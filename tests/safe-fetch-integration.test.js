const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { safeFetch } = require('../src/safe-fetch');
const { readSourcePages } = require('../src/source-reader');
const resolve = async host => {
  assert(['public.test', 'public2.test', 'public-tls.test'].includes(host));
  return [{ address: '93.184.216.34', family: 4, connect: '127.0.0.1' }];
};
const listen = server => new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', () => yes(server)); });
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-fetch-'));
  let secret = 0, tls;
  const server = http.createServer((req, res) => {
    if (req.url === '/secret') { secret++; res.end('secret'); }
    else if (req.url === '/public') { res.writeHead(302, { location: `http://public2.test:${server.address().port}/final` }); res.end(); }
    else if (req.url === '/final') { res.end('public destination'); }
    else if (req.url === '/private') { res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/secret` }); res.end(); }
    else if (req.url.startsWith('/chain/')) { res.writeHead(302, { location: `/chain/${Number(req.url.split('/').pop()) + 1}` }); res.end(); }
    else { res.writeHead(301, { location: `https://public-tls.test:${tls.address().port}/page` }); res.end(); }
  });
  try {
    await listen(server);
    const origin = `http://public.test:${server.address().port}`;
    const publicResult = await safeFetch(`${origin}/public`, { resolve });
    assert.equal(await publicResult.response.text(), 'public destination');
    assert.equal(publicResult.chain.length, 2);
    await assert.rejects(safeFetch(`${origin}/private`, { resolve }), /private-network/);
    assert.equal(secret, 0);
    await assert.rejects(safeFetch(`${origin}/chain/0`, { resolve }), /Stopped after 5 redirects/);
    const cert = path.join(dir, 'cert.pem'), key = path.join(dir, 'key.pem');
    const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=public-tls.test', '-addext', 'subjectAltName=DNS:public-tls.test', '-days', '1', '-keyout', key, '-out', cert], { encoding: 'utf8' });
    if (generated.error?.code === 'ENOENT') console.log('SKIP https cases: openssl not found');
    else {
      assert.equal(generated.status, 0, generated.stderr);
      const ca = fs.readFileSync(cert);
      tls = https.createServer({ key: fs.readFileSync(key), cert: ca }, (req, res) => {
        if (req.url === '/down') { res.writeHead(302, { location: `${origin}/page` }); res.end(); }
        else { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<html><title>Redirect history</title><article><p>${'HTTP redirect history explains how web pages move between addresses and preserve useful source information. '.repeat(12)}</p></article></html>`); }
      });
      await listen(tls);
      await assert.rejects(safeFetch(`https://public-tls.test:${tls.address().port}/down`, { resolve, ca }), /HTTPS to HTTP/);
      const result = await readSourcePages({ question: 'HTTP redirect history', results: [{ url: `${origin}/page`, title: 'Redirect history', snippet: 'Fallback' }], fetchImpl: (url, options) => safeFetch(url, { ...options, resolve, ca }) });
      assert.equal(result.sources[0].evidenceMode, 'page');
      assert.match(result.sources[0].evidenceText, /web pages move between addresses/);
    }
    console.log('safe-fetch real socket tests passed');
  } finally {
    server.closeAllConnections(); await new Promise(done => server.close(done));
    if (tls) { tls.closeAllConnections(); await new Promise(done => tls.close(done)); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
