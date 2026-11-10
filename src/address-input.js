// Pure address-bar classification shared by browser navigation and New Tab.

function normalizeInternalUrl(input) {
  let parsed;
  try {
    parsed = new URL(String(input || ''));
  } catch {
    return null;
  }

  if (parsed.protocol !== 'sovereign:') {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (!['newtab', 'search', 'ask', 'downloads', 'settings', 'bookmarks'].includes(host)) {
    return null;
  }

  parsed.pathname = '/';
  parsed.hash = '';
  if (host !== 'search' && host !== 'ask') {
    parsed.search = '';
  }
  return parsed.toString();
}

function normalizeAddress(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    return { ok: false, error: 'Enter a website address.' };
  }

  let candidate = raw;
  if (!/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(candidate)) {
    const localLike = /^localhost(?::\d{1,5})?(?:\/|$)/i.test(candidate) ||
      /^\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?(?:\/|$)/.test(candidate) || /^\[[0-9a-f:.]+\]/i.test(candidate);
    candidate = `${localLike ? 'http' : 'https'}://${candidate}`;
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, error: 'That address is not a valid URL.' };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, error: 'Sovereign only opens http and https websites.' };
  }

  if (!parsed.hostname) {
    return { ok: false, error: 'That address needs a website host.' };
  }

  return { ok: true, url: parsed.toString() };
}

function normalizeSearchQuestion(input) {
  return String(input || '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function looksLikeHostAddress(value) {
  const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  const domain = `(?:${label}\\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]+)`;
  const host = `(?:localhost|\\d{1,3}(?:\\.\\d{1,3}){3}|\\[[0-9a-f:.]+\\]|${domain})`;
  return new RegExp(`^${host}(?::\\d{1,5})?(?:[/?#]\\S*)?$`, 'i').test(String(value || ''));
}

function classifyAddressInput(input) {
  const raw = String(input || '').trim();
  const emptyError = { kind: 'error', error: 'Enter a website address or search question.' };
  const search = question => ({ kind: 'search', question: normalizeSearchQuestion(question), mode: 'search' });
  const address = () => {
    const checked = normalizeAddress(raw);
    return checked.ok ? { kind: 'url', url: checked.url } : { kind: 'error', error: checked.error };
  };
  if (!raw) return emptyError;
  if (raw.startsWith('?')) {
    const question = raw.slice(1).trim();
    return question ? search(question) : emptyError;
  }
  const internal = normalizeInternalUrl(raw);
  if (internal) return { kind: 'internal', url: internal };
  if (/^https?:\/\//i.test(raw)) return address();
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ||
      (!/\s/.test(raw) && /^(?:about|blob|chrome|chrome-extension|data|devtools|file|ftp|intent|javascript|magnet|mailto|sms|tel|view-source|ws|wss):/i.test(raw))) {
    return { kind: 'error', error: 'Sovereign only opens http and https websites.' };
  }
  if (/\s/.test(raw)) return search(raw);
  return looksLikeHostAddress(raw) ? address() : search(raw);
}

module.exports = {
  classifyAddressInput,
  normalizeAddress,
  normalizeInternalUrl,
  normalizeSearchQuestion,
  looksLikeHostAddress
};
