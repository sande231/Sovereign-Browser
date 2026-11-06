'use strict';

// Test-only switches read from environment variables. They are ignored in packaged builds, so
// an environment variable can never change what an installed Sovereign does.
// No Electron imports, so it can be tested with plain Node.

function testHook(name, { isPackaged, env = process.env } = {}) {
  if (isPackaged !== false) {
    return '';
  }
  return String(env[name] || '');
}

module.exports = { testHook };
