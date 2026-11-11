'use strict';

// Offline mode rules. Plain Node, no Electron imports, so it can be unit-tested.
// While Offline, only internal schemes, local files and allowlisted loopback host:port pairs
// may be requested. Everything else fails closed.

const net = require('node:net');

const ALWAYS_ALLOWED_SCHEMES = new Set(['sovereign:', 'data:', 'blob:', 'devtools:', 'about:', 'chrome:', 'chrome-error:']);
const LOCAL_SERVICE_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);
const DEFAULT_PORTS = { 'http:': 80, 'ws:': 80, 'https:': 443, 'wss:': 443 };
const MAX_ALLOWLIST = 20;
const OFFLINE_MESSAGE = 'Offline mode is on.';
const SEARXNG_ALLOWLIST_ERROR = "SearXNG forwards searches to the internet, so it can't be allowed in Offline mode.";

function stripBrackets(host) {
  return String(host || '').replace(/^\[|\]$/g, '');
}

function isLoopbackHost(hostname) {
  const host = stripBrackets(hostname).toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const family = net.isIP(host);
  if (family === 4) return host.split('.')[0] === '127';
  // Only the canonical IPv6 loopback. Mapped forms (::ffff:127.0.0.1) are blocked on purpose.
  if (family === 6) return host === '::1' || host === '0:0:0:0:0:0:0:1';
  return false;
}

function normalizeHost(hostname) {
  const host = stripBrackets(hostname).toLowerCase().replace(/\.$/, '');
  return net.isIP(host) === 6 ? `[${host === '0:0:0:0:0:0:0:1' ? '::1' : host}]` : host;
}

// host:port for an http(s)/ws(s) URL, with the default port filled in. '' if not applicable.
function hostPortOf(value) {
  let url;
  try { url = value instanceof URL ? value : new URL(String(value)); } catch { return ''; }
  if (!LOCAL_SERVICE_SCHEMES.has(url.protocol)) return '';
  return `${normalizeHost(url.hostname)}:${url.port || DEFAULT_PORTS[url.protocol]}`;
}

function blockedEntryList(blockedHostPorts) {
  return (Array.isArray(blockedHostPorts) ? blockedHostPorts : []).map(item => (
    typeof item === 'string'
      ? { entry: item, error: SEARXNG_ALLOWLIST_ERROR }
      : { entry: String(item?.entry || ''), error: String(item?.error || SEARXNG_ALLOWLIST_ERROR) }
  )).filter(item => item.entry);
}

function parseAllowlistEntry(text, { blockedHostPorts = [] } = {}) {
  const value = String(text || '').trim();
  const match = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(value);
  if (!match) {
    return { ok: false, error: 'Enter an address as host:port, for example 127.0.0.1:3000.' };
  }
  const port = Number(match[2]);
  if (port < 1 || port > 65535) {
    return { ok: false, error: 'The port must be between 1 and 65535.' };
  }
  if (!isLoopbackHost(match[1])) {
    return { ok: false, error: 'Only addresses on this computer can be allowed.' };
  }
  const entry = `${normalizeHost(match[1])}:${port}`;
  const blocked = blockedEntryList(blockedHostPorts).find(item => item.entry === entry);
  if (blocked) return { ok: false, error: blocked.error };
  return { ok: true, entry };
}

function normalizeAllowlist(list, options = {}) {
  const result = [];
  for (const item of Array.isArray(list) ? list : []) {
    const parsed = parseAllowlistEntry(item, options);
    if (parsed.ok && !result.includes(parsed.entry)) result.push(parsed.entry);
    if (result.length >= MAX_ALLOWLIST) break;
  }
  return result;
}

// An additional policy tightens the site's CSP without replacing it.
function offlineConnectSrc(pageUrl, allowlist = []) {
  const url = new URL(pageUrl);
  const sources = [url.origin, `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`];
  for (const entry of allowlist) {
    for (const scheme of ['http', 'https', 'ws', 'wss']) sources.push(`${scheme}://${entry}`);
  }
  return `connect-src ${[...new Set(sources)].join(' ')}`;
}

// blockedOrigins: origins or host:port strings of local services that forward to the internet
// (SearXNG, the audit proxy). They stay blocked even if the allowlist names them.
function offlineDecision(value, { allowlist = [], blockedOrigins = [] } = {}) {
  let url;
  try { url = new URL(String(value)); } catch { return { allow: false, reason: 'external' }; }
  if (ALWAYS_ALLOWED_SCHEMES.has(url.protocol)) return { allow: true, reason: 'internal' };
  if (url.protocol === 'file:') {
    return url.hostname ? { allow: false, reason: 'external' } : { allow: true, reason: 'local-file' };
  }
  if (!LOCAL_SERVICE_SCHEMES.has(url.protocol) || !isLoopbackHost(url.hostname)) {
    return { allow: false, reason: 'external' };
  }
  const hostPort = hostPortOf(url);
  const blocked = (Array.isArray(blockedOrigins) ? blockedOrigins : [])
    .map(origin => (/^[a-z][a-z0-9+.-]*:\/\//i.test(origin) ? hostPortOf(origin) : String(origin)))
    .filter(Boolean);
  if (blocked.includes(hostPort)) return { allow: false, reason: 'blocked-local-service' };
  if (!(Array.isArray(allowlist) ? allowlist : []).includes(hostPort)) {
    return { allow: false, reason: 'local-not-allowed' };
  }
  return { allow: true, reason: 'allowlisted' };
}

function initialNetworkState({ prefsFileExisted, parsed } = {}) {
  if (!prefsFileExisted) return { mode: 'offline', choiceMade: true };
  if (!parsed || typeof parsed !== 'object') return { mode: 'offline', choiceMade: false };
  const network = parsed.network;
  if (network && typeof network === 'object' && ['offline', 'online'].includes(network.mode)) {
    return { mode: network.mode, choiceMade: Boolean(network.choiceMade) };
  }
  return { mode: 'online', choiceMade: false };
}

function offlineError(purpose = '') {
  return Object.assign(new Error(OFFLINE_MESSAGE), { code: 'OFFLINE_MODE', purpose: String(purpose || '') });
}

function createNetworkMode({ initial = 'offline', onChange } = {}) {
  let mode = initial === 'online' ? 'online' : 'offline';
  return {
    get mode() { return mode; },
    isOffline: () => mode === 'offline',
    set(next) {
      const value = next === 'online' ? 'online' : 'offline';
      if (value === mode) return false;
      const previous = mode;
      mode = value;
      if (typeof onChange === 'function') onChange(value, previous);
      return true;
    },
    assertOnline(purpose) {
      if (mode === 'offline') throw offlineError(purpose);
    }
  };
}

module.exports = {
  MAX_ALLOWLIST,
  OFFLINE_MESSAGE,
  SEARXNG_ALLOWLIST_ERROR,
  isLoopbackHost,
  hostPortOf,
  parseAllowlistEntry,
  normalizeAllowlist,
  offlineConnectSrc,
  offlineDecision,
  initialNetworkState,
  offlineError,
  createNetworkMode
};
