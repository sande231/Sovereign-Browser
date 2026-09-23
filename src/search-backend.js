const DEFAULT_SEARXNG_ENDPOINT = 'http://127.0.0.1:8080/search';
const SEARCH_TIMEOUT_MS = 8000;
const MAX_SEARCH_QUERY_LENGTH = 300;
const MAX_ENDPOINT_LENGTH = 300;
const MAX_SEARCH_RESULTS = 5;
const MAX_MEDIA_RESULTS = 8;

function stripHtml(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSearchQuery(value) {
  const query = String(value || '').replace(/\s+/g, ' ').trim();
  if (!query) {
    throw new Error('Enter a search question.');
  }
  if (query.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new Error(`Search questions must be ${MAX_SEARCH_QUERY_LENGTH} characters or fewer.`);
  }
  return query;
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split('.').map(part => Number(part));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = parts;
  return a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254);
}

function isAllowedEndpointHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('fe80') ||
    isPrivateIpv4(host);
}

function normalizeSearxngEndpoint(value = DEFAULT_SEARXNG_ENDPOINT) {
  let raw = String(value || DEFAULT_SEARXNG_ENDPOINT).trim();
  if (!raw) {
    return DEFAULT_SEARXNG_ENDPOINT;
  }
  if (raw.length > MAX_ENDPOINT_LENGTH) {
    throw new Error(`SearXNG endpoint must be ${MAX_ENDPOINT_LENGTH} characters or fewer.`);
  }
  if (!/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(raw)) {
    raw = `http://${raw}`;
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('SearXNG endpoint must be a valid URL.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('SearXNG endpoint must use http or https.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('SearXNG endpoint must not include credentials.');
  }
  if (!isAllowedEndpointHost(parsed.hostname)) {
    throw new Error('Use a localhost or private-network SearXNG endpoint. Sovereign will not silently use a public instance.');
  }

  if (parsed.pathname === '' || parsed.pathname === '/') {
    parsed.pathname = '/search';
  } else if (parsed.pathname.endsWith('/')) {
    parsed.pathname = `${parsed.pathname}search`;
  }

  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function validateResultUrl(value) {
  let raw = String(value || '').trim();
  if (raw.startsWith('//')) {
    raw = `https:${raw}`;
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    return null;
  }
  return parsed.toString();
}

const MEDIA_QUERY_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'show', 'find', 'give', 'get',
  'picture', 'pictures', 'photo', 'photos', 'image', 'images', 'video',
  'videos', 'clip', 'clips', 'media'
]);

function mediaQueryTerms(query) {
  return String(query || '')
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9-]{1,}/g)
    ?.map(term => term.endsWith('s') && term.length > 4 ? term.slice(0, -1) : term)
    .filter(term => term.length >= 3 && !MEDIA_QUERY_STOP_WORDS.has(term)) || [];
}

function mediaRelevanceScore(item, terms) {
  if (!terms.length) {
    return 1;
  }
  const title = String(item.title || '').toLowerCase();
  const content = String(item.content || '').toLowerCase();
  const sourceUrl = String(item.sourceUrl || '').toLowerCase();
  const mediaUrl = String(item.mediaUrl || '').toLowerCase();
  const engine = String(item.engine || '').toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 5;
    if (content.includes(term)) score += 2;
    if (sourceUrl.includes(term)) score += 1;
    if (mediaUrl.includes(term)) score += 1;
  }
  if (/\b(lucide|devicons)\b/.test(engine) && score === 0) {
    score -= 5;
  }
  return score;
}

function normalizeResult(result, index) {
  const url = validateResultUrl(result?.url);
  if (!url) {
    return null;
  }

  const title = stripHtml(result?.title || result?.url || 'Untitled result').slice(0, 240);
  const snippet = stripHtml(result?.content || result?.snippet || result?.description || '').slice(0, 600);
  return {
    id: index + 1,
    title,
    url,
    snippet
  };
}

function sourceDomain(value) {
  try {
    return new URL(String(value || '')).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function normalizeMediaResult(result, index, type) {
  const pageUrl = validateResultUrl(result?.url);
  const mediaUrl = type === 'videos'
    ? validateResultUrl(result?.video_src || result?.media_src || result?.iframe_src || result?.embedded || result?.content || '')
    : validateResultUrl(result?.img_src || result?.image || result?.original || result?.media_src || '');
  const thumbnailUrl = validateResultUrl(result?.thumbnail || result?.thumbnail_src || result?.img_src || '');
  if (!pageUrl && !mediaUrl && !thumbnailUrl) {
    return null;
  }
  const directUrl = mediaUrl || '';
  const title = stripHtml(result?.title || result?.url || directUrl || 'Untitled media result').slice(0, 240);
  const sourceUrl = pageUrl || directUrl || thumbnailUrl;
  const license = stripHtml(result?.license || result?.rights || result?.metadata?.license || '').slice(0, 160);
  const creator = stripHtml(result?.author || result?.creator || result?.metadata?.author || '').slice(0, 160);
  const engine = stripHtml(Array.isArray(result?.engines) ? result.engines.join(', ') : result?.engine || '').slice(0, 120);
  return {
    id: index + 1,
    stableId: `${type}-${index + 1}-${sourceDomain(sourceUrl) || 'source'}`,
    type,
    title,
    sourceUrl,
    mediaUrl: directUrl,
    originalMediaUrl: directUrl,
    thumbnailUrl: thumbnailUrl || directUrl,
    content: stripHtml(result?.content || result?.snippet || result?.description || '').slice(0, 600),
    sourceDomain: sourceDomain(sourceUrl),
    license: license || 'License unknown',
    creator,
    engine,
    isDirectMediaCandidate: Boolean(directUrl)
  };
}

function normalizeSearxngResults(payload, limit = MAX_SEARCH_RESULTS) {
  const rawResults = Array.isArray(payload?.results) ? payload.results : [];
  const results = [];
  for (const raw of rawResults) {
    const result = normalizeResult(raw, results.length);
    if (result) {
      results.push(result);
    }
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}

function normalizeSearxngMediaResults(payload, type, limit = MAX_MEDIA_RESULTS, query = '') {
  const rawResults = Array.isArray(payload?.results) ? payload.results : [];
  const results = [];
  for (const raw of rawResults) {
    const result = normalizeMediaResult(raw, results.length, type);
    if (result) {
      results.push(result);
    }
  }
  const terms = mediaQueryTerms(query);
  const scored = results.map((result, rawIndex) => ({
    result,
    rawIndex,
    score: mediaRelevanceScore(result, terms)
  }));
  const hasRelevant = scored.some(item => item.score > 0);
  return scored
    .filter(item => !hasRelevant || item.score > 0)
    .sort((left, right) => right.score - left.score || left.rawIndex - right.rawIndex)
    .slice(0, limit)
    .map((item, index) => ({
      ...item.result,
      id: index + 1
    }));
}

function requestActivityEntry({ endpoint, query, status = 'started', resultCount = null, durationMs = null, error = '' }) {
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    parsed = { origin: 'invalid', pathname: '' };
  }

  return {
    at: new Date().toISOString(),
    endpoint: `${parsed.origin}${parsed.pathname || ''}`,
    method: 'GET',
    status,
    queryLength: query.length,
    resultCount,
    durationMs,
    error: String(error || '').slice(0, 500)
  };
}

async function searchSearxng({ query, endpoint = DEFAULT_SEARXNG_ENDPOINT, fetchImpl = fetch, signal, timeoutMs = SEARCH_TIMEOUT_MS }) {
  const checkedQuery = normalizeSearchQuery(query);
  const checkedEndpoint = normalizeSearxngEndpoint(endpoint);
  const url = new URL(checkedEndpoint);
  url.searchParams.set('q', checkedQuery);
  url.searchParams.set('format', 'json');
  url.searchParams.set('language', 'en-US');
  url.searchParams.set('safesearch', '1');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });

  const startedAt = Date.now();
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        accept: 'application/json'
      }
    });

    if (!response.ok) {
      const hint = response.status === 403
        ? ' SearXNG may not have JSON format enabled in settings.yml.'
        : '';
      throw new Error(`SearXNG returned HTTP ${response.status}.${hint}`);
    }

    const payload = await response.json();
    const results = normalizeSearxngResults(payload);
    return {
      query: checkedQuery,
      endpoint: checkedEndpoint,
      results,
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new DOMException('Search was canceled.', 'AbortError');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

async function searchSearxngMedia({ query, type = 'images', endpoint = DEFAULT_SEARXNG_ENDPOINT, fetchImpl = fetch, signal, timeoutMs = SEARCH_TIMEOUT_MS }) {
  const checkedQuery = normalizeSearchQuery(query);
  const mediaType = type === 'videos' ? 'videos' : 'images';
  const checkedEndpoint = normalizeSearxngEndpoint(endpoint);
  const url = new URL(checkedEndpoint);
  url.searchParams.set('q', checkedQuery);
  url.searchParams.set('format', 'json');
  url.searchParams.set('language', 'en-US');
  url.searchParams.set('safesearch', '1');
  url.searchParams.set('categories', mediaType);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });

  const startedAt = Date.now();
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        accept: 'application/json'
      }
    });
    if (!response.ok) {
      const hint = response.status === 403
        ? ' SearXNG may not have JSON format or this category enabled in settings.yml.'
        : '';
      throw new Error(`SearXNG returned HTTP ${response.status}.${hint}`);
    }
    const payload = await response.json();
    return {
      query: checkedQuery,
      endpoint: checkedEndpoint,
      category: mediaType,
      results: normalizeSearxngMediaResults(payload, mediaType, MAX_MEDIA_RESULTS, checkedQuery),
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new DOMException('Media search was canceled.', 'AbortError');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

module.exports = {
  DEFAULT_SEARXNG_ENDPOINT,
  SEARCH_TIMEOUT_MS,
  MAX_SEARCH_QUERY_LENGTH,
  MAX_SEARCH_RESULTS,
  normalizeSearchQuery,
  normalizeSearxngEndpoint,
  normalizeSearxngResults,
  normalizeSearxngMediaResults,
  requestActivityEntry,
  searchSearxng,
  searchSearxngMedia,
  stripHtml
};
