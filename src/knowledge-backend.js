'use strict';

const http = require('node:http');
const {
  isLoopbackHost,
  hostPortOf
} = require('./network-mode');
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8090';
function normalizeKiwixEndpoint(value = DEFAULT_ENDPOINT, {
  blockedHostPorts = []
} = {}) {
  let u;
  try {
    u = new URL(String(value));
  } catch {
    throw Error('Invalid local knowledge endpoint.');
  }
  if (u.protocol !== 'http:' ||
      !isLoopbackHost(u.hostname) ||
      /localhost\.?$/.test(u.hostname) && u.hostname !== 'localhost' ||
      u.username ||
      u.password ||
      u.pathname !== '/' ||
      u.search ||
      u.hash ||
      blockedHostPorts.some(v => (typeof v === 'string' ? v : v.entry) === hostPortOf(u))) throw Error('Use a loopback HTTP endpoint separate from SearXNG and the audit proxy.');
  return u.origin;
}
function buildSearchUrl(endpoint, {
  pattern = '',
  books = [],
  pageLength = 10
} = {}) {
  const u = new URL('/search', normalizeKiwixEndpoint(endpoint));
  u.searchParams.set('pattern', String(pattern).slice(0, 2000));
  u.searchParams.set('format', 'xml');
  u.searchParams.set('pageLength', String(Math.max(1, Math.min(10, Math.floor(Number(pageLength) || 10)))));
  for (const name of books) u.searchParams.append('books.name', String(name));
  return u.href;
}
function decode(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, v) => {
    if (v[0] === '#') {
      const n = v[1].toLowerCase() === 'x' ? parseInt(v.slice(2), 16) : Number(v.slice(1));
      if (n < 32 && ![9, 10, 13].includes(n) || n > 0x10ffff || n >= 0xd800 && n <= 0xdfff) throw Error('XML');
      return String.fromCodePoint(n);
    }
    return {
      amp: '&',
      lt: '<',
      gt: '>',
      quot: '"',
      apos: "'"
    }[v];
  });
}
// Small non-expanding XML reader: no DTD/entities, exact nesting, one root, bounded input.
// CDATA and escaped markup are text, never executed. Invalid input fails closed.
function xmlTree(value) {
  try {
    const xml = String(value);
    if (xml.length > 5 * 1024 * 1024 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(xml) || /<!DOCTYPE|<!ENTITY/i.test(xml)) return null;
    // `parts` keeps text and child elements in document order, so mixed content such as
    // kiwix-serve's `<description>...of <b>Earth</b>, a...</description>` reads correctly.
    const root = {
        name: '',
        children: [],
        parts: []
      },
      stack = [root];
    let pos = 0;
    const token = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<[^>]*>|[^<]+/g;
    let m;
    while (m = token.exec(xml)) {
      if (m.index !== pos) throw Error('XML');
      pos = token.lastIndex;
      const t = m[0],
        parent = stack.at(-1);
      if (t.startsWith('<!--')) {
        if (t.slice(4, -3).includes('--')) throw Error('XML');
        continue;
      }
      if (t.startsWith('<?')) {
        if (stack.length !== 1 || root.children.length) throw Error('XML');
        continue;
      }
      if (t.startsWith('<![CDATA[')) {
        if (stack.length === 1) throw Error('XML');
        parent.parts.push(t.slice(9, -3));
        continue;
      }
      if (t.startsWith('</')) {
        if (!/^<\/[\w:.-]+\s*>$/.test(t) || stack.length === 1 || stack.pop().name !== t.slice(2, -1).trim()) throw Error('XML');
        continue;
      }
      if (t[0] === '<') {
        const tag = /^<([A-Za-z_][\w:.-]*)([\s\S]*?)(\/?)>$/.exec(t);
        if (!tag) throw Error('XML');
        let attrs = tag[2];
        const names = new Set();
        const attributes = {};
        while (attrs.trim()) {
          const a = /^\s+([\w:.-]+)\s*=\s*("[^"<]*"|'[^'<]*')/.exec(attrs);
          if (!a || names.has(a[1]) || /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(a[2])) throw Error('XML');
          names.add(a[1]);
          attributes[a[1]] = decode(a[2].slice(1, -1));
          attrs = attrs.slice(a[0].length);
        }
        const node = {
          name: tag[1],
          attributes,
          children: [],
          parts: []
        };
        parent.children.push(node);
        parent.parts.push(node);
        if (!tag[3]) stack.push(node);
        if (stack.length > 64) throw Error('XML');
      } else {
        if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(t)) throw Error('XML');
        if (stack.length === 1 && t.trim()) throw Error('XML');
        parent.parts.push(decode(t));
      }
    }
    return pos === xml.length && stack.length === 1 && root.children.length === 1 ? root.children[0] : null;
  } catch {
    return null;
  }
}
const children = (n, name) => (n?.children || []).filter(c => c.name.split(':').pop() === name);
const rawText = n => n.parts.map(part => typeof part === 'string' ? part : rawText(part)).join('');
const text = n => n ? rawText(n).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '';
const field = (n, name) => text(children(n, name)[0]);
function parseSearchXml(xml) {
  const root = xmlTree(xml);
  if (root?.name !== 'rss') return [];
  return children(children(root, 'channel')[0], 'item').slice(0, 10).map(n => ({
    title: field(n, 'title'),
    url: field(n, 'link'),
    snippet: field(n, 'description'),
    book: field(children(n, 'book')[0], 'title')
  }));
}
// Wikipedia's own reference markers ("[17]", "[ 144 ]", "[note 3]", "[a]", "[citation needed]")
// would mix with Sovereign's [1]–[5] citations, so local text drops them before the model sees it.
// Applied only to Kiwix text, never to the model's answer (its [1] citations must stay).
const REFERENCE_MARKER = new RegExp('[ \\t]*\\[\\s*(?:' + [
  '\\d{1,4}',
  '(?:note|nb|n|fn|lower-alpha|upper-alpha|lower-roman)\\s*\\d{1,4}',
  '[a-z]{1,2}',
  '[a-z][a-z ]{0,30}?\\s+needed',
  '(?:who|when|which|where|why|how|according to whom|by whom|clarification|dubious(?:\\s*[–—-]\\s*discuss)?|failed verification|unreliable source\\??|not in citation given|disputed)\\??'
].join('|') + ')\\s*\\]', 'gi');
function stripReferenceMarkers(value) {
  return String(value || '')
    .replace(REFERENCE_MARKER, '')
    .replace(/[ \t]{2,}/g, ' ');
}
function normalizeKiwixResult(item, endpoint, index = 0) {
  try {
    const u = new URL(item.url || item.link, endpoint);
    if (u.origin !== normalizeKiwixEndpoint(endpoint) || u.username || u.password || !/^\/content\/[^/]+\/.+/.test(u.pathname)) return null;
    u.search = '';
    u.hash = '';
    return {
      id: index + 1,
      title: String(item.title || '').slice(0, 300),
      url: u.href,
      snippet: stripReferenceMarkers(item.snippet).slice(0, 2000),
      book: String(item.book || ''),
      origin: 'local'
    };
  } catch {
    return null;
  }
}
function articleRawUrl(value) {
  const u = new URL(value);
  if (!/^\/content\/[^/]+\/.+/.test(u.pathname)) throw Error('Invalid local article.');
  u.pathname = u.pathname.replace(/^\/content\/([^/]+)\//, '/raw/$1/content/');
  u.search = '';
  u.hash = '';
  return u.href;
}
function articleImages(html, articleUrl, endpoint) {
  const found = [];
  for (const m of String(html).matchAll(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    try {
      const u = new URL(decode(m[1] ?? m[2] ?? m[3]), articleUrl);
      if (u.origin === normalizeKiwixEndpoint(endpoint) && !u.username && !u.password && !found.includes(u.href)) found.push(u.href);
    } catch {}
    if (found.length >= 20) break;
  }
  return found;
}
// Local images come only from articles whose title names the subject the user asked about,
// so "pictures of the earth" can't show images from an article that merely mentions Earth.
const SUBJECT_STOP_WORDS = new Set([
  'a', 'an', 'the', 'of', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'about',
  'some', 'any', 'me', 'my', 'please', 'show', 'find', 'give', 'get', 'see', 'look', 'looks', 'like',
  'what', 'does', 'do', 'is', 'are', 'how', 'can', 'could', 'would', 'you', 'i', 'want',
  'picture', 'pictures', 'pic', 'pics', 'photo', 'photos', 'photograph', 'photographs',
  'image', 'images', 'video', 'videos', 'clip', 'clips', 'wallpaper', 'wallpapers'
]);
function subjectWords(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}
// Simple plural forms, compared on both sides: the word itself, minus "s" ("pandas" → "panda"),
// minus "es" ("volcanoes" → "volcano", "boxes" → "box"), and "ies" → "y" ("cities" → "city").
// Two words match when their form sets share a member, so "shoes" still matches "Shoe".
function singularForms(word) {
  const forms = new Set([word]);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) forms.add(word.slice(0, -1));
  if (word.length > 4 && word.endsWith('es')) forms.add(word.slice(0, -2));
  if (word.length > 4 && word.endsWith('ies')) forms.add(word.slice(0, -3) + 'y');
  return forms;
}
function mediaSubject(question) {
  return require('./media-intent').mediaQueryForQuestion(question);
}
function mediaSubjectTerms(subject) {
  const words = subjectWords(subject).filter(word => !SUBJECT_STOP_WORDS.has(word));
  return [...new Set(words)].slice(0, 8);
}
// Every subject term must be a whole word of the title (any case, simple plurals).
// No terms means no match (fail closed).
function titleMatchesSubject(title, terms) {
  if (!Array.isArray(terms) || !terms.length) return false;
  const titleForms = new Set(subjectWords(title).flatMap(word => [...singularForms(word)]));
  return terms.every(term => [...singularForms(String(term).toLowerCase())].some(form => titleForms.has(form)));
}
const QUESTION_STOP_WORDS = new Set([...SUBJECT_STOP_WORDS, ...(
  'who whom whose what when where which why how did does do is are was were be been can could should would will tell explain describe define meaning mean have has had i me my you your it its this that these those there their they yesterday today tomorrow tonight now currently current latest recent recently s ' +
  'work works working happen happens cause causes caused make makes made use used called mean means matter matters get gets become became'
).split(' ')]);
function questionKeyTerms(question) {
  return [...new Set(String(question || '').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').split(/[^\p{L}]+/u).filter(word => word && !QUESTION_STOP_WORDS.has(word)))].slice(0, 8);
}
const sameWord = (a, b) => [...singularForms(a)].some(form => singularForms(b).has(form));
const hasWord = (words, term) => words.some(word => sameWord(word, term));
// Key terms that sit next to each other in the question ("world cup", "red pandas").
function keyTermRuns(question, keyTerms) {
  const runs = [];
  let run = [];
  for (const word of String(question || '').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').split(/[^\p{L}]+/u).filter(Boolean)) {
    if (keyTerms.includes(word)) run.push(word);
    else {
      if (run.length) runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  return runs;
}
function hasPair(words, first, second) {
  return words.some((word, i) => i + 1 < words.length && sameWord(word, first) && sameWord(words[i + 1], second));
}
// R3.15 (approved): one rule for local text sources.
// 1. One key term: the title must contain it.
// 2. Two or more: the title contains at least one key term, and title + snippet together cover
//    at least 2/3 of them. An article whose title shares nothing with the question is never used.
// 3. A title word from an adjacent run ("world cup") counts only next to its neighbour from the
//    run, so "World War I" does not count for "world cup" and "Red fox" not for "red pandas".
// Known limits (HANDOFF): "sky blue"-style subjects; answers only in unrelated-title articles.
function localRelevance(result, keyTerms, question = '') {
  if (!Array.isArray(keyTerms) || !keyTerms.length) return { relevant: false, titleHits: 0, covered: 0 };
  const titleWords = subjectWords(result.title);
  const snippetWords = subjectWords(stripReferenceMarkers(result.snippet));
  const runs = keyTermRuns(question, keyTerms);
  const titleHit = term => {
    if (!hasWord(titleWords, term)) return false;
    const run = runs.find(r => r.includes(term));
    if (!run || run.length < 2) return true;
    // A title made only of key terms ("Tokyo" for "tokyo population") is on topic; the guard is
    // for titles that add other words ("Red fox" for "red pandas", "World War I" for "world cup").
    if (titleWords.filter(word => !SUBJECT_STOP_WORDS.has(word)).every(word => keyTerms.some(t => sameWord(word, t)))) return true;
    const i = run.indexOf(term);
    return (i > 0 && hasPair(titleWords, run[i - 1], term)) ||
      (i < run.length - 1 && hasPair(titleWords, term, run[i + 1]));
  };
  const titleHits = keyTerms.filter(titleHit).length;
  const covered = keyTerms.filter(term => titleHit(term) || hasWord(snippetWords, term)).length;
  const relevant = keyTerms.length === 1 ? titleHits === 1 : titleHits >= 1 && covered >= Math.ceil(2 * keyTerms.length / 3);
  return { relevant, titleHits, covered };
}
function isRelevantLocalResult(result, keyTerms, question = '') {
  return localRelevance(result, keyTerms, question).relevant;
}
// Sandeep (2026-11-17): sources are ordered by how many key terms the title covers, then by
// title + snippet coverage, then Kiwix's own order (stable).
function orderLocalResults(results, keyTerms, question = '') {
  return results
    .map((result, index) => ({ result, index, score: localRelevance(result, keyTerms, question) }))
    .sort((a, b) => b.score.titleHits - a.score.titleHits || b.score.covered - a.score.covered || a.index - b.index)
    .map(entry => entry.result);
}
function listBooks(xml) {
  const root = xmlTree(xml);
  if (root?.name.split(':').pop() !== 'feed') return [];
  return children(root, 'entry').map(n => ({
    name: field(n, 'name') || field(n, 'id'),
    title: field(n, 'title'),
    path: children(n, 'link').find(link => link.attributes.type === 'text/html')?.attributes.href || '',
    date: (field(n, 'issued') || field(n, 'updated')).split('T')[0],
    fullTextIndex: /(?:^|;)_ftindex:yes(?:;|$)/.test(field(n, 'tags'))
  }));
}
function bookInfoForUrl(value, books = []) {
  try {
    const path = new URL(value, DEFAULT_ENDPOINT).pathname;
    const book = books.filter(b => b.path && path.startsWith(b.path.replace(/\/$/, '') + '/')).sort((a,b) => b.path.length-a.path.length)[0];
    const fallback = /^\/content\/([^/]+)\//.exec(path)?.[1] || '';
    return { bookDate: book ? book.date || '' : /_(\d{4}-(?:0[1-9]|1[0-2]))$/.exec(fallback)?.[1] || '', bookTitle: book?.title || '' };
  } catch { return { bookDate: '', bookTitle: '' }; }
}
// Node HTTP only; no DNS for localhost, redirects, proxy, cookies or implicit downloads.
function fetchKiwix(value, {
  endpoint = DEFAULT_ENDPOINT,
  signal,
  method = 'GET',
  timeoutMs = 10000,
  maxBytes = 5 * 1024 * 1024
} = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(value);
      if (u.origin !== normalizeKiwixEndpoint(endpoint) || u.username || u.password) throw Error('Invalid local knowledge URL.');
    } catch (e) {
      reject(e);
      return;
    }
    const req = http.request({
      hostname: u.hostname === 'localhost' ? '127.0.0.1' : u.hostname.replace(/^\[|\]$/g, ''),
      port: u.port || 80,
      path: u.pathname + u.search,
      method,
      signal,
      headers: {
        Host: u.host
      }
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('error', reject);
      res.on('data', c => {
        size += c.length;
        if (size > maxBytes) req.destroy(Error('Local knowledge response too large.'));else chunks.push(c);
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(Error('Local knowledge response refused.'));
          return;
        }
        const data = Buffer.concat(chunks);
        resolve({
          ok: true,
          status: res.statusCode,
          headers: {
            get: name => res.headers[String(name).toLowerCase()] || ''
          },
          text: async () => data.toString('utf8'),
          arrayBuffer: async () => data
        });
      });
    });
    const timer = setTimeout(() => req.destroy(Object.assign(Error('Local knowledge timeout.'), {
      code: 'ETIMEDOUT'
    })), timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end();
  });
}
module.exports = {
  questionKeyTerms,
  isRelevantLocalResult,
  orderLocalResults,
  DEFAULT_ENDPOINT,
  normalizeKiwixEndpoint,
  buildSearchUrl,
  parseSearchXml,
  normalizeKiwixResult,
  stripReferenceMarkers,
  articleRawUrl,
  articleImages,
  mediaSubject,
  mediaSubjectTerms,
  titleMatchesSubject,
  listBooks,
  bookInfoForUrl,
  fetchKiwix
};
