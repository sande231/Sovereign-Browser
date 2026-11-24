'use strict';

// Test-only switches read from environment variables. They are ignored in packaged builds.
// Sovereign has no packaged build yet: under `npm start` (unpackaged) a switch that is set is
// honoured, so a leftover environment variable can change a normal run. A stricter gate is
// planned (docs/HANDOFF.md, Task 2c PLAN §16; Task 2d).
// No Electron imports, so it can be tested with plain Node.

function testHook(name, { isPackaged, env = process.env } = {}) {
  if (isPackaged !== false) {
    return '';
  }
  return String(env[name] || '');
}

module.exports = { testHook };
