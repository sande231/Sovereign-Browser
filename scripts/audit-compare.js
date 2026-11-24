#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { isIP } = require('node:net');
const { CLOUD_AI_HOSTS } = require('../src/privacy-receipt');

function normalizeHost(value) {
  let raw = String(value || '').trim().toLowerCase();
  if (!raw) {
    return '';
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      raw = new URL(raw).host;
    } catch {
      // Fall back to text normalization below.
    }
  }
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(raw);
  if (bracketed) {
    raw = bracketed[1];
  }
  raw = raw
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/^www\./, '')
    .replace(/\s+#.*$/, '')
    .split('/')[0];

  if (/^[a-z0-9.-]+:\d+$/.test(raw)) {
    raw = raw.replace(/:\d+$/, '');
  }
  return raw;
}

// A capture line with no hostname (local capture mode logs the destination IP
// and port when a connection has no TLS SNI, Host header or parsable QUIC SNI).
function isBareIp(host) {
  return isIP(normalizeHost(host)) !== 0;
}

// `dns:<server IP>`: a lookup macOS's resolver made for Sovereign (PLAN §12).
const DNS_PREFIX = 'dns:';

function normalizeNameserver(value) {
  return String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
}

// One capture line in a stable form: hostnames as normalizeHost gives them;
// bare IPs keep their port (`203.0.113.5:80`, `[2001:db8::1]:443`); DNS lines
// stay `dns:<ip>`.
function captureLabel(line) {
  const raw = String(line || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith(DNS_PREFIX)) {
    const server = normalizeNameserver(raw.slice(DNS_PREFIX.length));
    return server ? `${DNS_PREFIX}${server}` : '';
  }
  const host = normalizeHost(raw);
  const family = isIP(host);
  if (!family) return host;
  const port = (/^\[[^\]]+\]:(\d+)$/.exec(raw) || /^[0-9.]+:(\d+)$/.exec(raw) || [])[1];
  if (!port) return host;
  return family === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}

// Loopback never leaves the machine (SearXNG, Kiwix, the Offline black-hole proxy).
function isLoopbackHost(host) {
  const value = normalizeHost(host).replace(/\.$/, '');
  if (value === 'localhost' || value.endsWith('.localhost') || value === '::1') return true;
  if (isIP(value) === 4) return value.startsWith('127.');
  return /^::ffff:127\./.test(value);
}

function hostMatchesCloudAi(host) {
  const normalized = normalizeHost(host);
  return CLOUD_AI_HOSTS.find(cloudHost => normalized === cloudHost || normalized.endsWith(`.${cloudHost}`)) || '';
}

function sorted(values) {
  return [...values].filter(Boolean).sort((left, right) => left.localeCompare(right));
}

function readNetworkHosts(text) {
  return new Set(String(text || '')
    .split(/\r?\n/)
    .map(captureLabel)
    .filter(label => label && !isLoopbackHost(label.startsWith(DNS_PREFIX) ? label.slice(DNS_PREFIX.length) : label)));
}

function readReceiptHosts(receiptJson) {
  const parsed = typeof receiptJson === 'string' ? JSON.parse(receiptJson) : receiptJson;
  const receipts = Array.isArray(parsed?.receipts) ? parsed.receipts : [];
  const hosts = new Set();
  for (const receipt of receipts) {
    for (const entry of Array.isArray(receipt?.entries) ? receipt.entries : []) {
      const host = normalizeHost(entry?.host || entry?.url || '');
      if (host) {
        hosts.add(host);
      }
    }
  }
  return hosts;
}

// nameservers: the Mac's own DNS servers (`scutil --dns`). A dns: line is
// accepted only for one of them; without the list, every dns: line needs review.
function compareHosts(networkHosts, receiptHosts, { nameservers = [] } = {}) {
  const systemNameservers = new Set([...nameservers].map(normalizeNameserver).filter(Boolean));
  const matched = new Set();
  const missingFromReceipt = new Set();
  const bareIps = new Set();
  const receiptOnly = new Set();
  const dnsSystem = new Set();
  const dnsOther = new Set();
  const networkNames = new Set();
  for (const label of networkHosts) {
    if (label.startsWith(DNS_PREFIX)) {
      (systemNameservers.has(label.slice(DNS_PREFIX.length)) ? dnsSystem : dnsOther).add(label);
      continue;
    }
    const host = normalizeHost(label);
    networkNames.add(host);
    if (receiptHosts.has(host)) {
      matched.add(host);
    } else if (isBareIp(host)) {
      bareIps.add(label);
    } else {
      missingFromReceipt.add(host);
    }
  }
  for (const host of receiptHosts) {
    if (!networkNames.has(host)) {
      receiptOnly.add(host);
    }
  }
  const cloudAiHosts = new Set([
    ...[...networkNames].map(hostMatchesCloudAi),
    ...[...receiptHosts].map(hostMatchesCloudAi)
  ].filter(Boolean));
  const reasons = [];
  if (missingFromReceipt.size > 0) {
    reasons.push(`${missingFromReceipt.size} host${missingFromReceipt.size === 1 ? '' : 's'} in network capture but not in receipt`);
  }
  if (bareIps.size > 0) {
    reasons.push(`${bareIps.size} bare IP${bareIps.size === 1 ? '' : 's'} in network capture with no hostname (check by hand)`);
  }
  if (dnsOther.size > 0) {
    reasons.push(`${dnsOther.size} DNS server${dnsOther.size === 1 ? '' : 's'} in network capture that ${dnsOther.size === 1 ? 'is' : 'are'} not a system nameserver (check by hand)`);
  }
  if (cloudAiHosts.size > 0) {
    reasons.push(`cloud-AI host${cloudAiHosts.size === 1 ? '' : 's'} observed: ${sorted(cloudAiHosts).join(', ')}`);
  }
  return {
    matched: sorted(matched),
    missingFromReceipt: sorted(missingFromReceipt),
    bareIps: sorted(bareIps),
    receiptOnly: sorted(receiptOnly),
    dnsSystem: sorted(dnsSystem),
    dnsOther: sorted(dnsOther),
    cloudAiHosts: sorted(cloudAiHosts),
    verdict: reasons.length === 0
      ? 'PASS: no uncaptured hosts and no cloud-AI hosts'
      : `REVIEW: ${reasons.join('; ')}`
  };
}

function formatSection(title, hosts) {
  const lines = [title];
  if (!hosts.length) {
    lines.push('  (none)');
  } else {
    for (const host of hosts) {
      const cloud = hostMatchesCloudAi(host) ? '  [cloud AI]' : '';
      lines.push(`  ${host}${cloud}`);
    }
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const files = [];
  let nameservers = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--nameservers') {
      nameservers = String(argv[i + 1] || '').split(/[\s,]+/).filter(Boolean);
      i += 1;
    } else {
      files.push(argv[i]);
    }
  }
  return { networkPath: files[0], receiptPath: files[1], nameservers };
}

function runCli(argv = process.argv.slice(2)) {
  const { networkPath, receiptPath, nameservers } = parseArgs(argv);
  if (!networkPath || !receiptPath) {
    console.error('Usage: node scripts/audit-compare.js <mitm-hosts.txt> <receipt-export.json> [--nameservers <ip,ip,...>]');
    return 2;
  }
  const networkText = fs.readFileSync(path.resolve(networkPath), 'utf8');
  const receiptText = fs.readFileSync(path.resolve(receiptPath), 'utf8');
  const result = compareHosts(readNetworkHosts(networkText), readReceiptHosts(receiptText), { nameservers });
  console.log(formatSection('MATCHED:', result.matched));
  console.log('');
  console.log(formatSection('IN NETWORK CAPTURE BUT NOT IN RECEIPT:', result.missingFromReceipt));
  console.log('');
  console.log(formatSection('BARE IPs IN CAPTURE, NO HOSTNAME (check by hand):', result.bareIps));
  console.log('');
  console.log(formatSection('IN RECEIPT BUT NOT IN CAPTURE:', result.receiptOnly));
  console.log('');
  console.log(`System nameservers given: ${nameservers.map(normalizeNameserver).join(', ') || '(none)'}`);
  console.log(formatSection('DNS VIA SYSTEM RESOLVER (macOS lookups made for Sovereign; server only):', result.dnsSystem));
  console.log('');
  console.log(formatSection('DNS TO OTHER SERVERS, NOT A SYSTEM NAMESERVER (check by hand):', result.dnsOther));
  console.log('');
  if (result.cloudAiHosts.length) {
    console.log(formatSection('CLOUD-AI HOSTS OBSERVED:', result.cloudAiHosts));
    console.log('');
  }
  console.log(result.verdict);
  return result.verdict.startsWith('PASS:') ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = runCli();
}

module.exports = {
  captureLabel,
  compareHosts,
  formatSection,
  hostMatchesCloudAi,
  isBareIp,
  isLoopbackHost,
  normalizeHost,
  parseArgs,
  readNetworkHosts,
  readReceiptHosts
};
