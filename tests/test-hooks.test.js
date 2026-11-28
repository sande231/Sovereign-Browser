const assert = require('node:assert/strict');
const { testHook, auditHook, TEST_SWITCHES, ignoredTestSwitches } = require('../src/test-hooks.js');

const env = { SOVEREIGN_TEST_LEGACY_REMOVE: 'fail', SOVEREIGN_CHAT_DELETE_TEST_ANSWER: 'delete' };

// Missing entry: development hooks are ignored.
assert.equal(testHook('SOVEREIGN_TEST_LEGACY_REMOVE', { isPackaged: false, env }), '');
assert.equal(testHook('SOVEREIGN_CHAT_DELETE_TEST_ANSWER', { isPackaged: false, env }), '');
assert.equal(testHook('UNSET', { isPackaged: false, env }), '');

// Packaged build: ignored, whatever the environment says.
assert.equal(testHook('SOVEREIGN_TEST_LEGACY_REMOVE', { isPackaged: true, env }), '');
assert.equal(testHook('SOVEREIGN_CHAT_DELETE_TEST_ANSWER', { isPackaged: true, env }), '');
// Unknown packaging state counts as packaged.
assert.equal(testHook('SOVEREIGN_TEST_LEGACY_REMOVE', { env }), '');

console.log('test-hooks tests passed');

for (const name of ['SOVEREIGN_AUDIT_PROXY', 'SOVEREIGN_TEST_NETWORK_MODE', 'SOVEREIGN_TEST_OFFLINE_LAYERS']) {
  assert.equal(testHook(name, { isPackaged: true, env: { [name]: 'value' } }), '');
  assert.equal(testHook(name, { isPackaged: false, env: { [name]: 'value' } }), '');
}

const path = require('node:path');
const fs = require('node:fs');
const appRoot = path.resolve(__dirname, '..');
const names = ['SOVEREIGN_TEST_DNS', 'SOVEREIGN_TEST_CA_FILE', 'SOVEREIGN_TEST_NETWORK_MODE', 'SOVEREIGN_TEST_OFFLINE_LAYERS', 'SOVEREIGN_CHAT_DELETE_TEST_ANSWER', 'SOVEREIGN_TEST_LEGACY_REMOVE', 'SOVEREIGN_PERMISSION_TEST_ANSWER', 'SOVEREIGN_MEDIA_TEST_FIXTURES', 'SOVEREIGN_TEST_DOWNLOAD_DIR', 'SOVEREIGN_TEST_SAVE_DIALOG_DIR', 'SOVEREIGN_TEST_CONTEXT_MENU_ACTION'];
assert.deepEqual([...TEST_SWITCHES].sort(), [...names].sort());
for (const entry of ['src/main.js', 'tests/electron-evil/x.js', 'tests/electron/../../src/main.js', '../outside/x.js', undefined, 'tests/electron/x.test.js']) {
  const resolved = entry === undefined ? undefined : path.resolve(appRoot, entry);
  for (const isPackaged of [false, true]) {
    assert.equal(testHook(names[0], { isPackaged, entry: resolved, appRoot, env: { [names[0]]: 'value' } }), !isPackaged && entry === 'tests/electron/x.test.js' ? 'value' : '', String(entry));
  }
}
for (const isPackaged of [false, true]) assert.equal(auditHook('SOVEREIGN_AUDIT_PROXY', { isPackaged, env: { SOVEREIGN_AUDIT_PROXY: 'proxy' } }), isPackaged ? '' : 'proxy');
const switches = Object.fromEntries(names.map(name => [name, 'value']));
assert.deepEqual([...ignoredTestSwitches(switches, false)].sort(), [...names].sort());
assert.deepEqual(ignoredTestSwitches(switches, true), []);
assert.deepEqual(ignoredTestSwitches({ [names[0]]: '', OTHER: 'value' }, false), []);
const features = ['SOVEREIGN_USER_DATA_DIR', 'SOVEREIGN_DATASET_BATCH', 'SOVEREIGN_DATASET_OUT', 'SOVEREIGN_DATASET_DELAY_MS'];
function scan(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) scan(file);
    else if (file.endsWith('.js') && file !== path.join(appRoot, 'src/test-hooks.js')) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(/process\.env\.(SOVEREIGN_\w+)/g)) assert(features.includes(match[1]), `${file}: ungated ${match[1]}`);
    }
  }
}
scan(path.join(appRoot, 'src'));
assert(!/testHook\(\s*['"]SOVEREIGN_AUDIT_PROXY['"]/.test(fs.readFileSync(path.join(appRoot, 'src/main.js'), 'utf8')));

// Electron's app path must resolve to the exact suite folder; no entry needed.
for (const relativePath of ['tests/electron', '.', 'tests/electron-evil', 'tests/electron/sub', 'tests/electron/..', undefined]) {
  const appPath = relativePath === undefined ? undefined : appRoot + path.sep + relativePath;
  for (const isPackaged of [false, true]) {
    assert.equal(testHook(names[0], { isPackaged, appPath, appRoot, env: { [names[0]]: 'value' } }),
      !isPackaged && relativePath === 'tests/electron' ? 'value' : '', String(relativePath));
  }
}
