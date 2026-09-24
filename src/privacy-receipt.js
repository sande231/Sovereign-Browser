const MAX_RECEIPTS = 20;
const MAX_ENTRIES_PER_RECEIPT = 120;

const CLOUD_AI_HOSTS = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.mistral.ai',
  'api.groq.com',
  'api.together.xyz',
  'api.deepseek.com',
  'api.perplexity.ai',
  'openrouter.ai',
  'api.cohere.ai'
];

const VALID_CATEGORIES = new Set([
  'search',
  'source-page',
  'image',
  'model-download',
  'other'
]);

let receipts = [];
const listeners = new Set();
let backgroundReceiptId = '';

function timestamp() {
  return new Date().toISOString();
}

function safeString(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function hostFromUrl(value) {
  try {
    return new URL(value).host;
  } catch {
    return 'unknown';
  }
}

function cloudHostMatch(host) {
  const normalized = String(host || '').toLowerCase().split(':')[0].replace(/^www\./, '');
  return CLOUD_AI_HOSTS.find(cloudHost => normalized === cloudHost || normalized.endsWith(`.${cloudHost}`)) || '';
}

function cloudCheck(entries) {
  const matches = [...new Set(entries.map(entry => cloudHostMatch(entry.host)).filter(Boolean))];
  if (matches.length > 0) {
    return {
      ok: false,
      message: `Cloud AI service contacted: ${matches.join(', ')}`,
      hosts: matches
    };
  }
  return {
    ok: true,
    message: '✓ No data sent to cloud AI services',
    hosts: []
  };
}

function uniqueHosts(entries, category) {
  return [...new Set(entries
    .filter(entry => !category || entry.category === category)
    .map(entry => entry.host)
    .filter(Boolean))];
}

function buildSummary(receipt) {
  const entries = Array.isArray(receipt.entries) ? receipt.entries : [];
  if (entries.length === 0 && receipt.localOnly && receipt.type === 'ask') {
    return 'Nothing left this device: answer generated locally';
  }
  const parts = [];
  const searchHosts = uniqueHosts(entries, 'search');
  const sourceCount = entries.filter(entry => entry.category === 'source-page').length;
  const imageHosts = uniqueHosts(entries, 'image');
  const modelHosts = uniqueHosts(entries, 'model-download');
  const otherHosts = uniqueHosts(entries, 'other');

  if (searchHosts.length > 0) {
    parts.push(`Query sent to ${searchHosts.join(', ')} (SearXNG)`);
  }
  if (sourceCount > 0) {
    parts.push(`${sourceCount} source page${sourceCount === 1 ? '' : 's'} fetched`);
  }
  if (imageHosts.length > 0) {
    parts.push(`Image/media hosts contacted: ${imageHosts.join(', ')}`);
  }
  if (modelHosts.length > 0) {
    parts.push(`Model files requested from ${modelHosts.join(', ')}`);
  }
  if (otherHosts.length > 0) {
    parts.push(`Other trusted-app requests: ${otherHosts.join(', ')}`);
  }
  if (receipt.type === 'ask') {
    parts.push('AI generated locally');
  }
  if (receipt.type === 'background') {
    parts.unshift('Background app/AI network activity');
  }
  return parts.length > 0 ? parts.join(' · ') : 'No outbound network requests observed for this activity.';
}

function sanitizeReceipt(receipt) {
  return {
    id: receipt.id,
    type: receipt.type,
    label: receipt.label,
    query: receipt.query,
    localOnly: Boolean(receipt.localOnly),
    startedAt: receipt.startedAt,
    updatedAt: receipt.updatedAt,
    summary: receipt.summary,
    cloudAi: receipt.cloudAi,
    entries: receipt.entries.map(entry => ({ ...entry }))
  };
}

function notify(receipt) {
  const snapshot = sanitizeReceipt(receipt);
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch {
      // Receipt listeners are UI notifications; never recurse into logging here.
    }
  }
}

function createReceipt({ id, type = 'activity', label = '', query = '' } = {}) {
  const receiptId = safeString(id, 100) || `receipt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const existing = receipts.find(receipt => receipt.id === receiptId);
  if (existing) {
    existing.type = safeString(type, 40) || existing.type;
    existing.label = safeString(label, 120) || existing.label;
    existing.query = safeString(query, 300) || existing.query;
    if (arguments[0] && Object.prototype.hasOwnProperty.call(arguments[0], 'localOnly')) {
      existing.localOnly = Boolean(arguments[0].localOnly);
    }
    existing.updatedAt = timestamp();
    existing.summary = buildSummary(existing);
    notify(existing);
    return sanitizeReceipt(existing);
  }

  const now = timestamp();
  const receipt = {
    id: receiptId,
    type: safeString(type, 40) || 'activity',
    label: safeString(label, 120),
    query: safeString(query, 300),
    localOnly: Boolean(arguments[0]?.localOnly),
    startedAt: now,
    updatedAt: now,
    summary: '',
    cloudAi: cloudCheck([]),
    entries: []
  };
  receipt.summary = buildSummary(receipt);
  receipts.unshift(receipt);
  receipts = receipts.slice(0, MAX_RECEIPTS);
  notify(receipt);
  return sanitizeReceipt(receipt);
}

function getReceipt(id) {
  return receipts.find(receipt => receipt.id === String(id || '')) || null;
}

function addEntry(receiptId, details = {}) {
  const id = safeString(receiptId, 100);
  const receipt = getReceipt(id) || receipts[0] || createReceipt({ type: 'activity', label: 'Network activity' });
  const target = getReceipt(receipt.id) || receipt;
  const url = cleanUrl(details.url);
  const category = VALID_CATEGORIES.has(details.category) ? details.category : 'other';
  const entry = {
    timestamp: timestamp(),
    category,
    method: safeString(details.method || 'GET', 12).toUpperCase() || 'GET',
    host: hostFromUrl(url),
    url,
    whatWasSent: safeString(details.whatWasSent || 'request metadata only; no request body logged', 500)
  };
  target.entries.push(entry);
  if (target.entries.length > MAX_ENTRIES_PER_RECEIPT) {
    target.entries = target.entries.slice(-MAX_ENTRIES_PER_RECEIPT);
  }
  target.updatedAt = timestamp();
  target.cloudAi = cloudCheck(target.entries);
  target.summary = buildSummary(target);
  notify(target);
  return sanitizeReceipt(target);
}

function getOrCreateBackgroundReceipt() {
  const existing = backgroundReceiptId ? getReceipt(backgroundReceiptId) : null;
  if (existing) {
    return sanitizeReceipt(existing);
  }
  const receipt = createReceipt({
    id: `background-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: 'background',
    label: 'Background',
    query: ''
  });
  backgroundReceiptId = receipt.id;
  return receipt;
}

function addBackgroundEntry(details = {}) {
  const receipt = getOrCreateBackgroundReceipt();
  return addEntry(receipt.id, details);
}

async function fetchWithReceipt(fetchImpl, receiptId, url, options = {}, details = {}) {
  addEntry(receiptId, {
    category: details.category,
    method: options?.method || 'GET',
    url,
    whatWasSent: details.whatWasSent
  });
  return fetchImpl(url, options);
}

function getLatestReceipt() {
  return receipts[0] ? sanitizeReceipt(receipts[0]) : null;
}

function getReceipts() {
  return receipts.map(sanitizeReceipt);
}

function exportPayload({ appVersion = '' } = {}) {
  return {
    appVersion: safeString(appVersion, 80),
    exportedAt: timestamp(),
    cloudAiHosts: [...CLOUD_AI_HOSTS],
    note: 'Privacy receipts are in-memory diagnostics. Entries omit cookies, auth headers, and request bodies.',
    ignoredSchemes: ['file:', 'devtools:', 'blob:', 'data:', 'sovereign:'],
    receipts: getReceipts()
  };
}

function resetForTests() {
  receipts = [];
  backgroundReceiptId = '';
}

function onUpdate(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

module.exports = {
  CLOUD_AI_HOSTS,
  addEntry,
  addBackgroundEntry,
  createReceipt,
  exportPayload,
  fetchWithReceipt,
  getOrCreateBackgroundReceipt,
  getLatestReceipt,
  getReceipts,
  resetForTests,
  onUpdate
};
