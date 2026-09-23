const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, webContents } = require('electron');

const TABLE_CODE_FIXTURE = [
  '| Type | Mutability |',
  '| --- | --- |',
  '| List | Mutable |',
  '| Tuple | Immutable |',
  '',
  '```js',
  'const values = [1, 2];',
  '```'
].join('\n');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-model-chat-profile-'));
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({
  ai: {
    autoDownloadModel: false,
    setupNoticeSeen: true,
    setupCanceled: false,
    saveChatsOnDevice: false
  },
  search: {},
  downloads: {},
  bookmarks: [],
  startup: { continueWhereLeftOff: false },
  session: { windows: [] }
}, null, 2));
process.env.SOVEREIGN_USER_DATA_DIR = profile;

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 20000) {
  const started = Date.now();
  let lastValue;
  while (Date.now() - started < timeoutMs) {
    lastValue = await predicate();
    if (lastValue) {
      return lastValue;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for condition. Last value: ${JSON.stringify(lastValue)}`);
}

function liveContents() {
  return webContents.getAllWebContents().filter(contents => !contents.isDestroyed());
}

function contentsByUrl(part) {
  return liveContents().find(contents => contents.getURL().includes(part));
}

function askTabContents() {
  return liveContents().find(contents => {
    const url = contents.getURL();
    return url.startsWith('sovereign://ask/') &&
      !url.includes('model-setup') &&
      !url.includes('sidebar');
  });
}

async function main() {
  const retrievalRequests = [];
  const server = await listen((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    retrievalRequests.push(url.pathname + url.search);
    if (url.pathname === '/search') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        results: [
          {
            title: 'Lists and tuples',
            url: `http://127.0.0.1:${server.address().port}/source-one`,
            content: 'Lists are mutable sequences. Tuples are immutable sequences used for fixed records.'
          },
          {
            title: 'Tuple immutability',
            url: `http://127.0.0.1:${server.address().port}/source-two`,
            content: 'Tuples cannot be changed in place after creation, while list contents can be updated.'
          }
        ]
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<title>${url.pathname}</title><main>Lists are mutable. Tuples are immutable.</main>`);
  });

  require('../../src/main.js');
  await app.whenReady();

  const chrome = await waitFor(() => contentsByUrl('index.html'));
  const endpoint = `http://127.0.0.1:${server.address().port}/search`;
  await chrome.executeJavaScript(`window.sovereign.search.updateSettings({ endpoint: ${JSON.stringify(endpoint)} })`, true);

  await chrome.executeJavaScript("window.sovereign.navigate('difference between lists and tuples')", true);
  const searchPage = await waitFor(() => contentsByUrl('sovereign://search/'));
  await waitFor(async () => {
    const count = await searchPage.executeJavaScript("document.querySelectorAll('.result-card').length", true);
    return count === 2 ? count : null;
  });
  const searchShape = await searchPage.executeJavaScript(`({
    resultCards: document.querySelectorAll('.result-card').length,
    hasAiRuntime: typeof window.SovereignAIEngine !== 'undefined',
    hasAnswerPanel: Boolean(document.querySelector('.answer-panel')),
    hasModelNotice: document.body.innerText.includes('model')
  })`, true);

  if (searchShape.resultCards !== 2 || searchShape.hasAiRuntime || searchShape.hasAnswerPanel || searchShape.hasModelNotice) {
    throw new Error(`Ordinary Search was not independent of AI: ${JSON.stringify(searchShape)}`);
  }

  await chrome.executeJavaScript("window.sovereign.openSearch({ question: 'Explain local chat', mode: 'ask', autoRun: false })", true);
  const askPage = await waitFor(() => askTabContents());
  await askPage.executeJavaScript(`
    const tableCodeFixture = ${JSON.stringify(TABLE_CODE_FIXTURE)};
    window.__summarizeCalls = [];
    window.__holdGeneration = false;
    window.__stopRequested = false;
    window.SovereignAIEngine = {
      environment: async () => ({ webgpu: true, secureContext: true, userAgent: 'test' }),
      isModelCached: async () => true,
      loadModel: async progress => { progress?.({ text: 'Loaded mocked local model', progress: 1 }); },
      summarize: async (messages, onChunk) => {
        window.__summarizeCalls.push(messages);
        const prompt = messages.map(message => message.content).join('\\n');
        if (window.__holdGeneration) {
          onChunk('Working...');
          for (let i = 0; i < 40; i += 1) {
            if (window.__stopRequested) throw new Error('aborted by test');
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }
        if (prompt.includes('NUMBERED SOURCE EVIDENCE')) {
          onChunk('Lists can be changed after creation, while tuples cannot be changed in place [1].');
        } else if (prompt.includes('tiny table')) {
          onChunk(tableCodeFixture);
        } else if (window.__summarizeCalls.length >= 2) {
          onChunk('This follow-up uses the earlier context about lists and tuples.');
        } else {
          onChunk('A list is mutable, while a tuple is immutable.');
        }
      },
      stop: async () => { window.__stopRequested = true; },
      unload: async () => {}
    };
    undefined;
  `, true);

  await askPage.executeJavaScript(`
    document.querySelector('#chat-input').value = 'What is the difference between lists and tuples?';
    document.querySelector('#chat-form').requestSubmit();
  `, true);
  await waitFor(async () => {
    const text = await askPage.executeJavaScript("document.querySelector('#chat-thread').innerText", true);
    return text.includes('list is mutable') ? true : null;
  });

  await askPage.executeJavaScript(`
    document.querySelector('#chat-input').value = 'Can you restate that?';
    document.querySelector('#chat-form').requestSubmit();
  `, true);
  await waitFor(async () => {
    const text = await askPage.executeJavaScript("document.querySelector('#chat-thread').innerText", true);
    return text.includes('earlier context') ? true : null;
  });
  const followupContext = await askPage.executeJavaScript(`
    window.__summarizeCalls.at(-1).some(message => message.content.includes('list is mutable'))
  `, true);
  if (!followupContext) {
    throw new Error('Follow-up prompt did not include relevant previous context.');
  }

  await askPage.executeJavaScript(`
    document.querySelector('#chat-input').value = 'Show a tiny table and code';
    document.querySelector('#chat-form').requestSubmit();
  `, true);
  await waitFor(async () => {
    const hasTable = await askPage.executeJavaScript("Boolean(document.querySelector('.chat-table'))", true);
    const hasCodeButton = await askPage.executeJavaScript("Boolean(document.querySelector('.chat-copy-code'))", true);
    return hasTable && hasCodeButton ? true : null;
  });

  await askPage.executeJavaScript(`
    window.__holdGeneration = true;
    window.__stopRequested = false;
    document.querySelector('#chat-input').value = 'Please keep running until I stop you';
    document.querySelector('#chat-form').requestSubmit();
  `, true);
  await waitFor(async () => {
    const text = await askPage.executeJavaScript("document.querySelector('#chat-thread').innerText", true);
    return text.includes('Working') ? true : null;
  });
  await askPage.executeJavaScript("document.querySelector('#stop-chat').click()", true);
  await waitFor(async () => {
    const text = await askPage.executeJavaScript("document.querySelector('#chat-thread').innerText", true);
    return text.includes('Stopped') ? true : null;
  });

  await waitFor(() => askPage.executeJavaScript("!document.querySelector('#send-chat').disabled", true));
  await askPage.executeJavaScript(`
    window.__holdGeneration = false;
    document.querySelector('#web-toggle').checked = true;
    document.querySelector('#chat-input').value = 'Use the web: lists vs tuples';
    document.querySelector('#chat-form').requestSubmit();
  `, true);
  await waitFor(async () => {
    const count = await askPage.executeJavaScript("document.querySelectorAll('.citation-link').length", true);
    return count > 0 ? count : null;
  });
  await askPage.executeJavaScript("document.querySelector('.citation-link').click()", true);
  const citationTab = await waitFor(() => liveContents().find(contents => /\/source-(one|two)/.test(contents.getURL())));

  console.log(JSON.stringify({
    profile,
    searchShape,
    followupContext,
    renderedTableAndCode: true,
    citationOpenedUrl: citationTab.getURL(),
    retrievalRequests
  }, null, 2));

  server.close();
  app.quit();
}

main().catch(error => {
  console.error(error);
  app.quit();
  process.exitCode = 1;
});
