#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
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
    .map(normalizeHost)
    .filter(Boolean));
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

function compareHosts(networkHosts, receiptHosts) {
  const matched = new Set();
  const missingFromReceipt = new Set();
  const receiptOnly = new Set();
  for (const host of networkHosts) {
    if (receiptHosts.has(host)) {
      matched.add(host);
    } else {
      missingFromReceipt.add(host);
    }
  }
  for (const host of receiptHosts) {
    if (!networkHosts.has(host)) {
      receiptOnly.add(host);
    }
  }
  const cloudAiHosts = new Set([
    ...[...networkHosts].map(hostMatchesCloudAi),
    ...[...receiptHosts].map(hostMatchesCloudAi)
  ].filter(Boolean));
  const reasons = [];
  if (missingFromReceipt.size > 0) {
    reasons.push(`${missingFromReceipt.size} host${missingFromReceipt.size === 1 ? '' : 's'} in network capture but not in receipt`);
  }
  if (cloudAiHosts.size > 0) {
    reasons.push(`cloud-AI host${cloudAiHosts.size === 1 ? '' : 's'} observed: ${sorted(cloudAiHosts).join(', ')}`);
  }
  return {
    matched: sorted(matched),
    missingFromReceipt: sorted(missingFromReceipt),
    receiptOnly: sorted(receiptOnly),
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

function runCli(argv = process.argv.slice(2)) {
  const [networkPath, receiptPath] = argv;
  if (!networkPath || !receiptPath) {
    console.error('Usage: node scripts/audit-compare.js <mitm-hosts.txt> <receipt-export.json>');
    return 2;
  }
  const networkText = fs.readFileSync(path.resolve(networkPath), 'utf8');
  const receiptText = fs.readFileSync(path.resolve(receiptPath), 'utf8');
  const result = compareHosts(readNetworkHosts(networkText), readReceiptHosts(receiptText));
  console.log(formatSection('MATCHED:', result.matched));
  console.log('');
  console.log(formatSection('IN NETWORK CAPTURE BUT NOT IN RECEIPT:', result.missingFromReceipt));
  console.log('');
  console.log(formatSection('IN RECEIPT BUT NOT IN CAPTURE:', result.receiptOnly));
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
  compareHosts,
  formatSection,
  hostMatchesCloudAi,
  normalizeHost,
  readNetworkHosts,
  readReceiptHosts
};
