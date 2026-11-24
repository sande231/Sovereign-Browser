process.env.SOVEREIGN_TEST_NETWORK_MODE ||= 'online'; // Offline mode is tested in offline-mode.test.js.
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
process.env.SOVEREIGN_TEST_DNS = JSON.stringify(Object.fromEntries(['source-one.test', 'source-two.test'].map(host => [host, { address: '93.184.216.34', connect: '127.0.0.1' }])));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP source-one.test 127.0.0.1, MAP source-two.test 127.0.0.1');

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

const retrievalRequests = [];
const askConsole = [];
const testSteps = [];

async function main() {
  const server = await listen((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    retrievalRequests.push(url.pathname + url.search);
    if (url.pathname === '/search') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        results: [
          {
            title: 'Lists and tuples',
            url: `http://source-one.test:${server.address().port}/source-one`,
            content: 'Lists are mutable sequences. Tuples are immutable sequences used for fixed records.'
          },
          {
            title: 'Tuple immutability',
            url: `http://source-two.test:${server.address().port}/source-two`,
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
  testSteps.push({ t: Date.now(), step: 'saw-chrome' });
  const endpoint = `http://127.0.0.1:${server.address().port}/search`;
  await chrome.executeJavaScript(`window.sovereign.search.updateSettings({ endpoint: ${JSON.stringify(endpoint)} })`, true);

  await chrome.executeJavaScript("window.sovereign.navigate('difference between lists and tuples')", true);
  const searchPage = await waitFor(() => contentsByUrl('sovereign://search/'));
  testSteps.push({ t: Date.now(), step: 'saw-search-page' });
  await waitFor(async () => {
    const count = await searchPage.executeJavaScript("document.querySelectorAll('.result-card').length", true);
    return count === 2 ? count : null;
  });
  testSteps.push({ t: Date.now(), step: 'saw-search-results' });
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
  testSteps.push({ t: Date.now(), step: 'saw-ask-page' });
  askPage.on('console-message', event => {
    if (event.level !== 'warning' && event.level !== 'error') return;
    askConsole.push({ level: event.level, message: event.message, line: event.lineNumber, sourceId: event.sourceId });
    if (askConsole.length > 50) askConsole.shift();
  });
  await askPage.executeJavaScript(`
    window.addEventListener('error', event => {
      console.error('[diag] error:', event.error?.stack || event.error?.message || event.message);
    });
    window.addEventListener('unhandledrejection', event => {
      console.error('[diag] unhandledrejection:', event.reason?.stack || event.reason?.message || String(event.reason));
    });
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
          onChunk('Working on it.\\n');
          for (let i = 0; i < 40; i += 1) {
            if (window.__stopRequested) {
              window.__holdAborted = true;
              throw new Error('aborted by test');
            }
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          window.__holdCompleted = true;
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
    window.__diag = [];
    window.__diagPush = (kind, detail) => {
      window.__diag.push({ t: Date.now(), kind, detail: String(detail ?? '').slice(0, 120) });
      if (window.__diag.length > 200) window.__diag.splice(0, window.__diag.length - 200);
    };
    const send = document.querySelector('#send-chat');
    const status = document.querySelector('#chat-status');
    const thread = document.querySelector('#chat-thread');
    let lastDisabled = send.disabled;
    let lastStatus = status.textContent;
    let lastCount = thread.childElementCount;
    const observer = new MutationObserver(() => {
      if (send.disabled !== lastDisabled) {
        lastDisabled = send.disabled;
        window.__diagPush('send-disabled', lastDisabled);
      }
      if (status.textContent !== lastStatus) {
        lastStatus = status.textContent;
        window.__diagPush('chat-status', lastStatus);
      }
      if (thread.childElementCount !== lastCount) {
        lastCount = thread.childElementCount;
        window.__diagPush('thread-child-count', lastCount);
      }
    });
    observer.observe(send, { attributes: true, attributeFilter: ['disabled'] });
    observer.observe(status, { childList: true, characterData: true, subtree: true });
    observer.observe(thread, { childList: true });
    const originalSummarize = window.SovereignAIEngine.summarize;
    window.SovereignAIEngine.summarize = function (...args) {
      window.__diagPush('summarize-start', String(args[0]?.at(-1)?.content ?? '').slice(0, 60));
      const onChunk = args[1];
      args[1] = function (...chunkArgs) {
        window.__diagPush('chunk', String(chunkArgs[0] ?? '').slice(0, 40));
        return Reflect.apply(onChunk, this, chunkArgs);
      };
      try {
        const result = Reflect.apply(originalSummarize, this, args);
        result.then(
          () => { window.__diagPush('summarize-end', ''); },
          error => { window.__diagPush('summarize-throw', error?.message); }
        );
        return result;
      } catch (error) {
        window.__diagPush('summarize-throw', error?.message);
        throw error;
      }
    };
    const originalStop = window.SovereignAIEngine.stop;
    window.SovereignAIEngine.stop = function (...args) {
      window.__diagPush('stop-called', '');
      return Reflect.apply(originalStop, this, args);
    };
    document.querySelector('#web-toggle').addEventListener('change', event => {
      window.__diagPush('web-toggle-change', event.target.checked);
    });
    document.querySelector('#chat-form').addEventListener('submit', () => {
      window.__diagPush('form-submit', '');
    }, true);
    undefined;
  `, true);

  testSteps.push({ t: Date.now(), step: 'submit-q1' });
  await askPage.executeJavaScript(`
    document.querySelector('#chat-input').value = 'What is the difference between lists and tuples?';
    document.querySelector('#chat-form').requestSubmit();
  `, true);
  await waitFor(async () => {
    const text = await askPage.executeJavaScript("document.querySelector('#chat-thread').innerText", true);
    return text.includes('list is mutable') ? true : null;
  });
  testSteps.push({ t: Date.now(), step: 'saw-q1-answer' });

  testSteps.push({ t: Date.now(), step: 'submit-q2' });
  await askPage.executeJavaScript(`
    document.querySelector('#chat-input').value = 'Can you restate that?';
    document.querySelector('#chat-form').requestSubmit();
  `, true);
  await waitFor(async () => {
    const text = await askPage.executeJavaScript("document.querySelector('#chat-thread').innerText", true);
    return text.includes('earlier context') ? true : null;
  });
  testSteps.push({ t: Date.now(), step: 'saw-q2-answer' });
  const followupContext = await askPage.executeJavaScript(`
    window.__summarizeCalls.at(-1).some(message => message.content.includes('list is mutable'))
  `, true);
  if (!followupContext) {
    throw new Error('Follow-up prompt did not include relevant previous context.');
  }

  testSteps.push({ t: Date.now(), step: 'submit-q3-table' });
  await askPage.executeJavaScript(`
    document.querySelector('#chat-input').value = 'Show a tiny table and code';
    document.querySelector('#chat-form').requestSubmit();
  `, true);
  await waitFor(async () => {
    const hasTable = await askPage.executeJavaScript("Boolean(document.querySelector('.chat-table'))", true);
    const hasCodeButton = await askPage.executeJavaScript("Boolean(document.querySelector('.chat-copy-code'))", true);
    return hasTable && hasCodeButton ? true : null;
  });
  testSteps.push({ t: Date.now(), step: 'saw-table-and-code' });

  testSteps.push({ t: Date.now(), step: 'submit-q4-hold' });
  await askPage.executeJavaScript(`
    window.__holdGeneration = true;
    window.__stopRequested = false;
    window.__holdAborted = false;
    window.__holdCompleted = false;
    document.querySelector('#chat-input').value = 'Please keep running until I stop you';
    document.querySelector('#chat-form').requestSubmit();
  `, true);
  await waitFor(async () => {
    const text = await askPage.executeJavaScript("document.querySelector('#chat-thread').innerText", true);
    return text.includes('Working') ? true : null;
  });
  testSteps.push({ t: Date.now(), step: 'saw-working' });
  testSteps.push({ t: Date.now(), step: 'click-stop' });
  await askPage.executeJavaScript("document.querySelector('#stop-chat').click()", true);
  await waitFor(async () => {
    const text = await askPage.executeJavaScript("document.querySelector('#chat-thread').innerText", true);
    return text.includes('Stopped') ? true : null;
  });
  testSteps.push({ t: Date.now(), step: 'saw-stopped' });

  await delay(2500);
  const holdState = await askPage.executeJavaScript(`({
    stopRequested: window.__stopRequested,
    holdAborted: window.__holdAborted,
    holdCompleted: window.__holdCompleted
  })`, true);
  if (holdState.stopRequested !== true || holdState.holdAborted !== true || holdState.holdCompleted === true) {
    throw new Error(`Stop did not abort the live held generation: ${JSON.stringify(holdState)}`);
  }
  const stoppedReply = await askPage.executeJavaScript(`
    (() => {
      const text = document.querySelector('#chat-thread').innerText;
      const question = 'Please keep running until I stop you';
      const questionIndex = text.lastIndexOf(question);
      return questionIndex === -1 ? '' : text.slice(questionIndex + question.length);
    })()
  `, true);
  if (!stoppedReply.includes('Stopped') || stoppedReply.includes('Mutability')) {
    throw new Error(`Held answer did not remain Stopped without the post-hold table after 2500 ms: ${JSON.stringify(stoppedReply)}`);
  }

  await waitFor(() => askPage.executeJavaScript("!document.querySelector('#send-chat').disabled", true));
  testSteps.push({ t: Date.now(), step: 'saw-send-enabled' });
  testSteps.push({ t: Date.now(), step: 'submit-q5-web' });
  await askPage.executeJavaScript(`
    window.__holdGeneration = false;
    if (!document.querySelector('#web-toggle').checked) document.querySelector('#web-toggle').click();
    document.querySelector('#chat-input').value = 'Use the web: lists vs tuples';
    document.querySelector('#chat-form').requestSubmit();
  `, true);
  await waitFor(async () => {
    const count = await askPage.executeJavaScript("document.querySelectorAll('.citation-link').length", true);
    return count > 0 ? count : null;
  });
  testSteps.push({ t: Date.now(), step: 'saw-citations' });
  await askPage.executeJavaScript("document.querySelector('.citation-link').click()", true);
  const citationTab = await waitFor(() => liveContents().find(contents => /\/source-(one|two)/.test(contents.getURL())));
  testSteps.push({ t: Date.now(), step: 'saw-citation-tab' });

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

main().catch(async error => {
  console.error(error);
  async function readDiagnostic(read) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(read),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('timed out')), 3000);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    const threadText = await readDiagnostic(() => {
      const askPage = askTabContents();
      return askPage
        ? askPage.executeJavaScript("(document.querySelector('#chat-thread')?.innerText || '').slice(-2000)", true)
        : '(Ask page unavailable)';
    });
    console.error('Last #chat-thread text (tail):', threadText);
  } catch (diagnosticError) {
    console.error('Last #chat-thread text (tail):', diagnosticError?.message === 'timed out' ? 'timed out' : 'unavailable');
  }
  try {
    const requests = await readDiagnostic(() => JSON.stringify(retrievalRequests));
    console.error('Fake server requests:', requests);
  } catch (diagnosticError) {
    console.error('Fake server requests:', diagnosticError?.message === 'timed out' ? 'timed out' : 'unavailable');
  }
  try {
    const activity = await readDiagnostic(() => {
      const askPage = askTabContents();
      return askPage.executeJavaScript("(async () => JSON.stringify((await window.sovereign.search.getSettings()).activity.slice(-10)))()", true);
    });
    console.error('Recent search/source activity:', activity);
  } catch (diagnosticError) {
    console.error('Recent search/source activity:', diagnosticError?.message === 'timed out' ? 'timed out' : 'unavailable');
  }
  try {
    const messages = await readDiagnostic(() => JSON.stringify(askConsole.slice(-20)));
    console.error('Ask console (last 20 warnings/errors):', messages);
  } catch (diagnosticError) {
    console.error('Ask console (last 20 warnings/errors):', diagnosticError?.message === 'timed out' ? 'timed out' : 'unavailable');
  }
  try {
    const state = await readDiagnostic(() => {
      const askPage = askTabContents();
      return askPage.executeJavaScript(`JSON.stringify({
        status: document.querySelector('#chat-status')?.textContent ?? null,
        sendDisabled: document.querySelector('#send-chat')?.disabled ?? null,
        stopDisabled: document.querySelector('#stop-chat')?.disabled ?? null,
        webChecked: document.querySelector('#web-toggle')?.checked ?? null,
        webDisabled: document.querySelector('#web-toggle')?.disabled ?? null,
        messageCount: document.querySelector('#chat-thread')?.childElementCount ?? null,
        summarizeCallCount: window.__summarizeCalls?.length ?? null,
        lastSummarizePrompt: (window.__summarizeCalls?.at(-1)?.map(message => message.content).join('\\n') || '').slice(0, 200)
      })`, true);
    });
    console.error('Ask page state:', state);
  } catch (diagnosticError) {
    console.error('Ask page state:', diagnosticError?.message === 'timed out' ? 'timed out' : 'unavailable');
  }
  try {
    const steps = await readDiagnostic(() => JSON.stringify(testSteps));
    console.error('Test steps:', steps);
  } catch (diagnosticError) {
    console.error('Test steps:', diagnosticError?.message === 'timed out' ? 'timed out' : 'unavailable');
  }
  try {
    const timeline = await readDiagnostic(() => {
      const askPage = askTabContents();
      return askPage.executeJavaScript("JSON.stringify(window.__diag.slice(-80))", true);
    });
    console.error('Page timeline:', timeline);
  } catch (diagnosticError) {
    console.error('Page timeline:', diagnosticError?.message === 'timed out' ? 'timed out' : 'unavailable');
  }
  app.exit(1);
});
