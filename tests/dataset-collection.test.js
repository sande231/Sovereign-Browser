const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectDataset } = require('../src/dataset-collection');
const utils = require('../src/search-utils');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-dataset-'));
  const previousDelay = process.env.SOVEREIGN_DATASET_DELAY_MS;
  delete process.env.SOVEREIGN_DATASET_DELAY_MS;
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
    assert.deepEqual(JSON.parse(fs.readFileSync(outputPath + '.skipped.txt', 'utf8')), { id: '2', question: 'Empty?', reason: 'no_results' });
    fs.appendFileSync(outputPath, '{"id":');
    queried.length = 0;
    assert.deepEqual(await collectDataset(options), { collected: 0, skipped: 1, resumed: 2 });
    assert.deepEqual(queried, ['Empty?']);
    assert.equal(fs.readFileSync(outputPath, 'utf8').trim().split('\n').length, 2);
    await assert.rejects(collectDataset({ ...options, query: async () => { throw new Error('offline'); } }), /offline/);
    const skips = file => fs.readFileSync(file + '.skipped.txt', 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(skips(outputPath).at(-1).reason, 'offline');
    const run = async (name, results, extra = {}) => {
      const file = path.join(dir, name + '.jsonl');
      fs.writeFileSync(questionsPath, results.map((_, i) => `Question ${i + 1}?`).join('\n'));
      let calls = 0;
      const waits = [];
      const promise = collectDataset({ ...options, outputPath: file,
        query: async () => ({ results: results[calls++] ? [{ url: 'https://example.com' }] : [] }),
        wait: async ms => waits.push(ms), ...extra });
      return { promise, file, waits, calls: () => calls };
    };
    const stopped = await run('stopped', [true, false, false, false, false, true]);
    await assert.rejects(stopped.promise, /search engines appear to be rate-limiting; try again later/);
    assert.equal(stopped.calls(), 5);
    assert.equal(stopped.waits.filter(ms => ms === 600000).length, 1);
    assert.deepEqual(skips(stopped.file).map(row => row.reason), Array(4).fill('no_results'));
    assert.equal(JSON.parse(fs.readFileSync(stopped.file, 'utf8')).id, '1');

    const recovered = await run('recovered', [false, false, false, true, false, true]);
    assert.deepEqual(await recovered.promise, { collected: 2, skipped: 4, resumed: 0 });
    assert.equal(recovered.waits.filter(ms => ms === 600000).length, 1);
    const reset = await run('reset', [false, false, true, false, false, true]);
    await reset.promise;
    assert.ok(reset.waits.every(ms => ms === 3000));

    const missing = await run('missing', [true, true], { readSources: async () => ({ sources: [] }) });
    assert.deepEqual(await missing.promise, { collected: 0, skipped: 2, resumed: 0 });
    assert.deepEqual(skips(missing.file), [1, 2].map(id => ({ id: String(id), question: `Question ${id}?`, reason: 'source_read_failed' })));
    const failed = await run('failed', [true], { readSources: async () => { throw new Error('source timeout\nretry later'); } });
    await assert.rejects(failed.promise, /source timeout/);
    assert.deepEqual(skips(failed.file), [{ id: '1', question: 'Question 1?', reason: 'source timeout\nretry later' }]);
    assert.equal(fs.readFileSync(failed.file + '.skipped.txt', 'utf8').trim().split('\n').length, 1);

    process.env.SOVEREIGN_DATASET_DELAY_MS = '17';
    const configured = await run('configured', [true, true]);
    await configured.promise;
    assert.deepEqual(configured.waits, [17]);
    process.env.SOVEREIGN_DATASET_DELAY_MS = 'bad';
    await assert.rejects(collectDataset(options), /SOVEREIGN_DATASET_DELAY_MS/);
    console.log('Dataset collection tests passed');
  } finally {
    if (previousDelay === undefined) delete process.env.SOVEREIGN_DATASET_DELAY_MS;
    else process.env.SOVEREIGN_DATASET_DELAY_MS = previousDelay;
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
