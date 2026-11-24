const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Mask comments and quoted text so delimiters in page fixtures do not split handlers.
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`/g,
    match => ' '.repeat(match.length));
}

function unsafeExit(source) {
  const code = codeOnly(source);
  if (/\bprocess\s*\.\s*exitCode\s*=(?!=)/.test(code)) return true;
  for (const match of code.matchAll(/\.\s*(catch|then)\s*\(/g)) {
    const args = [];
    let start = match.index + match[0].length;
    let depth = 0;
    for (let i = start; i < code.length; i += 1) {
      const char = code[i];
      if (char === ')' && depth === 0) {
        args.push(code.slice(start, i));
        break;
      }
      if (char === ',' && depth === 0) {
        args.push(code.slice(start, i));
        start = i + 1;
      } else if ('([{'.includes(char)) depth += 1;
      else if (')]}'.includes(char)) depth -= 1;
    }
    const handler = args[match[1] === 'catch' ? 0 : 1] || '';
    const quits = /\bapp\s*\.\s*quit\s*\(/.test(handler);
    const exits = [...handler.matchAll(/\b(?:app|process)\s*\.\s*exit\s*\(\s*([+-]?(?:0[xX][\da-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d+)?))\s*\)/g)]
      .some(exit => Number(exit[1]) !== 0);
    if (quits && !exits) return true;
  }
  return false;
}

// Cover both failure callback forms, nested delimiters, and success-path isolation.
for (const source of [
  'process.exitCode = 1;',
  'main().catch(error => { app.quit(); });',
  'main().then(() => app.exit(1), error => { log({ error }); app.quit(); });',
  'main().catch(error => { app.quit(); app.exit(0); });',
  'main().catch(error => { app.quit(); process.exit(status); });'
]) assert.equal(unsafeExit(source), true, source);
for (const source of [
  'main().then(() => app.quit()).catch(error => { app.exit(1); });',
  'main().then(() => app.quit(), error => { app.quit(); process.exit(2); });',
  'main().catch(error => { app.quit(); app.exit(1); });',
  '// process.exitCode = 1;\nconst fixture = "app.quit()";'
]) assert.equal(unsafeExit(source), false, source);

const directory = path.join(__dirname, 'electron');
const files = fs.readdirSync(directory).filter(file => file.endsWith('.test.js')).sort();
assert(files.length > 0, 'No Electron suites found');
const failures = files.filter(file => unsafeExit(fs.readFileSync(path.join(directory, file), 'utf8')));
if (failures.length) {
  console.error('FAIL: unsafe Electron failure exits:');
  for (const file of failures) console.error(`  ${file}`);
  process.exitCode = 1;
} else {
  console.log(`PASS: Electron failure exit codes (${files.length} suites)`);
}
