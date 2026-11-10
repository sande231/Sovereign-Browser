const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BaseWindow, webContents } = require('electron');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-ask-layout-'));
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({
  ai: { autoDownloadModel: false, setupNoticeSeen: true, setupCanceled: false, saveChatsOnDevice: true },
  search: {}, downloads: {}, bookmarks: [],
  startup: { continueWhereLeftOff: false }, session: { windows: [] }
}));
process.env.SOVEREIGN_USER_DATA_DIR = profile;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate) {
  const start = Date.now();
  while (Date.now() - start < 12000) {
    const result = await predicate();
    if (result) return result;
    await delay(100);
  }
  throw new Error('Timed out waiting for Ask AI.');
}
const contents = url => webContents.getAllWebContents().find(wc => !wc.isDestroyed() && wc.getURL().includes(url));
async function resize(width, height) {
  const win = BaseWindow.getAllWindows().find(win => !win.isDestroyed());
  assert.ok(win, 'Main window exists');
  win.setBounds({ ...win.getBounds(), width, height });
  await delay(350);
}
async function main() {
  require('../../src/main.js');
  await app.whenReady();
  const chrome = await waitFor(() => contents('index.html'));
  const home = await waitFor(() => contents('sovereign://newtab'));
  await waitFor(() => home.executeJavaScript("Boolean(document.querySelector('#home-query'))"));
  await chrome.executeJavaScript("window.sovereign.openSearch({ mode: 'ask' })", true);
  const ask = await waitFor(() => webContents.getAllWebContents().find(wc => !wc.isDestroyed() && wc.getURL() === 'sovereign://ask/'));
  await waitFor(() => ask.executeJavaScript("typeof renderThread === 'function' && typeof saveChatsOnDevice !== 'undefined' && saveChatsOnDevice && document.querySelector('#model-setup-card') && !document.querySelector('#model-setup-card').hidden"));
  await resize(1280, 900);
  const before = await ask.executeJavaScript(`(() => {
    savedChatList = Array.from({ length: 3 }, (_, i) => ({ id: 'layout-' + i, title: 'Saved chat ' + i, messages: [] }));
    saveChatsOnDevice = true;
    renderChatHistory();
    messages = Array.from({ length: 8 }, (_, i) => ({ id: 'message-' + i, role: i % 2 ? 'assistant' : 'user', content: 'Layout test message ' + i }));
    const portrait = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1200"><rect width="600" height="1200" fill="teal"/></svg>');
    messages.push({ id: 'images', role: 'assistant', content: 'Five portrait images', mediaResults: Array.from({ length: 5 }, (_, i) => ({
      type: 'images', title: 'Portrait ' + i, thumbnailUrl: portrait,
      pageUrl: 'https://example.test/portrait', hasSourcePage: true,
      mediaUrl: portrait, sourceDomain: 'example.test'
    })) });
    document.querySelector('#model-setup-card').hidden = false;
    renderThread({ forceScroll: true });
    return [...document.querySelectorAll('.media-card')].map(card => card.getBoundingClientRect().height);
  })()`);
  const layout = await ask.executeJavaScript(`(async () => {
    await Promise.all([...document.images].map(img => img.complete ? Promise.resolve() : new Promise(resolve => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    })));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const page = document.querySelector('.ask-page');
    const thread = document.querySelector('#chat-thread');
    const height = selector => document.querySelector(selector).getBoundingClientRect().height;
    const toggle = document.querySelector('#chat-history-toggle');
    return {
      viewport: innerHeight, pageHeight: page.clientHeight, pageScroll: page.scrollHeight,
      threadHeight: thread.clientHeight,
      otherHeights: [...page.children].filter(el => el !== thread).map(el => el.getBoundingClientRect().height),
      historyHidden: document.querySelector('#chat-history-list').hidden,
      expanded: toggle?.getAttribute('aria-expanded'), toggleText: toggle?.textContent,
      historyHeight: height('#chat-history-panel'), modelHeight: height('#model-setup-card'),
      compact: document.querySelector('#attachment-panel').classList.contains('compact'), attachmentHeight: height('#attachment-panel'),
      bottomGap: thread.scrollHeight - thread.scrollTop - thread.clientHeight,
      threadBottom: thread.getBoundingClientRect().bottom,
      actionsBottom: [...document.querySelectorAll('.media-actions')].at(-1).getBoundingClientRect().bottom,
      lastBottom: thread.lastElementChild.getBoundingClientRect().bottom,
      cardHeights: [...document.querySelectorAll('.media-card')].map(card => card.getBoundingClientRect().height),
      imagesLoaded: [...document.images].every(img => img.complete && img.naturalWidth > 0)
    };
  })()`);
  assert.ok(layout.imagesLoaded, 'Portrait thumbnails loaded successfully');
  assert.ok(layout.pageScroll <= layout.pageHeight + 1, 'Page must not scroll');
  assert.ok(layout.threadHeight >= 0.35 * layout.viewport, 'Thread occupies at least 35% of viewport');
  assert.ok(layout.otherHeights.every(h => h <= layout.threadHeight), 'Thread is tallest child');
  assert.equal(layout.historyHidden, true);
  assert.equal(layout.expanded, 'false');
  assert.match(layout.toggleText, /\(3\)/);
  assert.ok(layout.historyHeight <= 48, 'Collapsed history is compact');
  assert.ok(layout.modelHeight <= 56, 'Model card is compact');
  assert.ok(layout.compact && layout.attachmentHeight <= 48, 'Empty attachment panel is compact');
  assert.ok(layout.bottomGap <= 1, 'Still scrolled to end after image load');
  assert.ok(layout.actionsBottom <= layout.threadBottom - 8, 'Last media buttons have space below');
  assert.ok(layout.lastBottom <= layout.threadBottom, 'Last message fully inside thread');
  assert.equal(before.length, 5);
  assert.equal(layout.cardHeights.length, 5);
  before.forEach((height, i) => assert.ok(Math.abs(height - layout.cardHeights[i]) <= 1, 'Image load keeps card height stable'));
  const interactions = await ask.executeJavaScript(`(() => {
    const toggle = document.querySelector('#chat-history-toggle');
    const list = document.querySelector('#chat-history-list');
    const panel = document.querySelector('#attachment-panel');
    const results = {};
    toggle.click();
    results.expands = !list.hidden && toggle.getAttribute('aria-expanded') === 'true';
    toggle.click();
    results.collapses = list.hidden && toggle.getAttribute('aria-expanded') === 'false';
    // Avoid persisting fixture messages when newChat invokes its normal save path.
    messages = [];
    newChat();
    results.newChatExpands = !list.hidden;
    chatHistoryExpanded = null;
    messages = [{ id: 'restored', role: 'assistant', content: 'Restored chat' }];
    renderThread();
    results.restoreCollapses = list.hidden;
    savedChatsUnreadable = true;
    renderChatHistory();
    results.unreadableExpands = !list.hidden;
    savedChatsUnreadable = false;
    renderChatHistory();
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['x'], 'a.txt', { type: 'text/plain' }));
    const enter = new DragEvent('dragenter', { dataTransfer, cancelable: true });
    document.dispatchEvent(enter);
    results.dragExpands = !panel.classList.contains('compact') && !enter.defaultPrevented;
    document.dispatchEvent(new DragEvent('dragleave', { dataTransfer }));
    results.leaveCompacts = panel.classList.contains('compact');
    for (const type of ['drop', 'dragend']) {
      document.dispatchEvent(new DragEvent('dragenter', { dataTransfer }));
      document.dispatchEvent(new DragEvent(type, { dataTransfer }));
      results[type + 'Compacts'] = panel.classList.contains('compact');
    }
    attachments.push({ id: 'fixture', name: 'a.txt', status: 'ready' });
    renderAttachments();
    results.attachmentExpands = !panel.classList.contains('compact');
    attachments.splice(0);
    renderAttachments();
    results.removeCompacts = panel.classList.contains('compact');
    return results;
  })()`);
  for (const [name, passed] of Object.entries(interactions)) assert.equal(passed, true, name);
  await resize(600, 500);
  const small = await ask.executeJavaScript(`(() => {
    const page = document.querySelector('.ask-page');
    page.scrollTop = page.scrollHeight;
    return { composerBottom: document.querySelector('#chat-form').getBoundingClientRect().bottom,
      viewport: innerHeight, threadHeight: document.querySelector('#chat-thread').clientHeight };
  })()`);
  assert.ok(small.composerBottom <= small.viewport, 'Small-window composer remains reachable');
  assert.ok(small.threadHeight >= 120, 'Small-window thread keeps its floor');
  console.log(JSON.stringify({ ok: true, profile, layout, interactions, small }, null, 2));
  app.exit(0);
}
main().catch(error => {
  console.error(JSON.stringify({ ok: false, error: error.stack }));
  app.exit(1);
});
