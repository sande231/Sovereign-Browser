const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChatStore, legacyChatIds, parseLegacyChats, DELETIONS_FILE_NAME, MAX_CHATS, MAX_MESSAGES, MAX_CHAT_BYTES } = require('../src/chat-store.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-chat-store-'));
}

// Every byte of every file in the directory, so a test can prove text is gone from all of them.
function allBytes(directory) {
  return fs.readdirSync(directory)
    .map(name => fs.readFileSync(path.join(directory, name), 'utf8'))
    .join('\n');
}

// Chat data files in the folder. The deletion record (random chat ids only) is checked by
// allBytes, which must never contain chat text.
function chatFiles(directory) {
  return fs.readdirSync(directory).filter(name => name !== DELETIONS_FILE_NAME);
}

function chat(id, marker, extra = {}) {
  return {
    id,
    title: `Question ${marker}`,
    updatedAt: '2026-11-06T10:00:00.000Z',
    messages: [
      { id: `${id}-u`, role: 'user', content: `user text ${marker}` },
      { id: `${id}-a`, role: 'assistant', content: `answer text ${marker}`, sources: [{ url: 'https://example.com' }] }
    ],
    ...extra
  };
}

// Save, single delete, delete of the last chat.
{
  const dir = tempDir();
  const store = createChatStore({ directory: dir });
  assert.deepEqual(store.list(), []);
  assert.equal(fs.existsSync(store.file), false, 'no file until something is saved');

  store.save(chat('a', 'MARKER-ALPHA'));
  store.save(chat('b', 'MARKER-BRAVO'));
  assert.equal(fs.existsSync(store.file), true);
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600, 'file is readable by the user only');
  assert.deepEqual(store.list().map(item => item.id), ['b', 'a'], 'newest first');
  assert.equal(store.count(), 2);
  assert.match(allBytes(dir), /MARKER-ALPHA/);

  store.save(chat('a', 'MARKER-ALPHA-EDITED'));
  assert.deepEqual(store.list().map(item => item.id), ['a', 'b'], 're-saving moves a chat to the top, no duplicate');

  const afterDelete = store.remove('a');
  assert.deepEqual(afterDelete.map(item => item.id), ['b']);
  assert.doesNotMatch(allBytes(dir), /MARKER-ALPHA/, 'a deleted chat is gone from every file in the folder');
  assert.match(allBytes(dir), /MARKER-BRAVO/, 'the other chat stays');
  assert.deepEqual(chatFiles(dir), ['saved-chats.json'], 'no temp or backup file is left behind');

  store.remove('b');
  assert.deepEqual(chatFiles(dir), [], 'deleting the last chat removes the file');
  assert.deepEqual(store.list(), []);
}

// clear() removes the file and any temp file; a stale temp file is removed on open.
{
  const dir = tempDir();
  const store = createChatStore({ directory: dir });
  store.save(chat('a', 'MARKER-CHARLIE'));
  store.save(chat('b', 'MARKER-DELTA'));
  fs.writeFileSync(`${store.file}.tmp`, 'partial MARKER-ECHO');
  assert.deepEqual(store.clear(), []);
  assert.deepEqual(chatFiles(dir), [], 'clear leaves no saved-chats files at all');

  fs.writeFileSync(path.join(dir, 'saved-chats.json.tmp'), 'crash leftover MARKER-FOXTROT');
  const reopened = createChatStore({ directory: dir });
  assert.deepEqual(chatFiles(dir), [], 'opening the store removes a temp file left by a crash');
  assert.deepEqual(reopened.list(), []);
  assert.deepEqual(reopened.clear(), [], 'clear on an empty store is fine');
}

// A new store instance reads what an earlier one wrote (survives a restart).
{
  const dir = tempDir();
  createChatStore({ directory: dir }).save(chat('a', 'MARKER-GOLF'));
  assert.deepEqual(createChatStore({ directory: dir }).list().map(item => item.id), ['a']);
}

// Validation and limits.
{
  const dir = tempDir();
  const store = createChatStore({ directory: dir });
  assert.throws(() => store.save(null));
  assert.throws(() => store.save({ title: 'no id' }));
  assert.throws(() => store.save({ id: 42 }));
  assert.throws(() => store.save(chat('huge', 'x', { messages: [{ role: 'user', content: 'x'.repeat(MAX_CHAT_BYTES) }] })));
  assert.equal(fs.existsSync(store.file), false, 'rejected chats write nothing');

  const many = chat('many', 'MANY', {
    messages: [...Array.from({ length: MAX_MESSAGES + 5 }, (_, index) => ({ role: 'user', content: `m${index}` })), 'junk', null, [1]]
  });
  const saved = store.save(many)[0];
  assert.equal(saved.messages.length, MAX_MESSAGES);
  assert.ok(saved.messages.every(message => typeof message === 'object' && !Array.isArray(message)));
  assert.equal(saved.title.length <= 120, true);

  for (let index = 0; index < MAX_CHATS + 5; index += 1) {
    store.save(chat(`c${index}`, `C${index}`));
  }
  assert.equal(store.count(), MAX_CHATS);
  assert.equal(store.list()[0].id, `c${MAX_CHATS + 4}`);

  fs.writeFileSync(store.file, '[{"id":"x","title":"MARKER-TRUNCATED');
  assert.deepEqual(store.list(), [], 'a corrupt file reads as empty instead of throwing');
  assert.deepEqual(store.status(), { count: 0, unreadable: true, hasData: true }, 'a corrupt file is reported, so it can still be deleted');
  store.clear();
  assert.deepEqual(chatFiles(dir), []);
  assert.deepEqual(store.status(), { count: 0, unreadable: false, hasData: false });
  fs.writeFileSync(store.file, '{"not":"a list","text":"MARKER-OBJECT"}');
  assert.equal(store.status().unreadable, true, 'valid JSON that is not a list is unreadable too');
  store.save(chat('fresh', 'FRESH'));
  assert.doesNotMatch(allBytes(dir), /MARKER-OBJECT/, 'saving over an unreadable file replaces it');
  store.clear();
}

// REVIEW round 3, item 2: entries that are not valid chats are still stored text. They make the
// file unreadable (so it is offered for deletion), and an empty list file still counts as data.
{
  const dir = tempDir();
  const store = createChatStore({ directory: dir });
  fs.writeFileSync(store.file, '[{"title":"MARKER-INVALID-CHAT","messages":[{"role":"user","content":"MARKER-INVALID-CHAT"}]}]');
  assert.deepEqual(store.status(), { count: 0, unreadable: true, hasData: true });
  store.clear();
  assert.deepEqual(chatFiles(dir), []);

  fs.writeFileSync(store.file, JSON.stringify([chat('ok', 'VALID'), { id: '   ', title: 'MARKER-BAD-MESSAGES' }, 'MARKER-STRING-ENTRY']));
  assert.deepEqual(store.status(), { count: 1, unreadable: true, hasData: true }, 'one valid chat, the rest unreadable');
  store.remove('missing');
  assert.doesNotMatch(allBytes(dir), /MARKER-STRING-ENTRY|MARKER-BAD-MESSAGES/, 'any rewrite drops invalid entries from disk');
  assert.deepEqual(store.status(), { count: 1, unreadable: false, hasData: true });
  store.clear();

  fs.writeFileSync(store.file, '[]');
  assert.deepEqual(store.status(), { count: 0, unreadable: false, hasData: true }, 'any file on disk can be deleted');
  store.clear();
  assert.deepEqual(store.status(), { count: 0, unreadable: false, hasData: false });
}

// Deletion always wins: deletes are recorded before data is removed, and nothing found later
// (a legacy scan, a stale tab) brings a deleted chat back.
{
  const dir = tempDir();
  const store = createChatStore({ directory: dir });
  store.save(chat('keep', 'KEEP'));
  store.save(chat('gone', 'MARKER-GONE'));
  store.remove('gone');
  assert.equal(store.isDeleted('gone'), true);
  assert.deepEqual(store.save(chat('gone', 'MARKER-GONE-AGAIN')).map(item => item.id), ['keep'], 'a deleted id is not saved again');
  assert.deepEqual(store.importLegacy([chat('gone', 'MARKER-GONE-LEGACY'), chat('new', 'NEW')]).map(item => item.id), ['keep', 'new'],
    'a later legacy scan never restores a deleted id');
  assert.doesNotMatch(allBytes(dir), /MARKER-GONE/, 'the deletion record holds ids, not chat text');
  assert.equal(fs.statSync(store.deletionsFile).mode & 0o777, 0o600);

  // Bulk delete with legacy: true: every legacy chat found afterwards is deleted, not imported,
  // until the legacy key is confirmed gone. A failed scan leaves this pending.
  assert.equal(store.legacyDeletePending(), false);
  store.clear({ legacy: true, extraIds: ['legacy-seen'] });
  assert.equal(store.legacyDeletePending(), true);
  assert.equal(store.isDeleted('keep') && store.isDeleted('new') && store.isDeleted('legacy-seen'), true);
  assert.deepEqual(store.importLegacy([chat('legacy-unseen', 'MARKER-LEGACY-LATER')]), [], 'pending legacy delete: nothing imported');
  assert.deepEqual(chatFiles(dir), []);
  const restarted = createChatStore({ directory: dir });
  assert.equal(restarted.legacyDeletePending(), true, 'the pending legacy delete survives a restart');
  assert.deepEqual(restarted.importLegacy([chat('legacy-unseen', 'MARKER-LEGACY-LATER')]), []);
  restarted.legacyDeleteDone();
  assert.equal(restarted.legacyDeletePending(), false);
  assert.equal(restarted.isDeleted('legacy-seen'), true, 'ids stay deleted after the legacy key is gone');
  assert.deepEqual(restarted.importLegacy([chat('legacy-seen', 'X'), chat('later', 'LATER')]).map(item => item.id), ['later']);

  // An unreadable deletion record is treated as "delete legacy chats".
  fs.writeFileSync(store.deletionsFile, '{broken');
  assert.equal(store.legacyDeletePending(), true);
  assert.deepEqual(store.importLegacy([chat('x', 'X')]).map(item => item.id), ['later']);
}

// REVIEW round 4, item 2a: deleted ids never expire. More than 2,000 deletions (the old cap),
// then a restart: the first deleted id still cannot be saved or imported again.
{
  const dir = tempDir();
  const store = createChatStore({ directory: dir });
  store.save(chat('first-deleted', 'FIRST'));
  store.remove('first-deleted');
  for (let index = 0; index < 2100; index += 1) {
    store.remove(`other-${index}`);
  }
  const reopened = createChatStore({ directory: dir });
  assert.equal(reopened.isDeleted('first-deleted'), true, 'the first deleted id survives 2,100 later deletions and a restart');
  assert.equal(reopened.isDeleted('other-2099'), true);
  assert.deepEqual(reopened.importLegacy([chat('first-deleted', 'FIRST-AGAIN')]), [], 'not re-imported');
  assert.deepEqual(reopened.save(chat('first-deleted', 'FIRST-AGAIN')), [], 'not saved again by a stale tab');
  assert.deepEqual(chatFiles(dir), []);
}

// REVIEW round 4, item 2b: ids are never dropped when the pending cleanup completes.
// The peek failed, so the bulk delete could not see the legacy ids. A tab's late import is
// blocked while pending, cleanup then completes, and after a restart the same chat (from a
// second tab, or an old copy) must still be refused.
{
  const dir = tempDir();
  const store = createChatStore({ directory: dir });
  store.clear({ legacy: true });
  assert.deepEqual(store.importLegacy([chat('unseen', 'UNSEEN')]), [], 'blocked while pending');
  store.legacyDeleteDone(['seen-at-removal']);
  assert.equal(store.legacyDeletePending(), false);
  const reopened = createChatStore({ directory: dir });
  assert.deepEqual(reopened.importLegacy([chat('unseen', 'UNSEEN'), chat('seen-at-removal', 'SEEN')]), [],
    'ids blocked while pending, and ids seen when the key was removed, stay deleted');
  assert.deepEqual(reopened.importLegacy([chat('after', 'AFTER')]).map(item => item.id), ['after'], 'a genuinely new legacy chat can still be imported');
}

assert.deepEqual(legacyChatIds([{ id: ' a ' }, { title: 'no id' }, 'junk', null, { id: 7 }]), ['a']);
assert.deepEqual(legacyChatIds('not a list'), []);

assert.deepEqual(parseLegacyChats('[{"id":"a"}]'), [{ id: 'a' }]);
assert.deepEqual(parseLegacyChats('not json'), []);
assert.deepEqual(parseLegacyChats('{"a":1}'), []);

// Legacy import from localStorage keeps existing chats and skips duplicates.
{
  const dir = tempDir();
  const store = createChatStore({ directory: dir });
  store.save(chat('a', 'CURRENT'));
  const result = store.importLegacy([chat('a', 'OLD-COPY'), chat('b', 'LEGACY-B'), chat('b', 'LEGACY-B2'), 'junk', { no: 'id' }]);
  assert.deepEqual(result.map(item => item.id), ['a', 'b']);
  assert.equal(result[0].title, 'Question CURRENT', 'existing chat wins over the legacy copy');
  assert.equal(result[1].title, 'Question LEGACY-B');
  assert.deepEqual(store.importLegacy('not an array').map(item => item.id), ['a', 'b']);

  const empty = createChatStore({ directory: tempDir() });
  assert.deepEqual(empty.importLegacy([]), []);
  assert.equal(fs.existsSync(empty.file), false, 'importing nothing creates no file');
}

assert.throws(() => createChatStore({}), /directory/);

console.log('chat-store tests passed');
