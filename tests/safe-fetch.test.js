const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { gzipSync, deflateSync, brotliCompressSync } = require('node:zlib');
const { isBlockedAddress, checkHopUrl, resolvePublicAddresses, safeFetch } = require('../src/safe-fetch');
const blocked = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:ac10:1', '::ffff:6440:1', 'fd00::1', 'fe80::1', 'febf::1', 'fec0::1', 'ff02::1', '64:ff9b::a00:1', '2002:c0a8:0101::1', 'fe80::1%en0', '100::1', '2001:db8::1', '::808:808', 'not-an-ip'];
for (const ip of blocked) assert.equal(isBlockedAddress(ip), true, ip);
for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1111', '64:ff9b::808:808', '::ffff:808:808', '2002:0808:0808::1']) assert.equal(isBlockedAddress(ip), false, ip);
for (const url of ['file:///etc/passwd', 'ftp://x', 'javascript:alert(1)', 'data:text/plain,x', 'http://user:pw@example.com', 'http://localhost/', 'http://a.localhost/', 'http://2130706433/', 'http://0x7f.1/', 'http://[::ffff:127.0.0.1]/']) assert.throws(() => checkHopUrl(url), { code: 'UNSAFE_URL' }, url);
assert.throws(() => checkHopUrl('http://public.test', { previousUrl: 'https://public.test' }), /HTTPS to HTTP/);
assert.doesNotThrow(() => checkHopUrl('https://public.test', { previousUrl: 'http://public.test' }));
const resolve = async host => [{ address: host === 'private.test' ? '10.0.0.7' : '93.184.216.34', family: 4 }];
const ok = () => ({ status: 200, headers: {}, body: Readable.from([Buffer.from('hello')]) });
async function main() {
  for (const host of ['127.0.0.1', '10.0.0.1', '192.168.0.1', '169.254.169.254', '[::1]', '[::ffff:7f00:1]', 'private.test']) {
    const contacted = [];
    const hops = [];
    await assert.rejects(safeFetch('http://public.test/', { resolve, onHop: h => hops.push(h), transport: async ({ url }) => {
      contacted.push(String(url));
      return { status: 302, headers: { location: `http://${host}/` }, body: Readable.from([]) };
    } }), /private-network/);
    assert.deepEqual(contacted, ['http://public.test/']);
    assert.equal(hops.length, 1);
  }
  await assert.rejects(resolvePublicAddresses('mixed.test', async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]), /private-network/);
  await assert.rejects(resolvePublicAddresses('empty.test', async () => []), /resolve/i);
  for (const count of [5, 6]) {
    let calls = 0;
    const pending = safeFetch('http://public.test/0', { resolve, transport: async () => calls++ < count ? { status: 302, headers: { location: `/${calls}` }, body: Readable.from([]) } : ok() });
    if (count === 6) await assert.rejects(pending, /Stopped after 5 redirects\./);
    else { const result = await pending; assert.equal(result.chain.length, 6); await result.response.text(); }
    assert.equal(calls, 6);
  }
  await assert.rejects(safeFetch('https://public.test/', { resolve, transport: async () => ({ status: 302, headers: { location: 'http://public.test/' }, body: null }) }), /HTTPS to HTTP/);
  const hops = [], resolutions = [];
  const result = await safeFetch('http://public.test/', {
    resolve: async (host, options) => { assert.equal(options.all, true); resolutions.push(host); return resolve(host); },
    onHop: hop => hops.push(hop),
    transport: async ({ url, lookup }) => {
      assert.equal(await new Promise((yes, no) => lookup(new URL(url).hostname, {}, (err, address) => err ? no(err) : yes(address))), '93.184.216.34');
      assert.deepEqual(await new Promise((yes, no) => lookup(new URL(url).hostname, { all: true }, (err, addresses) => err ? no(err) : yes(addresses))), [{ address: '93.184.216.34', family: 4 }]);
      return hops.length === 1 ? { status: 302, headers: { location: 'https://public2.test/final' }, body: null } : ok();
    }
  });
  assert.deepEqual(result.chain, ['http://public.test/', 'https://public2.test/final']);
  assert.deepEqual(resolutions, ['public.test', 'public2.test']);
  assert.deepEqual(hops.map(h => [h.host, h.index, h.fromHost]), [['public.test', 0, ''], ['public2.test', 1, 'public.test']]);
  assert.equal(result.finalUrl, 'https://public2.test/final');
  assert.equal(await result.response.text(), 'hello');
  await assert.rejects(safeFetch('http://public.test/', { resolve, transport: async () => ({ status: 302, headers: {}, body: null }) }), /Location/);
  const head = await safeFetch('http://public.test/', { resolve, method: 'HEAD', transport: async () => ok() });
  assert.equal(head.response.body, null);
  const zipped = await safeFetch('http://public.test/', { resolve, transport: async () => ({ status: 200, headers: { 'content-encoding': 'gzip' }, body: Readable.from([gzipSync('decoded')]) }) });
  assert.equal(await zipped.response.text(), 'decoded');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(safeFetch('http://public.test/', { signal: controller.signal, resolve, transport: async () => { throw Error('must not contact'); } }), { name: 'AbortError' });
  await assert.rejects(safeFetch('http://public.test/', { timeoutMs: 10, resolve: () => new Promise(() => {}), transport: async () => ok() }), { name: 'AbortError' });
  for (const [encoding, compress] of [['deflate', deflateSync], ['br', brotliCompressSync]]) {
    const decoded = await safeFetch('http://public.test/', { resolve, transport: async () => ({ status: 200, headers: { 'content-encoding': encoding }, body: Readable.from([compress(Buffer.from('decoded'))]) }) });
    assert.equal(await decoded.response.text(), 'decoded');
  }
  const stalled = await safeFetch('http://public.test/', { timeoutMs: 10, resolve, transport: async () => ({ status: 200, headers: {}, body: new Readable({ read() {} }) }) });
  await assert.rejects(stalled.response.text(), { name: 'AbortError' });
  const bodyController = new AbortController();
  const canceled = await safeFetch('http://public.test/', { signal: bodyController.signal, resolve, transport: async () => ({ status: 200, headers: {}, body: new Readable({ read() {} }) }) });
  bodyController.abort();
  await assert.rejects(canceled.response.text(), { name: 'AbortError' });
  const { readSourcePages, validatePublicSourceUrl } = require('../src/source-reader');
  assert.equal(await validatePublicSourceUrl('https://public.test/path#fragment', resolve), 'https://public.test/path');
  const sourceHops = [];
  const sources = await readSourcePages({
    question: 'HTTP redirect history', results: [{ url: 'http://public.test/article', title: 'History', snippet: 'fallback' }],
    resolveHostname: resolve, onHop: hop => sourceHops.push(hop),
    fetchImpl: (url, options) => safeFetch(url, { ...options, transport: async ({ url: hopUrl, headers }) => {
      assert.equal(headers.cookie, undefined);
      assert.equal(headers['accept-encoding'], 'gzip, deflate, br');
      if (hopUrl.endsWith('/article')) return { status: 301, headers: { location: 'https://public2.test/final' }, body: null };
      return { status: 200, headers: { 'content-type': 'text/html' }, body: Readable.from([Buffer.from(`<article><p>${'HTTP redirect history explains how web pages move between addresses and preserve useful source information. '.repeat(12)}</p></article>`)]) };
    } })
  });
  assert.equal(sources.sources[0].evidenceMode, 'page');
  assert.match(sources.sources[0].evidenceText, /web pages move between addresses/);
  assert.equal(sources.sources[0].fetchedUrl, 'https://public2.test/final');
  assert.equal(sourceHops.length, 2);
  console.log('safe-fetch unit tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
