'use strict';
const fs = require('node:fs');
function check(id, ok) { if (!ok) throw new Error(id); }
async function main() {
 const k = require('../src/knowledge-backend');
 const endpoint = 'http://127.0.0.1:8090';
 check('KR1-api', typeof k.questionKeyTerms==='function' && typeof k.isRelevantLocalResult==='function');
 const cases=[['What causes a solar eclipse?','solar,eclipse'],["Who won yesterday's match?",'won,match'],['I have a fever','fever'],['What is the Earth?','earth'],['How tall is Mount Everest?','tall,mount,everest'],['When did World War II end?','world,war,ii,end']];
 for(const [i,[q,want]] of cases.entries())check('KR1-'+i,k.questionKeyTerms(q).join(',')===want);
 const relevant=(file,q)=>k.parseSearchXml(fs.readFileSync(require.resolve('./fixtures/kiwix-search'+file+'.xml'),'utf8')).filter(r=>k.isRelevantLocalResult(r,k.questionKeyTerms(q),q)).map(r=>r.title);
 for(const [id,file,q,want] of [['KR2','-solar-eclipse',cases[0][0],'Solar eclipse'],['KR3','-yesterdays-match',cases[1][0],''],['KR4','-fever',cases[2][0],''],['KR5','',cases[3][0],'']])check(id,relevant(file,q).join(',')===want);
 // R3.15 F1 (approved cost): an article whose title shares no key term is not used.
 check('KR6',!k.isRelevantLocalResult({title:'George Washington',snippet:'First president of the United States'},k.questionKeyTerms('first president of the United States'),'first president of the United States') && !k.isRelevantLocalResult({title:'Other',snippet:'Earth'},['earth'],'Earth'));
 check('KR7',k.isRelevantLocalResult({title:'Red panda'},k.questionKeyTerms('red pandas'),'red pandas'));
 for(const [file,q,title] of [['photosynthesis','How does photosynthesis work?','Photosynthesis'],['red-pandas','Tell me about red pandas','Red panda'],['earth-word','Earth','Earth'],['albert-einstein','Who was Albert Einstein?','Albert Einstein']]) {
  check('KR-keeps-'+file,relevant('-'+file+'-synthetic',q).join(',')===title);
  check('KR-negative-'+file,relevant('-'+file,q).length===0);
 }
 // Sky blue expects no source: approved R3.15 cost ("sky blue" read as a two-word subject).
 // Longer questions (Sandeep, 2026-11-17). Wikipedia 100 has none of these articles, so the real
 // captures must give Not found; the synthetic fixtures add the target with a realistic Kiwix snippet.
 for(const [file,q,title] of [['malaria-children','What are the symptoms of malaria in children?','Malaria'],['mount-everest','How tall is Mount Everest?','Mount Everest'],['tokyo-population','What is the population of Tokyo?','Tokyo'],['sky-blue','Why is the sky blue?','']]) {
  check('KR-long-keeps-'+file,relevant('-'+file+'-synthetic',q).join(',')===title);
  check('KR-long-negative-'+file,relevant('-'+file,q).length===0);
 }
 // R3.15 F1: one rule (title shares a key term; title+snippet cover 2/3; adjacent-word guard).
 check('KR-rule-world-cup',relevant('-world-cup',"Who won the World Cup yesterday?").length===0);
 check('KR-rule-sky-blue',relevant('-sky-blue-synthetic','Why is the sky blue?').length===0); // approved cost
 for(const [id,q,item,want] of [
  ['ww1-caps','Who won the World Cup yesterday?',{title:'World War I',snippet:'...the Allies <b>won</b> the war that changed the <b>world</b>...'},false],
  ['ww1-lower','who won the world cup yesterday',{title:'World War I',snippet:'...the Allies <b>won</b> the war that changed the <b>world</b>...'},false],
  ['fifa','Who won the World Cup yesterday?',{title:'FIFA World Cup',snippet:'...Argentina <b>won</b> the 2022 <b>World</b> <b>Cup</b>...'},true],
  ['world-cup-mens','Who won the World Cup yesterday?',{title:"World Cup (men's)",snippet:'...was <b>won</b> by...'},true],
  ['red-fox','Tell me about red pandas',{title:'Red fox',snippet:'...unlike the red <b>panda</b>, the <b>red</b> fox...'},false],
  ['population','What is the population of Tokyo?',{title:'Population',snippet:'...world population...'},false],
  ['match','who won yesterday\'s match',{title:'Match',snippet:'...a match is...'},false],
  ['ww2','When did World War II end?',{title:'World War II',snippet:'...the war <b>ended</b> in 1945...'},true],
  ['everest','How tall is Mount Everest?',{title:'Mount Everest',snippet:''},true],
  ['solar','What causes a solar eclipse?',{title:'Solar eclipse',snippet:''},true],
  ['france','capital of France',{title:'France',snippet:'Paris is the capital of France.'},true]
 ]) check('KR-hypo-'+id,k.isRelevantLocalResult(item,k.questionKeyTerms(q),q)===want);
 // Keyword-style questions: a title made only of key terms passes the adjacent-word guard.
 for(const [id,q,item,want] of [
  ['antarctica','Antarctica temperature record',{title:'Antarctica',snippet:'lowest temperature recorded'},true],
  ['antarctica-record','Antarctica temperature record',{title:'Antarctica record',snippet:'The lowest temperature on Earth was recorded in Antarctica'},true],
  ['tokyo','tokyo population',{title:'Tokyo',snippet:'population of over 14 million'},true],
  ['malaria','malaria symptoms children',{title:'Malaria',snippet:'symptoms include fever'},true],
  ['red-fox','red pandas',{title:'Red fox',snippet:'unlike the red panda'},false],
  ['ww1','world cup winner',{title:'World War I',snippet:'won the world'},false],
  ['population','tokyo population',{title:'Population',snippet:'world population'},false]
 ]) check('KR-keyword-'+id,k.isRelevantLocalResult(item,k.questionKeyTerms(q),q)===want);
 // Decoy (Sandeep, 2026-11-17): generic "Children" listed first by Kiwix. Malaria must be kept and
 // ordered first (title coverage, then title+snippet coverage, then Kiwix order).
 {const q='malaria symptoms children',t=k.questionKeyTerms(q);
  const items=k.parseSearchXml(fs.readFileSync(require.resolve('./fixtures/kiwix-search-malaria-children-decoy-synthetic.xml'),'utf8'));
  const kept=items.filter(r=>k.isRelevantLocalResult(r,t,q));
  check('KR-decoy-kept',kept.some(r=>r.title==='Malaria'));
  check('KR-decoy-order',typeof k.orderLocalResults==='function'&&k.orderLocalResults(kept,t,q)[0].title==='Malaria');
  check('KR-decoy-generic-kept',kept.some(r=>r.title==='Children')); // reported to Sandeep: the decoy passes the rule
  check('KR-order-stable',typeof k.orderLocalResults==='function'&&k.orderLocalResults([{title:'Solar eclipse',snippet:''},{title:'Solar eclipse',snippet:'x'}].map((r,i)=>({...r,id:i})),k.questionKeyTerms('solar eclipse'),'solar eclipse').map(r=>r.id).join()==='0,1');}
 check('K1', k.normalizeKiwixEndpoint() === endpoint);
 for (const [i, url] of ['http://localhost:8090','http://[::1]:8090','http://127.2.3.4:8090'].entries()) check('K2-'+i, !!k.normalizeKiwixEndpoint(url));
 for (const [i, url] of ['http://192.168.1.5:8090','https://127.0.0.1:8090','http://user:pass@127.0.0.1:8090','http://127.0.0.1:8090/a','http://127.0.0.1:8090/?q=x','http://example.test:8090','http://localhost.:8090','http://sub.localhost:8090','http://127.0.0.1:8080','http://127.0.0.1:9000'].entries()) {
  let refused=false; try { k.normalizeKiwixEndpoint(url,{blockedHostPorts:['127.0.0.1:8080','127.0.0.1:9000']}); } catch { refused=true; } check('K3-'+i, refused);
 }
 const url=new URL(k.buildSearchUrl(endpoint,{pattern:'earth & moon',books:['one','two'],pageLength:50}));
 check('K4',url.pathname==='/search' && url.searchParams.get('pattern')==='earth & moon' && url.searchParams.get('format')==='xml' && url.searchParams.get('pageLength')==='10' && url.searchParams.getAll('books.name').join(',')==='one,two' && [...url.searchParams].length===5);
 // Real kiwix-serve 3.8.2 responses captured in Sandeep's traffic test (2026-11-17).
 const xml=fs.readFileSync(require.resolve('./fixtures/kiwix-search.xml'),'utf8');
 const items=k.parseSearchXml(xml);
 check('K5',items.length===10 && items[0].title==='Solar eclipse' && items[0].url==='/content/wikipedia_en_100_2026-08/Solar_eclipse' && items[0].book==='Wikipedia 100' && items.at(-1).title==='World Heritage Site');
 // Real snippets carry raw <b> elements: their text must stay in document order.
 check('K5-order',items[0].snippet.startsWith('...of Earth, a solar eclipse can only be viewed') && !/[<>]/.test(items[0].snippet) && items[1].snippet.includes('8.5 μm'));
 // Edge cases the real feed may also send: escaped markup, CDATA, entities, absolute links.
 const edge=k.parseSearchXml('<rss version="2.0"><channel><item><title>Earth &amp; Moon</title><link>/content/wikipedia/Earth</link><description>A &lt;b&gt;planet&lt;/b&gt; in space.</description><book><title>Wikipedia</title></book></item><item><title>Paris</title><link>http://127.0.0.1:8090/content/travel/Paris</link><description><![CDATA[A <b>city</b>.]]></description><book><title>Travel</title></book></item></channel></rss>');
 check('K5-edge',edge.length===2 && edge[0].title==='Earth & Moon' && edge[0].snippet==='A planet in space.' && edge[1].snippet==='A city.');
 for(const [i,bad] of ['<rss><item></rss>',xml.slice(0,-8),'<rss><channel>&bogus;</channel></rss>','<!DOCTYPE rss><rss/>'].entries()) check('K6-'+i,k.parseSearchXml(bad).length===0);
 check('K7',k.normalizeKiwixResult(items[0],endpoint,0).origin==='local' && k.normalizeKiwixResult(items[0],endpoint,0).url===endpoint+'/content/wikipedia_en_100_2026-08/Solar_eclipse' && k.normalizeKiwixResult(edge[1],endpoint,1).id===2);
 check('K7-all',items.every((item,i)=>k.normalizeKiwixResult(item,endpoint,i)));
 // Wikipedia's own reference markers are stripped from local text (real fixture has [17], [131][132], [4]...).
 const marker=/\[\s*(?:\d+|note \d+|[a-z]|citation needed)\s*\]/i;
 check('K19-fixture-has',items.filter(item=>marker.test(item.snippet)).length>=4);
 const cleaned=items.map((item,i)=>k.normalizeKiwixResult(item,endpoint,i));
 check('K19-fixture',cleaned.every(item=>!marker.test(item.snippet)));
 check('K19-fixture-text',cleaned.find(item=>item.title==='Evolution').snippet.startsWith('...on Earth. Morphological and biochemical traits') && cleaned.find(item=>item.title==='Plant').snippet.includes('the sacred tree. Another widespread') && cleaned.find(item=>item.title==='Eukaryote').snippet.includes('a cell. Diversity'));
 for(const [i,[raw,want]] of [
  ['Earth is a planet [ 144 ] [ 145 ] [ 146 ] with oceans.','Earth is a planet with oceans.'],
  ['Earth is round.[144][145] It orbits.','Earth is round. It orbits.'],
  ['Mass[note 3] is large[ note 12 ].','Mass is large.'],
  ['Many species[a] live here[b][ c ].','Many species live here.'],
  ['It is old.[citation needed] Very old[ citation needed ].','It is old. Very old.'],
  ['Claim[when?] and another[who?][clarification needed][dubious – discuss].','Claim and another.'],
  ['Keep [sic] and [Earth] and [2019 edition] as written.','Keep [sic] and [Earth] and [2019 edition] as written.']
 ].entries()) check('K19-'+i,k.stripReferenceMarkers(raw)===want);
 const realBooks=k.listBooks(fs.readFileSync(require.resolve('./fixtures/kiwix-catalog.xml'),'utf8'));
 check('K7-catalog',realBooks.length===1 && realBooks[0].name==='wikipedia_en_100' && realBooks[0].title==='Wikipedia 100' && realBooks[0].fullTextIndex===true);
 check('K20',realBooks[0].path==='/content/wikipedia_en_100_2026-08' && realBooks[0].date==='2026-08-20');
 for(const item of items) check('K21',k.bookInfoForUrl(endpoint+item.url,realBooks).bookDate==='2026-08-20' && k.bookInfoForUrl(endpoint+item.url,realBooks).bookTitle==='Wikipedia 100');
 check('K22',k.bookInfoForUrl(endpoint+'/content/other_2025-02/Article',realBooks).bookDate==='2025-02');
 check('K23',k.bookInfoForUrl(endpoint+'/content/other/Article',realBooks).bookDate==='');
 // Local images: only articles whose title names the subject (issue: "earth" matched "Earth Song" in Michael Jackson).
 const subjects=[['show me pictures of the earth','earth'],['pictures of earth','earth'],['images of dogs','dogs'],['photos of the Moon please','moon'],['can you show me images of Michael Jackson','michael,jackson'],['show me pictures',''],['what does a turtle look like? show me pictures','turtle']];
 for(const [i,[q,want]] of subjects.entries()) check('K16-'+i,k.mediaSubjectTerms(k.mediaSubject(q)).join(',')===want);
 const earth=k.mediaSubjectTerms(k.mediaSubject('show me pictures of the earth'));
 for(const [i,[title,want]] of [['Earth',true],["Earth's atmosphere",true],['Michael Jackson',false],['Solar eclipse',false],['Earthquake',false],['Antarctica',false]].entries()) check('K17-'+i,k.titleMatchesSubject(title,earth)===want);
 check('K17-real',items.every(item=>!k.titleMatchesSubject(item.title,earth)));
 check('K17-dog',k.titleMatchesSubject('Dog',k.mediaSubjectTerms('dogs')) && !k.titleMatchesSubject('Dog',k.mediaSubjectTerms('hot dogs')));
 // Simple plurals and case on either side (Sandeep, 2026-11-17).
 const titleFor=(q,title)=>k.titleMatchesSubject(title,k.mediaSubjectTerms(k.mediaSubject(q)));
 for(const [i,[q,title,want]] of [
  ['show me pictures of red pandas','Red panda',true],['pictures of Red Pandas','red panda',true],['photos of the red panda','Red pandas',true],
  ['show me volcanoes','Volcano',true],['images of VOLCANOES','volcano',true],['pictures of a volcano','Volcanoes',true],
  ['images of cities','City',true],['pictures of a city','Cities',true],
  ['photos of shoes','Shoe',true],['pictures of boxes','Box',true],['pictures of glasses','Glass',true],
  ['show me pictures of the earth','Michael Jackson',false],['show me pictures of the earth','Earth Song',true],
  ['show me pictures of red pandas','Giant panda',false],['show me pictures of red pandas','Red fox',false],
  ['images of cities','Citizenship',false],['show me volcanoes','Volcanic rock',false]
 ].entries()) check('K18-'+i,titleFor(q,title)===want);
 check('K17-empty',!k.titleMatchesSubject('Earth',[]) && !k.titleMatchesSubject('Earth',undefined));
 for(const [i,url] of ['https://outside.test/content/a/b','//outside.test/content/a/b','/search?x=y','/content/a/../../x'].entries()) check('K8-'+i,!k.normalizeKiwixResult({title:'a',url},endpoint,i));
 check('K9',k.articleRawUrl(endpoint+'/content/wiki/A%20B')===endpoint+'/raw/wiki/content/A%20B');
 const images=k.articleImages('<img src="pic.png"><img src="//outside.test/x"><img src="https://outside.test/x"><img src="data:image/png,x"><img src="/content/wiki/p.png">',endpoint+'/content/wiki/A',endpoint);
 check('K10',images.length===2 && images.every(u=>new URL(u).origin===endpoint));
 const books=k.listBooks('<feed><entry><id>one</id><title>First</title><name>one</name><tags>_ftindex:yes;_pictures:yes</tags></entry><entry><id>two</id><title>Second</title><name>two</name><tags>_ftindex:no</tags></entry></feed>');
 check('K11',books.length===2 && books[0].fullTextIndex===true && books[1].fullTextIndex===false);
 // The real client against an in-memory HTTP transport: no DNS or sockets.
 const http=require('node:http'),{EventEmitter}=require('node:events');
 const originalRequest=http.request;let calls=0,mode='ok',seen;
 http.request=(options,callback)=>{
  calls++;seen=options;const req=new EventEmitter();
  req.destroy=error=>{req.emit('error',error);req.emit('close');};
  req.end=()=>queueMicrotask(()=>{
   if(mode==='timeout')return;
   const res=new EventEmitter();res.statusCode=mode==='redirect'?302:200;res.headers={'content-type':'text/plain'};callback(res);
   res.emit('data',Buffer.from(mode==='large'?'123456789':'ok'));res.emit('end');req.emit('close');
  });return req;
 };
 try {
  const response=await k.fetchKiwix('http://localhost:8090/search?pattern=x',{endpoint:'http://localhost:8090'});
  check('K12',await response.text()==='ok'&&seen.hostname==='127.0.0.1'&&seen.headers.Host==='localhost:8090');
  const before=calls;let refused=false;try{await k.fetchKiwix('http://outside.test/search',{endpoint});}catch{refused=true;}check('K13',refused&&calls===before);
  for(const [i,next] of ['redirect','large','timeout'].entries()){
   mode=next;const prior=calls;let failed=false;try{await k.fetchKiwix(endpoint+'/search',{endpoint,maxBytes:4,timeoutMs:5});}catch{failed=true;}check('K14-'+i,failed&&calls===prior+1);
  }
 }finally{http.request=originalRequest;}
 console.log('knowledge-backend tests passed');
}
main().catch(e=>{console.error(/^K[A-Za-z0-9-]+$/.test(e.message)?e.message:'K0');process.exitCode=1;});
