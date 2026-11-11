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
  'permission',
  'blocked',
  'sensitive',
  'other'
]);

const PERMISSION_RECEIPT_ID = 'website-permissions';
const BLOCKED_WHAT_WAS_SENT = 'blocked (offline mode) – nothing sent';

let receipts = [];
const listeners = new Set();
let backgroundReceiptId = '';
let offlineMode = false;
let offlineReceiptId = '';

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
  // Permission entries record a site's request, not a network request made by Sovereign.
  const matches = [...new Set(entries.filter(entry => entry.category !== 'permission').map(entry => cloudHostMatch(entry.host)).filter(Boolean))];
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

const MAX_FORWARDING_NAMES_SHOWN = 25;
const FORWARDING_UNKNOWN = 'upstream search engines (names not reported)';

function forwardingNames(names) {
  const list = Array.isArray(names) ? names : [];
  if (list.length <= MAX_FORWARDING_NAMES_SHOWN) return list.join(', ');
  return `${list.slice(0, MAX_FORWARDING_NAMES_SHOWN).join(', ')} and ${list.length - MAX_FORWARDING_NAMES_SHOWN} more`;
}

function forwardingPhrase(receipt, host) {
  const names = receipt.forwarding?.[host] || [];
  return names.length > 0
    ? `which forwarded it to: ${forwardingNames(names)}`
    : `which forwarded it to ${FORWARDING_UNKNOWN}`;
}

function originOnly(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.origin && parsed.origin !== 'null' ? parsed.origin : `${parsed.protocol}//`;
  } catch {
    return '';
  }
}

function buildSummary(receipt) {
  if (receipt.crisis) return 'Nothing left this device: crisis support shown';
  const sensitive = receipt.entries.filter(entry => entry.category === 'sensitive');
  if (sensitive.length) return `Not sent: sensitive topic (${[...new Set(sensitive.map(entry => entry.topic))].join(', ')})` + (receipt.type === 'ask' ? ' · AI generated locally' : '');
  const allEntries = Array.isArray(receipt.entries) ? receipt.entries : [];
  const blockedEntries = allEntries.filter(entry => entry.category === 'blocked');
  const entries = allEntries.filter(entry => entry.category !== 'blocked');
  if (receipt.offline) {
    // Computed, never hard-coded: a leak must show up as a non-zero count.
    const external = entries.filter(entry => entry.category !== 'permission').length;
    const blockedCount = blockedEntries.reduce((total, entry) => total + (Number(entry.count) || 1), 0);
    const head = [`Offline: ${external} external request${external === 1 ? '' : 's'}`];
    if (blockedCount > 0) head.push(`${blockedCount} blocked (offline mode)`);
    const rest = summaryParts({ ...receipt, entries });
    return [...head, ...rest].join(' · ');
  }
  if (entries.length === 0 && receipt.localOnly && receipt.type === 'ask') {
    return 'Nothing left this device: answer generated locally';
  }
  const parts = summaryParts({ ...receipt, entries });
  if (blockedEntries.length > 0) {
    const blockedCount = blockedEntries.reduce((total, entry) => total + (Number(entry.count) || 1), 0);
    parts.push(`${blockedCount} blocked (offline mode)`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'No outbound network requests observed for this activity.';
}

function summaryParts(receipt) {
  const entries = receipt.entries;
  const parts = [];
  const searchHosts = uniqueHosts(entries, 'search');
  const sourceCount = entries.filter(entry => entry.category === 'source-page').length;
  const imageHosts = uniqueHosts(entries, 'image');
  const modelHosts = uniqueHosts(entries, 'model-download');
  const otherHosts = uniqueHosts(entries, 'other');
  const permissionEntries = entries.filter(entry => entry.category === 'permission');

  for (const host of searchHosts) {
    parts.push(`Query sent to ${host} (SearXNG), ${forwardingPhrase(receipt, host)}`);
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
  if (permissionEntries.length > 0) {
    const allowed = permissionEntries.filter(entry => / – allowed /.test(entry.whatWasSent)).length;
    parts.push(`Website permission requests: ${permissionEntries.length} (${allowed} allowed)`);
  }
  if (receipt.type === 'ask') {
    parts.push('AI generated locally');
  }
  if (receipt.type === 'background') {
    parts.unshift('Background app/AI network activity');
  }
  return parts;
}

function sanitizeReceipt(receipt) {
  return {
    id: receipt.id,
    type: receipt.type,
    label: receipt.label,
    query: receipt.query,
    chatId: receipt.chatId,
    sensitiveOverride: Boolean(receipt.sensitiveOverride),
    crisis: Boolean(receipt.crisis),
    localOnly: Boolean(receipt.localOnly),
    offline: Boolean(receipt.offline),
    droppedEntries: receipt.droppedEntries || 0,
    startedAt: receipt.startedAt,
    updatedAt: receipt.updatedAt,
    summary: receipt.summary,
    cloudAi: receipt.cloudAi,
    forwarding: Object.fromEntries(Object.entries(receipt.forwarding || {}).map(([host, names]) => [host, [...names]])),
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

function validChatId(value) {
  return typeof value === 'string' && value.length <= 100 && value.trim() && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : '';
}

function createReceipt({ id, type = 'activity', label = '', query = '', chatId = '', sensitiveOverride = false, crisis = false } = {}) {
  const receiptId = safeString(id, 100) || `receipt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const existing = receipts.find(receipt => receipt.id === receiptId);
  if (existing) {
    existing.type = safeString(type, 40) || existing.type;
    existing.label = safeString(label, 120) || existing.label;
    existing.query = safeString(query, 300);
    existing.chatId = validChatId(chatId) || existing.chatId;
    existing.sensitiveOverride = Boolean(sensitiveOverride);
    existing.crisis = Boolean(crisis);
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
    chatId: validChatId(chatId),
    sensitiveOverride: Boolean(sensitiveOverride),
    crisis: Boolean(crisis),
    localOnly: Boolean(arguments[0]?.localOnly),
    offline: offlineMode,
    droppedEntries: 0,
    startedAt: now,
    updatedAt: now,
    summary: '',
    cloudAi: cloudCheck([]),
    forwarding: {},
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
  const category = VALID_CATEGORIES.has(details.category) ? details.category : 'other';
  if (category === 'blocked') {
    return addBlocked(target, details);
  }
  const topic = category === 'sensitive' ? safeString(details.topic, 160) : '';
  const url = category === 'sensitive' ? originOnly(details.url) : cleanUrl(details.url);
  const entry = {
    timestamp: timestamp(),
    category,
    method: safeString(details.method || 'GET', 12).toUpperCase() || 'GET',
    host: hostFromUrl(url),
    url,
    ...(category === 'sensitive' ? { topic } : {}),
    whatWasSent: category === 'sensitive' ? `blocked (sensitive topic: ${topic}) – nothing sent` : safeString(details.whatWasSent || 'request metadata only; no request body logged', 500)
  };
  target.entries.push(entry);
  if (target.entries.length > MAX_ENTRIES_PER_RECEIPT) {
    target.droppedEntries += target.entries.length - MAX_ENTRIES_PER_RECEIPT;
    target.entries = target.entries.slice(-MAX_ENTRIES_PER_RECEIPT);
  }
  target.updatedAt = timestamp();
  target.cloudAi = cloudCheck(target.entries);
  target.summary = buildSummary(target);
  notify(target);
  return sanitizeReceipt(target);
}

// Blocked attempts keep the origin only (the path or query can hold the question) and are
// counted per origin and resource type, so a busy page can't push real entries out.
function addBlocked(target, details) {
  const url = originOnly(details.url);
  const resourceType = safeString(details.resourceType, 40);
  const method = safeString(details.method || 'GET', 12).toUpperCase() || 'GET';
  const existing = target.entries.find(entry => entry.category === 'blocked' && entry.url === url && entry.resourceType === resourceType);
  if (existing) {
    existing.count = (Number(existing.count) || 1) + 1;
    existing.timestamp = timestamp();
  } else {
    target.entries.push({
      timestamp: timestamp(),
      category: 'blocked',
      method,
      host: hostFromUrl(url),
      url,
      resourceType,
      count: 1,
      whatWasSent: BLOCKED_WHAT_WAS_SENT
    });
    if (target.entries.length > MAX_ENTRIES_PER_RECEIPT) {
      target.droppedEntries += target.entries.length - MAX_ENTRIES_PER_RECEIPT;
      target.entries = target.entries.slice(-MAX_ENTRIES_PER_RECEIPT);
    }
  }
  target.updatedAt = timestamp();
  target.summary = buildSummary(target);
  notify(target);
  return sanitizeReceipt(target);
}

// Unattributed blocked attempts go to one rolling "Offline mode" receipt per offline period.
function addOfflineBlockedEntry(details = {}) {
  let receipt = offlineReceiptId ? getReceipt(offlineReceiptId) : null;
  if (!receipt) {
    const created = createReceipt({
      id: `offline-mode-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: 'offline',
      label: 'Offline mode',
      query: ''
    });
    offlineReceiptId = created.id;
    receipt = getReceipt(created.id);
  }
  return addEntry(receipt.id, { ...details, category: 'blocked' });
}

function setOffline(value) {
  const next = Boolean(value);
  if (next === offlineMode) return;
  offlineMode = next;
  offlineReceiptId = '';
  if (!next) {
    for (const receipt of receipts) {
      if (!receipt.offline) continue;
      receipt.offline = false;
      receipt.summary = buildSummary(receipt);
      notify(receipt);
    }
  }
}

function isOffline() {
  return offlineMode;
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

function addPermissionEntry({ origin = '', name = '', decision = '', embeddedIn = '' } = {}) {
  if (!getReceipt(PERMISSION_RECEIPT_ID)) {
    createReceipt({ id: PERMISSION_RECEIPT_ID, type: 'permissions', label: 'Website permissions', query: '' });
  }
  const embedded = embeddedIn ? ` (embedded in ${safeString(embeddedIn, 200)})` : '';
  return addEntry(PERMISSION_RECEIPT_ID, {
    category: 'permission',
    method: 'PERMISSION',
    url: /^https?:\/\//i.test(origin) ? origin : origin === 'Sovereign' ? 'sovereign://sovereign/' : '',
    whatWasSent: `Permission request: ${safeString(name, 60)} – ${safeString(decision, 200)}${embedded}`
  });
}

// Record which upstream engines SearXNG reported forwarding a query to. Uses only the JSON
// SearXNG already returned; never makes a request. Unknown receipt ids are ignored.
function recordSearxngForwarding(receiptId, { url = '', engines = [] } = {}) {
  const target = getReceipt(safeString(receiptId, 100));
  if (!target) {
    return null;
  }
  const host = hostFromUrl(cleanUrl(url));
  const names = [...new Set((Array.isArray(engines) ? engines : [])
    .filter(name => typeof name === 'string')
    .map(name => safeString(name, 60))
    .filter(Boolean))].sort((left, right) => left.localeCompare(right));
  target.forwarding = target.forwarding || {};
  target.forwarding[host] = [...new Set([...(target.forwarding[host] || []), ...names])]
    .sort((left, right) => left.localeCompare(right));

  const note = names.length > 0
    ? ` – SearXNG forwarded it to: ${forwardingNames(names)} (engines SearXNG reported; engines that returned nothing are not listed)`
    : ` – SearXNG forwarded it to ${FORWARDING_UNKNOWN}`;
  const entry = [...target.entries].reverse()
    .find(item => item.category === 'search' && item.host === host && !item.whatWasSent.includes(' – SearXNG forwarded it to'));
  if (entry) {
    entry.whatWasSent = `${entry.whatWasSent}${note}`.slice(0, 1200);
  }
  target.updatedAt = timestamp();
  target.summary = buildSummary(target);
  notify(target);
  return sanitizeReceipt(target);
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

function deleteReceipts(predicate) {
  const removed = receipts.filter(predicate);
  receipts = receipts.filter(receipt => !removed.includes(receipt));
  if (removed.some(receipt => receipt.id === backgroundReceiptId)) backgroundReceiptId = '';
  if (removed.some(receipt => receipt.id === offlineReceiptId)) offlineReceiptId = '';
  // Broadcast a deletion event without retaining the deleted receipt's contents.
  if (removed.length) for (const listener of listeners) { try { listener(null); } catch {} }
  return removed.length;
}

function resetForTests() {
  receipts = [];
  backgroundReceiptId = '';
  offlineMode = false;
  offlineReceiptId = '';
}

function onUpdate(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

module.exports = {
  CLOUD_AI_HOSTS,
  deleteReceipts,
  addEntry,
  addBackgroundEntry,
  addPermissionEntry,
  addOfflineBlockedEntry,
  setOffline,
  isOffline,
  PERMISSION_RECEIPT_ID,
  recordSearxngForwarding,
  createReceipt,
  exportPayload,
  fetchWithReceipt,
  getOrCreateBackgroundReceipt,
  getLatestReceipt,
  getReceipt,
  getReceipts,
  resetForTests,
  onUpdate
};
