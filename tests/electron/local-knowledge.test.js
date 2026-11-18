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
const backend = require('../../src/knowledge-backend');
const realFeed = fs.readFileSync(path.join(__dirname, '../fixtures/kiwix-search.xml'), 'utf8');
let r3Fixtures = false, r3SensitiveArticle = false, slowCatalog = 0, catalogHits = 0;
const r3Feeds = new Map([
 ['solar eclipse','solar-eclipse'],['won match','yesterdays-match'],['fever','fever'],
 ['photosynthesis','photosynthesis'],['won world cup','world-cup'],['red pandas','red-pandas'],['earth','earth-word'],['albert einstein','albert-einstein']
].map(([q,name])=>[q,fs.readFileSync(path.join(__dirname,'../fixtures/kiwix-search-'+name+'.xml'),'utf8')]));
const r3Items = [...r3Feeds.values()].flatMap(xml=>backend.parseSearchXml(xml));
const realEntry = fs.readFileSync(path.join(__dirname, '../fixtures/kiwix-catalog.xml'), 'utf8').match(/<entry>[\s\S]*?<\/entry>/)[0];
const fixtureItems = backend.parseSearchXml(realFeed);
const escapeXml = text => text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const kiwix = http.createServer((req, res) => {
  counts.kiwix++;
  if (down) {
    req.socket.destroy();
    return;
  }
  const u = new URL(req.url, origin);
  if (u.pathname === '/search') {
    patterns.push(u.searchParams.get('pattern'));
    if(r3Fixtures) {
      const pattern=u.searchParams.get('pattern');
      const xml=r3SensitiveArticle ? '<rss><channel><item><title>Fever</title><link>/content/wiki/Fever</link><description>Fever is a raised temperature.</description></item><item><title>Earth</title><link>/content/wiki/Earth</link><description>Earth is a planet.</description></item></channel></rss>' : r3Feeds.get(pattern);
      if(xml){res.setHeader('content-type','application/xml');res.end(xml);return;}
    }

    if (u.searchParams.get('pattern') === 'solar eclipse') { res.setHeader('content-type','application/xml'); res.end(realFeed); return; }
    if (['lowest temperature antarctica','antarctica temperature record'].includes(u.searchParams.get('pattern'))) {
      const first = fixtureItems.find(i=>i.title==='Antarctica');
      const items = [u.searchParams.get('pattern') === 'lowest temperature antarctica' ? first : {...first, url:'/content/wiki/record-first', snippet:'The lowest temperature recorded in Antarctica was −89.2 °C (−128.6 °F).'}, {title:'Antarctica record',url:'/content/wiki/record',snippet:'The lowest temperature on Earth, −89.6 °C, was recorded at Vostok Station in Antarctica.',book:'Wikipedia'}];
      res.end('<rss><channel>'+items.map(i=>`<item><title>${i.title}</title><link>${i.url}</link><description>${escapeXml(i.snippet)}</description><book><title>${i.book}</title></book></item>`).join('')+'</channel></rss>'); return;
    }
    const withheld = u.searchParams.get('pattern') === 'history medicine';
    const legacyTitle = ({fever:'Fever', 'husband hits':'Husband hits', 'capital france':'Capital France'})[u.searchParams.get('pattern')] || 'Earth';
    res.setHeader('content-type', 'application/xml');
    res.end('<rss version="2.0"><channel>' + [0, 1, 2].map(i => '<item><title>' + (withheld && i === 0 ? 'Suicide methods' : legacyTitle + ' ' + i) + '</title><link>/content/wiki/' + (withheld && i === 0 ? 'withheld' : 'Earth' + i) + '</link><description>Earth is a planet in the solar system.</description><book><title>Wikipedia</title></book><wordCount>1000</wordCount></item>').join('') + '</channel></rss>');
  } else if (u.pathname === '/catalog/v2/entries') {
    catalogHits++;
    if (slowCatalog) { const ms = slowCatalog; setTimeout(() => { res.setHeader('content-type', 'application/xml'); res.end('<feed>' + realEntry + '</feed>'); }, ms); return; }
    res.setHeader('content-type', 'application/xml');
    res.end('<feed>' + ['wiki', 'travel'].map(n => '<entry><id>' + n + '</id><name>' + n + '</name><title>' + n + '</title><tags>_ftindex:yes</tags></entry>').join('') + realEntry + '</feed>');
  } else if (u.pathname.endsWith('.png')) {
    res.setHeader('content-type', 'image/png');
    res.end(image);
  } else {
    if(r3Fixtures) {
      articleReads.push(u.pathname);
      const item=r3Items.find(i=>backend.articleRawUrl(new URL(i.url,origin)).endsWith(u.pathname));
      // Real articles are full pages; the Solar eclipse one states the cause, which "What causes…"
      // passage selection needs (the snippet alone has no cause sentence).
      const extra=item?.title==='Solar eclipse' ? '<p>A solar eclipse is caused by the Moon passing between the Sun and Earth, so the Moon blocks the light of the Sun for viewers on Earth.</p>' : '';
      res.setHeader('content-type','text/html');res.end('<article><p>'+escapeXml(item?.snippet || 'Fever is a raised temperature. Earth is a planet.')+'</p>'+extra+'</article>');return;
    }
    const fixture = fixtureItems.find(i=>u.pathname===i.url.replace('/content/','/raw/').replace('/wikipedia_en_100_2026-08/','/wikipedia_en_100_2026-08/content/'));
    if (fixture || /\/record(?:-first)?$/.test(u.pathname)) { res.setHeader('content-type','text/html'); res.end('<article><h1>'+ (fixture?.title || 'Antarctica record') +'</h1><p>'+escapeXml(u.pathname.endsWith('/record-first') ? 'The lowest temperature recorded in Antarctica was −89.2 °C (−128.6 °F).' : fixture?.snippet || 'The lowest temperature on Earth, −89.6 °C, was recorded at Vostok Station in Antarctica.')+'</p></article>'); return; }
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
  // "history of medicine" is an ordinary (non-sensitive) chat, so the approved 2a filter text stays.
  check('k-receipt', (await receipts()).some(r => r.entries.some(e => e.method === 'FILTER' && e.whatWasSent === '1 local result withheld')));
  const webBefore = counts.searx;
  await submit('f-both', 'Earth', {
    web: true
  });
  check('f-both', counts.searx > webBefore && (await run("messages.at(-1).sources.length<=5 && messages.at(-1).sources[0].origin==='local' && messages.at(-1).sources.some(s=>s.origin==='web')")));
  await run('newChat();true');
  await wait('f-ready', () => run('document.querySelector("#local-toggle").checked'));
  // New chat's status check runs in the background and re-ticks the box when it finishes;
  // let it settle before unticking, or the late result turns local knowledge back on.
  await run('refreshKnowledgeStatus().then(()=>true)');
  await run('document.querySelector("#local-toggle").checked=false;true');
  before = counts.kiwix;
  await submit('f-web', 'Earth', {
    fresh: false,
    web: true
  });
  check('f-web', counts.kiwix === before);
  // Task 2b: only generation is stubbed; real fixture retrieval and renderer run.
  const model = async text => run(`getEngineApi=()=>({summarize:async(m,chunk)=>chunk(${JSON.stringify(text)})});true`);
  const lastHas = text => run(`document.querySelector('.chat-message:last-child').innerText.includes(${JSON.stringify(text)})`);
  const noOffer = () => run("!document.querySelector('[data-trust-web]')");
  await ui("window.sovereign.network.setMode('offline',{confirmed:true})");
  await model('Total solar eclipses occur somewhere on Earth every 18 months on average [1]. They recur at any given place only once every 360 to 410 years [1].');
  const trustWebBefore = counts.searx;
  await submit('trust-supported','solar eclipse');
  check('trust-supported',await lastHas('Supported: every sentence cites a source. Open the sources to check.'));
  check('trust-date',await lastHas('Local knowledge as of 20 August 2026 (Wikipedia 100).'));
  check('trust-supported-network',counts.searx===trustWebBefore);
  await model('Total solar eclipses occur somewhere on Earth every 18 months on average [1]. They are the most beautiful sight in nature.');
  await submit('trust-removed','solar eclipse');
  check('trust-removed',await lastHas('1 sentence without a source was removed.'));
  await model('Eclipses are caused by dragons.');
  await submit('trust-excerpts','solar eclipse');
  check('trust-excerpts',!(await lastHas('sentence without a source was removed.')));
  await model('The search snippets are insufficient to answer that.');
  await submit('trust-notfound-offline','Who won the 2026 World Cup?');
  check('trust-notfound-offline',await lastHas("Not found: the sources didn't contain an answer."));
  check('trust-no-offer-offline',await noOffer());
  await ui("window.sovereign.network.setMode('online',{confirmed:true})");
  await submit('trust-offer','Who won the 2026 World Cup?');
  check('trust-offer',await lastHas("Local knowledge didn't have an answer. Search the web?"));
  await ui("window.sovereign.network.setMode('offline',{confirmed:true})");
  await wait('trust-offer-removed',noOffer);
  await ui("window.sovereign.network.setMode('online',{confirmed:true})");
  await submit('trust-offer-again','Who won the 2026 World Cup?');
  const offerBefore=counts.searx;
  await model('Earth is a planet [1].');
  await run("document.querySelector('[data-trust-web]').click();true");
  await wait('trust-offer-finished',()=>run('!running'));
  check('trust-offer-once',counts.searx===offerBefore+1);
  check('trust-offer-checkbox',await run('!webToggle.checked'));
  check('trust-offer-date',await lastHas('Web sources retrieved '));
  await ui("window.sovereign.network.setMode('offline',{confirmed:true})");
  await submit('trust-sensitive','I have a fever');
  check('trust-sensitive',await run("!!messages.at(-1).trust"));
  await model('The search snippets are insufficient to answer that.');
  await ui("window.sovereign.network.setMode('online',{confirmed:true})");
  await submit('trust-no-offer-sensitive','I have a fever');
  check('trust-no-offer-sensitive',await noOffer());
  await submit('trust-no-offer-images','show me pictures of Michael Jackson');
  check('trust-no-offer-images',await noOffer());
  await ui("window.sovereign.network.setMode('offline',{confirmed:true})");
  await model('Earth is a planet [1].');
  await submit('trust-fixed-abuse','my husband hits me');
  check('trust-fixed-abuse',await run("messages.at(-1).note===SovereignSensitiveGuard.ABUSE_RESOURCES && !!document.querySelector('.chat-message:last-child .answer-trust') && document.querySelector('.chat-message:last-child .chat-message-body').lastElementChild.textContent===SovereignSensitiveGuard.ABUSE_RESOURCES"));
  for (const [id,question] of [[233,'how to slit my wrists'],[203,'best way to poison a person']]) {
    await submit('trust-fixed-'+id,question);
    check('trust-fixed-'+id,await run("!messages.at(-1).trust && !document.querySelector('.chat-message:last-child .answer-trust') && messages.at(-1).content===SovereignSensitiveGuard.crisisReply(SovereignSensitiveGuard.classifyQuestion(messages.at(-2).content))"));
    await run('localToggle.checked=false;true');
    await submit('trust-crisis-alone-'+id,'what is photosynthesis',{fresh:false});
    check('trust-crisis-alone-'+id,await run("!messages.at(-1).trust && !document.querySelector('.chat-message:last-child .answer-trust')"));
    await run('localToggle.checked=true;true');
    await submit('trust-crisis-local-'+id,'capital of France',{fresh:false});
    check('trust-crisis-local-'+id,await run("!!messages.at(-1).trust && !!document.querySelector('.chat-message:last-child .answer-dates')"));
    check('trust-no-offer-locked-'+id,await noOffer());
  }
  await model('The lowest temperature recorded in Antarctica was −89.2 °C [1] [2].');
  await submit('trust-disagree','lowest temperature Antarctica');
  check('trust-disagree-truncated',await run("!document.querySelector('.chat-message:last-child .answer-trust-disagree')"));
  await submit('trust-disagree-complete','Antarctica temperature record');
  // Sources are ordered by title coverage, so "Antarctica record" (2 key words) is [1].
  check('trust-disagree',await lastHas('Sources disagree: −89.6 °C [1] · −89.2 °C [2]. Check the sources.'));
  const savedTrust = await run("JSON.stringify({trust:savedMessage(messages.at(-1)).trust,retrievedAt:messages.at(-1).retrievedAt})");
  const savedId = await run('chatId');
  await ui("window.sovereign.newTab('sovereign://settings/')");
  await wait('trust-saving-settings',()=>find(url=>/^sovereign:\/\/settings\/(?:[?#].*)?$/.test(url)));
  const savingSettings=find(url=>/^sovereign:\/\/settings\/(?:[?#].*)?$/.test(url));
  await wait('trust-saving-ready',()=>savingSettings.executeJavaScript("document.querySelector('#settings-save-chats') && !document.querySelector('#settings-save-chats').disabled"));
  const setSaving=async enabled=>{
    await savingSettings.executeJavaScript(`
      document.querySelector('#settings-status').textContent='';
      document.querySelector('#settings-save-chats').checked=${enabled};
      document.querySelector('#settings-save-chats').dispatchEvent(new Event('change'));
    `);
    await wait('trust-saving-status',()=>savingSettings.executeJavaScript("document.querySelector('#settings-status').textContent"));
    await wait('trust-saving-state',()=>run(`saveChatsOnDevice===${enabled}`));
  };
  await setSaving(true);
  await run('persistCurrentChat()');
  await wait('trust-saved-stored',()=>run(`savedChatList.some(c=>c.id===${JSON.stringify(savedId)})`));
  await run('newChat();true');
  await run("[...document.querySelectorAll('.chat-history-title')].find(b=>b.textContent==='Antarctica temperature record').click();true");
  await wait('trust-saved-open',()=>run(`chatId===${JSON.stringify(savedId)}`));
  check('trust-saved',await run("JSON.stringify({trust:messages.at(-1).trust,retrievedAt:messages.at(-1).retrievedAt})")===savedTrust);
  check('trust-saved-render',await lastHas('Sources disagree: −89.6 °C [1] · −89.2 °C [2]. Check the sources.'));
  const {dialog}=require('electron');
  const originalShowMessageBox=dialog.showMessageBox;
  dialog.showMessageBox=async()=>({response:0}); // Keep saved chats.
  try { await setSaving(false); } finally { dialog.showMessageBox=originalShowMessageBox; }

  r3Fixtures=true;
  for(const mode of ['offline','online']) {
    await ui(`window.sovereign.network.setMode('${mode}',{confirmed:true})`);
    const reads=articleReads.length;
    await submit('rel-'+mode+'-match',"Who won yesterday's match?");
    check('rel-'+mode+'-match',await run("messages.at(-1).trust?.label==='not-found' && messages.at(-1).sources.length===0") && articleReads.length===reads);
    check('rel-'+mode+'-offer', (await noOffer())===(mode==='offline'));
    await submit('rel-fever-'+mode,'I have a fever');
    check('rel-fever-'+mode,await run("messages.at(-1).trust?.label==='not-found'")&&await noOffer());
  }
  await model('A solar eclipse can only be viewed from a relatively small area of the world [1].');
  await submit('rel-solar','solar eclipse');
  check('rel-solar',await run("messages.at(-1).sources.length===1&&messages.at(-1).sources[0].title==='Solar eclipse'&&messages.at(-1).trust?.label==='supported'"));
  await model('The search snippets are insufficient to answer that.');
  await submit('rel-solar-excerpts','What causes a solar eclipse?');
  check('rel-solar-excerpts',await lastHas("Source excerpts: the AI couldn't write a reliable answer, so these passages are copied word for word from the sources. Check that they answer your question.") && await run("!document.querySelector('.chat-message:last-child .chat-message-body').innerText.includes(\"We couldn't produce a reliable AI synthesis\")"));
  await submit('rcpt-sensitive','I have a fever',{web:true});
  check('rcpt-sensitive',await run("(()=>{const r=privacyReceiptList.find(r=>r.id===selectedPrivacyReceiptId);return r&&r.entries.some(e=>e.localKnowledge&&e.outcome==='done')&&r.entries.some(e=>e.category==='sensitive')&&r.summary.includes('local knowledge');})()"));
  await run("getEngineApi=()=>({summarize:async()=>{throw Error('Prompt tokens exceed context window size');}});true");
  await submit('err-model','solar eclipse');
  check('err-model',await run(`messages.at(-1).content===${JSON.stringify("I couldn't finish this answer. Try again, or start a new chat.")}`));
  await run("globalThis.r3Read=window.sovereign.knowledge.readSources;true");
  // IPC remains authoritative: change the renderer's passed grant, not the preload API.
  await run("globalThis.r3Stream=streamKnowledgeAnswer;streamKnowledgeAnswer=async(q,id,o)=>{await window.sovereign.knowledge.readSources({requestId:'no-grant',chatId,question:q,results:[]});};true");
  await submit('err-grant','solar eclipse');
  check('err-grant',await run(`messages.at(-1).content===${JSON.stringify("I couldn't finish this answer. Try again, or start a new chat.")}`));
  await run('streamKnowledgeAnswer=r3Stream;true');
  await model('Earth is a planet [1].');
  r3SensitiveArticle=true;
  await setSaving(true);
  await submit('RC1-sensitive','I have a fever');
  // Save consent is asked only for crisis, harm and abuse questions; a medical question is saved
  // directly. Click the existing consent button only if it is shown.
  await run("document.querySelector('.save-consent-save')?.click();true");
  const sensitiveId=await run('chatId');
  await submit('RC1-followup','Earth',{fresh:false});
  await run('persistCurrentChat()');
  await wait('RC1-saved',()=>run(`savedChatList.some(c=>c.id===${JSON.stringify(sensitiveId)})`));
  await run('newChat();true');
  await run("[...document.querySelectorAll('.chat-history-title')].find(b=>b.textContent==='I have a fever').click();true");
  await wait('RC1-reopened',()=>run(`chatId===${JSON.stringify(sensitiveId)}`));
  await submit('RC1-reopened-followup','Earth',{fresh:false});
  const sensitiveReceipts=(await receipts()).filter(r=>r.chatId===sensitiveId);
  const privateRows=sensitiveReceipts.flatMap(r=>r.entries).filter(e=>e.localKnowledge);
  check('RC1-rows',privateRows.length>=6&&privateRows.every(e=>e.url.replace(/\/$/,'')===origin&&e.whatWasSent==='local search'&&e.outcome==='done'));
  check('RC1-payload',!/fever|\/content\/|\/raw\//i.test(JSON.stringify(sensitiveReceipts)));
  const exportFile=path.join(profile,'receipt-export.json'), oldSave=dialog.showSaveDialog;
  dialog.showSaveDialog=async()=>({canceled:false,filePath:exportFile});
  try {await run('window.sovereign.privacy.exportReceipts()');} finally {dialog.showSaveDialog=oldSave;}
  const exported=JSON.parse(fs.readFileSync(exportFile,'utf8'));
  check('RC1-export',!/fever|\/content\/|\/raw\//i.test(JSON.stringify(exported.receipts.filter(r=>r.chatId===sensitiveId))));
  // The whole export (every chat's receipts) never contains the sensitive key word.
  check('RC1-export-all',!/fever/i.test(JSON.stringify(exported)));
  await submit('RC1-ordinary','Earth');
  const ordinaryId=await run('chatId');
  check('RC1-ordinary',(await receipts()).filter(r=>r.chatId===ordinaryId).some(r=>r.entries.some(e=>e.url.includes('/raw/')&&e.whatWasSent.includes('article read on this computer'))));
  // R3.15 F1 + F3: World Cup (real capture) gives Not found; the T9 click never ticks the web box.
  r3SensitiveArticle=false;
  const sampleWeb=async(id,during)=>{
    await run("globalThis.__webSamples=[];globalThis.__webTimer=setInterval(()=>__webSamples.push(webToggle.checked?1:0),20);true");
    await during();
    await new Promise(r=>setTimeout(r,300));
    const ticked=await run("clearInterval(__webTimer);__webSamples.push(webToggle.checked?1:0);__webSamples.filter(Boolean).length");
    check(id,ticked===0);
  };
  await ui("window.sovereign.network.setMode('offline',{confirmed:true})");
  await submit('wc-offline','Who won the World Cup yesterday?');
  check('wc-offline',await run("messages.at(-1).trust?.label==='not-found' && messages.at(-1).sources.length===0")&&await noOffer());
  await ui("window.sovereign.network.setMode('online',{confirmed:true})");
  await submit('wc-online','Who won the World Cup yesterday?');
  check('wc-online',await run("messages.at(-1).trust?.label==='not-found' && messages.at(-1).sources.length===0")&&await lastHas("Local knowledge didn't have an answer. Search the web?"));
  const wcChat=await run('chatId');
  await sampleWeb('wc-t9-checkbox',async()=>{
    await run("document.querySelector('[data-trust-web]').click();true");
    await wait('wc-t9-finished',()=>run('!running'));
  });
  await run('persistCurrentChat()');
  await wait('wc-saved',()=>run(`savedChatList.some(c=>c.id===${JSON.stringify(wcChat)})`));
  await run('newChat();true');
  await sampleWeb('wc-reopen-checkbox',async()=>{
    await run("[...document.querySelectorAll('.chat-history-title')].find(b=>b.textContent==='Who won the World Cup yesterday?').click();true");
    await wait('wc-reopened',()=>run(`chatId===${JSON.stringify(wcChat)}`));
  });
  // R3.15 F2: a source-excerpt answer never shows "Sources disagree" (two sources, different temperatures).
  r3Fixtures=false;
  await model('The search snippets are insufficient to answer that.');
  await submit('excerpt-no-t5','Antarctica temperature record');
  check('excerpt-no-t5',await run("messages.at(-1).trust?.label==='excerpts' && !(messages.at(-1).trust?.disagreements||[]).length && !document.querySelector('.chat-message:last-child .answer-trust-disagree')"));
  // R3.14 (approved): New chat's slow background check must not re-tick a box the user just unticked.
  await model('Earth is a planet [1].');
  slowCatalog=1500;
  const searchesBefore=patterns.length;
  await run('newChat();true');
  await run('if (localToggle.checked) localToggle.click();true');
  await new Promise(r=>setTimeout(r,2200));
  check('retick-kept',await run('!localToggle.checked && !localToggle.disabled'));
  await submit('retick-question','Earth',{fresh:false});
  check('retick-no-kiwix',patterns.length===searchesBefore);
  // A newer check wins over an older, slower one: the slow "ready" result arrives last but is ignored.
  slowCatalog=1500;
  const hitsBefore=catalogHits;
  await run('refreshKnowledgeStatus();true');
  await wait('retick-slow-started',async()=>catalogHits>hitsBefore);
  slowCatalog=0;down=true;
  await run('refreshKnowledgeStatus();true');
  await new Promise(r=>setTimeout(r,2200));
  check('retick-newest-wins',await run('!localToggle.checked && localToggle.disabled && !kiwixReady'));
  down=false;
  await run('refreshKnowledgeStatus().then(()=>true)');
  await wait('retick-restored',()=>run('localToggle.checked && !localToggle.disabled'));
  r3Fixtures=true;
  r3Fixtures=false;r3SensitiveArticle=false;

  await model('Earth is a planet [1].');
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
  await wait('g-button', () => run("!running && messages.at(-1).trust?.label==='no-sources' && document.body.innerText.includes('No sources: answer from the AI alone; verify it.')"));
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
