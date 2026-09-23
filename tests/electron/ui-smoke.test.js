const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BaseWindow, nativeImage, webContents } = require('electron');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-ui-smoke-profile-'));
const screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-ui-smoke-shots-'));

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

function contentsWithExactUrl(url) {
  return liveContents().find(contents => contents.getURL() === url);
}

async function captureSurface(contents, name) {
  const image = await contents.capturePage();
  if (image.isEmpty()) {
    throw new Error(`${name} screenshot was empty.`);
  }
  const size = image.getSize();
  if (size.width < 100 || size.height < 80) {
    throw new Error(`${name} screenshot was unexpectedly small: ${size.width}x${size.height}.`);
  }
  const outputPath = path.join(screenshotDir, `${name}.png`);
  fs.writeFileSync(outputPath, image.toPNG());
  return {
    name,
    path: outputPath,
    size
  };
}

async function resizeMainWindow(width, height) {
  const windows = typeof BaseWindow.getAllWindows === 'function'
    ? BaseWindow.getAllWindows().filter(win => !win.isDestroyed())
    : [];
  const win = windows[0];
  if (win && typeof win.setBounds === 'function') {
    const bounds = typeof win.getBounds === 'function' ? win.getBounds() : { x: 0, y: 0 };
    win.setBounds({
      x: Number.isFinite(bounds.x) ? bounds.x : 0,
      y: Number.isFinite(bounds.y) ? bounds.y : 0,
      width,
      height
    });
    await delay(350);
    return true;
  }
  return false;
}

async function main() {
  require('../../src/main.js');
  await app.whenReady();

  const chrome = await waitFor(() => contentsByUrl('index.html'));
  const newtab = await waitFor(() => contentsByUrl('sovereign://newtab'));
  await waitFor(() => newtab.executeJavaScript("document.querySelector('#home-query') !== null", true));

  const captures = [];
  captures.push(await captureSurface(chrome, 'chrome-normal'));
  captures.push(await captureSurface(newtab, 'newtab-normal'));

  await chrome.executeJavaScript("window.sovereign.openSearch({ mode: 'ask' })", true);
  const ask = await waitFor(() => contentsWithExactUrl('sovereign://ask/'));
  await waitFor(() => ask.executeJavaScript("document.querySelector('#chat-input') !== null", true));
  captures.push(await captureSurface(ask, 'ask-normal'));

  await chrome.executeJavaScript('window.sovereign.openDownloads()', true);
  const downloads = await waitFor(() => contentsWithExactUrl('sovereign://downloads/'));
  await waitFor(() => downloads.executeJavaScript("document.querySelector('#downloads-list') !== null", true));
  captures.push(await captureSurface(downloads, 'downloads-normal'));

  const resized = await resizeMainWindow(760, 620);
  if (resized) {
    captures.push(await captureSurface(chrome, 'chrome-narrow'));
    captures.push(await captureSurface(newtab, 'newtab-narrow'));
  }

  for (const capture of captures) {
    const loaded = nativeImage.createFromPath(capture.path);
    if (loaded.isEmpty()) {
      throw new Error(`${capture.name} screenshot could not be read back from disk.`);
    }
  }

  console.log(JSON.stringify({
    profile,
    screenshotDir,
    resized,
    captures
  }, null, 2));

  app.quit();
}

main().catch(error => {
  console.error(error);
  app.quit();
  process.exitCode = 1;
});
