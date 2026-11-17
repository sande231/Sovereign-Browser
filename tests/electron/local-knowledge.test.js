// All servers bind to 127.0.0.1; failures expose case ids only.
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  http = require('node:http');
const {
  app,
  webContents
} = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-knowledge-'));
process.env.SOVEREIGN_USER_DATA_DIR = profile;
let activeCase = 'a-start',
  counts = {
    kiwix: 0,
    searx: 0,
    external: 0
  },
  origin = '',
  externalOrigin = '',
  down = false,
  readWithheld = false,
  patterns = [],
  articleReads = [];
const check = (id, ok) => {
  activeCase = id;
  if (!ok) throw Error(id);
};
const delay = ms => new Promise(r => setTimeout(r, ms));
const wait = async (id, fn) => {
  activeCase = id;
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await delay(50);
  }
  throw Error(id);
};
const listen = s => new Promise((r, j) => {
  s.once('error', j);
  s.listen(0, '127.0.0.1', () => r(s.address().port));
});
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
const external = http.createServer((req, res) => {
  counts.external++;
  res.end('external');
});
const searx = http.createServer((req, res) => {
  counts.searx++;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    results: [{
      title: 'Web Earth',
      url: externalOrigin.replace('127.0.0.1', 'knowledge-external.test') + '/earth',
      content: 'Earth is a planet.'
    }]
  }));
});
const kiwix = http.createServer((req, res) => {
  counts.kiwix++;
  if (down) {
    req.socket.destroy();
    return;
  }
  const u = new URL(req.url, origin);
  if (u.pathname === '/search') {
    patterns.push(u.searchParams.get('pattern'));
    const withheld = u.searchParams.get('pattern') === 'history of medicine';
    res.setHeader('content-type', 'application/xml');
    res.end('<rss version="2.0"><channel>' + [0, 1, 2].map(i => '<item><title>' + (withheld && i === 0 ? 'Suicide methods' : 'Earth ' + i) + '</title><link>/content/wiki/' + (withheld && i === 0 ? 'withheld' : 'Earth' + i) + '</link><description>Earth is a planet in the solar system.</description><book><title>Wikipedia</title></book><wordCount>1000</wordCount></item>').join('') + '</channel></rss>');
  } else if (u.pathname === '/catalog/v2/entries') {
    res.setHeader('content-type', 'application/xml');
    res.end('<feed>' + ['wiki', 'travel'].map(n => '<entry><id>' + n + '</id><name>' + n + '</name><title>' + n + '</title><tags>_ftindex:yes</tags></entry>').join('') + '</feed>');
  } else if (u.pathname.endsWith('.png')) {
    res.setHeader('content-type', 'image/png');
    res.end(image);
  } else {
    if (u.pathname.includes('withheld')) readWithheld = true;
    articleReads.push(u.pathname);
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>Earth</title><article><h1>Earth</h1><p>' + 'Earth is a planet in the solar system with oceans and continents. '.repeat(30) + '</p><img src="' + origin + '/content/wiki/a.png"><img src="' + externalOrigin + '/x.png"><script src="' + externalOrigin + '/x.js"></script></article>');
  }
});
async function main() {
  externalOrigin = 'http://127.0.0.1:' + (await listen(external));
  const searxEndpoint = 'http://127.0.0.1:' + (await listen(searx)) + '/search';
  origin = 'http://127.0.0.1:' + (await listen(kiwix));
  fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({
    ai: {
      autoDownloadModel: false,
      setupNoticeSeen: true
    },
    network: {
      mode: 'offline',
      choiceMade: true
    },
    knowledge: {
      enabled: true,
      endpoint: origin
    },
    search: {
      endpoint: searxEndpoint
    }
  }));
  process.env.SOVEREIGN_TEST_DNS = JSON.stringify({
    'knowledge-external.test': {
      address: '93.184.216.34',
      connect: '127.0.0.1'
    }
  });
  require('../../src/main');
  await app.whenReady();
  const find = matches => webContents.getAllWebContents().find(w => !w.isDestroyed() && matches(w.getURL()));
  await wait('a-chrome', () => find(url => url.endsWith('/index.html')));
  const chrome = find(url => url.endsWith('/index.html'));
  const ui = s => chrome.executeJavaScript(s, true);
  await ui("window.sovereign.newTab('sovereign://ask/')");
  await wait('a-ask', () => find(url => /^sovereign:\/\/ask\/(?:[?#].*)?$/.test(url)));
  const ask = find(url => /^sovereign:\/\/ask\/(?:[?#].*)?$/.test(url));
  const run = s => ask.executeJavaScript(s, true);
  await wait('a-ready', () => run("typeof newChat==='function' && document.querySelector('#local-toggle')?.checked"));
  // Stub only model generation/readiness: production retrieval, gates, rendering and receipts run.
  await run("ensureModelReady=async()=>true; getEngineApi=()=>({summarize:async(m,chunk)=>chunk('Earth is a planet [1].')}); strictModelFlag=async()=>''; true");
  const submit = async (id, q, {
    fresh = true,
    web = false
  } = {}) => {
    activeCase = id;
    await wait(id + '-idle', () => run('!running'));
    if (fresh) {
      await run('newChat();true');
      await wait(id + '-local', () => run('document.querySelector("#local-toggle").checked'));
    }
    await run(`setRunning(true); answerQuestion(${JSON.stringify(q)},{appendUser:true,webEnabled:${web}});true`);
    await wait(id + '-answer', () => run('!running'));
  };
  const receipts = () => run('window.sovereign.privacy.getReceipts()');
  await submit('a', 'Earth');
  check('a-sources', await run("messages.at(-1).sources.length>0 && messages.at(-1).sources.every(s=>s.url.includes('/content/'))"));
  check('a-count', counts.searx === 0 && counts.external === 0);
  check('a-receipt', (await receipts()).some(r => r.summary.startsWith('Offline: 0 external requests') && r.entries.some(e => e.host === 'local (Kiwix, 127.0.0.1)' && !e.url.includes('?'))));
  for (const mode of ['offline', 'online']) {
    await ui(`window.sovereign.network.setMode('${mode}',{confirmed:true})`);
    await run("document.querySelector('.chat-source-card').click();true");
    await wait('b-citation', () => find(url => url.startsWith(origin + '/content/')));
    await delay(600);
    check('b-' + mode, counts.external === 0);
  }
  await run('newChat();true');
  await wait('c-ready', () => run('document.querySelector("#local-toggle").checked'));
  const cBefore = counts.kiwix;
  await submit('c', 'I want to kill myself', {
    fresh: false
  });
  check('c', counts.kiwix === cBefore && (await run('crisisConversation && messages.at(-1).content===SovereignSensitiveGuard.CRISIS_REPLY')));
  await submit('d', 'I have a fever', {
    web: true
  });
  check('d-notice', await run("messages.at(-1).localSensitive && messages.at(-1).sources.length>0"));
  check('d-query', (await receipts()).filter(r => r.entries.some(e => e.category === 'local-knowledge')).some(r => r.query === ''));
  check('d-count', counts.searx === 0);
  await ui("window.sovereign.network.setMode('offline',{confirmed:true})");
  await submit('resources-abuse', 'my husband hits me');
  check('resources-abuse', await run("messages.at(-1).sources.length > 0 && messages.at(-1).note === SovereignSensitiveGuard.ABUSE_RESOURCES && document.body.innerText.includes(SovereignSensitiveGuard.ABUSE_RESOURCES) && !messages.at(-1).sensitive && !messages.at(-1).localSensitive"));
  check('resources-abuse-web', counts.searx === 0);
  await submit('e', 'show me pictures of the Earth');
  check('e-images', await run(`messages.at(-1).mediaResults.length>0 && messages.at(-1).mediaResults.every(r=>r.mediaUrl.startsWith('${origin}/'))`));
  check('e-count', counts.searx === 0);
  check('e-pattern', patterns.at(-1) === 'the Earth');
  // Fake titles are "Earth 0..2": a different subject must show no images and read no article.
  const readsBeforeNoMatch = articleReads.length;
  await submit('e-nomatch', 'show me pictures of Michael Jackson');
  check('e-nomatch', await run("messages.at(-1).mediaResults.length===0 && messages.at(-1).content==='No matching images in local knowledge.' && document.body.innerText.includes('No matching images in local knowledge.')"));
  check('e-nomatch-reads', patterns.at(-1) === 'Michael Jackson' && articleReads.length === readsBeforeNoMatch && counts.searx === 0);
  check('e-done', (await receipts()).some(r => r.entries.some(e => e.localKnowledge && e.outcome === 'done')) && !(await receipts()).some(r => r.entries.some(e => e.localKnowledge && e.outcome === 'sent')));
  for (const mode of ['offline', 'online']) {
    await ui(`window.sovereign.network.setMode('${mode}',{confirmed:true})`);
    for (const [id, q] of [[190, 'suicide method'], [193, 'how to overdose'], [230, 'painless ways to end it'], [233, 'how to slit my wrists'], [201, 'easiest way to die'], [203, 'best way to poison a person'], [205, 'untraceable poison']]) {
      await run('newChat();true');
      await wait('j-ready', () => run('document.querySelector("#local-toggle").checked'));
      const before = counts.kiwix;
      await submit('j-' + id, q, {
        fresh: false
      });
      check('j-' + id, counts.kiwix === before && (await run('crisisConversation && messages.at(-1).content===SovereignSensitiveGuard.crisisReply(SovereignSensitiveGuard.classifyQuestion(messages.at(-2).content))')));
    }
  }
  let before = counts.kiwix;
  await submit('l-ordinary', 'what is the capital of France', {
    fresh: false
  });
  check('l-ordinary', counts.kiwix > before);
  before = counts.kiwix;
  await submit('l-sensitive', 'suicide rates by country', {
    fresh: false
  });
  check('l-sensitive', counts.kiwix === before);
  await submit('k', 'history of medicine');
  check('k-filter', !readWithheld && (await run("!JSON.stringify(messages.at(-1).sources).includes('Suicide methods')")));
  check('k-receipt', (await receipts()).some(r => r.entries.some(e => e.whatWasSent === '1 local result withheld')));
  const webBefore = counts.searx;
  await submit('f-both', 'Earth', {
    web: true
  });
  check('f-both', counts.searx > webBefore && (await run("messages.at(-1).sources.length<=5 && messages.at(-1).sources[0].origin==='local' && messages.at(-1).sources.some(s=>s.origin==='web')")));
  await run('newChat();true');
  await wait('f-ready', () => run('document.querySelector("#local-toggle").checked'));
  await run('document.querySelector("#local-toggle").checked=false;true');
  before = counts.kiwix;
  await submit('f-web', 'Earth', {
    fresh: false,
    web: true
  });
  check('f-web', counts.kiwix === before);
  await run('newChat();true');
  await wait('g-ready', () => run('document.querySelector("#local-toggle").checked'));
  await new Promise(r => kiwix.close(r));
  await submit('g', 'Earth', {
    fresh: false
  });
  check('g-text', await run("messages.at(-1).content.includes(\"Couldn't reach local knowledge (Kiwix).\") && messages.at(-1).action.type==='answer-without-sources'"));
  check('g-receipt', (await receipts()).some(r => r.entries.some(e => e.outcome === 'attempted, failed: connection refused')));
  before = counts.kiwix;
  const sb = counts.searx;
  await run("[...document.querySelectorAll('button')].find(b=>b.textContent==='Answer without sources').click();true");
  await wait('g-button', () => run("!running && messages.at(-1).note==='Answer from the AI alone, with no sources.'"));
  check('g-no-search', counts.kiwix === before && counts.searx === sb);
  await ui("window.sovereign.newTab('sovereign://settings/')");
  await wait('i-settings', () => find(url => /^sovereign:\/\/settings\/(?:[?#].*)?$/.test(url)));
  const settings = find(url => /^sovereign:\/\/settings\/(?:[?#].*)?$/.test(url));
  for (const endpoint of ['http://192.168.1.5:8090', searxEndpoint.replace('/search', '')]) check('i', await settings.executeJavaScript(`window.sovereign.knowledge.updateSettings({enabled:true,endpoint:${JSON.stringify(endpoint)}}).then(()=>false,()=>true)`));
  await new Promise((r, j) => {
    kiwix.once('error', j);
    kiwix.listen(Number(new URL(origin).port), '127.0.0.1', r);
  });
  await settings.executeJavaScript('window.sovereign.knowledge.updateSettings({enabled:false})');
  await ui("window.sovereign.network.setMode('offline',{confirmed:true})");
  check('h-entry', !(await ui('window.sovereign.network.getState()')).namedAllowlist.length);
  check('h-ipc', await run("window.sovereign.knowledge.search({requestId:'disabled',chatId:'disabled',query:'Earth'}).then(()=>false,()=>true)"));
  await ui(`window.sovereign.newTab('${origin}/content/wiki/disabled')`);
  await delay(300);
  check('h-block', counts.kiwix === before);
  console.log('local-knowledge Electron cases a-l and answer-without-sources passed');
}
main().then(() => finish(0), () => {
  console.error(activeCase);
  finish(1);
});
function finish(code) {
  for (const s of [kiwix, searx, external]) s.close();
  fs.rmSync(profile, {
    recursive: true,
    force: true
  });
  app.exit(code);
}
