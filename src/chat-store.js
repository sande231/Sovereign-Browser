'use strict';

// Saved Ask AI chats, kept in one JSON file owned by the main process.
// No Electron imports, so it can be tested with plain Node.
//
// Why a file and not localStorage: Chromium's localStorage is LevelDB, which keeps deleted
// values on disk until it compacts. Here a delete rewrites the file (atomic rename), and an
// empty list or clear() unlinks it, so deleted chats do not linger in app storage.
//
// Deletion always wins: every delete is first written to a small deletion record
// (chat-deletions.json: deleted chat ids, which are random, and whether chats saved by older
// versions in localStorage must be deleted). Nothing that runs later, such as a legacy
// localStorage scan, can bring a deleted chat back.

const fs = require('node:fs');
const path = require('node:path');

const FILE_NAME = 'saved-chats.json';
const DELETIONS_FILE_NAME = 'chat-deletions.json';
const MAX_CHATS = 50;
const MAX_MESSAGES = 40;
const MAX_CHAT_BYTES = 1024 * 1024;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

// Returns a clean copy of one chat, or null if it is not a valid chat.
function sanitizeChat(chat) {
  if (!isPlainObject(chat)) {
    return null;
  }
  const id = cleanString(chat.id, 100).trim();
  if (!id) {
    return null;
  }
  let messages;
  try {
    // JSON round trip drops functions, prototypes and anything else that is not plain data.
    messages = JSON.parse(JSON.stringify(Array.isArray(chat.messages) ? chat.messages : []));
  } catch {
    return null;
  }
  const clean = {
    id,
    title: cleanString(chat.title, 120) || 'Saved chat',
    updatedAt: cleanString(chat.updatedAt, 40) || new Date().toISOString(),
    messages: messages.filter(isPlainObject).slice(-MAX_MESSAGES)
  };
  if (Buffer.byteLength(JSON.stringify(clean), 'utf8') > MAX_CHAT_BYTES) {
    return null;
  }
  return clean;
}

function createChatStore({ directory, fileName = FILE_NAME, deletionsFileName = DELETIONS_FILE_NAME } = {}) {
  if (!directory) {
    throw new Error('createChatStore needs a directory.');
  }
  const file = path.join(directory, fileName);
  const tempFile = `${file}.tmp`;
  const deletionsFile = path.join(directory, deletionsFileName);

  function removeIfPresent(target) {
    try {
      fs.unlinkSync(target);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  // unreadable: a file exists but is not a valid chat list (for example cut short by a crash).
  // It may still hold chat text, so callers must still offer to delete it.
  function load() {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { chats: [], unreadable: false };
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return { chats: [], unreadable: true };
      }
      const chats = parsed.map(sanitizeChat).filter(Boolean);
      // An entry that is not a valid chat (no id, too large, not an object) is not listed, but
      // its text is still in the file: report it so it can be deleted.
      return { chats: chats.slice(0, MAX_CHATS), unreadable: chats.length !== parsed.length };
    } catch {
      return { chats: [], unreadable: true };
    }
  }

  function read() {
    return load().chats;
  }

  function writeAtomic(target, text) {
    fs.mkdirSync(directory, { recursive: true });
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, target);
    fs.chmodSync(target, 0o600);
  }

  function write(chats) {
    const clean = chats.slice(0, MAX_CHATS);
    if (clean.length === 0) {
      removeIfPresent(file);
      removeIfPresent(tempFile);
      return [];
    }
    writeAtomic(file, `${JSON.stringify(clean)}\n`);
    return clean;
  }

  // { deletedIds: Set, legacyDeletePending }. If the record exists but cannot be read, assume
  // legacy chats are to be deleted: when unsure, deletion wins.
  function readDeletions() {
    let raw;
    try {
      raw = fs.readFileSync(deletionsFile, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { deletedIds: new Set(), legacyDeletePending: false };
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(raw);
      const ids = Array.isArray(parsed?.deletedIds) ? parsed.deletedIds.filter(id => typeof id === 'string') : [];
      return { deletedIds: new Set(ids), legacyDeletePending: parsed?.legacyDeletePending !== false };
    } catch {
      return { deletedIds: new Set(), legacyDeletePending: true };
    }
  }

  // Written before any chat data is removed, and before any legacy scan runs.
  function recordDeletion({ ids = [], legacy } = {}) {
    const record = readDeletions();
    for (const id of ids) {
      const clean = cleanString(id, 100).trim();
      if (clean) {
        record.deletedIds.delete(clean);
        record.deletedIds.add(clean);
      }
    }
    const legacyDeletePending = legacy === undefined ? record.legacyDeletePending : Boolean(legacy);
    writeAtomic(deletionsFile, `${JSON.stringify({
      // Never capped: an id dropped from here could be imported or saved again.
      deletedIds: [...record.deletedIds],
      legacyDeletePending
    })}\n`);
  }

  function isDeleted(id) {
    return readDeletions().deletedIds.has(cleanString(id, 100).trim());
  }

  // A leftover temp file can only exist after a crash mid-write and may hold chat text.
  removeIfPresent(tempFile);
  removeIfPresent(`${deletionsFile}.tmp`);

  return {
    file,
    list: () => read(),
    count: () => read().length,
    // { count, unreadable, hasData }. hasData is true whenever a chat file is on disk, whatever
    // it holds, so deletion never depends on the file being readable.
    status() {
      const { chats, unreadable } = load();
      return { count: chats.length, unreadable, hasData: fs.existsSync(file) || fs.existsSync(tempFile) };
    },
    deletionsFile,
    isDeleted,
    // True after a bulk delete until the legacy localStorage key is confirmed gone.
    legacyDeletePending: () => readDeletions().legacyDeletePending,
    // ids: the chats that were in the legacy key when it was removed. They are recorded as
    // deleted in the same write that clears the pending flag, so they can never come back.
    legacyDeleteDone(ids = []) {
      recordDeletion({ ids, legacy: false });
    },
    // A deleted chat is never saved again (for example from a tab that still had it open).
    save(chat) {
      const clean = sanitizeChat(chat);
      if (!clean) {
        throw new Error('Chat could not be saved: it is not a valid chat or is too large.');
      }
      if (isDeleted(clean.id)) {
        return read();
      }
      return write([clean, ...read().filter(saved => saved.id !== clean.id)]);
    },
    remove(id) {
      const target = cleanString(id, 100);
      recordDeletion({ ids: [target] });
      return write(read().filter(saved => saved.id !== target));
    },
    // Deletes every saved chat. legacy: true also records that chats saved by older versions
    // in localStorage must be deleted, not imported, whenever they are found later.
    // extraIds: ids of legacy chats seen but not imported.
    clear({ legacy = false, extraIds = [] } = {}) {
      recordDeletion({ ids: [...read().map(saved => saved.id), ...extraIds], ...(legacy ? { legacy: true } : {}) });
      removeIfPresent(file);
      removeIfPresent(tempFile);
      return [];
    },
    // Moves chats from the old localStorage copy in. Existing ids win. Nothing is imported
    // while a legacy delete is pending, and deleted ids are never imported.
    importLegacy(chats) {
      const current = read();
      const deletions = readDeletions();
      if (deletions.legacyDeletePending) {
        // Blocked by a bulk delete: remember these ids, so they stay deleted after the pending
        // cleanup completes (for example a late import from a tab that read the key earlier).
        recordDeletion({ ids: legacyChatIds(chats) });
        return current;
      }
      const known = new Set(current.map(saved => saved.id));
      const incoming = (Array.isArray(chats) ? chats : [])
        .map(sanitizeChat)
        .filter(chat => chat && !deletions.deletedIds.has(chat.id) && !known.has(chat.id) && known.add(chat.id));
      if (incoming.length === 0) {
        return current;
      }
      return write([...current, ...incoming]);
    }
  };
}

// Ids of the entries in a legacy chat list (entries without an id cannot be imported anyway).
function legacyChatIds(chats) {
  return (Array.isArray(chats) ? chats : [])
    .map(chat => (isPlainObject(chat) ? cleanString(chat.id, 100).trim() : ''))
    .filter(Boolean);
}

function parseLegacyChats(text) {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

module.exports = {
  DELETIONS_FILE_NAME,
  FILE_NAME,
  MAX_CHATS,
  MAX_MESSAGES,
  MAX_CHAT_BYTES,
  createChatStore,
  legacyChatIds,
  parseLegacyChats,
  sanitizeChat
};
