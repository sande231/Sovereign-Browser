// Pure tests: failure output contains case ids only.
'use strict';
const fs = require('node:fs');
const k = require('../src/knowledge-backend');
const search = require('../src/search-utils');
let trust;
try { trust = require('../src/answer-trust'); } catch {}
const sources = k.parseSearchXml(fs.readFileSync(require.resolve('./fixtures/kiwix-search.xml'), 'utf8')).map((s,i) => k.normalizeKiwixResult(s, 'http://127.0.0.1:8090', i));
const eclipse = 'Total solar eclipses occur somewhere on Earth every 18 months on average [1].';
const padded = eclipse + ' They are the most beautiful sight in nature.';
const antarctica = sources.find(s => s.title === 'Antarctica');
const animal = sources.find(s => s.title === 'Animal');
const tests = [];
const test = (id, fn) => tests.push([id, fn]);
const eq = (a,b) => require('node:assert/strict').deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
const ok = value => { if (!value) throw Error(); };
const label = (answer, extra={}) => trust.computeTrustLabel({answer, sources, ...extra});
const q = text => trust.extractQuantities(text);
// R3.15 F2: the question decides which kind of number is compared, so tests name the question.
const disagreement = (answer, snippets, question='', outcome) => trust.findDisagreements({answer, sources: snippets.map(snippet=>({snippet})), question, outcome});
const TEMP_Q='What is the lowest temperature recorded in Antarctica?', TALL_Q='How tall is Mount Everest?', YEAR_Q="When were Antarctica's ice shelves first seen?", POP_Q='What is the population of China?';
test('AT1',()=>eq(label(eclipse),'supported'));
test('AT2',()=>eq(label(padded),'partly-supported'));
test('AT3',()=>{for(const answer of ['The search snippets are insufficient to answer that.','No local results found.','I could not find search results for that question.','Evidence is insufficient [1].'])eq(label(answer),'not-found');eq(label(eclipse,{outcome:'insufficient-evidence'}),'not-found');});
test('AT4',()=>{eq(label('Supported: trust me [9].',{sources:sources.slice(0,5)}),'not-found');eq(label('Claim [1].',{sources:[{snippet:' '}]}),'not-found');eq(label(eclipse,{sources:[]}),'not-found');eq(label('Supported: trust me.'),'not-found');});
test('AT5',()=>{eq(label(eclipse+' '+search.LIMITED_DETAIL_SENTENCE),'supported');eq(label('A claim. [2] Another claim [1].'),'supported');eq(label(''),'not-found');});
test('AT6',()=>{eq(trust.decideTrust({answer:'An answer.',sources:[],path:'ai'}).label,'no-sources');eq(trust.decideTrust({answer:'fixed',path:'ai',fixed:true}),null);eq(trust.decideTrust({answer:eclipse,sources,path:'ai',attachments:true}),null);});
test('AT7',()=>{for(const [unit,value] of [['mm',.001],['cm',.01],['m',1],['metres',1],['meters',1],['km',1000],['kilometres',1000],['ft',.3048],['feet',.3048],['foot',.3048],['mi',1609.344],['miles',1609.344],['inch',.0254],['inches',.0254]])eq(q('1 '+unit)[0].value,value);});
test('AT8',()=>{for(const [text,kind,value] of [['1 g','mass',.001],['1 kg','mass',1],['1 tonnes','mass',1000],['1 tonne','mass',1000],['1 pound','mass',.45359237],['1 km²','area',1e6],['1 km2','area',1e6],['1 square kilometres','area',1e6],['1 sq mi','area',2589988.110336],['1 square miles','area',2589988.110336],['32 °F','temperature',0],['5 per cent','percent',5],['5%','percent',5],['5 percent','percent',5],['1.4 billion people','count',1.4e9],['population of 1,412,000,000','count',1412000000]]){eq(q(text)[0].kind,kind);ok(Math.abs(q(text)[0].value-value)<.000001);}});
test('AT9',()=>{eq(q('33.6 m (110 ft)').length,1);eq(q('−89.2 °C (−128.6 °F)').length,1);eq(q('360 to 410 years; 5–10 m; 5-10 km; about 4 m; approximately 8 kg; 8.5 μm; 12; [17]'),[]);});
test('AT10',()=>{eq(q('−89.2 °C')[0].value,-89.2);eq(q('-1,200.5 m')[0].value,-1200.5);eq(q('1.4 billion inhabitants')[0].precision,1e8);});
test('AT11',()=>{eq(q('1820 [17] 2101'),[]);eq(q('in 1820 and since 2000 and March 2026').map(v=>v.value),[1820,2000,2026]);});
test('AT12',()=>{ok(q(antarctica.snippet).some(v=>v.value===-89.2));ok(q(antarctica.snippet).some(v=>v.value===1820));ok(q(animal.snippet).some(v=>v.value===33.6));ok(!q(animal.snippet).some(v=>v.raw.includes('110')));});
test('AT13',()=>{eq(disagreement('The lowest temperature recorded in Antarctica was −89.2 °C [1] [2].',[antarctica.snippet,'The lowest temperature on Earth, −89.6 °C, was recorded at Vostok Station in Antarctica.'],TEMP_Q),[]);eq(disagreement('The lowest temperature recorded in Antarctica was −89.2 °C [1] [2].',['The lowest temperature recorded in Antarctica was −89.2 °C (−128.6 °F).','The lowest temperature on Earth, −89.6 °C, was recorded at Vostok Station in Antarctica.'],TEMP_Q)[0].map(v=>v.raw+' ['+v.citation+']'),['−89.2 °C [1]','−89.6 °C [2]']);});
test('AT14',()=>{eq(disagreement('Mount Everest is 8,849 m high [1] [2].',['Mount Everest is 8,849 m high.','Mount Everest is 29,032 ft high.'],TALL_Q),[]);ok(disagreement('Mount Everest is 8,849 m high [1] [2].',['Mount Everest is 8,849 m high.','Mount Everest is 8,848 m high.'],TALL_Q).length===1);eq(disagreement('Mount Everest is 8,849 m high [1] [2].',['Mount Everest is 8,848.86 m high.','Mount Everest is 8,849 m high.'],TALL_Q),[]);eq(disagreement('China population is 1.4 billion people [1] [2].',['China population is 1.4 billion people.','China population is 1,412,000,000 people.'],POP_Q),[]);});
test('AT15',()=>ok(disagreement('Antarctica ice shelves were first seen in 1820 [1] [2].',[antarctica.snippet,"Antarctica's ice shelves were first sighted in 1821."],YEAR_Q).length===1));
test('AT16',()=>{eq(disagreement('Mount Everest is 8,849 m high [1].',['Mount Everest is 8,849 m high. Mount Everest is 8,848 m high.','Mount Everest is 2 m high.'],TALL_Q),[]);eq(disagreement('Mount Everest is 8,849 m high [1] [2].',['Mount Everest is 8,849 m high. Mount Everest is 8,848 m high.','Nothing here.'],TALL_Q),[]);});
test('AT17',()=>{for(const question of ['',TEMP_Q,TALL_Q,YEAR_Q,POP_Q])for(let i=0;i<sources.length;i++)for(let j=i+1;j<sources.length;j++)eq(disagreement(sources[i].snippet+' [1]. '+sources[j].snippet+' [2].',[sources[i].snippet,sources[j].snippet],question),[]);});
test('AT18',()=>{const q='How tall are Everest, Lhotse and Makalu?';const snips=[1,2,3,4].map(n=>`Everest height is ${n} m. Lhotse height is ${n+10} m. Makalu height is ${n+20} m.`);const d=disagreement('Everest height is 5 m [1] [2] [3] [4]. Lhotse height is 15 m [1] [2] [3] [4]. Makalu height is 25 m [1] [2] [3] [4].',snips,q);eq(d.length,2);eq(d[0].length,3);ok(d.every(g=>new Set(g.map(v=>v.citation)).size===g.length));});
test('AT19',()=>eq(trust.formatKnowledgeDate([{origin:'local',bookDate:'2026-08-20',bookTitle:'Wikipedia 100'}]),'Local knowledge as of 20 August 2026 (Wikipedia 100).'));
test('AT20',()=>{eq(trust.formatKnowledgeDate([{bookDate:'2026-08',bookTitle:'Wiki'},{bookDate:'',bookTitle:'Travel'}]),'Local knowledge as of August 2026 (Wiki); an unknown date (Travel).');eq(trust.formatKnowledgeDate([{book:'Wiki'}]),'Local knowledge as of an unknown date (Wiki).');});
test('AT21',()=>eq(trust.formatRetrievedAt(new Date(2026,10,17,14,5).toISOString()),'Web sources retrieved 17 November 2026 at 14:05.'));
test('AT22',()=>{eq(search.finalizeSearchAnswerWithMeta(padded,sources,'How often are total solar eclipses?').removedUnsupported,1);eq(trust.removedText(1),'1 sentence without a source was removed.');});
test('AT23',()=>{const r=search.finalizeSearchAnswerWithMeta('Solar eclipses are rare [7]. '+eclipse+' People once feared them.',sources.slice(0,5),'How often are total solar eclipses?');eq(r.outcome,'checked-ai-answer');eq(r.removedUnsupported,2);eq(trust.removedText(2),'2 sentences without a source were removed.');});
test('AT24',()=>eq(search.finalizeSearchAnswerWithMeta('Eclipses are caused by dragons.',sources,'How often are total solar eclipses?').removedUnsupported,0));
test('AT25',()=>eq(search.finalizeSearchAnswerWithMeta(eclipse+' '+eclipse,sources,'How often are total solar eclipses?').removedUnsupported,0));
test('AT26',()=>{eq(trust.decideTrust({answer:'A reply.',path:'ai',crisisConversation:true}),null);eq(trust.decideTrust({answer:eclipse,sources,path:'local',crisisConversation:true}).label,'supported');eq(trust.decideTrust({answer:'No local results found.',sources:[],path:'local',crisisConversation:true}).label,'not-found');});

test('AT27',()=>{eq(q('10 km/h; 20 m per second; 5 m to 10 m; about 2 billion people; approximately a population of 20'),[]);eq(q('Height is 5 m. Speed is 10 km/h.').map(v=>v.value),[5]);});
test('AT28',()=>{
 const vm=require('node:vm'), source=fs.readFileSync(require.resolve('../src/ask'),'utf8');
 const body=name=>{const start=source.indexOf('function '+name+'(');return source.slice(start,source.indexOf('\n}',start)+2);};
 const guard=require('../src/sensitive-guard');
 const ctx=vm.createContext({window:{SovereignAnswerTrust:trust,SovereignSensitiveGuard:guard,SovereignMediaIntent:require('../src/media-intent')},
  networkOffline:false,crisisConversation:false,privacySettings:{sensitiveTopics:'strict'},renderThread(){},messages:[],
  safeMarkdownUrl:v=>v});
 vm.runInContext(['isFixedTrustReply','canOfferTrustWeb','finishAnswerTrust','savedMessage'].map(body).join('\n'),ctx);
 const m={id:'case',role:'assistant',content:'No local results found.',sources:[]};ctx.messages.push(m);
 ctx.finishAnswerTrust('case','Earth',{path:'local'});ok(ctx.canOfferTrustWeb(m));
 const saved=ctx.savedMessage(m);eq(saved.trust,m.trust);ok(ctx.canOfferTrustWeb(saved));
 ctx.networkOffline=true;ok(!ctx.canOfferTrustWeb(saved));ctx.networkOffline=false;
 ctx.crisisConversation=true;ok(!ctx.canOfferTrustWeb(saved));ctx.crisisConversation=false;
 for(const question of ['I have a fever','show me images of Earth'])ok(!ctx.canOfferTrustWeb({...saved,action:{type:'search-web',question}}));
 ctx.finishAnswerTrust('case','Earth',{path:'local',usedWeb:true});ok(!ctx.canOfferTrustWeb(m));
 for(const content of [guard.CRISIS_REPLY,guard.HARM_REPLY,guard.FOLLOWUP_REPLY,guard.ABUSE_RESOURCES,guard.CRISIS_SHORT_LINE]){
  m.content=content;ctx.finishAnswerTrust('case','Earth',{path:'local'});eq(m.trust,null);ok(!ctx.savedMessage({...m,trust:{label:'supported'}}).trust);
 }
 m.content='A local response.';ctx.finishAnswerTrust('case','Earth',{path:'ai',crisisAtStart:true});eq(m.trust,null);
 m.content=eclipse;m.sources=sources;ctx.finishAnswerTrust('case','Earth',{path:'ai',attachments:true});eq(m.trust,null);
});
test('AT29',()=>{
 const result=search.finalizeSearchAnswerWithMeta(eclipse+' This invented description has no supporting evidence. Another invented description has no supporting evidence.',sources,'How often are total solar eclipses?');
 eq(result.removedUnsupported,2);
 const incomplete=search.finalizeSearchAnswerWithMeta(eclipse+' Tiny.',sources,'How often are total solar eclipses?');eq(incomplete.removedUnsupported,0);
 eq(trust.decideTrust({answer:eclipse,sources,path:'local',outcome:'source-excerpts',removedUnsupported:3}).removed,0);
});
test('AT30',()=>{eq(trust.validateTrust({label:'model-invented'}),null);eq(trust.validateTrust({label:'supported',removed:-1,dates:['bad'],disagreements:[[{raw:'bad',citation:99}]]}),{label:'supported',localOnly:false,removed:0,disagreements:[],dates:[]});});
test('AT31',()=>{
 eq(q('born 1990 in Paris'),[]); eq(q('won 3 in a row'),[]);
 eq(q('Founded in 1820 in London').map(v=>[v.kind,v.value]),[['year',1820]]);
 eq(q('It weighs 5 t.'),[]); eq(q('It weighs 5 tonnes.').map(v=>[v.kind,v.value]),[['mass',5000]]);
});
test('AT32',()=>eq(disagreement('Smith was born 1990 in Paris [1] [2].',['Smith was born 1990 in Paris.','Smith was born 1991 in Paris.']),[]));
test('AT33',()=>{
 for(const outcome of ['source-excerpts','snippet-excerpts','ai-generated','checked-ai-answer']) {
  eq(label('Insufficient sleep is linked to heart disease [1].',{outcome}),outcome.endsWith('excerpts')?'excerpts':'supported');
  for(const answer of ['The search snippets are insufficient to answer that.','No local results found.','I could not find search results for that question.']) eq(label(answer,{outcome}),'not-found');
 }
 eq(label('Insufficient sleep is linked to heart disease [1].',{outcome:'insufficient-evidence'}),'not-found');
});
test('AT34',()=>{
 const k=require('../src/knowledge-backend');
 const evidence=k.parseSearchXml(fs.readFileSync(require.resolve('./fixtures/kiwix-search-solar-eclipse.xml'),'utf8')).slice(0,1).map(s=>({...s,evidenceText:s.snippet,evidenceMode:'page'}));
 const result=search.finalizeSearchAnswerWithMeta('The search snippets are insufficient to answer that.',evidence,'What causes a solar eclipse?');
 eq(trust.computeTrustLabel({answer:result.answer,sources:evidence,outcome:result.outcome}),'excerpts');
});
test('AT35',()=>{eq(label('First sentence. Second sentence [1].\n\nUncited block.',{outcome:'source-excerpts'}),'not-found');eq(label('First sentence. Second sentence [1].',{outcome:'snippet-excerpts'}),'excerpts');});
test('AT36',()=>eq(label('First sentence. Second sentence [1].',{outcome:'ai-generated'}),'partly-supported'));
test('AT37',()=>{
 const vm=require('node:vm'), cp=require('node:child_process'), k=require('../src/knowledge-backend');
 const ctx=vm.createContext({module:{exports:{}},URL});vm.runInContext(cp.execFileSync('git',['show','HEAD:src/search-utils.js'],{encoding:'utf8'}),ctx);
 for(const name of ['solar-eclipse','yesterdays-match','fever']) {
  const evidence=k.parseSearchXml(fs.readFileSync(require.resolve('./fixtures/kiwix-search-'+name+'.xml'),'utf8')).map(s=>({...s,evidenceText:s.snippet,evidenceMode:'page'}));
  for(const answer of ['The search snippets are insufficient to answer that.',evidence[0].snippet+' [1].']) {
   const q=name==='solar-eclipse'?'What causes a solar eclipse?':name;
   const old=ctx.module.exports.finalizeSearchAnswerWithMeta(answer,evidence,q), now=search.finalizeSearchAnswerWithMeta(answer,evidence,q);
   for(const key of Object.keys(old).filter(k=>k!=='removedUnsupported'))eq(now[key],old[key]);
  }
 }
});

// R3.15 F2 (Sandeep, 2026-11-17): T5 only for the fact the question asks about, across 2+ sources.
const wc=k2=>require('../src/knowledge-backend').parseSearchXml(require('fs').readFileSync(require.resolve('./fixtures/kiwix-search-world-cup.xml'),'utf8'));
test('AT40',()=>{const items=wc().slice(0,3);const answer=items.map((it,i)=>it.snippet.replace(/\.*$/,'')+' ['+(i+1)+']').join('\n\n');const snips=items.map(it=>it.snippet);
 eq(disagreement(answer,snips,'Who won the World Cup yesterday?','source-excerpts'),[]);eq(disagreement(answer,snips,'Who won the World Cup yesterday?'),[]);eq(disagreement(answer,snips,'When did France win the World Cup?','source-excerpts'),[]);});
test('AT41',()=>eq(disagreement('Antarctica ice shelves were first seen in 1820 [1] [2].',['Antarctica ice shelves were first seen in 1820. Antarctica ice shelves were first seen in 1821.','Antarctica ice shelves were first seen in 1822.'],YEAR_Q),[]));
test('AT42',()=>eq(disagreement('Mount Everest is 8,849 m high [1] [2].',['Mount Everest is 8,849 m high.','Mount Everest is 8,848 m high.'],'Tell me about Mount Everest'),[]));
test('AT43',()=>{eq(disagreement('Mount Everest is 8,849 m high [1] [2].',['Mount Everest is 8,849 m high.','Mount Everest is 8,848 m high.'],TALL_Q).map(g=>g.map(v=>v.raw+' ['+v.citation+']').join(' · ')),['8,849 m [1] · 8,848 m [2]']);eq(disagreement('Mount Everest is 8,849 m high [1] [2].',['Mount Everest is 8,849 m high.','Mount Everest is 29,032 ft high.'],TALL_Q),[]);});
test('AT44',()=>{const t=trust.decideTrust({answer:'The lowest temperature recorded in Antarctica was −89.2 °C [1] [2].',sources:[{snippet:'The lowest temperature recorded in Antarctica was −89.2 °C (−128.6 °F).'},{snippet:'The lowest temperature on Earth, −89.6 °C, was recorded at Vostok Station in Antarctica.'}],path:'local',outcome:'ai-generated',question:TEMP_Q});
 eq(t.disagreements.map(g=>'Sources disagree: '+g.map(v=>v.raw+' ['+v.citation+']').join(' · ')+'. Check the sources.'),['Sources disagree: −89.2 °C [1] · −89.6 °C [2]. Check the sources.']);
 eq(trust.decideTrust({answer:'The lowest temperature recorded in Antarctica was −89.2 °C [1] [2].',sources:[{snippet:'The lowest temperature recorded in Antarctica was −89.2 °C (−128.6 °F).'},{snippet:'The lowest temperature on Earth, −89.6 °C, was recorded at Vostok Station in Antarctica.'}],path:'local',outcome:'source-excerpts',question:TEMP_Q}).disagreements,[]);});
test('AT45',()=>{const d=disagreement('Antarctica ice shelves were first seen in 1820 [1] [2] [3] [4].',['Antarctica ice shelves were first seen in 1820.','Antarctica ice shelves were first seen in 1821.','Antarctica ice shelves were first seen in 1821.','Antarctica ice shelves were first seen in 1823.'],YEAR_Q);ok(d.length===1);ok(new Set(d[0].map(v=>v.citation)).size===d[0].length&&d[0].length<=3);});

// R3.15 F3: the T9 "Search the web" handler never writes the web checkbox (static check on ask.js).
test('AT46',()=>{const src=fs.readFileSync(require.resolve('../src/ask.js'),'utf8');const start=src.indexOf("if (message.action?.type === 'search-web')");const end=src.indexOf("if (message.action?.type === 'answer-without-sources')",start);
 ok(start>0&&end>start);const block=src.slice(start,end);ok(!/webToggle\.checked\s*=(?!=)/.test(block)&&!/webToggle\.dispatchEvent/.test(block)&&/skipLocal:\s*true/.test(block)&&/webEnabled:\s*true/.test(block));});

// Retest bug: a source page repeated "Spain won it all…" and the excerpt fallback showed it twice, both [2].
test('AT47',()=>{const S='Spain won it all, defeating Argentina 1-0 in the final at the World Cup.',Q='Who won the World Cup?',lead={title:'A',url:'https://a.example',snippet:'Football news from the weekend roundup today.',evidenceMode:'snippet'};
 const page=p=>[lead,{title:'FOX',url:'https://b.example',evidenceMode:'page',selectedPassages:p}];
 const across=search.finalizeSearchAnswerWithMeta('',page([S+' The World Cup final was held in the stadium.','Fans celebrated across the country all night long. '+S.toUpperCase().replace(/\.$/,'')+'  .']),Q);
 eq(across.outcome,'source-excerpts');eq(across.answer.toLowerCase().split(S.toLowerCase()).length-1,1);ok(across.answer.startsWith(S));ok(across.answer.endsWith('Fans celebrated across the country all night long. [2]'));
 const within=search.finalizeSearchAnswerWithMeta('',page([S+' '+S+' The World Cup final was held in the stadium.']),Q);
 eq(within.answer,S+' The World Cup final was held in the stadium. [2]');});

for(const [id,fn] of tests){try{fn();}catch{console.error(id);process.exitCode=1;}}
if(!process.exitCode)console.log('answer-trust tests passed (AT1–AT47)');
