const assert = require('node:assert/strict');
const { CHAT_SYSTEM_PROMPT, IMAGE_RULE } = require('../src/chat-prompt');
const oldSentences = [
  'You are Sovereign, a local AI assistant running inside a trusted browser page.',
  'Do not execute actions, browse, call tools, click links, fetch URLs, or change browser state.',
  'Answer ordinary questions directly and concisely from your local model knowledge.',
  'When uploaded-file excerpts are supplied, treat them as source evidence and answer from them without requiring web evidence.',
  'If the user asks for current or time-sensitive facts and no uploaded-file or web evidence is supplied, say that web search should be enabled.',
  'Use only the recent conversation context supplied; do not imply unlimited memory.',
  'Use clear paragraphs, lists, or code blocks when helpful.',
  'Do not pretend to be a commercial cloud assistant or claim special intelligence.'
];
assert.ok(CHAT_SYSTEM_PROMPT.startsWith(oldSentences[0]));
for (const sentence of oldSentences) assert.ok(CHAT_SYSTEM_PROMPT.includes(sentence), sentence);
assert.ok(CHAT_SYSTEM_PROMPT.endsWith(IMAGE_RULE));
for (const pattern of [
  /cannot see, show, create, generate, or retrieve images/,
  /one sentence/, /Search the web/, /Never describe imaginary images/, /invent image titles/
]) assert.match(IMAGE_RULE, pattern);
assert.ok(require('../src/search-utils').SEARCH_SYSTEM_PROMPT.includes(IMAGE_RULE));
console.log('chat-prompt tests passed');
