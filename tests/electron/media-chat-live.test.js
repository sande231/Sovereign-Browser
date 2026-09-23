const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, clipboard, webContents } = require('electron');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-media-live-profile-'));
const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-media-live-downloads-'));
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({
  ai: {
    autoDownloadModel: false,
    setupNoticeSeen: true,
    setupCanceled: false,
    saveChatsOnDevice: false
  },
  search: {
    endpoint: 'http://127.0.0.1:8080/search'
  },
  downloads: {},
  bookmarks: [],
  startup: { continueWhereLeftOff: false },
  session: { windows: [] }
}, null, 2));
process.env.SOVEREIGN_USER_DATA_DIR = profile;
process.env.SOVEREIGN_TEST_DOWNLOAD_DIR = downloadDir;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 45000) {
  const started = Date.now();
  let lastValue;
  while (Date.now() - started < timeoutMs) {
    lastValue = await predicate();
    if (lastValue) {
      return lastValue;
    }
    await delay(250);
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
  require('../../src/main.js');
  await app.whenReady();

  const chrome = await waitFor(() => contentsByUrl('index.html'));
  await chrome.executeJavaScript("window.sovereign.openSearch({ question: 'show me a map of Nepal', mode: 'ask', autoRun: true })", true);
  const askPage = await waitFor(() => askTabContents());

  await waitFor(async () => {
    const text = await askPage.executeJavaScript("document.querySelector('#chat-thread').innerText", true);
    return text.includes('Search web for images') ? text : null;
  });
  const askUrlBefore = askPage.getURL();
  await askPage.executeJavaScript("document.querySelector('.chat-inline-action').click()", true);

  const selected = await waitFor(async () => {
    const cards = await askPage.executeJavaScript(`
      Array.from(document.querySelectorAll('.media-card')).map((card, index) => {
        const copy = card.querySelector('button[data-role="copy-original-media-url"]');
        const download = card.querySelector('button[data-role="download-media"]');
        return {
          index,
          title: card.querySelector('.media-card-body strong')?.textContent || '',
          text: card.innerText,
          originalUrl: card.dataset.originalUrl || '',
          thumbnailUrl: card.dataset.thumbnailUrl || '',
          canCopy: Boolean(copy),
          canDownload: Boolean(download && !download.disabled && download.textContent === 'Download')
        };
      })
    `, true);
    return cards.find(card => card.canCopy && card.canDownload && /^https:\/\//i.test(card.originalUrl)) || null;
  });

  const copyResult = await askPage.executeJavaScript(`
    (() => {
      const cards = Array.from(document.querySelectorAll('.media-card'));
      const card = cards.find(item => item.dataset.originalUrl === ${JSON.stringify(selected.originalUrl)});
      const button = card?.querySelector('button[data-role="copy-original-media-url"]');
      if (!card || !button) {
        return { ok: false, cardCount: cards.length, text: document.querySelector('#chat-thread')?.innerText || '' };
      }
      button.click();
      return { ok: true, cardText: card.innerText, originalUrl: card.dataset.originalUrl };
    })()
  `, true);
  if (!copyResult.ok) {
    throw new Error(`Could not click Copy image URL for selected live card: ${JSON.stringify(copyResult)}`);
  }
  await waitFor(() => clipboard.readText() === selected.originalUrl);

  await chrome.executeJavaScript(`window.sovereign.newTab(${JSON.stringify(selected.originalUrl)})`, true);
  const openedMediaTab = await waitFor(() => liveContents().find(contents => contents.getURL().startsWith(selected.originalUrl.slice(0, 80))));

  const downloadClick = await askPage.executeJavaScript(`
    (() => {
      const cards = Array.from(document.querySelectorAll('.media-card'));
      const card = cards.find(item => item.dataset.originalUrl === ${JSON.stringify(selected.originalUrl)});
      const button = card?.querySelector('button[data-role="download-media"]');
      if (!card || !button || button.disabled) {
        return { ok: false, cardCount: cards.length, buttonText: button?.textContent || '', cardText: card?.innerText || '' };
      }
      button.click();
      return { ok: true, cardText: card.innerText, originalUrl: card.dataset.originalUrl };
    })()
  `, true);
  if (!downloadClick.ok) {
    throw new Error(`Could not click Download for selected live card: ${JSON.stringify(downloadClick)}`);
  }
  const completedDownload = await waitFor(async () => {
    const state = await chrome.executeJavaScript('window.sovereign.downloads.getState()', true);
    return state.downloads.find(item => item.state === 'completed' && item.savePath && item.url === selected.originalUrl) ||
      state.downloads.find(item => item.state === 'completed' && item.savePath);
  }, 60000);

  const stat = fs.statSync(completedDownload.savePath);
  const firstBytes = fs.readFileSync(completedDownload.savePath).subarray(0, 16).toString('hex');
  if (stat.size <= 0) {
    throw new Error('Downloaded media file was empty.');
  }

  console.log(JSON.stringify({
    profile,
    downloadDir,
    askUrlBefore,
    askUrlAfter: askPage.getURL(),
    selected,
    clipboard: clipboard.readText(),
    openedMediaUrl: openedMediaTab.getURL(),
    download: {
      filename: completedDownload.filename,
      url: completedDownload.url,
      savePath: completedDownload.savePath,
      size: stat.size,
      firstBytes
    }
  }, null, 2));

  app.quit();
}

main().catch(error => {
  console.error(error);
  app.quit();
  process.exitCode = 1;
});
