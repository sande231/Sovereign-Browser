const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, webContents } = require('electron');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-download-profile-'));
const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-downloads-'));
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
process.env.SOVEREIGN_TEST_DOWNLOAD_DIR = downloadDir;

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

async function downloadState(chrome) {
  return chrome.executeJavaScript('window.sovereign.downloads.getState()', true);
}

async function waitForCompleted(chrome, filenamePart) {
  return waitFor(async () => {
    const state = await downloadState(chrome);
    return state.downloads.find(item => item.state === 'completed' && item.filename.includes(filenamePart));
  });
}

async function main() {
  const server = await listen((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/file.txt') {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'content-disposition': 'attachment; filename="sovereign-file.txt"'
      });
      res.end('sovereign file download\n');
      return;
    }
    if (url.pathname === '/page') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<a id="file" href="/file.txt">Download</a>
        <script>
          const blob = new Blob(['sovereign blob download\\n'], { type: 'text/plain' });
          const a = document.createElement('a');
          a.id = 'blob';
          a.href = URL.createObjectURL(blob);
          a.download = 'sovereign-blob.txt';
          a.textContent = 'Blob';
          document.body.append(a);
        </script>`);
      return;
    }
    res.writeHead(404).end('missing');
  });

  require('../../src/main.js');
  await app.whenReady();

  const chrome = await waitFor(() => contentsByUrl('index.html'));
  await chrome.executeJavaScript(`window.sovereign.newTab('http://127.0.0.1:${server.address().port}/page')`, true);
  const page = await waitFor(() => contentsByUrl('/page'));
  await page.executeJavaScript("document.querySelector('#file').click()", true);
  const fileDownload = await waitForCompleted(chrome, 'sovereign-file');
  await page.executeJavaScript("document.querySelector('#blob').click()", true);
  const blobDownload = await waitForCompleted(chrome, 'sovereign-blob');

  const fileContents = fs.readFileSync(fileDownload.savePath, 'utf8');
  const blobContents = fs.readFileSync(blobDownload.savePath, 'utf8');
  if (fileContents !== 'sovereign file download\n' || blobContents !== 'sovereign blob download\n') {
    throw new Error('Downloaded file contents did not match expected fixtures.');
  }

  console.log(JSON.stringify({
    profile,
    downloadDir,
    file: {
      filename: fileDownload.filename,
      contents: fileContents
    },
    blob: {
      filename: blobDownload.filename,
      contents: blobContents
    }
  }, null, 2));

  server.close();
  app.quit();
}

main().catch(error => {
  console.error(error);
  app.quit();
  process.exitCode = 1;
});
