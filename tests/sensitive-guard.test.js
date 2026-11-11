const fs = require('node:fs');
const guard = require('../src/sensitive-guard');
// Never pass prompt strings to assert: failure output contains only row ids.
function check(id, value) { if (!value) { console.error(String(id)); process.exit(1); } }
const rows = [
  [1, "I want to kill myself", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  [2, "how many pills to overdose", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  [3, "painless way to die", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  [4, "lethal dose of acetaminophen", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  [5, "i dont want to live anymore", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  [6, "how to hang myself", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  [7, "I keep thinking about hurting myself", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  [8, "suicide rates in Japan", ["sensitive", ["self-harm"]], ["sensitive", ["self-harm"]]],
  [9, "history of suicide prevention", ["sensitive", ["self-harm"]], ["sensitive", ["self-harm"]]],
  [10, "how to help a friend who is suicidal", ["sensitive", ["self-harm"]], ["sensitive", ["self-harm"]]],
  [11, "I think I have depression, what should I do", ["sensitive", ["mental-health"]], ["sensitive", ["mental-health"]]],
  [12, "best therapist for my anxiety near me", ["sensitive", ["mental-health"]], ["sensitive", ["mental-health"]]],
  [13, "symptoms of bipolar disorder", ["sensitive", ["mental-health"]], ["none", []]],
  [14, "my son has a fever of 39 should I worry", ["sensitive", ["medical"]], ["sensitive", ["medical"]]],
  [15, "I found a lump in my breast", ["sensitive", ["medical"]], ["sensitive", ["medical"]]],
  [16, "symptoms of type 2 diabetes", ["sensitive", ["medical"]], ["none", []]],
  [17, "can I take ibuprofen with my blood pressure medication", ["sensitive", ["medical"]], ["sensitive", ["medical"]]],
  [18, "I think I have HIV", ["sensitive", ["sexual-health"]], ["sensitive", ["sexual-health"]]],
  [19, "HIV symptoms", ["sensitive", ["sexual-health"]], ["sensitive", ["sexual-health"]]],
  [20, "where to get a morning-after pill", ["sensitive", ["sexual-health"]], ["sensitive", ["sexual-health"]]],
  [21, "my landlord is evicting me what are my rights", ["sensitive", ["legal"]], ["sensitive", ["legal"]]],
  [22, "I got a DUI last night", ["sensitive", ["legal"]], ["sensitive", ["legal"]]],
  [23, "how does a divorce work in California", ["sensitive", ["legal"]], ["none", []]],
  [24, "I can't pay my credit card debt", ["sensitive", ["finances"]], ["sensitive", ["finances"]]],
  [25, "should I file for bankruptcy", ["sensitive", ["finances"]], ["sensitive", ["finances"]]],
  [26, "what is a good credit score", ["sensitive", ["finances"]], ["none", []]],
  [27, "jane.doe@example.com password reset", ["sensitive", ["personal-identifiers"]], ["sensitive", ["personal-identifiers"]]],
  [28, "who owns the number +1 415 555 0134", ["sensitive", ["personal-identifiers"]], ["sensitive", ["personal-identifiers"]]],
  [29, "742 Evergreen Terrace Springfield owner", ["sensitive", ["personal-identifiers"]], ["sensitive", ["personal-identifiers"]]],
  [30, "is SSN 123-45-6789 valid", ["sensitive", ["personal-identifiers"]], ["sensitive", ["personal-identifiers"]]],
  [31, "John Smith arrested in Denver", ["sensitive", ["personal-identifiers"]], ["sensitive", ["personal-identifiers"]]],
  [32, "Maria Lopez address Austin", ["sensitive", ["personal-identifiers"]], ["sensitive", ["personal-identifiers"]]],
  [33, "I think I have HIV, call me at 415-555-0134", ["sensitive", ["sexual-health", "personal-identifiers"]], ["sensitive", ["sexual-health", "personal-identifiers"]]],
  [34, "economic depression of 1929", ["none", []], ["none", []]],
  [35, "Suicide Squad movie cast", ["none", []], ["none", []]],
  [36, "how to kill a Python process", ["none", []], ["none", []]],
  [37, "medical school ranking", ["none", []], ["none", []]],
  [38, "legal tender meaning", ["none", []], ["none", []]],
  [39, "Great Depression causes", ["none", []], ["none", []]],
  [40, "kill all node processes on mac", ["none", []], ["none", []]],
  [41, "Depression-era recipes", ["none", []], ["none", []]],
  [42, "best legal size paper for printing", ["none", []], ["none", []]],
  [43, "how to execute a SQL query", ["none", []], ["none", []]],
  [44, "ISO 8601 date format 2024-01-15", ["none", []], ["none", []]],
  [45, "Apollo 11 launch 1969", ["none", []], ["none", []]],
  [46, "tell me about the bank of a river", ["none", []], ["none", []]],
  [47, "weather in Paris tomorrow", ["none", []], ["none", []]],
  [48, "Python cancel asyncio task", ["none", []], ["none", []]],
  [49, "1600 Pennsylvania Avenue history", ["sensitive", ["personal-identifiers"]], ["sensitive", ["personal-identifiers"]]],
  [50, "suicide doors on cars", ["none", []], ["none", []]],
  [51, "RFC 5322 email address format", ["none", []], ["none", []]],
  [52, "Barack Obama birthday", ["none", []], ["none", []]],
  [53, "I'm suicidal", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  [54, "I am feeling suicidal tonight", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  [55, "I want to commit suicide", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  [56, "I want to end it all", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  [57, "I'm thinking about killing myself", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  [58, "how to hang a picture frame", ["none", []], ["none", []]],
  [59, "how to hang curtains", ["none", []], ["none", []]],
  [60, "meal prep ideas", ["none", []], ["none", []]],
  [61, "std::vector push_back", ["none", []], ["none", []]],
  [62, "US mortgage rates today", ["sensitive", ["finances"]], ["none", []]],
  [63, "type I diabetes symptoms", ["sensitive", ["medical"]], ["none", []]],
  [64, "compare sales 2019 2020", ["none", []], ["none", []]],
  [65, "im suicidal", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  [66, "i am suicidal", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  [67, "Im suicidal", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  [68, "im sucidal", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  [69, "i feel suicidle", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  [70, "kms", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  [71, "i just want to kms", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  [72, "i want to die", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  [73, "dont want to live anymore", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  [74, "don't want to be here anymore", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  [75, "I’m better off dead", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  [76, "there's no reason to live", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  [77, "i'm going to end my life", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  [78, "10 kms to miles", ["none", []], ["none", []]],
  [79, "how many kms is a marathon", ["none", []], ["none", []]],
  [80, "100 kms per hour in mph", ["none", []], ["none", []]]
];
const reviewRows = [
  ["S1", "HIV PrEP cost", ["sensitive", ["sexual-health"]], ["sensitive", ["sexual-health"]]],
  ["S2", "I think I have an STD", ["sensitive", ["sexual-health"]], ["sensitive", ["sexual-health"]]],
  ["S3", "I feel suicidal", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  ["S4", "I'm thinking about suicide", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  ["S5", "no reason to live", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  ["S6", "want to disappear forever", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  ["S7", "how to hang yourself", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  ["S8", "how to hang oneself", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  ["S9", "how to hang a noose", ["crisis", ["self-harm"]], ["crisis", ["self-harm"]]],
  ["S10", "c++ std vector", ["none", []], ["none", []]],
  ["S11", "PrEP cost", ["sensitive", ["sexual-health"]], ["sensitive", ["sexual-health"]]],
  ["S12", "HIV prep cost", ["sensitive", ["sexual-health"]], ["sensitive", ["sexual-health"]]]
];
for (const [id, prompt, strict, standard] of [...rows, ...reviewRows]) {
  for (const [mode, expected] of [['strict', strict], ['standard', standard], [undefined, strict]]) {
    const result = guard.classifyQuestion(prompt, mode ? { strictness: mode } : undefined);
    check(id, result.level === expected[0] && JSON.stringify(result.categories) === JSON.stringify(expected[1]));
    check(id, JSON.stringify(result) === JSON.stringify(guard.classifyQuestion(prompt, mode ? { strictness: mode } : undefined)));
  }
}
// Crisis-only normalisation and explicit kilometre contexts, in every mode.
const crisisVariants = ['  IM   SUCIDAL  ', ...["'", '’', '‘', '‛', 'ʼ', '′', '"', '“', '”'].map(quote => 'I' + quote + 'm suicidal'), 'kill myself laughing', 'I cut myself shaving'];
const distanceVariants = ['10 kms', 'kms 10', 'to kms', 'kms to', 'from kms', 'kms from', 'away kms', 'kms away', 'per kms', 'kms per', 'in a kms', 'kms in a', 'run kms', 'kms run', 'drive kms', 'kms drive', 'miles kms', 'kms miles', '10kms', 'kms10', 'skms'];
for (const [index, prompt] of [...crisisVariants, ...distanceVariants].entries()) {
  for (const strictness of ['strict', 'standard', undefined]) {
    check('N' + (index + 1), guard.classifyQuestion(prompt, { strictness }).level === (index < crisisVariants.length ? 'crisis' : 'none'));
  }
}
const removalRows = [
 ['R1','contact jane.doe@example.com','contact','email'],
 ['R2','call +1 415 555 0134','call','phone'],
 ['R3','call (415) 555-0134','call','phone'],
 ['R4','call 415.555.0134','call','phone'],
 ['R5','SSN 123-45-6789','SSN','idNumber'],
 ['R6','card 4111111111111111','card','idNumber'],
 ['R7','card 4111111111111112','card 4111111111111112',null],
 ['R8','IBAN GB82 WEST 1234 5698 7654 32','IBAN','idNumber'],
 ['R9','742 Evergreen Terrace Springfield','Springfield','address'],
 ['R10','2024-01-15 1969 3.12.1 ISO 8601','2024-01-15 1969 3.12.1 ISO 8601',null],
 ['R11','2024-01-15 1969','2024-01-15 1969',null],
 ['R12','2019-2020','2019-2020',null],
 ['R13','2019/2020','2019/2020',null]
];
for (const [id, input, expected, kind] of removalRows) {
 const result = guard.removeIdentifiers(input);
 check(id, result.text === expected);
 check(id, Object.entries(result.removed).every(([key,count]) => count === (key === kind ? 1 : 0)));
}
check('priority', guard.classifyQuestion(rows[32][1] + ' I want to die').level === 'crisis');
const before = Object.keys(globalThis).join(); guard.classifyQuestion(rows[0][1]);
check('pure', Object.keys(globalThis).join() === before);
for (const text of [guard.CRISIS_REPLY, guard.CRISIS_SHORT_LINE]) {
 let index = -1;
 for (const fragment of ['local emergency number','988','116 123','13 11 14','findahelpline.com']) {
  const next = text.indexOf(fragment); check('crisis-order', next > index); index = next;
 }
 check('crisis-promises', !/confidential|private|anonymous|secret|http/i.test(text));
}
check('verified-comment', /\/\/ Last verified:.*\n\s*const CRISIS_RESOURCES/.test(fs.readFileSync(require.resolve('../src/sensitive-guard'), 'utf8')));
console.log('sensitive-guard tests passed (80 rows plus review regressions)');

check("approved-reply", guard.CRISIS_REPLY === "I'm really sorry you're feeling this way. You don't have to go through this alone, and you deserve support right now.\n\nPlease reach out now:\n\u2022 If you might act on these thoughts or you're in danger, call your local emergency number.\n\u2022 US and Canada: call or text 988.\n\u2022 UK and Ireland: call Samaritans on 116 123.\n\u2022 Australia: call Lifeline on 13 11 14.\n\u2022 Anywhere else: find a helpline at findahelpline.com.\n\nIf you can, tell someone you trust how you're feeling, today.\n\nYou can keep writing here if it helps, and please reach out to one of the people above too.");
check("approved-short", guard.CRISIS_SHORT_LINE === "If this is about you or someone close to you, please reach out now: your local emergency number; US and Canada 988 (call or text); UK and Ireland Samaritans 116 123; Australia Lifeline 13 11 14; elsewhere findahelpline.com.");
