const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const vm = require('node:vm');
const { once } = require('node:events');
const { createNetworkMode } = require('../src/network-mode');
const { safeFetch } = require('../src/safe-fetch');

const source = fs.readFileSync(require.resolve('../src/main'), 'utf8');
// Same top-level body extraction as network-exits: execute production gates, not copies.
function body(name) {
  let start = source.indexOf(`function ${name}(`);
  assert(start >= 0, name);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  const end = source.indexOf('\n}', start);
  assert(end > start, `Missing end of ${name}`);
  return source.slice(start, end + 2);
}

async function main() {
  let connections = 0;
  let resolverCalls = 0;
  const sockets = new Set();
  const server = net.createServer(socket => {
    connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'));
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const host = 'offline-gate.test';
    const url = `http://${host}:${server.address().port}/`;
    const networkMode = createNetworkMode({ initial: 'offline' });
    const context = vm.createContext({
      networkMode,
      safeFetch,
      app: { isPackaged: false },
      isIP: net.isIP,
      testCa: undefined,
      // Public validation address plus a loopback-only connection override: no real DNS.
      testDns: {
        get [host]() {
          resolverCalls++;
          return { address: '93.184.216.34', connect: '127.0.0.1' };
        }
      },
      dns: { lookup() { resolverCalls++; throw new Error('Unexpected OS DNS lookup'); } }
    });
    vm.runInContext(`${body('safeFetchResolve')}\n${body('gatedSafeFetch')}`, context);

    await assert.rejects(() => context.safeFetchResolve(host, { all: true }), {
      code: 'OFFLINE_MODE', purpose: 'dns lookup'
    });
    assert.equal(resolverCalls, 0);
    assert.equal(connections, 0);
    await assert.rejects(() => context.gatedSafeFetch(url), {
      code: 'OFFLINE_MODE', purpose: 'page or media fetch'
    });
    assert.equal(resolverCalls, 0);
    assert.equal(connections, 0);

    networkMode.set('online');
    const { response } = await context.gatedSafeFetch(url, { timeoutMs: 2000 });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ok');
    assert.equal(resolverCalls, 1, 'Online must exercise the resolver');
    assert.equal(connections, 1, 'Online must reach the real TCP server');
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  console.log('offline-gate integration tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
