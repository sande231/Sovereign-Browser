const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, clipboard, Menu, webContents } = require('electron');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-stage1-profile-'));

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

function contentsWithExactUrl(url) {
  return liveContents().find(contents => contents.getURL() === url);
}

async function valueOf(contents, selector) {
  return contents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.value ?? null`, true);
}

async function focusEditable(contents, selector, value = '') {
  contents.focus();
  await contents.executeJavaScript(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) {
        throw new Error('Missing editable ${selector}');
      }
      el.value = ${JSON.stringify(value)};
      el.focus();
      if (typeof el.setSelectionRange === 'function') {
        el.setSelectionRange(el.value.length, el.value.length);
      }
    })();
  `, true);
}

async function selectEditable(contents, selector) {
  await contents.executeJavaScript(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el.focus();
      if (typeof el.select === 'function') {
        el.select();
      } else if (typeof el.setSelectionRange === 'function') {
        el.setSelectionRange(0, el.value.length);
      }
    })();
  `, true);
}

async function exerciseEditingTarget(label, contents, selector) {
  const text = `${label} copied text`;
  clipboard.writeText(text);
  await focusEditable(contents, selector, '');
  contents.paste();
  await waitFor(async () => (await valueOf(contents, selector)) === text);

  await selectEditable(contents, selector);
  clipboard.clear();
  contents.copy();
  await waitFor(() => clipboard.readText() === text);

  contents.cut();
  await waitFor(async () => (await valueOf(contents, selector)) === '');
  if (clipboard.readText() !== text) {
    throw new Error(`${label}: cut did not place selected text on the clipboard.`);
  }

  contents.undo();
  await waitFor(async () => (await valueOf(contents, selector)) === text);
  contents.redo();
  await waitFor(async () => (await valueOf(contents, selector)) === '');

  clipboard.writeText(`${label} pasted again`);
  contents.paste();
  await waitFor(async () => (await valueOf(contents, selector)) === `${label} pasted again`);
}

function assertEditMenuRoles() {
  const menu = Menu.getApplicationMenu();
  const edit = menu?.items.find(item => item.label === 'Edit');
  if (!edit?.submenu) {
    throw new Error('Application Edit menu is missing.');
  }
  const roles = new Set(edit.submenu.items.map(item => String(item.role || '').toLowerCase()).filter(Boolean));
  for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'pasteandmatchstyle', 'delete', 'selectall']) {
    if (!roles.has(role)) {
      const seen = edit.submenu.items.map(item => ({ label: item.label, role: item.role })).filter(item => item.label || item.role);
      throw new Error(`Application Edit menu is missing role: ${role}; seen ${JSON.stringify(seen)}`);
    }
  }
}

async function exerciseShortcuts(newtab) {
  await newtab.executeJavaScript(`
    (() => {
      document.querySelector('.shortcut-add').click();
      document.querySelector('#shortcut-title').value = 'Example Docs';
      document.querySelector('#shortcut-url').value = 'example.com/docs';
      document.querySelector('#shortcut-editor').requestSubmit();
    })();
  `, true);

  let shortcuts = await newtab.executeJavaScript('window.SovereignNewTab.getShortcuts()', true);
  let index = shortcuts.findIndex(item => item.title === 'Example Docs');
  if (index < 0 || shortcuts[index].url !== 'https://example.com/docs') {
    throw new Error(`Shortcut add/normalize failed: ${JSON.stringify(shortcuts)}`);
  }

  await newtab.executeJavaScript(`
    (() => {
      const index = window.SovereignNewTab.getShortcuts().findIndex(item => item.title === 'Example Docs');
      document.querySelector(\`[data-shortcut-index="\${index}"] .shortcut-action\`).click();
      document.querySelector('#shortcut-title').value = 'Example Reference';
      document.querySelector('#shortcut-url').value = 'https://example.org/path';
      document.querySelector('#shortcut-editor').requestSubmit();
    })();
  `, true);

  shortcuts = await newtab.executeJavaScript('window.SovereignNewTab.getShortcuts()', true);
  index = shortcuts.findIndex(item => item.title === 'Example Reference');
  if (index < 0 || shortcuts[index].url !== 'https://example.org/path') {
    throw new Error(`Shortcut edit failed: ${JSON.stringify(shortcuts)}`);
  }

  await newtab.executeJavaScript(`
    (() => {
      const index = window.SovereignNewTab.getShortcuts().findIndex(item => item.title === 'Example Reference');
      const buttons = document.querySelectorAll(\`[data-shortcut-index="\${index}"] .shortcut-action\`);
      buttons[1].click();
    })();
  `, true);
  shortcuts = await newtab.executeJavaScript('window.SovereignNewTab.getShortcuts()', true);
  const movedIndex = shortcuts.findIndex(item => item.title === 'Example Reference');
  if (movedIndex < 0 || movedIndex >= index) {
    throw new Error(`Shortcut reorder failed: ${JSON.stringify(shortcuts)}`);
  }

  newtab.reload();
  await waitFor(() => newtab.executeJavaScript('Boolean(window.SovereignNewTab?.getShortcuts)', true));
  shortcuts = await newtab.executeJavaScript('window.SovereignNewTab.getShortcuts()', true);
  if (!shortcuts.some(item => item.title === 'Example Reference' && item.url === 'https://example.org/path')) {
    throw new Error(`Shortcut was not persisted across reload: ${JSON.stringify(shortcuts)}`);
  }

  await newtab.executeJavaScript(`
    (() => {
      const index = window.SovereignNewTab.getShortcuts().findIndex(item => item.title === 'Example Reference');
      const buttons = document.querySelectorAll(\`[data-shortcut-index="\${index}"] .shortcut-action\`);
      buttons[3].click();
    })();
  `, true);
  shortcuts = await newtab.executeJavaScript('window.SovereignNewTab.getShortcuts()', true);
  if (shortcuts.some(item => item.title === 'Example Reference')) {
    throw new Error(`Shortcut delete failed: ${JSON.stringify(shortcuts)}`);
  }
}

async function main() {
  const server = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html>
      <title>Editing Test Page</title>
      <label>Site input <input id="site-input" value=""></label>`);
  });

  require('../../src/main.js');
  await app.whenReady();
  assertEditMenuRoles();

  const chrome = await waitFor(() => contentsByUrl('index.html'));
  const newtab = await waitFor(() => contentsWithExactUrl('sovereign://newtab/'));
  await waitFor(() => newtab.executeJavaScript("document.querySelector('#home-query') !== null", true));

  await exerciseEditingTarget('address', chrome, '#address');
  await exerciseEditingTarget('home', newtab, '#home-query');

  await chrome.executeJavaScript("window.sovereign.openSearch({ mode: 'ask' })", true);
  const ask = await waitFor(() => contentsWithExactUrl('sovereign://ask/'));
  await waitFor(() => ask.executeJavaScript("document.querySelector('#chat-input') !== null", true));
  await exerciseEditingTarget('ask', ask, '#chat-input');

  const pageUrl = `http://127.0.0.1:${server.address().port}/`;
  await chrome.executeJavaScript(`window.sovereign.newTab(${JSON.stringify(pageUrl)})`, true);
  const page = await waitFor(() => contentsByUrl(`127.0.0.1:${server.address().port}`));
  await waitFor(() => page.executeJavaScript("document.querySelector('#site-input') !== null", true));
  await exerciseEditingTarget('website', page, '#site-input');

  await exerciseShortcuts(newtab);

  console.log(JSON.stringify({
    profile,
    editMenu: 'roles present',
    editingTargets: ['address', 'home', 'ask', 'website'],
    shortcuts: 'add edit reorder delete reload-persistence'
  }, null, 2));

  server.close();
  app.quit();
}

main().catch(error => {
  console.error(error);
  app.quit();
  process.exitCode = 1;
});
