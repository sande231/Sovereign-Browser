const assert = require('node:assert/strict');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { checkSender } = require('../src/ipc-policy.js');
const indexUrl = pathToFileURL(path.resolve(__dirname, '../src/index.html')).href;
const chrome = { role: 'chrome', url: indexUrl, isMainFrame: true };
const settings = { role: 'tab', tabKind: 'settings', url: 'sovereign://settings/', isMainFrame: true };
const setup = { role: 'setup', url: 'sovereign://ask/model-setup.html', isMainFrame: true };
for (const [sender, policy, expected] of [
  [chrome, {}, true], [settings, {}, true], [setup, {}, true],
  [{ role: 'sidebar', url: 'sovereign://ask/sidebar.html', isMainFrame: true }, {}, true],
  [{ ...chrome, isMainFrame: false }, {}, false],
  [{ ...chrome, url: 'http://127.0.0.1/x' }, {}, false],
  [{ ...chrome, url: 'file:///tmp/index.html' }, {}, false],
  [{ ...chrome, role: 'unknown' }, {}, false],
  [{ ...settings, tabKind: 'web' }, {}, false],
  [settings, { tabKinds: ['settings'] }, true],
  [{ ...settings, tabKind: 'ask', url: 'sovereign://ask/' }, { tabKinds: ['settings'] }, false],
  [chrome, { tabKinds: ['settings'] }, false],
  [setup, { roles: ['setup'] }, true], [chrome, { roles: ['setup'] }, false]
]) {
  const result = checkSender(sender, policy, { indexUrl });
  assert.equal(result.ok, expected, JSON.stringify({ sender, policy }));
  assert('reason' in result);
}
const source = fs.readFileSync(path.resolve(__dirname, '../src/main.js'), 'utf8');
// Any future exception requires review.
const allowList = [];
// Mask strings and comments while preserving offsets and brace structure.
const masked = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`/g, m => ' '.repeat(m.length));
const ranges = [];
for (const match of masked.matchAll(/function\s+(handleTrusted|onTrusted)\s*\([^)]*\)\s*\{/g)) {
  let depth = 1, end = match.index + match[0].length;
  for (; end < masked.length && depth; end++) { if (masked[end] === '{') depth++; if (masked[end] === '}') depth--; }
  ranges.push([match.index, end]);
}
for (const match of masked.matchAll(/ipcMain\s*\.\s*(handle|on)\s*\(/g)) {
  assert(ranges.some(([start, end]) => match.index >= start && match.index < end) || allowList.includes(match.index), `Unwrapped IPC at ${match.index}`);
}
for (const channel of ['network:add-allowed', 'network:remove-allowed', 'privacy:update-settings']) {
  const pattern = new RegExp("handleTrusted\\(\\s*['\"]" + channel + "['\"]\\s*,\\s*\\{[^}]*tabKinds\\s*:\\s*\\[\\s*['\"]settings['\"]\\s*\\]");
  assert(pattern.test(source), `${channel}: Settings policy required`);
}
console.log('ipc-policy tests passed');
