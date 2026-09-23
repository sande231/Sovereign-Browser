const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, webContents } = require('electron');

app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', event => {
    console.error(`[renderer:${contents.getURL()}] ${event.message}`);
  });
});

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-browser-features-profile-'));
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
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await delay(100);
  }
  throw new Error('Timed out waiting for condition.');
}

function liveContents() {
  return webContents.getAllWebContents().filter(contents => !contents.isDestroyed());
}

function contentsByUrl(part) {
  return liveContents().find(contents => contents.getURL().includes(part));
}

function chromeContents() {
  return liveContents().filter(contents => contents.getURL().endsWith('/src/index.html'));
}

async function main() {
  const server = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html>
      <title>Sovereign Feature Page</title>
      <main>
        <h1>Feature test article</h1>
        <p>Sovereign extracts article text and excludes forms, inputs, scripts, and hidden content.</p>
        <p>This paragraph exists so the summary test has readable page material.</p>
        <form><input value="do not summarize"></form>
      </main>`);
  });

  require('../../src/main.js');
  await app.whenReady();

  const chrome = await waitFor(() => contentsByUrl('index.html'));
  const pageUrl = `http://127.0.0.1:${server.address().port}/feature-page`;
  await chrome.executeJavaScript(`window.sovereign.newTab(${JSON.stringify(pageUrl)})`, true);
  const page = await waitFor(() => contentsByUrl('/feature-page'));
  await waitFor(() => page.executeJavaScript("document.title === 'Sovereign Feature Page'", true));

  await chrome.executeJavaScript('window.sovereign.toggleBookmark()', true);
  const bookmarks = await chrome.executeJavaScript('window.sovereign.bookmarks.get()', true);
  if (!bookmarks.bookmarks.some(bookmark => bookmark.url === pageUrl)) {
    throw new Error('Bookmark was not persisted for the active page.');
  }

  await chrome.executeJavaScript('window.sovereign.toggleSidebar()', true);
  const sidebar = await waitFor(() => contentsByUrl('sidebar.html'));
  await sidebar.executeJavaScript(`
    window.SovereignAIEngine = {
      environment: async () => ({ webgpu: true, secureContext: true, userAgent: 'test' }),
      isModelCached: async () => true,
      loadModel: async progress => { progress?.({ text: 'Loaded mocked summary model', progress: 1 }); },
      summarize: async (_messages, onChunk) => {
        onChunk('- Sovereign extracts visible article text.\\n- Form inputs are excluded from the summary source.');
      },
      stop: async () => {},
      unload: async () => {}
    };
    undefined;
  `, true);
  await waitFor(() => sidebar.executeJavaScript("!document.querySelector('#download-model').disabled", true));
  await sidebar.executeJavaScript("document.querySelector('#download-model').click()", true);
  await waitFor(async () => {
    const text = await sidebar.executeJavaScript("document.querySelector('#model-progress').innerText", true);
    return text.includes('ready') ? true : null;
  });
  await waitFor(() => sidebar.executeJavaScript("!document.querySelector('#summarize-page').disabled", true));
  await sidebar.executeJavaScript("document.querySelector('#summarize-page').click()", true);
  try {
    await waitFor(async () => {
      const state = await sidebar.executeJavaScript(`({
        status: document.querySelector('#ai-status')?.innerText || '',
        output: document.querySelector('#summary-output')?.innerText || ''
      })`, true);
      return state.status.includes('Summary complete') &&
        state.output.includes('Sovereign extracts article text') &&
        !state.output.includes('do not summarize')
        ? true
        : null;
    });
  } catch (error) {
    const debug = await sidebar.executeJavaScript(`({
      status: document.querySelector('#ai-status')?.innerText || '',
      output: document.querySelector('#summary-output')?.innerText || '',
      summarizeDisabled: document.querySelector('#summarize-page')?.disabled ?? null
    })`, true);
    throw new Error(`Summary did not render expected output: ${JSON.stringify(debug)}`);
  }

  const beforeDetachState = await chrome.executeJavaScript('window.sovereign.getState()', true);
  await chrome.executeJavaScript(`window.sovereign.detachTab(${beforeDetachState.activeTabId}, { screenX: 520, screenY: 160 })`, true);
  await waitFor(() => chromeContents().length >= 2 ? true : null);

  console.log(JSON.stringify({
    profile,
    bookmarkCount: bookmarks.bookmarks.length,
    summaryGenerated: true,
    detachedWindowCount: chromeContents().length
  }, null, 2));

  server.close();
  app.quit();
}

main().catch(error => {
  console.error(error);
  app.quit();
  process.exitCode = 1;
});
