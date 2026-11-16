const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/main'), 'utf8');
function body(name, text = source) {
 let start = text.indexOf(`function ${name}(`);
 assert.ok(start >= 0, name);
 if (text.slice(start - 6, start) === 'async ') start -= 6;
 return text.slice(start, text.indexOf('\n}', start) + 2);
}
async function main() {
 const askSource = fs.readFileSync(require.resolve('../src/ask'), 'utf8');
 // Execute the actual local-answer functions with a fake, chunked engine.
 for (const flagged of [true, false]) {
  for (const [reply, rejecting] of [["I'm not interested in chatting with you right now… reach out to a trusted adult…", true], ["Hey, I'm here.", false], ['Call 911. Keep talking.', false], ['Keep talking. Call 911', false], ['', false], [' \t\n ', false]]) {
   const updates = [], statuses = [];
   let modelMessages;
   const prompt = require('../src/chat-prompt');
   const guard = require('../src/sensitive-guard');
   const local = vm.createContext({
    crisisConversation: flagged, CHAT_SYSTEM_PROMPT: prompt.CHAT_SYSTEM_PROMPT,
    CRISIS_FOLLOWUP_RULE: prompt.CRISIS_FOLLOWUP_RULE,
    window: { SovereignSensitiveGuard: guard, SovereignChatPrompt: prompt },
    priorConversationContext: () => [], attachmentPrompt: q => q,
    selectedAttachmentSources: () => [], sensitiveModelPending: null, messages: [],
    updateAssistant: (_id, value) => updates.push(value), setStatus: value => statuses.push(value),
    getEngineApi: () => ({ summarize: async (input, chunk) => {
     modelMessages = input;
     chunk(reply.slice(0, 12));
     if (!flagged) assert.ok(!updates.at(-1).content.includes('911') && (!reply.startsWith('Keep talking.') || updates.at(-1).content === ''), 'G86');
     assert.ok(updates.length === (flagged ? 0 : 1), 'G80');
     chunk(reply.slice(12));
     assert.ok(updates.length === (flagged ? 0 : 2), 'G81');
    } })
   });
   vm.runInContext(body('safeStreamingReply', askSource)+'\n'+body('directMessages', askSource)+'\n'+body('streamLocalAnswer', askSource), local);
   await local.streamLocalAnswer('hey', 'fixture');
   assert.ok(updates.at(-1).content === (flagged && (rejecting || !reply.trim()) ? guard.FOLLOWUP_REPLY : guard.sanitizeModelReply(reply).text.trim() || 'I could not produce an answer.'), 'G82');
   assert.ok(modelMessages[0].content === prompt.CHAT_SYSTEM_PROMPT + (flagged ? ' '+prompt.CRISIS_FOLLOWUP_RULE : ''), 'G83');
   assert.ok(!flagged || statuses[0] === 'Writing a reply…', 'G84');
  }
 }

 const guard5 = require('../src/sensitive-guard');
 for (const [question, crisis] of [["i'm going to shoot up tonight", false], ['I want to kill myself', true]]) {
  const messages = []; let localCalls = 0;
  const ctx = vm.createContext({window:{SovereignSensitiveGuard:guard5,SovereignMediaIntent:{isMediaRequest:()=>false}},
   crisisConversation:true, networkOffline:false, privacySettings:{sensitiveTopics:'strict'}, messages,
   attachmentSnapshot:()=>[], messageId:()=>String(messages.length), requireSaveConsent(){}, startLocalAskReceipt:async()=>{},
   setRunning(){}, persistCurrentChat(){}, renderThread(){}, updateAssistant:(id, patch)=>Object.assign(messages.find(m=>m.id===id),patch),
   ensureModelReady:async()=>true, streamLocalAnswer:async()=>{localCalls++;}, webToggle:{},
  });
  vm.runInContext(body('showSensitiveAnswer',askSource)+'\n'+body('answerQuestion',askSource),ctx);
  await ctx.answerQuestion(question,{appendUser:true});
  assert.ok(crisis ? messages.at(-1).content===guard5.CRISIS_REPLY && localCalls===0 : messages.at(-1).sensitive.categories.includes('drugs-alcohol') && localCalls===1, 'G87');
 }

 // Render the production locked notice, without an override action.
 class NoticeElement {
  constructor() { this.children=[]; this.dataset={}; }
  append(...items) { this.children.push(...items); }
  prepend(...items) { this.children.unshift(...items); }
 }
 const renderContext=vm.createContext({document:{createElement:()=>new NoticeElement()}, crisisConversation:true,
  window:{SovereignSensitiveGuard:guard5,SovereignSensitiveUI:{render(){throw new Error('G88');}}},
  renderRichText(){}, renderSources(){}, renderMediaCards(){} });
 vm.runInContext(body('renderMessage',askSource),renderContext);
 const rendered=renderContext.renderMessage({id:'fixture',role:'assistant',content:'',sensitive:guard5.classifyQuestion("i'm going to shoot up tonight")});
 assert.ok(rendered.children[1].children[0].children[0].textContent===guard5.notSentSentence(['drugs-alcohol']), 'G88');
 const streamContext=vm.createContext({window:{SovereignSensitiveGuard:guard5}});
 vm.runInContext(body('safeStreamingReply',askSource),streamContext);
 for (const [input, expected] of [['Hello. unfinished','Hello.'],['Hello\nunfinished','Hello\n'],['Call 911',''],['```\ncall 911',''],['`call 911','']]) {
  assert.ok(streamContext.safeStreamingReply(input)===expected, 'G89');
 }
 assert.ok(body('streamWebAnswer',askSource).includes('safeStreamingReply(output)') && body('streamWebAnswer',askSource).includes('sanitizeModelReply(finalResult.answer)'), 'G90');
 assert.ok(body('streamLocalAnswer', askSource).includes('isRejectingReply'), 'G85');
 const searchSource = fs.readFileSync(require.resolve('../src/search'), 'utf8');
 const before = (text, first, second, id) => assert.ok(text.indexOf(first) >= 0 && text.indexOf(first) < text.indexOf(second), id);
 before(body('handleSearchQuery'), 'crisis', 'refuseWebWhileOffline', 'G14');
 before(body('handleMediaSearch'), 'crisis', 'refuseWebWhileOffline', 'G15');
 before(body('runSearch', searchSource), 'classifyQuestion', 'networkOffline', 'G16');
 before(body('submitQuestion', askSource), 'crisis', "item.status === 'extracting'", 'G17');
 before(body('runInlineMediaSearch', askSource), 'crisis', 'networkOffline', 'G18');
 before(body('retryLast', askSource), 'crisis', 'needsReprocess', 'G19');
 before(body('handleReadSources'), 'crisis', 'refuseWebWhileOffline', 'G20');
 const receipts = require('../src/privacy-receipt'); receipts.resetForTests();
 let calls = 0, sent = '', activity = [], offline = false, savedChats = [];
 const context = vm.createContext({
  sensitiveGuard: require('../src/sensitive-guard'), privacySettings: { sensitiveTopics: 'strict' },
  privacyReceipts: receipts, searchSettings: { endpoint: 'http://localhost:8080/' },
  assignPrivacyReceiptToSender() {}, findTabBySender: () => ({ tab: { kind: 'ask' } }),
  datasetWindow: null, activeSearchRequests: new Map(), allowedSearchRequests: new Map(),
  rememberAllowedSearch() {}, normalizeSearxngEndpoint: value => value,
  refuseWebWhileOffline() { if (offline) throw new Error('G11'); }, AbortController, URL,
  requestActivityEntry: value => value, pushSearchActivity: value => activity.push(value),
  searchActivityEvents: [], makeReceiptFetch() {}, recordSearxngForwardingSafely() {},
  searchSearxng: async input => { calls++; sent = input.query; return { query: sent, results: [] }; },
  // Round 6: per-chat web lock helpers run for real; saved chats come from this fake store.
  lockedChatIds: new Set(), chatStore: () => ({ list: () => savedChats }),
  FIXED_CRISIS_REPLIES: () => { const g = require('../src/sensitive-guard'); return [g.CRISIS_REPLY, g.HARM_REPLY]; }, require
 });
 vm.runInContext([body('lockChat'), body('chatIsLocked'), body('refuseLockedChat'), body('sensitiveGate'), body('handleSearchQuery')].join('\n'), context);
 const event = { sender: { id: 7 } };
 const marker = 'SECRETQ-7731';
 // Each request names its own chat, so a crisis request doesn't lock the next case.
 const run = (query, extra = {}) => context.handleSearchQuery(event, { query, requestId: 'gate-' + Math.random(), chatId: 'gate-chat-' + Math.random(), ...extra });
 const refusal = await run('I have a fever ' + marker);
 assert.ok(refusal.sensitive && calls === 0, 'G1');
 assert.ok(!JSON.stringify([activity, receipts.exportPayload()]).includes(marker), 'G2');
 await run('I have a fever call 415-555-0134', { override: true });
 assert.ok(calls === 1 && sent === 'I have a fever call', 'G3');
 await run('I want to kill myself', { override: true });
 assert.ok(calls === 1, 'G4');
 const strict = await run('symptoms of type 2 diabetes', { strictness: 'standard' });
 assert.ok(strict.sensitive && calls === 1, 'G5');
 offline = true;
 const crisis = await run('I want to kill myself ' + marker);
 assert.ok(crisis.sensitive && crisis.level === 'crisis' && calls === 1, 'G11');
 vm.runInContext(body('handleMediaSearch'), context);
 const mediaCrisis = await context.handleMediaSearch(event, { query: 'I want to kill myself ' + marker, requestId: 'media-crisis' });
 assert.ok(mediaCrisis.sensitive && mediaCrisis.level === 'crisis' && calls === 1, 'G12');
 assert.ok(!JSON.stringify(receipts.exportPayload()).includes(marker), 'G13');
 offline = false;
 // Task 1c: every crisis gate handles harm, even offline and with override.
 for (const isOffline of [false, true]) {
  offline = isOffline;
  for (const query of ['I want to hurt someone', 'I want to kill myself']) {
   const previous = calls;
   const result = await run(query, { override: true });
   assert.ok(result.level === 'crisis' && calls === previous, 'G14');
   assert.ok((await context.handleMediaSearch(event, {query, override:true, chatId:'gate-media-'+Math.random()})).level === 'crisis' && calls === previous, 'G15');
   vm.runInContext(body('handleReadSources'), context);
   assert.ok((await context.handleReadSources(event, {question:query, override:true, chatId:'gate-read-'+Math.random()})).level === 'crisis', 'G20');
  }
 }
 offline = false;
 const previous = calls;
 await run('my husband hits me, call me at 415-555-0134', {override:true});
 assert.ok(calls === previous + 1 && !sent.includes('415') && sent.includes('hits me'), 'G21');
 await run('my husband hits me '+marker);
 assert.ok(!JSON.stringify([activity, receipts.exportPayload()]).includes(marker), 'G22');
 // Round 6: a locked chat is refused in main before any search, for every web handler.
 offline = false;
 const lockedId = 'locked-chat';
 await run('I want to hurt someone', { chatId: lockedId });
 const lockedBefore = calls;
 const lockedResult = await run('weather in Paris ' + marker, { chatId: lockedId });
 assert.ok(lockedResult.locked === true && calls === lockedBefore, 'L1');
 assert.ok((await context.handleMediaSearch(event, { query: 'pictures of cats', requestId: 'm-locked', chatId: lockedId })).locked === true && calls === lockedBefore, 'L2');
 assert.ok((await context.handleReadSources(event, { question: 'weather', requestId: 'r-locked', chatId: lockedId, results: [] })).locked === true, 'L3');
 const lockedReceipts = receipts.getReceipts().filter(r => r.entries.some(e => e.category === 'locked'));
 assert.ok(lockedReceipts.length >= 1 && lockedReceipts.every(r => r.query === '' && r.summary.startsWith('Not sent: web search is off')), 'L4');
 assert.ok(!JSON.stringify(receipts.exportPayload()).includes(marker) && !JSON.stringify(receipts.exportPayload()).includes('weather in Paris'), 'L5');
 await assert.rejects(() => context.handleSearchQuery(event, { query: 'weather', requestId: 'no-chat' }), /must name their chat/, 'L6');
 savedChats = [{ id: 'saved-locked', webLocked: true, messages: [] }];
 assert.ok((await run('weather in Rome', { chatId: 'saved-locked' })).locked === true && calls === lockedBefore, 'L7');
 const searchTab = context.findTabBySender;
 context.findTabBySender = () => ({ tab: { kind: 'search' } });
 await context.handleSearchQuery(event, { query: 'weather in Oslo', requestId: 'search-page' });
 assert.ok(calls === lockedBefore + 1, 'L8');
 context.findTabBySender = searchTab;
 for (const name of ['handleSearchQuery', 'handleMediaSearch', 'handleReadSources']) {
  before(body(name), 'refuseLockedChat', 'refuseWebWhileOffline', 'L9');
 }
 before(body('handleSearchQuery'), 'refuseLockedChat', 'searchSearxng', 'L10');
 // The Ask page checks webAllowedNow() right before each search call.
 for (const [fn, call] of [['streamWebAnswer', 'search.query'], ['streamWebAnswer', 'search.readSources'], ['streamMediaAnswer', 'search.media']]) {
  const text = body(fn, askSource);
  const callAt = text.indexOf(call);
  assert.ok(callAt > 0 && text.lastIndexOf('webAllowedNow(options.useWeb)', callAt) >= 0, 'L11');
 }
 // The lock and Offline mode are read live; the checkbox is not (UI resets can untick it mid-answer).
 assert.ok(!body('webAllowedNow', askSource).includes('disabled') && body('webAllowedNow', askSource).includes('crisisConversation') && !body('webAllowedNow', askSource).includes('webToggle'), 'L12');
 const uiSource = fs.readFileSync(require.resolve('../src/sensitive-ui'), 'utf8');
 assert.ok(uiSource.includes('crisisReply') && uiSource.includes("level === 'crisis'"), 'G23');
 const guard = require('../src/sensitive-guard');
 for (const [id, text] of [['G16',searchSource],['G17',askSource],['G18',askSource],['G19',askSource]]) {
  assert.ok(guard.classifyQuestion('I want to hurt someone').level === 'crisis' && text.includes('classifyQuestion'), id);
 }
 // Execute the actual IPC save handler with a fake disk; inspect booleans only.
 let saveHandler, writes = 0;
 const saveContext = vm.createContext({ sensitiveGuard:guard, chatSenderTab(){}, aiSettings:{saveChatsOnDevice:true},
  chatStore:()=>({save(){writes++;}}), broadcastSavedChats:()=>({chats:[]}), pendingChatConsents:new Map(),
  ipcMain:{handle(_name, handler){saveHandler=handler;}},
  lockedChatIds:new Set(), FIXED_CRISIS_REPLIES:()=>[guard.CRISIS_REPLY, guard.HARM_REPLY] });
 vm.runInContext(body('lockChat'), saveContext);
 vm.runInContext(source.slice(source.indexOf("ipcMain.handle('chats:save'"), source.indexOf("ipcMain.handle('chats:delete'")), saveContext);
 for (const content of ['I want to kill myself','I want to hurt someone','my husband hits me']) {
  const result = saveHandler(event,{id:'consent-fixture',messages:[{role:'user',content}]});
  assert.ok(result?.needsConsent === true && writes === 0, 'G24');
 }
 for (const content of [guard.CRISIS_REPLY,guard.HARM_REPLY]) assert.ok(saveHandler(event,{id:'consent-fixture',messages:[{role:'assistant',content}]}).needsConsent && writes === 0,'G25');
 saveHandler(event,{id:'consent-fixture',saveConsent:true,messages:[{role:'user',content:'my husband hits me'}]});
 assert.ok(writes === 1,'G26');
 // Round 6: saving a chat with webLocked (or a fixed crisis reply) locks it in main.
 saveHandler(event,{id:'locked-by-flag',saveConsent:true,webLocked:true,messages:[{role:'user',content:'hello'}]});
 assert.ok(saveContext.lockedChatIds.has('locked-by-flag'),'L13');
 // Source grants are sender-scoped, URL-scoped, expiring and consumed.
 let reads = 0;
 context.privacyReceiptIdForSender = () => '';
 context.readSourcePages = async () => { reads++; return { sources: [] }; };
 vm.runInContext(body('handleReadSources'), context);
 const sourceInput = { requestId:'source', chatId:'source-chat', question:'fixture', results:[{url:'https://example.test/source'}] };
 const blockedRead = async id => {
  let blocked = false; try { await context.handleReadSources(event, sourceInput); } catch { blocked = true; }
  assert.ok(blocked && reads === 0, id);
 };
 await blockedRead('G6');
 context.allowedSearchRequests.set('source', {senderId:8, expires:Date.now()+10000, urls:new Set(['https://example.test/source'])});
 await blockedRead('G7');
 context.allowedSearchRequests.set('source', {senderId:7, expires:0, urls:new Set(['https://example.test/source'])});
 await blockedRead('G8');
 context.allowedSearchRequests.set('source', {senderId:7, expires:Date.now()+10000, urls:new Set(['https://example.test/other'])});
 await blockedRead('G9');
 context.allowedSearchRequests.set('source', {senderId:7, expires:Date.now()+10000, urls:new Set(['https://example.test/source'])});
 await context.handleReadSources(event, sourceInput);
 assert.ok(reads === 1 && !context.allowedSearchRequests.has('source'), 'G10');
 // Run the editor itself with a small local DOM fixture, including recovery.
 class Element {
  constructor(tag) { this.tag=tag; this.style={}; this.children=[]; this.events={}; this.textContent=''; this.value=''; this.disabled=false; }
  append(...children) { this.children.push(...children); }
  setAttribute() {} focus() {} remove() {}
  addEventListener(name, callback) { this.events[name]=callback; }
  querySelector(selector) { return this.children.find(child=>child.className?.split(' ').includes(selector.slice(1))) || this.children.map(child=>child.querySelector(selector)).find(Boolean); }
 }
 for (const ask of [false,true]) {
  let sends=0, crises=0;
  const window={SovereignSensitiveGuard:guard};
  vm.runInNewContext(uiSource,{window,document:{createElement:tag=>new Element(tag)}});
  const container=new Element('div');
  window.SovereignSensitiveUI.render(container,{question:'my husband hits me',result:guard.classifyQuestion('my husband hits me'),send(){sends++;},...(ask?{onCrisis(){crises++;}}:{})});
  container.querySelector('.sensitive-anyway').events.click();
  const input=container.querySelector('.sensitive-query'), preview=container.querySelector('.sensitive-preview'), send=container.querySelector('.sensitive-send');
  for (const [question,reply] of [['I want to kill myself',guard.CRISIS_REPLY],['I want to hurt someone',guard.HARM_REPLY],['I want to kill myself and my ex',guard.CRISIS_REPLY]]) {
   input.value=question; input.events.input(); send.events.click();
   assert.ok(preview.textContent===reply && send.disabled && sends===0, 'G27');
  }
  input.value='ordinary fixture'; input.events.input();
  assert.ok(preview.textContent==='ordinary fixture' && send.disabled===ask && (ask ? crises>0 : crises===0), 'G28');
 }
 // Main owns pending choices after the renderer closes. No disk or sockets here.
 const {EventEmitter}=require('node:events');
 const handlers={}, pending=new Map(); let removed=[], deletedReceipts=0;
 const owner=new EventEmitter(); owner.id=101;
 const lifecycle=vm.createContext({pendingChatConsents:pending,consentWatchers:new WeakSet(),
  chatSenderTab(){}, chatStore:()=>({remove(id){removed.push(id);}}), privacyReceipts:{deleteReceipts(){deletedReceipts++;}}, broadcastSavedChats(){},
  ipcMain:{handle(name,fn){handlers[name]=fn;}}});
 vm.runInContext(body('discardPendingChat')+'\n'+source.slice(source.indexOf("ipcMain.handle('chats:pending-consent'"),source.indexOf('let legacyRemovalsInFlight')),lifecycle);
 handlers['chats:pending-consent']({sender:owner},'pending-fixture');
 owner.emit('destroyed');
 assert.ok(removed.includes('pending-fixture') && deletedReceipts===1 && pending.size===0,'G29');
 const other=new EventEmitter(); other.id=102;
 handlers['chats:pending-consent']({sender:other},'pending-reload');
 other.emit('did-start-navigation',{},'sovereign://ask/',false,true);
 assert.ok(removed.includes('pending-reload') && pending.size===0,'G30');
 const consentSource=body('renderSaveConsent',askSource);
 assert.ok(consentSource.includes("Save this chat? Anyone using this computer could see it.") && consentSource.includes(" Don't save will also remove the earlier part of this chat from this device."),'G31');
 before(body('answerQuestion',askSource), 'requireSaveConsent(classification)', 'ensureModelReady', 'G32');
 assert.ok(body('newChat',askSource).includes('declineChatSave') && source.includes('for (const id of pendingChatConsents.keys()) discardPendingChat(id)'), 'G33');
 // Exercise the production Strict check without loading a model or any network.
 let modelCalls=0, stops=0, modelOutput='medical', hang=false;
 const modelContext = vm.createContext({
  privacySettings:{sensitiveTopics:'strict'}, engineLoaded:false, sensitiveModelPending:null,
  window:{SovereignSensitiveGuard:require('../src/sensitive-guard')},
  setTimeout: (callback, ms) => { assert.ok(ms === 4000, 'M7'); if (hang) { queueMicrotask(callback); return null; } return setTimeout(callback, ms); }, clearTimeout,
  getEngineApi:()=>({summarize:async (_messages,chunk)=>{modelCalls++; if(hang) return new Promise(()=>{}); chunk(modelOutput);}, stop:async()=>{stops++;}})
 });
 vm.runInContext(body('strictModelFlag', fs.readFileSync(require.resolve('../src/ask'),'utf8')), modelContext);
 assert.ok(await modelContext.strictModelFlag('fixture') === '' && modelCalls === 0, 'M1');
 modelContext.engineLoaded=true;
 assert.ok(await modelContext.strictModelFlag('fixture') === 'medical' && modelCalls === 1, 'M2');
 modelContext.privacySettings.sensitiveTopics='standard';
 assert.ok(await modelContext.strictModelFlag('fixture') === '' && modelCalls === 1, 'M3');
 modelContext.privacySettings.sensitiveTopics='strict'; modelOutput='crisis';
 assert.ok(await modelContext.strictModelFlag('fixture') === '', 'M4');
 modelOutput='medical explanation'; assert.ok(await modelContext.strictModelFlag('fixture') === '', 'M5');
 for (const category of ['self-harm','harm-to-others','abuse']) { modelOutput=category; assert.ok(await modelContext.strictModelFlag('fixture') === '', 'M8'); }
 hang=true; assert.ok(await modelContext.strictModelFlag('fixture') === '' && stops >= 1, 'M6');
 console.log('sensitive-gate tests passed');
}
main().catch(error => { console.error(/^[GM]\d+$/.test(error.message) ? error.message : 'G0'); process.exitCode = 1; });
