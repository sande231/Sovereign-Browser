const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { SEARCH_ANSWER_VERSION, buildSourceAnswerMessages } = require('./search-utils');

function expandPath(value) {
  return path.resolve(value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value);
}

// Repair only an interrupted final append. Corruption elsewhere must not be hidden.
function completedIds(outputPath) {
  if (!fs.existsSync(outputPath)) return new Set();
  const data = fs.readFileSync(outputPath, 'utf8');
  const lines = data.split('\n');
  const ids = new Set();
  let validBytes = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) { validBytes += Buffer.byteLength(line + '\n'); continue; }
    try {
      const row = JSON.parse(line);
      if (typeof row.id !== 'string') throw new Error('Missing string id');
      ids.add(row.id);
    } catch (error) {
      if (index !== lines.length - 1) throw new Error(`Invalid output line ${index + 1}: ${error.message}`);
      fs.truncateSync(outputPath, validBytes);
      return ids;
    }
    validBytes += Buffer.byteLength(line + '\n');
  }
  if (data && !data.endsWith('\n')) fs.appendFileSync(outputPath, '\n');
  return ids;
}

async function collectDataset({ questionsPath, outputPath, query, readSources,
  onProgress = async () => {}, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const delayMs = Number(process.env.SOVEREIGN_DATASET_DELAY_MS ?? 3000);
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 2147483647) {
    throw new Error('SOVEREIGN_DATASET_DELAY_MS must be a non-negative number of milliseconds no greater than 2147483647.');
  }
  const questions = fs.readFileSync(questionsPath, 'utf8').split(/\r?\n/).map(q => q.trim()).filter(Boolean);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const completed = completedIds(outputPath);
  let collected = 0;
  let skipped = 0;
  let resumed = 0;
  let attempted = false;
  let emptyStreak = 0;
  let checkingAfterPause = false;
  const skip = (id, question, reason) => {
    fs.appendFileSync(outputPath + '.skipped.txt', JSON.stringify({ id, question, reason }) + '\n');
    skipped++;
  };
  try {
    await onProgress(0, questions.length);
    for (let index = 0; index < questions.length; index++) {
      const id = String(index + 1);
      const question = questions[index];
      if (completed.has(id)) {
        resumed++;
      } else {
        if (attempted) await wait(delayMs);
        attempted = true;
        const requestId = `dataset-${Date.now()}-${id}`;
        let response;
        try {
          response = await query({ requestId, query: question });
        } catch (error) {
          skip(id, question, error?.message || String(error));
          throw error;
        }
        if (!response.results?.length) {
          skip(id, question, 'no_results');
          emptyStreak++;
          if (checkingAfterPause) {
            throw new Error('search engines appear to be rate-limiting; try again later');
          }
          if (emptyStreak === 3 && index + 1 < questions.length) {
            console.log('Three consecutive questions returned no search results; pausing for 10 minutes.');
            await wait(10 * 60 * 1000);
            checkingAfterPause = true;
            emptyStreak = 0;
          }
        } else {
          emptyStreak = 0;
          checkingAfterPause = false;
          let bundle;
          try {
            bundle = await readSources({ requestId, question, results: response.results });
          } catch (error) {
            skip(id, question, error?.message || String(error));
            throw error;
          }
          const sources = bundle?.sources;
          if (!Array.isArray(sources) || !sources.length) {
            skip(id, question, 'source_read_failed');
            await onProgress(index + 1, questions.length);
            continue;
          }
          const row = {
            id, question,
            prompt_version: `${SEARCH_ANSWER_VERSION}-source-pages`,
            messages: buildSourceAnswerMessages(question, sources),
            source_count: sources.length,
            evidence_modes: sources.map(source => source.evidenceMode === 'page' ? 'page' : 'snippet'),
            collected_at: new Date().toISOString()
          };
          fs.appendFileSync(outputPath, JSON.stringify(row) + '\n');
          collected++;
        }
      }
      await onProgress(index + 1, questions.length);
    }
    return { collected, skipped, resumed };
  } finally {
    console.log(`Dataset collection summary: collected=${collected}, skipped=${skipped}, already collected=${resumed}, output=${outputPath}`);
  }
}

module.exports = { collectDataset, completedIds, expandPath };
