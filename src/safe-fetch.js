const dns = require('node:dns').promises;
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const { Readable, finished, pipeline } = require('node:stream');
const zlib = require('node:zlib');

function ipv4Blocked(bytes) {
  const [a, b, c] = bytes;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) || a >= 224;
}

function isBlockedAddress(ip) {
  if (typeof ip !== 'string' || ip.includes('%')) return true;
  const family = net.isIP(ip);
  if (family === 4) return ipv4Blocked(ip.split('.').map(Number));
  if (family !== 6) return true;
  // Expand valid IPv6 into bytes, including dotted IPv4 tails.
  let value = ip;
  if (value.includes('.')) {
    const colon = value.lastIndexOf(':');
    const tail = value.slice(colon + 1).split('.').map(Number);
    value = `${value.slice(0, colon)}:${((tail[0] << 8) | tail[1]).toString(16)}:${((tail[2] << 8) | tail[3]).toString(16)}`;
  }
  const halves = value.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const words = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  const bytes = words.flatMap(word => { const n = parseInt(word, 16); return [n >> 8, n & 255]; });
  const zero = count => bytes.slice(0, count).every(byte => byte === 0);
  if (zero(12)) return true; // IPv4-compatible, unspecified, loopback.
  if (zero(10) && bytes[10] === 255 && bytes[11] === 255) return ipv4Blocked(bytes.slice(12));
  if (bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes.slice(4, 12).every(b => b === 0)) return ipv4Blocked(bytes.slice(12));
  if (bytes[0] === 0x20 && bytes[1] === 2) return ipv4Blocked(bytes.slice(2, 6));
  return (bytes[0] & 0xfe) === 0xfc || (bytes[0] === 0xfe && (bytes[1] & 0xc0) >= 0x80) ||
    bytes[0] === 0xff || (bytes[0] === 1 && bytes.slice(1, 8).every(b => b === 0)) ||
    (bytes[0] === 0x20 && bytes[1] === 1 && bytes[2] === 0x0d && bytes[3] === 0xb8);
}

function unsafe(message) { return Object.assign(new Error(message), { code: 'UNSAFE_URL' }); }
function checkHopUrl(value, { previousUrl } = {}) {
  let url;
  try { url = new URL(value); } catch { throw unsafe('Invalid link URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw unsafe('Only http and https links can be followed.');
  if (url.username || url.password) throw unsafe('Links must not include credentials.');
  if (previousUrl && new URL(previousUrl).protocol === 'https:' && url.protocol === 'http:') throw unsafe('Blocked a redirect from HTTPS to HTTP.');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || (net.isIP(host) && isBlockedAddress(host))) throw unsafe('Blocked a link to a local or private-network address.');
  return url;
}

async function resolvePublicAddresses(hostname, resolve = dns.lookup) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return [{ address: host, family: net.isIP(host) }];
  const records = await resolve(host, { all: true });
  if (!Array.isArray(records) || !records.length) throw new Error(`Could not resolve ${host}.`);
  if (records.some(record => isBlockedAddress(record.address))) throw unsafe(`Blocked: ${host} resolves to a local or private-network address.`);
  return records;
}

function nodeTransport({ url, method, headers, lookup, ca, signal }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = (parsed.protocol === 'https:' ? https : http).request(parsed, {
      method, headers, lookup, ca, signal, agent: false,
      servername: net.isIP(parsed.hostname.replace(/^\[|\]$/g, '')) ? undefined : parsed.hostname
    }, body => resolve({ status: body.statusCode, statusText: body.statusMessage, headers: body.headers, body }));
    request.on('error', reject);
    request.end();
  });
}

function abortError() { return new DOMException('Request was canceled.', 'AbortError'); }
function abortable(operation, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function safeFetch(url, { method = 'GET', headers = {}, signal, timeoutMs = 12000, maxRedirects = 5, resolve, ca, onHop, transport = nodeTransport } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
  let current = url, previousUrl;
  const chain = [];
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (controller.signal.aborted) throw abortError();
      const parsed = checkHopUrl(current, { previousUrl });
      parsed.hash = '';
      current = parsed.href;
      const records = await abortable(() => resolvePublicAddresses(parsed.hostname, resolve), controller.signal);
      const lookup = (_host, options, callback) => {
        if (typeof options === 'function') { callback = options; options = {}; }
        const family = typeof options === 'number' ? options : options?.family;
        const pinned = records.filter(record => !family || record.family === family).map(record => ({ address: record.connect || record.address, family: net.isIP(record.connect || record.address) }));
        if (!pinned.length) return callback(new Error('No validated address for requested family.'));
        if (options?.all) callback(null, pinned);
        else callback(null, pinned[0].address, pinned[0].family);
      };
      const requestHeaders = new Headers(headers);
      requestHeaders.delete('cookie');
      requestHeaders.set('accept-encoding', 'gzip, deflate, br');
      onHop?.({ url: current, host: parsed.host, index: hop, fromHost: previousUrl ? new URL(previousUrl).host : '' });
      chain.push(current);
      const result = await abortable(() => transport({ url: current, method, headers: Object.fromEntries(requestHeaders), lookup, ca, signal: controller.signal }), controller.signal);
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(result.headers || {})) {
        if (Array.isArray(value)) value.forEach(item => responseHeaders.append(key, item));
        else if (value !== undefined) responseHeaders.set(key, value);
      }
      if ([301, 302, 303, 307, 308].includes(result.status)) {
        result.body?.destroy();
        const location = responseHeaders.get('location');
        if (!location) throw new Error(`Redirect HTTP ${result.status} has no Location header.`);
        if (hop === maxRedirects) throw new Error(`Stopped after ${maxRedirects} redirects.`);
        previousUrl = current;
        current = new URL(location, current).href;
        if (result.status === 303 || ([301, 302].includes(result.status) && method === 'POST')) method = 'GET';
        continue;
      }
      let body = result.body;
      if (method === 'HEAD' || [204, 304].includes(result.status)) { body?.destroy(); body = null; }
      if (body) {
        const encoding = responseHeaders.get('content-encoding');
        const decoder = encoding === 'gzip' ? zlib.createGunzip() : encoding === 'deflate' ? zlib.createInflate() : encoding === 'br' ? zlib.createBrotliDecompress() : null;
        if (decoder) { pipeline(body, decoder, () => {}); body = decoder; }
        const bodyStream = body;
        const abortBody = () => bodyStream.destroy(abortError());
        controller.signal.addEventListener('abort', abortBody, { once: true });
        finished(body, () => { controller.signal.removeEventListener('abort', abortBody); cleanup(); });
        body = Readable.toWeb(body);
      } else cleanup();
      return { response: new Response(body, { status: result.status, statusText: result.statusText, headers: responseHeaders }), finalUrl: current, chain };
    }
  } catch (error) { cleanup(); throw controller.signal.aborted ? abortError() : error; }
}

module.exports = { isBlockedAddress, checkHopUrl, resolvePublicAddresses, safeFetch };
