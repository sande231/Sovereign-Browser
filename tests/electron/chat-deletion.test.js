process.env.SOVEREIGN_TEST_NETWORK_MODE ||= 'online'; // Offline mode is tested in offline-mode.test.js.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { app, BrowserWindow, webContents } = require('electron');

// Proves saved chats are removed from Sovereign's storage, using only supported APIs.
//
// Runs as several launches on one profile, so data is flushed to disk and the profile is closed
// before it is inspected:
//   1. seed-residue, seed: write chats into localStorage the way older builds did (with an older
//      value overwritten, as in real use), from a bare sovereign://ask window (no preload, so this
//      build's migration does not run). They also write data deletion must never touch: other
//      localStorage keys, the theme, an IndexedDB database on the
//      sovereign://ask origin (where the AI model cache lives), and New Tab shortcuts.
//   2. main: Settings is opened before Ask AI and deletes the legacy chats. Then single delete,
//      Clear history (saving on and off), Keep/Delete when turning saving off, unreadable and
//      invalid chat files, deletion from another Ask tab while generating, refused IPC callers.
//   3. seed-legacy + fail-remove (twice): removing the legacy key is made to fail after the user
//      confirmed. Then a later scan (Ask AI opening, or the next start) must remove the key
//      without restoring any deleted chat.
//   4. verify: everything that must be kept is still readable, and settings are unchanged.
//   After launches exit, this process scans every file in the profile. Deleted chat text must
//   not be in any of Sovereign's own files. Chromium's internal localStorage files may keep
//   fragments (reported, not failed): Sovereign does not touch Chromium's files.
// The confirmation dialog is answered with the test-only SOVEREIGN_CHAT_DELETE_TEST_ANSWER.

const PHASE = (process.argv.find(arg => arg.startsWith('--phase=')) || '--phase=orchestrate').slice('--phase='.length);
const DELETED_MARKERS = [
  'MARKER-LEGACY-ONE', 'MARKER-LEGACY-TWO', 'MARKER-RESIDUE', 'MARKER-ALPHA', 'MARKER-BRAVO',
  'MARKER-CHARLIE', 'MARKER-DELTA', 'MARKER-CORRUPT', 'MARKER-OFF', 'MARKER-GENERATING',
  'MARKER-INVALID-CHAT'
];
const LATER_MARKERS = ['MARKER-FAIL-ASK', 'MARKER-FAIL-RESTART'];
const KEEP_THEME = 'dark';
const KEEP_MODEL_CACHE = 'MARKER-KEEP-MODEL-CACHE';
const KEEP_SHORTCUT = 'MARKER-KEEP-SHORTCUT';
const FRAGMENTS_TEXT = "from Sovereign's storage. Chromium may keep fragments in its internal files until it cleans them up.";
const LEGACY_PENDING_TEXT = 'Chats saved by an older version could not be removed yet; Sovereign will try again the next time it starts.';
const KEEP_MARKER = 'MARKER-KEEP-UNRELATED-LOCALSTORAGE';

function expect(condition, message, details) {
  if (!condition) {
    throw new Error(`${message}${details === undefined ? '' : `: ${JSON.stringify(details)}`}`);
  }
}

// Every file under the profile, recursively, read as raw bytes.
function profileFilesContaining(profile, marker) {
  const needle = Buffer.from(marker, 'latin1');
  const needle16 = Buffer.from(marker, 'utf16le');
  return fs.readdirSync(profile, { recursive: true })
    .map(name => path.join(profile, name))
    .filter(file => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    })
    .filter(file => {
      const bytes = fs.readFileSync(file);
      return bytes.includes(needle) || bytes.includes(needle16);
    })
    .map(file => path.relative(profile, file));
}

// ---------- orchestrator ----------

function runPhase(phase, profile, extraEnv = {}) {
  const env = { ...process.env, CHAT_TEST_PROFILE: profile, ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(process.execPath, [__filename, `--phase=${phase}`], { env, stdio: 'inherit', timeout: 180000 });
  expect(result.status === 0, `Phase ${phase} failed`, { status: result.status, signal: result.signal });
}

function orchestrate() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-chat-deletion-profile-'));
  fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({
    ai: { autoDownloadModel: false, setupNoticeSeen: true, setupCanceled: false, saveChatsOnDevice: true },
    search: {},
    downloads: {},
    bookmarks: [],
    startup: { continueWhereLeftOff: false },
    session: { windows: [] }
  }, null, 2));

  const deletionsFile = path.join(profile, 'chat-deletions.json');
  const legacyPending = () => JSON.parse(fs.readFileSync(deletionsFile, 'utf8')).legacyDeletePending;
  // Deleted text must not be in Sovereign's own files. Chromium's localStorage files may keep
  // fragments until Chromium cleans them up; those are reported, not failed.
  const leftoversOf = markers => {
    const outside = {};
    const fragments = {};
    for (const marker of markers) {
      for (const file of profileFilesContaining(profile, marker)) {
        const bucket = file.startsWith(`Local Storage${path.sep}`) ? fragments : outside;
        (bucket[marker] ||= []).push(file);
      }
    }
    return { outside, fragments };
  };
  const preferencesBefore = () => JSON.parse(fs.readFileSync(path.join(profile, 'preferences.json'), 'utf8'));

  runPhase('seed-residue', profile);
  expect(profileFilesContaining(profile, 'MARKER-RESIDUE').length > 0, 'Fixture: the older value is flushed to disk');
  runPhase('seed', profile);
  for (const marker of ['MARKER-LEGACY-ONE', 'MARKER-RESIDUE', KEEP_MARKER]) {
    const files = profileFilesContaining(profile, marker);
    expect(files.some(file => file.startsWith('Local Storage')), `Fixture: ${marker} must be flushed to Chromium's localStorage`, files);
  }
  const settingsBefore = preferencesBefore();

  runPhase('main', profile);
  const afterMain = leftoversOf(DELETED_MARKERS);
  expect(Object.keys(afterMain.outside).length === 0, "Deleted chat text must not remain in Sovereign's own files", afterMain.outside);
  expect(!/MARKER-/.test(fs.readFileSync(deletionsFile, 'utf8')), 'The deletion record holds ids only, no chat text');

  // REVIEW round 3, item 3: removing the legacy key fails after the user confirmed deletion.
  // a) A later scan from Ask AI must not restore the chats.
  runPhase('seed-legacy', profile, { CHAT_TEST_SEED_MARKER: 'MARKER-FAIL-ASK' });
  runPhase('fail-remove', profile, { SOVEREIGN_TEST_LEGACY_REMOVE: 'fail', CHAT_TEST_SEED_MARKER: 'MARKER-FAIL-ASK', CHAT_TEST_THEN: 'ask' });
  expect(legacyPending() === false, 'Ask AI removed the key and cleared the pending delete');
  // b) The next start must finish the delete, again without restoring anything.
  runPhase('seed-legacy', profile, { CHAT_TEST_SEED_MARKER: 'MARKER-FAIL-RESTART' });
  runPhase('fail-remove', profile, { SOVEREIGN_TEST_LEGACY_REMOVE: 'fail', CHAT_TEST_SEED_MARKER: 'MARKER-FAIL-RESTART', CHAT_TEST_THEN: 'quit' });
  expect(legacyPending() === true, 'Failed removal stays recorded as pending across the restart');

  runPhase('verify', profile);
  expect(legacyPending() === false, 'The next start removed the key and cleared the pending delete');
  runPhase('pending-notice', profile, { SOVEREIGN_TEST_LEGACY_REMOVE: 'fail' });
  runPhase('pending-cleared', profile, { SOVEREIGN_TEST_LEGACY_REMOVE: '' });
  const atEnd = leftoversOf([...DELETED_MARKERS, ...LATER_MARKERS]);
  expect(Object.keys(atEnd.outside).length === 0, "No deleted chat text in Sovereign's own files", atEnd.outside);
  expect(!fs.existsSync(path.join(profile, 'saved-chats.json')), 'No saved chats were restored');

  // Settings untouched by deletion, apart from the switch the test flipped.
  const settingsAfter = preferencesBefore();
  for (const key of ['search', 'downloads', 'bookmarks', 'startup']) {
    expect(JSON.stringify(settingsAfter[key]) === JSON.stringify(settingsBefore[key]), `Setting "${key}" is unchanged`, { before: settingsBefore[key], after: settingsAfter[key] });
  }
  const aiBefore = { ...settingsBefore.ai, saveChatsOnDevice: null };
  const aiAfter = { ...settingsAfter.ai, saveChatsOnDevice: null };
  expect(JSON.stringify(aiAfter) === JSON.stringify(aiBefore), 'AI settings (model choice etc.) are unchanged', { aiBefore, aiAfter });
  const kept = profileFilesContaining(profile, KEEP_MARKER);

  console.log(JSON.stringify({
    ok: true,
    profile,
    scannedMarkers: DELETED_MARKERS.length + LATER_MARKERS.length,
    chromiumFragments: atEnd.fragments,
    keptIn: kept
  }, null, 2));
}

// ---------- helpers for the app phases ----------

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

function askTabs() {
  return liveContents().filter(contents => {
    const url = contents.getURL();
    return url.startsWith('sovereign://ask/') && !url.includes('model-setup') && !url.includes('sidebar') && !url.includes('legacy-chat-probe');
  });
}

async function openAskTab(chrome, known = []) {
  await chrome.executeJavaScript("window.sovereign.openSearch({ question: 'chat deletion test', mode: 'ask', autoRun: false })", true);
  const page = await waitFor(() => askTabs().find(contents => !known.includes(contents)));
  await waitFor(() => page.executeJavaScript("typeof savedChatList !== 'undefined' && settings !== null", true));
  await delay(300);
  return page;
}

async function launch() {
  process.env.SOVEREIGN_USER_DATA_DIR = process.env.CHAT_TEST_PROFILE;
  require('../../src/main.js');
  await app.whenReady();
  return waitFor(() => contentsByUrl('index.html'));
}

function savedChatBytes(profile) {
  return fs.readdirSync(profile)
    .filter(name => name.startsWith('saved-chats'))
    .map(name => fs.readFileSync(path.join(profile, name), 'utf8'))
    .join('\n');
}

function savedChatFiles(profile) {
  return fs.readdirSync(profile).filter(name => name.startsWith('saved-chats'));
}

async function saveChat(askPage, id, marker) {
  await askPage.executeJavaScript(`(async () => {
    chatId = ${JSON.stringify(id)};
    messages = [
      { id: '${id}-u', role: 'user', content: 'question ${marker}' },
      { id: '${id}-a', role: 'assistant', content: 'answer ${marker}', sources: [] }
    ];
    await persistCurrentChat();
  })()`, true);
}

function askState(askPage) {
  return askPage.executeJavaScript(`({
    ids: savedChatList.map(chat => chat.id),
    unreadable: savedChatsUnreadable,
    items: document.querySelectorAll('.chat-history-item').length,
    notice: Boolean(document.querySelector('.chat-history-unreadable')),
    clearDisabled: document.querySelector('#clear-chat-history').disabled,
    panelHidden: document.querySelector('#chat-history-panel').hidden,
    threadText: document.querySelector('#chat-thread').innerText,
    modelInput: lastModelMessages.length,
    chatId
  })`, true);
}

async function setSaving(settingsPage, enabled) {
  await settingsPage.executeJavaScript(`
    document.querySelector('#settings-status').textContent = '';
    document.querySelector('#settings-save-chats').checked = ${enabled};
    document.querySelector('#settings-save-chats').dispatchEvent(new Event('change'));
  `, true);
  return waitFor(() => settingsPage.executeJavaScript("document.querySelector('#settings-status').textContent", true));
}

async function rejects(contents, call) {
  return contents.executeJavaScript(`${call}.then(() => 'allowed', error => 'refused')`, true);
}

// ---------- phase 1: seed legacy localStorage like an older build ----------

// Writes localStorage in the sovereign://ask origin like an older build did, from a bare window
// (no preload, so this build's Ask page code and its migration never run here).
async function legacyOriginPage() {
  await launch();
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadURL('sovereign://ask/sidebar.html').catch(() => {});
  await waitFor(() => win.webContents.executeJavaScript('location.origin', true).then(origin => origin === 'sovereign://ask'));
  return win.webContents;
}

// Separate launches, so the older value reaches disk before it is overwritten
// (Chromium batches localStorage writes, and two quick writes would collapse into one).
async function seedResidue() {
  const askPage = await legacyOriginPage();
  await askPage.executeJavaScript(`
    localStorage.setItem('sovereign.ask.chats', JSON.stringify([{ id: 'old', title: 'MARKER-RESIDUE', messages: [{ role: 'user', content: 'MARKER-RESIDUE' }] }]));
  `, true);
  await delay(1500);
}

async function seed() {
  const askPage = await legacyOriginPage();
  await askPage.executeJavaScript(`
    localStorage.setItem('sovereign.ask.chats', JSON.stringify([
      { id: 'legacy-1', title: 'MARKER-LEGACY-ONE', updatedAt: '2026-01-01T00:00:00.000Z', messages: [{ role: 'user', content: 'MARKER-LEGACY-ONE' }] },
      { id: 'legacy-2', title: 'MARKER-LEGACY-TWO', updatedAt: '2026-01-02T00:00:00.000Z', messages: [{ role: 'user', content: 'MARKER-LEGACY-TWO' }] }
    ]));
    localStorage.setItem('probe.keep', '${KEEP_MARKER}');
    localStorage.setItem('sovereign.theme', '${KEEP_THEME}');
  `, true);
  // The AI model cache is IndexedDB on this same origin; deletion must leave it alone.
  await askPage.executeJavaScript(`new Promise((resolve, reject) => {
    const open = indexedDB.open('sovereign-test-model-cache', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('files');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('files', 'readwrite');
      tx.objectStore('files').put('${KEEP_MODEL_CACHE}', 'model-shard-1');
      tx.oncomplete = () => { open.result.close(); resolve(true); };
      tx.onerror = () => reject(tx.error);
    };
  })`, true);
  const newtab = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await newtab.loadURL('sovereign://newtab/legacy-chat-probe.html');
  await newtab.webContents.executeJavaScript(`localStorage.setItem('sovereign.shortcuts', JSON.stringify([{ title: '${KEEP_SHORTCUT}', url: 'https://example.com/' }])); true`, true);
  await delay(1500);
}

// Chat ids are random in real use; keep the marker text out of the id so the scan stays meaningful.
function legacyIdFor(marker) {
  return marker.toLowerCase().replace('marker-', 'legacy-');
}

// Writes legacy chats again for the failed-removal phases.
async function seedLegacy() {
  const marker = process.env.CHAT_TEST_SEED_MARKER;
  const askPage = await legacyOriginPage();
  await askPage.executeJavaScript(`
    localStorage.setItem('sovereign.ask.chats', JSON.stringify([
      { id: '${legacyIdFor(marker)}', title: '${marker}', messages: [{ role: 'user', content: '${marker}' }] }
    ]));
  `, true);
  await delay(1500);
}

// ---------- phase 2: this build ----------

async function main() {
  const profile = process.env.CHAT_TEST_PROFILE;
  const chatFile = path.join(profile, 'saved-chats.json');
  const chrome = await launch();

  // 1. Settings before Ask AI: the delete finds the old chats in localStorage (read through
  // Chromium's localStorage API) and deletes them; nothing was imported at startup.
  expect(savedChatFiles(profile).length === 0, 'Nothing is moved at startup; Chromium files are never opened directly');
  expect(askTabs().length === 0, 'No Ask AI page has opened yet');
  await chrome.executeJavaScript('window.sovereign.openSettings()', true);
  const settingsPage = await waitFor(() => contentsByUrl('sovereign://settings/'));
  await waitFor(() => settingsPage.executeJavaScript("document.querySelector('#settings-save-chats').checked === true", true));
  process.env.SOVEREIGN_CHAT_DELETE_TEST_ANSWER = 'delete';
  const legacyDeleted = await setSaving(settingsPage, false);
  expect(legacyDeleted === `Chat saving turned off. 2 saved chats deleted ${FRAGMENTS_TEXT}`, 'Disabling saving offers and deletes the legacy chats', legacyDeleted);
  expect(savedChatFiles(profile).length === 0, 'Legacy chats are gone from saved-chats.json', savedChatFiles(profile));
  await setSaving(settingsPage, true);

  // Ask AI opens afterwards: nothing is re-imported, the key is gone, other data is intact.
  const askPage = await openAskTab(chrome);
  const afterOpen = await askState(askPage);
  expect(afterOpen.ids.length === 0, 'Legacy chats do not come back when Ask AI opens', afterOpen);
  const storage = await askPage.executeJavaScript("({ chats: localStorage.getItem('sovereign.ask.chats'), keep: localStorage.getItem('probe.keep') })", true);
  expect(storage.chats === null && storage.keep === KEEP_MARKER, 'Legacy key removed; unrelated localStorage kept and readable by Chromium', storage);

  // 2. Saving writes only the file; a single delete removes that chat at once.
  await saveChat(askPage, 'chat-a', 'MARKER-ALPHA');
  await saveChat(askPage, 'chat-b', 'MARKER-BRAVO');
  expect((fs.statSync(chatFile).mode & 0o777) === 0o600, 'saved-chats.json is private to the user');
  expect(/MARKER-ALPHA/.test(savedChatBytes(profile)) && /MARKER-BRAVO/.test(savedChatBytes(profile)), 'Both chats are on disk');
  await waitFor(async () => (await askState(askPage)).items === 2);
  await askPage.executeJavaScript(`
    Array.from(document.querySelectorAll('.chat-history-item'))
      .find(item => item.querySelector('.chat-history-title').textContent.includes('MARKER-BRAVO'))
      .querySelector('.compact-action').click();
  `, true);
  await waitFor(() => !/MARKER-BRAVO/.test(savedChatBytes(profile)));
  const afterDelete = await askState(askPage);
  expect(afterDelete.ids.join() === 'chat-a', 'Only chat-a is listed after delete', afterDelete);
  expect(!afterDelete.threadText.includes('MARKER-BRAVO'), 'The deleted open chat is closed', afterDelete);
  await askPage.executeJavaScript("chatId = 'chat-b'; messages = [{ id: 'x', role: 'user', content: 'MARKER-BRAVO again' }]; persistCurrentChat()", true);
  await delay(300);
  expect(!/MARKER-BRAVO/.test(savedChatBytes(profile)), 'A deleted chat id is never saved again from this tab');
  await askPage.executeJavaScript('closeDeletedChat()', true);

  // 3. Two tabs: chat-a is open and "generating" in tab 1 and is deleted from tab 2.
  const secondAsk = await openAskTab(chrome, [askPage]);
  await waitFor(async () => (await askState(secondAsk)).ids.join() === 'chat-a');
  await askPage.executeJavaScript(`
    chatId = 'chat-a';
    messages = [{ id: 'g1', role: 'user', content: 'MARKER-GENERATING' }];
    lastModelMessages = [{ role: 'user', content: 'MARKER-GENERATING' }];
    renderThread();
    setRunning(true);
  `, true);
  await secondAsk.executeJavaScript("document.querySelector('.chat-history-item .compact-action').click()", true);
  await waitFor(() => !/MARKER-ALPHA/.test(savedChatBytes(profile)));
  await waitFor(async () => (await askState(askPage)).ids.length === 0);
  const whileRunning = await askState(askPage);
  expect(whileRunning.threadText.includes('MARKER-GENERATING'), 'While generating, the deleted chat stays on screen', whileRunning);
  await askPage.executeJavaScript('setRunning(false); persistCurrentChat()', true);
  await delay(300);
  const afterRunning = await askState(askPage);
  expect(!afterRunning.threadText.includes('MARKER-GENERATING') && afterRunning.modelInput === 0 && afterRunning.chatId !== 'chat-a',
    'When generation ends, the deleted chat is closed and the model input is dropped', afterRunning);
  expect(savedChatFiles(profile).length === 0, 'The deleted chat was not saved again when generation ended', savedChatFiles(profile));

  // 4. Turning saving off with Keep: chats stay and remain visible so they can be deleted.
  await saveChat(askPage, 'chat-c', 'MARKER-CHARLIE');
  await askPage.executeJavaScript('closeDeletedChat()', true);
  process.env.SOVEREIGN_CHAT_DELETE_TEST_ANSWER = 'keep';
  const keptStatus = await setSaving(settingsPage, false);
  expect(/kept/i.test(keptStatus), 'Keep is reported in Settings', keptStatus);
  expect(/MARKER-CHARLIE/.test(savedChatBytes(profile)), 'Keep leaves chats on disk');
  await waitFor(() => askPage.executeJavaScript('saveChatsOnDevice === false', true));
  const keptState = await askState(askPage);
  expect(!keptState.panelHidden && keptState.items === 1, 'With saving off, saved chats stay visible', keptState);

  // 5. Clear history with saving off: Cancel keeps everything, Delete removes the file.
  await askPage.executeJavaScript("document.querySelector('#clear-chat-history').click()", true);
  await delay(500);
  expect(/MARKER-CHARLIE/.test(savedChatBytes(profile)), 'Clear history asks first; Cancel deletes nothing');
  process.env.SOVEREIGN_CHAT_DELETE_TEST_ANSWER = 'delete';
  await askPage.executeJavaScript("document.querySelector('#clear-chat-history').click()", true);
  await waitFor(() => !fs.existsSync(chatFile));
  expect(savedChatFiles(profile).length === 0, 'Clear history leaves no saved-chat files', savedChatFiles(profile));
  let clearStatus;
  try {
    await waitFor(async () => {
      clearStatus = await askPage.executeJavaScript("document.querySelector('#chat-status').textContent", true);
      return clearStatus === `Deleted ${FRAGMENTS_TEXT}`;
    });
  } catch {
    expect(false, 'Clear history uses the honest wording', clearStatus);
  }
  expect(clearStatus === `Deleted ${FRAGMENTS_TEXT}`, 'Clear history uses the honest wording', clearStatus);
  await waitFor(async () => (await askState(askPage)).panelHidden);

  // 6. With saving off, a chat is never written.
  await saveChat(askPage, 'chat-off', 'MARKER-OFF');
  await delay(300);
  expect(savedChatFiles(profile).length === 0, 'Nothing is saved while saving is off', savedChatFiles(profile));
  await askPage.executeJavaScript('closeDeletedChat()', true);

  // 7. An unreadable (truncated) chat file can still be deleted: from Ask AI, and from Settings.
  fs.writeFileSync(chatFile, '[{"id":"broken","title":"MARKER-CORRUPT question","messages":[{"role":"user","content":"MARKER-CORRUPT');
  await askPage.executeJavaScript('loadSavedChats()', true);
  const corruptState = await askState(askPage);
  expect(corruptState.unreadable && corruptState.notice && !corruptState.panelHidden && !corruptState.clearDisabled,
    'An unreadable file is shown with an enabled Clear history', corruptState);
  await askPage.executeJavaScript("document.querySelector('#clear-chat-history').click()", true);
  await waitFor(() => !fs.existsSync(chatFile));
  await waitFor(async () => (await askState(askPage)).panelHidden);

  await setSaving(settingsPage, true);
  fs.writeFileSync(chatFile, '[{"id":"broken","title":"MARKER-CORRUPT again');
  const corruptDeleted = await setSaving(settingsPage, false);
  expect(/Unreadable saved chat history deleted/.test(corruptDeleted), 'Disabling saving offers to delete an unreadable file', corruptDeleted);
  expect(savedChatFiles(profile).length === 0, 'Unreadable file removed', savedChatFiles(profile));

  // REVIEW round 3, item 2: valid JSON whose entries are not valid chats (no id) is still
  // stored text. Shown as unreadable in Ask AI, and deletable from Ask AI and from Settings.
  const invalidList = '[{"title":"MARKER-INVALID-CHAT","messages":[{"role":"user","content":"MARKER-INVALID-CHAT"}]}]';
  fs.writeFileSync(chatFile, invalidList);
  await askPage.executeJavaScript('loadSavedChats()', true);
  const invalidState = await askState(askPage);
  expect(invalidState.unreadable && invalidState.notice && !invalidState.clearDisabled, 'An invalid chat list is shown as unreadable', invalidState);
  await askPage.executeJavaScript("document.querySelector('#clear-chat-history').click()", true);
  await waitFor(() => !fs.existsSync(chatFile));
  await setSaving(settingsPage, true);
  fs.writeFileSync(chatFile, invalidList);
  const invalidDeleted = await setSaving(settingsPage, false);
  expect(/Unreadable saved chat history deleted/.test(invalidDeleted), 'Disabling saving deletes an invalid chat list', invalidDeleted);
  expect(savedChatFiles(profile).length === 0, 'Invalid chat list removed', savedChatFiles(profile));

  // 8. Turn saving on, save, turn off with Delete; turning it on again brings nothing back.
  await setSaving(settingsPage, true);
  await waitFor(() => askPage.executeJavaScript('saveChatsOnDevice === true', true));
  await saveChat(askPage, 'chat-d', 'MARKER-DELTA');
  const deletedStatus = await setSaving(settingsPage, false);
  expect(deletedStatus === `Chat saving turned off. 1 saved chat deleted ${FRAGMENTS_TEXT}`, 'Delete is reported in Settings', deletedStatus);
  expect(savedChatFiles(profile).length === 0, 'Turning saving off with Delete removes the file', savedChatFiles(profile));
  await waitFor(async () => (await askState(askPage)).ids.length === 0);
  await waitFor(async () => (await askState(secondAsk)).ids.length === 0);
  await setSaving(settingsPage, true);
  await askPage.executeJavaScript('loadSavedChats()', true);
  expect((await askState(askPage)).ids.length === 0, 'Old chats do not come back when saving is turned on again');

  // 9. Only Ask AI (and Settings for the disable offer) may use the chat IPC.
  const refusals = {
    settingsList: await rejects(settingsPage, 'window.sovereign.chats.list()'),
    settingsSave: await rejects(settingsPage, "window.sovereign.chats.save({ id: 'x', messages: [] })"),
    settingsClear: await rejects(settingsPage, 'window.sovereign.chats.clear()'),
    chromeList: await rejects(chrome, 'window.sovereign.chats.list()'),
    askOffer: await rejects(askPage, 'window.sovereign.chats.offerDeleteOnDisable()')
  };
  expect(Object.values(refusals).every(value => value === 'refused'), 'Chat IPC from other pages is refused', refusals);
  expect(savedChatFiles(profile).length === 0, 'Refused calls wrote nothing', savedChatFiles(profile));

  await askPage.executeJavaScript('closeDeletedChat(); messages = []', true);
  await secondAsk.executeJavaScript('closeDeletedChat(); messages = []', true);
  await delay(1000);
}

// ---------- phase 3: removing the legacy key fails after the user confirmed ----------

async function settingsFirst(chrome) {
  await chrome.executeJavaScript('window.sovereign.openSettings()', true);
  const settingsPage = await waitFor(() => contentsByUrl('sovereign://settings/'));
  await waitFor(() => settingsPage.executeJavaScript("document.querySelector('#settings-save-chats') !== null", true));
  await delay(300);
  return settingsPage;
}

function deletionRecord(profile) {
  return JSON.parse(fs.readFileSync(path.join(profile, 'chat-deletions.json'), 'utf8'));
}

async function failRemove() {
  const profile = process.env.CHAT_TEST_PROFILE;
  const marker = process.env.CHAT_TEST_SEED_MARKER;
  const chrome = await launch();
  const settingsPage = await settingsFirst(chrome);
  await setSaving(settingsPage, true);
  process.env.SOVEREIGN_CHAT_DELETE_TEST_ANSWER = 'delete';
  const status = await setSaving(settingsPage, false);
  expect(status === `Chat saving turned off. 1 saved chat deleted ${FRAGMENTS_TEXT} ${LEGACY_PENDING_TEXT}`,
    'Settings reports the delete and that the old chats are removed next start', status);
  const record = deletionRecord(profile);
  expect(record.legacyDeletePending === true && record.deletedIds.includes(legacyIdFor(marker)), 'The delete was recorded before the failed removal', record);
  expect(savedChatFiles(profile).length === 0, 'Nothing was imported', savedChatFiles(profile));

  if (process.env.CHAT_TEST_THEN === 'ask') {
    // A later scan: Ask AI opens, finds the key, and must remove it without restoring the chat.
    await setSaving(settingsPage, true);
    const askPage = await openAskTab(chrome);
    await waitFor(() => !deletionRecord(profile).legacyDeletePending);
    const state = await askState(askPage);
    expect(state.ids.length === 0, 'The later scan restored nothing', state);
    expect(await askPage.executeJavaScript("localStorage.getItem('sovereign.ask.chats')", true) === null, 'Ask AI removed the key');
    expect(savedChatFiles(profile).length === 0, 'No saved-chats file was written', savedChatFiles(profile));
  }
  await delay(1000);
}

// ---------- phase 4: next start, and everything that must be kept ----------

async function readOrigin(url, script) {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadURL(url);
  try {
    return await win.webContents.executeJavaScript(script, true);
  } finally {
    win.destroy();
  }
}

async function verify() {
  const profile = process.env.CHAT_TEST_PROFILE;
  const chrome = await launch();
  // The pending delete from the failed removal is finished at startup.
  await waitFor(() => !deletionRecord(profile).legacyDeletePending);
  const askPage = await openAskTab(chrome);
  const state = await askState(askPage);
  expect(state.ids.length === 0, 'Nothing was restored at startup', state);
  expect(savedChatFiles(profile).length === 0, 'No saved-chats file', savedChatFiles(profile));

  const ask = await readOrigin('sovereign://ask/legacy-chat-probe.html', `(async () => {
    const model = await new Promise((resolve, reject) => {
      const open = indexedDB.open('sovereign-test-model-cache', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const request = open.result.transaction('files').objectStore('files').get('model-shard-1');
        request.onsuccess = () => { open.result.close(); resolve(request.result); };
        request.onerror = () => reject(request.error);
      };
    });
    return {
      chats: localStorage.getItem('sovereign.ask.chats'),
      keep: localStorage.getItem('probe.keep'),
      theme: localStorage.getItem('sovereign.theme'),
      model
    };
  })()`);
  expect(ask.chats === null, 'The legacy key is gone', ask);
  expect(ask.keep === KEEP_MARKER && ask.theme === KEEP_THEME, 'Other localStorage on the Ask origin (theme) is kept', ask);
  // WebLLM is configured with cacheBackend: 'indexeddb' (src/ai/ai-engine-entry.js).
  expect(ask.model === KEEP_MODEL_CACHE, 'Model cache storage (IndexedDB on the Ask origin) is untouched', ask);
  const shortcuts = await readOrigin('sovereign://newtab/legacy-chat-probe.html', "localStorage.getItem('sovereign.shortcuts')");
  expect(String(shortcuts).includes(KEEP_SHORTCUT), 'New Tab shortcuts are kept', shortcuts);
  const modelSetup = await askPage.executeJavaScript('window.sovereign.modelSetup.getState()', true);
  expect(modelSetup && typeof modelSetup === 'object', 'Model setup state still loads', modelSetup);
  await delay(500);
}

// ---------- phases 5–6: persistent pending notice and successful retry ----------

async function pendingNotice() {
  const profile = process.env.CHAT_TEST_PROFILE;
  const pending = PHASE === 'pending-notice';
  if (pending) {
    const file = path.join(profile, 'chat-deletions.json');
    const record = deletionRecord(profile);
    record.legacyDeletePending = true;
    // Updating the existing file preserves its mode and all other fields, including deletedIds.
    fs.writeFileSync(file, JSON.stringify(record));
  }
  const chrome = await launch();
  const settingsPage = await settingsFirst(chrome);
  const noticeMatches = page => page.executeJavaScript(`(() => {
    const notice = document.querySelector('#legacy-delete-notice');
    return Boolean(notice && notice.hidden === ${!pending}
      && (${!pending} || notice.textContent.includes('could not be removed yet')));
  })()`, true);
  await waitFor(() => noticeMatches(settingsPage));
  const askPage = await openAskTab(chrome);
  await waitFor(() => noticeMatches(askPage));
  await waitFor(() => deletionRecord(profile).legacyDeletePending === pending);
  expect(deletionRecord(profile).legacyDeletePending === pending,
    'Deletion record matches the pending notice', deletionRecord(profile));
}

// ---------- entry ----------

if (PHASE === 'orchestrate') {
  try {
    orchestrate();
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
} else {
  ({ 'seed-residue': seedResidue, seed, main, 'seed-legacy': seedLegacy, 'fail-remove': failRemove, verify, 'pending-notice': pendingNotice, 'pending-cleared': pendingNotice }[PHASE] || main)()
    .then(() => app.quit())
    .catch(error => {
      console.error(error);
      app.exit(1);
    });
}
