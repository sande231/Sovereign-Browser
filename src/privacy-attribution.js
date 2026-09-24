const IGNORED_SCHEMES = new Set(['file:', 'devtools:', 'blob:', 'data:', 'sovereign:']);

function schemeOf(value) {
  try {
    return new URL(String(value || '')).protocol;
  } catch {
    return '';
  }
}

function originFromUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
}

function isHttpUrl(value) {
  const scheme = schemeOf(value);
  return scheme === 'http:' || scheme === 'https:';
}

function isIgnoredRequestUrl(value) {
  return IGNORED_SCHEMES.has(schemeOf(value));
}

function isAppFileUrl(value, appRoot = '') {
  if (schemeOf(value) !== 'file:') {
    return false;
  }
  if (!appRoot) {
    return true;
  }
  try {
    const pathname = decodeURIComponent(new URL(String(value)).pathname);
    return pathname.startsWith(appRoot);
  } catch {
    return false;
  }
}

function isInternalCurrentUrl(value, { allowAppFile = false, appRoot = '' } = {}) {
  const scheme = schemeOf(value);
  return scheme === 'sovereign:' || (allowAppFile && isAppFileUrl(value, appRoot));
}

function requestOriginCandidates(details = {}) {
  return [
    details.initiator,
    details.documentUrl,
    details.frame?.url,
    details.referrer,
    details.originUrl
  ].filter(Boolean);
}

function classifyPrivacyRequest(details = {}, context = {}) {
  if (isIgnoredRequestUrl(details.url)) {
    return { action: 'ignore', reason: 'ignored-scheme' };
  }

  const currentUrl = String(context.currentUrl || '');
  if (context.hasWebContents) {
    if (context.tabKind === 'web' || isHttpUrl(currentUrl)) {
      return { action: 'ignore', reason: 'web-content' };
    }

    const trustedRole = Boolean(context.isUiView || context.isSidebarView || context.isAiView || (context.tabKind && context.tabKind !== 'web'));
    const trustedCurrentUrl = isInternalCurrentUrl(currentUrl, {
      allowAppFile: Boolean(context.isUiView),
      appRoot: context.appRoot
    });
    if (!trustedRole || !trustedCurrentUrl) {
      return { action: 'ignore', reason: 'untrusted-current-url' };
    }

    return context.activeReceiptId
      ? { action: 'receipt', receiptId: context.activeReceiptId, unattributed: false }
      : { action: 'background', unattributed: false };
  }

  const candidates = requestOriginCandidates(details);
  for (const candidate of candidates) {
    const origin = originFromUrl(candidate);
    if (origin && context.openWebOrigins?.has?.(origin)) {
      return { action: 'ignore', reason: 'web-origin' };
    }
    if (isHttpUrl(candidate)) {
      return { action: 'ignore', reason: 'http-origin' };
    }
    if (isInternalCurrentUrl(candidate, { allowAppFile: true, appRoot: context.appRoot })) {
      return { action: 'background', unattributed: false };
    }
  }

  return { action: 'debug-skip', reason: candidates.length === 0 ? 'unattributed' : 'unknown-origin' };
}

module.exports = {
  IGNORED_SCHEMES,
  classifyPrivacyRequest,
  isHttpUrl,
  isInternalCurrentUrl,
  originFromUrl,
  requestOriginCandidates,
  schemeOf
};
