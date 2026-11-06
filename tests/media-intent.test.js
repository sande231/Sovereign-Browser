const assert = require('node:assert/strict');
const { isMediaRequest, mediaTypeForQuestion, mediaQueryForQuestion, mentionsMedia } = require('../src/media-intent');
const { normalizeSearxngMediaResults, searchSearxngMedia } = require('../src/search-backend');

const positives = [
  [
    "pictures of Mount Everest",
    "images",
    "Mount Everest"
  ],
  [
    "images of the Eiffel Tower",
    "images",
    "the Eiffel Tower"
  ],
  [
    "Can you show me photos of red pandas?",
    "images",
    "red pandas"
  ],
  [
    "I want to see images of Mars",
    "images",
    "Mars"
  ],
  [
    "Give me some pics of Tokyo at night",
    "images",
    "Tokyo at night"
  ],
  [
    "What does a snow leopard look like?",
    "images",
    "a snow leopard"
  ],
  [
    "Show me a map of Nepal.",
    "images",
    "a map of Nepal"
  ],
  [
    "Find a video of Mount Everest.",
    "videos",
    "Mount Everest"
  ],
  [
    "photos of The Who",
    "images",
    "The Who"
  ],
  [
    "show me pictures of Show Me the Money",
    "images",
    "Show Me the Money"
  ],
  [
    "Get Out poster images",
    "images",
    "Get Out poster images"
  ],
  [
    "Find Finding Nemo pictures",
    "images",
    "Find Finding Nemo pictures"
  ],
  [
    "Show me Paris photos",
    "images",
    "Paris photos"
  ],
  [
    "Find pictures about the Apollo 11 landing",
    "images",
    "the Apollo 11 landing"
  ],
  [
    "Please show me a picture of the Moon",
    "images",
    "the Moon"
  ],
  [
    "Could you please pull up some images of Venice?",
    "images",
    "Venice"
  ],
  [
    "I'd like to see photos of Kyoto",
    "images",
    "Kyoto"
  ],
  [
    "Let me see pictures of Iceland",
    "images",
    "Iceland"
  ],
  [
    "Look up pictures of the Hubble",
    "images",
    "the Hubble"
  ],
  [
    "Search for images of auroras",
    "images",
    "auroras"
  ],
  [
    "Show me pictures of a watch",
    "images",
    "a watch"
  ],
  [
    "Show me photos of Apple Watch bands",
    "images",
    "Apple Watch bands"
  ],
  [
    "Find a clip of the Moon landing",
    "videos",
    "the Moon landing"
  ],
  [
    "What do koalas look like?",
    "images",
    "koalas"
  ]
];
for (const [question, type, query] of positives) {
  assert.equal(isMediaRequest(question), true, question);
  assert.equal(mediaTypeForQuestion(question), type, question);
  assert.equal(mediaQueryForQuestion(question), query, question);
}
for (const question of [
  "How does image compression work?",
  "What is image processing?",
  "Picture this scenario: a city with no cars.",
  "Explain the image of the soul in Plato",
  "How do I resize an image in Python?",
  "How do I find an image in Python?",
  "What is a video codec?",
  "Find the image size in Python",
  "Get image dimensions with PIL",
  "Display the image in a React component",
  "Show me how image compression works",
  "Can you find a picture frame for 8x10 photos?",
  "Did you see the video I sent?",
  "Can you explain how to find an image in Python",
  "Could you explain what a photo histogram is?",
  "Please define image resolution",
  "What does it look like?",
  "What does this look like?",
  "Why do photos look blurry at night?",
  "Define image resolution",
  "Describe the picture",
  "Tell me about the photo of the Earthrise",
  "Imagine a picture of a cat",
  "What's a good photo editor?",
  "What was the first photo ever taken?",
  "What are the best image formats?",
  "How can I get photos off my iPhone?",
  "How to take photos of the moon",
  "How is a video compressed?",
  "Picture a beach at sunset"
]) assert.equal(isMediaRequest(question), false, question);
for (const noun of ['picture', 'pic', 'photo', 'photograph', 'image', 'map', 'video', 'clip', 'wallpaper']) {
  for (const word of [noun, noun + 's']) {
    assert.equal(mentionsMedia('Explain ' + word), true);
    assert.equal(isMediaRequest('some ' + word + ' showing cats'), true);
  }
}
assert.equal(mentionsMedia('photographic imaging'), false);
assert.equal(mentionsMedia('What does a cat look like?'), false);
assert.equal(isMediaRequest('show one two three four images of cats'), true);
assert.equal(isMediaRequest('show one two three four five images of cats'), false);
assert.equal(mediaQueryForQuestion('please show me photos of The Who for me please!'), 'The Who');
assert.equal(mediaQueryForQuestion('pictures of 123?!'), 'pictures of 123');
assert.equal(mediaQueryForQuestion('photos of ' + 'x'.repeat(200)).length, 180);
const [noPage] = normalizeSearxngMediaResults({ results: [{ img_src: 'https://cdn.example/cat.jpg' }] }, 'images');
assert.equal(noPage.pageUrl, '');
assert.equal(noPage.hasSourcePage, false);
const [page] = normalizeSearxngMediaResults({ results: [{ url: 'https://example.com/cats', img_src: 'https://cdn.example/cat.jpg' }] }, 'images');
assert.equal(page.pageUrl, 'https://example.com/cats');
assert.equal(page.hasSourcePage, true);

const cleanupCases = [
  [
    "Please Please Me album cover photos",
    false,
    "Please Please Me album cover photos"
  ],
  [
    "Show me Show Me the Money posters",
    false,
    "Show Me the Money posters"
  ],
  [
    "please show me photos of The Who for me please!",
    true,
    "The Who"
  ],
  [
    "pictures of 123?!",
    true,
    "pictures of 123"
  ],
  [
    "Picture of Dorian Gray themes",
    true,
    "Dorian Gray themes"
  ]
];
for (const [question, detected, query] of cleanupCases) {
  assert.equal(isMediaRequest(question), detected, question);
  assert.equal(mediaQueryForQuestion(question), query, question);
}
assert.equal(mentionsMedia('Please Please Me album cover photos'), true);

async function testBackend() {
  const result = await searchSearxngMedia({
    query: 'cats',
    fetchImpl: async () => ({ ok: true, json: async () => ({ results: [], unresponsive_engines: [[' bing ', 'private error'], ['google', 'timeout']] }) })
  });
  assert.deepEqual(result.unresponsiveEngines, ['bing', 'google']);
  const abortingFetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException('aborted', 'AbortError'));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
  await assert.rejects(searchSearxngMedia({ query: 'cats', timeoutMs: 5, fetchImpl: abortingFetch }),
    /SearXNG did not respond within 8 seconds. Try again./);
  const controller = new AbortController();
  const pending = searchSearxngMedia({ query: 'cats', signal: controller.signal, fetchImpl: abortingFetch });
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError' && /canceled/.test(error.message));
  console.log('media-intent tests passed');
}
testBackend().catch(error => { console.error(error); process.exitCode = 1; });
