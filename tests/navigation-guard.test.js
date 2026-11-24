const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { lockNavigation } = require('../src/navigation-guard.js');

function fakeContents() {
  const handlers = new Map();
  const opens = [];
  return {
    handlers, opens,
    on(name, handler) {
      const list = handlers.get(name) || [];
      list.push(handler);
      handlers.set(name, list);
    },
    setWindowOpenHandler(handler) { opens.push(handler); }
  };
}
for (const contents of [fakeContents(), fakeContents()]) {
  lockNavigation(contents);
  lockNavigation(contents);
  assert.equal(contents.handlers.get('will-navigate')?.length, 1);
  assert.equal(contents.handlers.get('will-frame-navigate')?.length, 1);
  assert.equal(contents.opens.length, 1);
  assert.deepEqual(contents.opens[0]({ url: 'https://example.invalid' }), { action: 'deny' });
  for (const [name, isMainFrame, expected] of [
    ['will-navigate', true, 1],
    ['will-frame-navigate', false, 1],
    ['will-frame-navigate', true, 0]
  ]) {
    let prevented = 0;
    contents.handlers.get(name)[0]({ isMainFrame, preventDefault() { prevented++; } });
    assert.equal(prevented, expected, `${name}, isMainFrame=${isMainFrame}`);
  }
}

const read = file => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');
const main = read('main.js');
// Preserve offsets while blanking comments; keep strings because regex literals make string masking unreliable.
const code = main.replace(/\/\*[\s\S]*?\*\/|^[ \t]*\/\/[^\n]*/gm, value => value.replace(/[^\n]/g, ' '));
// main.js uses top-level named function declarations with unindented closing braces.
const functions = [...code.matchAll(/^(?:async\s+)?function\s+(\w+)\s*\([^\n]*\)\s*\{/gm)].map(match => {
  const end = code.indexOf('\n}', match.index + match[0].length);
  assert(end >= 0, `Missing function end: ${match[1]}`);
  return { name: match[1], start: match.index, end: end + 2 };
});
const constructors = [...code.matchAll(/\bnew\s+(?:WebContentsView|BrowserWindow)\s*\(/g)];
assert(constructors.length >= 7, 'Expected all existing view/window constructors');
for (const match of constructors) {
  const owner = functions.find(fn => fn.start <= match.index && match.index < fn.end);
  assert(owner, `Constructor outside an audited named function at offset ${match.index}`);
  if (owner.name === 'createWebView') continue; // Reviewed web-tab exception: normalizeAddress.
  const assignment = code.slice(owner.start, match.index).match(/([\w]+(?:\.[\w]+)*)\s*=\s*$/);
  assert(assignment, `Cannot identify constructed object in ${owner.name}`);
  const object = assignment[1].replace(/\./g, '\\.');
  const remainder = code.slice(match.index + match[0].length, owner.end);
  assert(new RegExp(`\\blockNavigation\\s*\\(\\s*${object}\\.webContents\\s*\\)`).test(remainder),
    `${owner.name}: ${assignment[1]}.webContents must use lockNavigation in the same function`);
}
const internal = functions.find(fn => fn.name === 'attachInternalTabEvents');
// Locate the existing internal-tab event function by its title update if renamed.
const internalOwner = internal || functions.find(fn => main.slice(fn.start, fn.end).includes('tab.title = internalTabTitle(tab.kind)'));
assert(internalOwner, 'Internal-tab event setup must be audited');
const internalSource = main.slice(internalOwner.start, internalOwner.end);
assert(!/\bwc\.on\(\s*['"]will-navigate['"]/.test(internalSource), 'Remove the internal-tab bespoke navigation handler');
assert(!/\bwc\.setWindowOpenHandler\s*\(/.test(internalSource), 'Remove the internal-tab bespoke deny handler');

assert(fs.existsSync(path.join(__dirname, '../src/drop-guard.js')), 'drop-guard.js must exist');
for (const file of ['index.html', 'sidebar.html', 'model-setup.html']) {
  const scripts = [...read(file).matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/g)];
  assert.equal(scripts[0]?.[1], './drop-guard.js', `${file}: drop guard must precede other app scripts`);
}
const handlers = new Map();
class Element {
  constructor(editable = null) { this.editable = editable; }
  closest(selector) {
    // Use the selector supplied by the implementation, rather than treating all selectors as matches.
    if (!this.editable) return null;
    const matches = selector.split(',').some(part => {
      const s = part.trim();
      if (this.editable === 'input') return s === 'input' || /^input\[type\s*=\s*["']?text["']?\]$/.test(s);
      if (this.editable === 'textarea') return s === 'textarea';
      return s === '[contenteditable]' || s === '[contenteditable="true"]' || s === "[contenteditable='true']";
    });
    return matches ? this : null;
  }
}
vm.runInNewContext(read('drop-guard.js'), {
  Element,
  document: { addEventListener(name, handler) {
    const list = handlers.get(name) || [];
    list.push(handler);
    handlers.set(name, list);
  } }
}, { filename: 'drop-guard.js' });
for (const name of ['dragover', 'drop']) {
  assert.equal(handlers.get(name)?.length, 1, `${name} listener`);
  for (const editable of [null, 'input', 'textarea', 'contenteditable']) {
    for (const descendant of [false, true]) {
      const element = new Element(editable);
      const target = descendant ? new Element() : element;
      if (descendant) target.closest = selector => element.closest(selector);
      let prevented = 0;
      handlers.get(name)[0]({ target, preventDefault() { prevented++; } });
      assert.equal(prevented, editable ? 0 : 1, `${name}: ${editable || 'plain'}; descendant=${descendant}`);
    }
  }
}
console.log('PASS: navigation guards, constructor coverage, and editable drop exemptions');
