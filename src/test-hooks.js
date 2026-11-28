'use strict';

// Test switches are honoured only when unpackaged AND Electron's app path (the
// folder Electron was started with) is tests/electron, or the entry is a suite
// in tests/electron/. Under npm start they are ignored and reported.
// SOVEREIGN_AUDIT_PROXY is honoured unpackaged and shown as a warning.
// No Electron imports, so this can be tested with plain Node.
const path = require('node:path');

const TEST_SWITCHES = [
  'SOVEREIGN_TEST_DNS', 'SOVEREIGN_TEST_CA_FILE',
  'SOVEREIGN_TEST_NETWORK_MODE', 'SOVEREIGN_TEST_OFFLINE_LAYERS',
  'SOVEREIGN_CHAT_DELETE_TEST_ANSWER', 'SOVEREIGN_TEST_LEGACY_REMOVE',
  'SOVEREIGN_PERMISSION_TEST_ANSWER', 'SOVEREIGN_MEDIA_TEST_FIXTURES',
  'SOVEREIGN_TEST_DOWNLOAD_DIR', 'SOVEREIGN_TEST_SAVE_DIALOG_DIR',
  'SOVEREIGN_TEST_CONTEXT_MENU_ACTION'
];

function testHook(name, { isPackaged, entry, appPath, appRoot, env = process.env } = {}) {
  if (isPackaged !== false || typeof appRoot !== 'string' ||
      !((typeof appPath === 'string' && path.resolve(appPath) === path.join(path.resolve(appRoot), 'tests', 'electron')) ||
        (typeof entry === 'string' && path.resolve(entry).startsWith(path.join(path.resolve(appRoot), 'tests', 'electron') + path.sep)))) {
    return '';
  }
  return String(env[name] || '');
}

function auditHook(name, { isPackaged, env = process.env } = {}) {
  return isPackaged === false ? String(env[name] || '') : '';
}

function ignoredTestSwitches(env, gateOpen) {
  return gateOpen ? [] : TEST_SWITCHES.filter(name => Boolean(env[name]));
}

module.exports = { testHook, auditHook, TEST_SWITCHES, ignoredTestSwitches };
