(function attachSensitiveGuard(global) {
  const LABELS = { 'self-harm': 'self-harm or suicide', 'mental-health': 'mental health', medical: 'medical', legal: 'legal', 'sexual-health': 'sexual health', finances: 'financial', 'personal-identifiers': 'personal information' };
  // Last verified: pending human verification by Sandeep before release (text approved 2026-11-10).
  const CRISIS_RESOURCES = [
    { region: 'emergency', text: "If you might act on these thoughts or you're in danger, call your local emergency number.", short: 'your local emergency number' },
    { region: 'US and Canada', text: 'US and Canada: call or text 988.', short: 'US and Canada 988 (call or text)' },
    { region: 'UK and Ireland', text: 'UK and Ireland: call Samaritans on 116 123.', short: 'UK and Ireland Samaritans 116 123' },
    { region: 'Australia', text: 'Australia: call Lifeline on 13 11 14.', short: 'Australia Lifeline 13 11 14' },
    { region: 'elsewhere', text: 'Anywhere else: find a helpline at findahelpline.com.', short: 'elsewhere findahelpline.com' }
  ];
  const CRISIS_REPLY = "I'm really sorry you're feeling this way. You don't have to go through this alone, and you deserve support right now.\n\nPlease reach out now:\n" + CRISIS_RESOURCES.map(item => '• ' + item.text).join('\n') + "\n\nIf you can, tell someone you trust how you're feeling, today.\n\nYou can keep writing here if it helps, and please reach out to one of the people above too.";
  const CRISIS_SHORT_LINE = 'If this is about you or someone close to you, please reach out now: ' + CRISIS_RESOURCES.map(item => item.short).join('; ') + '.';
  function luhn(value) {
    const digits = value.replace(/\D/g, '');
    let sum = 0;
    for (let i = digits.length - 1, double = false; i >= 0; i--, double = !double) {
      let n = Number(digits[i]); if (double) { n *= 2; if (n > 9) n -= 9; } sum += n;
    }
    return sum % 10 === 0;
  }
  function removeIdentifiers(value) {
    let text = String(value || '');
    const removed = { email: 0, phone: 0, address: 0, idNumber: 0 };
    const remove = (pattern, kind, accept = () => true) => { text = text.replace(pattern, match => { if (!accept(match)) return match; removed[kind]++; return ' '; }); };
    remove(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, 'email');
    remove(/\b\d{3}-\d{2}-\d{4}\b/g, 'idNumber');
    remove(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g, 'idNumber');
    remove(/\b(?:passport|licen[cs]e|ID|account)\s+(?:number\s*[:#]?\s*)?[A-Z0-9]{6,}\b/gi, 'idNumber');
    // Consume the entire numeric candidate once. Invalid cards cannot become phones.
    text = text.split(/(\b\d{4}-\d{2}-\d{2}\b|\b\d{1,3}(?:\.\d{1,3}){2,}\b)/g).map((part, index) => index % 2 ? part : part.replace(/(?:\+?\d|\(\d{2,4}\))[\d ()./-]*\d/g, match => {
      const candidate = match.trim(); const digits = candidate.replace(/\D/g, '');
      if (/^(?:19|20)\d{2}(?:[ \/-]+(?:19|20)\d{2})+$/.test(candidate)) return match;
      if (/^\d{4}-\d{2}-\d{2}$/.test(candidate) || /^\d{1,3}(?:\.\d{1,3}){2,}$/.test(candidate)) return match;
      if (digits.length >= 13 && digits.length <= 19) {
        if (!luhn(candidate)) return match;
        removed.idNumber++; return ' ';
      }
      if (digits.length >= 7 && digits.length <= 12) { removed.phone++; return ' '; }
      return match;
    })).join('');
    remove(/\b\d{1,6}\s+(?:[A-Za-z][A-Za-z'-]*\s+){1,4}(?:St(?:reet)?|Ave(?:nue)?|Rd|Road|Blvd|Lane|Ln|Dr(?:ive)?|Court|Ct|Way|Place|Pl|Terrace)\b\.?/gi, 'address');
    return { text: text.replace(/\s+/g, ' ').trim(), removed };
  }
  function classifyQuestion(value, { strictness = 'strict' } = {}) {
    const original = String(value || '');
    let text = original.toLowerCase().replace(/’/g, "'").replace(/\s+/g, ' ').trim();
    text = text.replace(/^(?:(?:can you|please|tell me|show me|help me understand|explain)\s+)+/, '');
    // Keep broader quote normalisation local to crisis detection.
    const crisisText = original.toLowerCase().replace(/[’‘‛ʼ′"“”]/g, "'").replace(/\s+/g, ' ').trim();
    const crisisForms = [crisisText, crisisText.replace(/'/g, '')];
    const crisisPattern = /\b(?:i want to (?:die|kill myself|commit suicide)|i(?:'m|m| am| feel)(?: feeling)? (?:suicidal|sucidal|suicidle)|i(?:'m|m| am)? thinking about (?:killing myself|suicide)|end it all|no reason to live|want to disappear forever|kill myself|end my life|don'?t want to (?:live|be here anymore)|better off dead|hurt(?:ing)? myself|cut(?:ting)? myself|how many pills.{0,30}overdose|lethal dose|painless way to die|how to hang (?:myself|yourself|oneself|(?:a )?noose)|how to commit suicide)\b/;
    const crisisKms = [...crisisText.matchAll(/\bkms\b/g)].some(match => {
      // In the explicitly requested "want to kms", "to" is not a distance word.
      const before = crisisText.slice(0, match.index).replace(/\bwant to\s*$/, 'want ');
      const after = crisisText.slice(match.index + match[0].length);
      // Evaluate each occurrence; a distance mention cannot hide a later crisis.
      return !/(?:\d|\b(?:to|from|away|per|run|drive|miles)|\bin a|\bhow many)\s*$/.test(before)
        && !/^\s*(?:\d|(?:to|from|away|per|run|drive|miles)\b|in a\b)/.test(after);
    });
    if (crisisForms.some(candidate => crisisPattern.test(candidate)) || crisisKms) return { level: 'crisis', categories: ['self-harm'] };
    text = text.replace(/\b(?:economic depression|great depression|depression-era|suicide (?:squad|doors|kings?)|medical (?:school|student|drama)|legal (?:tender|size|pad)|bar exam|bank of (?:a|the) river|kill (?:\w+ ){0,3}(?:process(?:es)?|task|job|server|thread|tab|switch|lights)|execute (?:\w+ ){0,2}(?:script|query)|shoot (?:a )?(?:photo|video))\b/g, '');
    const hits = new Set();
    const identifiers = removeIdentifiers(original);
    const knownNames = new Set(['New York', 'Los Angeles', 'San Francisco', 'Google Chrome', 'Microsoft Windows']);
    const contextualName = [...original.matchAll(/\b[A-Z][a-z]+(?: [A-Z][a-z]+){1,2}\b/g)].some(match => !knownNames.has(match[0])) && /\b(?:address|lives|phone|email|arrested|diagnosed|pregnant|divorce|salary|dating|cheating|criminal record|DUI)\b/i.test(original);
    if (Object.values(identifiers.removed).some(Boolean) || contextualName) hits.add('personal-identifiers');
    if (/\b(?:suicide|suicidal|self-harm|self-injury)\b/.test(text)) hits.add('self-harm');
    const sexualText = text.replace(/\bc\+\+\s+std\b/g, '').replace(/\bstd\s*::/g, '');
    if (/\b(?:sti|std|hiv|herpes|chlamydia|gonorrhea|syphilis|hpv|erectile dysfunction|morning-after pill|abortion pill|pregnancy test)\b/.test(sexualText) || /\bPrEP\b/.test(original)) hits.add('sexual-health');
    // Preserve case for US and remove Roman-numeral contexts before framing.
    const framing = original.replace(/’/g, "'").replace(/\b(?:type|world war|phase)\s+I\b/gi, '').replace(/\bUS\b/g, '');
    if (strictness !== 'standard' || /\b(?:i|i'm|i've|me|my|mine|we|our|us)\b/i.test(framing)) {
      const mental = /\b(?:depression|anxiety|bipolar|panic attack|therapist|antidepressant)\b/.test(text);
      if (mental) hits.add('mental-health');
      // "Symptoms" alone belongs to the explicitly named mental/sexual topic if present.
      if (/\b(?:diagnosis|tumou?r|cancer|diabetes|medication|dosage|fever|lump|ibuprofen|blood pressure|std clinic)\b/.test(text) || (!mental && !hits.has('sexual-health') && /\bsymptoms\b/.test(text))) hits.add('medical');
      if (/\b(?:lawyer|sued|lawsuit|custody|divorce|immigration status|dui|eviction|evicting)\b/.test(text) || (!contextualName && /\barrested\b/.test(text))) hits.add('legal');
      if (/\b(?:debt|bankruptcy|credit score|loan|mortgage|overdraft|tax return|salary|payday loan)\b/.test(text)) hits.add('finances');
    }
    const categories = Object.keys(LABELS).filter(category => hits.has(category));
    return { level: categories.length ? 'sensitive' : 'none', categories };
  }
  function categoryLabels(categories) { return categories.map(category => LABELS[category]).filter(Boolean).join(', '); }
  function notSentSentence(categories, modelFlag = false) {
    return `I didn't search the web: this ${modelFlag ? 'may be' : 'looks like'} a ${categoryLabels(categories)} question${modelFlag ? ' (checked by the local AI)' : ''}, so nothing was sent.`;
  }
  const api = { classifyQuestion, removeIdentifiers, CRISIS_REPLY, CRISIS_SHORT_LINE, CRISIS_RESOURCES, LABELS, categoryLabels, notSentSentence };
  global.SovereignSensitiveGuard = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
