process.env.SOVEREIGN_TEST_NETWORK_MODE = 'online';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { app, webContents, dialog } = require('electron');
const { spawn } = require('node:child_process');
const phase = process.env.SOVEREIGN_SENSITIVE_PHASE || 'orchestrate';
const profile = process.env.SOVEREIGN_SENSITIVE_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-sensitive-'));
process.env.SOVEREIGN_USER_DATA_DIR = profile;
let count = 0, expectedQuery = '', matched = false;
// Count only; never retain or print request URLs or questions.
const server = http.createServer((req, res) => {
 count++; matched = new URL(req.url, 'http://localhost').searchParams.get('q') === expectedQuery;
 res.setHeader('content-type','application/json'); res.end(JSON.stringify({ results: [] }));
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let activeCase = '1-start';
function failure(id) { const error = new Error(); error.caseId = id; return error; }
async function wait(id, fn) { activeCase = id; for (let i=0;i<150;i++) { if (await fn()) return; await delay(100); } throw failure(id); }
const isAsk = w => !w.isDestroyed() && /^sovereign:\/\/ask\/(?:[?#].*)?$/.test(w.getURL());
const find = url => webContents.getAllWebContents().find(w => !w.isDestroyed() && (url === 'sovereign://ask/' ? isAsk(w) : w.getURL().includes(url)));
function check(id, value) { activeCase = id; if (!value) throw failure(id); }
async function preferencePhase() {
 if (phase === 'fresh') process.env.SOVEREIGN_TEST_NETWORK_MODE = 'offline'; // No model auto-download in a truly empty profile.
 require('../../src/main'); await app.whenReady(); await wait('8-'+phase+'-chrome', () => find('index.html'));
 const chrome = find('index.html');
 await chrome.executeJavaScript("window.sovereign.newTab('sovereign://settings/')",true);
 await wait('8-'+phase+'-settings', () => find('sovereign://settings/'));
 const settings = find('sovereign://settings/');
 await wait('8-'+phase+'-ready', () => settings.executeJavaScript("Boolean(document.querySelector('#sensitive-strict'))"));
 const state = await settings.executeJavaScript('window.sovereign.privacy.getSettings()');
 check('8-'+phase, state.sensitiveTopics === (phase === 'relaunch-standard' ? 'standard' : 'strict'));
 if (phase === 'fresh' || phase === 'old') {
  await wait('8-'+phase+'-strict', () => settings.executeJavaScript("document.querySelector('#sensitive-strict').checked"));
  await settings.executeJavaScript("document.querySelector('#sensitive-standard').click()",true);
  await wait('8-'+phase+'-standard', async () => (await settings.executeJavaScript('window.sovereign.privacy.getSettings()')).sensitiveTopics === 'standard');
 } else if (phase === 'relaunch-standard') {
  await settings.executeJavaScript("window.sovereign.privacy.updateSettings({sensitiveTopics:'strict'})",true);
 }
}
async function orchestrate() {
 const run = (childPhase, dir, script = __filename) => new Promise((resolve,reject) => {
  const env = { ...process.env, SOVEREIGN_SENSITIVE_PHASE:childPhase, SOVEREIGN_SENSITIVE_PROFILE:dir };
  delete env.ELECTRON_RUN_AS_NODE;
  // Child output is intentionally not forwarded: only the case id can leave this harness.
  const child = spawn(process.execPath,[script],{env,stdio:['ignore','pipe','pipe']});
  let failedId = childPhase === 'main' ? '1-main' : /^[0-9]/.test(childPhase) ? childPhase : '8-'+childPhase, leaked = false, stackLines = [];
  const scan = () => { let tail = ''; return chunk => { const text = tail + chunk.toString(); if (text.includes('SECRETQ-7731')) leaked = true; tail = text.slice(-11); }; };
  child.stdout.on('data', scan()); child.stderr.on('data', scan());
  let diagnostics = '';
  child.stderr.on('data', chunk => {
    diagnostics += chunk.toString();
    const lines = diagnostics.split('\n'); diagnostics = lines.pop().slice(-4096);
    for (const line of lines) {
      try {
        const report = JSON.parse(line);
        if (/^[0-9]+[a-z]?(?:-[a-z]+)*$/.test(report.caseId) && Array.isArray(report.stackLines) && report.stackLines.every(n => /^\d+:\d+$/.test(n))) {
          failedId = report.caseId; stackLines = report.stackLines;
        }
      } catch {}
    }
  });
  const timer=setTimeout(()=>child.kill('SIGKILL'),script === __filename ? 180000 : 600000);
  child.on('error',()=>{clearTimeout(timer);reject(failure(failedId));});
  child.on('exit',code=>{clearTimeout(timer);code===0&&!leaked?resolve():reject(Object.assign(failure(leaked ? '7d' : failedId), { stackLines }));});
 });
 await run('main', profile);
 for (const kind of ['fresh','old']) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sovereign-sensitive-prefs-'));
  if (kind==='old') fs.writeFileSync(path.join(dir,'preferences.json'),JSON.stringify({ai:{autoDownloadModel:false,setupNoticeSeen:true}}));
  await run(kind,dir); await run('relaunch-standard',dir); await run('relaunch-strict',dir);
 }
 for (const name of ['ui-smoke','media-chat','safe-redirects','ask-layout','stage1-usability','offline-mode']) {
  await run('9-'+name, fs.mkdtempSync(path.join(os.tmpdir(),'sovereign-sensitive-regression-')), path.join(__dirname,name+'.test.js'));
 }
 console.log('sensitive-guard Electron cases 1–11 passed');
}
async function main() {
 await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
 const endpoint = `http://127.0.0.1:${server.address().port}/search`;
 if (!fs.existsSync(path.join(profile,'preferences.json'))) fs.writeFileSync(path.join(profile,'preferences.json'), JSON.stringify({ ai: { autoDownloadModel:false, setupNoticeSeen:true, saveChatsOnDevice:true }, search: { endpoint } }));
 require('../../src/main'); await app.whenReady(); await wait('1-chrome', () => find('index.html'));
 const chrome = find('index.html');
 await chrome.executeJavaScript("window.sovereign.newTab('sovereign://ask/?q=x&web=1')", true);
 await wait('1-ask', () => find('sovereign://ask/'));
 const ask = find('sovereign://ask/');
 await wait('1-ready', () => ask.executeJavaScript("typeof newChat === 'function' && typeof privacySettings !== 'undefined'"));
 const invoke = (method, input) => ask.executeJavaScript(`window.sovereign.${method}(${JSON.stringify(input)})`,true);
 await invoke('search.updateSettings', { endpoint });
 check('1a', await ask.executeJavaScript("!document.querySelector('#web-toggle').checked"));
 check('1b', await ask.executeJavaScript("document.querySelector('#web-toggle').click(); newChat(); !document.querySelector('#web-toggle').checked"));
 const submit = async (id, q, web = true) => {
  await ask.executeJavaScript(`newChat(); if (document.querySelector('#web-toggle').checked !== ${web}) document.querySelector('#web-toggle').click(); document.querySelector('#chat-input').value = ${JSON.stringify(q)}; document.querySelector('#chat-form').requestSubmit();`,true);
  await wait(id+'-submit', () => ask.executeJavaScript('!running'));
 };
 const marker = 'SECRETQ-7731';
 count=0; await submit('2', 'I think I have HIV ' + marker);
 check('2a', count===0);
 check('2b', await ask.executeJavaScript("Boolean(document.querySelector('.sensitive-notice')) && Boolean(document.querySelector('.sensitive-anyway')) && /not downloaded|isn't downloaded/i.test(document.body.textContent)"));
 const receipts = await invoke('privacy.getReceipts');
 check('7a', !JSON.stringify(receipts).includes(marker));
 check('7b', receipts.some(r => r.entries.some(e => e.whatWasSent.startsWith('blocked (sensitive topic:'))));
 const exported = path.join(profile, 'receipt-export.json');
 dialog.showSaveDialog = async () => ({ canceled:false, filePath:exported });
 await invoke('privacy.exportReceipts');
 check('7c', !fs.readFileSync(exported,'utf8').includes(marker));
 await submit('3', 'I think I have HIV, call me at 415-555-0134');
 await ask.executeJavaScript("document.querySelector('.sensitive-anyway').click()",true);
 check('3a', await ask.executeJavaScript("document.querySelector('.sensitive-query').value === document.querySelector('.sensitive-preview').textContent && !document.querySelector('.sensitive-query').value.includes('415')"));
 expectedQuery='HIV testing options'; count=0;
 await ask.executeJavaScript("document.querySelector('.sensitive-query').value='HIV testing options'; document.querySelector('.sensitive-query').dispatchEvent(new Event('input')); document.querySelector('.sensitive-send').click()",true);
 await wait('3-request', () => count===1); check('3b', matched);
 await wait('3-complete', () => ask.executeJavaScript('!running'));
 const overrideReceipt = (await invoke('privacy.getReceipts')).find(r=>r.sensitiveOverride);
 check('3c', overrideReceipt && overrideReceipt.query === expectedQuery && overrideReceipt.chatId === await ask.executeJavaScript('chatId'));
 for (const mode of ['web','local','offline']) {
  if (mode==='offline') await invoke('network.setMode','offline');
  count=0; await submit('4-'+mode, 'I want to kill myself', mode==='web');
  check('4-'+mode, count===0 && await ask.executeJavaScript("messages.at(-1).content === SovereignSensitiveGuard.CRISIS_REPLY && !document.querySelector('.sensitive-anyway') && !document.querySelector('#web-toggle').checked"));
 }
 await invoke('network.setMode','online');
 count=0; await submit('6', 'show me pictures of herpes',false);
 await ask.executeJavaScript("document.querySelector('.chat-inline-action').click()",true);
 await wait('6-complete', () => ask.executeJavaScript('!running'));
 check('6', count===0 && await ask.executeJavaScript("Boolean(document.querySelector('.sensitive-notice'))"));
 // Address-bar routing is exercised through its normal navigation API.
 await chrome.executeJavaScript("window.sovereign.newTab('sovereign://newtab/')",true);
 await chrome.executeJavaScript("window.sovereign.navigate('my son has a fever of 39 should I worry')",true);
 await wait('5-search', () => find('sovereign://search/'));
 const search = find('sovereign://search/');
 await wait('5-notice', () => search.executeJavaScript("Boolean(document.querySelector('.sensitive-notice'))"));
 check('5a', count===0);
 await search.executeJavaScript("document.querySelector('.sensitive-local').click()",true);
 await wait('10-ask', () => webContents.getAllWebContents().some(w => w !== ask && isAsk(w)));
 const localAsk = webContents.getAllWebContents().find(w=>!w.isDestroyed()&&w !== ask&&isAsk(w));
 check('10', count===0 && localAsk && await localAsk.executeJavaScript("!document.querySelector('#web-toggle').checked"));
 await search.executeJavaScript("document.querySelector('#question').value='how to kill a Python process'; document.querySelector('#search-form').requestSubmit()",true);
 await wait('5-request', ()=>count===1); check('5b',count===1);
 check('8a',(await invoke('privacy.getSettings')).sensitiveTopics==='strict');
 const query = () => invoke('search.query',{requestId:'setting-'+Math.random(),query:'symptoms of type 2 diabetes'});
 check('8b',(await query()).sensitive);
 await chrome.executeJavaScript("window.sovereign.newTab('sovereign://settings/')",true);
 await wait('8-settings', ()=>find('sovereign://settings/'));
 const settings=find('sovereign://settings/');
 await wait('8-ready', ()=>settings.executeJavaScript("document.querySelector('#sensitive-strict')?.checked"));
 await settings.executeJavaScript("document.querySelector('#sensitive-standard').click()",true);
 await wait('8-standard', async ()=>(await invoke('privacy.getSettings')).sensitiveTopics==='standard');
 count=0; await query(); check('8c',count===1);
 await settings.executeJavaScript("document.querySelector('#sensitive-strict').click()",true);
 await wait('8-strict', async ()=>(await invoke('privacy.getSettings')).sensitiveTopics==='strict');
 check('8d',(await query()).sensitive);
 check('8e',JSON.parse(fs.readFileSync(path.join(profile,'preferences.json'))).privacy.sensitiveTopics==='strict');
 check('8f',await settings.executeJavaScript("document.querySelectorAll('input[name=sensitive-topics]').length===2"));
 const savedChat = id => ({id,messages:[{id:'turn',role:'user',content:'fixture'}]});
 await invoke('chats.save',savedChat('guard-chat-a'));
 await invoke('search.query',{requestId:'delete-a',chatId:'guard-chat-a',query:'HIV testing options',override:true});
 await invoke('privacy.startActivity',{requestId:'keep',type:'ask',localOnly:true});
 await invoke('chats.delete','guard-chat-a');
 check('11a',!(await invoke('privacy.getReceipts')).some(r=>r.id==='delete-a'));
 await invoke('chats.save',savedChat('guard-chat-b'));
 await invoke('search.query',{requestId:'delete-b',chatId:'guard-chat-b',query:'HIV testing options',override:true});
 await search.executeJavaScript("window.sovereign.search.query({requestId:'delete-search',query:'HIV testing options',override:true})",true);
 dialog.showMessageBox = async () => ({response:1});
 dialog.showMessageBoxSync = () => 1;
 await invoke('chats.clear');
 const remaining=await invoke('privacy.getReceipts');
 check('11b',remaining.every(r=>!r.chatId&&!r.sensitiveOverride)&&remaining.some(r=>r.id==='keep'));
 // Case 18: crisis first on every surface, including seeded Offline Search.
 const crisisQuestion = 'I want to kill myself ' + marker;
 const verifyCrisis = async (id, page) => {
  // Ask renders replies as paragraphs/lists (newlines and bullets change), so compare letters and digits only.
  await wait(id+'-reply', () => page.executeJavaScript("(() => { const flat = s => s.replace(/[^A-Za-z0-9]/g, ''); return flat(document.body.textContent).includes(flat(SovereignSensitiveGuard.CRISIS_REPLY)); })()"));
  check(id, count === 0 && await page.executeJavaScript("document.body.textContent.includes('988') && document.body.textContent.includes('local emergency number') && !document.body.textContent.includes('Web search is off in Offline mode') && !document.body.textContent.includes('Image search needs Online mode')"));
  check(id+'-receipt', !JSON.stringify(await invoke('privacy.getReceipts')).includes(marker));
 };
 for (const mode of ['offline', 'online']) {
  await invoke('network.setMode', mode);
  for (const surface of ['search', 'address', 'newtab']) {
   const id = '18-'+surface+'-'+mode;
   const previous = new Set(webContents.getAllWebContents());
   count = 0;
   if (surface === 'search') {
    await chrome.executeJavaScript('window.sovereign.newTab('+JSON.stringify('sovereign://search/?q='+encodeURIComponent(crisisQuestion)+'&run=1')+')', true);
   } else {
    await chrome.executeJavaScript("window.sovereign.newTab('sovereign://newtab/')", true);
    if (surface === 'address') {
     await chrome.executeJavaScript('window.sovereign.navigate('+JSON.stringify(crisisQuestion)+')', true);
    } else {
     await wait(id+'-home', () => webContents.getAllWebContents().some(w => !previous.has(w) && !w.isDestroyed() && w.getURL().startsWith('sovereign://newtab/')));
     const home = webContents.getAllWebContents().find(w => !previous.has(w) && !w.isDestroyed() && w.getURL().startsWith('sovereign://newtab/'));
     await wait(id+'-ready', () => home.executeJavaScript("typeof selectedMode === 'function'"));
     await home.executeJavaScript('setSelectedMode("search"); document.querySelector("#home-query").value='+JSON.stringify(crisisQuestion)+'; document.querySelector("#home-search").requestSubmit()', true);
    }
   }
   const resultPage = () => webContents.getAllWebContents().find(w => !previous.has(w) && !w.isDestroyed() && w.getURL().startsWith('sovereign://search/'));
   await wait(id+'-page', () => Boolean(resultPage()));
   await verifyCrisis(id, resultPage());
  }
  for (const web of mode === 'offline' ? [false] : [false, true]) {
   const id = '18-ask-'+mode+(web ? '-web' : '-local');
   count = 0; await submit(id, crisisQuestion, web); await verifyCrisis(id, ask);
  }
 }
 count = 0;
 await submit('18-image', 'show me images I want to kill myself '+marker, true);
 await verifyCrisis('18-image', ask);
 // Case 9 is run by the orchestrator after these checks.
 console.log('1–11'); server.close(); app.exit(0);
}
const task = phase === 'orchestrate' ? app.whenReady().then(orchestrate) : phase === 'main' ? main() : preferencePhase();
task.then(() => app.exit(0), error => {
 const caseId = /^[0-9]+[a-z]?(?:-[a-z]+)*$/.test(error.caseId) ? error.caseId : activeCase;
 const stackLines = error.stackLines?.length ? error.stackLines : String(error.stack || '').split('\n').slice(1).flatMap(line => {
  const match = line.match(/:(\d+):(\d+)\)?$/); return match ? [match[1]+':'+match[2]] : [];
 });
 console.error(JSON.stringify({ caseId, stackLines })); server.close(); app.exit(1);
});
