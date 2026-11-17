'use strict';
const fs = require('node:fs');
function check(id, ok) { if (!ok) throw new Error(id); }
async function main() {
 const k = require('../src/knowledge-backend');
 const endpoint = 'http://127.0.0.1:8090';
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
main().catch(e=>{console.error(/^K\d+(?:-\d+)?$/.test(e.message)?e.message:'K0');process.exitCode=1;});
