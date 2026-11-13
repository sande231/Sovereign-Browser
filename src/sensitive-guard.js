(function attachSensitiveGuard(global) {
  const LABELS = {"self-harm": "self-harm or suicide", "harm-to-others": "harm to others", "abuse": "abuse or domestic violence", "mental-health": "mental health", "medical": "medical", "legal": "legal", "sexual-health": "sexual health", "finances": "financial", "crime": "crime", "drugs-alcohol": "drugs or alcohol", "reproductive-health": "pregnancy or reproductive health", "orientation-gender": "sexual orientation or gender identity", "immigration": "immigration", "beliefs": "religion or politics", "personal-identifiers": "personal information"};
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
  // Last verified: pending human verification by Sandeep before release.
  const HARM_RESOURCES = [
    'If anyone is in danger right now, call your local emergency number.',
    ...CRISIS_RESOURCES.slice(1).map(item => item.text)
  ];
  const HARM_REPLY = "It sounds like you're dealing with some very strong feelings right now. I can't help with anything that could hurt someone, but you don't have to handle this alone.\n\n" + HARM_RESOURCES[0] + '\n\nIf you need to talk to someone now:\n' + HARM_RESOURCES.slice(1).map(text => '• ' + text).join('\n') + "\n\nIf you can, step away from the situation for a while and reach out to someone you trust.\n\nYou can keep writing here if it helps, and please reach out to one of the people above too.";
  // Last verified: pending human verification by Sandeep before release.
  const ABUSE_RESOURCE_LIST = [
    "If you're in danger right now, call your local emergency number.",
    'US: National Domestic Violence Hotline, 1-800-799-7233.',
    'UK: National Domestic Abuse Helpline, 0808 2000 247.',
    'Anywhere else: find a helpline at findahelpline.com.'
  ];
  const ABUSE_RESOURCES = "If someone is hurting you or you don't feel safe, you deserve support.\n" + ABUSE_RESOURCE_LIST.map(text => '• ' + text).join('\n') + '\nIf someone else uses this computer, you can delete this chat from the chat list.';
  function crisisReply(result) { return result.categories.includes('self-harm') ? CRISIS_REPLY : HARM_REPLY; }
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
    // Self-harm above always wins. Remove only entertainment phrases, not the whole question.
    const harmText = crisisForms[1].replace(/\bhow to get away with murder\s+(?:cast|season|episode|show)\b/g, '').replace(/\bmurder mystery\b/g, '');
    const target = '(?:someone|somebody|a person|him|her|them|people|my (?:boss|ex|partner|husband|wife|boyfriend|girlfriend|parent|mother|father|mom|dad|brother|sister|son|daughter|friend|neighbor|neighbour|coworker))';
    const place = '(?:(?:my|our|the|a|an) )?(?:school|workplace|office|church|mosque|synagogue|temple|mall|store|restaurant|club|bar|hospital|university|college|classroom|campus|concert|theater|theatre)';
    const action = '(?:(?:hurt|kill|stab|shoot|beat(?: up)?|poison) '+target+'|beat the (?:crap|hell) out of '+target+'|shoot up '+place+')';
    const intent = new RegExp('\\b(?:i(?: want to|m going to| am going to| will| could| plan to|m gonna| am gonna)|(?:i )?gonna) '+action+'\\b');
    const planning = new RegExp('\\b(?:how (?:to|do i|can i)|(?:best )?ways? to|help me) '+action+'\\b');
    if (intent.test(harmText) || planning.test(harmText) || /\b(?:get away with murder|make someone disappear|hurt someone without getting caught)\b/.test(harmText)) return { level: 'crisis', categories: ['harm-to-others'] };
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
      if (/\b(?:lawyer|sued|lawsuit|custody|divorce|dui|eviction|evicting)\b/.test(text)) hits.add('legal');
      if (/\b(?:debt|bankruptcy|credit score|loan|mortgage|overdraft|tax return|salary|payday loan)\b/.test(text)) hits.add('finances');
    }
    const personal = /\b(?:i|i'm|im|i've|me|my|mine|we|our|us)\b/i.test(framing);
    const personalOrStrict = strictness !== 'standard' || personal;
    // Phrase-local negative guards allow another real topic in the same question to match.
    const abuseText = text.replace(/\b(?:abuse of power|substance abuse|abuse (?:a |an )?(?:function|api))\b/g, '');
    if (personalOrStrict && /\b(?:(?:hits?|beats|hurts|threatens|choked|strangled|slapped|kicked|pushed) me|threatens to hurt me|abusive (?:partner|husband|wife|boyfriend|girlfriend|parent)|domestic violence|(?:scared|afraid) of my (?:partner|husband|wife|boyfriend|girlfriend|parent|mom|dad|mother|father|brother|sister)|child abuse|controls my (?:money|phone))\b/.test(abuseText)) hits.add('abuse');
    const crimeText = text.replace(/\b(?:warrant officers?|crime rates?|true crime|law and order|police academy|court of appeals)\b/g, '');
    if (personalOrStrict && (/\b(?:charged with|warrant|felony|misdemeanor|probation|parole|criminal record|plea deal|public defender|expunge|court date|police (?:questioned|searched|came to))\b/.test(crimeText) || (!contextualName && /\barrested\b/.test(crimeText)))) hits.add('crime');
    const drugsText = text.replace(/\b(?:how alcohol is made|(?:rubbing|isopropyl) alcohol|weed (?:killer|control)|prohibition|drug store)\b/g, '');
    if (personalOrStrict && /\b(?:cocaine|heroin|meth|fentanyl|mdma|lsd|ketamine|opioids?|weed|marijuana|cannabis|addicted|addiction|rehab|relapse|withdrawal|sober|sobriety|alcoholic|alcoholism|drinking problem|drink every night|drug test|aa meetings?|substance abuse)\b/.test(drugsText)) hits.add('drugs-alcohol');
    const reproductiveText = text.replace(/\b(?:pregnant pause|pregnancy test|abortion pill|fertile soil|fertilizer|birth rate|period of \w+)\b/g, '');
    if (personalOrStrict && /\b(?:pregnant|pregnancy|miscarriage|abortion|ivf|fertility|ovulation|birth control|contraception|trying to conceive|period is (?:\w+ ){0,3}late|missed (?:my )?period)\b/.test(reproductiveText)) hits.add('reproductive-health');
    const orientationText = text.replace(/\b(?:trans-siberian|trans fat|queer eye|gay nineties)\b/g, '');
    if (/\b(?:gay|lesbian|bisexual|transgender|trans|nonbinary|queer|lgbtq\w*|coming out|come out to|gender dysphoria)\b/.test(orientationText) || (/\bhrt\b/.test(text) && /\bgender\b/.test(text))) hits.add('orientation-gender');
    const immigrationText = text.replace(/\b(?:ice cream|visa (?:card|credit|debit|gift)|ellis island|immigration (?:statistics|history))\b/g, '');
    if (/\b(?:overstay(?:ed)? (?:my |a |the )?visa|undocumented|deport(?:ed|ation)?|green card|asylum|daca|immigration status|work permit|citizenship test)\b/.test(immigrationText) || /\bICE\b/.test(original.replace(/\b(?:ice (?:cream|storm)|black ice)\b/gi, ''))) hits.add('immigration');
    if (personal && /\b(?:my (?:religion|faith|beliefs|political views)|leave (?:my religion|the church)|los(?:e|ing) my faith|convert to \w+|become (?:an? )?(?:atheist|muslim|christian|jew|buddhist|hindu)|who should i vote for|my parents are (?:conservative|liberal))\b/.test(text)) hits.add('beliefs');
    const categories = Object.keys(LABELS).filter(category => hits.has(category));
    return { level: categories.length ? 'sensitive' : 'none', categories };
  }
  function categoryLabels(categories) { return categories.map(category => LABELS[category]).filter(Boolean).join(', '); }
  function notSentSentence(categories, modelFlag = false) {
    return `I didn't search the web: this ${modelFlag ? 'may be' : 'looks like'} ${/^[aeiou]/i.test(categoryLabels(categories)) ? 'an' : 'a'} ${categoryLabels(categories)} question${modelFlag ? ' (checked by the local AI)' : ''}, so nothing was sent.`;
  }
  const api = { classifyQuestion, removeIdentifiers, CRISIS_REPLY, CRISIS_SHORT_LINE, CRISIS_RESOURCES, HARM_REPLY, HARM_RESOURCES, ABUSE_RESOURCES, ABUSE_RESOURCE_LIST, crisisReply, LABELS, categoryLabels, notSentSentence };
  global.SovereignSensitiveGuard = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
