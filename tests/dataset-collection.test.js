const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectDataset } = require('../src/dataset-collection');
const utils = require('../src/search-utils');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-dataset-'));
  try {
    const questionsPath = path.join(dir, 'questions.txt');
    const outputPath = path.join(dir, 'output.jsonl');
    fs.writeFileSync(questionsPath, 'First?\n\nEmpty?\nThird?\n');
    const sources = [{ title: 'Source', url: 'https://example.com', snippet: 'Evidence', evidenceMode: 'page', selectedPassages: ['Evidence'] }];
    const queried = [];
    const delays = [];
    const options = {
      questionsPath, outputPath,
      query: async request => {
        queried.push(request.query);
        return { results: request.query === 'Empty?' ? [] : [{ url: 'https://example.com' }] };
      },
      readSources: async () => ({ sources, headers: { secret: 'never saved' } }),
      wait: async ms => delays.push(ms)
    };
    assert.deepEqual(await collectDataset(options), { collected: 2, skipped: 1, resumed: 0 });
    assert.deepEqual(delays, [3000, 3000]);
    const rows = fs.readFileSync(outputPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.map(r => r.id), ['1', '3']);
    assert.deepEqual(rows[0].messages, [
      { role: 'system', content: utils.SEARCH_SYSTEM_PROMPT },
      { role: 'user', content: utils.buildSourceAnswerPrompt('First?', sources) }
    ]);
    assert.deepEqual(Object.keys(rows[0]), ['id', 'question', 'prompt_version', 'messages', 'source_count', 'evidence_modes', 'collected_at']);
    assert.equal(JSON.parse(fs.readFileSync(outputPath + '.skipped.txt', 'utf8')).id, '2');
    fs.appendFileSync(outputPath, '{"id":');
    queried.length = 0;
    assert.deepEqual(await collectDataset(options), { collected: 0, skipped: 1, resumed: 2 });
    assert.deepEqual(queried, ['Empty?']);
    assert.equal(fs.readFileSync(outputPath, 'utf8').trim().split('\n').length, 2);
    await assert.rejects(collectDataset({ ...options, query: async () => { throw new Error('offline'); } }), /offline/);
    console.log('Dataset collection tests passed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
