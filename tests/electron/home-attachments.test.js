const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, webContents } = require('electron');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-home-attachments-profile-'));

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

async function waitFor(predicate, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await delay(80);
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
    return url.startsWith('sovereign://ask/') && !url.includes('/model-setup.html');
  });
}

async function main() {
  require('../../src/main.js');
  await app.whenReady();

  const newtab = await waitFor(() => contentsByUrl('sovereign://newtab/'));
  await waitFor(() => newtab.executeJavaScript("Boolean(window.SovereignNewTab?.attachments)", true));

  await newtab.executeJavaScript(`
    async function attachFromHome() {
      const input = document.querySelector('#home-attachment-input');
      const transfer = new DataTransfer();
      transfer.items.add(new File(
        ['Sovereign home attachments should transfer into Ask AI and stay temporary.'],
        'home-notes.txt',
        { type: 'text/plain' }
      ));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    attachFromHome();
  `, true);

  await waitFor(async () => {
    const result = await newtab.executeJavaScript(`({
      mode: document.querySelector('input[name="home-mode"]:checked')?.value,
      attachments: window.SovereignNewTab.attachments(),
      status: document.querySelector('#home-attachment-status').innerText
    })`, true);
    return result.mode === 'ask' &&
      result.attachments.some(item => item.name === 'home-notes.txt' && item.status === 'ready') &&
      result.status.includes('Ask AI')
      ? result
      : null;
  });

  await newtab.executeJavaScript(`
    document.querySelector('#home-query').value = 'What do the attached notes say?';
    document.querySelector('#home-search').requestSubmit();
  `, true);

  const ask = await waitFor(() => askTabContents());
  await waitFor(() => ask.executeJavaScript("Boolean(window.SovereignAsk?.attachmentNames)", true));

  const transferred = await waitFor(async () => {
    const result = await ask.executeJavaScript(`({
      url: location.href,
      attachments: window.SovereignAsk.attachmentNames(),
      webEnabled: document.querySelector('#web-toggle').checked,
      text: document.querySelector('#attachment-list').innerText,
      status: document.querySelector('#chat-status').innerText,
      thread: document.querySelector('#chat-thread').innerText
    })`, true);
    return result.attachments.some(item => item.name === 'home-notes.txt' && item.status === 'ready')
      ? result
      : null;
  });

  if (transferred.webEnabled) {
    throw new Error('Home-page attachments must not enable web search.');
  }
  if (!transferred.url.includes('handoff=')) {
    throw new Error(`Ask URL did not include handoff id: ${transferred.url}`);
  }
  if (!transferred.text.includes('home-notes.txt')) {
    throw new Error(`Transferred attachment did not render in Ask AI: ${JSON.stringify(transferred)}`);
  }
  const queued = await waitFor(async () => {
    const result = await ask.executeJavaScript(`({
      status: document.querySelector('#chat-status').innerText,
      thread: document.querySelector('#chat-thread').innerText
    })`, true);
    return result.status.includes('AI setup') || result.thread.includes('attached notes')
      ? result
      : null;
  });

  console.log(JSON.stringify({
    profile,
    transferredFile: 'home-notes.txt',
    webSearchEnabled: transferred.webEnabled,
    questionPreserved: queued.status.includes('AI setup') || queued.thread.includes('attached notes')
  }, null, 2));

  app.quit();
}

main().catch(error => {
  console.error(error);
  app.exit(1);
});
