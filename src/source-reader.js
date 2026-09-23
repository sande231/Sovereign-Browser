const dns = require('node:dns').promises;
const net = require('node:net');

const MAX_SOURCE_PAGES = 3;
const SOURCE_FETCH_TIMEOUT_MS = 10000;
const MAX_SOURCE_BYTES = 1_250_000;
const MAX_EXTRACTED_TEXT_CHARS = 120_000;
const MODEL_CONTEXT_TOKENS = 4096;
const RESPONSE_TOKEN_RESERVE = 700;
const PROMPT_OVERHEAD_TOKEN_RESERVE = 900;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const SOURCE_CONTEXT_CHAR_LIMIT = (MODEL_CONTEXT_TOKENS - RESPONSE_TOKEN_RESERVE - PROMPT_OVERHEAD_TOKEN_RESERVE) * CHARS_PER_TOKEN_ESTIMATE;
const MAX_PASSAGES_PER_SOURCE = 3;
const MAX_PASSAGE_CHARS = 900;
const MAX_REDIRECTS = 5;

const SOURCE_HEADERS = {
  accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.1',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent': 'Sovereign-Browser/0.1 local source reader'
};

const STOP_WORDS = new Set([
  'about',
  'after',
  'also',
  'and',
  'any',
  'are',
  'before',
  'been',
  'being',
  'both',
  'can',
  'does',
  'each',
  'from',
  'have',
  'into',
  'its',
  'may',
  'more',
  'most',
  'need',
  'not',
  'one',
  'some',
  'that',
  'the',
  'their',
  'them',
  'these',
  'they',
  'this',
  'those',
  'two',
  'use',
  'used',
  'using',
  'what',
  'when',
  'where',
  'which',
  'while',
  'with',
  'would',
  'could',
  'should',
  'you',
  'your'
]);

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function contentTerms(value) {
  const matches = String(value || '').toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) || [];
  return matches
    .map(term => term.replace(/[^a-z0-9]/g, ''))
    .map(term => term.endsWith('ves') && term.length > 5 ? `${term.slice(0, -3)}f` : term)
    .map(term => term.endsWith('s') && term.length > 4 ? term.slice(0, -1) : term)
    .filter(term => term.length >= 3 && !STOP_WORDS.has(term));
}

function isPrivateIpv4(address) {
  const parts = String(address || '').split('.').map(part => Number(part));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = parts;
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a >= 224);
}

function isPrivateIpv6(address) {
  const host = String(address || '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === '::' ||
    host === '::1' ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('fe80:') ||
    host.startsWith('::ffff:127.') ||
    host.startsWith('::ffff:10.') ||
    host.startsWith('::ffff:192.168.');
}

function isBlockedHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }

  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    return isPrivateIpv4(host);
  }
  if (ipVersion === 6) {
    return isPrivateIpv6(host);
  }

  return false;
}

async function validatePublicSourceUrl(value, resolveHostname = dns.lookup) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw new Error('Source URL is invalid.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Source URL must use http or https.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Source URL must not include credentials.');
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw new Error('Source fetching blocks localhost and private-network addresses.');
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!net.isIP(host)) {
    let records;
    try {
      records = await resolveHostname(host, { all: true });
    } catch {
      throw new Error('Could not resolve source host.');
    }
    const addresses = Array.isArray(records) ? records : [records];
    if (addresses.length === 0) {
      throw new Error('Could not resolve source host.');
    }
    if (addresses.some(record => isBlockedHostname(record.address))) {
      throw new Error('Source host resolves to a private-network address.');
    }
  }

  parsed.hash = '';
  return parsed.toString();
}

function decodeHtmlEntities(value) {
  const named = {
    amp: '&',
    apos: "'",
    gt: '>',
    hellip: '...',
    laquo: '"',
    lt: '<',
    mdash: '-',
    ndash: '-',
    nbsp: ' ',
    quot: '"',
    raquo: '"',
    rdquo: '"',
    rsquo: "'",
    ldquo: '"',
    lsquo: "'"
  };

  return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower[0] === '#') {
      const isHex = lower[1] === 'x';
      const codePoint = Number.parseInt(lower.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return named[lower] || match;
  });
}

function longestTaggedContent(html, tagName) {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  let best = '';
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const content = match[1] || '';
    if (content.length > best.length) {
      best = content;
    }
  }
  return best;
}

function removeTaggedContent(html, tagNames) {
  let output = html;
  for (const tagName of tagNames) {
    const pattern = new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, 'gi');
    output = output.replace(pattern, ' ');
  }
  return output;
}

function removeNoisyElements(html) {
  const noiseWords = [
    'ads',
    'advert',
    'banner',
    'breadcrumb',
    'cookie',
    'comment',
    'footer',
    'header',
    'login',
    'modal',
    'nav',
    'newsletter',
    'popup',
    'promo',
    'recommend',
    'related',
    'share',
    'sidebar',
    'sign-?up',
    'social',
    'sponsor',
    'subscribe'
  ].join('|');
  const noisyElement = new RegExp(`<([a-z0-9]+)\\b[^>]*(?:class|id|role|aria-label)=["'][^"']*(?:${noiseWords})[^"']*["'][^>]*>[\\s\\S]*?<\\/\\1>`, 'gi');

  let output = html;
  for (let pass = 0; pass < 4; pass += 1) {
    output = output.replace(noisyElement, ' ');
  }
  return output;
}

function extractTitle(html) {
  const metaTitle = html.match(/<meta\b[^>]*(?:property|name)=["'](?:og:title|twitter:title)["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:title|twitter:title)["'][^>]*>/i);
  if (metaTitle?.[1]) {
    return normalizeText(decodeHtmlEntities(metaTitle[1])).slice(0, 240);
  }

  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return normalizeText(decodeHtmlEntities(title?.[1] || '')).slice(0, 240);
}

function isBoilerplateLine(line) {
  return /\b(advertisement|all rights reserved|cookie|cookies|follow us|log in|newsletter|privacy policy|recommended|related articles|share this|sign in|sign up|sponsored|subscribe|terms of use)\b/i.test(line);
}

function htmlToText(html) {
  return decodeHtmlEntities(html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote)>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' '))
    .split(/\n+/)
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(line => line.length >= 2 && !isBoilerplateLine(line))
    .join('\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractReadableText(html, { truncated = false } = {}) {
  const raw = String(html || '');
  const title = extractTitle(raw);
  const body = raw.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] || raw;
  const article = longestTaggedContent(body, 'article');
  const main = longestTaggedContent(body, 'main');
  let selected = article.length > 1000 ? article : (main.length > 1000 ? main : body);

  selected = selected.replace(/<!--[\s\S]*?-->/g, ' ');
  selected = removeTaggedContent(selected, [
    'script',
    'style',
    'noscript',
    'template',
    'svg',
    'canvas',
    'iframe',
    'picture',
    'source',
    'video',
    'audio',
    'form',
    'button',
    'select',
    'textarea',
    'nav',
    'header',
    'footer',
    'aside'
  ]);
  selected = removeNoisyElements(selected);

  const text = htmlToText(selected);
  const partial = truncated || text.length > MAX_EXTRACTED_TEXT_CHARS;
  return {
    title,
    text: text.slice(0, MAX_EXTRACTED_TEXT_CHARS),
    partial
  };
}

function splitSentences(text) {
  return normalizeText(text)
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.trim())
    .filter(Boolean);
}

function splitIntoPassages(text, question = '') {
  const windows = [];
  const paragraphs = String(text || '')
    .split(/\n{2,}/)
    .map(paragraph => normalizeText(paragraph))
    .filter(paragraph => paragraph.length >= 80);

  for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
    const sentences = splitSentences(paragraph);
    if (sentences.length === 0) {
      continue;
    }

    for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex += 1) {
      const sentence = sentences[sentenceIndex];
      const directness = directAnswerSignal(question, sentence);
      if (directness === 0 && !hasQuestionOverlap(question, sentence)) {
        continue;
      }

      const selected = [sentence];
      const previous = sentences[sentenceIndex - 1] || '';
      const next = sentences[sentenceIndex + 1] || '';
      if (previous && hasQuestionOverlap(question, previous) && `${previous} ${selected.join(' ')}`.length <= MAX_PASSAGE_CHARS) {
        selected.unshift(previous);
      }
      if (next && (directAnswerSignal(question, next) > 0 || hasQuestionOverlap(question, next)) && `${selected.join(' ')} ${next}`.length <= MAX_PASSAGE_CHARS) {
        selected.push(next);
      }

      windows.push({
        paragraphIndex,
        sentenceIndex,
        directness,
        text: selected.join(' ')
      });
    }

    if (paragraph.length <= MAX_PASSAGE_CHARS && directAnswerSignal(question, paragraph) > 0) {
      windows.push({
        paragraphIndex,
        sentenceIndex: 0,
        directness: directAnswerSignal(question, paragraph),
        text: paragraph
      });
    }
  }

  return windows
    .filter(window => window.text.length >= 60)
    .filter((window, index, all) => all.findIndex(other => other.text === window.text) === index);
}

function termSimilarity(left, right) {
  const leftTerms = new Set(contentTerms(left));
  const rightTerms = new Set(contentTerms(right));
  if (leftTerms.size === 0 || rightTerms.size === 0) {
    return 0;
  }

  let shared = 0;
  for (const term of leftTerms) {
    if (rightTerms.has(term)) {
      shared += 1;
    }
  }
  const union = new Set([...leftTerms, ...rightTerms]).size;
  return union === 0 ? 0 : shared / union;
}

function asksForCause(question) {
  return /\b(why|cause|causes|caused|reason|reasons)\b/i.test(question);
}

function asksForComparison(question) {
  return /\b(difference|different|compare|comparison|versus|between|distinguish|distinction)\b|\bvs\.?\b/i.test(question);
}

function asksForDefinition(question) {
  return /\b(what is|what are|define|definition|meaning|refers to)\b/i.test(question);
}

function directAnswerSignal(question, passage) {
  const text = String(passage || '');
  let score = 0;
  if (asksForCause(question)) {
    if (/\b(because|cause|causes|caused|due|driven|generates?|lead|leads|produces?|result|results|signal|trigger|triggers|force|pull)\b/i.test(text)) {
      score += 6;
    }
    if (/\b(shorter|longer|less|more|colder|warmer|sunlight|temperature|temperatures|environment)\b/i.test(text)) {
      score += 3;
    }
    if (/\b(starts?|stops?|fade|fades|fading|visible|creates?|forms?|formation)\b/i.test(text)) {
      score += 3;
    }
  }
  if (asksForComparison(question) && /\b(difference|different|differ|differs|while|whereas|but|however|unlike|compared|contrast|mutability|mutable|immutable|performance|memory|syntax)\b/i.test(text)) {
    score += 8;
  }
  if (asksForDefinition(question) && /\b(is|are|means|refers to|defined as|called)\b/i.test(text)) {
    score += 4;
  }
  if (/\b(first|then|therefore|as a result|creates?|forms?|formation|explains?)\b/i.test(text)) {
    score += 2;
  }
  return score;
}

function hasQuestionOverlap(question, passage) {
  const questionTerms = new Set(contentTerms(question));
  const passageTerms = new Set(contentTerms(passage));
  let overlap = 0;
  for (const term of questionTerms) {
    if (passageTerms.has(term)) {
      overlap += 1;
    }
  }
  return overlap >= Math.min(2, questionTerms.size);
}

function scorePassage(question, passage) {
  const questionTerms = new Set(contentTerms(question));
  const passageTerms = new Set(contentTerms(passage));
  let overlap = 0;
  for (const term of questionTerms) {
    if (passageTerms.has(term)) {
      overlap += 1;
    }
  }

  const explanatory = directAnswerSignal(question, passage);
  const density = overlap / Math.max(1, passageTerms.size);
  return overlap * 4 + density * 10 + explanatory;
}

function selectRelevantPassages(question, text, {
  maxPassages = MAX_PASSAGES_PER_SOURCE,
  maxChars = SOURCE_CONTEXT_CHAR_LIMIT
} = {}) {
  const questionTerms = new Set(contentTerms(question));
  if (questionTerms.size === 0) {
    return [];
  }

  const directQuestion = asksForCause(question) || asksForComparison(question) || asksForDefinition(question);
  const candidates = splitIntoPassages(text, question)
    .map((passage, index) => ({
      index,
      sourceOrder: passage.paragraphIndex * 1000 + passage.sentenceIndex,
      text: passage.text,
      directness: passage.directness,
      score: scorePassage(question, passage.text)
    }))
    .filter(candidate => candidate.score > 0 && (!directQuestion || candidate.directness > 0))
    .sort((left, right) => right.score - left.score || left.index - right.index);

  const selected = [];
  let totalChars = 0;
  for (const candidate of candidates) {
    if (selected.some(existing => termSimilarity(existing.text, candidate.text) > 0.55)) {
      continue;
    }
    if (totalChars + candidate.text.length > maxChars && selected.length > 0) {
      break;
    }
    selected.push(candidate);
    totalChars += candidate.text.length;
    if (selected.length >= maxPassages) {
      break;
    }
  }

  return selected
    .sort((left, right) => left.sourceOrder - right.sourceOrder)
    .map(candidate => candidate.text);
}

function normalizeRequestedResult(result, index) {
  let parsed;
  try {
    parsed = new URL(String(result?.url || ''));
  } catch {
    parsed = null;
  }

  return {
    id: Number.isInteger(result?.id) ? result.id : index + 1,
    title: normalizeText(result?.title || `Result ${index + 1}`).slice(0, 240),
    url: parsed && ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : '',
    snippet: normalizeText(result?.snippet || '').slice(0, 1000)
  };
}

function snippetSource(result, patch = {}) {
  return {
    ...result,
    evidenceMode: 'snippet',
    evidenceText: result.snippet,
    selectedPassages: [],
    partial: false,
    attempted: false,
    fetchedUrl: '',
    fetchedBytes: 0,
    error: '',
    note: 'Using search snippet.',
    ...patch
  };
}

function sourceActivityEntry({
  sourceId,
  url,
  status = 'source-started',
  durationMs = null,
  error = '',
  bytes = null,
  truncated = false,
  mode = ''
}) {
  let endpoint = 'invalid source URL';
  try {
    const parsed = new URL(url);
    endpoint = `${parsed.origin}${parsed.pathname || ''}`;
  } catch {
    // Keep the generic label.
  }

  return {
    kind: 'source',
    at: new Date().toISOString(),
    endpoint,
    method: 'GET',
    status,
    sourceId,
    durationMs,
    error: String(error || '').slice(0, 500),
    bytes,
    truncated: Boolean(truncated),
    mode
  };
}

async function readLimitedResponseText(response, maxBytes = MAX_SOURCE_BYTES) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    const bytes = Buffer.byteLength(text);
    return {
      text: text.slice(0, maxBytes),
      bytes: Math.min(bytes, maxBytes),
      truncated: bytes > maxBytes
    };
  }

  const decoder = new TextDecoder();
  const chunks = [];
  let bytes = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    const remaining = maxBytes - bytes;
    if (remaining <= 0) {
      truncated = true;
      await reader.cancel();
      break;
    }

    const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
    chunks.push(decoder.decode(chunk, { stream: true }));
    bytes += chunk.byteLength;
    if (value.byteLength > remaining) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }

  chunks.push(decoder.decode());
  return {
    text: chunks.join(''),
    bytes,
    truncated
  };
}

async function fetchPublicPage(url, {
  fetchImpl = fetch,
  signal,
  timeoutMs = SOURCE_FETCH_TIMEOUT_MS,
  resolveHostname = dns.lookup
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  if (signal?.aborted) {
    controller.abort();
  } else {
    signal?.addEventListener('abort', abort, { once: true });
  }

  let currentUrl = url;
  try {
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const checkedUrl = await validatePublicSourceUrl(currentUrl, resolveHostname);
      const response = await fetchImpl(checkedUrl, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        headers: SOURCE_HEADERS,
        signal: controller.signal
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new Error(`Source redirected with HTTP ${response.status} but no Location header.`);
        }
        currentUrl = new URL(location, checkedUrl).toString();
        continue;
      }

      if (!response.ok) {
        throw new Error(`Source returned HTTP ${response.status}.`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType && !/(?:text\/html|application\/xhtml\+xml|text\/plain)/i.test(contentType)) {
        throw new Error(`Unsupported source content type: ${contentType.split(';')[0]}.`);
      }

      const body = await readLimitedResponseText(response);
      return {
        finalUrl: checkedUrl,
        contentType,
        ...body
      };
    }

    throw new Error('Source redirected too many times.');
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new DOMException('Source reading was canceled.', 'AbortError');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

function trimContextToLimit(sources, limit = SOURCE_CONTEXT_CHAR_LIMIT) {
  let used = 0;
  return sources.map(source => {
    if (source.evidenceMode !== 'page') {
      return source;
    }

    const selectedPassages = [];
    let omitted = false;
    for (const passage of source.selectedPassages) {
      if (used + passage.length > limit && selectedPassages.length > 0) {
        omitted = true;
        continue;
      }
      if (used + passage.length > limit && selectedPassages.length === 0) {
        const slice = passage.slice(0, Math.max(300, limit - used));
        selectedPassages.push(slice);
        used += slice.length;
        omitted = true;
        continue;
      }
      selectedPassages.push(passage);
      used += passage.length;
    }

    if (selectedPassages.length === 0) {
      return snippetSource(source, {
        attempted: source.attempted,
        error: 'Selected page passages exceeded the local model context limit.',
        note: 'Using snippet because selected page passages exceeded the local model context limit.'
      });
    }

    return {
      ...source,
      selectedPassages,
      evidenceText: selectedPassages.join('\n\n'),
      partial: source.partial || omitted,
      note: `Used page text: ${selectedPassages.length} passage${selectedPassages.length === 1 ? '' : 's'} selected.${source.partial || omitted ? ' Only part of the page was processed.' : ''}`
    };
  });
}

async function readOneSource(question, result, options) {
  const startedAt = Date.now();
  options.onActivity?.(sourceActivityEntry({
    sourceId: result.id,
    url: result.url,
    status: 'source-started'
  }));

  try {
    const fetched = await fetchPublicPage(result.url, options);
    const extracted = extractReadableText(fetched.text, { truncated: fetched.truncated });
    const passages = selectRelevantPassages(question, extracted.text);
    const durationMs = Date.now() - startedAt;

    if (passages.length === 0) {
      options.onActivity?.(sourceActivityEntry({
        sourceId: result.id,
        url: result.url,
        status: 'source-complete',
        durationMs,
        bytes: fetched.bytes,
        truncated: fetched.truncated,
        mode: 'snippet'
      }));
      return snippetSource(result, {
        attempted: true,
        fetchedUrl: fetched.finalUrl,
        fetchedBytes: fetched.bytes,
        partial: extracted.partial,
        error: 'No relevant readable passage was found in the downloaded page.',
        note: `Using snippet because no relevant readable passage was found in the downloaded page.${extracted.partial ? ' Only part of the page was processed.' : ''}`
      });
    }

    options.onActivity?.(sourceActivityEntry({
      sourceId: result.id,
      url: result.url,
      status: 'source-complete',
      durationMs,
      bytes: fetched.bytes,
      truncated: fetched.truncated || extracted.partial,
      mode: 'page'
    }));

    return {
      ...result,
      title: extracted.title || result.title,
      evidenceMode: 'page',
      evidenceText: passages.join('\n\n'),
      selectedPassages: passages,
      partial: extracted.partial,
      attempted: true,
      fetchedUrl: fetched.finalUrl,
      fetchedBytes: fetched.bytes,
      error: '',
      note: `Used page text: ${passages.length} passage${passages.length === 1 ? '' : 's'} selected.${extracted.partial ? ' Only part of the page was processed.' : ''}`
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      options.onActivity?.(sourceActivityEntry({
        sourceId: result.id,
        url: result.url,
        status: 'source-canceled',
        durationMs: Date.now() - startedAt,
        error: error.message || String(error)
      }));
      throw error;
    }

    options.onActivity?.(sourceActivityEntry({
      sourceId: result.id,
      url: result.url,
      status: 'source-error',
      durationMs: Date.now() - startedAt,
      error: error.message || String(error)
    }));

    return snippetSource(result, {
      attempted: true,
      error: error.message || String(error),
      note: `Using snippet because the source page could not be read: ${error.message || String(error)}`
    });
  }
}

async function readSourcePages({ question, results, signal, onActivity, fetchImpl, resolveHostname, timeoutMs } = {}) {
  const safeQuestion = normalizeText(question).slice(0, 300);
  if (!safeQuestion) {
    throw new Error('Enter a search question before reading sources.');
  }

  const safeResults = (Array.isArray(results) ? results : [])
    .slice(0, 5)
    .map(normalizeRequestedResult);

  const sources = [];
  for (let index = 0; index < safeResults.length; index += 1) {
    if (signal?.aborted) {
      throw new DOMException('Source reading was canceled.', 'AbortError');
    }

    const result = safeResults[index];
    if (!result.url) {
      sources.push(snippetSource(result, {
        attempted: index < MAX_SOURCE_PAGES,
        error: 'Result URL is invalid.',
        note: 'Using snippet because the result URL is invalid.'
      }));
      continue;
    }

    if (index >= MAX_SOURCE_PAGES) {
      sources.push(snippetSource(result, {
        note: 'Using snippet because only the top 3 results are read.'
      }));
      continue;
    }

    sources.push(await readOneSource(safeQuestion, result, {
      signal,
      onActivity,
      fetchImpl,
      resolveHostname,
      timeoutMs
    }));
  }

  return {
    question: safeQuestion,
    sources: trimContextToLimit(sources)
  };
}

module.exports = {
  MAX_SOURCE_PAGES,
  SOURCE_CONTEXT_CHAR_LIMIT,
  extractReadableText,
  selectRelevantPassages,
  sourceActivityEntry,
  validatePublicSourceUrl,
  readSourcePages
};
