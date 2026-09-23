const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, webContents } = require('electron');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-generation-shutdown-profile-'));
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

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 15000) {
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

function askTabContents() {
  return liveContents().find(contents => {
    const url = contents.getURL();
    return url.startsWith('sovereign://ask/') &&
      !url.includes('model-setup') &&
      !url.includes('sidebar');
  });
}

async function main() {
  require('../../src/main.js');
  await app.whenReady();

  const chrome = await waitFor(() => contentsByUrl('index.html'));
  await chrome.executeJavaScript("window.sovereign.openSearch({ question: 'generation shutdown', mode: 'ask', autoRun: false })", true);
  const askPage = await waitFor(() => askTabContents());
  await askPage.executeJavaScript(`
    window.SovereignAIEngine = {
      environment: async () => ({ webgpu: true, secureContext: true, userAgent: 'test' }),
      isModelCached: async () => true,
      loadModel: async progress => { progress?.({ text: 'Loaded mocked local model', progress: 1 }); },
      summarize: async (_messages, onChunk) => {
        onChunk('Streaming before shutdown...');
        await new Promise(resolve => setTimeout(resolve, 10000));
      },
      stop: async () => {},
      unload: async () => {}
    };
    document.querySelector('#chat-input').value = 'Start a long answer';
    document.querySelector('#chat-form').requestSubmit();
  `, true);

  await waitFor(async () => {
    const text = await askPage.executeJavaScript("document.querySelector('#chat-thread').innerText", true);
    return text.includes('Streaming before shutdown') ? true : null;
  });

  console.log(JSON.stringify({
    profile,
    quittingWithGenerationActive: true
  }, null, 2));
  app.quit();
}

main().catch(error => {
  console.error(error);
  app.quit();
  process.exitCode = 1;
});
