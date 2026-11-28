# Evidence for README claims

Each claim in the [README](../README.md) is listed here with the code, test or record that supports it. Paths are relative to the repository root. "HANDOFF" means [`docs/HANDOFF.md`](HANDOFF.md), the project's plan/build/review log; section names are given so they can be searched.

**Status key**
- ✅ **Proven in the repository:** an automated test asserts it, or the code and a recorded check show it.
- ⚠️ **Partly proven:** the evidence is manual, dated, or narrower than the plain claim. The README states it with the limit shown here.
- ❌ **Not proven:** the README does not make this claim, or states it only as a limit or future work.

Last updated: 2026-11-22, after the fresh audits of the current build. Their summaries are in [`docs/audits/`](audits/), and the procedure is in [`docs/audits/RUNBOOK.md`](audits/RUNBOOK.md). "Local capture" means mitmproxy's macOS local capture mode, which records every connection made by Sovereign's own processes (hostnames only).

## Local AI

| # | Claim | Evidence | Status |
|---|---|---|---|
| C1 | Answers are generated on the laptop with WebLLM on WebGPU. The default model is Llama 3.2 1B Instruct (q4f16_1, MLC build). | `src/main.js` (`DEFAULT_AI_MODEL_ID`, model list); `src/ai/ai-engine-entry.js`; `tests/electron/model-chat.test.js` | ✅ |
| C2 | No cloud AI service is contacted, and there is no cloud fallback when the local model is unavailable. | `CLOUD_AI_HOSTS` and `cloudCheck` in `src/privacy-receipt.js` (every receipt is checked against known cloud-AI hosts); the app has no cloud AI client; local capture: `docs/audits/2026-11-19-online-local.txt` and `docs/audits/2026-11-20-sensitive-local.txt` ("PASS: no uncaptured hosts and no cloud-AI hosts"), `docs/audits/2026-11-19-offline-local.txt` (no connections) | ✅ No automated test asserts "no fallback" directly; it rests on the code and the audits. |
| C2a | The model is downloaded once, on first use, from Hugging Face and GitHub (raw files), and cached afterwards. No model is downloaded while Offline. | Hosts `huggingface.co`, `us.aws.cdn.hf.co`, `raw.githubusercontent.com` in `docs/audits/2026-11-19-online-local.txt` (new profile, model downloaded during the run); `tests/electron/offline-mode.test.js` fresh phase: "no model download while Offline" | ✅ "Cached" holds while the model files are on disk. During the audits, a copied test profile that had lost its files downloaded the model again, after the app correctly said it wasn't downloaded (HANDOFF Task 2c, PLAN §13.5). |
| C22 | With the model on disk, Ask AI answers Offline. | `docs/audits/2026-11-22-kiwix-capture-summary.txt` (Offline run: the solar eclipse question got a Supported/Partly supported answer written by the local model; on the local path the model must load and run before such an answer, `src/ask.js` `streamKnowledgeAnswer`) | ✅ Answering was shown in the Offline Kiwix run; absence of traffic was shown separately in the Offline run (`docs/audits/2026-11-19-offline-local.txt`). |

## Privacy Receipt

| # | Claim | Evidence | Status |
|---|---|---|---|
| C3 | Every request the app makes for search, answers, images, model setup and local knowledge is listed in the Privacy Receipt with its purpose. | `src/privacy-receipt.js`, `src/privacy-attribution.js`; `tests/privacy-receipt.test.js`, `tests/privacy-attribution.test.js`, `tests/audit-compare.test.js`; local capture: `docs/audits/2026-11-19-dryrun-local.txt` (the method sees the main process's Node requests and the browser engine's), `docs/audits/2026-11-19-online-local.txt` and `docs/audits/2026-11-20-sensitive-local.txt` (0 hosts in the capture but not in the receipt), `docs/audits/2026-11-19-offline-local.txt` (no connections) | ⚠️ Every captured host was in the receipt, but the sensitive run's export counts **2 requests with no known origin** that no receipt lists (follow-up open, HANDOFF Task 2c PLAN §14.7). Also: normal browsing tabs are excluded by design; SearXNG's upstream requests come from Docker, not the app (`docs/privacy-audit.md` §7); DNS lookups are not receipt rows (the capture shows only which nameserver was asked); hostnames only. |
| C3a | A hostname capture can be compared with the receipt by anyone. | `docs/audits/RUNBOOK.md`, `docs/privacy-audit.md`, `scripts/log-hosts.py`, `scripts/audit-compare.js`; `tests/audit-compare.test.js`, `tests/log-hosts.test.js` | ✅ macOS only (local capture mode). |
| C3b | Image thumbnails are loaded directly from the search engines' image servers and listed as image rows. | `docs/audits/2026-11-19-online-local.txt` (MATCHED: `encrypted-tbn0.gstatic.com`, `ts3.explicit.bing.net`, `ts4.mm.bing.net`); receipt category `image` (`src/main.js`, `recordPrivacyWebRequest`) | ✅ as a disclosed limit: those servers see the user's IP address and which thumbnails are fetched. |

## Offline mode

| # | Claim | Evidence | Status |
|---|---|---|---|
| C4 | While Offline, the app's requests are blocked except to loopback addresses on a user allowlist. | `src/network-mode.js`; `tests/network-mode.test.js`, `tests/network-exits.test.js`, `tests/offline-gate-integration.test.js`; `tests/electron/offline-mode.test.js` (8 phases); HANDOFF "Offline mode (Phase 1, Task 1a)"; local capture of a whole Offline run: `docs/audits/2026-11-19-offline-local.txt` (no connection, no DNS lookup; whole-machine DNS capture with 0 lines naming the app's hosts) | ✅ for Sovereign's own traffic. Other apps and the OS are not covered. The Offline run may not have loaded the model (HANDOFF Task 2c, PLAN §13.5), so an Offline model load was not under capture; see C22. |
| C5 | New installs (no preferences file) start Offline, as does a profile whose preferences file can't be read. A profile from before Offline mode starts Online with a one-time choice; afterwards the saved choice is used. | `initialNetworkState` in `src/network-mode.js`; `tests/network-mode.test.js` (initial-state cases); `tests/electron/offline-mode.test.js` phases fresh, old, old-again, corrupt | ✅ Not "Offline by default" for every user: existing profiles keep Online until the user chooses. |
| C6 | While Offline, WebTransport, WebRTC STUN and beacons from web pages send nothing. | HANDOFF Task 1a CHANGES (§3.8 table) and Round 2b review: 0 datagrams Offline, at least 1 in the Online control; `offlineConnectSrc` in `src/main.js` | ✅ for `http(s)` pages. ❌ for `file:///` pages to loopback ports (known limit). |
| C7 | Redirects to private addresses are refused; at most 5 redirects; `https` → `http` refused. | `src/safe-fetch.js`; `tests/safe-fetch.test.js`, `tests/safe-fetch-integration.test.js`, `tests/electron/safe-redirects.test.js` | ✅ |

## Sensitive-topic guard

| # | Claim | Evidence | Status |
|---|---|---|---|
| C8 | Questions are checked before any web search, image search, source reading or local-knowledge search, across 15 categories (health, mental health, legal, finances, immigration, and others). | `src/sensitive-guard.js` (`LABELS`); `tests/sensitive-guard.test.js`, `tests/sensitive-gate.test.js`; `tests/electron/sensitive-guard.test.js` | ✅ The rules are English-only patterns: they miss some wording and over-block some harmless questions (HANDOFF Tasks 1b §8 and 1c §9). |
| C8a | Crisis-level messages (self-harm, harm to others) are checked first and never reach web search or local knowledge. | `tests/sensitive-gate.test.js` (crisis → 0 Kiwix calls and chat locked; static check that the crisis check precedes any Kiwix fetch) | ✅ It is not a safety service: it shows resources and does not contact anyone. The crisis texts await professional review, and the helpline numbers must be re-verified before release (README "Before releasing"). |
| C9 | A sensitive chat's exported receipt contains none of the sensitive text, and its search is not sent. | Local capture: `docs/audits/2026-11-20-sensitive-local.txt` (0 new hosts after the sensitive question, compared with a baseline taken after the model loaded; the test word 0 times in the exported receipt and 0 times in the capture; the sensitive chat's only row is the blocked search, "Not sent: sensitive topic (medical)", with an empty query); also HANDOFF Task 2b, "Final review" (Sandeep's manual retest, 2026-11-17) | ✅ One question, one category (medical), Strict setting; hostnames only. |

## Local knowledge (Kiwix)

| # | Claim | Evidence | Status |
|---|---|---|---|
| C10 | Kiwix runs on this computer, bound to `127.0.0.1` only, and makes no internet requests. | `kiwix/docker-compose.yml` (image pinned by digest, `--blockexternal`, `127.0.0.1:8090`, read-only, `cap_drop: ALL`); `tests/knowledge-backend.test.js` (loopback-only endpoint, results off the Kiwix origin dropped); `docs/audits/2026-11-22-kiwix-capture-summary.txt` (packet capture inside the container's network: 45 connections, all inbound to port 8080; 0 outgoing packets; no DNS, UDP, ICMP or IPv6; config confirmed); HANDOFF Task 2a, Round 4 review (source review of kiwix-tools 3.8.2) | ✅ One session of 6 questions with one ZIM file (`wikipedia_en_100_2026-08`). |
| C11 | Local answers cite the local article and show "Local knowledge as of <date>". | `tests/electron/local-knowledge.test.js` | ✅ |
| C12 | Off-topic local results are dropped; the app says Not found rather than cite an unrelated article. | `isRelevantLocalResult`, `orderLocalResults` in `src/knowledge-backend.js`; `tests/knowledge-backend.test.js` (KR cases, including a decoy article); fixtures `tests/fixtures/kiwix-search-*.xml` (real captures and labelled synthetic variants) | ✅ Some answerable questions are lost (HANDOFF "Known limits (Task 2b)"). |

## Answer trust signals

| # | Claim | Evidence | Status |
|---|---|---|---|
| C13 | Each answer gets a label: Supported, Partly supported, Source excerpts, Not found, or No sources. Sentences without a valid citation are removed and counted. | `src/answer-trust.js`; `tests/answer-trust.test.js` (AT1–AT47) | ✅ |
| C14 | "Supported" means the answer is correct. | — | ❌ **Not claimed.** "Supported" means every sentence cites a source; it does not check that the source says it. A manual test found a Supported answer with a made-up and a false sentence (HANDOFF "Known limits (Task 2b)"). |
| C15 | When sources disagree on the number the question asks for, the answer shows "Sources disagree". | `tests/answer-trust.test.js` (AT41–AT45); `tests/electron/local-knowledge.test.js` (`trust-disagree`) | ✅ Only the kind of number the question asks for is compared. |
| C16 | Answer accuracy figures. | `tests/evals/research-answer-quality.json` (6 cases, no recorded results) | ❌ **Not claimed.** Planned for Phase 5. |

## Other

| # | Claim | Evidence | Status |
|---|---|---|---|
| C17 | Attached documents are parsed on the laptop. | `src/pdf-extract-worker.js`; `tests/electron/attachments.test.js`, `tests/electron/pdf-attachments.test.js` | ✅ |
| C18 | Deleting a chat removes the app's copy. | `src/chat-store.js`; `tests/chat-store.test.js`, `tests/electron/chat-deletion.test.js` | ✅ Chromium's storage may keep old bytes until it compacts; exported files and backups are not affected (HANDOFF "Saved chat deletion"). |
| C19 | Test suite size: 21 unit and integration test files run by `npm run check`; 20 Electron end-to-end suites (`npm run test:electron:*`, one of which, `media-chat-live`, needs the internet). | `package.json` scripts; `tests/`, `tests/electron/` | ✅ counted 2026-11-22. Pass results are recorded per task in HANDOFF; not every Electron suite is re-run for every change. |
| C20 | A fine-tuned model is used. | `src/dataset-collection.js` (collection mode only) | ❌ **Not claimed.** Fine-tuning is in progress outside this repository (Roadmap). |
| C21 | MIT licence. | `LICENSE`, `package.json` | ✅ |
| C23 | Test-only switches can't change a normal run. | `src/test-hooks.js` (`testHook`: honoured only when unpackaged **and** Electron's app path is `tests/electron`); `src/main.js` (all 11 test switches read through it; startup refusal of `--host-resolver-rules` / `--ignore-certificate-errors`; warnings for `SOVEREIGN_AUDIT_PROXY`, ignored test settings and `--proxy-server`, shown in a toolbar notice); `tests/test-hooks.test.js` (gate cases, plus a static check that `src/` reads no test variable outside `src/test-hooks.js`); `tests/electron/test-switch-gate.test.js` (launches the real app as `npm start` does: test settings ignored and reported, the two switches refused, warnings shown, a clean start shows none) | ✅ **Fixed in Task 2d (2026-11-24).** `SOVEREIGN_AUDIT_PROXY` deliberately still works under `npm start`, with a visible warning. The audits set only `SOVEREIGN_USER_DATA_DIR` (and `SOVEREIGN_AUDIT_PROXY` in the first, session-proxy Run 1), inline per command. |
