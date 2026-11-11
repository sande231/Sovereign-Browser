const assert = require('node:assert/strict');
const { testHook } = require('../src/test-hooks.js');

const env = { SOVEREIGN_TEST_LEGACY_REMOVE: 'fail', SOVEREIGN_CHAT_DELETE_TEST_ANSWER: 'delete' };

// Development build: the hook is honoured.
assert.equal(testHook('SOVEREIGN_TEST_LEGACY_REMOVE', { isPackaged: false, env }), 'fail');
assert.equal(testHook('SOVEREIGN_CHAT_DELETE_TEST_ANSWER', { isPackaged: false, env }), 'delete');
assert.equal(testHook('UNSET', { isPackaged: false, env }), '');

// Packaged build: ignored, whatever the environment says.
assert.equal(testHook('SOVEREIGN_TEST_LEGACY_REMOVE', { isPackaged: true, env }), '');
assert.equal(testHook('SOVEREIGN_CHAT_DELETE_TEST_ANSWER', { isPackaged: true, env }), '');
// Unknown packaging state counts as packaged.
assert.equal(testHook('SOVEREIGN_TEST_LEGACY_REMOVE', { env }), '');

console.log('test-hooks tests passed');

for (const name of ['SOVEREIGN_AUDIT_PROXY', 'SOVEREIGN_TEST_NETWORK_MODE', 'SOVEREIGN_TEST_OFFLINE_LAYERS']) {
  assert.equal(testHook(name, { isPackaged: true, env: { [name]: 'value' } }), '');
  assert.equal(testHook(name, { isPackaged: false, env: { [name]: 'value' } }), 'value');
}
