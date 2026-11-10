(function attachMediaIntent(global) {
  const nouns = '(?:pictures?|pics?|photos?|photographs?|images?|maps?|videos?|clips?|wallpapers?)';
  const quantity = '(?:(?:a few|a|an|some|any|\\d+)\\s+)?';
  const links = '(?:of|from|showing|about)';
  const bareRequests = '(?:show|find|get|give|see|display|download)';
  const requests = "(?:show me|give me|find me|get me|search for|look up|pull up|I want to see|I would like to see|I['’]d like to see|let me see|" + bareRequests + ')';
  const appearance = /^what\s+(?:does|do)\s+(.+?)\s+look like\s*[?.!]*$/i;
  const politeness = [
    /^can you(?: please)?\b\s*/i,
    /^could you(?: please)?\b\s*/i,
    /^would you(?: please)?\b\s*/i,
    /^please\b\s*/i
  ];
  const mediaUnit = new RegExp('^' + quantity + '(?:pictures?|pics?|photos?|photographs?|images?|videos?|clips?|wallpapers?)\\s+' + links + '\\b\\s*', 'i');
  const requestPrefix = new RegExp('^' + requests + '\\b\\s*', 'i');
  const shortVerbs = new Set('show find get give see display download pull look search send share fetch bring gimme'.split(' '));
  const shortFillers = new Set('me us u you can could would pls plz please i want wanna to need lemme gimme up for some a few any the hey just quick'.split(' '));
  const shortMediaUnit = new RegExp('^' + quantity + '(?:pictures?|pics?|photos?|photographs?|images?|videos?|clips?|wallpapers?)\\s+(?:of|showing|from)\\b.*\\p{L}', 'iu');

  function withinOneEdit(word, target) {
    if (Math.abs(word.length - target.length) > 1) return false;
    let i = 0;
    while (i < word.length && word[i] === target[i]) i++;
    if (i === word.length || i === target.length) return true;
    if (word.length === target.length) {
      if (word.slice(i + 1) === target.slice(i + 1)) return true;
      return word[i] === target[i + 1] && word[i + 1] === target[i]
        && word.slice(i + 2) === target.slice(i + 2);
    }
    if (word.length > target.length) {
      return word.slice(i + 1) === target.slice(i);
    }
    return word.slice(i) === target.slice(i + 1);
  }

  function shortRequestRest(text) {
    const words = text.split(/\s+/);
    let hasVerb = false;
    for (let i = 0; i < Math.min(5, words.length); i++) {
      const word = words[i].toLowerCase();
      const typo = /^(?:me|us|u)$/i.test(words[i + 1] || '')
        && ['show', 'find', 'give', 'send'].some(verb => withinOneEdit(word, verb));
      // "gimme" is the contracted request required by the PLAN's positive cases.
      const verb = shortVerbs.has(word) || typo;
      if (!verb && !shortFillers.has(word)) return '';
      hasVerb ||= verb;
      const rest = words.slice(i + 1).join(' ');
      if (hasVerb && shortMediaUnit.test(rest)) return rest;
    }
    return '';
  }

  function mentionsMedia(question) {
    return new RegExp('\\b' + nouns + '\\b', 'i').test(String(question || ''));
  }

  function trimTrailing(text) {
    let previous;
    do {
      previous = text;
      text = text.replace(/[?.!]+\s*$/, '').replace(/(?:\s+|^)(?:please|for me)\s*$/i, '').trim();
    } while (text !== previous);
    return text;
  }

  function isMediaRequest(question) {
    let core = String(question || '').trim();
    for (const phrase of politeness) core = core.replace(phrase, '');
    const looksLike = appearance.exec(core);
    if (looksLike && !/^(?:it|this|that|these|those|they|them|he|she)$/i.test(looksLike[1].trim())) return true;
    if (/^(?:what(?:\s+(?:is|are|was)|['’]s)|how\s+(?:do|does|can|to|is)|why|explain|define|describe|tell me about|picture (?:this|a|an)|imagine)\b/i.test(core)) return false;
    if (shortRequestRest(core)) return true;
    const request = new RegExp('\\b' + requests + '\\s+(?:\\S+\\s+){0,4}' + nouns + '(?=\\s+' + links + '\\b|$)', 'i');
    const leading = new RegExp('^' + quantity + nouns + '\\s+' + links + '\\b', 'i');
    return request.test(trimTrailing(core)) || leading.test(core);
  }

  function mediaTypeForQuestion(question) {
    return /\b(video|videos|clip|clips)\b/i.test(String(question || '')) ? 'videos' : 'images';
  }

  function mediaQueryForQuestion(question) {
    const original = String(question || '').trim();
    let text = original;
    // Politeness is removable only when it introduces a request or media unit.
    for (const phrase of politeness) {
      const match = phrase.exec(text);
      if (!match) continue;
      const rest = text.slice(match[0].length);
      if (requestPrefix.test(rest) || mediaUnit.test(rest)) text = rest;
      break;
    }
    // Strip one request only. Bare verbs can themselves be part of a title.
    const request = requestPrefix.exec(text);
    let strippedRequest = false;
    if (request) {
      const rest = text.slice(request[0].length);
      const bare = new RegExp('^' + bareRequests + '$', 'i').test(request[0].trim());
      if (!bare || mediaUnit.test(rest)) {
        text = rest;
        strippedRequest = true;
      }
    }
    if (!strippedRequest) {
      let core = original;
      for (const phrase of politeness) core = core.replace(phrase, '');
      text = shortRequestRest(core) || text;
    }
    text = text.replace(mediaUnit, '');
    const looksLike = appearance.exec(text);
    if (looksLike) text = looksLike[1];
    text = trimTrailing(text).replace(/\s+/g, ' ').trim();
    if (!/\p{L}/u.test(text)) text = original.replace(/[?.!]+\s*$/, '');
    return text.slice(0, 180);
  }

  const api = { isMediaRequest, mediaTypeForQuestion, mediaQueryForQuestion, mentionsMedia };
  global.SovereignMediaIntent = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
