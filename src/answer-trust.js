(function attachAnswerTrust(global) {
  'use strict';
  const search = typeof module !== 'undefined' && module.exports ? require('./search-utils') : global.SovereignSearchUtils;
  const TRUST_TEXTS = Object.freeze({
    excerpts: "Source excerpts: the AI couldn't write a reliable answer, so these passages are copied word for word from the sources. Check that they answer your question.",
    supported: 'Supported: every sentence cites a source. Open the sources to check.',
    'partly-supported': 'Partly supported: some sentences have no source. Check them before relying on them.',
    'not-found': "Not found: the sources didn't contain an answer.",
    'no-sources': 'No sources: answer from the AI alone; verify it.',
    offer: "Local knowledge didn't have an answer. Search the web?",
    button: 'Search the web'
  });
  const evidence = source => String(source?.snippet || source?.evidenceText || '').trim();
  const provided = sources => new Set((sources || []).flatMap((s,i) => evidence(s) ? [i+1] : []));
  const citations = text => [...String(text).matchAll(/\[(\d+)\]/g)].map(m=>Number(m[1]));
  const clean = text => String(text || '').replace(/\[\d+\]/g,'').replace(/\s+([.!?,])/g,'$1').replace(/\s+/g,' ').trim();
  function computeTrustLabel({answer, sources = [], outcome}) {
    const p = provided(sources);
    const text = clean(answer);
    if (!p.size || outcome === 'insufficient-evidence' || (!['source-excerpts', 'snippet-excerpts', 'ai-generated', 'checked-ai-answer'].includes(outcome) && /insufficient/i.test(text)) ||
        ['No local results found.', 'I could not find search results for that question.'].includes(text)) return 'not-found';
    if (['source-excerpts', 'snippet-excerpts'].includes(outcome)) {
      const blocks = String(answer || '').trim().split(/\n\s*\n/).filter(Boolean);
      return blocks.length && blocks.every(block => {
        const ending = block.match(/(?:\[\d+\]\s*)+[.!?]?\s*$/);
        return ending && citations(ending[0]).every(n => p.has(n));
      }) ? 'excerpts' : 'not-found';
    }
    const claims = search.splitSentences(answer).filter(s => clean(s) !== search.LIMITED_DETAIL_SENTENCE);
    const cited = claims.filter(s=>citations(s).some(n=>p.has(n))).length;
    return !cited ? 'not-found' : cited === claims.length ? 'supported' : 'partly-supported';
  }
  function removedText(n) {
    return n === 1 ? '1 sentence without a source was removed.' : `${n} sentences without a source were removed.`;
  }
  // Units are ordered longest first so area and word units cannot become shorter units.
  const units = [
    ['area',1e6,'km²|km2|square kilometres'], ['area',2589988.110336,'sq mi|square miles'],
    ['temperature',1,'°C'], ['temperature',5/9,'°F'],
    ['length',.001,'mm'], ['length',.01,'cm'], ['length',1000,'kilometres?|km'],
    ['length',.3048,'feet|foot|ft'], ['length',1609.344,'miles?|mi'],
    ['length',.0254,'inches|inch'], ['length',1,'metres?|meters?|m'],
    ['mass',1000,'tonnes?'], ['mass',.45359237,'pounds?|lb'], ['mass',1,'kg'], ['mass',.001,'g'],
    ['percent',1,'per cent|percent|%'], ['count',1,'people|inhabitants|residents']
  ];
  const unitPattern = units.map(u=>u[2]).join('|');
  const numberPattern = '[−-]?\\d+(?:,\\d{3})*(?:\\.\\d+)?';
  function extractQuantities(value) {
    const text = String(value || '').replace(/\[\s*\d+\s*\]/g,m=>' '.repeat(m.length));
    const regex = new RegExp(`(${numberPattern})\\s*(?:(thousand|million|billion)\\s+)?(${unitPattern})(?![\\p{L}\\p{N}²])`, 'giu');
    const found = [];
    const skipped = (start,end) => {
      const before = text.slice(0,start), after = text.slice(end);
      return /^\s*(?:\/\s*(?:h|s|hr|sec)\b|per\s+(?:hour|second)\b)/i.test(after) ||
        /\b(?:about|approximately|around|roughly|nearly)\s+(?:a\s+)?population\s+of\s*$/i.test(before) ||
        new RegExp(`\\d\\s*(?:${unitPattern})\\s*(?:to|[–—-])\\s*$`, 'i').test(before) ||
        /[\d.,]$/.test(before) || /(?:\d\s*(?:to|[–—-])\s*|\b(?:about|approximately|around|roughly|nearly)\s*)$/i.test(before) || /^\s*(?:to|[–—-])\s*\d/.test(after);
    };
    for (const m of text.matchAll(regex)) {
      const end = m.index+m[0].length;
      if (skipped(m.index,end)) continue;
      const unit = units.find(u=>new RegExp(`^(?:${u[2]})$`,'i').test(m[3]));
      const multiplier = ({thousand:1e3,million:1e6,billion:1e9})[m[2]?.toLowerCase()] || 1;
      const number = Number(m[1].replace(/,/g,'').replace('−','-'));
      const precision = 10 ** -(m[1].split('.')[1]?.length || 0) * multiplier * unit[1];
      const quantity = {kind:unit[0], value: (m[3].toLowerCase()==='°f' ? number-32 : number)*multiplier*unit[1], precision, raw:m[0], start:m.index,end};
      const previous = found.at(-1);
      if (previous?.kind === quantity.kind && /^\s*\(\s*$/.test(text.slice(previous.end,m.index)) && /^\s*\)/.test(text.slice(end))) continue;
      found.push(quantity);
    }
    for (const m of text.matchAll(new RegExp(`\\bpopulation\\s+of\\s+(${numberPattern})(?:\\s+(thousand|million|billion))?`, 'gi'))) {
      const multiplier = ({thousand:1e3,million:1e6,billion:1e9})[m[2]?.toLowerCase()] || 1;
      const start=m.index+m[0].indexOf(m[1]), end=m.index+m[0].length;
      if (skipped(start,end) || found.some(v=>v.start===start)) continue;
      found.push({kind:'count',value:Number(m[1].replace(/,/g,'').replace('−','-'))*multiplier,precision:10**-(m[1].split('.')[1]?.length||0)*multiplier,raw:m[0].slice(m[0].indexOf(m[1])),start,end});
    }
    for (const m of text.matchAll(/\b(?:in|since|from|until|by|of|year|January|February|March|April|May|June|July|August|September|October|November|December)\s+(1\d{3}|20\d{2}|2100)\b/gi)) {
      const start=m.index+m[0].lastIndexOf(m[1]), end=start+4;
      if (skipped(start,end) || found.some(v=>v.start<=start && v.end>=end)) continue;
      found.push({kind:'year',value:Number(m[1]),precision:1,raw:m[1],start,end});
    }
    return found.sort((a,b)=>a.start-b.start);
  }
  const unitTerms = new Set(search.contentTerms(unitPattern.replace(/[?|]/g,' ')+' thousand million billion square population year'));
  function factTerms(sentence) {
    return new Set(search.contentTerms(sentence).filter(t=>!/^\d/.test(t) && !unitTerms.has(t)));
  }
  function agrees(a,b) {
    if (a.kind === 'year') return a.value === b.value;
    const precision = Math.max(a.precision,b.precision);
    return Math.round(a.value/precision) === Math.round(b.value/precision);
  }
  // R3.15 F2 (approved): the question's cue decides which kind of number is compared.
  const QUESTION_CUES = [
    ['year', /\b(?:when|what year|which year|since when|date)\b/i],
    ['length', /\b(?:how (?:tall|high|long|far|deep)|height|length|distance|elevation)\b/i],
    ['mass', /\b(?:how heavy|weight|mass)\b/i],
    ['count', /\b(?:population|how many people|inhabitants)\b/i],
    ['temperature', /\b(?:temperature|how hot|how cold)\b/i],
    ['percent', /\b(?:percent|percentage|what share)\b/i],
    ['area', /\b(?:area|how big|square)\b/i]
  ];
  const QUESTION_WORDS = new Set(['how','what','when','which','who','whom','whose','why','where','did','does','was','were','are','tell','since','year','date','tall','high','long','far','deep','height','length','distance','elevation','heavy','weight','mass','population','many','people','inhabitants','temperature','hot','cold','percent','percentage','share','area','big','square']);
  function questionKinds(question) {
    return new Set(QUESTION_CUES.filter(([, cue]) => cue.test(String(question || ''))).map(([kind]) => kind));
  }
  // Subject words of the question (cue words removed), e.g. "mount", "everest", "lowest", "antarctica".
  function questionSubjectTerms(question) {
    return new Set(search.contentTerms(question).filter(t => !QUESTION_WORDS.has(t) && !unitTerms.has(t)));
  }
  function findDisagreements({answer, sources = [], question = '', outcome} = {}) {
    // Source excerpts are copied text, not claims written by the AI.
    if (['source-excerpts', 'snippet-excerpts'].includes(outcome)) return [];
    const kinds = questionKinds(question);
    if (!kinds.size) return [];
    const subject = questionSubjectTerms(question);
    const hasSubject = text => search.contentTerms(text).some(t => subject.has(t));
    const p = provided(sources), cited = [...new Set(citations(answer).filter(n=>p.has(n)))];
    if (cited.length < 2) return [];
    const disagreements = [], seen = new Set();
    for (const sentence of search.splitSentences(answer)) {
      if (!hasSubject(sentence)) continue;
      const terms = factTerms(sentence);
      for (const kind of new Set(extractQuantities(sentence).map(q=>q.kind).filter(k=>kinds.has(k)))) {
        // One value per source; a source with two different values for the fact is left out.
        const perSource = [];
        for (const citation of cited) {
          const values = [];
          for (const sourceSentence of search.splitSentences(evidence(sources[citation-1]))) {
            const shared = [...factTerms(sourceSentence)].filter(t=>terms.has(t));
            if (shared.length < 2 || !hasSubject(sourceSentence)) continue;
            for (const quantity of extractQuantities(sourceSentence).filter(q=>q.kind===kind)) values.push({...quantity,citation});
          }
          if (values.length && values.every(v => agrees(v, values[0]))) perSource.push(values[0]);
        }
        if (perSource.length < 2 || perSource.every(v => agrees(v, perSource[0]))) continue;
        // Each citation once; first the earliest source, then sources whose value differs; max 3.
        const listed = [];
        for (const v of perSource) if (listed.length < 3 && listed.every(d => !agrees(d, v))) listed.push(v);
        if (listed.length < 2) continue;
        listed.sort((a,b)=>a.citation-b.citation);
        const key = listed.map(v=>`${v.citation}:${v.raw}`).join('|');
        if (!seen.has(key)) { seen.add(key); disagreements.push(listed.map(({raw,citation})=>({raw,citation}))); }
        if (disagreements.length===2) return disagreements;
      }
    }
    return disagreements;
  }
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  function knowledgeDate(date) {
    const m=/^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(date || '');
    if (!m || !months[Number(m[2])-1] || (m[3] && (Number(m[3])<1 || Number(m[3])>new Date(Date.UTC(Number(m[1]),Number(m[2]),0)).getUTCDate()))) return 'an unknown date';
    return `${m[3] ? Number(m[3])+' ' : ''}${months[Number(m[2])-1]} ${m[1]}`;
  }
  function formatKnowledgeDate(sources) {
    const books = [...new Set((sources || []).map(s=>`${knowledgeDate(s.bookDate)} (${s.bookTitle || s.book || ''})`))];
    return books.length ? `Local knowledge as of ${books.join('; ')}.` : '';
  }
  function formatRetrievedAt(value) {
    const date = new Date(value);
    if (!value || !Number.isFinite(date.getTime())) return '';
    return `Web sources retrieved ${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()} at ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}.`;
  }
  function decideTrust({answer, sources=[], outcome, removedUnsupported=0, path, fixed=false, attachments=false, crisisConversation=false, retrievedAt='', question=''}) {
    if (fixed || attachments || !['ai','local','web'].includes(path) || (path==='ai' && crisisConversation)) return null;
    const label = path==='ai' ? 'no-sources' : computeTrustLabel({answer,sources,outcome});
    const removed = ['ai-generated','checked-ai-answer'].includes(outcome) ? removedUnsupported : 0;
    const local = sources.filter(s=>s.origin==='local');
    return {label, removed, disagreements:['not-found','excerpts'].includes(label)||path==='ai'?[]:findDisagreements({answer,sources,question,outcome}),
      dates:path==='ai'?[]:[local.length?formatKnowledgeDate(local):'',formatRetrievedAt(retrievedAt)].filter(Boolean)};
  }
  // Saved objects are data, never HTML or arbitrary labels. Dates retain their original page-clock formatting.
  function validateTrust(value) {
    if (!value || !Object.hasOwn(TRUST_TEXTS,value.label) || ['offer','button'].includes(value.label)) return null;
    return {label:value.label,localOnly:value.localOnly===true,removed:Number.isSafeInteger(value.removed)&&value.removed>0?value.removed:0,
      disagreements:(Array.isArray(value.disagreements)?value.disagreements:[]).slice(0,2).map(group=>(Array.isArray(group)?group:[]).filter(v=>typeof v?.raw==='string'&&v.raw.length<=100&&Number.isInteger(v.citation)&&v.citation>0&&v.citation<=5).slice(0,3)).filter(g=>g.length>1),
      dates:(Array.isArray(value.dates)?value.dates:[]).filter(d=>typeof d==='string'&&d.length<=2000&&/^(Local knowledge as of |Web sources retrieved ).*\.$/.test(d)).slice(0,2)};
  }
  const api = {TRUST_TEXTS,computeTrustLabel,extractQuantities,findDisagreements,formatKnowledgeDate,formatRetrievedAt,decideTrust,removedText,validateTrust};
  global.SovereignAnswerTrust=api;
  if (typeof module!=='undefined'&&module.exports) module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
