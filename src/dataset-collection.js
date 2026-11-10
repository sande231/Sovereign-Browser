const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { SEARCH_ANSWER_VERSION, buildSourceAnswerMessages } = require('./search-utils');

function datasetUserDataDir(appDataDir) {
  return path.join(appDataDir, 'sovereign-browser-dataset');
}

function seedDatasetPreferences({ normalPrefsPath, datasetDir, fsImpl = fs }) {
  try {
    const destination = path.join(datasetDir, 'preferences.json');
    if (fsImpl.existsSync(destination)) return false;
    fsImpl.mkdirSync(datasetDir, { recursive: true, mode: 0o700 });
    const preferences = JSON.parse(fsImpl.readFileSync(normalPrefsPath, 'utf8'));
    if (!preferences?.search || typeof preferences.search !== 'object' || Array.isArray(preferences.search)) return false;
    fsImpl.writeFileSync(destination, JSON.stringify({ search: preferences.search }), { mode: 0o600, flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

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

function isConnectionRefused(error) {
  const seen = new Set();
  while (error && !seen.has(error)) {
    seen.add(error);
    if (error.code === 'ECONNREFUSED' || /ECONNREFUSED|ERR_CONNECTION_REFUSED|connection refused/i.test(error.message || '')) return true;
    error = error.cause;
  }
  return false;
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
  let refusedStreak = 0;
  const skippedByReason = Object.create(null);
  // Retry only the failed stage; a source retry can reuse successful search results.
  const retry = async (operation, search = false) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const value = await operation(attempt);
        if (search) refusedStreak = 0;
        return { value };
      } catch (error) {
        if (search) {
          refusedStreak = isConnectionRefused(error) ? refusedStreak + 1 : 0;
          if (refusedStreak === 3) {
            return { error, stop: 'SearXNG endpoint is unreachable: connection refused 3 times in a row; try again later' };
          }
        }
        if (attempt === 1) return { error };
        await wait(5000);
      }
    }
  };
  const skip = (id, question, reason) => {
    fs.appendFileSync(outputPath + '.skipped.txt', JSON.stringify({ id, question, reason }) + '\n');
    skipped++;
    skippedByReason[reason] = (skippedByReason[reason] || 0) + 1;
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
        const search = await retry(attempt => query({ requestId: `${requestId}-search-${attempt}`, query: question }), true);
        if (search.error) {
          emptyStreak = 0;
          skip(id, question, search.error?.message || String(search.error));
          if (search.stop) throw new Error(search.stop);
          await onProgress(index + 1, questions.length);
          continue;
        }
        const response = search.value;
        if (!response.results?.length) {
          skip(id, question, 'no_results');
          emptyStreak++;
          if (checkingAfterPause && emptyStreak === 3) {
            throw new Error('search engines appear to be rate-limiting; try again later');
          }
          if (!checkingAfterPause && emptyStreak === 3 && index + 1 < questions.length) {
            console.log('Three consecutive questions returned no search results; pausing for 10 minutes.');
            await wait(10 * 60 * 1000);
            checkingAfterPause = true;
            emptyStreak = 0;
          }
        } else {
          emptyStreak = 0;
          checkingAfterPause = false;
          const read = await retry(async attempt => {
            const bundle = await readSources({ requestId: `${requestId}-read-${attempt}`, question, results: response.results });
            if (!Array.isArray(bundle?.sources) || !bundle.sources.length) throw new Error('source_read_failed');
            return bundle;
          });
          if (read.error) {
            skip(id, question, read.error?.message || String(read.error));
            await onProgress(index + 1, questions.length);
            continue;
          }
          const sources = read.value.sources;
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
    console.log(`Dataset collection summary: collected=${collected}, skipped=${skipped}, skipped by reason=${JSON.stringify(skippedByReason)}, already collected=${resumed}, output=${outputPath}`);
  }
}

module.exports = { collectDataset, completedIds, expandPath, datasetUserDataDir, seedDatasetPreferences };
