const assert = require('node:assert/strict');
const {
  classifyPrivacyRequest,
  originFromUrl
} = require('../src/privacy-attribution');

const appRoot = '/Users/sandeep/Sovereign-Browser';

const redditTab = classifyPrivacyRequest(
  { url: 'https://www.reddit.com/r/LocalLLaMA/', method: 'GET' },
  {
    hasWebContents: true,
    tabKind: 'web',
    currentUrl: 'https://www.reddit.com/r/LocalLLaMA/',
    appRoot,
    openWebOrigins: new Set()
  }
);
assert.equal(redditTab.action, 'ignore');
assert.equal(redditTab.reason, 'web-content');

const redditTabWithMissingKind = classifyPrivacyRequest(
  { url: 'https://redditstatic.com/app.js', method: 'GET' },
  {
    hasWebContents: true,
    tabKind: '',
    currentUrl: 'https://www.reddit.com/r/LocalLLaMA/',
    appRoot,
    openWebOrigins: new Set()
  }
);
assert.equal(redditTabWithMissingKind.action, 'ignore');
assert.equal(redditTabWithMissingKind.reason, 'web-content');

const unknownUnattributed = classifyPrivacyRequest(
  { url: 'https://unknown.example/script.js', method: 'GET' },
  {
    hasWebContents: false,
    appRoot,
    openWebOrigins: new Set()
  }
);
assert.equal(unknownUnattributed.action, 'debug-skip');
assert.equal(unknownUnattributed.reason, 'unattributed');

const searchRequest = classifyPrivacyRequest(
  {
    url: 'http://127.0.0.1:8080/search?q=Local+LLM+privacy',
    method: 'GET'
  },
  {
    hasWebContents: true,
    tabKind: 'search',
    currentUrl: 'sovereign://search/',
    activeReceiptId: 'search-receipt-1',
    appRoot,
    openWebOrigins: new Set()
  }
);
assert.equal(searchRequest.action, 'receipt');
assert.equal(searchRequest.receiptId, 'search-receipt-1');

const sourcePageRequest = classifyPrivacyRequest(
  {
    url: 'https://example.org/article',
    method: 'GET'
  },
  {
    hasWebContents: true,
    tabKind: 'ask',
    currentUrl: 'sovereign://ask/',
    activeReceiptId: 'ask-receipt-1',
    appRoot,
    openWebOrigins: new Set()
  }
);
assert.equal(sourcePageRequest.action, 'receipt');
assert.equal(sourcePageRequest.receiptId, 'ask-receipt-1');

const imageRequest = classifyPrivacyRequest(
  {
    url: 'https://images.example/photo.jpg',
    method: 'HEAD'
  },
  {
    hasWebContents: true,
    tabKind: 'ask',
    currentUrl: 'sovereign://ask/',
    activeReceiptId: 'media-receipt-1',
    appRoot,
    openWebOrigins: new Set()
  }
);
assert.equal(imageRequest.action, 'receipt');
assert.equal(imageRequest.receiptId, 'media-receipt-1');

const modelDownload = classifyPrivacyRequest(
  {
    url: 'https://huggingface.co/mlc-ai/model/resolve/main/params.bin',
    method: 'GET',
    initiator: 'sovereign://ask/model-setup.html'
  },
  {
    hasWebContents: false,
    appRoot,
    openWebOrigins: new Set()
  }
);
assert.equal(modelDownload.action, 'background');

const webOrigin = new Set([originFromUrl('https://www.reddit.com/r/LocalLLaMA/')]);
const webWorkerRequest = classifyPrivacyRequest(
  {
    url: 'https://www.googletagmanager.com/gtm.js',
    method: 'GET',
    initiator: 'https://www.reddit.com/r/LocalLLaMA/'
  },
  {
    hasWebContents: false,
    appRoot,
    openWebOrigins: webOrigin
  }
);
assert.equal(webWorkerRequest.action, 'ignore');
assert.equal(webWorkerRequest.reason, 'web-origin');

console.log('privacy-attribution tests passed');
