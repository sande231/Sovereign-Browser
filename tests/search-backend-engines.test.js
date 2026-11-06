const assert = require('node:assert/strict');
const { reportedSearxngEngines, searchSearxng, searchSearxngMedia } = require('../src/search-backend');

// Fields SearXNG uses to name engines.
assert.deepEqual(reportedSearxngEngines({
  results: [
    { engine: 'startpage', engines: ['startpage', 'google cse'] },
    { engines: ['duckduckgo'] },
    { engine: 'duckduckgo' }
  ],
  infoboxes: [{ engine: 'wikidata', engines: ['wikipedia', 'wikidata'] }],
  answers: [{ engine: 'currency' }]
}), ['currency', 'duckduckgo', 'google cse', 'startpage', 'wikidata', 'wikipedia']);

// Unresponsive engines did receive the query; suspended ones were skipped by SearXNG.
assert.deepEqual(reportedSearxngEngines({
  results: [{ engines: ['duckduckgo images'] }],
  unresponsive_engines: [
    ['bing images', 'HTTP connection error'],
    ['brave.images', 'Suspended: too many requests'],
    ['qwant', 'access denied'],
    ['mojeek', '  suspended: access denied'],
    'plain-name'
  ]
}), ['bing images', 'duckduckgo images', 'plain-name', 'qwant']);

// Clean-up: whitespace, duplicates, HTML, non-strings, empty names.
assert.deepEqual(reportedSearxngEngines({
  results: [
    { engines: ['  bing ', 'bing', '<b>startpage</b>', 42, null, '', '   '] },
    { engine: { name: 'object' } },
    null,
    'not-an-object'
  ]
}), ['bing', 'startpage']);

// Missing or malformed payloads never throw.
for (const payload of [undefined, null, {}, { results: 'nope' }, { unresponsive_engines: [[null, 'x'], []] }]) {
  assert.deepEqual(reportedSearxngEngines(payload), []);
}

// Huge lists are capped.
const many = reportedSearxngEngines({ results: Array.from({ length: 80 }, (_, index) => ({ engine: `engine-${String(index).padStart(2, '0')}` })) });
assert.equal(many.length, 50);

async function testSearchFunctions() {
  const payload = {
    results: [{ url: 'https://example.com/tea', title: 'Tea', engines: ['duckduckgo', 'startpage'] }],
    unresponsive_engines: [['brave', 'too many requests'], ['qwant', 'Suspended: access denied']]
  };
  const fetchImpl = async () => ({ ok: true, json: async () => payload });
  const text = await searchSearxng({ query: 'history of tea', fetchImpl });
  assert.deepEqual(text.upstreamEngines, ['brave', 'duckduckgo', 'startpage']);
  assert.equal(text.endpoint, 'http://127.0.0.1:8080/search');

  const images = await searchSearxngMedia({ query: 'tea', type: 'images', fetchImpl: async () => ({
    ok: true,
    json: async () => ({ results: [{ url: 'https://example.com/p', img_src: 'https://cdn.example/t.jpg', engine: 'flickr' }] })
  }) });
  assert.deepEqual(images.upstreamEngines, ['flickr']);

  const empty = await searchSearxng({ query: 'nothing', fetchImpl: async () => ({ ok: true, json: async () => ({ results: [] }) }) });
  assert.deepEqual(empty.upstreamEngines, []);

  // Only the one SearXNG request is made: names come from the response already received.
  let calls = 0;
  await searchSearxng({ query: 'count', fetchImpl: async () => { calls += 1; return { ok: true, json: async () => payload }; } });
  assert.equal(calls, 1);
  console.log('search-backend-engines tests passed');
}

testSearchFunctions().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
