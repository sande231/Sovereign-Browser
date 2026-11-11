# Claude ↔ Codex handoff
One section per task. Claude writes PLAN and REVIEW. Codex writes CHANGES. Sandeep tests and commits.

## Task: Fix Ask AI image retrieval
Status: reviewing

### PLAN (Claude)

#### 1. Code path today
1. `src/ask.js` `answerQuestion()` calls `isMediaRequest(question)` (around line 839). If it returns true and web is on, it calls `streamMediaAnswer()`. If web is off, it shows a "Search web for images" button that leads to `runInlineMediaSearch()` and then `streamMediaAnswer()`.
2. `streamMediaAnswer()` builds the search query with `mediaQueryForQuestion()` and the type (images or videos) with `mediaTypeForQuestion()`. It then calls `window.sovereign.search.media()`.
3. `src/main.js` IPC `search:media` creates the Privacy Receipt "Media image retrieval" and calls `searchSearxngMedia()` with `makeReceiptFetch(receipt.id, 'image', 'Image search query: …')`.
4. `src/search-backend.js` `searchSearxngMedia()` sends `GET <endpoint>?q=…&format=json&categories=images&safesearch=1`. Then `normalizeSearxngMediaResults()` normalises the results, scores them by query terms, and keeps 8.
5. Back in `ask.js`, `validatedMediaResults()` keeps the top 5 and sends a HEAD preflight (`media:preflight`) for each original or thumbnail URL. `renderMediaCards()` then draws each card with `<img src=thumbnailUrl referrerPolicy=no-referrer>`.

#### 2. Root cause
I tested this against the running local SearXNG (127.0.0.1:8080) and an offline copy of the `ask.js` helpers. SearXNG itself works: image queries returned 200 in about 1.3–1.7 s, with 300–900 raw results. The problems are in our own code.

**A. Intent detection misses common phrasings (main bug).** `isMediaRequest()` needs a word from its first regex, which lists verbs plus *singular* nouns, and a word from its second regex, which lists the nouns. Because of `\b`, `picture` does not match `pictures`. As a result:

| Prompt | `isMediaRequest` | Result |
|---|---|---|
| `pictures of Mount Everest` | **false** | Text answer, no images |
| `images of the Eiffel Tower` | **false** | Text answer, no images |
| `I want to see images of Mars` | **false** | Text answer, no images |
| `Give me some pics of Tokyo at night` | **false** | `pics` is not recognised |
| `What does a snow leopard look like?` | **false** | Text answer, no images |
| `Show me pictures of Mount Everest` | true | Works |

It also has false positives. `How does image compression work?` matches `image` in both regexes, so it is sent to image search instead of a normal answer.

**B. Query extraction leaves filler words in, so results are off-topic.** `mediaQueryForQuestion()` only removes a fixed word list:
- `Can you show me photos of red pandas?` becomes `Can you of red pandas`. The top results were "Can You Keep a Red Panda as a Pet?" and "Can You Own A Red Panda In Colorado?" (article pages, not photos). The clean query `red pandas` returned Wikimedia Commons photos.
- `I want to see images of Mars` becomes `I want to see of Mars`. The top results included "BRUNO MARS GIVEAWAY" (facebook.com) and telescope buying guides.

Words like `can`, `you`, `want` and `see` also count as relevance terms in `mediaQueryTerms()` (search-backend.js), so they push these bad matches *up* the ranking.

**C. Broken thumbnails look like failures.** Upstream image engines are flaky. In one run `bing images` returned an HTTP connection error, `brave.images` crashed and `unsplash` had a parsing error. Thumbnail hosts (for example `encrypted-tbn0.gstatic.com`) sometimes refuse hotlinks. The card's `<img>` has no `onerror` handler, so it shows a broken-image icon. When SearXNG returns 0 results, the user sees a generic "could not find usable results" message and is never told that the engines failed or that SearXNG is unreachable.

**D. Privacy Receipt labelling gap (related).** Thumbnail `<img>` loads from the Ask tab go through `recordPrivacyWebRequest()`, where `receiptCategoryForTrustedRequest()` labels them `other` / "trusted app/AI request". They should be labelled `image` with their real purpose. AGENTS.md requires every request to be labelled with its purpose.

#### 3. Files to change
| File | Change |
|---|---|
| `src/media-intent.js` (**new**) | Move `isMediaRequest`, `mediaTypeForQuestion` and `mediaQueryForQuestion` out of ask.js and rewrite them (§4.1–4.2). Add `mentionsMedia` (§4.1). Use the same browser/Node wrapper as `search-utils.js` (`global.SovereignMediaIntent` plus `module.exports`) so the functions can be unit-tested. |
| `src/ask.html` | Add `<script src="./media-intent.js"></script>` before `ask.js`. |
| `src/ask.js` | Delete the three old functions and call `SovereignMediaIntent.*`. In `renderMediaCards()`, add the source line and the image `onerror` fallback (§4.4–4.5). In `streamMediaAnswer()` and `runInlineMediaSearch()`, add the clearer error messages (§5). Add the `answer-text` / `search-media` controls and the `forceText` / `forceMedia` options (§4.6). Save and restore `action` and `mediaResults` in saved chats, and start the saved-chat receipt when a chat is reopened (§4.7). Change nothing else. |
| `src/search-backend.js` | In `normalizeMediaResult()`, add `pageUrl` (the validated `result.url`, `''` if missing) and `hasSourcePage`. Add filler words to `MEDIA_QUERY_STOP_WORDS`. In `searchSearxngMedia()`, also return `unresponsiveEngines`: the engine names only, from `payload.unresponsive_engines`, max 10, trimmed strings. |
| `src/privacy-attribution.js` | Add a pure helper `receiptCategoryForAppRequest({ url, resourceType, tabKind, baseCategory })`. It returns `'image'` when `resourceType === 'image'`, `tabKind` is `ask` or `search`, and `baseCategory !== 'model-download'`. Otherwise it returns `baseCategory`. |
| `src/main.js` | Three places only. (1) In `recordPrivacyWebRequest()`, use the helper above, and when the category is `image`, set `whatWasSent` to `'image thumbnail preview – no query, prompt, or AI output sent'`. (2) In `mediaFixtureResults()`, add **fixture data only**: `pageUrl` (set to the existing `sourceUrl`) and `hasSourcePage: true` on each image fixture, with no other fixture or behaviour change (§4.8, Q1). (3) In `ipcMain.handle('privacy:start-activity')`, accept an optional `purpose: 'saved-chat-media'`. When it is set, label the receipt `Saved chat image previews` instead of `Ask AI`; any other value is ignored (§4.7). The `search:media` IPC already spreads `result`, so `unresponsiveEngines` passes through with no change there. |
| `src/styles.css` | Small styles for `.media-source` (the source line) and a link-style `.chat-inline-link` for `Search text instead` / `Show images`. |
| `tests/media-intent.test.js` (**new**) | Plain Node `assert` tests with no framework. Cover every positive row in §4.1 (detection, type, and the **exact** cleaned query), every negative row (must be false), and `mentionsMedia`. Any failed assert must exit non-zero. |
| `tests/privacy-attribution.test.js` | Cases for `receiptCategoryForAppRequest`. |
| `package.json` | In the `check` script, right after `node tests/privacy-attribution.test.js`, add `&& node --check src/media-intent.js && node tests/media-intent.test.js`. `tests/privacy-attribution.test.js` already runs in `check`. |
| `tests/electron/media-chat.test.js` | Keep its existing assertions passing. Add one assertion that the first image card shows `Source: maps.example` (the fixture domain). |

Do **not** change: the download and preflight logic, the SearXNG settings, `searchSearxng` (text search), the video path apart from the shared intent function, or the Search tab UI.

#### 4. Exact behaviour

**4.1 `isMediaRequest(question)` must be conservative.** A wrong text answer is cheap to fix with the "Show images" link (§4.6). Image cards in reply to a real question are worse. So when in doubt, return **false**.

*Revised after REVIEW findings 1, 5 and 14. This section replaces the earlier rule set; where the REVIEW text differs, this PLAN wins.*

Definitions:
- **Media nouns** (singular or plural): `picture`, `pic`, `photo`, `photograph`, `image`, `map`, `video`, `clip`, `wallpaper`.
- **Link words:** `of`, `from`, `showing`, `about`. This one list is used by rule (a), rule (b) and the §4.2 media unit.
- **Politeness:** `can you`, `could you`, `would you` (each optionally followed by `please`), then `please`.
- **Request phrases:** `show me`, `give me`, `find me`, `get me`, `search for`, `look up`, `pull up`, `I want to see`, `I would like to see`, `I'd like to see`, `let me see`, and the bare verbs `show`, `find`, `get`, `give`, `see`, `display`, `download`.

Steps, in order:
1. **Core text.** Trim the prompt. Remove leading politeness, at most once for each phrase, in the order listed. The rest is the *core*. Detection uses only the core. (§4.2 has its own, stricter politeness rule.)
2. **Rule (c), appearance:** return **true** if the core matches `what does/do <subject> look like` (plus optional trailing `?.!`) and `<subject>` is not just a pronoun (`it`, `this`, `that`, `these`, `those`, `they`, `them`, `he`, `she`). [finding 5]
3. **Exclusions:** return **false** if the *core* starts with a concept, how-to or figurative opener: `what is`, `what are`, `what was`, `what's`, `how do`, `how does`, `how can`, `how to`, `how is`, `why`, `explain`, `define`, `describe`, `tell me about`, `picture this`, `picture a/an`, `imagine`. Because this check runs on the core, `Can you explain …` and `Please define …` are excluded too. [finding 14]
4. **Rule (a), request:** return **true** if both of these hold:
   - a request phrase comes before a media noun, with at most 4 words between them;
   - that media noun is **anchored**: either it is followed straight away by a link word, or it is the last word of the core (ignoring trailing `please`, `for me` and `?.!`). [finding 1]
5. **Rule (b), leading noun:** return **true** if the core starts with an optional `a`, `an`, `some`, `a few`, `any` or number, then a media noun, then a link word.
6. Otherwise return **false**.

`mentionsMedia(question)` does not change: it is true if any media noun appears as a whole word anywhere in the prompt.

`mediaTypeForQuestion(question)` returns `videos` only when `video(s)` or `clip(s)` appears. The word `watch` no longer counts. [finding 2]

`download the second image` is still handled first by `downloadReferenceFromQuestion`. Don't change that.

**4.2 `mediaQueryForQuestion(question)` must never remove the subject.** It only trims at the start and the end of the prompt, and each step removes at most one thing.

*Revised after REVIEW finding 13.*

1. **Politeness, only as part of a request.** Remove leading politeness (`can/could/would you (please)`, `please`) only if what comes straight after it is a request phrase (step 2) or a media unit (step 3). Otherwise keep it. For example, `Please Please Me …` keeps both words.
2. **At most one request phrase.** Remove one leading request phrase from the §4.1 list.
   - A **bare** verb (`show`, `find`, `get`, `give`, `see`, `display`, `download`, with no `me`) is removed **only if** a media unit (step 3) follows it straight away. Otherwise the verb is part of the subject and stays. This is why `Get Out poster images` stays whole and `Find a video of …` becomes `…`.
   - This step never runs twice.
3. **At most one media unit.** Remove one leading unit made of an optional `a`, `an`, `some`, `a few`, `any` or number, then a media noun other than `map(s)`, then a link word. Maps stay in the query.
4. **Appearance.** If the remaining text is `what does/do X look like`, the query is `X`, keeping any article.
5. **Trailing trim.** Remove trailing `please`, `for me` and `?.!`, repeating until nothing changes, then collapse whitespace. Articles are never removed.
6. **Subject guard and cap.** If the result is empty or has no letters, use the original prompt with only the trailing punctuation removed. Cap the result at 180 characters.

**4.2.1 Tests Codex must add or keep in `tests/media-intent.test.js`.** Every row below is required. "Query" means the **exact** value `mediaQueryForQuestion` must return. Existing tests stay, and none of their expected values change.

A. Positive cases: `isMediaRequest` is true, and the type and query are exact.

| # | Prompt | Type | Query | Covers |
|---|---|---|---|---|
| A1 | `pictures of Mount Everest` | images | `Mount Everest` | existing |
| A2 | `images of the Eiffel Tower` | images | `the Eiffel Tower` | existing |
| A3 | `Can you show me photos of red pandas?` | images | `red pandas` | existing |
| A4 | `I want to see images of Mars` | images | `Mars` | existing |
| A5 | `Give me some pics of Tokyo at night` | images | `Tokyo at night` | existing |
| A6 | `What does a snow leopard look like?` | images | `a snow leopard` | existing |
| A7 | `Show me a map of Nepal.` | images | `a map of Nepal` | existing |
| A8 | `Find a video of Mount Everest.` | videos | `Mount Everest` | existing |
| A9 | `photos of The Who` | images | `The Who` | existing |
| A10 | `show me pictures of Show Me the Money` | images | `Show Me the Money` | existing |
| A11 | `Get Out poster images` | images | `Get Out poster images` | 13: bare verb kept |
| A12 | `Find Finding Nemo pictures` | images | `Find Finding Nemo pictures` | 13: bare verb kept |
| A13 | `Show me Paris photos` | images | `Paris photos` | 1: noun is the last word |
| A14 | `Find pictures about the Apollo 11 landing` | images | `the Apollo 11 landing` | 1/13: `about` link word |
| A15 | `Please show me a picture of the Moon` | images | `the Moon` | 13: politeness before a request |
| A16 | `Could you please pull up some images of Venice?` | images | `Venice` | 19 |
| A17 | `I'd like to see photos of Kyoto` | images | `Kyoto` | 19 |
| A18 | `Let me see pictures of Iceland` | images | `Iceland` | 19 |
| A19 | `Look up pictures of the Hubble` | images | `the Hubble` | 19 |
| A20 | `Search for images of auroras` | images | `auroras` | 19 |
| A21 | `Show me pictures of a watch` | images | `a watch` | 2 |
| A22 | `Show me photos of Apple Watch bands` | images | `Apple Watch bands` | 2 |
| A23 | `Find a clip of the Moon landing` | videos | `the Moon landing` | 2 |
| A24 | `What do koalas look like?` | images | `koalas` | 5 |

B. Negative cases: `isMediaRequest` must be **false**.

| # | Prompt | Covers |
|---|---|---|
| B1 | `How does image compression work?` | existing |
| B2 | `What is image processing?` | existing |
| B3 | `Picture this scenario: a city with no cars.` | existing |
| B4 | `Explain the image of the soul in Plato` | existing |
| B5 | `How do I resize an image in Python?` | existing |
| B6 | `How do I find an image in Python?` | existing |
| B7 | `What is a video codec?` | existing |
| B8 | `Find the image size in Python` | 1 |
| B9 | `Get image dimensions with PIL` | 1 |
| B10 | `Display the image in a React component` | 1 |
| B11 | `Show me how image compression works` | 1 |
| B12 | `Can you find a picture frame for 8x10 photos?` | 1 |
| B13 | `Did you see the video I sent?` | 1/14 |
| B14 | `Can you explain how to find an image in Python` | 14 |
| B15 | `Could you explain what a photo histogram is?` | 14 |
| B16 | `Please define image resolution` | 14 |
| B17 | `What does it look like?` | 5 |
| B18 | `What does this look like?` | 5 |
| B19 | `Why do photos look blurry at night?` | 19: `why` |
| B20 | `Define image resolution` | 19: `define` |
| B21 | `Describe the picture` | 19: `describe` |
| B22 | `Tell me about the photo of the Earthrise` | 19: `tell me about` |
| B23 | `Imagine a picture of a cat` | 19: `imagine` |
| B24 | `What's a good photo editor?` | 19: `what's` |
| B25 | `What was the first photo ever taken?` | 19: `what was` |
| B26 | `What are the best image formats?` | 19: `what are` |
| B27 | `How can I get photos off my iPhone?` | 19: `how can` |
| B28 | `How to take photos of the moon` | 19: `how to` |
| B29 | `How is a video compressed?` | 19: `how is` |
| B30 | `Picture a beach at sunset` | 19: `picture a` |

C. Cleanup-only cases: assert the exact query and the detection value shown. These matter because the `Show images` link uses `mediaQueryForQuestion` even when detection is false.

| # | Prompt | `isMediaRequest` | Query | Covers |
|---|---|---|---|---|
| C1 | `Please Please Me album cover photos` | false (`mentionsMedia` true) | `Please Please Me album cover photos` | 13 |
| C2 | `Show me Show Me the Money posters` | false | `Show Me the Money posters` | 13: only one request phrase removed |
| C3 | `please show me photos of The Who for me please!` | true | `The Who` | existing |
| C4 | `pictures of 123?!` | true | `pictures of 123` | existing (guard) |
| C5 | `Picture of Dorian Gray themes` | true | `Dorian Gray themes` | known limit, §9 |

Keep the existing tests for noun variants, the 4-word window (`show one two three four images of cats` is true; with `five` added it is false), the 180-character cap, `pageUrl` / `hasSourcePage`, engine names, and timeout versus cancel.

D. Other required tests (finding 19, outside `media-intent.test.js`), in fixture mode in `tests/electron/media-chat.test.js`:
- **D1, zero results:** the reply says `I couldn't find usable images for "…"` and shows the `Answer with text instead` button. Clicking it appends a text answer.
- **D2, SearXNG unreachable:** the `I couldn't reach your local SearXNG at …` message appears, and `Answer with text instead` does **not**.
- **D3, thumbnail error:** a thumbnail that fails to load shows `Preview unavailable`, and the card keeps its source line and buttons.
- **D4, receipt entries:** after an image answer, the receipt has thumbnail entries with category `image` and text `image thumbnail preview – no query, prompt, or AI output sent`.
- **D5, video watch page:** the video watch-page card has an open-source control and shows `Media host:` when it has no page (finding 3).

Fixture mode may add whatever test-only switches D1–D3 need (for example, an empty result set, a refused endpoint, or a broken thumbnail URL). These are test data only, with no change in behaviour, the same as Q1.

**4.3 Relevance terms (search-backend.js).** Add these to `MEDIA_QUERY_STOP_WORDS`: `can`, `could`, `would`, `you`, `want`, `see`, `like`, `look`, `some`, `pic`, `pics`, `photograph`, `please`, `me`. Keep the current behaviour of filtering icon engines (lucide, devicons) when nothing scores.

**4.4 Source website on each image card.**
- The card meta line becomes two lines.
  - Line 1, class `media-source`: `Source: <domain>`, where the domain comes from `pageUrl` (the web page the image appears on, for example `commons.wikimedia.org` or `en.wikipedia.org`). Clicking the domain opens `pageUrl` in a new tab with `window.sovereign.newTab`, the same as the existing "Open source page" button.
  - If there is no `pageUrl`, show `Image host: <domain of mediaUrl or thumbnailUrl>` as plain text. Hide the "Open source page" button and never label an image CDN as the "source page".
  - Line 2 stays as it is today: `Creator: … · License …`.
- The title, detail text, and the Open original / Copy / Download buttons stay unchanged.
- Video cards get the same source line.

**4.5 Thumbnail fallback.** Add `image.addEventListener('error', …)`, which replaces the `<img>` with the existing "Preview unavailable" text. The card stays, with its source link and buttons. Don't retry with the original full-size URL, so no extra requests are made.

**4.6 Ways out when detection is wrong, and the text fallback.** Each one is a single click. The original message stays, and the new answer is appended as a new assistant turn. Nothing runs automatically.

| Where | Control | What the click does |
|---|---|---|
| Any image or video answer (cards shown) | Small link-style button `Search text instead` | Answers the same question as text, skipping media detection. If **Search the web** is on, it runs the normal web answer (`streamWebAnswer`). If it is off, it runs the local answer (`streamLocalAnswer`), which goes through `ensureModelReady` as usual. |
| Image search ran but found nothing usable (0 results after filtering) | Primary button `Answer with text instead` | Same action as above. Not shown when SearXNG is unreachable or timed out, because a web text answer would fail the same way. In that case only the error from §5 is shown. |
| Text answer where `isMediaRequest` was false but `mentionsMedia(question)` is true | Small link-style button `Show images` (or `Show videos` if `mediaTypeForQuestion` says videos) | Runs the media search for this question, skipping detection, with `mediaQueryForQuestion(question)` as the query. If web is off, it behaves like the existing "Search web for images" button: the click counts as consent and turns web search on for this search. |

Implementation notes:
- Add `forceText` and `forceMedia` options to `answerQuestion()`. They skip `isMediaRequest` but **not** `downloadReferenceFromQuestion`. Reuse the existing retry path (`appendUser: false`) so the user's turn is not duplicated.
- Store the control on the message as `action: { type: 'answer-text' | 'search-media', question, mediaType }`. `search-media` already exists. Render it in `renderMessage()` next to the existing inline action, so it survives `persistCurrentChat()`. Disable it while `running`.
- A message shows at most one of these controls.
- To survive reopening a chat, the control must also be saved by `persistCurrentChat()`. Rendering it is not enough (see §4.7).

**4.7 Saved chats keep their cards and links (Q2).** A reopened chat must look the same as when it was saved.
- `persistCurrentChat()` (ask.js, around line 1558) currently saves only `id`, `role`, `content`, `sources` and `note`. Also save:
  - `action`: only `{ type, question, mediaType }`, and only when `type` is `answer-text` or `search-media`. This covers `Search text instead`, `Answer with text instead`, `Show images` / `Show videos` and the existing "Search web for images" button. The button label is worked out from `type`, `mediaType` and whether the message has `mediaResults`, so it doesn't need to be saved. `Answer with text instead` is the `answer-text` action on a message whose `mediaResults` is empty.
  - `mediaResults`: at most 5 items, each with only these fields: `id`, `stableId`, `type`, `title`, `pageUrl`, `hasSourcePage`, `sourceUrl`, `sourceDomain`, `mediaUrl`, `originalMediaUrl`, `thumbnailUrl`, `creator`, `license`, `downloadable`, `downloadKind`, `downloadUrl`, `downloadError`. That is the title, image URL, source-page URL and source site, plus what the card needs to look the same. Don't save `content` snippets or anything else.
- On reopen (the click handler in `renderChatHistory()`, around line 1607), clean the saved data before rendering:
  - Drop any URL that isn't `http:` or `https:`, because localStorage is not trusted input.
  - Drop any `action.type` other than the two allowed.
  - Keep the existing limits (40 messages, 50 chats).
- Rebuild `mediaTurns` from the restored messages (last 8), so `download the second image` still works after reopening.
- Don't re-run preflights on reopen. The saved `downloadable` flag only sets the button state. Clicking Download still goes through `media:download`, which checks the file again in main.js before saving.
- **Privacy on reopen.** Rendering saved cards loads their thumbnails again. These are image requests to the same thumbnail hosts saved in the chat, with no new hosts.
  - If the reopened chat has any `mediaResults` with a thumbnail, first `await window.sovereign.privacy.startActivity({ requestId, type: 'ask', purpose: 'saved-chat-media', query: '', localOnly: false })`, then call `selectPrivacyReceiptForActivity(requestId)`, and only then call `renderThread()`.
  - This way the thumbnail loads go into their own receipt, `Saved chat image previews`, as `image` / `image thumbnail preview – no query, prompt, or AI output sent` (§3, `recordPrivacyWebRequest`). They are not attached to whatever receipt was active before.
  - Nothing is sent except the thumbnail GETs (`no-referrer`). In particular, no SearXNG query and no prompt are sent.
  - If `startActivity` fails, still render the chat and show `Could not start a privacy receipt for saved images.` as an error status. Don't block reopening.
  - If the reopened chat has no media cards, behave exactly as today.

**4.8 Fixture data for the source-page assertion (Q1).** `mediaFixtureResults()` returns fixtures directly and skips `normalizeMediaResult()`. So each image fixture gets explicit `pageUrl` (the same value as its current `sourceUrl`) and `hasSourcePage: true`. This is test data only: no new fixtures, and no change to counts, titles, URLs or app behaviour. As a result, the first card shows `Source: maps.example`.

The "no source page" case (`Image host: …`) is covered by a unit test instead: in `tests/media-intent.test.js`, call `normalizeSearxngMediaResults()` from `src/search-backend.js` with one raw result that has `img_src` but no `url`, and assert that `pageUrl === ''` and `hasSourcePage === false`.

**4.9 Answers to Codex's questions (from CHANGES, 2026-11-05)**
- **Q1, fixture source fields / main.js scope: ANSWERED.** Yes, update `mediaFixtureResults()` with explicit `pageUrl` and `hasSourcePage`. Fixture and test data only, with no behaviour change. See §3 and §4.8.
- **Q2, saved action persistence: ANSWERED.** Yes, extend serialisation. Persist **both** the action controls and the media cards, so a reopened chat looks the same. Thumbnail loads on reopen must appear in the Privacy Receipt as image requests with their purpose, with no new hosts. See §4.7, §6 and manual step 12.

#### 5. Error handling
| Situation | What the user sees (assistant message and status) |
|---|---|
| SearXNG unreachable (`fetch failed` or `ECONNREFUSED`) | `I couldn't reach your local SearXNG at <endpoint>. Start it (docker compose up in searxng/) or check the endpoint in Settings.` Status shown as an error. |
| SearXNG timeout (current 8 s abort, not a user Stop) | `SearXNG did not respond within 8 seconds. Try again.` A user Stop still shows `Stopped.`, as today. Note that both currently surface as an `AbortError` from search-backend.js, so the code must tell a timeout apart from a user cancel. |
| HTTP 403 | Keep the existing hint about JSON format or the category in settings.yml. |
| 0 results, some engines failed | `I couldn't find usable images for "<query>". These image engines did not respond: <names>.` Also show the `Answer with text instead` button (§4.6). |
| 0 results, no engine failures | `I couldn't find usable images for "<query>".` Also show the `Answer with text instead` button (§4.6). |
| Preflight fails for a result | The card stays and Download is disabled (current behaviour). |
| Thumbnail fails to load | "Preview unavailable" placeholder (§4.5). |
| Concept question about images (`How does image compression work?`) | Normal web or local answer, not image cards, with a `Show images` link (§4.6). |
| Detection picked images but the user wanted text | `Search text instead` link on the image answer (§4.6). |

Never fall back to any cloud API, and never auto-enable web search. From local-only mode, only an explicit click (the existing "Search web for images" button or the new `Show images` link) can start a media search.

#### 6. Privacy impact
This adds **no new kinds of requests or hosts.** The only changes are better labels and fewer prompt words leaving the machine.

For one image request, the Privacy Receipt "Media image retrieval" lists:

| # | Request | Destination | Receipt category / "what was sent" | Change |
|---|---|---|---|---|
| 1 | `GET /search?q=<cleaned query>&categories=images` | Local SearXNG (127.0.0.1:8080 or a private-network endpoint; public endpoints are already refused) | `image` / `Image search query: <cleaned query>` | The query now drops filler words, so fewer words from the prompt go to SearXNG and its upstream engines. |
| 2 | SearXNG → upstream image engines | duckduckgo, bing, google cse, wikicommons, pexels, flickr, … | Not in the Electron receipt, because SearXNG makes these calls itself. The card note already says SearXNG contacts upstream websites. | Unchanged |
| 3 | Up to 5 `HEAD` preflights (`GET Range: bytes=0-0` fallback on 405/501) | Original image hosts, for example `upload.wikimedia.org` | `image` / `media validation request – no query, prompt, or AI output sent` | Unchanged |
| 4 | Up to 5 thumbnail `GET`s from the Ask tab (`no-referrer`) | Thumbnail hosts, for example `thumb.wikimedia.org`, `images.pexels.com`, `encrypted-tbn0.gstatic.com` | **Was** `other` / "trusted app/AI request…". **Now** `image` / `image thumbnail preview – no query, prompt, or AI output sent` | Relabelled only |
| 5 | User clicks the source domain or "Open source page" | Opens a normal web tab | Treated as web content, like any page the user opens (not in the AI receipt) | Unchanged |
| 6 | User clicks Download | Original image host | `image` / existing download entries | Unchanged |

The new controls in §4.6 only start requests when the user clicks them, and they reuse existing flows:

| Click | Requests | Receipt |
|---|---|---|
| `Search text instead` / `Answer with text instead` with web **on** | The normal web answer: SearXNG text search plus source-page reads | Existing web-answer receipt (`search` and `source-page` entries). No new kinds of request. |
| `Search text instead` / `Answer with text instead` with web **off** | None. The answer comes from the local model. | Local-only receipt, as today |
| `Show images` | Rows 1–4 above | New "Media image retrieval" receipt, as above |
| Reopen a saved chat that has image cards | Only thumbnail `GET`s (`no-referrer`) to the hosts already saved in that chat. No SearXNG query, preflight, prompt or AI output. | New receipt `Saved chat image previews`, with each entry `image` / `image thumbnail preview – no query, prompt, or AI output sent` (§4.7) |

As a result, the receipt summary line "Image/media hosts contacted: …" (privacy-receipt.js) will now include the thumbnail hosts. Nothing goes to any `CLOUD_AI_HOSTS` entry, and prompts, answers and chat history still stay local.

Option considered but not part of this task: routing thumbnails through SearXNG's `image_proxy` (already `true` in settings.yml) would hide the user's IP from thumbnail hosts. However, SearXNG's JSON output does not return proxied URLs, and building them needs the HMAC secret. Propose it as a separate task if wanted.

#### 7. Checks for Codex
- `npm run check` must pass, and it must actually run `tests/media-intent.test.js`. To verify this, temporarily change one expected query in the test, confirm that `npm run check` fails, then revert the change. Report this in CHANGES.
- `npm run test:electron:media-chat` must pass (fixture mode, no network), including the new `Source: maps.example` assertion.

#### 8. Manual test steps (for Sandeep)
1. Start SearXNG (`cd searxng && docker compose up -d`), then `npm start`. Open Ask AI and turn on **Search the web**.
2. Type `pictures of Mount Everest`. Expect up to 5 image cards of Everest, each with `Source: <site>` (for example `commons.wikimedia.org`). Click a source domain: the web page, not the raw image, opens in a new tab.
3. Repeat with `images of the Eiffel Tower`, `Can you show me photos of red pandas?`, `I want to see images of Mars` (the query must be exactly `Mars`; some off-topic results are possible, see §9) and `What does a snow leopard look like?`. Each should return relevant image cards, and the reply text should quote the cleaned query (for example `"red pandas"`).
4. Negative prompts: type each of `How does image compression work?`, `What is image processing?`, `Picture this scenario: a city with no cars.`, `Explain the image of the soul in Plato` and `How do I resize an image in Python?`. Each should give a normal text answer with no image cards. The ones that mention a picture or image noun should show a `Show images` link. Click it once and expect image cards in a new turn.
    - Also type `Find the image size in Python`, `Can you explain how to find an image in Python` and `Did you see the video I sent?`. Each should give a text answer, not image cards.
    - Known limit (§9): type `Picture of Dorian Gray themes`. Expect **image cards** for `Dorian Gray themes`, not a text answer. Click `Search text instead` and expect a text answer about the novel's themes in a new turn.
    - Type `Get Out poster images`. The reply must quote the query `"Get Out poster images"`, with no word dropped.
5. Type `Show me a map of Nepal` and `Find a video of Mount Everest`. Both should still work as before.
6. Open the **Privacy Receipt** for the image request. Check: one SearXNG `image` entry showing the cleaned query; `image` entries for the preflights; thumbnail hosts labelled `image` / "image thumbnail preview…"; no `other` / "trusted app/AI request" entries for thumbnails; and no cloud-AI hosts.
7. Thumbnail failure: in DevTools for the Ask tab, use Network › request blocking to block `*gstatic.com*`, then search again. Cards from that host show "Preview unavailable", and their source line and buttons still work.
8. SearXNG down: run `docker compose stop`, then ask `pictures of cats`. Expect the "couldn't reach your local SearXNG" message, with no hang and no cloud fallback. Restart SearXNG afterwards.
9. Web off: turn off **Search the web** and type `pictures of Mount Everest`. Expect the "Search web for images" button. Clicking it runs the search, as today.
10. `Search text instead`: on the image answer from step 2, click `Search text instead`. Expect a new text answer about Mount Everest below the cards, which stay. With web off, it should answer from the local model with no network entries in the receipt.
11. Nothing usable: type `pictures of qzxvbnmlkjhg`. Expect `I couldn't find usable images for "qzxvbnmlkjhg".` and an `Answer with text instead` button. Clicking it gives a text answer. With SearXNG stopped (step 8), this button must **not** appear.
12. Saved chat reopen: in Settings, turn on saving chats on this device. In one chat, make (a) an image answer (`pictures of Mount Everest`), (b) a text answer with a `Show images` link (`Explain the image of the soul in Plato`), and (c) a no-results answer with `Answer with text instead` (`pictures of qzxvbnmlkjhg`). Start a new chat, then reopen the saved one from the history list. Expect:
    - The image cards look the same: same titles, thumbnails, `Source: <site>` lines and buttons.
    - All three controls are present and work when clicked.
    - `download the second image` still downloads result 2.
    - The Privacy Receipt shows a new `Saved chat image previews` receipt listing only the thumbnail hosts already shown in that chat, each labelled `image` / "image thumbnail preview…". It has no SearXNG entry, no preflight entries and no cloud-AI hosts.
    - The receipt from the original search did not gain new entries.
    - Finally, reopen a saved chat with **no** image cards. Expect no new receipt.

#### 9. Known limits (accepted, do not fix in this task)
- **Ambiguous subjects can still return off-topic images.** For example, `Mars` can return Bruno Mars as well as the planet, and `Jaguar` can return the car or the animal. SearXNG ranks the results and we only filter by query terms. Do **not** add guessed context words (for example, appending "planet") or disambiguation rules. The user can make the query more specific (`images of the planet Mars`).
- Upstream engines (bing, brave, unsplash, …) are sometimes down. The fix reports this but cannot repair it.
- Detection is deliberately conservative, so some real image requests with unusual wording will get a text answer. The `Show images` link covers those cases.
- **Titles that start with a media noun are detected as image requests.** `Picture of Dorian Gray themes` matches rule (b) (`Picture of …`) and returns images for `Dorian Gray themes`. Don't add title lists or guess at intent. The `Search text instead` link (§4.6) is the way out. This is covered by test C5 and manual step 4.
- **Some technical prompts still match.** `I need to download an image from S3 with boto3` is still detected (`image from` is anchored). Accept this; the `Search text instead` link covers it.
- **Appearance questions are only matched exactly.** `What do red pandas look like in the wild?` is not detected (rule (c) needs `look like` at the end), and it gets no `Show images` link because it has no media noun. This is conservative on purpose.
- **Cleanup keeps a bare verb when no media unit follows it.** For example, `Find Finding Nemo pictures` searches `Find Finding Nemo pictures`. A slightly noisier query is accepted so that the subject is never cut.

### CHANGES (Codex)

#### Review follow-up — 2026-11-05

Addressed MUST FIX 1, 13, 14 and SHOULD FIX 16, 19 using the updated PLAN.

Files changed in this follow-up:
- `tests/media-intent.test.js`: added all required A1–A24, B1–B30 and C1–C5 assertions before code changes. Preserved the existing noun variants, four-word boundary, subject guard, length cap, source-page fields, engine diagnostics and timeout/cancel tests.
- `tests/electron/media-chat.test.js`: added D1–D5 before code changes: zero results and a working appended text answer; unreachable SearXNG with no text-fallback action; synthetic thumbnail error retaining the source/buttons; thumbnail receipt entries through the actual main-process monitor; openable video watch-page fixture and Media host label for a no-page video.
- `src/media-intent.js`: detection strips leading politeness before exclusions, anchors request media nouns to the specified link words or the end of the core, and excludes pronoun-only appearance questions. Cleanup removes at most one request phrase, only strips bare verbs before a complete media unit, and preserves subject titles. Detection and cleanup share the link-word list, including `about`. Only video/clip nouns select videos; `watch` stays an image subject, as required by A21–A23.
- `src/ask.js`: video cards without a page use `Media host:`, as required by D5.
- `src/main.js`: fixture-only empty/unreachable query switches for D1/D2; source-page fields on the video watch-page fixture for D5. The switches are gated by the existing media fixture mode.
- `docs/HANDOFF.md`: this follow-up and Status only. PLAN and REVIEW were preserved.

Finding 16: Claude's updated PLAN already documents the Dorian Gray limitation in §9 and manual step 4. Added C5 to lock in that accepted behavior; did not add title guessing or edit Claude's sections.

Deviations: none from the updated PLAN. The watch/pronoun cases and video-card adjustment are included because the updated PLAN explicitly requires their A/B/D tests. Other review suggestions outside this pass, including finding 4's receipt-attribution timing proposal, were not changed.

Validation:
- Red phase: `npm run check` exited 1 on the new title-preservation assertion (`Get Out poster images` incorrectly became `Out poster images`).
- Green phase: `npm run check` passed with all required new unit cases.
- `npm run test:electron:media-chat` passed with D1–D5 and all earlier assertions, using a temporary profile and test fixtures (sandbox escalation for Electron launch). D3 dispatches an image error event; D4 checks actual recorded thumbnail request entries.
- Repeated the required deliberate-failure check: changed one expected query to `INTENTIONALLY WRONG QUERY`; `npm run check` exited 1. Restored the expectation and reran successfully (exit 0).
- `git diff --check` passed. Live SearXNG/manual testing remains for Sandeep.

Manual focus: try the five coding prompts in REVIEW 1 and the polite exclusions in REVIEW 14; verify they answer as text. Try `Get Out poster images`, `Please Please Me album cover photos` via Show images, and `Show me Show Me the Money posters` cleanup; verify title words are retained. Use PLAN §8 step 4 for the accepted Dorian Gray exception.

Status: reviewing. No commit or push made.

#### Initial implementation


Implemented on 2026-11-05. The questions from the previous pass were resolved by PLAN §§4.7–4.9.

Files changed:
- `src/media-intent.js` (new): browser/Node intent helpers, conservative exclusions and request matching, subject-preserving query cleanup, media type, and mentionsMedia.
- `src/ask.html`: loads the new helper before ask.js.
- `src/ask.js`: uses the helpers; adds clickable source-page domains and image-host labels; replaces failed previews with a placeholder without fetching another image; adds explicit text/media fallback controls that append assistant turns; distinguishes unavailable/timeout/empty-result cases; saves/restores whitelisted actions and media cards, sanitizes saved URLs, and starts the saved-preview receipt before rendering. Forced text mode survives model setup and retry. Restored media references exclude download-confirmation cards so result numbers remain correct.
- `src/search-backend.js`: source-page fields, the specified relevance stop words, trimmed engine-name diagnostics (maximum 10), and timeout/user-cancel distinction for media searches.
- `src/privacy-attribution.js`: pure thumbnail-category helper.
- `src/main.js`: imports/uses that helper in request attribution, adds the specified image fixture fields, and accepts the saved-chat receipt purpose.
- `src/styles.css`: source-line and inline-link styles.
- `tests/media-intent.test.js` (new): all positive prompts with exact type/query assertions, all negative prompts, noun variants, request distance, subject preservation/guard/length, source-page normalization, engine diagnostics, and timeout versus cancellation.
- `tests/privacy-attribution.test.js`: thumbnail classification and model-download precedence cases.
- `tests/electron/media-chat.test.js`: source-line assertion plus saved-card/action round trip, saved receipt label, restored numbered download, local text fallback without duplicated user turns, and explicit Show images consent. Failed fixture assertions now exit nonzero.
- `package.json`: wires the new module syntax check and unit test into `npm run check` immediately after privacy-attribution tests.
- `docs/HANDOFF.md`: this CHANGES section and task status only; PLAN was preserved.

Plan deviations:
- No product behavior or scope deviations. Added regression assertions beyond the minimum requested source-line assertion to validate §§4.6–4.7, and made the fixture test exit nonzero on failure.
- The first Electron invocation aborted with SIGABRT in the sandbox. Retried with sandbox escalation using the test's temporary profile and fixture mode; it passed.
- Download/preflight behavior, SearXNG settings, ordinary text search, and Search UI were not changed.

Test results:
- Tests were written before implementation. The new intent test initially failed because the module did not exist; `npm run check` initially failed because the new privacy helper did not exist.
- `npm run check`: passed after implementation, including `tests/media-intent.test.js`.
- Required negative check: temporarily changed the Mount Everest expected query to `INTENTIONALLY WRONG QUERY`; `npm run check` exited 1 on that assertion. Restored the expectation; `npm run check` exited 0.
- `npm run test:electron:media-chat`: passed, including existing assertions, `Source: maps.example`, and the added interaction/persistence assertions. Local generation in the added fallback assertion uses a test stub, not a model download or cloud service.
- The new restored-download assertion initially exposed result-list replacement by a download-confirmation card; fixed restoration and reran successfully.
- In-memory renderer probes passed for zero-result engine diagnostics, unreachable endpoint wording, and saved action/URL sanitization.
- `git diff --check`: passed.
- Live SearXNG quality and manual UI steps were not exercised in this pass. Sandeep should use PLAN §8, especially prompts in steps 2–5, receipt labels in step 6, error/fallback cases in steps 7–11, and saved-chat restoration in step 12.

No commit or push was made.

### REVIEW (Claude)

Reviewed on 2026-11-05 against PLAN §1–§9. I read the full `git diff` and the untracked `src/media-intent.js` and `tests/media-intent.test.js`, ran both test commands, and probed detection with extra prompts. No code was changed.

**What I ran**
- `npm run check`: **exit 0**. It printed `media-intent tests passed`, wired in right after `privacy-attribution tests passed`.
- `npm run test:electron:media-chat`: **exit 0** (fixture mode, run locally with no sandbox problem).

**Findings**

1. **MUST FIX: detection still triggers on everyday coding and how-to prompts.** Rule (a) in PLAN §4.1 lets a request verb plus a singular media noun count as an image request. That is a gap in my plan, not a Codex deviation. Sandeep asked for conservative detection, and these prompts currently trigger image search (`isMediaRequest === true`). With web off, the user gets "I can retrieve real image results…" instead of an answer:
   - `Find the image size in Python`
   - `Get image dimensions with PIL`
   - `Display the image in a React component`
   - `Show me how image compression works`
   - `Can you find a picture frame for 8x10 photos?`

   Fix: for rule (a), the media noun must be followed by `of`, `from`, `showing`, `for` or `about`, or be the last word of the prompt (ignoring trailing `please` and punctuation). Add all five prompts to the negative list in `tests/media-intent.test.js`. Every current positive case still passes under this rule (I checked each by hand).

   Known residual: `I need to download an image from S3 with boto3` will still match (`image from`). Accept it and note it in PLAN §9; the `Search text instead` link covers it.
2. **SHOULD FIX: `mediaTypeForQuestion` treats "watch" as video.** `Show me pictures of a watch` and `Show me photos of Apple Watch bands` both search **videos**. Fix: return `videos` only when `video(s)` or `clip(s)` appears. Add both prompts to the unit tests.
3. **SHOULD FIX: video cards say "Image host", and the fixture watch page can't be opened.** The Electron test output shows card 1 as `Everest documentary watch page / Image host: video.example`, with no `Watch / Open source` button and no link. Two causes:
   - The video fixtures in `mediaFixtureResults()` did not get `pageUrl` / `hasSourcePage`. Q1 only covered image fixtures, so Codex followed the plan; the same fixture-only change applies.
   - The fallback label is hard-coded as "Image host".

   Fix: add `pageUrl` to the video watch-page fixture. Use `Media host:` for video cards. Assert in the Electron test that the watch-page card has an open-source control.
4. **SHOULD FIX (needs a runtime check): thumbnail loads can be logged in the wrong receipt.** `renderThread()` rebuilds every card on each update, and thumbnails use `loading='lazy'`. A thumbnail that loads later (scrolled into view, or a failed or uncached image requested again on re-render) goes into **whichever receipt is active at that moment**. For example:
   - a following local-only Ask receipt would show "Image/media hosts contacted: …" instead of "Nothing left this device";
   - off-screen cards in a reopened saved chat can miss the `Saved chat image previews` receipt that §4.7 promises.

   Entries are still recorded and labelled `image thumbnail preview`, so nothing is hidden, but they are attributed to the wrong activity. Fix: use `loading='eager'` for media thumbnails (at most 5 per answer). Add manual step 13: after an image answer, turn web off, ask a local question, and confirm that its receipt still says "Nothing left this device".
5. **SHOULD FIX: pronoun subjects.** `What does it look like?` is detected as an image request with the query `it`. Following PLAN §9, don't guess the subject. Make rule (c) not match when the subject is only a pronoun (`it`, `this`, `that`, `they`, `them`, `he`, `she`). Add a negative test.
6. **SHOULD FIX: these PLAN cases have no automated test.**
   - The zero-results message plus `Answer with text instead`, and that this button is hidden when SearXNG is unreachable or timed out (Codex used an in-memory probe that isn't saved).
   - The unreachable-SearXNG wording mapping in `streamMediaAnswer()`.
   - The §4.5 `Preview unavailable` fallback.
   - End-to-end receipt entries for thumbnails (category `image`, text `image thumbnail preview…`). Only the helper is unit-tested, and the Electron test checks only the saved-chat receipt label.
   - The new negatives from findings 1, 2 and 5.

   Add the zero-results and unreachable cases to the media-chat Electron test (fixture mode), at minimum.
7. **OK: plan coverage.** Every item in §3–§4.9 is implemented:
   - `media-intent.js` is wired into ask.html.
   - The source line, the `Image host` fallback and the hidden `Open source page` button are in place.
   - The thumbnail `onerror` placeholder is added with no retry.
   - The three action controls work, using `forceText` / `forceMedia`, which survive model setup and Retry.
   - `unresponsiveEngines` is returned (max 10).
   - Timeout and cancel are now distinguished.
   - Saved chats keep the whitelisted action and card fields; reopening sanitises URLs to http(s), rebuilds `mediaTurns` and starts the saved-chat receipt before rendering.
   - Fixture fields and the `purpose` label are in place.

   The deviations listed in CHANGES (extra assertions, the sandbox retry) are explained and acceptable.
8. **OK, with two nits: error messages.**
   - Unreachable (`fetch failed`, `ECONNREFUSED`, `ERR_CONNECTION_REFUSED`), timeout, user Stop and 0 results (with or without failed engines) each match PLAN §5. On errors, `action: null` correctly suppresses `Answer with text instead`.
   - Nit: the backend hard-codes "8 seconds" even if `timeoutMs` changes.
   - Nit: other media errors (for example the 403) are shown raw, with Electron's `Error invoking remote method 'search:media': Error:` prefix. Strip that prefix.
9. **OK, with one nit: action links.**
   - `Search text instead` appears on image answers and `Answer with text instead` on empty results.
   - `Show images` appears only on text answers where `mentionsMedia && !isMediaRequest`.
   - New answers are appended without duplicating the user turn, and the controls are disabled while running.
   - Nit: the original local-only "Search web for images" button stays clickable after use, so each extra click appends another search. Each click is still an explicit choice, so it's acceptable.
10. **OK: privacy.**
    - No new request types or hosts, and no cloud-AI calls.
    - SearXNG receives only the cleaned query, which has fewer prompt words than before. The only new data coming back is engine names.
    - Ask/Search-tab thumbnails are now `image` / "image thumbnail preview – no query, prompt, or AI output sent" (the Ask page loads no other remote images).
    - Reopening a saved chat with cards creates `Saved chat image previews` and sends only thumbnail GETs (`no-referrer`). There is no SearXNG call, preflight or prompt, and downloads are still re-checked in main.js.
    - The attribution timing issue is finding 4.
11. **OK: tests run.** The new unit test is in `check` and runs. Codex's deliberate-failure check is reported in CHANGES. The test exits non-zero on failure (`assert`, plus `process.exitCode = 1` in the async part).
12. **OK: scope and secrets.**
    - Changes stay within the files PLAN §3 lists.
    - Small extras: `savedMessage()` also sanitises saved source URLs (harmless hardening), and `receiptTypeLabel()` shows the saved-chat label (needed).
    - No `.env` files, keys, tokens or credentials were added, and nothing was committed.

**Addendum: rule-by-rule review of the untracked files** (`src/media-intent.js`, `tests/media-intent.test.js`) against PLAN §4.1–§4.2. `git diff` doesn't show untracked files, so I checked each rule directly and probed it with `node`. These numbers continue the list above.

13. **MUST FIX: query cleanup removes part of the subject (breaks PLAN §4.2 "must never remove the subject").** In `mediaQueryForQuestion()`, step 1 strips the bare verbs `show`, `find`, `get` and `give`, and repeats until nothing more matches. That eats titles and names that start with those words:
    - `Get Out poster images` (detected as an image request) becomes **`Out poster images`**.
    - `Please Please Me album cover photos` is not detected, but it gets a `Show images` link, and that link searches **`Me album cover photos`**.
    - `Show me Show Me the Money posters` becomes **`the Money posters`**. This one isn't reachable today, but it shows the same flaw.

    This is a gap in my plan, because step 1 listed the bare verbs and said "repeatedly". The fix:
    - (a) Strip politeness (`can/could/would you (please)`, `please`, `I want / would like / 'd like to see`, `let me see`) at most once each.
    - (b) Then strip at most **one** request phrase.
    - (c) Strip a bare `show`, `find`, `get` or `give` (without `me`) only if the step-2 media unit (for example `pictures of`) follows straight after; otherwise keep the verb as part of the subject.

    Add all three prompts as exact-query tests (`Get Out poster images`, `Please Please Me album cover photos`, `Show Me the Money posters`). The existing 10 positive queries are unaffected by this change.
14. **MUST FIX (part of finding 1): the exclusions are skipped when the prompt starts with politeness.** The exclusion regex only checks the start of the prompt, so `Can you explain how to find an image in Python` is detected as an image request (`true`). Fix: check the exclusion openers *after* removing leading politeness (`can/could/would you (please)`, `please`). Also add `Did you see the video I sent?` (currently `true`, a video search) as a negative. The tighter rule (a) from finding 1 fixes that one, but it needs a test.
15. **OK: detection rules match PLAN §4.1.**
    - The noun list matches (singular and plural).
    - Rule (c), "what does X look like", is checked before the exclusions, as specified.
    - Every exclusion opener works. I probed `why`, `define`, `describe`, `tell me about`, `imagine`, `what's`, `how can`, `how to`, `picture this` and `picture an`, and each returned `false`.
    - The rule (a) 4-word window and rule (b)'s leading `a/an/some/a few/any/number` both match the plan.
    - `mentionsMedia` matches whole words only (`photographic imaging` gives `false`).
16. **SHOULD FIX: record a known limit in PLAN §9.** Rule (b) matches book and film titles that start with a media noun: `Picture of Dorian Gray themes` is detected as an image request with the query `Dorian Gray themes`. Per §9, don't guess here. Document it, rely on the `Search text instead` link, and add it to manual step 4 so Sandeep sees the behaviour.
17. **OK, with one nit: the rest of query cleanup matches PLAN §4.2.**
    - The media unit is removed once and maps are kept.
    - Trailing `please`, `for me` and `?.!` are trimmed in a loop.
    - Articles are kept.
    - The subject guard (`\p{L}` check, falling back to the original minus punctuation) and the 180-character cap work.
    - All prefix variants clean correctly: `Could you please pull up some images of Venice?` gives `Venice`, `I'd like to see photos of Kyoto` gives `Kyoto`, `Let me see pictures of Iceland` gives `Iceland`, `Look up pictures of the Hubble` gives `the Hubble`, and `Search for images of auroras` gives `auroras`.
    - Nit: `What do red pandas look like in the wild?` is not detected (rule (c) needs `look like` at the end), and it gets no `Show images` link because it contains no media noun. That is conservative and acceptable. Note it in §9.
18. **OK: `tests/media-intent.test.js` covers PLAN §4.1 / §4.2 as written.**
    - All 10 positive rows check detection, type and the **exact** query.
    - All 7 required negatives are tested.
    - Also covered: noun variants, the 4-word boundary, the subject guard, the length cap, `pageUrl` / `hasSourcePage`, engine names, and timeout versus cancel.
    - Any failure exits non-zero.
19. **SHOULD FIX: the unit tests are missing these cases.**
    - One negative test per exclusion opener not yet covered: `why`, `define`, `describe`, `tell me about`, `imagine`, `what's`, `what was`, `how can`, `how to`, `how is`, `picture a`. Today only 5 of the 14 openers are exercised.
    - Exact-query tests for the politeness and request variants in finding 17 (`could you please`, `I'd like to see`, `let me see`, `pull up`, `look up`, `search for`).
    - The new cases from findings 1, 2, 5, 13 and 14.

**Verdict (updated):** Not ready to commit. Fix the MUST FIX items 1, 13 and 14. Items 2–6, 16 and 19 are strongly recommended before Sandeep's manual pass. Findings 1 and 13 come from gaps in my PLAN, so I'll update PLAN §4.1 / §4.2 / §9 if Sandeep asks. Of these, 3 and 4 matter most, because they affect what users see and what the receipts show.

**Re-review (2026-11-05): items 1, 13, 14, 16 and 19 only**

How I checked:
- I read the current `src/media-intent.js` and `tests/media-intent.test.js`. Both are still untracked.
- I ran every row of PLAN §4.2.1 tables A (24 rows), B (30 rows) and C (7 rows, including the two 4-word-window cases) against the real module, using a separate script in the scratchpad. **0 failures.**
- `npm run check`: **exit 0**. The output includes `media-intent tests passed`, after `privacy-attribution tests passed`.

Results:
- **Item 1: OK.**
  - Rule (a) now requires the media noun to be anchored: followed by `of`, `from`, `showing` or `about`, or the last word after the trailing trim (`media-intent.js` lines 36–38).
  - B8–B13 (`Find the image size in Python`, `Get image dimensions with PIL`, `Display the image in a React component`, `Show me how image compression works`, `Can you find a picture frame for 8x10 photos?`, `Did you see the video I sent?`) all return false and are in the test file.
  - Positives that rely on the "last word" anchor (`Show me Paris photos`, `Get Out poster images`) still pass.
- **Item 13: OK.**
  - Query cleanup now removes politeness only when a request or media unit follows it.
  - It removes at most one request phrase, and removes a bare verb only when a media unit follows straight after it (lines 49–63).
  - Test results: `Get Out poster images` gives `Get Out poster images`; `Please Please Me album cover photos` keeps the full query; `Show me Show Me the Money posters` gives `Show Me the Money posters`; `Find Finding Nemo pictures` keeps the subject.
  - All four are in the tests (A11, A12, C1, C2), and `mentionsMedia` for C1 is asserted.
- **Item 14: OK.** Politeness is removed before the exclusion check (lines 31–35). `Can you explain how to find an image in Python`, `Could you explain what a photo histogram is?` and `Please define image resolution` all return false and are tested (B14–B16).
- **Item 16: OK.** The PLAN records the limit in §9 and in manual step 4. Test C5 locks in the accepted behaviour (`Picture of Dorian Gray themes` is detected, with query `Dorian Gray themes`). No guessing by title was added.
- **Item 19: OK.**
  - Every exclusion opener now has a negative test (B19–B30, plus the existing B1–B7).
  - The politeness and request variants have exact-query tests (A15–A20).
  - Finding 2 (`watch` is no longer video) is covered by A21–A23, and finding 5 (pronoun subjects) by A24, B17 and B18.
  - All failures throw, so `npm run check` exits non-zero.

Not re-checked in this pass, because it was out of scope: items 3, 4 and 6 (the video card label and fixture, the timing of receipt attribution for lazy thumbnails, and the Electron tests D1–D5), and `npm run test:electron:media-chat`. Their status above is unchanged.

**Verdict for this pass:** items 1, 13, 14, 16 and 19 are fixed, with no MUST FIX left among them.

## Feature test pass
Status: planning (review only, no code changed)
Reviewed by Claude on 2026-11-05, on branch `phase-0/feature-test`, after the merged image-retrieval fix (`d45bd99`).

**How this was done:** I read the code for each feature and probed the pure functions with `node` from the scratchpad. I did not click through the running app, so every manual step below still needs Sandeep's hand test. "Bug" means something I can show from the code or a probe. "Risk" means something to watch for during the hand test.

### 1. Browsing (address bar, navigation, popups, permissions)
- **Files:** `src/main.js` (`classifyAddressInput`, `normalizeAddress`, `looksLikeNavigableAddress`, `navigateActive`, `createWebView`, `will-navigate`, `setWindowOpenHandler`), `src/renderer.js`, `src/index.html`, `src/preload.js`.
- **Bug, address bar, `word:` treated as a URL scheme.** `classifyAddressInput` decides any input that starts with `letters:` is an unsupported scheme. Probe results:
  - `Python: list comprehension` gives the error "Sovereign only opens http and https websites."
  - `Note:buy milk` gives the same error.
  - `example.com:8080/path` gives the same error, though `localhost:3000` and `192.168.1.1:8080` work.
  - Expected: the first two run a search, and the third opens `https://example.com:8080/path`.
- **Bug, privacy: no permission handler for websites.** There is no `setPermissionRequestHandler` or `setPermissionCheckHandler` anywhere in `main.js`. Electron's default **grants** permission requests (camera, microphone, geolocation, notifications, MIDI and others) without asking. Web tabs use `sandbox: true`, but that does not stop permission grants.
- **Risk:** every `window.open` from a page becomes a new foreground tab. There is no popup limit, so pop-up-heavy sites will open many tabs.
- **Hand test:**
  1. Type `wikipedia.org`, then `localhost:8080`, then `Python: list comprehension`, then `example.com:8080`. Check each one opens or searches correctly; the last two currently fail.
  2. Open `https://browserleaks.com/geo` and a webcam test page (for example `https://webcamtests.com`). Expected: a prompt, or a denial. Today the site probably gets access with no prompt. **This is the most important check in this pass.**
  3. Back, Forward and Reload on a normal site. Then a link with `target=_blank`, which should open one new tab.

### 2. Tabs (new, switch, close, reopen closed, detach, tab menu, find in page, bookmarks)
- **Files:** `src/main.js` (`createTab`, `closeTab`, `reopenClosedTab`, `recentlyClosedTabs`, `detachTabToNewWindow`, `showTabContextMenu`, find-bar handlers, bookmarks IPC), `src/renderer.js`, `src/bookmarks.js` / `.html`, `src/newtab.js` / `.html`.
- **Bugs:** none seen in the handlers I read.
- **Risk:** `reopenClosedTab` reopens by `entry.url`. If you close an Ask AI tab and reopen it, the chat is not restored (unless chat saving is on). Expected, but users may be surprised.
- **Hand test:**
  1. Cmd+T, open three sites, then switch tabs by clicking and with the keyboard.
  2. Close a tab, then reopen it with Cmd+Shift+T: the same URL comes back.
  3. Drag a tab out of the window (detach). It moves to a new window and keeps working.
  4. Right-click a tab and use the tab menu.
  5. Cmd+F to find in page: Next, Previous, then Esc clears the highlight.
  6. Bookmark the page, rename it, open it from the Bookmarks page, then remove it.

### 3. Search page (Sovereign Search, results only)
- **Files:** `src/search.js`, `src/search.html`, `src/search-backend.js` (`searchSearxng`, `normalizeSearxngEndpoint`), `src/main.js` (`handleSearchQuery`, `search:cancel`).
- **Bugs:** none new. The endpoint is restricted to localhost or a private network (good).
- **Known issue (1)** applies here: see Privacy Receipt.
- **Hand test:**
  1. Run SearXNG and search `history of tea`. Expect up to 5 results; clicking a title opens a new tab.
  2. Press Cancel during a search; the status should say it was canceled.
  3. Stop SearXNG and search again. Expect a clear error, not a hang. The error appears within about 8 seconds.

### 4. Ask AI (local model chat, with or without web)
- **Files:** `src/ask.js`, `src/ask.html`, `src/ai/ai-engine-entry.js` (bundled to `src/generated/ai-engine.bundle.js`), `src/model-setup.js` / `.html`, `src/main.js` (model-setup IPC, `ask-handoff:*`), `src/search-utils.js`.
- **Known issue (2), the Search the web / Attach bar overlaps the end of the chat. Root cause found.**
  - `.ask-page` (`src/styles.css` around line 1444) uses `grid-template-rows: auto auto auto auto minmax(0, 1fr) auto auto`.
  - That row list assumes the receipt panel, the model-setup card and the saved-chats panel are all visible. All three are usually `hidden` (`display: none`), so they drop out of the grid and everything after them moves up.
  - The `1fr` row then lands on `.chat-composer` instead of `.chat-thread`. The thread sits in an `auto` row and grows past the screen. With `overflow: hidden` on the page, the controls, attachment panel and composer get squeezed over the end of the conversation.
  - Fix: pin the thread to the stretching row whatever is hidden. Either use a flex column with `.chat-thread { flex: 1 1 auto; min-height: 0 }`, or give each child an explicit `grid-row` / `grid-template-areas`. This is CSS only.
- **Risk:** the local model needs WebGPU. If WebGPU is missing, check that the message is clear and that there is no cloud fallback. There is none in the code.
- **Hand test:**
  1. With web off, ask `What is photosynthesis?`. Expect a local answer, and a receipt saying "Nothing left this device".
  2. Ask 6–8 more questions until the chat scrolls. The last message must be fully visible above the controls bar: this is the check for known issue (2). Resize the window narrow and wide and check again.
  3. Press Stop during generation, then Retry, then Copy, and export Markdown and PDF.
  4. Turn saving on in Settings, reload Ask AI, and reopen the chat from the history list.

### 5. Citations (numbered `[n]` links in web answers)
- **Files:** `src/search-utils.js` (`buildSourceAnswerMessages`, `finalizeSearchAnswerWithMeta`, `validCitationNumbers`, `citationSupportsSentence`), `src/ask.js` (`appendInlineMarkdown`, `renderSources`, `evidenceResultsForSources`).
- **Bugs:** none seen. Citation numbers map to sources by result `id`, and invalid numbers are filtered out.
- **Hand test:**
  1. With web on, ask `When was the Eiffel Tower built?`. Every `[n]` should link to source n. Click each one: the right page opens.
  2. Check that no `[n]` points past the end of the source list, and that a sentence with no source has no citation.

### 6. Reading sources for a fuller answer
- **Files:** `src/source-reader.js` (max 3 pages, 10 s timeout, 1.25 MB cap, manual redirects with each hop checked), `src/main.js` (`handleReadSources`, receipt label "Read sources"), `src/ask.js` (`streamWebAnswer`).
- **Decided (Sandeep, 2026-11-05):** automatic reading of the top 3 sources is the intended behaviour. **No separate button.** With web on, Ask AI always reads the top 3 source pages and then answers. `README.md` (line 132) and `docs/privacy-audit.md` (line 50) still tell users to click "Read sources for a fuller answer"; see fix #14. The receipt label `Read sources` in `src/main.js` names the activity, not a button, so it stays.
- **Good:** redirects are followed manually, so every hop appears in the receipt as `source-page`.
- **Hand test:**
  1. With web on, ask a question and open the receipt. Expect 1 SearXNG `search` entry plus up to 3 `source-page` entries, each with its host.
  2. Ask about a page that redirects (for example an `http://` link). Each hop should be listed.
  3. Check the answer's note says whether it is a full answer or source excerpts.

### 7. Page summary (sidebar)
- **Files:** `src/sidebar.js` / `.html`, `src/summary-utils.js`, `src/main.js` (`ai:extract-active-page-text`, `extractActivePageText`, `ai:update-tab-state`).
- **Bugs:** none functional. Cleanup: `summarizePage()` still builds debugging `promptDiagnostics` (regexes for "compact/extensive standard library" left over from a test). They are harmless but unrelated code.
- **Hand test:**
  1. Open a long article and the sidebar. Load the model, then Summarize. A summary should stream in.
  2. Switch tab mid-summary: the summary stays with the original tab.
  3. Press Stop: the status shows stopped, not an error.
  4. Summarize a page with little text (for example `about:blank`, or an image-only page). Expect a clear message.
  5. Open the receipt: summarising sends nothing over the network.

### 8. Document attach (PDF / TXT / MD / CSV)
- **Files:** `src/ask.js` (`addFiles`, `validateAttachmentFile`, `reprocessAttachment`, `attachmentBlocker`; limits: 3 files, 25 MB PDF, 5 MB other, 60 MB total, 200,000 characters), `src/pdf-extract-worker.js` (bundled to `src/generated/`), `src/main.js` (`ask-handoff:*` for attachments from the home page).
- **Bug, small: rejected files use up a slot.** A rejected file (wrong type or too big) is still pushed into `attachments` with status `error`, so it counts toward the 3-file limit until the user removes it.
- **Bug, misleading text:** the drop zone says attachments are kept "if chat saving is enabled", but `savedMessage()` saves no attachment data. Fix the text or the behaviour.
- **Hand test:**
  1. Attach a text PDF and ask `Summarize this document`. Expect an answer from the file and a "Nothing left this device" receipt.
  2. Attach a scanned (image-only) PDF. Expect the "No extractable PDF text" message.
  3. Attach a `.docx`. It should be rejected, and you should still be able to add 3 valid files.
  4. Attach a CSV and ask about one of its columns.
  5. Drag and drop onto the drop zone. Attach from the home page, which hands the files over to Ask AI.

### 9. Image search, download and copy link (Ask AI)
- **Files:** `src/media-intent.js`, `src/ask.js` (`streamMediaAnswer`, `validatedMediaResults`, `renderMediaCards`, `answerMediaDownloadReference`), `src/search-backend.js` (`searchSearxngMedia`), `src/main.js` (`search:media`, `media:preflight`, `media:download`, `preflightDownloadUrl`), `src/privacy-attribution.js`.
- **Still open from the image-retrieval REVIEW, item 4:** thumbnails still use `loading='lazy'` (`ask.js` around line 615). Thumbnails that load late can be logged in whichever receipt is active then.
- **Bug, privacy: redirects during media checks aren't listed.** `preflightDownloadUrl` uses `redirect: 'follow'`, so when an image URL redirects to a different host, only the first host is listed in the receipt. The final host is contacted but not listed. (`media:download` does log the final URL.) Fix: when `response.url`'s host differs, add a receipt entry for it, or follow redirects manually as `source-reader.js` does.
- **Hand test:** PLAN §8 steps 1–12 of "Fix Ask AI image retrieval", plus:
  1. Click **Copy image URL** and paste it into the address bar: the image opens.
  2. **Download** an image, and type `download the second image`.
  3. In the receipt, look for any preflight to a URL that redirects (Wikimedia `Special:FilePath` links redirect). Compare the hosts you see in DevTools' Network panel with the ones in the receipt.

### 10. Downloads
- **Files:** `src/main.js` (`setupDownloadHandlingForSession`, `will-download`, `chooseSavePathForFilename`, `uniqueDownloadPath`, `downloads:*` IPC, context-menu "Save Image As…"), `src/downloads.js` / `.html`, the downloads popover in `src/renderer.js`.
- **Risk, rare:** `uniqueDownloadPath` uses `existsSync` before any bytes are written. Two downloads with the same filename that start at the same moment can pick the same path, and one overwrites the other.
- **Hand test:**
  1. Download a large file and Pause / Resume / Cancel it.
  2. Download the same file twice: you should get `name (1).ext`.
  3. Use Show in folder and Open file.
  4. Clear finished downloads.
  5. Change the download folder in Settings and turn on "Ask where to save".
  6. Right-click an image on a site, Save Image As, and check the file type is correct.

### 11. Privacy Receipt
- **Files:** `src/privacy-receipt.js` (`createReceipt`, `addEntry`, `buildSummary`, `fetchWithReceipt`, the cloud-AI host check), `src/privacy-attribution.js`, `src/main.js` (`recordPrivacyWebRequest`, `makeReceiptFetch`, `privacy:*` IPC), the receipt panels in `src/ask.js` and `src/search.js`.
- **Known issue (1), the receipt doesn't say SearXNG forwards the query. Confirmed.**
  - `buildSummary` writes "Query sent to 127.0.0.1:8080 (SearXNG)" and nothing else. SearXNG then sends the query, in full, to upstream engines (duckduckgo, bing, google cse, startpage, qwant, mojeek, wikipedia, …, from `searxng/core-config/settings.yml` plus the defaults).
  - Those calls come from the SearXNG container, not Electron, so they can never show up as Electron requests.
  - Fix, which needs no new network request: add a fixed disclosure line to search and image receipts, such as "SearXNG forwards this query to upstream search engines". Also list the engine names SearXNG reports in its JSON (`results[].engines`, `unresponsive_engines`). `normalizeResult` currently throws these away.
- **Bug, wrong receipt:** if `addEntry` gets an unknown receipt id, it falls back to `receipts[0]`, the newest receipt, which may be a different activity. It should go to the Background receipt.
- **Note:** receipts are kept in memory only and disappear on restart, by design (the export note says so). Export JSON is the only way to keep them.
- **Hand test:**
  1. Run a web answer and open the receipt. Today it shows only SearXNG; after the fix there should be an upstream-engines line.
  2. A local-only answer should say "Nothing left this device".
  3. Run an image search, then click Export JSON and open the file.
  4. Check the cloud-AI check never fires during normal use (no `api.openai.com` or similar).

### 12. Settings
- **Files:** `src/settings.js` / `.html`, `src/theme.js`, `src/main.js` (`settings:*`, `search:update-settings`, `savePreferences`, `preferences.json` in the user-data folder).
- **Bug, privacy: turning chat saving off keeps old chats.**
  - Turning off "Save chats on this device" makes `savedChats()` / `writeSavedChats()` stop reading and writing, but the old chats stay in `localStorage` under `sovereign.ask.chats`.
  - "Clear history" does nothing while saving is off, and its panel is hidden.
  - So a user who turns saving off cannot delete old chats in the app, and they come back if saving is turned on again.
  - The help text "When disabled, Ask AI chat history stays in memory" implies nothing is stored. Fix: when saving is turned off, offer "Delete saved chats now?" (or delete them), and let Clear history work in either state.
- **Hand test:**
  1. Change the theme.
  2. Set the SearXNG endpoint to `https://searx.example.org`. It must be refused (public instance). Then try `192.168.1.10:8080`, which is accepted.
  3. Change the model; start and cancel model setup.
  4. Turn saving on, save two chats, turn saving off, then on again. Today the old chats come back.
  5. Turn "Restore session" on, quit and relaunch: the tabs come back.

### 13. Startup: Chromium database errors (known issue 3)
- **Logs:** "Failed to delete the database: Database IO error" and "Could not open the quota database, resetting".
- **Files:** `src/main.js` (startup: `SOVEREIGN_USER_DATA_DIR`, `app.whenReady`, dataset-collection mode `runDatasetCollection`). The profile is `~/Library/Application Support/sovereign-browser/` (`WebStorage/QuotaManager`).
- **Likely cause:**
  - Chromium's QuotaManager database couldn't be opened or locked, so it was rebuilt. `WebStorage/` on disk was recreated today at 21:15, which fits a reset.
  - `main.js` has **no `app.requestSingleInstanceLock()`**. A second `npm start`, or dataset-collection mode (`SOVEREIGN_DATASET_BATCH`, which uses the default profile), running alongside the app means two processes share one profile, which causes exactly these errors.
  - A force-quit or crash can do the same thing. The Electron tests are fine: all 12 set their own `SOVEREIGN_USER_DATA_DIR`.
- **Impact:** usually harmless, because Chromium rebuilds the quota database. But a shared profile can also corrupt `localStorage`, which holds saved chats, and IndexedDB, which holds the cached model.
- **Fix:**
  - Add `app.requestSingleInstanceLock()`. A second launch then focuses the existing window and quits. Skip this in test and dataset modes, which should use their own user-data folder.
  - Give dataset-collection mode its own profile folder.
- **Hand test:**
  1. Quit every Sovereign window (Cmd+Q) and check Activity Monitor shows no Electron left. Run `npm start` once and check whether the two log lines appear. If they do, note whether the previous session was force-quit.
  2. While the app is running, run `npm start` again in a second terminal. Today you get two instances and the errors. After the fix the first window should just come to the front.

### Prioritised fix list
Each item is small and focused. One Codex task per line unless they are grouped.

| # | Priority | Fix | Files | Why |
|---|---|---|---|---|
| 1 | **P1, privacy** | Deny website permission requests by default, or ask the user (`setPermissionRequestHandler` plus `setPermissionCheckHandler` on the web-tab session) | `src/main.js` | Today sites can silently get the camera, microphone or location |
| 2 | **P1, privacy** | Receipt says SearXNG forwards the query upstream, and lists the engine names SearXNG reports (known issue 1) | `src/privacy-receipt.js`, `src/search-backend.js`, `src/main.js`, receipt UI in `src/ask.js` / `src/search.js` | The receipt currently understates where the query goes |
| 3 | **P1, privacy** | Turning chat saving off offers to delete saved chats, and Clear history always works | `src/ask.js`, `src/settings.js` / `.html` | Chats stay on disk after the user opts out |
| 4 | **P2, usability** | Fix the Ask AI grid so the thread always takes the free space and nothing overlaps (known issue 2) | `src/styles.css` | The end of every long chat is hidden |
| 5 | **P2, bug** | Address bar: inputs with spaces, or `word:` with no `//`, are searches; `host:port` is a URL | `src/main.js` (`classifyAddressInput`) | Common searches give a false error |
| 6 | **P2, privacy** | List every redirect host in media checks (log the final URL's host, or follow redirects manually) | `src/main.js` (`preflightDownloadUrl`) | A contacted host is missing from the receipt |
| 7 | **P2, privacy** | Thumbnails load straight away instead of lazily (`loading='eager'`) (open image-review item 4) | `src/ask.js` | Late thumbnail loads are logged in the wrong receipt |
| 8 | **P2, stability** | Single-instance lock, and a separate profile for dataset mode (known issue 3) | `src/main.js` | Shared-profile database errors and a risk of corrupting `localStorage` / IndexedDB |
| 9 | P3 | `addEntry` with an unknown receipt id goes to Background, not the newest receipt | `src/privacy-receipt.js` | Entries can be attributed to the wrong activity |
| 10 | P3 | Rejected attachments don't count toward the 3-file limit; fix the drop-zone wording about saving | `src/ask.js`, `src/ask.html` | Confusing limits and wording |
| 11 | P3 | Make filenames unique for downloads that start at the same moment | `src/main.js` (`uniqueDownloadPath`) | Rare overwrite |
| 12 | P3, cleanup | Remove the leftover `promptDiagnostics` debugging code | `src/sidebar.js` | Unrelated debugging code |
| 13 | ~~Question~~ Answered | No separate "Read sources for a fuller answer" button. Automatic reading of the top 3 sources is the intended behaviour (Sandeep, 2026-11-05) | — | Closed; the docs follow-up is #14 |
| 14 | P3, docs | Replace the "Read sources for a fuller answer" wording with a description of automatic source reading: with **Search the web** on, Ask AI reads up to the top 3 source pages and answers from them. The pages appear in the Privacy Receipt as `source-page` entries. Change only those lines | `README.md` (line 132, feature table row "Read more source material"), `docs/privacy-audit.md` (line 50: delete step 3 and fold it into step 2, e.g. "Run one Ask AI question with **Search the web** enabled; Sovereign reads the top 3 source pages automatically". Renumber the image step from 4 to 3. Check the expected-hosts part of the audit still matches, since the source-page hosts now come from step 2) | The docs describe a button that doesn't exist. No code change; `npm run check` must still pass |
| 15 | P3, usability | If removing older-version chats fails again on a later startup, the pending cleanup is not shown to the user again (deleted chats still cannot return). Follow-up: show the pending notice whenever cleanup is still pending, with a regression test. | `src/main.js`, `src/ask.js`, `src/settings.js`, `tests/electron/chat-deletion.test.js` | A cleanup that keeps failing is invisible to the user |
| 16 | **P1, privacy/security** | **Safe redirect handling** (Sandeep, 2026-11-09, high priority). Follow redirects manually for both image validation (media preflight / download / copy link) and source reading. At **every hop**, check that the host resolves to a public address: block private, loopback and link-local ranges (IPv4 and IPv6, including IPv4-mapped IPv6), checked **after DNS resolution**, not only on the literal host. Stop after at most **5 hops**. List every contacted host in the Privacy Receipt, with the purpose and "redirect from &lt;host&gt;". Source pages that redirect (for example `http://` → `https://`) must be readable. Note from Task 3 testing: in Electron 38, `net.fetch`/`session.fetch` with `redirect: 'manual'` rejects with "Redirect was cancelled" instead of returning the 3xx, and `session.fetch`'s `response.url` is not updated after redirects, so the PLAN must use a mechanism that really exposes each hop (for example `webRequest.onBeforeRedirect` to validate the next hop and cancel it, or Node `http`/`https` with a pinned, pre-validated address). Needs Electron tests with a local redirect chain: public→private blocked, a 6-hop chain blocked, http→https source read OK, and every hop in the receipt | `src/main.js` (`preflightDownloadUrl`, `fetchForDownloadPreflight`, `recordPrivacyRedirect`), `src/source-reader.js`, receipt tests, new Electron test | Today a public image URL that redirects to a private address passes the check (SSRF gap), and source pages that redirect probably can't be read |
| 17 | ~~P3, usability~~ Done in "Chat layout overlap" round 2 | **Compact drop zone** (Sandeep, 2026-11-09). On Ask AI, the attachment drop zone stays one line until a file is dragged over the page or **Attach** is used; it then expands as it does today, and goes back to one line when it's empty again. Keyboard and screen-reader access to Attach must not change | `src/ask.html`, `src/ask.js`, `src/styles.css`, Ask AI layout test | In short windows the bottom stack takes about 300px and squeezes the chat (Task 1 follow-up) |

Each fix should come with an automated test where it's practical: pure functions (the address classifier, receipt summary, `addEntry`) in `tests/*.test.js`, which run under `npm run check`, and UI flows in the fixture Electron tests.

## Task: Website permissions
Status: ready for manual testing (not committed)

### PLAN (Claude)
This is item P1 #1 from the Feature test pass. Codex is out of usage today, so at Sandeep's request Claude both plans and implements this task, and also writes CHANGES.

#### 1. Problem
`src/main.js` never calls `setPermissionRequestHandler`, `setPermissionCheckHandler`, `setDevicePermissionHandler` or `setDisplayMediaRequestHandler`. Electron's defaults are:
- Every permission request is granted, including camera, microphone, location, notifications and MIDI.
- When a page asks for a Bluetooth device (`select-bluetooth-device`) and nothing handles it, **the first device is chosen automatically**.

Web tabs (`createWebView`) and Sovereign's own pages (`createTrustedInternalView`, the UI, sidebar and model-setup views) all use `session.defaultSession`. So one set of handlers covers everything. The code tells web pages and Sovereign's pages apart by the requesting URL.

#### 2. Policy
| Group | Permissions (Electron names) | Web pages | Sovereign's own pages (`sovereign:`, `file:`) |
|---|---|---|---|
| **Ask the user** | `media` with `mediaTypes` containing `video` (camera) and/or `audio` (microphone), `geolocation`, `notifications`, `midi`, `midiSysex`, `clipboard-read`, `pointerLock`, `keyboardLock`, `idle-detection`, `window-management`, `storage-access`, `top-level-storage-access`, `speaker-selection` | Prompt: **Deny** (default, and also Esc) or **Allow once** | Deny, no prompt |
| **Allowed without a prompt** | `fullscreen`, `clipboard-sanitized-write` | Allowed. Chromium only lets these run straight after a click or key press, and they read no user data (fullscreen for video players; writing text to the clipboard for "Copy" buttons). **Sandeep can veto this**: move them to "Ask the user" if wanted. | Deny |
| **Always denied** | Everything else: `openExternal`, `mediaKeySystem`, `display-capture`, `fileSystem`, `hid`, `serial`, `usb`, `deprecated-sync-clipboard-read`, `unknown`, and any new name | Deny, no prompt | Deny |
| **Device pickers** | `select-bluetooth-device` (web contents), `select-hid-device`, `select-serial-port`, `select-usb-device` (session); `setDevicePermissionHandler` | Cancel the picker / return `false` | Same |
| **Screen capture** | `getDisplayMedia()`: Electron first sends `media` with an **empty** `mediaTypes` list (verified with a probe), then would call `setDisplayMediaRequestHandler` | Deny with no prompt, recorded as `screen capture`. Never shown as a camera/microphone prompt | Deny |

**Sovereign's own pages need no website permissions.** I checked `src/*.js` and the AI bundle:
- Clipboard writes go through IPC to `clipboard.writeText` in main, not through a browser permission.
- Downloads go through IPC.
- The local model uses WebGPU and origin-private storage (`navigator.gpu`, `navigator.storage`), neither of which is a permission.
- No page uses `getUserMedia`, `Notification`, geolocation, MIDI or the browser clipboard.

So every permission request from these pages is denied and recorded.

**Check handler** (`setPermissionCheckHandler`, synchronous, used by `navigator.permissions.query` and the like): it returns `true` only for web pages asking about `fullscreen` or `clipboard-sanitized-write`, and `false` for everything else. **"Allow once" is never remembered:** the next request prompts again. Check-handler calls are not recorded, because they are status queries, not requests.

#### 3. The prompt
A native `dialog.showMessageBox` attached to the tab's window. If that window can't be found, it uses the focused window.
- **Title:** `Website permission`
- **Message:** `<site> wants to <action>.` Here `<site>` is the requesting origin (`URL.origin`, so internationalised domain names show in their `xn--` form, which makes look-alike spoofing harder), and `<action>` is one of:
  - `use your camera`, `use your microphone`, `use your camera and microphone`
  - `use your location`
  - `show notifications`
  - `use MIDI devices`, `use MIDI devices with full control (SysEx)`
  - `read your clipboard`
  - `hide and lock your mouse pointer`
  - `capture all keyboard keys`
  - `know when you are idle`
  - `see your screens and place windows on them`
  - `use its cookies while embedded in another site`
  - `choose your audio output device`
- **Detail:** if the request comes from an embedded frame, it adds `(inside <top-level origin>)`. It always adds: `Allow once grants this request only. Sovereign will ask again next time.`
- **Buttons:** `Deny` (default, also on Esc / cancel) and `Allow once`.
- **Order:** prompts are shown one at a time, in a queue.
- **When the request no longer applies:** if the tab is closed, or has moved to a different origin, before the user answers, the request is denied.
- **If the dialog fails:** the request is denied.

#### 4. Privacy Receipt
- Every request, and every device-picker or screen-capture attempt, is recorded with its decision in one receipt per app run: `Website permissions` (type `permissions`, id `website-permissions`).
- **Entry fields:** category `permission`, method `PERMISSION`, url = the requesting origin. "What was sent" reads `Permission request: <name> – <decision>`, with `(embedded in <origin>)` when the request comes from a frame.
- **Decisions:**
  - `allowed once by you`
  - `denied by you`
  - `allowed automatically (needs a click or key press; reads no user data)`
  - `denied automatically: not supported in Sovereign`
  - `denied automatically: Sovereign's own pages need no website permissions`
  - `denied: tab closed or page changed before you answered`
  - `denied: unknown site`
- **Summary:** `Website permission requests: N (M allowed)`.
- Permission entries are not network requests, so they are left out of the cloud-AI host check.
- The Ask AI and Search receipt panels must not jump to this receipt when it updates; they treat it like `background`.

#### 5. Files
| File | Change |
|---|---|
| `src/permission-policy.js` (**new**) | Pure logic with no Electron imports: the permission tables, `isInternalUrl`, `describePermission`, `classifyPermissionRequest`, `checkPermission`, and `createPermissionController({ prompt, record })`, which returns the `request` and `check` handlers (queue, re-check that the tab still exists and is on the same origin, deny on errors). |
| `src/main.js` | `setupPermissionHandling(targetSession)`: wires the controller to `setPermissionRequestHandler` / `setPermissionCheckHandler`, adds `setDevicePermissionHandler(() => false)`, the `select-*-device` / `select-serial-port` handlers and `setDisplayMediaRequestHandler`, plus `select-bluetooth-device` on every web contents (`app.on('web-contents-created')`). The prompt uses `dialog.showMessageBox`. Called for `session.defaultSession` at startup and for any other session (`app.on('session-created')`), at most once per session. |
| `src/privacy-receipt.js` | `permission` category, `addPermissionEntry()`, the summary line, and the cloud-check exclusion. |
| `src/ask.js`, `src/search.js` | Don't auto-select a `permissions` receipt (treat it like `background`). One line each. |
| `tests/permission-policy.test.js` (**new**) | See §6. |
| `tests/privacy-receipt.test.js` | Permission entry, summary and cloud-check exclusion. |
| `package.json` | Add `node --check src/permission-policy.js && node tests/permission-policy.test.js` to `check`. |

#### 6. Tests (unit tests, run in `npm run check`)
- Every "Ask the user" permission from a web origin is classified `prompt` with the correct action text. `media` gives camera, microphone or both. `media` with no `mediaTypes` (screen capture) is `deny`, with no prompt.
- `fullscreen` and `clipboard-sanitized-write` are `allow` for web pages and `deny` for Sovereign's own pages.
- `openExternal`, `display-capture`, `hid`, `usb`, `serial`, `unknown` and an invented permission name are `deny` with no prompt.
- Sovereign's own pages (`sovereign://ask/`, `file:///…/index.html`) get `deny` for every permission, with no prompt.
- An empty or unparseable origin gives `deny` ("unknown site").
- **Controller:**
  - "Allow once" calls back `true` exactly once.
  - "Deny" calls back `false`.
  - A prompt that throws gives `false`.
  - A tab destroyed before the answer gives `false`.
  - A page that moved to a different origin before the answer gives `false`.
  - The prompt is **never** called for a denied or allowed-without-a-prompt permission.
  - Callbacks are never `true` unless the prompt answered `allow` (or the permission is in the allowed-without-a-prompt group).
  - Two requests at once are shown one after the other.
  - Every request records exactly one receipt entry, with the right decision.
  - The check handler returns `true` only for web pages asking about `fullscreen` or `clipboard-sanitized-write`.
- **Receipt:** a permission entry has category `permission`. The summary counts requests and how many were allowed. An entry whose host is a cloud-AI host does not flag cloud AI.

#### 7. Manual test steps (for Sandeep)
1. `npm start`. Open `https://webcamtests.com` and click to test the camera. Expect the prompt `https://webcamtests.com wants to use your camera.`, with Deny selected by default.
   - Press **Deny**: the site reports that access was denied or blocked.
   - Reload and press **Allow once**: the camera works.
   - Reload again: you are asked again.
2. Open `https://browserleaks.com/geo`. Expect the location prompt. **Deny** means the site shows an error or denial.
3. Microphone: `https://mictests.com`. Expect `wants to use your microphone`.
4. Notifications: open the notification test page `https://www.bennish.net/web-notifications.html` (or any page that calls `Notification.requestPermission()`). Expect the prompt. With Deny, no notification appears.
5. Clipboard read: open DevTools on any https page (View › Toggle Developer Tools) and run `navigator.clipboard.readText()`. Expect the `read your clipboard` prompt. With Deny, the promise rejects.
6. Still on that page, run `navigator.permissions.query({ name: 'geolocation' }).then(s => s.state)`. It must **not** return `granted`, even after an earlier "Allow once".
7. Fullscreen: play a YouTube video and click its fullscreen button. It goes fullscreen with no prompt (allowed without a prompt, as planned).
8. Run `navigator.mediaDevices.getDisplayMedia()` in DevTools: it is rejected with no prompt.
9. Open any Ask AI or Search tab, open the Privacy Receipt and choose **Website permissions** from the history list. Each request from steps 1–8 is listed with its site, the permission and the decision (`allowed once by you`, `denied by you`, `denied automatically…`). The summary reads `Website permission requests: N (M allowed)`, and the cloud-AI check still says ✓.
10. While Ask AI generates an answer, open a permission prompt in another tab. The Ask AI receipt panel must stay on the Ask AI receipt and not jump to Website permissions.
11. Ask for camera access, then close the tab while the prompt is open. Answer **Allow once**: nothing is granted, and the receipt shows `denied: tab closed or page changed before you answered`.
12. Regression check: Ask AI (local and web), page summary, attachments, image search and downloads all still work, and none of them shows a permission prompt.

### CHANGES (written by Claude at Sandeep's request, because Codex is out of usage today)
Implemented on 2026-11-05. Nothing was committed.

**Files changed**
- `src/permission-policy.js` (**new**, no Electron imports):
  - The permission tables (ask the user / allowed without a prompt / always denied).
  - `classifyPermissionRequest`, `checkPermission`, `describePermission`, `promptText`, `isInternalUrl`, `webOrigin`.
  - `createPermissionController({ prompt, record })`, which returns the `request` and `check` handlers plus `recordAutoDenied`. Prompts run one at a time in a queue. The request is denied if the tab closes or moves to another origin while the prompt is open, if the prompt throws, or if the answer is anything other than `allow`. Each request gets exactly one receipt entry, and a failing receipt never blocks the decision.
- `src/main.js`:
  - `setupPermissionHandling(session)`: request and check handlers, `setDevicePermissionHandler(() => false)`, cancelled HID/serial/USB pickers, `setDisplayMediaRequestHandler` that denies.
  - `select-bluetooth-device` is cancelled on every web contents (Electron would otherwise pick the first device).
  - Applied to `session.defaultSession` at startup and to any new session (`session-created`), at most once per session.
  - The prompt is a native `dialog.showMessageBox` (`Deny` is the default and the cancel action, plus `Allow once`), attached to the tab's window.
  - Test-only `SOVEREIGN_PERMISSION_TEST_ANSWER=allow|deny` skips the dialog, the same idea as `SOVEREIGN_MEDIA_TEST_FIXTURES`.
- `src/privacy-receipt.js`: `permission` category; `addPermissionEntry()`, which writes to a single `Website permissions` receipt (id `website-permissions`, type `permissions`); the summary line `Website permission requests: N (M allowed)`; permission entries are left out of the cloud-AI check.
- `src/ask.js`, `src/search.js`: the receipt panels no longer jump to the `permissions` receipt (treated like `background`). Two lines each.
- `tests/permission-policy.test.js` (**new**): all of PLAN §6.
- `tests/privacy-receipt.test.js`: permission entry, summary, cloud-check exclusion, one receipt per run, and no entries leaking into other receipts.
- `tests/electron/permissions.test.js` (**new**, plus a `test:electron:permissions` script). In real Electron, with the prompt answered "Allow once", it checks:
  - a website's `Notification.requestPermission()` is `granted` only through the prompt;
  - `navigator.permissions.query` for notifications and geolocation is never `granted`;
  - `getDisplayMedia()` is rejected;
  - Sovereign's own UI page is `denied` with no prompt;
  - all of it is in the receipt.
- `package.json`: `check` runs `node --check src/permission-policy.js && node tests/permission-policy.test.js`, and `check:tests` syntax-checks the new Electron test.

**Deviation from the PLAN, found while testing:** I probed Electron 38.8.6 directly. `getDisplayMedia()` sends a `media` permission request with **empty** `mediaTypes` before the display-media handler runs. The first build therefore showed screen-capture attempts as a "camera or microphone" prompt. Fixed: `media` with no `video`/`audio` is classed as `screen capture` and denied with no prompt. Tests were added (unit test, plus an Electron assertion that no "camera or microphone" entry appears). PLAN §2 and §6 are updated to match.

**Decision for Sandeep:** `fullscreen` and `clipboard-sanitized-write` (writing text to the clipboard) are allowed for websites without a prompt, as PLAN §2 explains. Chromium only lets them run straight after a click or key press, and they read no user data. Every one is still recorded. If you would rather be asked, move them into `PROMPT_PERMISSIONS` in `src/permission-policy.js`. That is a one-line change, but the existing tests would need updating.

**Test results**
- `npm run check`: **exit 0**. It runs `permission-policy tests passed` and `privacy-receipt tests passed`, alongside the existing tests.
- Mutation check: I copied the module to the scratchpad and made `geolocation` allowed without a prompt. `tests/permission-policy.test.js` failed with an assertion, which proves the tests catch an automatic grant.
- `npm run test:electron:permissions`: **exit 0**. Receipt entries seen:
  - `127.0.0.1:<port> | Permission request: notifications – allowed once by you`
  - `… | screen capture – denied automatically: not supported in Sovereign`
  - `sovereign | Permission request: notifications – denied automatically: Sovereign's own pages need no website permissions`
- Regression: `test:electron:browser-features`, `media-chat`, `ui-smoke` and `downloads` all exit 0.
- `git diff --check`: clean. No secrets were added.

**Not verified automatically (needs PLAN §7 by hand):** the native dialog itself (wording, Deny as the default, Esc), real camera/microphone/location hardware, and `select-bluetooth-device` / HID / USB pickers, because no devices are available in tests. Run manual steps 1–12 in PLAN §7, especially steps 1, 2, 9 and 11.

## Task: Receipt: SearXNG forwarding
Status: ready for manual testing (not committed)

### PLAN (Claude)
This is item P1 #2 from the Feature test pass (known issue 1; that section is on branch `phase-0/feature-test`). Claude plans and implements this task at Sandeep's request.

#### 1. Problem
`buildSummary()` (`src/privacy-receipt.js`) writes only `Query sent to 127.0.0.1:8080 (SearXNG)`. SearXNG then sends the query to upstream engines, and the receipt never says so. Those upstream calls come from the SearXNG container, not Electron, so they can never be recorded as Electron requests.

Image search is worse: its SearXNG request is recorded with category `image`, so SearXNG is listed under "Image/media hosts contacted", with no hint that it is a search engine front end.

#### 2. What SearXNG reports (checked against the local instance)
In its JSON response:
- `results[].engine` (string) and `results[].engines` (array): the engines that returned results;
- `infoboxes[].engine(s)` and `answers[].engine`;
- `unresponsive_engines`: `[name, reason]` pairs.

From a live check:
- **Text search:** `startpage, google cse, duckduckgo`, plus infobox `wikipedia, wikidata`. Unresponsive: `brave` (`too many requests`), `mojeek` and `qwant` (`access denied`).
- **Image search:** `duckduckgo images, google cse images, flickr, pexels, …`. Unresponsive: `bing images` (`HTTP connection error`), `brave.images` (**`Suspended: too many requests`**), `unsplash` (`parsing error`).

Rules for the list of engines the query was **forwarded to**:
- **Included:** every engine named in results, infoboxes or answers, plus unresponsive engines (the query was sent to them; they then failed).
- **Excluded:** unresponsive engines whose reason starts with `Suspended`. SearXNG skipped those, so the query was **not** sent.
- **Limits:** names are de-duplicated, trimmed and sorted A–Z, at most 25 shown (then `and N more`), and HTML is stripped.
- **Known limit:** engines that were asked but returned nothing are not reported by SearXNG, so they can't be listed. The receipt row says so.

#### 3. What the receipt says
**Summary line** (replaces `Query sent to X (SearXNG)`):
- When the names are known: `Query sent to 127.0.0.1:8080 (SearXNG), which forwarded it to: brave, duckduckgo, google cse, …`
- When they aren't (an empty list, a failed or cancelled request, or a request still running): `Query sent to 127.0.0.1:8080 (SearXNG), which forwarded it to upstream search engines (names not reported)`
- If one receipt has several SearXNG queries (for example a search after Retry), the names are combined for that host.

**Receipt row** (the existing SearXNG entry, no new row): once the response arrives, its "what was sent" text gets ` – SearXNG forwarded it to: <names> (engines SearXNG reported; engines that returned nothing are not listed)`, or ` – SearXNG forwarded it to upstream search engines (names not reported)`.

**Applies to:**
- web search (Search tab), via `handleSearchQuery`;
- Ask AI with web retrieval, which uses the same handler;
- image and video search, via `search:media`.

Image search's SearXNG request is now recorded with category **`search`** (text `Image search query: …`), so the summary shows it as a query to SearXNG rather than an image host. Thumbnails and preflights stay `image`.

**No new network requests:** the names come only from the JSON SearXNG already returns.

#### 4. Files
| File | Change |
|---|---|
| `src/search-backend.js` | `reportedSearxngEngines(payload)`, which applies the rules in §2 and is exported. `searchSearxng` and `searchSearxngMedia` return `upstreamEngines` (array) with each result. |
| `src/privacy-receipt.js` | `recordSearxngForwarding(receiptId, { url, engines })` stores the names per SearXNG host on the receipt and adds the note to the most recent matching SearXNG entry; `buildSummary` uses the new wording; the snapshot includes `forwarding`. |
| `src/main.js` | After `searchSearxng` / `searchSearxngMedia` succeeds, call `recordSearxngForwarding`. Change the media SearXNG request's receipt category from `image` to `search`. No other changes. |
| `tests/search-backend-engines.test.js` (**new**) | Engine-name extraction (§6). |
| `tests/privacy-receipt.test.js` | Summary and row wording (§6). |
| `package.json` | Add the new test to `check`. |

#### 5. Error handling
- **SearXNG unreachable, timed out or cancelled:** the request entry exists but has no names, so the summary says `forwarded it to upstream search engines (names not reported)`. That is correct, because we can't know whether SearXNG forwarded it.
- **Unusual JSON** (missing arrays, non-string names, a huge list): ignored or capped; it never throws.
- **Recording errors:** caught, so a search never fails because of the receipt.

#### 6. Tests
**`tests/search-backend-engines.test.js`:**
- `engine` and `engines` fields;
- infobox and answer engines;
- unresponsive engines included, but `Suspended…` ones excluded;
- duplicates and whitespace removed, sorted;
- HTML stripped;
- non-strings ignored;
- the cap of 25;
- empty or missing payload gives `[]`;
- `searchSearxng` and `searchSearxngMedia` return `upstreamEngines`, using a fake fetch.

**`tests/privacy-receipt.test.js`:**
- the exact example `Query sent to 127.0.0.1:8080 (SearXNG), which forwarded it to: bing, duckduckgo, startpage`;
- the names-unknown wording (before a response, and for an empty list);
- the row note text;
- two queries in one receipt combine their names;
- image-search wording (category `search`);
- an unknown receipt id does nothing;
- forwarding names never trigger the cloud-AI check.

#### 7. Manual test steps (for Sandeep)
1. Start SearXNG and run `npm start`. In **Search**, search `history of tea`. Open the Privacy Receipt:
   - the summary reads `Query sent to 127.0.0.1:8080 (SearXNG), which forwarded it to: …`, followed by engine names (for example `duckduckgo, google cse, startpage, …`);
   - the SearXNG row ends with `– SearXNG forwarded it to: … (engines SearXNG reported; …)`.
2. Cross-check: open `http://127.0.0.1:8080/search?q=history+of+tea&format=json` in a browser tab. Every engine in `results[].engines` and every unresponsive engine **not** marked `Suspended` should appear in the receipt.
3. In **Ask AI**, turn on **Search the web** and ask `When was the Eiffel Tower built?`. The receipt shows the same forwarding wording, followed by the source-page count and "AI generated locally".
4. In Ask AI, type `pictures of Mount Everest`. The receipt summary shows `Query sent to 127.0.0.1:8080 (SearXNG), which forwarded it to: …` with image engines (for example `duckduckgo images, flickr, pexels, …`), and `127.0.0.1:8080` is **not** listed under "Image/media hosts contacted". Thumbnail hosts still are.
5. Stop SearXNG (`docker compose stop`) and search again. The summary says `… (SearXNG), which forwarded it to upstream search engines (names not reported)`.
6. In a local-only Ask AI question (web off), the receipt still says `Nothing left this device: answer generated locally`, with no SearXNG wording.

### CHANGES (written by Claude at Sandeep's request)
Implemented on 2026-11-05 on branch `phase-0/receipt-searxng`, which was created from `main`. Nothing was committed. The Feature test pass and Website permissions sections are on their own branches and are not in this branch's HANDOFF.

**Files changed**
- `src/search-backend.js`: new exported `reportedSearxngEngines(payload)`. It takes names from `results[].engine/engines`, `infoboxes`, `answers` and `unresponsive_engines`; leaves out engines whose reason starts with `Suspended`; and de-duplicates, trims, strips HTML, sorts and caps the list (at most 50 kept). `searchSearxng` and `searchSearxngMedia` return `upstreamEngines`. No extra requests.
- `src/privacy-receipt.js`:
  - `recordSearxngForwarding(receiptId, { url, engines })` stores the names per SearXNG host (`receipt.forwarding`, also in snapshots and exports) and adds the forwarding note to the matching SearXNG row, once per row.
  - The `buildSummary` wording is `Query sent to <host> (SearXNG), which forwarded it to: <names>`, or `…, which forwarded it to upstream search engines (names not reported)`. At most 25 names are shown, then `and N more`.
  - Unknown receipt ids return `null`.
- `src/main.js`:
  - `recordSearxngForwardingSafely()` is called after a successful `searchSearxng`, which covers the Search tab, Ask AI web retrieval and dataset mode, and after `searchSearxngMedia`, which covers image and video search. It never fails the search.
  - Image and video search's SearXNG request is now recorded as category `search` (was `image`).
- `tests/search-backend-engines.test.js` (**new**), and the extra cases in `tests/privacy-receipt.test.js`: everything in PLAN §6.
- `package.json`: `check` also runs `node tests/search-backend-engines.test.js`.

**Decisions to note**
- **Wording when names are unavailable.** The summary reads `…(SearXNG), which forwarded it to upstream search engines (names not reported)`. It contains the requested phrase, in the same sentence form as the example.
- **The fallback also covers a SearXNG that never answered.** That applies when SearXNG is unreachable or times out, where the query probably was **not** forwarded. I kept it as specified because it errs towards disclosure. If you'd like, a failed request could say instead `SearXNG did not answer; the query may not have been forwarded`. That's a small change in `buildSummary`, using the existing error status.
- **The list is "engines SearXNG reported".** Engines that were asked but returned nothing are not in SearXNG's JSON. The row says so explicitly; the summary uses the exact requested format.

**Test results**
- `npm run check`: **exit 0**, including `search-backend-engines tests passed` and `privacy-receipt tests passed`.
- Mutation checks (broken copies in the scratchpad):
  - listing `Suspended` engines makes `search-backend-engines` fail (exit 1);
  - dropping the "names not reported" fallback makes `privacy-receipt` fail (exit 1).
- **Live end-to-end** (real Electron, the real IPC handlers, local SearXNG, receipts read from the main process):
  - **Text** `history of tea`: `Query sent to 127.0.0.1:8080 (SearXNG), which forwarded it to: duckduckgo, google cse, startpage, wikidata · AI generated locally`. Row: `search | 127.0.0.1:8080 | Search query: history of tea – SearXNG forwarded it to: … (engines SearXNG reported; engines that returned nothing are not listed)`.
  - **Image** `Mount Everest`: the summary lists `artic, bing images, duckduckgo images, flickr, google cse images, lucide, pexels, pinterest, unsplash, wikicommons.images`, and the row category is `search`. The suspended `brave.images` is correctly left out.
  - **Unreachable endpoint** (`127.0.0.1:8099`): `… (SearXNG), which forwarded it to upstream search engines (names not reported)`.
- Regression: `test:electron:media-chat`, `ui-smoke` and `stage1-usability` exit 0. Their logs have no assertion failures or timeouts; I checked the logs because these tests' exit codes are unreliable.
- `git diff --check`: clean. No secrets.

**Manual tests:** PLAN §7, steps 1–6.

## Task: Saved chat deletion
Status: done

### PLAN (Claude)
This is item P1 #3 from the Feature test pass. At Sandeep's request, Claude plans and implements this task and also writes CHANGES.

#### 1. Problem
- Saved chats live in the Ask AI page's `localStorage` (origin `sovereign://ask`, key `sovereign.ask.chats`). On disk that is Chromium's LevelDB in `<userData>/Local Storage/leveldb/`.
- **`localStorage.removeItem` does not erase the data from disk.** LevelDB is append-only: a delete adds a tombstone to the `.log` file, and the old value stays in `.log` / `.ldb` files until LevelDB compacts them, which may be never.
- Turning off "Save chats on this device" makes `savedChats()` / `writeSavedChats()` return early, so old chats stay, can't be cleared (the panel is hidden and **Clear history** returns early), and come back when saving is turned on again.
- Settings (`sovereign://settings`) is a different origin, so it can't reach the Ask page's `localStorage` at all.
- No other place writes chats: the main process never receives them, session restore stores tab URLs only, and the dataset mode writes its own files. Attachment text is not saved (`savedMessage` keeps content, sources, note, action and media fields).

#### 2. Design: one file owned by the main process
- New `src/chat-store.js` (pure Node, no Electron imports, testable under `npm run check`): `createChatStore({ directory })` with `list`, `count`, `save(entry)`, `remove(id)`, `clear()`, `importLegacy(chats)`.
- Storage: `<userData>/saved-chats.json`, mode `0600`.
  - Writes go to `saved-chats.json.tmp`, then `rename` over the real file, so a crash never leaves a half-written file.
  - When the list becomes empty (last chat deleted, or Clear), the file is **unlinked**, not rewritten as `[]`.
  - `clear()` also removes any leftover `.tmp` file. Opening the store removes a stale `.tmp` too, because it may hold chat text after a crash.
- Validation in the store, so a misbehaving page can't write anything else: at most 50 chats, 40 messages each, plain JSON objects only, string ids, and at most 1 MB per chat.
- `src/main.js` IPC, accepted **only** from Ask AI tabs (`tab.kind === 'ask'`), plus Settings for the disable flow. Web tabs have no preload, and the sender check is a second guard:
  - `chats:list`, `chats:save` (refused unless saving is on), `chats:delete`, `chats:clear` (asks first), `chats:import-legacy`, `chats:offer-delete-on-disable` (Settings only).
  - After any change, main sends `chats:changed` with the new list to every Ask AI tab, so open tabs update at once.
- Confirmation dialogs are native `dialog.showMessageBox`, attached to the tab's window:
  - Turning saving off with N > 0 chats: **"Also delete the N saved chats on this device?"** with **Delete** / **Keep**. Keep is the default and the Esc action, so nothing is lost by accident. Sandeep can veto this and make Delete the default.
  - Clear history: **"Delete all N saved chats on this device?"** with **Delete** / **Cancel** (Cancel is the default).
  - Test-only `SOVEREIGN_CHAT_DELETE_TEST_ANSWER=delete|keep` skips the dialog, the same idea as `SOVEREIGN_PERMISSION_TEST_ANSWER`.
- `src/ask.js`:
  - Keeps an in-memory copy of the list from main; `persistCurrentChat`, delete and clear go through IPC.
  - The saved-chats panel shows whenever saving is on **or** saved chats exist, so Clear history and Delete work with saving off.
  - When the open chat is deleted (here, in another tab or from Settings), it is closed and its id is never saved again from this tab.
  - **One-time migration of old data:** on load, if `localStorage` still has `sovereign.ask.chats`, the chats are moved into the file (they were saved chats, so they stay saved chats the user can now delete), then the key is removed.
- `src/settings.js` / `.html`: after saving is turned off, call `chats:offer-delete-on-disable`, then report "N saved chats deleted" or "Saved chats kept". Update the help text so it says what happens.

#### 3. Old data in Chromium's localStorage (revised again after Codex REVIEW round 3)
*Round 2 opened Chromium's LevelDB directly with `classic-level` and compacted it. Codex showed that another running instance could still hold that database, so the approach was withdrawn in round 4. The dependency, the startup child process and all direct file access are removed.*
- **Rule:** Sovereign never opens or edits Chromium's files. Legacy chats (key `sovereign.ask.chats` on `sovereign://ask`) are read and removed **only through Chromium's `localStorage` API**, from a renderer on that origin:
  - **The Ask AI page** moves them into `saved-chats.json` when it opens.
  - **Main process, for a bulk delete:** a hidden, empty page (`src/legacy-chat-probe.html`, CSP `default-src 'none'`) on the same origin calls `getItem` / `removeItem`.
- **Why not `session.clearStorageData`:** the `sovereign://ask` origin also holds the theme and, in IndexedDB, the cached AI model (the model-setup page is on the same origin). Clearing by origin is too broad, so only the one key is removed.
- **Deletion always wins:**
  - Every delete is written first to `<userData>/chat-deletions.json` (mode 0600). It holds only the deleted chat ids, which are random, plus `legacyDeletePending`.
  - Bulk delete runs in this order:
    1. A read-only peek at the legacy key, so the dialog can count those chats. It never writes `saved-chats.json`.
    2. The user confirms.
    3. The deletion is recorded: ids plus `legacyDeletePending: true`.
    4. `saved-chats.json` is unlinked.
    5. The key is removed with `removeItem`, and a read-back confirms it is gone. Only then is `legacyDeletePending` cleared.
  - While a legacy delete is pending, `importLegacy` imports nothing and records the blocked ids as deleted. A deleted id is never imported or saved again; the id list is never capped, and the ids still in the key when it is removed are recorded in the same write that clears the pending flag (round 5). A failed or later scan therefore cannot restore anything.
  - A pending delete is finished on the next start (in `whenReady`), or when Ask AI next opens.
  - An unreadable deletion record is treated as "pending".
- **Wording:** "Deleted from Sovereign's storage. Chromium may keep fragments in its internal files until it cleans them up." It appears in the dialog detail, the Clear history status, the Settings status and the Settings help text, plus the existing note about exports and backups. If the key could not be removed, the status adds: "Chats saved by an older version could not be removed yet; Sovereign will try again the next time it starts." (Round 5 wording: startup retries, it does not guarantee.)
- **Known limit (accepted):** `removeItem` is a supported delete, but Chromium's LevelDB keeps the old bytes in its own `.log` / `.ldb` files until Chromium compacts them. Sovereign does not force that. The Electron test reports these fragments rather than failing on them. Sovereign's own files (`saved-chats.json`, `chat-deletions.json`) never contain deleted chat text.

#### 4. Privacy Receipt
No network requests are added. Everything is local file I/O, so the receipt is unchanged.

#### 5. Tests
- `tests/chat-store.test.js` (new, added to `npm run check`), in a temp directory:
  - Save → the file exists with mode 0600. Delete one → that chat's unique marker text is gone from **every file in the directory**, while the other chat remains. Delete the last → the file is gone.
  - `clear()` → the directory has no `saved-chats*` files and no file contains any marker text; a stale `.tmp` is removed on clear and on open.
  - Validation: junk entries are ignored, the 50/40 limits hold, an oversized chat is refused, and `importLegacy` skips duplicate ids.
  - Deletion always wins (round 4): deleted ids are never saved or imported again, and a pending legacy delete blocks every import, also after a restart.
- `tests/electron/media-chat.test.js`: switch its saved-chat check from `localStorage` to the new API.
- New `tests/electron/chat-deletion.test.js` (`npm run test:electron:chat-deletion`): with a real Ask tab and `SOVEREIGN_CHAT_DELETE_TEST_ANSWER`, save chats, delete one, Clear with saving off, disable-with-Delete from Settings, and legacy migration. After each step it scans the profile's `saved-chats*` files for the marker text and checks the `localStorage` key is gone. Round 4 adds a failed legacy removal followed by a later scan (from Ask AI, and on the next start), and checks that the model cache (IndexedDB), the theme, New Tab shortcuts and settings are untouched. See CHANGES round 4.

#### 6. Manual tests
1. Settings: turn on **Save chats on this device**. In Ask AI, ask two questions in two chats (use **New chat**). Both appear under Saved chats.
2. Check the file `~/Library/Application Support/sovereign-browser/saved-chats.json` exists and contains both questions.
3. Press **Delete** on one chat. It disappears, and `grep` for its question in `saved-chats.json` finds nothing.
4. Settings: turn saving **off**. Expect "Also delete the 1 saved chats on this device?" Press **Keep**: the chat is still listed in Ask AI, and **Clear history** is visible.
5. With saving still off, press **Clear history** in Ask AI. Expect a confirmation; press **Cancel**, and nothing changes. Press it again and choose **Delete**: the list is empty and `saved-chats.json` no longer exists.
6. Turn saving on, save one chat, turn saving off, and choose **Delete**. The file is gone. Turn saving on again: no old chats come back.
7. Open two Ask AI tabs. Delete a chat in one: it disappears from the other tab straight away.
8. Old data: on a profile that had chats before this change, open Ask AI once. The chats now appear from `saved-chats.json`, and in DevTools for the Ask tab `localStorage.getItem('sovereign.ask.chats')` returns `null`.
9. Regression: with saving off, a new chat is never written (no `saved-chats.json` appears). Reopening a saved chat, including its image previews, still works.

### CHANGES (written by Claude at Sandeep's request)
Implemented on 2026-11-06 on branch `phase-0/chat-deletion`. Nothing was committed.

**Files changed**
- `src/chat-store.js` (**new**, no Electron imports): `createChatStore({ directory })` with `list`, `count`, `save`, `remove`, `clear`, `importLegacy`, plus `sanitizeChat`.
  - The file is `<userData>/saved-chats.json`, mode 0600. Writes go to a `.tmp` file, then `rename`.
  - An empty list or `clear()` **unlinks** the file and any `.tmp`. A stale `.tmp` is removed whenever the store is opened.
  - Limits: 50 chats, 40 messages, 1 MB per chat, plain JSON only.
- `src/main.js`:
  - IPC `chats:list|save|delete|clear|import-legacy`, accepted only from Ask AI tabs, checked by both tab kind and `sovereign://ask/` URL. `chats:offer-delete-on-disable` is accepted from Settings only.
  - `chats:save` is refused while saving is off.
  - Every change is pushed to all Ask AI tabs as `chats:changed`.
  - The native confirmations: **Keep / Delete** when turning saving off, and **Cancel / Delete** for Clear history. The non-destructive button is the default and the Esc action. `SOVEREIGN_CHAT_DELETE_TEST_ANSWER` is test-only and read on each call.
- `src/preload.js`: `window.sovereign.chats` (list, save, delete, clear, importLegacy, offerDeleteOnDisable, onChanged).
- `src/ask.js`:
  - `localStorage` reads and writes are replaced by IPC, with an in-memory `savedChatList` and `applySavedChats()`. `persistCurrentChat` is now async; it builds the entry synchronously, so `newChat()` still saves the right messages.
  - The saved-chats panel shows when saving is on **or** chats exist. Clear history always works and asks first.
  - A deleted chat that is open gets closed, and its id is never saved again from that tab. If an answer is generating, it stays on screen but is not saved.
  - `migrateLegacyChats()` runs once on load: it moves `sovereign.ask.chats` from `localStorage` into the file and removes the key.
- `src/settings.js` / `src/settings.html`: after saving is turned off, the user is offered deletion, and the status reads "N saved chats deleted" or "kept". The help text is updated.
- `package.json`: `node --check src/chat-store.js && node tests/chat-store.test.js` added to `check`, `chat-deletion.test.js` added to `check:tests`, and a new `test:electron:chat-deletion` script.
- `tests/chat-store.test.js` (**new**): each step reads **every file in the temp folder** and checks the deleted chat's marker text is gone. It covers single delete, deleting the last chat (file removed), clear, the stale `.tmp`, a restart, the limits, a corrupt file and legacy import.
- `tests/electron/chat-deletion.test.js` (**new**), on a real Ask AI tab and Settings tab:
  - Saving writes only to the file, never to `localStorage`.
  - A single Delete removes the chat from disk, and the deleted open chat can't be re-saved.
  - Turning saving off with Keep keeps the chats, which stay visible.
  - Clear history with saving off: Cancel keeps the chats, Delete leaves no `saved-chats*` file.
  - Nothing is written while saving is off.
  - Turning saving off with Delete removes the file, and the chats don't come back when saving is turned on again.
  - Legacy migration, then clear.
- `tests/electron/media-chat.test.js`: the saved-chat round trip now reads through `window.sovereign.chats.list()` and asserts nothing is in `localStorage`.

**Privacy Receipt:** no network requests were added; this is local file I/O only.

**Verified**
- `npm run check`: exit 0. All unit tests pass, including the new `chat-store tests passed`.
- `npm run test:electron:chat-deletion`: exit 0, ends with `"ok": true`. Afterwards, a `grep` of the **whole test profile** (including Chromium's `Local Storage`, `Session Storage`, caches and `Code Cache`) found none of the deleted chats' marker texts.
- Regression: `test:electron:media-chat`, `ui-smoke` and `stage1-usability` exit 0 and print their final result JSON. The `media:preflight` / `search:media` handler errors in the media-chat log come from its negative fixtures (non-image links, a refused endpoint) and are not new.
- `git diff --check`: clean. No secrets.

**Not proven automatically (superseded by round 2 below):** PLAN §3 (first version), LevelDB keeping old bytes of chats saved **before** this change. In the Electron test, the legacy key was written and removed within one storage commit, so it never reached LevelDB, and the test can't show either way whether old real data lingers. Sandeep, after manual step 8, you can check with the app closed: `LC_ALL=C grep -rla '<a word from an old chat>' ~/Library/Application\ Support/sovereign-browser/Local\ Storage`.

**Manual tests:** PLAN §6, steps 1–9. For step 8, you need a profile that has chats saved by the previous build.


**Round 2: fixes for Codex REVIEW (2026-11-06)**

MUST FIX:
1. **Legacy chats missed when Settings is used first.** The legacy migration now runs at app startup, in the main process, before any page opens (PLAN §3). So `chats:offer-delete-on-disable` counts them even if Ask AI has never been opened, and Delete erases them. Ask AI opening later re-imports nothing, because the key is gone.
2. **Corrupt file survives Clear history.** `chat-store` has `status()` → `{ count, unreadable, hasData }`, where `unreadable` means a file exists but isn't a valid chat list.
   - `chats:clear` and the disable offer now delete whenever `hasData` is true. The prompts name "the unreadable saved chat history".
   - Ask AI shows a notice ("Some saved chat history on this device could not be read. Clear history deletes it.") with Clear history enabled.
   - All chat IPC now returns `{ chats, unreadable }`.
3. **Legacy LevelDB data.** Implemented as in PLAN §3, with the new `src/legacy-chat-storage.js` and the `classic-level` dependency. The wording is changed in the dialog detail, the Settings status and the Settings help text: "deleted from Sovereign's storage on this device", and exported copies and system backups are not affected.

SHOULD FIX:
4. **In-memory copies.**
   - A deleted chat that is open while generating is now closed as soon as generation ends (`setRunning(false)`). `closeDeletedChat()` also drops `lastModelMessages`, pending question data and retry data.
   - **Deletion boundary:** saved-chat files and the legacy localStorage copy. These are **not** deleted:
     - Privacy receipts, which are in memory only and gone on quit; they hold queries and URLs, not answers.
     - The WebLLM engine's internal conversation, which is replaced on the next question.
     - Exports the user saved (Markdown/PDF/receipt JSON).
     - OS backups.
5. **Coverage.** `tests/electron/chat-deletion.test.js` now runs as 4 launches on one profile (residue seed, legacy seed, main run, plus the orchestrator):
   - The legacy data is written by real Chromium from a `sovereign://ask` page without this build's Ask code, flushed and closed, with an older overwritten value on disk.
   - The main launch opens Settings before Ask AI and covers: single delete; deletion from a second Ask tab while the first is "generating"; Keep and Delete; Clear with Cancel and Delete; a truncated file from Ask and from Settings; nothing saved while off; and refused callers (Settings, the browser UI, and Ask calling the Settings-only handler).
   - After the profile is closed, the orchestrator scans **every file under the profile, recursively** (LevelDB, caches, everything, Latin-1 and UTF-16) for 10 deleted markers. It also checks that an unrelated localStorage value is kept and that Chromium still reads it.
   - Not covered: real model state and web/media caches. The test injects messages rather than running the model.

**Files changed in round 2**
- `src/legacy-chat-storage.js` (**new**): migration, key/value decoding, marker file, child-process entry and `runBeforeStartup()`.
- `src/chat-store.js`: `status()`, and an unreadable-file check that also catches valid JSON which isn't a list.
- `src/main.js`:
  - Calls the startup migration right after `userData` is set.
  - Chat IPC returns snapshots, deletes even when the file is unreadable, and uses the new wording.
  - `chats:import-legacy` marks the profile for compaction on the next start.
- `src/ask.js`: `closeDeletedChat()`, closing a deleted chat after generation, and the unreadable notice.
- `src/settings.js`, `src/settings.html`: wording.
- `package.json` / `package-lock.json`: the `classic-level` ^3.0.0 dependency, and `node tests/legacy-chat-storage.test.js` added to `check`.
- `tests/legacy-chat-storage.test.js` (**new**), on a Chromium-shaped LevelDB:
  - Legacy and residue text are gone from every file, while other keys survive and the database still reads.
  - Covers UTF-16 values, residue-only compaction, the fallback marker, unreadable legacy JSON, a failed import keeping the key, a locked database and a brand-new profile.
- `tests/chat-store.test.js`: unreadable-file status and clear.
- `tests/electron/chat-deletion.test.js`: rewritten as above.
- `tests/electron/media-chat.test.js`: uses `.chats` from the snapshot.

**Verified (round 2)**
- `npm run check`: exit 0, including `chat-store tests passed` and `legacy-chat-storage tests passed`.
- `npm run test:electron:chat-deletion`: exit 0, `"ok": true`.
  - The main launch logged `legacy saved chats: migrated, imported 2`.
  - The final recursive scan found none of the 10 markers. The kept value was in `Local Storage/leveldb/000007.ldb`.
  - Chromium reopened the compacted database: a new log was written and the kept key was read. All LevelDB files are mode 0600.
  - The `chats:*` "can only be managed from Ask AI and Settings" errors in the log are the expected refusals.
- Regression: `test:electron:media-chat`, `ui-smoke`, `stage1-usability` and `permissions` exit 0 with their final result JSON.
- `npm audit` reports only the existing Electron advisories, nothing from `classic-level`. No secrets.

**Notes for Sandeep**
- **Your real profile:** an earlier check found the key in `~/Library/Application Support/sovereign-browser/Local Storage/leveldb/000038.log`. The first `npm start` with this build will move those chats into `saved-chats.json` and compact that database once. Back up the folder first if you want to keep a copy.
- **Packaging (later):** `classic-level` is native, so an installer needs `asarUnpack` for it. The `RunAsNode` fuse must stay enabled, or the startup step needs another way to run.
- **Running an older build again** on the same profile can re-add the key. The Ask-page fallback moves it, and the next start compacts it.

**Manual tests (round 2), in addition to PLAN §6**
1. Use a copy of a profile with chats from the previous build. Start the app and open **Settings first**, then turn saving off. Expect "Also delete the N saved chats on this device?". Choose Delete, quit, and run `LC_ALL=C grep -rla '<a word from an old chat>' <profile>`: nothing is found. Relaunch: no chats come back.
2. Quit, put `[{"id":"x","title":"broken` into `saved-chats.json`, and start the app. Ask AI shows the unreadable notice. **Clear history** → Delete removes the file.
3. Two Ask tabs with the same saved chat: start a long answer in tab 1 and delete the chat in tab 2. Tab 1 keeps the answer on screen until it finishes, then closes the chat. It never reappears in the list.
4. The dialogs read "…from Sovereign's storage on this device" and mention exports and backups. Nothing claims secure erase.

#### Round 3: fixes for Codex re-review (2026-11-06)

**1. A cleanup marker no longer hides legacy chats**
- `runBeforeStartup` no longer returns early when `legacy-chat-storage.json` says `cleaned`. Whenever the profile has a localStorage database, the child process opens it and looks the legacy key up.
  - With the marker present and no key, it only does the lookup, with no compaction. That costs about 55 ms per launch (measured).
  - If the key is there (an older build ran since), it is moved, deleted and compacted.
- On delete, Sovereign always scans as well, whatever startup reported (locked, failed or clean):
  - Clear history and the Settings turn-off offer first load a hidden, empty page (`src/legacy-chat-probe.html`) on the `sovereign://ask` origin and read the key.
  - Any chats found are moved into `saved-chats.json` before the dialog, so the count and the delete cover them.
  - The key is then removed, even if its value is empty or not valid JSON.
  - If moving the chats into the file fails, the key is kept.
  - This is local only and adds no network request, so nothing is added to the Privacy Receipt.

**2. Invalid or corrupt chat data is always deletable**
- `chat-store.js`: if any entry in the list is not a valid chat (for example it has no id), the file is marked `unreadable`.
- `hasData` is now "a chat file or temp file exists", so deletion never depends on parsing. Any rewrite drops the invalid entries from disk.

**3. The fallback tells the user, and the next start finishes the job**
- Whenever a legacy key is removed while Sovereign runs, by the delete-time scan or the Ask page fallback, the marker is removed first. The Ask fallback now reports the key even when its value is empty or malformed.
  - While the marker is missing, cleanup is pending.
  - The next start compacts the database, even when no key is left to find.
- While cleanup is pending:
  - Delete, Clear history and the Settings offer return `pendingRestart`.
  - Ask AI shows: **"Deleted. Some data will be fully removed when Sovereign restarts."**
  - Settings shows: "Chat saving turned off. Deleted. Some data will be fully removed when Sovereign restarts."
  - The confirmation dialog adds the same sentence.
- Test-only: `SOVEREIGN_TEST_LEGACY_STARTUP=locked` skips the startup step, as if another instance held the database. It is used by the Electron test, both to simulate the lock and to make seed launches behave like an older build.

**Files (round 3)**
- `src/legacy-chat-storage.js`: runs on every start, and exports `parseLegacyChats`.
- `src/chat-store.js`: the invalid-entry and file-presence checks.
- `src/main.js`: the delete-time scan (`scanLegacyChats`), `pendingRestart` and the test hook.
- `src/legacy-chat-probe.html` (**new**): an empty page with `default-src 'none'`.
- `src/ask.js`, `src/settings.js`: the restart message, and the fallback always reports the key.
- `tests/chat-store.test.js`: invalid entries, mixed lists and an empty-list file.
- `tests/legacy-chat-storage.test.js`, each case through the real `runBeforeStartup` child process:
  - A marker exists and an older build then writes chats: they are migrated and erased.
  - Empty, non-JSON, non-list and no-id legacy values are removed and compacted.
  - Fallback residue is still in LevelDB before restart and gone after.
- `tests/electron/chat-deletion.test.js`, new launches on the same profile:
  - `seed-again` → `marker-kept`: the marker exists, an older build saves a chat, and Settings-first deletes it.
  - `seed-fallback` → `fallback`: startup is locked out and Settings-first scans and deletes. Expected:
    - The pending text appears in Settings, and also after a single delete in Ask AI.
    - A malformed key re-arms the cleanup.
  - Then `restart`.
  - The orchestrator checks that before the restart, the fallback text exists only in Local Storage and the cleanup is pending. After the restart, a full-profile scan finds none of the 15 markers, the cleanup is marked done, and unrelated localStorage is kept.
  - The main phase adds the no-id chat list, cleared from Ask AI and from Settings.

**Verified (round 3)**
- `npm run check`: exit 0.
- `npm run test:electron:chat-deletion`: exit 0, `"ok": true`.
  - Logs: `migrated, imported 2`, then `migrated, imported 1` (marker-kept), then `locked (simulated by test)`, then `compacted` at restart.
  - Before the restart, the fallback text was in `Local Storage/leveldb/000011.log`. After it, none of the 15 markers were found anywhere. The kept value was in `000019.ldb`.
- Regression: `test:electron:media-chat`, `ui-smoke`, `stage1-usability` and `permissions` exit 0.

**Known limits**
- If the startup step can never run (for example `classic-level` is missing from a package), cleanup stays pending. Deletions will then keep saying data is removed at restart, and a restart will not do it. The console logs `legacy saved chats: failed`.
- The hidden probe window is created only for Clear history and the Settings offer, not for single deletes. A single delete can only target chats already in the file.

**Manual tests (round 3)**
1. Run the app once, quit, then run an older build (or `git stash` and run `main`) and save a chat. Quit, start this build, open **Settings first** and turn saving off with Delete. Expect "1 saved chat deleted…". Quit, then `LC_ALL=C grep -rla '<word from that chat>' <profile>` finds nothing.
2. Quit, write `[{"title":"x","messages":[]}]` to `saved-chats.json`, and start. Ask AI shows the unreadable notice. Clear history → Delete removes the file. Repeat, then turn saving off in Settings → Delete.
3. Fallback: start with `SOVEREIGN_TEST_LEGACY_STARTUP=locked npm start` on a profile that still has old chats, then turn saving off in Settings → Delete. The status reads "…Deleted. Some data will be fully removed when Sovereign restarts." Quit: grep still finds the text under `Local Storage/leveldb`. Run `npm start` normally, quit, and grep again: nothing.

#### Round 4: supported APIs only (after Codex REVIEW round 3, 2026-11-06)
**Supersedes rounds 2–3 wherever they mention `classic-level`, compaction, the startup child process, `legacy-chat-storage.json` or "fully removed when Sovereign restarts".** PLAN §3 describes the current design.

**1. classic-level and direct LevelDB access removed**
- `npm uninstall classic-level`: `package-lock.json` is back to identical with `main`, and `package.json` lost the dependency and its test entries.
- Deleted: `src/legacy-chat-storage.js` and `tests/legacy-chat-storage.test.js`.
- Removed from `src/main.js`: the pre-ready startup block, `SOVEREIGN_TEST_LEGACY_STARTUP` (it existed only for that), the marker file logic and `pendingRestart`.
- This also resolves Codex's items 4 (concurrent access to a Chromium-held database) and 5 (pinning).

**2. Legacy chats only through Chromium's localStorage API**
- `src/main.js`:
  - `withLegacyProbe` loads the hidden `sovereign://ask/legacy-chat-probe.html` (one at a time).
  - `peekLegacyChats` (`getItem`) and `removeLegacyChatKey` (`removeItem` plus a read-back check).
  - `deleteAllSavedChats` is shared by Clear history and the Settings offer.
- `src/ask.js`: the on-open migration remains. After `removeItem` it checks the key is gone and calls the new `chats:legacy-removed`, which is accepted from Ask only.
- `session.clearStorageData` is not used, because the same origin holds the theme and the model cache.

**3. Deletion always wins**
- `src/chat-store.js` gains the deletion record (`chat-deletions.json`): `recordDeletion`, `isDeleted`, `legacyDeletePending`, `legacyDeleteDone`. `remove` and `clear` record before touching data. `save` and `importLegacy` refuse deleted ids, and `importLegacy` imports nothing while a legacy delete is pending.
- Codex's failure (a failed probe followed by restore at restart) can no longer happen. The deletion is recorded before the scan, and the next start only removes the key.
- Test-only `SOVEREIGN_TEST_LEGACY_REMOVE=fail` makes the main-process removal fail after the user confirmed.

**4. Wording**
- Uses "Deleted from Sovereign's storage. Chromium may keep fragments in its internal files until it cleans them up." in `src/ask.js`, `src/settings.js`, `src/settings.html` and the dialog detail in `src/main.js`.
- Single delete still says "Saved chat deleted.", because it touches only Sovereign's own file.

**5. Tests**
- `tests/chat-store.test.js`:
  - Deleted ids are never saved or imported again. The deletion record holds no chat text and is mode 0600.
  - `clear({ legacy: true })` blocks imports across a store restart until `legacyDeleteDone`, and ids stay deleted after it.
  - An unreadable record means pending. `parseLegacyChats` is covered too.
- `tests/electron/chat-deletion.test.js`, rewritten:
  - **Seed:** legacy chats with an overwritten older value, plus data that must survive: `probe.keep` and the theme (`sovereign.theme`) on the Ask origin, an IndexedDB database on the Ask origin (where WebLLM's `cacheBackend: 'indexeddb'` model cache lives), and New Tab shortcuts.
  - **main:** checks nothing is imported at startup, then Settings-first deletes the 2 legacy chats with the exact wording. All earlier cases are kept, and the Clear history status wording is checked.
  - **Failed removal, twice** (`seed-legacy` → `fail-remove` with `SOVEREIGN_TEST_LEGACY_REMOVE=fail`):
    - Settings reports the delete plus "…removed the next time Sovereign starts", and the record has the id with `legacyDeletePending: true`.
    - (a) Ask AI then opens: it restores nothing, removes the key and clears pending.
    - (b) Quit with the delete still pending: the next start (`verify`) removes the key and restores nothing.
  - **verify:** the legacy key is gone. `probe.keep`, the theme, the IndexedDB "model cache" entry and New Tab shortcuts are all still readable, and model setup state still loads.
  - **Orchestrator:**
    - `preferences.json` `search`, `downloads`, `bookmarks`, `startup` and `ai` (except `saveChatsOnDevice`) are unchanged.
    - No deleted marker is in any file outside `Local Storage/`.
    - `chat-deletions.json` contains no chat text.
    - Chromium's localStorage fragments are reported as `chromiumFragments`.
  - The Cache API was not used as a fixture, because Chromium refuses it for the `sovereign:` scheme. The model cache is IndexedDB.

**Verified (round 4)**
- `npm run check`: exit 0.
- `npm run test:electron:chat-deletion`: exit 0, `"ok": true`, 13 markers scanned.
  - No deleted text in Sovereign's files.
  - `chromiumFragments`: the 5 legacy markers are still in `Local Storage/leveldb/000003.log`. This is the accepted limit, disclosed in the wording.
  - The `chats:*` refusal errors and the two "legacy removal failed (test)" lines in the log are expected.
- Regression: `test:electron:media-chat`, `ui-smoke`, `stage1-usability` and `permissions` exit 0.
- `git diff --check` is clean. No new network requests: the probe page is served by the local `sovereign:` protocol.

**Known limits (updated)**
- **Chromium fragments:** chats from older builds are removed with `localStorage.removeItem`. Chromium's LevelDB may keep pieces of the old value in its `.log` / `.ldb` files until Chromium compacts them. Sovereign does not open or force-compact Chromium's files. The user-facing text says this.
- **Backups:** exported copies, Time Machine, APFS snapshots and SSD remnants are out of scope. Nothing claims secure erase.
- **Deletion record:** `chat-deletions.json` keeps every deleted chat id (random `time-random` strings, no content), with no cap since round 5, so a deleted chat can never come back.
- **If the hidden probe fails before the dialog:** the dialog says "…and any chats saved by older versions", and the delete is recorded as pending.
- **Old build later:** running an older build can again save chats to localStorage. If a legacy delete is still pending, those are deleted rather than imported (deletion wins).
- **Single delete** never needs the probe, because only chats already in `saved-chats.json` are listed.
- **Dev profiles:** a profile started with a round 2–3 build may contain a leftover `legacy-chat-storage.json`. Nothing reads it now, and it holds no chat data.
- **Repeated cleanup failure:** If removing older-version chats fails again on a later startup, the pending cleanup is not shown to the user again (deleted chats still cannot return). Follow-up: show the pending notice whenever cleanup is still pending, with a regression test. (Feature test pass fix list #15, P3.)

**Manual tests (round 4; replace rounds 2–3)**
1. On a copy of a profile with chats from an older build, open **Settings first** and turn saving off. Expect "Also delete the N saved chats on this device?". Choose Delete. The status reads "Chat saving turned off. N saved chats deleted from Sovereign's storage. Chromium may keep fragments…". Open Ask AI: no chats. In DevTools, `localStorage.getItem('sovereign.ask.chats')` returns `null`, and the theme and downloaded model are still there.
2. Same with `SOVEREIGN_TEST_LEGACY_REMOVE=fail npm start`: the status adds "Chats saved by an older version could not be removed yet; Sovereign will try again the next time it starts." (round 5 wording) `chat-deletions.json` shows `"legacyDeletePending":true`. Quit and run `npm start` normally: pending becomes `false`, the key is `null` and no chat is restored.
3. Clear history in Ask AI shows "Deleted from Sovereign's storage. Chromium may keep fragments in its internal files until it cleans them up."
4. After any delete, the model still shows as downloaded in Settings / Ask AI, and other settings are unchanged.

#### Round 5: final fixes from Codex REVIEW round 4 (2026-11-06)

**1. Deleted ids never expire or get dropped** (REVIEW item 2)
- `src/chat-store.js`:
  - The 2,000-id cap is removed, so `chat-deletions.json` keeps every deleted id. Ids are random `time-random` strings of about 25 bytes, so 10,000 deletions is about 250 KB.
  - While a legacy delete is pending, `importLegacy` records the ids it blocks as deleted, for example a late import from a tab that read the key before the delete.
  - `legacyDeleteDone(ids)` records the given ids in the same write that clears the pending flag.
- `src/main.js`, in `removeLegacyChatKey`: reads the key before `removeItem` and passes its chat ids to `legacyDeleteDone`. A failed peek therefore can't leave ids unrecorded when cleanup completes.
- New export: `legacyChatIds`.

**2. Test hooks ignored in packaged builds** (REVIEW item 3)
- New `src/test-hooks.js`: `testHook(name, { isPackaged })` returns the environment value only when `isPackaged === false`. An unknown state counts as packaged.
- `src/main.js` reads `SOVEREIGN_TEST_LEGACY_REMOVE` through it with `app.isPackaged`. I also put `SOVEREIGN_CHAT_DELETE_TEST_ANSWER` through it: it auto-confirms deletion, so it should not work in an installed app either.
- Other features' test hooks, such as `SOVEREIGN_PERMISSION_TEST_ANSWER`, are out of scope and unchanged.

**3. Wording** (REVIEW item 5)
- After a failed removal, Ask AI and Settings now say: "Chats saved by an older version could not be removed yet; Sovereign will try again the next time it starts."
- The fragments sentence is unchanged. It describes Chromium's internal files after a successful removal, which is a different situation from a live key still waiting to be removed.

**Tests (round 5)**
- `tests/chat-store.test.js`:
  - 2,101 deletions followed by a restart: the first deleted id still can't be imported, or saved by a stale tab.
  - Pending delete with an unseen id, then an import blocked while pending, then `legacyDeleteDone(['seen-at-removal'])`, then a restart. Both ids are refused, and a new legacy chat can still be imported.
  - `legacyChatIds` is covered.
- New `tests/test-hooks.test.js`, added to `npm run check`. A development build honours the hooks. A packaged build, and an unknown packaging state, ignore them.
- `tests/electron/chat-deletion.test.js`: the expected pending wording is updated.

**About the model-cache check**
The Electron test checks an **IndexedDB fixture** (`sovereign-test-model-cache`) on the `sovereign://ask` origin, where WebLLM keeps its cache (`cacheBackend: 'indexeddb'`). It does not download a real model or run inference. **The real model cache must be checked manually:**
1. With a downloaded model, delete chats (Clear history, and the Settings offer).
2. Restart.
3. Confirm the model still shows as downloaded and answers a question without downloading again. Ideally, check this with the network off.

**Not done in this round:** REVIEW item 5 also suggests a persistent visible notice while a legacy delete stays pending across repeated failed starts. The one-time status message is reworded, but no permanent notice was added. It would be a small follow-up if wanted.

**Verified (round 5)**
- `npm run check`: exit 0, including `chat-store tests passed` and `test-hooks tests passed`.
- `npm run test:electron:chat-deletion`: exit 0, `"ok": true`, 13 markers.
- Regression: `test:electron:media-chat`, `ui-smoke`, `stage1-usability` and `permissions` exit 0.
- `git diff --check` is clean.

**Files (round 5):**
- New: `src/test-hooks.js`, `tests/test-hooks.test.js`
- Changed: `src/chat-store.js`, `src/main.js`, `src/ask.js`, `src/settings.js`, `package.json`, `tests/chat-store.test.js`, `tests/electron/chat-deletion.test.js`

### REVIEW (Codex, at Sandeep's explicit request)

#### Quick re-check — round 5 (2026-11-06)
Scope limited to the three MUST FIX findings from round 4 (items 2, 3 and 5) and `npm run check`. Included the relevant untracked store, hook helper and tests. These verdicts supersede those three earlier verdicts. Only REVIEW edited.

- **Item 2: OK — The two reproduced deletion-record failures are fixed.** Deleted ids are no longer capped. Imports blocked while cleanup is pending now record their ids, and main reads ids from the legacy key before removal and records them when clearing pending. The tests cover 2,101 deletions, reopening, stale saves/imports, blocked unseen ids and ids discovered at removal. These tests passed under `npm run check`.
- **Item 3: OK — Packaged builds ignore the failure hook.** Main calls `testHook` with `app.isPackaged`; the helper enables hooks only when that value is exactly false. Tests verify development, packaged and unknown states. The auto-confirm deletion hook is gated too. Tests passed.
- **Item 5: MUST FIX — Retry wording is corrected, but the requested visible status after another failed startup is still missing.** Ask and Settings now correctly say Sovereign will *try again*, rather than guarantee removal. However, `finishPendingLegacyChatDelete()` still runs the safe removal without publishing its failed result; failure only logs to the console, and `savedChatSnapshot()` does not expose pending cleanup. On reopening Settings after another failed startup, the previous status message is gone although the legacy key remains. Round 5 CHANGES explicitly acknowledges this was not implemented. Expose the persisted pending state in the UI after restart and cover two consecutive failed attempts followed by success. No permanent banner is specifically required; a visible status retained until completion is sufficient. The repeated-failure/restart test requested in the earlier finding is also absent.

**Verification:** `npm run check` exited 0, including `chat-store tests passed` and `test-hooks tests passed`. This quick check did not rerun the Electron suite or expand review to other issues. No code changes or commits.


#### Final review — round 4, supported-API approach (2026-11-06)
These verdicts supersede earlier rounds. Reviewed the tracked changes and all four untracked files: `src/chat-store.js`, `src/legacy-chat-probe.html`, `tests/chat-store.test.js`, and `tests/electron/chat-deletion.test.js`. Only REVIEW edited; no code/test/dependency edits or commits.

1. **OK — No direct Chromium storage access; classic-level removed.** Production migration/deletion uses `localStorage.getItem/removeItem` through Chromium and the hidden probe. No direct LevelDB open, compaction, or broad `clearStorageData` operation remains. The former storage module and its tests are absent. No `classic-level` reference remains in application source or dependency manifests. Compared to local `main`: dependency/devDependency declarations match exactly and `package-lock.json` is byte-identical. `package.json` differs only in the intended test/check scripts, so it is not literally identical as a whole. Tests read disposable Chromium files for verification; production does not manipulate them.

2. **MUST FIX — “Deletion always wins” still has two reproducible holes.**
   - **Deletion ids expire.** `src/chat-store.js:161` keeps only the last 2,000 ids. In a disposable directory, `remove('first-deleted')` followed by 2,000 other removals and reopening the store made `isDeleted('first-deleted')` false; `importLegacy` then restored that id. A stale tab can likewise save an expired id. Do not discard deletion protection while an old copy can still arrive. Add a boundary/restart test that exceeds the current cap.
   - **Previously unknown ids are forgotten when pending cleanup finishes.** After a failed initial peek, `clear({ legacy: true })` cannot record ids it did not see. `importLegacy` refuses those chats while pending but does not record their ids, and `legacyDeleteDone()` clears the only remaining barrier. Reproduced with the real store: clear with legacy pending → import an unseen id (blocked) → mark cleanup done → reopen → import the same id (restored). This permits a delayed cross-tab import that read the old key before another probe/tab removed it, or a later old copy, to resurrect chats covered by the bulk delete. The probe queue does not serialize Ask-page migration IPC with cleanup completion. Retain a durable rejection rule for pre-delete legacy data, including unknown/in-flight imports; do not let a key-removal acknowledgement reopen that path. Add a failed-peek plus delayed-import test across cleanup completion/restart and two tabs. Existing tests cover failed removal *after a successful peek*, when the ids are already known; they miss this case.

3. **MUST FIX — Failure hook is active in packaged builds.** `legacyRemovalTestFailure()` (`src/main.js:4973`) checks only `process.env.SOVEREIGN_TEST_LEGACY_REMOVE === 'fail'`. There is no `!app.isPackaged` or equivalent development/test guard. Evaluating the exact function with `app.isPackaged = true` and that variable set still throws `legacy removal failed (test)`. Gate the hook explicitly and test both packaged and development branches. A comment saying “Test-only” does not enforce it.

4. **OK — Other storage is preserved, within the tested scope.** The only Chromium key removed is `sovereign.ask.chats`; no origin-wide cleanup or IndexedDB deletion is present. The passing multi-launch Electron regression confirms the Ask-origin theme and unrelated localStorage, New Tab shortcuts, an IndexedDB cache sentinel, and unrelated preferences survive all tested deletions/restarts. Model setup state still loads. This tests an IndexedDB fixture in the model-cache origin, not a downloaded WebLLM model or successful inference; the code inspection supports preservation, but a real downloaded-model round trip was not performed.

5. **MUST FIX — Fragment disclosure is accurate; the next-start promise is too strong.** The new Chromium-fragment and export/backup wording matches the accepted boundary and the test results (old bytes remain in LevelDB). However, `src/ask.js:1595` and `src/settings.js:159` promise old chats “will be removed the next time Sovereign starts.” Startup only calls `removeLegacyChatKeySafely()` and can fail again; on failure it logs and leaves pending, with no guaranteed removal. Say cleanup remains pending and Sovereign will retry on startup (and distinguish a live legacy key awaiting removal from fragments after removal). Retain a visible pending/failure status if the next attempt fails. Add a repeated-failure/restart wording check. This concerns the live legacy key, not the explicitly disclosed LevelDB fragments.

6. **OK — Checks pass.** `npm run check` exited 0, including the new chat-store tests and Electron-test syntax checks. `npm run test:electron:chat-deletion` exited 0 with final `"ok": true`, 13 markers scanned, no deleted text outside Chromium Local Storage, and five legacy markers reported in `Local Storage/leveldb/000003.log`. The expected denied-IPC and injected-removal errors occurred. Additional isolated Node probes reproduced both finding 2 cases and the packaged-hook failure in finding 3. Those cases are not covered by the passing repository tests.


#### Final re-review — round 3 (2026-11-06)
Current verdicts below supersede earlier reviews. Scope: the three prior MUST FIX items, exclusive startup access to Chromium storage, dependency pinning, and checks. Inspected all six untracked files, including the empty CSP-restricted `src/legacy-chat-probe.html`, the two storage modules and their three test files. Only REVIEW edited; no implementation/test changes or commits.

1. **OK — Existing cleanup markers no longer hide legacy chats.** `runBeforeStartup()` now checks the database on every launch; a found key is imported, deleted and compacted even with a clean marker. Clear and Settings also use the Chromium-backed probe before counting chats. Unit tests exercise the real startup child with a retained marker; the Electron `seed-again` / `marker-kept` phases pass with Settings opened first. Discovery failures are covered by the remaining finding 3 below.

2. **OK — Invalid chat arrays and corrupt files are deletable.** `load()` flags rejected entries as unreadable; `status().hasData` uses file existence. Tests cover missing-id arrays, mixed valid/invalid entries, truncated/non-list JSON and an empty-list file. The Electron test verifies missing-id data can be removed from both Ask and Settings.

3. **MUST FIX — Normal fallback now reports pending cleanup, but a failed probe can resurrect chats after reported deletion.** Valid, empty and malformed legacy keys now schedule compaction; successful fallback returns `pendingRestart`, displays the restart message, and the multi-launch test verifies residue disappears after restart. However, `scanLegacyChatsSafely()` catches probe/import failures and returns false while bulk deletion continues. It records only “cleanup needed,” not a durable request to delete the undiscovered legacy chats. Reproduced using the actual extracted IPC handlers in a disposable-profile Node harness with a failing probe: Clear returned `{ deleted: 1, cleared: true, chats: [], pendingRestart: true }`; the next real `runBeforeStartup()` returned `{ status: 'migrated', imported: 1 }` and restored the live legacy chat to `saved-chats.json`. Thus “fully removed when Sovereign restarts” is false on this supported error path. Propagate the discovery failure and do not report bulk deletion complete, or persist an explicit deletion intent that startup honors instead of importing those chats. Add a probe/import-failure regression through deletion and restart.

4. **MUST FIX — Pre-startup ordering is correct for this process, but real Chromium-held database exclusion is not safe.** The sole production `classic-level` call runs synchronously at `src/main.js:239`, before `app.whenReady()` and window/session setup. The hidden runtime probe uses Chromium localStorage, not `classic-level`. Nevertheless, another running instance can already own this profile: there is no `requestSingleInstanceLock` guard before migration, and the assumed LevelDB lock refusal does not protect against real Chromium in this environment. A disposable Electron harness opened `sovereign://ask`, wrote/flushed legacy localStorage, kept its window alive, then called the real startup child. `lsof` showed Chromium still holding `LOG`, `LOCK`, `MANIFEST-000001` and `000003.log`; the child returned **`{ status: 'migrated', imported: 1 }`**, not `locked`. Reproduced twice. This demonstrates concurrent mutation of a live Chromium database; no claim of actual corruption is made, but the required exclusion guarantee fails. The repository lock test only holds another ClassicLevel handle, and the Electron fallback test simulates `locked`; neither establishes Chromium interoperability. Prevent migration whenever another instance/session owns the profile, using an ownership guard acquired before the child starts, and add a real Chromium-held-profile regression. The direct migration path is limited to `Local Storage/leveldb` and does not address the IndexedDB model-cache directory, but that path separation does not make concurrent Local Storage mutation safe. Do not sign off on other-data safety until this is fixed. The temporary harness/profile used no real user data or downloaded model.

5. **MUST FIX — Dependency is normal but not pinned.** `package.json:39` declares `"classic-level": "^3.0.0"` under `dependencies`. The lockfile resolves 3.0.0, but the caret still permits later 3.x releases. Use an exact version (for example `"3.0.0"`) in package.json and update the lockfile root dependency declaration consistently. No dependency files were changed during review.

6. **OK — Required checks pass.** `npm run check` exited 0, including chat-store and legacy-chat-storage tests. `npm run test:electron:chat-deletion` exited 0 with `"ok": true`: 15 deleted markers absent after restart, fallback residue observed beforehand in `Local Storage/leveldb/000011.log`, unrelated localStorage retained in `000019.ldb`. These successes do not cover the failing probe/restart and real Chromium exclusion reproductions above. The real-lock diagnostic correctly failed its expected-`locked` assertion.


#### Re-review of the three MUST FIX items (2026-11-06)
Scope: only original findings 1–3. Inspected their tracked changes and all five untracked implementation/test files, including `src/legacy-chat-storage.js` and its tests. No code or tests edited. The verdicts below supersede the original findings 1–3; the earlier review is retained as history.

1. **MUST FIX — Settings-first legacy discovery is fixed for a first upgrade, but still skipped when a cleanup marker already exists.** Startup migration now precedes page creation, and the multi-launch Electron test proves Settings can delete two legacy chats without opening Ask. However, `src/legacy-chat-storage.js:150–153` returns immediately on `cleaned: true` without checking for a new legacy key. Reproduced in a disposable profile: run startup once (writes the marker), write a Chromium-format legacy chat as an older build would, then call `runBeforeStartup` again. Result: `{ status: 'clean', imported: 0 }`, the live legacy key remains, and the Settings store reports `{ count: 0, unreadable: false, hasData: false }`. Thus the documented older-build reuse path still reproduces the original Settings-first bug. Check for a live legacy key even with a marker (the lower-level migration already supports this), and add a regression that retains the marker. The current Electron test explicitly removes the marker before its main launch. Also surface incomplete discovery when startup migration fails instead of treating a zero file count as proof that there are no legacy chats.

2. **MUST FIX — Truncated JSON is fixed, but invalid chat arrays still bypass deletion.** The new unreadable status, UI notice and both deletion handlers correctly handle malformed JSON and non-array JSON; the Electron test passes those cases. `src/chat-store.js:88` nevertheless marks every parsed array readable after filtering rejected entries, and `status()` at line 122 ignores existence of the main file. Reproduced with `[{"title":"REVIEW-INVALID-CHAT-TEXT","messages":[{"role":"user","content":"REVIEW-INVALID-CHAT-TEXT"}]}]` (missing id): status is `{ count: 0, unreadable: false, hasData: false }` while the marker remains on disk. Clear still returns without unlinking, and Settings offers nothing. Treat rejected on-disk entries as unreadable and base physical-cleanup availability on file presence; add this case through the IPC/UI path, not only direct `store.clear()`.

3. **MUST FIX — Normal LevelDB compaction and narrower wording pass, but the fallback still reports deletion before legacy residue is removed.** The new startup compaction genuinely removes live and overwritten legacy marker text from the closed test profile while preserving unrelated localStorage. The dialog correctly excludes exports/backups and no longer promises irrecoverability. However, after skipped/failed startup cleanup, `chats:import-legacy` (`src/main.js:4975–4982`) only removes the cleanup marker for a future restart; Ask then calls `removeItem`. Deleting the imported chat in that same run removes only the JSON file and still reports deletion from Sovereign's storage, while LevelDB residue remains until a successful subsequent startup. Moreover, unreadable or empty legacy JSON never invokes `importLegacy` (`src/ask.js:1601–1611`), so with an existing clean marker it does not even schedule compaction. Track and disclose pending legacy cleanup in deletion results/UI, and always schedule cleanup when removing any legacy key, including malformed/empty values. Add fallback-path tests with persisted LevelDB data and an existing marker, checking both before and after restart. The successful first-upgrade test alone does not cover this path.

**Verification:** `npm run check` passed, including both new store/migration test suites. `npm run test:electron:chat-deletion` passed with final `"ok": true`: 10 markers absent from the recursively scanned closed profile, and the unrelated value retained in `Local Storage/leveldb/000007.ldb`. The two additional disposable-profile Node probes reproduced findings 1 and 2 above without modifying repository files. These results confirm the normal-path fixes but do not close all three findings.

#### Original review (historical)
Reviewed 2026-11-06. Read AGENTS.md, this task's PLAN and CHANGES, the entire tracked diff, and all three untracked files (`src/chat-store.js`, `tests/chat-store.test.js`, `tests/electron/chat-deletion.test.js`). Only this REVIEW was edited; implementation and tests were not changed.

**MUST FIX**
1. **Disabling saving before opening Ask AI misses legacy chats.** `src/main.js` `chats:offer-delete-on-disable` counts only `saved-chats.json`; migration happens only on Ask-page load (`src/ask.js:1573`). On an upgraded profile, open Settings first and turn saving off: count is zero, no deletion offer appears, and the live legacy key remains. Opening Ask later imports those chats even with saving off. Migrate/discover legacy storage before deciding there is nothing to delete, and ensure the disable-with-Delete operation covers it. Test with a legacy profile flushed and closed before launching the new build, with Settings opened first.
2. **Clear history can report success while leaving chat bytes in a corrupt file.** `src/chat-store.js` treats malformed JSON as an empty list; `src/main.js` `chats:clear` returns immediately when count is zero without calling `clear()`. The disable handler likewise skips it. A truncated file containing chat text therefore survives; the UI hides/disables the way to remove it. Route explicit deletion through physical cleanup even when parsing produces no valid chats, and provide a recovery path for an unreadable history. The existing corrupt-file unit case calls the store directly and misses this IPC/UI bug. Add an integration case with truncated JSON containing a unique marker.
3. **The deletion guarantee shown to users is false for legacy data.** The confirmation says “Deleted chats are removed from this device and cannot be recovered,” but PLAN §3 correctly acknowledges that migrated text can remain in LevelDB logs/tables; `removeItem` does not erase those bytes. No deletion path clears that legacy storage. This is a known design limitation rather than an implementation deviation, but it prevents signing off on complete deletion. Either implement safe legacy cleanup or narrow the user-facing guarantee and explain the residual legacy-data cleanup requirement in the product. Do not describe unlink/rename as secure erasure; filesystem snapshots and backups also remain outside this operation.

**SHOULD FIX**
4. **In-memory copies and generated replies survive deletion.** `applySavedChats()` clears `messages`, `mediaTurns` and `lastRequest` only when not running. If deletion happens during generation, the completion path merely skips saving; it never closes the deleted conversation after generation finishes. Even for an idle deletion, `lastModelMessages` retains the previous model input, and the model engine resets its conversation only on the next `summarize()` call. Privacy receipts independently retain prompt/query text and URLs in memory, and user-exported receipt JSON is not deleted. Define the deletion boundary explicitly; clear relevant runtime references and close the deleted conversation when generation finishes. Test deletion during generation and deletion from another Ask tab. User-created exports and OS backups should not be silently removed.
5. **Coverage does not establish deletion across caches or upgrades.** The Electron test scans only top-level `saved-chats*` files and injects messages directly, so it never populates real model state or web/media caches. Its legacy key is written and removed in the same running session. Add a two-launch legacy fixture, a recursive profile scan (including LevelDB and caches), multi-tab propagation/concurrent save-delete tests, and denied-sender IPC tests. A passing marker scan of this synthetic profile does not prove deletion of pre-existing flushed data or cached media. The prior CHANGES already acknowledges the migration-test limitation; it remains unresolved.

**OK**
- Normal store operations match the file design: mode 0600, temporary-file rename, no application-created backup, unlink on last deletion, and stale temporary-file cleanup when the store opens. Unit tests inspect all files in their isolated store directory. No additional chat-body persistence was found in the inspected source; session restore strips Ask query parameters, and the model's configured IndexedDB cache is for model assets. This does not prove forensic erasure or removal of cached media/source responses.
- The changed implementation adds local IPC/file operations, with no new network request or cloud-AI fallback. Existing restored media can still load thumbnails through the existing receipt path. Ask/Settings checks guard the new IPC; save is refused when saving is disabled; destructive dialogs default to Keep/Cancel.
- `npm run check`: passed (including chat-store unit tests and Electron-test syntax checks). `npm run test:electron:chat-deletion`: passed with final `"ok": true` after running outside the sandbox; the sandboxed GUI launch aborted with SIGABRT. `git diff --check`: passed before this documentation update. These passing tests do not cover the MUST FIX cases above.

**Manual verification for fixes:** use a disposable old-version profile with persisted legacy chats; launch Settings before Ask and disable saving; verify the deletion offer and absence of reimport after restart. Separately seed a malformed saved-chats file containing a marker and verify explicit Clear removes it. Open the same saved conversation in two Ask tabs, delete it while one is generating, and verify both close it after completion and it never returns. Inspect the closed profile recursively for legacy markers, and distinguish remaining legacy/cache/export data from the new saved-chat file.

## Task: Chat layout overlap
Status: done, round 2 (reviewed 2026-11-09; awaiting Sandeep manual retest)

Priority P2, usability. This is item 4 in the Feature test pass fix list, and known issue (2). Branch: `phase-0/chat-layout`.

### PLAN (Claude)

#### 1. Root cause
- `.ask-page` (`src/styles.css` lines 1444–1452) is a CSS grid with 7 fixed rows: `grid-template-rows: auto auto auto auto minmax(0, 1fr) auto auto`.
- `src/ask.html` puts **8** children in `<main class="ask-page">`, in this order:
  1. `.ask-header`
  2. `#privacy-receipt-panel`: `hidden` until the user clicks the receipt toggle
  3. `#model-setup-card`: `hidden` once the model is ready
  4. `#chat-history-panel`: `hidden` unless chat saving is on, or saved chats exist
  5. `#chat-thread`
  6. `.chat-controls` (Search the web toggle and Attach button)
  7. `#attachment-panel` (always shown)
  8. `#chat-composer`
- The row list was written for the case where 2, 3 and 4 are all shown, which would put the thread in row 5, the `1fr` row. A `hidden` panel is `display: none`, so it takes no grid row and everything after it moves up.
- Normal case (all three hidden): the header, thread, controls, attachment panel and composer fill rows 1–5. The **composer** gets the stretching `1fr` row, and the **thread** gets an `auto` row that grows with its content.
- `.ask-page` has `height: 100vh; overflow: hidden`. Once the chat is longer than the screen, the `auto` rows add up to more than 100vh. The `1fr` row shrinks to 0, and the controls, attachment panel and composer are drawn over the end of the thread. The thread's own `overflow: auto` never comes into play, because its row is as tall as its content.
- The row count only works for the one combination the author had in mind. Any other mix of shown and hidden panels moves the stretching row to the wrong element.

#### 2. The fix (CSS only, `src/styles.css`)
Change `.ask-page` from a fixed-row grid to a **flex column**. Then it does not matter which panels are shown: only the thread stretches, and every other child keeps its natural height.

1. **`.ask-page` (line 1444):**
   - Replace `display: grid` and `grid-template-rows: …` with `display: flex; flex-direction: column;`. Keep `gap: 12px`, `padding: 18px`, `max-width: 980px` and `margin: 0 auto`.
   - Change `overflow: hidden` to `overflow-y: auto; overflow-x: hidden;`. In a normal window nothing overflows, so the page never scrolls. In a very short window the whole page scrolls instead of clipping the composer, which is a safety net.
   - Keep `height: 100vh` from the shared rule at line 1433. `box-sizing: border-box` is already global (line 85), so the padding is inside the 100vh.
2. **All direct children except the thread:** add one rule `.ask-page > * { flex: 0 0 auto; min-width: 0; }`. They keep their natural height and never shrink. `min-width: 0` stops long URLs or file names from widening the column.
3. **`.chat-thread` (line 1556):** add `flex: 1 1 0;` and change `min-height: 0` to `min-height: 120px`. Keep `overflow: auto`. The thread takes all the space left over and scrolls inside itself. The 120px floor stops it collapsing to nothing when the receipt or history panel is open in a short window; the page scrolls instead (see 1). This rule must come after the `.ask-page > *` rule, or be more specific (`.ask-page > .chat-thread`), so that `flex: 1 1 0` wins.
4. **Cap the optional panels** so that opening one never pushes the thread down to its floor in a normal window:
   - `.privacy-receipt-panel` (line 1240) and `.chat-history-panel` (line 1495): add `max-height: 38vh; overflow: auto;`. The receipt table already has its own `max-height: 190px` (line 1323); leave it as it is.
   - Do **not** cap `.model-setup-card`. It is short, and its buttons must always be reachable.
5. **Media queries:** no change is needed. The rules at 860px and 620px only change columns inside the children (`.chat-message`, `.chat-composer`, `.media-card`) and padding. Check that nothing in those blocks sets `grid-template-rows` on `.ask-page` (it doesn't today).
6. **Do not touch** `src/ask.js`, `src/ask.html` or any other page's layout. The shared rule at line 1433 (`.newtab-page, .ask-page, …`) must stay as it is. Override only inside the `.ask-page`-specific rule.

Expected diff: about 15 lines, all in `src/styles.css`.

**Out of scope, note only:** the auto-scroll in `renderThread()` (`src/ask.js` lines 797–799) runs before image thumbnails load. A card that loads later grows after the scroll, so the last image card can end up partly below the fold until the user scrolls. That is a JS follow-up and related to fix-list item 7 (thumbnail loading). It is not the overlap bug. Report it in CHANGES if you see it during testing, but don't fix it in this task.

#### 3. Sizes and states to check
Test each state at three window sizes:
- **Wide:** about 1400×900
- **Narrow:** about 800×700. This is below the 860px breakpoint, so chat labels stack and media cards go to one column.
- **Small:** about 600×500. This is below the 620px breakpoint, and the controls stack vertically.

| # | State | Expected |
|---|---|---|
| A | All optional panels hidden (model ready, saving off, no saved chats, receipt closed), short chat | Thread fills the space between the header and the controls. Controls, attachment panel and composer sit at the bottom of the window. No page scrollbar. |
| B | Same as A, long chat (10+ messages) | Only the thread scrolls. The last message is fully visible directly above the Search the web / Attach bar. Nothing overlaps. |
| C | Privacy receipt panel open, long chat | Receipt is at most about 38vh and scrolls inside itself. Thread still visible and scrollable. Closing the receipt gives the space back to the thread. |
| D | Saved chats panel shown (saving on, several saved chats), long chat | Same as C. |
| E | Model setup card shown (model not loaded yet) | Card at natural height, its buttons fully visible. Thread takes what's left. |
| F | Receipt **and** saved chats **and** model setup all shown, small window | Thread keeps at least 120px. The **page** scrolls, so the composer can always be reached. Nothing is drawn on top of anything else. |
| G | 1–3 attachments added (attachment list grows) | Attachment panel grows, thread shrinks, no overlap. |
| H | Image answer with media cards | Cards render inside the thread and scroll with it. At narrow width the cards stack to one column, and the last card can be scrolled fully into view above the controls. |
| I | Composer textarea resized by dragging its corner (max 150px) | Thread shrinks to make room. No overlap. |
| J | Light and dark theme | No visual change apart from the layout fix. |

#### 4. Manual test steps (Sandeep)
1. `npm run check` passes.
2. `npm start`, then open Ask AI. Make sure the model is loaded, chat saving is off, and the receipt is closed (state A).
3. With web off, ask about 10 short questions (or one question that gives a long answer) until the thread scrolls. **The last line of the last answer must be fully visible above the Search the web / Attach bar.** Scroll the thread up and down: only the thread should move, and the header and composer stay put.
4. Click the Privacy Receipt toggle (state C). The thread gets shorter but still scrolls to the last message. Close the receipt and the thread grows back.
5. Turn chat saving on in Settings and reload Ask AI so the saved-chats panel appears (state D). Repeat step 3's check.
6. Attach two TXT files (state G). Check the last message is still visible.
7. Turn on Search the web and ask `show me pictures of red pandas` (state H). Scroll to the last image card and check it sits fully above the controls bar.
8. Resize the window to about 800×700, then about 600×500, and repeat the checks in steps 3, 4 and 7 at each size. At 600×500, open the receipt and the saved-chats panel together (state F). The page may scroll, but the composer must still be reachable and nothing may overlap.
9. Drag the textarea's resize corner to make it taller (state I).
10. Switch the theme (Settings) and check once in dark mode (state J).
11. Regression: open the New Tab, Settings, Downloads and Bookmarks pages and check their layout is unchanged, because they share the rule at `src/styles.css` line 1433.

**Automated check (optional, if it's quick):** in `tests/electron/ui-smoke.test.js`, after filling the thread with enough messages to scroll, assert that `#chat-thread`'s `getBoundingClientRect().bottom` is `<=` `.chat-controls`'s `getBoundingClientRect().top`, and that `#chat-thread.scrollHeight > clientHeight` (the thread scrolls, not the page). Skip this if the smoke fixture can't easily fill the thread. The manual steps above are the main check.

#### Round 2 PLAN (2026-11-09, after Sandeep's manual test failed)
**What failed:** in a window of about 1600×1100 with saving on, 3 saved chats and an image answer:
1. The last image card's buttons were clipped at the bottom of the chat, even with the chat scrolled to the end.
2. The chat was a thin strip, and the page and the chat both scrolled, so there were two scrollbars.

**Reproduced** with a scratch probe that renders the real Ask AI page with 3 saved chats, the model card showing and a 5-card image answer. On this display the window is clamped to a 737px viewport.

| Part | Height |
|---|---|
| Header | 72px |
| Model card | 103px |
| Saved chats panel | 210px |
| Controls | 50px |
| Drop zone panel | 70px |
| Composer | 138px |

Together with the gaps and padding, these are taller than the viewport. The thread sits at its 120px minimum, and the page scrolls as well, which gives the two scrollbars. In a 120px strip, an image card (about 230px) never fits, and its buttons are cut off at the strip's edge.

A second cause of clipping: thumbnails are `height: 100%` of a preview with no fixed height, so a card grows when its image loads. `renderThread()` has already scrolled to the bottom by then. A portrait thumbnail can push the last card's buttons below the fold after the "scroll to end".

**Goal:** the conversation is the main area. The page does not scroll in a normal window; only the thread scrolls. The last element can always be scrolled fully into view, with padding below it.

**Changes. Keep them to these files:**
- `src/styles.css`
- `src/ask.html`
- `src/ask.js`
- `package.json` (test script only)
- one new test

**1. Thread padding and stable card height (`src/styles.css`)**
- `.chat-thread`:
  - Change the padding to `2px 4px 24px 0`. The extra bottom padding keeps space below the last card, and the right padding keeps the scrollbar off the cards.
  - Add `scroll-padding-bottom: 24px`.
- `.media-preview`: add `position: relative`.
- `.media-preview img`: add `position: absolute; inset: 0;` and keep `width/height: 100%; object-fit: cover`. The image then never changes the card's height. The preview keeps its `min-height` (92px, or 160px under 860px) and stretches with the card body. The text placeholder ("Preview unavailable" / "Video") still sizes normally.
- No JS change for scrolling. The existing `forceScroll` / `shouldAutoScroll` logic is enough once the card height no longer changes after render.

**2. Model card becomes one line (`src/styles.css` only; the HTML ids stay)**
- The card is already hidden once the model is loaded (`renderModelSetupState` → `engineLoaded`). Keep that.
- Before the model loads, make it a compact row:
  - `.model-setup-card`: `display: flex; align-items: center; gap: 12px; padding: 8px 12px;`. This replaces the 2-column grid.
  - `.model-setup-card > div`: `flex: 1 1 auto; min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 10px; row-gap: 2px;`
  - `.model-setup-card .section-title`: keep it as the "Local model" label, at the same small size, with `margin: 0`.
  - `.model-setup-card h2`: `margin: 0; font-size: 13px`.
  - `#model-size` and `#model-status`: `font-size: 12px`. Keep them as they are. They wrap only if the window is too narrow, so a long error message is never truncated.
  - `#download-model`: add the `compact-action` class in `ask.html`, plus `flex: 0 0 auto` in CSS.
- Remove `.model-setup-card` from the 860px media-query rule that sets `grid-template-columns: 1fr`. Leave `.chat-composer` in that rule.
- Target: the card is ≤ 56px tall at widths ≥ 860px.

**3. Saved chats become a collapsible section (`src/ask.html`, `src/ask.js`, `src/styles.css`)**
- **HTML:** in `.chat-history-header`, replace `<strong>Saved chats</strong>` with:

  ```html
  <button class="chat-history-toggle" id="chat-history-toggle" type="button" aria-expanded="true" aria-controls="chat-history-list">Saved chats</button>
  ```

  Keep `#clear-chat-history`, `#chat-history-panel` and `#chat-history-list` unchanged. Tests use those ids.
- **JS state:** add a module variable `let chatHistoryExpanded = null;`. `null` means automatic.
- **JS helper:** add `chatHistoryIsExpanded()`. It returns `savedChatsUnreadable || (chatHistoryExpanded ?? messages.length === 0)`.
  - Expanded by default when the thread is empty.
  - Collapsed by default once a chat is open.
  - Always expanded while the unreadable-history notice is showing, so the user can see it and delete it.
- **JS helper:** add `updateChatHistoryDisclosure()`.
  - Sets `chatHistoryList.hidden = !expanded` and `toggle.setAttribute('aria-expanded', String(expanded))`.
  - Sets the toggle text to `Saved chats (N)`, where N is `savedChatList.length`, or plain `Saved chats` when N is 0.
  - Adds or removes the class `collapsed` on `#chat-history-panel`.
- **Call sites:**
  - Call `updateChatHistoryDisclosure()` at the top of `renderChatHistory()`, after the `hidden` early return. The list is still rebuilt as today, even when collapsed, so hidden items stay in the DOM.
  - Also call it at the end of `renderThread()`. That way asking the first question collapses the list automatically.
- **Toggle click:** sets `chatHistoryExpanded = !chatHistoryIsExpanded()` and calls `updateChatHistoryDisclosure()`.
- **Reset to automatic:** set `chatHistoryExpanded = null` when a saved chat is loaded (in the title click handler, before `renderThread`) and in `newChat()`. So loading a chat collapses the list, and New chat expands it again.
- **CSS:**
  - `.chat-history-panel`: change the padding to `6px 10px`, and the cap to `max-height: min(30vh, 260px)`.
  - `.chat-history-toggle`: styled as a plain text button. Bold, 13px, no border or background, `color: var(--text)`, with a ▸ marker before the text, rotated to ▾ when the panel is not `.collapsed`. Visible `:focus-visible` ring, using the existing focus styles.
  - `#chat-history-list[hidden] { display: none; }`
- **Target:** collapsed panel ≤ 48px.

**4. Compact drop zone (this is fix-list #17, folded in here; `src/ask.html`, `src/ask.js`, `src/styles.css`)**
- **HTML:** split the drop-zone text into two spans. Keep the exact wording, because wording changes belong to fix-list #10.

  ```html
  <span class="drop-zone-title">Drop PDF, TXT, Markdown, or CSV files here.</span> <span class="drop-zone-detail">Attachments stay temporary in this chat unless chat saving is enabled.</span>
  ```

- **Compact state:** `#attachment-panel` gets the class `compact` when there are no attachments **and** no file drag is in progress. `renderAttachments()` sets it. "Attach used" counts as expanded as soon as files are added. A cancelled file picker leaves it compact.
- **Page-level drag tracking in `ask.js`:**
  - A `dragDepth` counter.
  - `document` `dragenter`: if `event.dataTransfer?.types` includes `'Files'`, increment the counter and remove `compact`.
  - `document` `dragleave`: decrement the counter. At 0, re-apply compact through `renderAttachments()`, or through a small `updateAttachmentPanelCompact()` helper that both call.
  - `document` `drop` and `dragend`: reset the counter to 0 and update.
  - Do **not** `preventDefault` on document-level events. Only the drop zone accepts drops, exactly as today.
- **CSS:**
  - `.attachment-panel.compact`: `padding: 6px;`
  - `.attachment-panel.compact .attachment-drop-zone`: `padding: 6px 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`
  - `.attachment-panel.compact .drop-zone-detail`: `display: none;`
  - `.attachment-list:empty`: `display: none;`. This removes the empty grid row and its gap.
- Keyboard and screen readers are unchanged. The drop zone keeps `tabindex="0"` and Enter/Space opens the picker, the Attach label is unchanged, and the `.drag-over` focus ring is unchanged.
- **Target:** the compact panel is ≤ 48px.

**5. Less fixed chrome, and no nested scrolling (`src/styles.css`)**
- `.ask-page`: change `gap` from 12px to 10px. Keep `overflow-y: auto` only as the safety net for very short windows.
- `.privacy-receipt-panel`: change the cap from `38vh` to `min(30vh, 260px)`, so opening it doesn't push the thread to its floor in a normal window.
- **Composer:** change `.chat-actions` to `grid-template-columns: repeat(3, minmax(74px, auto))`, which gives 2 rows instead of 3. This brings the composer from about 138px to about 100px. Keep the 860px rule (4 columns) and the 620px rule as they are.
- **Header:** when the thread has messages, hide the description paragraph.
  - `renderThread()` sets `document.body.classList.toggle('ask-has-messages', messages.length > 0)`.
  - CSS: `.ask-has-messages .ask-header p { display: none; }`
  - The h1 and the buttons stay.
- **Expected budget** at a 737px viewport with the model card shown and saved chats collapsed:
  - Header about 45px, model 56, history 48, controls 50, drop zone 48 and composer about 100.
  - Plus about 60px of gaps and 36px of padding, which is about 445px in total.
  - That leaves the thread about 290px, with no page scroll.
- With the model loaded, the thread gets more than 50% of the viewport. In a 1600×1100 window, the thread is far larger.

**6. Automated test (new `tests/electron/ask-layout.test.js`)**
Use the same setup as `ui-smoke.test.js`:
- A temporary profile with `saveChatsOnDevice: true`.
- `require('../../src/main.js')`, then open Ask AI.

Set up the page with page globals (they are top-level `let` bindings in `ask.js`), the same way the round-2 probe did:
- `savedChatList` = 3 chats, `saveChatsOnDevice = true`, then `renderChatHistory()`.
- `messages` = 4 Q/A pairs, plus an assistant message whose `mediaResults` holds 5 image items. Their `thumbnailUrl` is a `data:image/svg+xml` **portrait** image, 600×1200. A `data:` URL makes no network request.
- Make sure `#model-setup-card` is shown. No model is loaded in tests, so it normally is.
- Call `renderThread({ forceScroll: true })`.

Resize the window to 1280×900. Wait for all `document.images` to finish loading, then two animation frames.

Assert:
1. **Page does not scroll:** `.ask-page.scrollHeight <= clientHeight + 1`.
2. **Thread is the main area:** `#chat-thread.clientHeight >= 0.35 * innerHeight`. The thread is also the tallest direct child of `.ask-page`.
3. **History collapsed:** `#chat-history-list.hidden === true`, the toggle has `aria-expanded="false"`, the toggle text includes `(3)`, and the panel is ≤ 48px.
4. **Model card one line:** ≤ 56px.
5. **Drop zone compact:** `#attachment-panel` has `.compact` and is ≤ 48px.
6. **Scroll to end works:**
   - `renderThread` force-scrolled to the end, so `scrollHeight - scrollTop - clientHeight <= 1` **after** the images loaded.
   - The last `.media-actions` bottom is ≤ `#chat-thread` bottom − 8.
   - The last child's bottom is ≤ the thread's bottom.
7. **Image load doesn't resize cards:** record each `.media-card` height before the images load (render with the images, and measure synchronously in the same task) and after. They must be equal within 1px.
8. **Toggle:**
   - Clicking `#chat-history-toggle` expands the list and sets `aria-expanded="true"`.
   - Clicking it again collapses it.
   - `newChat()` with an empty thread expands it.
   - Calling the title-click restore on a saved chat collapses it. Simulate this by setting `messages` and running the restore path, or simply call `.chat-history-title.click()`. The saved chat's `messages` are empty, so instead assert that after `newChat()` and then `chatHistoryExpanded = null; messages = [m]; renderThread()`, the list collapses.
9. **Drag:**
   - Dispatch `new DragEvent('dragenter', { dataTransfer })` on `document`, where `dataTransfer` is a `new DataTransfer()` with `items.add(new File(['x'], 'a.txt', { type: 'text/plain' }))`. Then `#attachment-panel` loses `.compact`.
   - Dispatch `dragleave` and it becomes compact again.
   - Adding an attachment entry also removes `.compact`. Push a fake `{ name, status: 'ready' }` and call `renderAttachments()`, or skip this if it is brittle.
10. **Small-window safety net:** at 600×500, the composer (`#chat-form`) can be reached. After `.ask-page.scrollTop = scrollHeight`, the composer's bottom is ≤ `innerHeight`, and the thread is ≥ 120px.

Print a JSON summary and quit with exit code 0 or 1, like the other Electron tests.

**package.json:**
- Add `"test:electron:ask-layout": "npm run build:ai && node --check tests/electron/ask-layout.test.js && env -u ELECTRON_RUN_AS_NODE electron tests/electron/ask-layout.test.js"`.
- Add `node --check tests/electron/ask-layout.test.js` to `check:tests`.

**Codex note:** Electron aborts inside the Codex sandbox, so just `node --check` the new test. Claude runs it outside the sandbox during REVIEW.

**7. Do not change**
- Media card markup or JS, except nothing (CSS only for the card).
- The receipt contents.
- Chat saving and deletion logic.
- Other pages' layout.
- No new network requests. The test's thumbnails are `data:` URLs.

**8. Manual tests (Sandeep), after round 2**
1. `npm run check` passes.
2. Window about 1600×1100. Turn saving on so 3 or more saved chats exist. Before the model loads, the model card is one line. Then ask an image question with web on (`show me pictures of red pandas`).
   - Only the chat scrolls. There is no page scrollbar.
   - The chat area is the largest part of the page.
   - Scroll to the end: the last card's Open source page / Open original media / Copy image URL / Download buttons are fully visible, with space below them.
3. **Saved chats:**
   - With a chat open, the list is collapsed to one line, "▸ Saved chats (3)". Click to expand, then click to collapse.
   - Click **New chat**: the list expands.
   - Load a saved chat: it collapses again.
   - Clear history and Delete still work.
4. **Model:** before the model loads, the card is one line with its button. After the first answer loads the model, the card disappears.
5. **Drop zone:**
   - It is one line ("Drop PDF, TXT, Markdown, or CSV files here.").
   - Drag a file over the window: it expands. Drag out: it is one line again.
   - Drop a TXT file on it: the file is attached and the panel stays expanded. Remove the file: one line again.
   - **Attach** works the same way.
   - Tab to the drop zone and press Enter: the file picker opens.
6. Open the Privacy Receipt. It is capped, and the chat still scrolls without a page scrollbar.
7. Resize to about 800×700 and 600×500. Nothing overlaps. At 600×500 the page may scroll, but the composer must stay reachable.
8. Check dark theme, and check that the New Tab, Settings and Downloads layouts are unchanged.


### CHANGES (Codex)

#### Round 2, fix 1

- Fixed both Round 2, review 1 MUST FIX items in `tests/electron/ask-layout.test.js`: explicit `app.exit(0)` / `app.exit(1)`, exact `sovereign://ask/` matching, and readiness guards for `saveChatsOnDevice` and the model card. Kept substring matching for chrome/newtab.
- Validation: `npm run check` passed, including the test's syntax check. Electron runtime was not run in the sandbox, per PLAN; run `npm run test:electron:ask-layout` outside it and confirm `ok: true` with exit 0 (failed assertions must exit 1).
- No product code, PLAN or REVIEW changes; no commit.

#### Round 2

Implemented the Round 2 PLAN, tests first:
- `tests/electron/ask-layout.test.js` (new): temporary saving-enabled profile, 3 saved chats, 4 Q/A pairs and 5 portrait SVG thumbnails using only data URLs. Measures card heights synchronously before image loading and after loading plus two animation frames. Asserts page/thread geometry, compact panel heights, bottom padding and scroll position, disclosure defaults/toggles, unreadable-history visibility, drag/reset and attachment states, and composer access at 600×500.
- `package.json`: added `test:electron:ask-layout` and the new test's syntax check to `check:tests`.
- `src/styles.css`: stable absolutely positioned thumbnails, thread bottom/right padding, compact model row, collapsible-history styling and focus ring, compact empty drop zone, smaller panel caps/page gaps, three-column composer actions, and hidden header description during conversations. Preserved the short-window page-scroll safety net and responsive composer rules.
- `src/ask.html`: added the history disclosure button, compact model-button class, and separate drop-zone title/detail spans without changing their wording or existing ids.
- `src/ask.js`: automatic/manual history disclosure with reset on New chat and saved-chat restore, forced expansion for unreadable history, conversation body class, and document-level file-drag depth tracking for the empty attachment panel. Document listeners do not prevent default; existing drop acceptance and scrolling logic stay unchanged.

Validation:
- Wrote the Electron regression test and script wiring before product edits; `node --check tests/electron/ask-layout.test.js` and `npm run check` passed at that stage.
- `npm run check` passed after implementation and the final CHANGES update. `git diff --check` passed.
- As instructed, did not launch Electron in the sandbox. The new test has only been syntax-checked; no runtime red/green result or visual layout result is claimed. Claude should run `npm run test:electron:ask-layout` outside the sandbox during REVIEW.
- No new network requests or cloud AI calls. Existing unrelated work was preserved. PLAN and REVIEW were not edited. No commit or push.

Manual testing: follow Round 2 PLAN §8. With 3 saved chats and an image answer at about 1600×1100, check that only the thread scrolls and the last card's buttons have space below. Exercise history expand/collapse, New chat and saved-chat restore; drag in/out, attach/remove a TXT file, and keyboard attachment picking. Open the receipt, resize to 800×700 and 600×500, and verify composer access, dark theme, and unchanged New Tab/Settings/Downloads layouts.


Implemented the CSS-only PLAN in `src/styles.css`:
- Converted `.ask-page` to a flex column with vertical page overflow as the short-window safety net and horizontal overflow hidden.
- Made direct children keep their natural height with `flex: 0 0 auto` and `min-width: 0`; the later `.chat-thread` rule overrides flex to `1 1 0`, keeps internal scrolling, and sets a 120px minimum height.
- Capped the receipt and saved-chats panels at `38vh` with internal scrolling.
- Preserved the shared page rule, model setup card, receipt table cap, responsive rules, and all JavaScript/HTML.

Validation: `npm run check` passed after the CSS change. Inspected the CSS diff and responsive rules; no `.ask-page` grid-row override remains. No automated UI test was added, and the visual state matrix has not been run. No new network requests were introduced.

Manual testing: follow PLAN §4 at approximately 1400×900, 800×700, and 600×500. With a long chat, verify the last message scrolls fully above the controls; toggle receipt/history, show model setup, add attachments, inspect image cards, and resize the composer. With all panels open in the small window, verify the page scrolls and the composer remains reachable. Check both themes and the New Tab, Settings, Downloads, and Bookmarks layouts.

The image-thumbnail auto-scroll follow-up remains outside this change; it was not exercised during testing. No commit was made.

### REVIEW (Claude)

#### Round 2, review 2 (2026-11-09): DONE
- **MUST FIX 1 fixed:** the catch calls `app.exit(1)` and success calls `app.exit(0)`. I proved it with a scratch copy that has one assertion made impossible: it printed `{"ok":false,…}` and exited **1**.
- **MUST FIX 2 fixed:** the test waits for the exact `sovereign://ask/` URL, and the readiness wait guards `typeof saveChatsOnDevice`.
- `npm run test:electron:ask-layout` passes (`"ok": true`, exit 0), run outside the sandbox.
- `npm run check` passes and `git diff --check` is clean.
- Product code is unchanged since review 1. The review 1 SHOULD FIX notes still stand, and neither blocks.
- Fix-list #17 (Compact drop zone) is done as part of this round.

#### Round 2, review 1 (2026-11-09)
I reviewed the `src/ask.html`, `src/ask.js`, `src/styles.css` and `package.json` diffs against the Round 2 PLAN. I ran the new test and the round-2 probe outside the sandbox.

**MUST FIX (test only; the product code is correct):**
1. **The new test can never fail.** `tests/electron/ask-layout.test.js:153-157` sets `process.exitCode = 1` and then calls `app.quit()`. Under Electron the process still exits 0. That is how the first run below reported `{"ok":false,…}` with **exit 0**. Use `app.exit(1)` in the catch, as `media-chat.test.js` and `chat-deletion.test.js` do. Also call `app.exit(0)` on success instead of `app.quit()`.
2. **The test waits on the wrong page.**
   - Lines 24 and 38 use `getURL().includes('sovereign://ask/')`, which first matches `sovereign://ask/model-setup.html`. That page has no `renderThread` or `#model-setup-card`, so the run timed out with "Timed out waiting for Ask AI."
   - Match the exact URL `=== 'sovereign://ask/'`, like `ui-smoke.test.js:49-51`. Keep `includes` only for `index.html` and `sovereign://newtab`.
   - Also make the line-39 wait robust: `typeof saveChatsOnDevice !== 'undefined' && …`.

**Evidence that the product change is right.** I ran a scratch copy of the test with only those two fixes applied, and it **passed**. At a 735px viewport (this display clamps the 1280×900 window):

| Measurement | Result |
|---|---|
| Thread height | 330px, 45% of the viewport, the tallest part of the page |
| Page scroll | none (`scrollHeight == clientHeight`) |
| Model card | 46px |
| Collapsed saved chats, "Saved chats (3)" | 42px |
| Compact drop zone | 45px |
| Composer | 97px |
| Header (description hidden) | 30px |
| Last `.media-actions` | 48px above the thread's bottom edge |
| Image cards | identical height before and after the portrait thumbnails loaded |

All 11 interaction checks passed: toggle, New chat, restore, unreadable notice, drag enter, leave, drop and dragend, and attachment add and remove. At 600×500 the composer can be reached and the thread keeps its 120px floor.

**SHOULD FIX (not blocking):**
- `document` `dragleave` decrements `dragDepth` even for non-file drags, while only file drags increment it. `Math.max(0, …)` keeps it safe. The worst case is that the panel compacts early during a mixed drag. Acceptable.
- In windows of 800×700 or smaller, the thread still sits at its 120px floor and the page scrolls. That is the planned safety net. Making the composer or controls even smaller is a possible later P3.

**OK:**
- **Model card:** the HTML and JS match the PLAN §2–4 exactly, and every existing id is kept. The model card is one line and still disappears once the model is loaded. Long errors wrap rather than truncate.
- **Saved chats:**
  - Collapsed by default with a chat open, expanded on New chat, collapsed again on restore.
  - Always expanded while the unreadable notice is showing.
  - The list is still rebuilt while hidden, so `chat-deletion` and `media-chat` (which click hidden items through JS) are unaffected.
- **Drop zone:** compact until a file drag or an attachment. The document listeners don't call `preventDefault`. Wording is unchanged.
- **Card height:** thumbnails are absolutely positioned, so a card can no longer grow after the auto-scroll. Together with the 24px bottom padding, this removes the clipping.
- **Round-2 probe at the reported scenario:** 3 saved chats, the model card shown, a 5-image answer, a window of 1600×1100 (clamped to 737px).
  - Before: thread 120px, page scrolls.
  - After: thread 332px, **no page scroll**, and the last buttons are not clipped.
  - Screenshot: `shots-after/ask-1600x1100.png` in my scratchpad.
- **Regression:** `chat-deletion`, `media-chat` and `ui-smoke` pass outside the sandbox.
- No new network requests. The test thumbnails are `data:` URLs.

---
#### Round 1 review
Reviewed 2026-11-09. Checked the `src/styles.css` diff against the PLAN, read the rules it interacts with, and measured the real Ask AI page in Electron with a throwaway probe script (scratchpad only, not added to the repo). The probe filled the thread with 15 long messages plus a 4-card image grid, toggled the optional panels, and measured at three window sizes.

**MUST FIX:** none.

**SHOULD FIX (follow-up, not blocking):**
- In short windows the fixed bottom stack (controls bar + attachment panel with its drop zone + composer) is about 280–310px. At 800×700 (494px viewport) that leaves the thread at its 120px floor even with every optional panel hidden, so the page scrolls to reach the composer. Nothing overlaps and everything is reachable, but the chat area is small. Suggested follow-up: make the attachment drop zone compact (one line) until files are added or dragged over. This is a separate usability task, not part of the overlap bug.
- No automated layout assertion was added (the PLAN marked it optional). The probe in this review could become a `tests/electron/` test later.

**OK:**
- The diff matches the PLAN exactly: `.ask-page` is a flex column with `overflow-y: auto; overflow-x: hidden`, `.ask-page > *` keeps natural height, `.chat-thread` gets `flex: 1 1 0; min-height: 120px` and comes later in the file with equal specificity, so it wins. The receipt and saved-chats panels are capped at 38vh.
- The shared page rule, the model setup card, the receipt table cap and the 860px/620px media queries are unchanged, and no media query sets `grid-template-rows` on `.ask-page`. JS and HTML are untouched.
- The thread's children (`.chat-message`, a grid with visible overflow) keep a content-based minimum height, so the newly fixed-height thread scrolls instead of squashing messages.
- `[hidden]` overrides exist for the receipt, setup and history panels, so the new `max-height`/`overflow` rules do not show hidden panels.
- Probe results: at 1400×900, 800×700 and 600×500, with no panels, with the receipt only, and with receipt + saved chats + model setup: `#chat-thread` bottom is above `.chat-controls` top in all 9 cases (no overlap), the thread scrolls internally, and after scrolling to the end the last message (the image grid) sits fully above the controls bar. At 1400×900 with no panels the page itself does not scroll. In the smaller sizes, or with all panels open, the thread holds 120px and the page scrolls, as planned.
- No network requests added. `npm run check` passed (exit 0).

**Still needs Sandeep's hand test:** PLAN §4, particularly real image cards from SearXNG (the probe used placeholder cards of 220px) and dragging the textarea resize corner. The PLAN's out-of-scope note on auto-scroll before thumbnails load still applies.

## Task: Address bar input
Status: done (reviewed 2026-11-09)

Priority P2, bug. Feature test pass fix list #5 (section 1, Browsing). Branch: `phase-0/chat-layout` (batch of P2 fixes).

### PLAN (Claude)

#### 1. Root cause
- **Address bar:** `classifyAddressInput` (`src/main.js` ~line 435) treats any input that starts with `letters:` as an unsupported URL scheme, unless it is `http(s)://` or `localhost:port`. So `Python: list comprehension`, `Note:buy milk` and `example.com:8080` all get "Sovereign only opens http and https websites." `new URL('example.com:8080')` really does parse `example.com:` as a scheme, which is why the old check fires.
- `looksLikeNavigableAddress` accepts any `a.b` with any last label, so version numbers like `3.11.2` open as URLs (Chromium even parses `3.11.2` as the IPv4 address 3.11.0.2).
- **New Tab search box:** `src/newtab.js` (submit handler ~line 372) always calls `window.sovereign.openSearch(...)`, and `browser:open-search` in `src/main.js` (~line 4262) always opens a Search or Ask AI tab. So `localhost:3000` or `https://example.com` typed there is **sent to SearXNG as a query** and never opened.

#### 2. Changes

**A. New pure module `src/address-input.js`** (CommonJS, no Electron imports, same style as `src/permission-policy.js`). Move these functions out of `src/main.js` unchanged unless stated: `normalizeInternalUrl`, `normalizeAddress`, `normalizeSearchQuestion`, and `classifyAddressInput` (rewritten, below). Delete `looksLikeNavigableAddress` (replaced by `looksLikeHostAddress`). Export `classifyAddressInput`, `normalizeAddress`, `normalizeInternalUrl`, `normalizeSearchQuestion`, `looksLikeHostAddress`. In `src/main.js`, `require('./address-input')` and destructure those names so every existing caller of `normalizeAddress` / `normalizeInternalUrl` keeps working with no other edits.

**`normalizeAddress` change (one line):** the "use `http` not `https`" rule for scheme-less input currently covers `localhost` and IPv4. Add bracketed IPv6 (`^\[[0-9a-f:.]+\]`, case-insensitive) to it, so `[::1]:3000` opens as `http://[::1]:3000/`.

**`classifyAddressInput(input)`**, rules in this order (return shapes unchanged: `{kind:'error',error}`, `{kind:'internal',url}`, `{kind:'url',url}`, `{kind:'search',question,mode:'search'}`):
1. Trim. Empty → error `Enter a website address or search question.` (unchanged).
2. Starts with `?` → search for the rest, trimmed. If the rest is empty → the empty-input error. (Lets users force a search for a host-like word, e.g. `?node.js`.)
3. `normalizeInternalUrl(raw)` succeeds → internal (unchanged).
4. Starts with `http://` or `https://` (case-insensitive) → `normalizeAddress(raw)`. ok → url. Not ok → error with `checked.error`. **Never** search. Spaces after the scheme are allowed here (the URL parser encodes them).
5. Starts with any other `scheme://` (`/^[a-z][a-z\d+.-]*:\/\//i`) → error `Sovereign only opens http and https websites.`
6. No whitespace and starts with a known non-web scheme followed by `:` → same error. List (case-insensitive): `about, blob, chrome, chrome-extension, data, devtools, file, ftp, intent, javascript, magnet, mailto, sms, tel, view-source, ws, wss`. These must never go to the search engine. Every other `word:` prefix is **not** treated as a scheme.
7. Contains whitespace → search.
8. `looksLikeHostAddress(raw)` is true → `normalizeAddress(raw)`. ok → url. Not ok (for example `localhost:99999`, `999.1.1.1`) → error with `checked.error`. It clearly looked like an address, so it is never searched.
9. Otherwise → search.

**`looksLikeHostAddress(value)`**: true when the whole value is `HOST` + optional `:PORT` (1–5 digits) + optionally a path/query/fragment starting with `/`, `?` or `#`, where HOST is one of:
- `localhost` (case-insensitive)
- IPv4: `\d{1,3}(\.\d{1,3}){3}` (range checked later by the URL parser)
- bracketed IPv6: `\[[0-9a-f:.]+\]`
- a domain: one or more labels `[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?` followed by `.`, then a top-level label that is either letters only (2–63) or `xn--` punycode. Case-insensitive.
No `@` support (no userinfo), so `user@example.com` is a search.

**B. New Tab box opens addresses.**
- `src/newtab.js` submit handler: when there are **no** attachments, add `navigateIfAddress: true` to the `openSearch` payload. With attachments, the payload is unchanged (it's an Ask AI handoff).
- `src/main.js`, `browser:open-search` handler: at the top (after the sidebar line), if `input.navigateIfAddress === true && !input.handoffId`, call `classifyAddressInput(input.question)`. If the result's kind is **not** `search`, call `navigateActive(state, input.question)` and return. This opens URLs and internal pages, and shows the same error as the address bar for blocked schemes. It applies in both Search and Ask modes, because a bare address is never a question. Otherwise fall through to the current behaviour.
- `src/renderer.js` and `src/search.js` are **not** changed. (The toolbar Search button's seed uses `naturalSearchQuestion`; a `word:` input just seeds an empty search box there, which is harmless. Out of scope.)

**No new network requests.** Navigation to the typed address is the same as today's address bar.

#### 3. Tests (write first)
**`tests/address-input.test.js`** (new, `node:assert/strict`), and add `node --check src/address-input.js && node tests/address-input.test.js` to the `check` script in `package.json` next to the other unit tests. It must cover at least these 40 cases with the exact expected result:

| Input | Kind | Expected url / question |
|---|---|---|
| `example.com` | url | `https://example.com/` |
| `example.com:8080` | url | `https://example.com:8080/` |
| `example.com:8080/path?q=1#x` | url | `https://example.com:8080/path?q=1#x` |
| `example.com?q=1` | url | `https://example.com/?q=1` |
| `wikipedia.org` | url | `https://wikipedia.org/` |
| `sub.domain.co.uk/page` | url | `https://sub.domain.co.uk/page` |
| `xn--bcher-kva.example` | url | `https://xn--bcher-kva.example/` |
| `localhost` | url | `http://localhost/` |
| `localhost:3000` | url | `http://localhost:3000/` |
| `LOCALHOST:3000/api` | url | `http://localhost:3000/api` |
| `127.0.0.1:8080` | url | `http://127.0.0.1:8080/` |
| `192.168.1.1` | url | `http://192.168.1.1/` |
| `[::1]:3000` | url | `http://[::1]:3000/` |
| `https://example.com` | url | `https://example.com/` |
| `HTTPS://Example.com/Path` | url | `https://example.com/Path` |
| `http://localhost:3000/a b` | url | `http://localhost:3000/a%20b` |
| `  https://example.com/x  ` | url | `https://example.com/x` |
| `Python: list comprehension` | search | `Python: list comprehension` |
| `Note:buy milk` | search | `Note:buy milk` |
| `C++: templates` | search | `C++: templates` |
| `re:invent` | search | `re:invent` |
| `foo:bar` | search | `foo:bar` |
| `what is example.com` | search | `what is example.com` |
| `history   of tea` | search | `history of tea` |
| `3.11.2` | search | `3.11.2` |
| `e.g.` | search | `e.g.` |
| `user@example.com` | search | `user@example.com` |
| `hello` | search | `hello` |
| `?example.com` | search | `example.com` |
| `ftp://example.com` | error | http/https-only message |
| `file:///etc/passwd` | error | http/https-only message |
| `javascript:alert(1)` | error | http/https-only message |
| `mailto:a@example.com` | error | http/https-only message |
| `view-source:example.com` | error | http/https-only message |
| `https://` | error | (any non-empty message) |
| `localhost:99999` | error | (any non-empty message) |
| `` (empty) and `   ` | error | `Enter a website address or search question.` |
| `?` | error | `Enter a website address or search question.` |
| `sovereign://settings` | internal | `sovereign://settings/` |
| a 400-character search phrase with spaces | search | sliced to 300 characters |

Also assert, as a loop over every row whose kind is `url`: the result is never `search` (the "never send a URL to the search engine" rule), and `looksLikeHostAddress` is false for `Python:`, `3.11.2` and `user@example.com`.

**`tests/electron/browser-features.test.js`** (extend; it already runs a local HTTP server on 127.0.0.1): after the existing feature page loads, open a New Tab (`window.sovereign.newTab()` from the chrome contents), wait for `#home-query`, set its value to `127.0.0.1:<port>/home-typed` (no scheme), and submit `#home-search` (`requestSubmit()`). Wait until some web contents has URL `http://127.0.0.1:<port>/home-typed`, and assert no contents URL starts with `sovereign://search`. Make the server answer any path (it already does). Do this before the sidebar and detach steps, or after. Either is fine, but don't break the existing assertions.

#### 4. Manual test steps (Sandeep)
1. `npm run check` passes (includes the new unit tests). Optionally `npm run test:electron:browser-features`.
2. `npm start`. In the **address bar** type each and press Enter:
   - `example.com:8080`: tries to open `https://example.com:8080/` (it will time out or fail to connect; that's fine, it must not search or show the "http and https" error).
   - `localhost:3000` (with nothing running: connection error page, not a search). `127.0.0.1:8080` with SearXNG running: the SearXNG page opens.
   - `https://wikipedia.org`: opens.
   - `Python: list comprehension` and `Note:buy milk`: open Sovereign Search with that text.
   - `3.11.2`: searches. `javascript:alert(1)` and `file:///etc/passwd`: the "only opens http and https" error.
3. Open a **New Tab**. In its search box, with **Search** selected, type `127.0.0.1:8080` and press Enter: the page opens in this tab, and Search does not open. Repeat with `https://example.com` and with **Ask AI** selected: it opens the page, and Ask AI does not start.
4. In the New Tab box type `Python: list comprehension`: Sovereign Search opens with that query. Open the Privacy Receipt after any of the URL cases in step 3: there is no SearXNG `search` entry for them.
5. Attach a TXT file on the New Tab and type `example.com`: this is still an Ask AI handoff with the attachment (an address plus an attachment is a question about the file).

**Known limit:** without a public-suffix list, a host-like word with an alphabetic last label (for example `node.js`) still opens as a URL, as it does today. Type `?node.js` to search.

### CHANGES (Codex)

Implemented the PLAN, tests first:
- Added `tests/address-input.test.js` with every required table case, exact result shapes, URL-never-search assertions, host exclusions, all listed blocked schemes, and invalid IPv4 coverage. Added the module syntax check and unit test to `package.json`.
- Extended `tests/electron/browser-features.test.js` after the existing sidebar/detach checks: submit a scheme-less local address through New Tab, wait for direct navigation, and assert no Search tab exists.
- Added pure CommonJS `src/address-input.js`, moving the existing normalization helpers and implementing the ordered classification rules and host matcher. The only change to `normalizeAddress` is the planned bracketed IPv6 HTTP default.
- Updated `src/main.js` to import the helpers and route opted-in New Tab address submissions through `navigateActive`, including internal pages and blocked-address errors.
- Updated `src/newtab.js` to set `navigateIfAddress: true` only without attachments. Attachment handoff payloads remain unchanged.

Validation:
- Tests were written before implementation. `npm run check` initially failed because `src/address-input.js` did not yet exist.
- After implementation, `npm run check` passed, including the new unit tests and Electron test syntax check.
- Attempted `npm run test:electron:browser-features`; Electron exited with signal `SIGABRT` at startup, before test output. Runtime integration and visual checks remain unverified in this environment.
- No new request mechanism or cloud AI calls were added; typed addresses use existing navigation and receipt handling. Preserved the pre-existing CSS and handoff edits, and did not change renderer.js, search.js, PLAN, or REVIEW. No commit was made.

Manual testing: follow PLAN §4. In the address bar verify domains with ports and local/IPv6 hosts navigate, colon phrases and `3.11.2` search, `?node.js` forces search, and blocked schemes show errors. In New Tab, verify a local address and HTTPS URL navigate in both Search and Ask AI modes, with no SearXNG search entry in the Privacy Receipt. Verify an attachment plus `example.com` still opens an Ask AI handoff. Run `npm run test:electron:browser-features` in a working Electron session.

### REVIEW (Claude)
Reviewed 2026-11-09. Read the full diff (`src/main.js`, `src/newtab.js`, `package.json`, `tests/electron/browser-features.test.js`) and the new files `src/address-input.js` and `tests/address-input.test.js`, against the PLAN.

**MUST FIX:** none.

**SHOULD FIX (minor, not blocking):**
- `src/main.js` imports `looksLikeHostAddress` but never uses it. Harmless; drop it from the destructure when next touching the file.
- Rule 6 (known non-web schemes) only applies when the input has no whitespace, as the PLAN said. So `javascript: alert(1)` or `data:text/html, <b>x` with a space would go to the user's own SearXNG as a search. That is the PLAN's choice, not a build error; the risk is low (the text only goes to the local SearXNG and its upstream engines, as any typed search does). Revisit only if it comes up.

**OK:**
- The classifier implements rules 1–9 in the PLAN's order. The moved helpers are byte-for-byte the old ones apart from the planned IPv6 `http` default. Every other caller of `normalizeAddress` / `normalizeInternalUrl` in `main.js` still resolves through the import, and `normalizeSearchQuestion` is still used at three call sites.
- `tests/address-input.test.js` covers every row in the PLAN table (17 URL cases, 13 search cases, 21 blocked-scheme cases, 3 invalid-address errors, 4 empty cases, the internal case, the 300-character slice) and asserts no URL row is classified as `search`. It is wired into `npm run check`.
- New Tab: `navigateIfAddress` is only sent without attachments, and main.js only acts on it when `handoffId` is empty, so the attachment handoff is unchanged. Blocked schemes typed on the New Tab show the address-bar error rather than searching.
- `npm run test:electron:browser-features` **passed** when I ran it outside the sandbox (Codex's sandboxed run aborted at startup). The new step typed `127.0.0.1:<port>/home-typed` into the New Tab box, the page opened, and no `sovereign://search` tab was created.
- No new network requests: the typed address uses the existing navigation path. `npm run check` passed (exit 0).

## Task: Receipt: image redirects and late thumbnails
Status: done (reviewed 2026-11-09), with a QUESTION FOR SANDEEP below

Priority P2, privacy. Feature test pass fix list #6 and #7 (section 9; image-retrieval REVIEW item 4). Branch: `phase-0/chat-layout` (batch of P2 fixes).

### PLAN (Claude)

#### 1. Root cause
- **Preflight redirects.** `preflightDownloadUrl` (`src/main.js` ~line 2047) calls `fetchForDownloadPreflight` with `redirect: 'follow'`. `privacyReceipts.fetchWithReceipt` logs only the URL it was given. Chromium then follows every redirect hop, but no hop is logged. The webRequest hook sees each hop, but a `session.fetch` request has no `webContentsId` or initiator, so `classifyPrivacyRequest` returns `debug-skip` and it is dropped. Result: when an image URL (e.g. Wikimedia `Special:FilePath`) redirects to another host, that host is contacted but missing from the receipt. The same applies to the GET range fallback and to `media:download`.
- **Manual redirects are not an option.** I probed Electron 38 on 2026-11-09 (scratchpad script, local server, 302 to another host). `net.fetch` and `session.fetch` with `redirect: 'manual'` **reject with "Redirect was cancelled"** for both GET and HEAD, with or without webRequest listeners. They do not return the 3xx response. So `preflightDownloadUrl` must keep `redirect: 'follow'`. The same probe showed `webRequest.onBeforeRedirect` fires for every hop with `details.url` (from) and `details.redirectURL` (to), for both `session.fetch` and `<img>` loads.
- **Late thumbnails.** Thumbnail `<img>` loads from the Ask/Search page go through `recordPrivacyWebRequest`. That function attributes a request to `activeReceiptId`, the receipt most recently started in that tab (`activePrivacyReceiptsByWebContentsId`). Thumbnails use `loading='lazy'` (`src/ask.js` ~line 623), and `renderThread()` re-creates every `<img>` on each render. So a thumbnail from an older image answer that loads after the user starts a new question (on scroll, or on re-render without a cache hit) is logged in the **new** question's receipt. The probe showed `<img>` redirect hops each reach `onBeforeRequest`, so they are already listed, but also in whatever receipt is active then.

#### 2. Changes

**A. Pure tracker in `src/privacy-attribution.js`** (unit-testable, no Electron). Add and export `createUrlReceiptTracker({ maxEntries = 500 } = {})` returning:
- `remember(key, receiptId)`: store `key → receiptId`. Keys are strings built by the caller. If the map exceeds `maxEntries`, drop the oldest entries (Map insertion order; re-setting a key moves it to the end).
- `lookup(key)`: the receipt id or `''`.
- `forget(key)`.
- `follow(fromKey, toKey)`: if `fromKey` is known, remember `toKey` with the same receipt id and return that id; otherwise return `''`.
Also export `urlKey(url, scope = '')`, which returns `${scope} ${new URL(url).href}`, or `''` for an invalid URL or a non-http(s) URL. Normalising with `URL.href` matters because Chromium reports normalised URLs.

**B. Preflight redirect hops (`src/main.js`)**
1. Module-level `const preflightRedirects = createUrlReceiptTracker()` and a `Map` `preflightRedirectDetails` of `receiptId → { whatWasSent }`, or store an object instead of a bare id; either is fine as long as the tracker stays pure.
2. In `fetchForDownloadPreflight`, when `receiptDetails?.receiptId` is set: before the fetch, `remember(urlKey(url, 'preflight'), receiptId)` and keep the details. After the fetch settles (`finally`), `forget` every key registered for this call, including the followed ones. A small per-call `Set` of keys is enough.
3. In `setupAiNetworkMonitor`, add `session.defaultSession.webRequest.onBeforeRedirect(details => recordPrivacyRedirect(details))`. No other code registers `onBeforeRedirect` (checked).
4. `recordPrivacyRedirect(details)`:
   - **Preflight:** if `!details.webContentsId`, compute `receiptId = preflightRedirects.follow(urlKey(details.url,'preflight'), urlKey(details.redirectURL,'preflight'))`. If it is set, `privacyReceipts.addEntry(receiptId, { category: 'image', method: details.method || 'GET', url: details.redirectURL, whatWasSent: 'media validation redirect from <from-host> – no query, prompt, or AI output sent' })`. Use the stored `whatWasSent` base when available. Add the new key to the per-call set so it is forgotten later.
   - **Thumbnails:** if `details.webContentsId`, call `thumbnailReceipts.follow(urlKey(details.url, String(details.webContentsId)), urlKey(details.redirectURL, String(details.webContentsId)))`. No entry is added here, because the next `onBeforeRequest` for the hop logs it (see C).
   - Must never throw. Wrap the body in try/catch and log with `logAi`.
5. Only the receipt-backed path is tracked. `downloads:download-url` (no receipt) is unchanged. Keep `validatePublicSourceUrl` on the final URL in `preflightMediaUrl` as it is today.

**C. Late thumbnails go to the receipt that showed them (`src/main.js`, `src/ask.js`)**
1. Module-level `const thumbnailReceipts = createUrlReceiptTracker({ maxEntries: 1000 })`.
2. `search:media` handler: after results are available (**both** the fixture branch and the real branch), for each result with a `thumbnailUrl`, `thumbnailReceipts.remember(urlKey(item.thumbnailUrl, String(event.sender.id)), receipt.id)`.
3. `privacy:start-activity` with `purpose === 'saved-chat-media'`: accept an optional `thumbnailUrls` array from the request. Take at most 200 strings, http(s) only (urlKey returns `''` otherwise), and remember each against the new receipt for `event.sender.id`. In `src/ask.js` (saved-chat restore, ~line 1724), pass `thumbnailUrls` = every `item.thumbnailUrl` of the restored messages' `mediaResults`.
4. In `recordPrivacyWebRequest`, after `classifyPrivacyRequest` returns `action: 'receipt'` or `'background'` and the request has a `webContentsId`: if `thumbnailReceipts.lookup(urlKey(details.url, String(details.webContentsId)))` returns an id **and** `privacyReceipts.getReceipt(id)` exists, use that id and `addEntry` to it instead of the active or background receipt. Otherwise keep today's behaviour. Web-tab requests are already `ignore`d before this point, so a website can't use this.
5. `src/ask.js` ~line 623: change `image.loading = 'lazy'` to `image.loading = 'eager'`, so thumbnails load while their receipt is still the active one (fix list #7).
6. The key is scoped by the Ask/Search tab's `webContents.id`, so the same thumbnail URL in two tabs keeps each tab's own receipt.

**No new network requests.** This only labels requests that already happen. The `whatWasSent` text says what was sent (a validation request), with no cookies or bodies logged.

#### 3. Tests (write first)
- **`tests/privacy-attribution.test.js`** (extend; already in `npm run check`):
  - `urlKey`: normalises (`HTTPS://A.example/x` and `https://a.example/x` give the same key), scopes differ, and `data:`/`blob:`/invalid input give `''`.
  - Tracker: remember/lookup/forget. `follow` chains A→B→C, and all three return the same receipt. `follow` from an unknown key returns `''` and remembers nothing. Eviction at `maxEntries` drops the oldest key.
- **Electron test**, extending `tests/electron/media-chat.test.js` or a new `tests/electron/receipt-redirects.test.js` (add it to `check:tests` and a `test:electron:receipt-redirects` script if new). Run a local HTTP server on `127.0.0.1` that answers `/redirect.png` with a 302 to `http://localhost:<port>/final.png`, served as `image/png`. In an Ask tab, call `window.sovereign.privacy.startActivity({ requestId: 'r1', type: 'ask', query: 'x' })`, then `window.sovereign.media.preflight({ url: 'http://127.0.0.1:<port>/redirect.png', type: 'images' })` (check the real preload names). Assert receipt `r1` contains entries for **both** hosts `127.0.0.1` and `localhost`.
  - Note: `validatePublicSourceUrl` rejects loopback. If there is no existing test hook that allows local hosts for media preflight (check `MEDIA_TEST_FIXTURES` and `src/test-hooks.js`), call `fetchForDownloadPreflight`/`preflightDownloadUrl` through an existing test seam, or skip the Electron part and say so in CHANGES. **Do not** weaken `validatePublicSourceUrl` for tests, and do not add a new env-var bypass that works in packaged builds.
  - Late thumbnail (if practical): register a thumbnail for receipt A via a fixture media search, start receipt B, then append an `<img>` with that thumbnail URL (served by the local server) to the page. Assert the request is in A, not B. If it isn't practical, cover it with the unit tests plus manual step 4 below, and say so in CHANGES.

#### 4. Manual test steps (Sandeep)
1. `npm run check` passes.
2. `npm start` with SearXNG running. In Ask AI, turn on **Search the web** and ask `show me pictures of the Eiffel Tower`. When the cards appear, open the Privacy Receipt for that question.
3. Find a result whose original URL redirects (Wikimedia `commons.wikimedia.org/wiki/Special:FilePath/...` redirects to `upload.wikimedia.org`). Click **Download** on it. The receipt must list `commons.wikimedia.org` **and** `upload.wikimedia.org`, the second labelled "media validation redirect from commons.wikimedia.org". Compare with DevTools (View → Toggle Developer Tools on the Ask page, Network tab): every host there should appear in the receipt.
4. Late thumbnails: ask an image question, then **immediately** (before every thumbnail has loaded, ideally on a slow network) ask a plain text question. Open the receipt history dropdown. Thumbnail hosts (`image` rows) must be in the image question's receipt, and the text question's receipt must have none.
5. Turn chat saving on, save a chat with image results, restart, reopen it from Saved chats. The "Saved chat image previews" receipt lists the thumbnail hosts. Then ask a new question: no thumbnail rows move into it.

### CHANGES (Codex)

Implemented the PLAN, tests first:
- `tests/privacy-attribution.test.js`: added URL normalization/scope/scheme cases, tracker lookup/forget, redirect chains, unknown-source behavior, eviction and re-insertion order, and independent thumbnail ownership across tabs.
- `src/privacy-attribution.js`: added the bounded pure URL receipt tracker and normalized HTTP(S) keys.
- `src/main.js`: tracks receipt-backed validation redirect hops through onBeforeRedirect, labels each destination using the stored validation purpose and source host, and cleans up each call's keys in finally. Thumbnail ownership is registered in both media search branches and saved-chat activity, propagated through redirects, and preferred over the active/background receipt when the owning receipt still exists.
- `src/ask.js`: uses eager thumbnail loading and passes restored thumbnail URLs before rendering a saved chat.
- `src/privacy-receipt.js`: exported the existing getReceipt helper, required by the PLAN's receipt-existence check (it was previously private).

Validation:
- Wrote tests before implementation; the first `npm run check` failed because urlKey was not yet implemented. Full `npm run check` passes after implementation.
- Redirect Electron test skipped as explicitly permitted in PLAN §3: real media preflight rejects loopback; MEDIA_TEST_FIXTURES accepts HTTPS only and bypasses fetching; no existing callable preflight seam is exposed. Public URL validation remains unchanged and no bypass was added.
- Late-thumbnail integration testing remains manual: existing fixture thumbnails are fixed remote URLs, not a local-server fixture. Unit tests cover per-tab ownership and redirect propagation; they do not prove Electron event ordering.
- Attempted existing `npm run test:electron:media-chat`; Electron aborted at startup with SIGABRT, before assertions ran. Runtime/visual behavior remains unverified here.
- No new network request mechanism or cloud AI calls. Existing unrelated working-tree changes were preserved. No commit or push.

Manual testing: follow PLAN §4. Confirm redirected image validation lists both source and destination hosts with the redirect purpose; immediately follow an image question with a text question and check that late thumbnail rows stay with the image receipt; reopen a saved image chat and verify its previews stay in the saved-chat receipt after another question.


### REVIEW (Claude)
Reviewed 2026-11-09. Read the diff of `src/main.js`, `src/privacy-attribution.js`, `src/privacy-receipt.js`, `src/ask.js` and `tests/privacy-attribution.test.js` against the PLAN, then verified the behaviour at runtime with a scratch Electron probe (not in the repo). The probe loads the real `src/main.js`, maps two fake public hostnames (`img-a.example`, `img-b.example`) to a local server with Chromium's `host-resolver-rules`, and stubs Node's `dns.promises.lookup` *in the probe process only* so `validatePublicSourceUrl` accepts them. No app code was bypassed.

**MUST FIX:** none.

**Runtime results (probe):**
- `media.preflight('http://img-a.example/redir-pre.png')` with a 302 to `img-b.example`: the receipt lists `img-a.example` ("media validation request …") **and** `img-b.example` ("media validation redirect from img-a.example …"). Before this change only `img-a.example` appeared.
- Late thumbnail: registered `http://img-a.example/redir-thumb.png` (which redirects to `img-b.example`) to receipt A through the saved-chat path, started receipt B, then loaded the `<img>`. **Both hops were logged in A, and B stayed empty.**
- So `session.fetch` redirects do arrive in `onBeforeRedirect` with no `webContentsId`, and `<img>` hops carry the tab's id, which is what the code assumes.

**SHOULD FIX (follow-ups, not blocking):**
- **Turn the probe into a permanent Electron test** (`tests/electron/receipt-redirects.test.js`). The `host-resolver-rules` + test-process DNS stub technique avoids any app-side test bypass. Codex skipped the Electron part, as the PLAN permitted, because it had no local-host seam; this is the seam.
- `whatWasSent` for a hop is built with `base.replace('request', 'redirect from <host>')`. This works for the three current strings, but is fragile if the wording changes. A dedicated label would be cleaner.
- **Pre-existing, found during this review: `session.fetch`'s `response.url` does not reflect redirects in Electron 38.** The probe's preflight returned the *original* URL as `finalUrl`. So `preflightMediaUrl`'s second `validatePublicSourceUrl(details.finalUrl)` never checks the redirect target, and a public image URL that redirects to a private-network address passes validation. This gap existed before this task. The new `onBeforeRedirect` hook is the natural place to close it, by validating each hop or cancelling via `onBeforeRequest`. See the question below.
- **Pre-existing, found while planning:** `net.fetch(..., { redirect: 'manual' })` rejects with "Redirect was cancelled" in Electron 38 instead of returning the 3xx. `src/source-reader.js` `fetchPublicPage` relies on manual redirects, so in the real app any source page that redirects (for example `http://` → `https://`) probably fails to read instead of being followed. The unit tests use a fake fetch, so they don't catch it. Worth a hand test: ask a web question whose top source redirects, and check whether it is read.

**QUESTION FOR SANDEEP:** should the two pre-existing redirect problems above (the media preflight's private-network check misses redirect targets; source pages that redirect probably can't be read) become their own tasks? I did not change either here, because both go beyond this task's receipt-only scope, and the safe fix for the first one changes download behaviour.

**OK:**
- The tracker is pure, bounded (500 / 1000 entries) and unit-tested: normalisation, scopes, chains, eviction, and per-tab ownership.
- Thumbnail ownership is registered in both `search:media` branches and in the saved-chat restore path. Renderer-supplied URLs are capped at 200, http(s) only, and scoped to the sender's own webContents, so a page can only relabel requests from itself. Web tabs are still ignored before the override.
- The owning receipt is used only if it still exists (`getReceipt` is now exported); otherwise today's behaviour applies.
- Preflight keys are cleaned up in `finally`, including keys added by redirects, without removing keys still used by a concurrent call.
- `loading='eager'` is set as planned. No new network requests: this only labels requests that already happen. `npm run check` passed (exit 0).

## Task: Single instance and dataset profile
Status: done (reviewed 2026-11-09)

Priority P2, stability. Feature test pass fix list #8 (section 13, known issue 3). Branch: `phase-0/chat-layout` (batch of P2 fixes).

### PLAN (Claude)

#### 1. Root cause
- `src/main.js` never calls `app.requestSingleInstanceLock()`. A second `npm start` (or a double-click while it's running) starts a second full browser on the **same** profile (`~/Library/Application Support/sovereign-browser/`). Two Chromium processes then fight over `WebStorage/QuotaManager`, LevelDB (`Local Storage`, which once held saved chats) and IndexedDB (the cached model). That gives "Could not open the quota database, resetting" and "Failed to delete the database: Database IO error", and risks corrupting storage.
- Dataset collection mode (`SOVEREIGN_DATASET_BATCH`, `runDatasetCollection` ~line 4118) also uses the default profile, so running it while the browser is open is the same two-processes-one-profile problem.
- Electron's single-instance lock is **per userData folder**. Instances with different profiles (every Electron test sets its own `SOVEREIGN_USER_DATA_DIR`, and the dataset profile below) don't block each other, so the lock can always be requested once the path is final.

#### 2. Changes
**A. Dataset profile helpers, `src/dataset-collection.js`** (pure, already unit-tested by `tests/dataset-collection.test.js`). Add and export:
- `datasetUserDataDir(appDataDir)` returns `path.join(appDataDir, 'sovereign-browser-dataset')`.
- `seedDatasetPreferences({ normalPrefsPath, datasetDir, fsImpl = fs })`: if `<datasetDir>/preferences.json` already exists, do nothing and return `false`. Otherwise create `datasetDir` (`recursive`, mode `0o700`). Read `normalPrefsPath` **read-only**. If it parses and has a `search` object, write `{ "search": <that object> }` to `<datasetDir>/preferences.json` (mode `0o600`) and return `true`. A missing or unparseable file means write nothing and return `false`; never throw. Only the `search` section (the SearXNG endpoint) is copied: no chats, bookmarks, session or AI settings. That keeps a user's custom SearXNG endpoint working in dataset mode without sharing any storage.

**B. Profile selection and lock, `src/main.js`**, replacing the block at ~line 231 (`if (process.env.SOVEREIGN_USER_DATA_DIR) …`):
1. If `SOVEREIGN_USER_DATA_DIR` is set, use it (unchanged; this is what tests use, and it wins in dataset mode too).
2. Else, if `datasetBatchEnabled`: `const dir = datasetUserDataDir(app.getPath('appData'))`, call `seedDatasetPreferences({ normalPrefsPath: path.join(app.getPath('userData'), 'preferences.json'), datasetDir: dir })` **before** `setPath` (so `getPath('userData')` is still the normal profile), then `app.setPath('userData', dir)`. Log one line: `Dataset collection uses its own profile: <dir>`.
3. Then, still at top level: `const hasSingleInstanceLock = app.requestSingleInstanceLock();`. If false: `console.log('Sovereign is already running with this profile; focusing the existing window.')` and `app.quit()`.
4. `app.whenReady().then(...)`: first line `if (!hasSingleInstanceLock) return;`, so the second process creates no windows, sessions or model service, and doesn't touch storage. Also guard `finishPendingLegacyChatDelete` and the rest implicitly via that early return. Check that no other top-level code touches storage before `whenReady`. If something does, guard it with the same flag.
5. Add `app.on('second-instance', () => focusExistingWindow())`:
   - In dataset mode: if `datasetWindow` is alive, restore it if minimized, then `show()` and `focus()`.
   - Otherwise pick the most recently created live window state in `windows` (the last entry of the Map with a non-destroyed `state.window`). If minimized, `restore()`, then `show()` and `focus()`. If there is no window (macOS, all windows closed), call `createWindow()`, the same as `activate`.
   - Ignore command-line URLs for now (out of scope).

**No new network requests.** No change to how storage is used apart from the dataset profile location.

#### 3. Tests (write first)
- **`tests/dataset-collection.test.js`** (extend): `datasetUserDataDir('/x/AppSupport')` is `/x/AppSupport/sovereign-browser-dataset`. `seedDatasetPreferences` in a temp dir:
  - (a) normal prefs with `search.endpoint` + `bookmarks` + `ai`: the seeded file has **only** `search`, and its mode is `0o600`;
  - (b) a second call doesn't overwrite an edited dataset file, and returns `false`;
  - (c) a missing normal file returns `false` and doesn't throw;
  - (d) invalid JSON returns `false`.
- **New `tests/electron/single-instance.test.js`**, using the orchestrator pattern from `tests/electron/chat-deletion.test.js` (spawn `process.execPath` with `--phase=…`, `ELECTRON_RUN_AS_NODE` removed):
  - Phase `primary`: set `SOVEREIGN_USER_DATA_DIR` to a temp profile (with the usual test `preferences.json`), `require('../../src/main.js')`, wait for the chrome `index.html` contents. Count `app.on('second-instance')` events and focus calls. Then spawn the `secondary` phase **asynchronously** on the same profile, and wait up to 30 s for it to exit.
  - Assert: the secondary exits with status 0 within the timeout, the primary saw exactly one `second-instance`, and the primary still has exactly one chrome window (`index.html` contents count unchanged).
  - Then also spawn a secondary on a **different** temp profile that quits itself once its chrome window exists, and assert it **did** start: its stdout contains a marker the phase prints after ready. That proves separate profiles aren't blocked.
  - Print a JSON summary with `"ok": true`, then quit.
  - Add `node --check tests/electron/single-instance.test.js` to `check:tests` and a `test:electron:single-instance` script, like the others.
  - Don't add a dataset-mode Electron test (it needs SearXNG). The helpers are unit-tested.

#### 4. Manual test steps (Sandeep)
1. `npm run check` passes. `npm run test:electron:single-instance` passes (run outside the sandbox).
2. Quit every Sovereign window (Cmd+Q). Check Activity Monitor shows no Sovereign/Electron left, then `npm start`. Note whether the quota/database lines appear. They may still appear **once** if the previous session was force-quit or crashed; that is Chromium repairing itself.
3. With Sovereign running, run `npm start` again in a second terminal. The second command prints "Sovereign is already running…" and exits within a few seconds. The existing window comes to the front (un-minimize it first to check restore). No second window, and no quota/database errors in either terminal.
4. Minimize the window, run `npm start` again: the window is restored. On macOS, close all windows (app still in the Dock) and run `npm start` again: one new window opens.
5. Dataset mode: with the browser still open, run `SOVEREIGN_DATASET_BATCH=<questions file> npm start` (with SearXNG running). It starts (not blocked), prints `Dataset collection uses its own profile: ~/Library/Application Support/sovereign-browser-dataset`, and uses the same SearXNG endpoint as your normal settings. Afterwards your normal browser's saved chats, settings and downloaded model are untouched, and no database errors appear in the browser's terminal.
6. The dataset profile has its own model cache. Dataset mode doesn't use the local model today, so nothing is downloaded there.

### CHANGES (Codex)

Implemented the PLAN, tests first:
- `tests/dataset-collection.test.js`: added dataset path, search-only seeding, file/directory permissions, preservation of the normal preferences and an edited dataset file, missing/invalid preferences, absent/null search, and filesystem-error cases.
- `tests/electron/single-instance.test.js` (new): asynchronous orchestrator/primary/secondary launches verify same-profile exit status, one second-instance event, one focus call, unchanged chrome count, and successful startup on a different profile. Child launches have timeouts and remove ELECTRON_RUN_AS_NODE.
- `package.json`: registered the Electron test's syntax check and `test:electron:single-instance` command.
- `src/dataset-collection.js`: added/exported datasetUserDataDir and non-throwing seedDatasetPreferences. Only search settings are copied, with private permissions and exclusive creation to avoid overwriting an existing file.
- `src/main.js`: explicit profile overrides retain precedence; dataset mode otherwise seeds and selects its separate profile before acquiring the per-profile single-instance lock. A rejected launch quits and skips ready initialization. Second launches restore/show/focus the latest live browser window (or dataset window); a browser with no windows creates one. Audited top-level initialization for storage access; also guarded the before-quit session saver so a rejected instance cannot write preferences during shutdown.

Validation:
- Tests were written before implementation. Initial `npm run check` failed with `datasetUserDataDir is not a function`, as expected. Full `npm run check` passes after implementation, including the new Electron test's syntax check.
- Attempted `npm run test:electron:single-instance`; Electron aborted at startup with SIGABRT before assertions ran. Runtime lock/focus behavior is not verified in this sandbox; run this command outside the sandbox as specified in PLAN §4.
- No dataset-mode Electron test, as specified by the PLAN. No new network requests or cloud AI calls. Existing unrelated edits preserved. No commit or push.

Manual testing: follow PLAN §4: run the Electron test outside the sandbox; launch twice on the normal profile and verify the second exits while the existing window focuses/restores; close all macOS windows and relaunch to verify one opens; run dataset collection alongside the browser and verify the separate profile log and copied SearXNG endpoint, with normal chats/settings/model storage untouched.

### REVIEW (Claude)
Reviewed 2026-11-09. Read the diff of `src/main.js`, `src/dataset-collection.js`, `tests/dataset-collection.test.js`, `package.json` and the new `tests/electron/single-instance.test.js` against the PLAN.

**MUST FIX:** none.

**SHOULD FIX (minor):**
- `console.log('Sovereign is already running …')` goes to the terminal only. A double-click launch of a packaged build shows nothing, but the existing window comes to the front, which is the standard macOS behaviour. Fine as is.
- The PLAN's expected outcome ("stops the quota/database errors") can only be confirmed by hand. A force-quit or crash can still make Chromium repair its quota database once on the next start. That is expected, and the manual steps say so.

**OK:**
- Order is right: the `SOVEREIGN_USER_DATA_DIR` override, then the dataset profile (seeded **before** `setPath`, so it reads the normal profile's `preferences.json`), then `requestSingleInstanceLock()` on the final path. `app.setName('Sovereign')` runs later in `whenReady`, and userData is already fixed by then, so the normal profile stays `sovereign-browser/`.
- A rejected instance returns early from `whenReady`, and `before-quit` is also guarded. Without that guard, the rejected instance's `saveOpenSessionNow()` could overwrite the running instance's saved session with an empty one. Codex caught this beyond the PLAN, and it's correct.
- `focusExistingWindow` restores, shows and focuses the newest live window, creates one if all are closed (macOS), and focuses the dataset window in dataset mode.
- `seedDatasetPreferences` copies only `search`, uses `0o600` / `0o700` and exclusive create (`wx`), never throws, and never writes to the normal profile. The unit tests cover all four PLAN cases plus a filesystem error.
- **`npm run test:electron:single-instance` passed** when I ran it outside the sandbox: `{"ok":true,"secondInstances":1,"focusCalls":1,"chromeWindows":1,"differentProfileStarted":true}`.
- No new network requests. `npm run check` passed.

## Task: Docs: automatic source reading
Status: done (reviewed 2026-11-09)

Priority P3, docs. Feature test pass fix list #14 (section 6). Docs only. Branch: `phase-0/chat-layout` (batch of P2 fixes).

### PLAN (Claude)

#### 1. Root cause
Sandeep decided on 2026-11-05 that there is no "Read sources for a fuller answer" button. With **Search the web** on, Ask AI automatically reads up to the top 3 source pages (`src/source-reader.js`: at most 3 pages, 10 s timeout, 1.25 MB cap per page) and answers from them. Each page fetch is listed in the Privacy Receipt as a `source-page` entry. Two docs still describe the button. A search of every `*.md` outside `node_modules` and `docs/HANDOFF.md`, plus `src/*.html` and `src/*.js`, found exactly two places:
- `README.md` line 132, table row `| Read more source material | Use **Read sources for a fuller answer**, where available |`
- `docs/privacy-audit.md` line 50, step `3. Use **Read sources for a fuller answer**.` in section 4 "Run a Small Test Script Manually".
The receipt label `Read sources` in `src/main.js` names the activity, not a button, so it stays (fix list #13).

#### 2. Changes (docs only, change only these lines)
1. `README.md` line 132: replace the row with
   `| Read more source material | Turn on **Search the web** in Ask AI. Sovereign automatically reads up to the top 3 source pages and answers from them; each page appears in the Privacy Receipt as a ` + "`source-page`" + ` entry |`
   Keep the table's two-column format.
2. `docs/privacy-audit.md` section 4, the numbered list (lines ~48–51):
   - Step 2 becomes: `2. Run one Ask AI question with **Search the web** enabled. Sovereign reads the top 3 source pages automatically; there is no separate button.`
   - Delete step 3 (`Use **Read sources for a fuller answer**.`).
   - Renumber the image step from 4 to 3.
3. Check the rest of `docs/privacy-audit.md` for anything that relied on the old step 3 (for example "source pages from step 3", or an expected-hosts list). Section 7 currently doesn't mention source pages. If you find a reference, point it at step 2. If there is none, change nothing else.
4. Don't touch `docs/HANDOFF.md` history, code, or any other file.

#### 3. Tests
No code change. `npm run check` must still pass. Afterwards, `grep -rn "fuller answer" README.md docs/privacy-audit.md` returns nothing.

#### 4. Manual test steps (Sandeep)
1. Read the README "Using Sovereign" table and `docs/privacy-audit.md` section 4. They describe automatic reading, the list is numbered 1–3, and nothing mentions a button.
2. Optional sanity check of the claim: with SearXNG running, ask an Ask AI question with **Search the web** on, and open the receipt. Up to 3 `source-page` entries appear, with no button pressed.

### CHANGES (Codex)

Implemented the docs-only PLAN:
- `README.md`: replaced the obsolete button instruction with the exact planned automatic-reading wording, preserving the two-column table and documenting `source-page` receipt entries.
- `docs/privacy-audit.md`: updated step 2, removed the button step, and renumbered the image step to 3. Checked the rest of the guide; no references depended on the removed step, so no other changes were needed.

Validation:
- Tests first: ran the obsolete-wording absence check before editing; it failed as expected on both old passages. After editing, the same check passed with no matches for `fuller answer` in either file.
- `npm run check` passed. No code or test files changed; existing unrelated edits were preserved. No commit or push.

Manual testing: read the README “Using Sovereign” table and audit section 4; confirm automatic reading and numbering 1–3. Optionally ask a web-enabled question with SearXNG running and confirm up to 3 `source-page` receipt entries without pressing a separate button. This optional runtime check was not performed.

### REVIEW (Claude)
Reviewed 2026-11-09. Read the diff of `README.md` and `docs/privacy-audit.md`.

**MUST FIX:** none.

**SHOULD FIX:** none. (Wording nit: the README says "up to the top 3" and the audit says "the top 3". Both are accurate, because fewer pages are read when fewer results exist or a page fails. I left them as the PLAN specified.)

**OK:** Only the two planned lines changed. The audit list is renumbered 1–3, and section 7 didn't rely on the old step 3. `grep "fuller answer"` on both files returns nothing. No code changed. `npm run check` passed.

## Task: Pending deletion notice
Status: done (reviewed 2026-11-09)

Priority P3, usability. Feature test pass fix list #15 (Saved chat deletion, known limit "Repeated cleanup failure"). Branch: `phase-0/chat-layout` (batch of P2 fixes).

### PLAN (Claude)

#### 1. Root cause
- When removing chats saved by an older version fails, `deleteAllSavedChats` returns `legacyPending: true`, and Ask AI / Settings show a one-off status line: "Chats saved by an older version could not be removed yet; Sovereign will try again the next time it starts." (`LEGACY_DELETE_PENDING_TEXT` in `src/ask.js` ~line 1595, and the same text in `src/settings.js` ~line 159).
- On the next start, `finishPendingLegacyChatDelete()` (`src/main.js` ~line 4985) retries in the background. If it fails **again**, the result is only logged to the console. `chat-deletions.json` keeps `legacyDeletePending: true`, but no UI ever reads it. `savedChatSnapshot()` doesn't include it, and Settings has no way to ask. So a cleanup that keeps failing is invisible to the user. Deletion still wins (the chats can't come back), so this is a usability/trust problem, not a data leak.

#### 2. Changes
**`src/main.js`**
1. A counter `legacyRemovalsInFlight`, incremented and decremented (in `finally`) around the body of `removeLegacyChatKeySafely()`.
2. `function legacyDeleteNoticeVisible()` returns `chatStore().legacyDeletePending() && legacyRemovalsInFlight === 0`. If `legacyDeletePending()` throws, treat it as `false` and log; never break `chats:list`.
3. `savedChatSnapshot()` adds `legacyPending: legacyDeleteNoticeVisible()`. That way it reaches Ask AI through `chats:list` and the existing `chats:changed` broadcast.
4. `broadcastSavedChats()` also sends `chats:legacy-status` with `{ legacyPending }` (**only** that field, no chat titles) to every live tab whose `kind === 'settings'`.
5. New `ipcMain.handle('chats:legacy-status', event => { chatSenderTab(event, ['ask', 'settings']); return { legacyPending: legacyDeleteNoticeVisible() }; })`.
6. `finishPendingLegacyChatDelete()`: after `removeLegacyChatKeySafely()` resolves (success **or** failure), call `broadcastSavedChats()`, so open pages update when the startup retry finishes. Also call `broadcastSavedChats()` after `removeLegacyChatKeySafely()` in `deleteAllSavedChats` (it already broadcasts before), and in the `chats:legacy-removed` handler after `legacyDeleteDone()`.

**`src/preload.js`**: under `chats`, add `legacyStatus: () => ipcRenderer.invoke('chats:legacy-status')` and `onLegacyStatus(callback)`, using the same listener and unsubscribe pattern as `onChanged`, on channel `chats:legacy-status`.

**`src/ask.html` / `src/ask.js`**
- Add `<p class="legacy-delete-notice" id="legacy-delete-notice" role="status" hidden></p>` as a direct child of `.ask-page`, right after `#chat-history-panel` (before `#chat-thread`). It must not be inside the history panel, because that panel is hidden when saving is off.
- In `applySavedChats(snapshot)`: set the notice's text to the pending message (reuse `LEGACY_DELETE_PENDING_TEXT.trim()`) and `hidden = !snapshot?.legacyPending`.

**`src/settings.html` / `src/settings.js`**
- Add the same `<p class="legacy-delete-notice" id="legacy-delete-notice" role="status" hidden>` directly under the "Save chats on this device" checkbox row.
- On load, call `window.sovereign.chats.legacyStatus()` and render it, and subscribe with `onLegacyStatus`. Render the same text and the same hidden logic. Wrap the load in try/catch; on error, leave it hidden.

**`src/styles.css`**: one small rule `.legacy-delete-notice { margin: 0; padding: 8px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); color: var(--text); font-size: 13px; }` plus `.legacy-delete-notice[hidden] { display: none; }`. Use existing tokens only. In Ask AI it is a direct child of `.ask-page`, so the Task 1 flex rule gives it natural height. No other layout change.

**No new network requests.**

#### 3. Tests (write first)
Extend `tests/electron/chat-deletion.test.js` (orchestrator plus phases). Add two phases, run by the orchestrator **after** the existing `verify` phase on the same profile, so existing assertions are untouched:
1. **`pending-notice`**, with `SOVEREIGN_TEST_LEGACY_REMOVE=fail`. Before `require('../../src/main.js')`, read `<profile>/chat-deletions.json`, set `legacyDeletePending: true`, and write it back, keeping `deletedIds` and the existing file mode. After `verify`, the legacy localStorage key is already gone. That is deliberate: the Ask page then has nothing to migrate and can't clear the pending flag itself, so the notice must come from main's state. Then start the app, so the startup retry runs and fails because of the test hook. Then:
   - Open **Settings**. `waitFor` `#legacy-delete-notice` to be visible (`!hidden`) with text containing "could not be removed yet".
   - Open **Ask AI**. `waitFor` the same in its `#legacy-delete-notice`.
   - Assert `chat-deletions.json` still has `legacyDeletePending: true`.
2. **`pending-cleared`**, with no test hook. Start the app. The startup retry succeeds (the key is already absent, so `removeItem` and the check succeed). Open Settings and Ask AI, and `waitFor` both notices to be hidden. Assert `chat-deletions.json` has `legacyDeletePending: false`.
After both phases, re-run the existing marker scan (or call the same scan helper), so the extra launches restore nothing.
**Also fix a flaky assertion in the same test (found during Task 4's regression run, 2 failures in 3 runs, unrelated to this batch's product code):** in phase `main`, step 5 (~line 406), `clearStatus` is read with `waitFor(() => …textContent)`, which returns the first **non-empty** status. That is often the stale "Saved chat deleted." from the earlier single delete, because the file disappears before the Clear IPC returns and `setStatus` runs. Change it to wait until the status equals `Deleted ${FRAGMENTS_TEXT}` (with the normal `waitFor` timeout), and keep the same `expect` message if the wait times out (report the last status seen). Change no other existing assertion.

Run `npm run test:electron:chat-deletion` if Electron starts in your environment. If it aborts (SIGABRT in the sandbox), say so in CHANGES; Claude will run it outside the sandbox.

#### 4. Manual test steps (Sandeep)
1. `npm run check` passes. `npm run test:electron:chat-deletion` passes (outside the sandbox).
2. On a disposable profile copy with chats from an older build: `SOVEREIGN_USER_DATA_DIR=/tmp/sov-pending SOVEREIGN_TEST_LEGACY_REMOVE=fail npm start`. In Settings, turn saving off and choose Delete. The status mentions it could not be removed yet.
3. Quit, then start again **with the same fail variable**. Without doing anything, open Settings: a boxed notice under "Save chats on this device" says chats saved by an older version could not be removed yet. Open Ask AI: the same notice appears above the conversation. (Opening Ask AI may itself remove the old data, in which case the notice disappears from both pages within a moment. That's correct: nothing is pending any more.)
4. Quit and start **without** the variable. After a moment the notices are gone in both pages, and `chat-deletions.json` shows `"legacyDeletePending": false`.
5. Normal profile, nothing pending: no notice in either page, and no layout change in Ask AI.

### CHANGES (Codex)

Implemented the PLAN, tests first:
- `tests/electron/chat-deletion.test.js`: added `pending-notice` and `pending-cleared` launches after `verify`, on the same profile. The pending fixture preserves the deletion record's other fields and existing file mode. Both phases check Settings and Ask AI notices and the persisted pending flag; the existing final marker scan runs afterwards. Fixed Clear history's stale-status race by waiting for the exact expected wording, retaining the original failure message and last observed status.
- `src/main.js`: tracks legacy removals in flight with a finally decrement; exposes an exception-safe pending-notice helper in saved-chat snapshots and restricted Ask/Settings status IPC. Settings broadcasts contain only `legacyPending`. Broadcasts now follow startup retries, bulk deletion cleanup, and Ask AI's legacy-removal acknowledgement.
- `src/preload.js`: added `legacyStatus` and `onLegacyStatus` with listener unsubscribe support.
- `src/ask.html`, `src/ask.js`: added the status notice outside the history panel, immediately before the conversation; saved-chat snapshots control its visibility and reuse the existing pending message.
- `src/settings.html`, `src/settings.js`: added the notice below the saving checkbox, initial status loading with error handling, and live status subscription. Reused the same wording for the notice and deletion status.
- `src/styles.css`: added only the planned notice styling and hidden rule using existing tokens.

Validation:
- Wrote the Electron tests before product changes. `npm run check` passed with tests added and again after implementation.
- Attempted `npm run test:electron:chat-deletion` before and after implementation. Both attempts built successfully, then Electron aborted with SIGABRT before any assertions ran. Runtime behavior still needs verification outside this sandbox; no red/green runtime result is claimed.
- `git diff --check` passed. No new network requests or cloud AI calls. Preserved existing unrelated edits. No commit or push.

Manual testing: follow PLAN §4 on a disposable profile: force legacy removal to fail, delete old chats, restart with the failure variable and confirm both notices appear; restart without it and confirm both disappear and the pending flag is false. Also confirm a normal profile shows no notice or Ask AI layout change. Run `npm run test:electron:chat-deletion` outside the sandbox.

### REVIEW (Claude)
Reviewed 2026-11-09. Read the diff of `src/main.js`, `src/preload.js`, `src/ask.html`, `src/ask.js`, `src/settings.html`, `src/settings.js`, `src/styles.css` and `tests/electron/chat-deletion.test.js` against the PLAN.

**MUST FIX:** none.

**SHOULD FIX (minor):**
- `LEGACY_DELETE_PENDING_TEXT` is now defined in both `ask.js` and `settings.js` (Settings' existing inline copy was replaced by the constant). The pages share no module, so this is acceptable; keep the two in sync if the wording changes.
- In the `pending-cleared` phase, the notice starts hidden, so the hidden check alone could pass before the startup retry finishes. The phase also waits for `legacyDeletePending === false` in `chat-deletions.json`, so the phase as a whole still proves the cleanup.

**OK:**
- `savedChatSnapshot()` carries `legacyPending`, which is shown only when pending **and** no removal is in flight. So the notice doesn't flash during the startup retry. Settings tabs receive only `{ legacyPending }`, with no chat titles. The new `chats:legacy-status` IPC is limited to Ask AI and Settings by `chatSenderTab`.
- Broadcasts happen after the startup retry, after the bulk-delete removal, and after `chats:legacy-removed`, so open pages update either way.
- The Ask notice is a direct child of `.ask-page` (natural height under Task 1's flex rule), outside the history panel. The Settings notice sits under the checkbox. Both use `role="status"` and existing colour tokens.
- The flaky Clear-history assertion now waits for the exact expected text.
- **`npm run test:electron:chat-deletion` passed twice in a row** when I ran it outside the sandbox (`"ok": true`), including the new `pending-notice` and `pending-cleared` phases and the final marker scan. Before the fix, the same test failed 2 of 3 runs on the stale status.
- No new network requests. `npm run check` passed.

## Batch summary (P2 fixes batch, phase-0/chat-layout)
Batch of P2 fixes on `phase-0/chat-layout`, run 2026-11-09. Claude planned and reviewed every task, Codex built every task, and Claude ran all the Electron tests outside the sandbox. Nothing was committed.

| # | Task | Status | Built by | Files changed |
|---|---|---|---|---|
| 1 | Chat layout overlap | DONE | Codex (before this run) | `src/styles.css` |
| 2 | Address bar input | DONE | Codex | `src/address-input.js` (new), `src/main.js`, `src/newtab.js`, `package.json`, `tests/address-input.test.js` (new), `tests/electron/browser-features.test.js` |
| 3 | Receipt: image redirects and late thumbnails | DONE (2 pre-existing issues raised as a question) | Codex | `src/privacy-attribution.js`, `src/privacy-receipt.js`, `src/main.js`, `src/ask.js`, `tests/privacy-attribution.test.js` |
| 4 | Single instance and dataset profile | DONE | Codex | `src/main.js`, `src/dataset-collection.js`, `package.json`, `tests/dataset-collection.test.js`, `tests/electron/single-instance.test.js` (new) |
| 5 | Docs: automatic source reading | DONE | Codex | `README.md`, `docs/privacy-audit.md` |
| 6 | Pending deletion notice | DONE | Codex | `src/main.js`, `src/preload.js`, `src/ask.html`, `src/ask.js`, `src/settings.html`, `src/settings.js`, `src/styles.css`, `tests/electron/chat-deletion.test.js` |

**Test results (final):**
- `npm run check`: exit 0. It includes the new `tests/address-input.test.js` and the extended privacy-attribution and dataset-collection unit tests.
- Electron, run outside the sandbox (Codex's sandbox aborts Electron with SIGABRT): `browser-features`, `single-instance`, `chat-deletion` (passed twice), `media-chat`, `ui-smoke`, `permissions`, `stage1-usability` and `home-attachments` all passed.
- Scratch probes, not in the repo: the Ask AI layout at 3 window sizes × 3 panel states (no overlap), and receipt redirect/thumbnail attribution against a local server (both hosts listed; late thumbnail kept in its own receipt).

**Open questions for Sandeep:**
1. (Task 3) Two **pre-existing** redirect problems were found. Should they become their own tasks? (a) In Electron 38, `session.fetch` doesn't update `response.url` after a redirect, so the media preflight's "final URL must be public" check never sees the redirect target; a public image URL that redirects to a private address passes. (b) `net.fetch(..., { redirect: 'manual' })` rejects ("Redirect was cancelled") instead of returning the 3xx, so `source-reader.js` probably can't read any source page that redirects.
2. (Task 1, follow-up) In short windows, the bottom stack (controls + attachment drop zone + composer) takes about 300px. Should the drop zone collapse to one line until it's used?

**Answered (Sandeep, 2026-11-09):** Q1 yes, now fix list #16 "Safe redirect handling" (P1, high priority). Q2 yes, now fix list #17 "Compact drop zone" (P3). No code was changed for either yet.

**Manual tests to run in the app:** see the "Manual tests" list in the chat summary for this batch, which is the same as each task's PLAN §4. In short: (1) long chat, receipt open, image cards, and 3 window sizes; (2) address bar and New Tab inputs; (3) the Wikimedia redirect download and a fast image→text question; (4) a second `npm start`, minimise/restore, and dataset mode alongside the browser; (5) read the README table and the audit steps; (6) the pending notice with `SOVEREIGN_TEST_LEGACY_REMOVE=fail` on a disposable profile.

## Task: Safe redirect handling
Status: DONE (reviewed 2026-11-09; built by Codex). Branch: `phase-0/safe-redirects`. Fix-list #16 (P1, security).

### PLAN (Claude)

#### 1. What is wrong today (verified)
- **Source reading** (`src/source-reader.js` `fetchPublicPage`, lines 622–689) loops over redirects with `fetchImpl(url, { redirect: 'manual' })`. In `main.js`, `fetchImpl` is `net.fetch` (`makeReceiptFetch`, line 924). In Electron 38, `net.fetch` with `redirect: 'manual'` **rejects** with "Redirect was cancelled" instead of returning the 3xx response. So every source page that redirects (`http`→`https`, `example.com`→`www.example.com`) fails and falls back to the snippet.
- **Media validation** (`preflightMediaUrl`, `main.js` lines 2204–2216) checks the first URL, then calls `session.fetch(..., { redirect: 'follow' })`, then checks `response.url`. Electron does not update `response.url` after redirects, so **the redirect target is never checked**. A public image URL that 302s to `http://127.0.0.1/…` or `http://169.254.169.254/…` passes, and the request to the private address has already been sent (SSRF).
- **Media download** (`media:download`, line 4743) calls `downloadURL(checked.url)` after the preflight. Chromium fetches the URL again and follows any redirects itself, and that second fetch is not checked at all.
- **Address checks are incomplete** (`isPrivateIpv4` and `isPrivateIpv6`, lines 86–113):
  - IPv6: `fe80:` is matched only literally, so `fe90::`–`febf::` slip through. Multicast `ff00::/8` and NAT64 `64:ff9b::/96` are not blocked. IPv4-mapped addresses are matched only as dotted text (`::ffff:127.`). `new URL('http://[::ffff:127.0.0.1]/').hostname` is `[::ffff:7f00:1]` (checked), so **the mapped form bypasses the check today**. Mapped `172.16/12`, `169.254/16` and `100.64/10` are also missed.
  - IPv4 misses the reserved ranges `192.0.0.0/24` and `198.18.0.0/15`.
- **DNS rebinding:** `validatePublicSourceUrl` resolves the host. Then `fetch` resolves it again on its own, and the second answer can be private.

#### 2. Design: one small Node module that fetches with redirects and DNS pinned
New file **`src/safe-fetch.js`**, plain Node with no Electron imports, so it is unit-testable under `npm run check`. Source reading and media validation both use it. It uses Node's `http`/`https` (Electron main has them), **not** `net.fetch`, because only Node lets us:
- (a) see each 3xx response, and
- (b) choose the IP address the socket connects to.

Exports:
1. **`isBlockedAddress(ip)`** returns true for any address that must never be contacted. Parse the address to bytes; do not use string prefixes.
   - **IPv4:**
     - `0.0.0.0/8` (unspecified)
     - `10/8`
     - `100.64/10` (CGNAT)
     - `127/8`
     - `169.254/16` (link-local, cloud metadata)
     - `172.16/12`
     - `192.0.0.0/24`
     - `192.0.2.0/24`
     - `192.168/16`
     - `198.18/15`
     - `198.51.100/24`
     - `203.0.113/24`
     - `224/4` (multicast)
     - `240/4` (reserved, including `255.255.255.255`)
   - **IPv6:**
     - `::/128`
     - `::1/128`
     - `::/96` (IPv4-compatible; this also covers `::` and `::1`)
     - `::ffff:0:0/96` (IPv4-mapped): check the embedded IPv4 against the IPv4 list, and accept both `::ffff:127.0.0.1` and `::ffff:7f00:1`
     - `64:ff9b::/96` (NAT64): check the embedded IPv4
     - `2002::/16` (6to4): check the embedded IPv4 from bits 16–47
     - `fc00::/7` (unique local)
     - `fe80::/10` (link-local)
     - `fec0::/10` (old site-local)
     - `ff00::/8` (multicast)
     - `100::/64` (discard)
     - `2001:db8::/32` (documentation)
     - Any address with a zone id (`%…`) is blocked.
   - Anything that doesn't parse as an IP returns `true` (fail closed).
2. **`checkHopUrl(url, { previousUrl })`** throws a clear `Error` (`err.code = 'UNSAFE_URL'`) unless all of these hold:
   - The protocol is `http:` or `https:`. Otherwise: "Only http and https links can be followed."
   - The URL has no username or password.
   - It is not a downgrade from `https` to `http`. Otherwise: "Blocked a redirect from HTTPS to HTTP."
   - The hostname is not `localhost` or `*.localhost`.
   - If the hostname is an IP literal (strip `[]`), it is not blocked by `isBlockedAddress`. Otherwise: "Blocked a link to a local or private-network address."
   - Always parse with `new URL()`. That normalises `2130706433`, `0x7f.1` and similar forms to dotted IPv4 before the check.
3. **`resolvePublicAddresses(hostname, resolve)`** does the following:
   - For an IP literal, it returns that address. It has already been checked by `checkHopUrl`.
   - Otherwise it calls `resolve(hostname, { all: true })`. The default is `dns.promises.lookup`.
   - It throws if there are no records. It throws if **any** record is blocked, with the message "Blocked: <host> resolves to a local or private-network address."
   - It returns the records `{ address, family }`. A record may carry an extra `connect` field; see §5.
4. **`safeFetch(url, options)`** fetches a URL and follows redirects manually. It returns `{ response, finalUrl, chain }`.
   - **Options:**
     - `method` (default `GET`)
     - `headers`
     - `signal`
     - `timeoutMs` (default 12000)
     - `maxRedirects` (default **5**)
     - `resolve`
     - `ca` (optional extra trusted CA; tests only)
     - `onHop`
     - `transport` (for unit tests)
   - **Per hop**, for `hop = 0 … maxRedirects`:
     1. `checkHopUrl(current, { previousUrl })`.
     2. `records = await resolvePublicAddresses(host, resolve)`.
     3. `onHop({ url, host, index: hop, fromHost })`. `fromHost` is empty for hop 0. Call it **only after** the checks pass, so a blocked host is never listed as contacted.
     4. Send the request with `http.request` or `https.request`:
        - `lookup` is **pinned** to `records`. It answers from `records` and never resolves again. It honours `options.all`, and uses `record.connect || record.address`.
        - `agent: false`, so no reused sockets.
        - `servername` stays as the hostname, so TLS still verifies the real certificate.
        - Pass `signal`, plus `ca` when given.
        - Send no cookies. Send only the headers given, plus `accept-encoding: gzip, deflate, br`.
     5. If the status is 301, 302, 303, 307 or 308 with a `Location` header: destroy the response body, set `previousUrl = current`, and set `current = new URL(location, current)`. After 303, or after 301/302 on a POST, switch to `GET` (we only send GET and HEAD, so in practice the method stays). Continue. A 3xx with no `Location` is an error.
     6. Otherwise, build a WHATWG `Response`:
        - `body` is `null` for `HEAD`, 204 and 304.
        - Otherwise the body is `Readable.toWeb(stream)`, where the stream is first passed through `zlib` gunzip, inflate or brotli according to `content-encoding`.
        - Copy `status`, `statusText` and the headers.
        - Return `{ response, finalUrl: current, chain }`.
   - If the loop ends while still redirecting, throw "Stopped after 5 redirects." This makes 6 hops the error, while 5 redirects (6 requests in total) are allowed.
   - **Timeout:** one `AbortController` for the whole chain, combined with the caller's `signal`. An abort rejects with `name === 'AbortError'`.
   - **`transport`** (unit tests only): `transport({ url, method, headers, lookup, ca, signal })`. It resolves to `{ status, headers, body /* Readable or null */ }`. The default transport is the `http`/`https` code above.

#### 3. Wiring
- **`src/source-reader.js`:**
  - Remove its own `isPrivateIpv4`, `isPrivateIpv6` and `isBlockedHostname`.
  - Re-implement `validatePublicSourceUrl(value, resolve)` as `checkHopUrl` + `resolvePublicAddresses`. Keep the exported name and keep the hash stripping.
  - `fetchPublicPage(url, { fetchImpl, signal, timeoutMs, resolveHostname, onHop })`:
    - Calls `safeFetch(url, { method: 'GET', headers: SOURCE_HEADERS, signal, timeoutMs, resolve: resolveHostname, onHop })`, or `fetchImpl` if one is given. The `fetchImpl` contract is now the same as `safeFetch`: it handles redirects and returns `{ response, finalUrl }`.
    - Then applies the existing `response.ok`, content-type and `readLimitedResponseText` checks.
    - Delete the old manual loop.
  - Thread `onHop` (and `fetchImpl`) through `readOneSource` and `readSourcePages`.
- **`src/main.js`, source reading** (`handleReadSources`, about line 4819):
  - Pass `fetchImpl: (url, opts) => safeFetch(url, { ...opts, resolve: safeFetchResolve, ca: testCa, onHop: hop => privacyReceipts.addEntry(receipt.id, …) })`.
  - Hop 0 `whatWasSent` is `'page fetch – no query or AI output sent'`. Later hops use `'page fetch – no query or AI output sent (redirect from <fromHost>)'`.
  - Category `source-page`, method `GET`, `url: hop.url`.
  - Stop using `makeReceiptFetch` here. Keep the function if other callers use it, and delete it if this was the last caller.
- **`src/main.js`, media validation:**
  - `preflightMediaUrl(url, mediaType, receiptDetails)` does `safeFetch(url, { method: 'HEAD', … })`. On 405 or 501, it falls back to `GET` with `Range: bytes=0-0`, and cancels the body straight away.
  - Each hop gets a receipt entry: category `image`, with `receiptDetails.whatWasSent` for hop 0 and `… (redirect from <fromHost>)` after that.
  - If there is no `receiptId`, use `privacyReceipts.addBackgroundEntry`, so a request is never unlisted.
  - Keep the content-type and HTML checks. The returned `url` is the checked `finalUrl`.
  - `preflightMediaUrlForRequest` and the `MEDIA_TEST_FIXTURES` branch stay as they are.
- **Dead code to remove** (only what this change makes unused; check with grep):
  - `preflightRedirects`, `preflightRedirectDetails`, and the preflight branch of `recordPrivacyRedirect`. Keep the thumbnail `follow` branch.
  - The `receiptDetails` parameter of `fetchForDownloadPreflight` / `preflightDownloadUrl`.
  - `preflightDownloadUrl` itself stays for `downloads:download-url` (the Downloads page "download this URL" box, user-typed, which may legitimately be a LAN address). That path is unchanged.
- **`src/main.js`, guarding the download step:**
  - `media:download` still uses Chromium's `downloadURL(checked.url)`, so the file goes through the normal Downloads UI.
  - Chromium keeps one webRequest `details.id` across all redirect hops of a download, and `onBeforeRequest` fires **before** each hop is sent. Verified with a probe: ids `2 → 2 → 2` for `/a → /b → /c.png`.
  - Steps:
    1. Before calling `downloadURL`, register `guardedDownloadUrls.set(urlKey(checked.url, String(event.sender.id)), { receiptId, created: Date.now() })`. Expire entries after 60s.
    2. In the existing `onBeforeRequest` handler (`setupAiNetworkMonitor`, line 4045; one listener per session, so extend this one), before `recordPrivacyWebRequest`:
       - If the request matches a registered key, move it to `guardedDownloadRequests.set(details.id, { receiptId, hops: 0, lastUrl: details.url })`, delete the key, and continue as normal.
       - If `details.id` is already guarded and `details.url !== lastUrl`, this is a redirect hop:
         - `hops += 1`. If `hops > 5`, cancel.
         - Run `checkHopUrl(details.url, { previousUrl: lastUrl })` and `resolvePublicAddresses(host, safeFetchResolve)`. This is async; call `callback` when it finishes.
         - On failure: `callback({ cancel: true })`, and set the Ask page status through the existing download-failed path if it is easy. Otherwise the cancelled download simply shows as failed in Downloads.
         - On success: add a receipt entry `'media file download request – no prompt or AI output sent (redirect from <prevHost>)'`, set `lastUrl`, `callback({})`, and **skip** `recordPrivacyWebRequest` for this hop so it isn't listed twice.
       - Clean up `guardedDownloadRequests` in `onCompleted` and `onErrorOccurred` (add those listeners; they don't exist yet) and in `will-download`.
       - All other requests keep exactly today's synchronous path.
- **Test-only DNS override** (`main.js`, using `testHook`, so it is ignored when `app.isPackaged`):
  - `SOVEREIGN_TEST_DNS` is JSON, for example `{"public.test":{"address":"93.184.216.34","connect":"127.0.0.1"},"private.test":{"address":"10.0.0.7"}}`.
  - `safeFetchResolve(host)` returns `[{ address, family, connect }]` for mapped names, and calls `dns.promises.lookup(host, { all: true })` for everything else. Validation sees `address`; the pinned socket connects to `connect || address`.
  - `SOVEREIGN_TEST_CA_FILE` is a PEM file passed as `ca`, test only.
  - When packaged, `safeFetchResolve` is plain `dns.promises.lookup` and `ca` is `undefined`.

#### 4. DNS rebinding (for CHANGES to state plainly)
- **Source reading and media validation: closed.** The address that was checked is the address the socket connects to (pinned `lookup`), and there is no second DNS query.
- **Media download step (Chromium `downloadURL`): narrowed, not closed.**
  - Each hop is checked before it is sent.
  - Chromium does its own DNS lookup, so a host that changes its answer between our check and Chromium's connect can still reach a private address.
  - Closing it fully would mean downloading through `safeFetch` and writing the file ourselves, which bypasses Chromium's Downloads manager. That is not "simple and safe" for this task, so it goes under QUESTION FOR SANDEEP.
- Node's `https` uses Node's bundled CA list, not the macOS keychain, and ignores system proxy settings. Source pages and media validation no longer go through a configured system proxy or a custom root CA. State this in CHANGES.

#### 5. Tests (write first)
1. **`tests/safe-fetch.test.js`** (pure unit, added to `npm run check`):
   - **Address table.** Blocked:
     - `127.0.0.1`, `10.1.2.3`, `172.16.0.1`, `172.31.255.255`, `192.168.1.1`
     - `169.254.169.254`, `100.64.0.1`, `0.0.0.0`, `224.0.0.1`, `255.255.255.255`, `198.18.0.1`
     - `::`, `::1`, `::ffff:127.0.0.1`, `::ffff:7f00:1`, `::ffff:a9fe:a9fe`
     - `fd00::1`, `fe80::1`, `febf::1`, `ff02::1`
     - `64:ff9b::a00:1`, `2002:c0a8:0101::1`, `fe80::1%en0`
     - `not-an-ip`

     Allowed: `93.184.216.34`, `8.8.8.8`, `172.32.0.1`, `2606:4700::1111`, `64:ff9b::808:808`.
   - **`checkHopUrl`.** Blocked:
     - `file:///etc/passwd`, `ftp://x`, `javascript:alert(1)`, `data:…`
     - `http://user:pw@example.com`, `http://localhost/`, `http://a.localhost/`
     - `http://2130706433/`, `http://0x7f.1/`, `http://[::ffff:127.0.0.1]/`
     - `https→http`

     Allowed: `http→https`.
   - **`safeFetch` with a fake `transport` and fake `resolve`:**
     - `public.test` 302 → `http://127.0.0.1/`, `10.0.0.1`, `192.168.0.1`, `169.254.169.254`, `[::1]`, `[::ffff:7f00:1]`, `private.test` (resolves to `10.0.0.7`). Each is blocked **and the transport is never called for the blocked hop**.
     - A mixed DNS answer (one public and one private record) is blocked.
     - A chain of 5 redirects succeeds. A chain of 6 throws "Stopped after 5 redirects."
     - `https` → `http` is blocked.
     - `http` → `https` and public → other public succeed, `chain` has every URL, and `onHop` was called once per contacted host with the right `fromHost`.
     - `resolve` is called once per hop, and the `lookup` passed to the transport returns exactly the resolved address (pinning).
     - A 3xx with no `Location` is an error.
     - `HEAD` gives a `null` body.
     - A gzip body is decoded.
2. **`tests/safe-fetch-integration.test.js`** (plain Node, real sockets on `127.0.0.1`, added to `npm run check` if it runs in under about 3s):
   - Real HTTP servers, with `resolve` mapping `public.test` and `public2.test` to `{ address: '93.184.216.34', connect: '127.0.0.1' }`.
   - Real HTTPS server: generate a 1-day self-signed certificate for `public-tls.test` at test time with `openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=public-tls.test -addext subjectAltName=DNS:public-tls.test -days 1` in a temp dir, and pass it as `ca`. Never commit a key. If `openssl` is missing, print `SKIP https cases: openssl not found` and still run the HTTP cases.
   - Cases:
     - Redirect to `http://127.0.0.1:<port>/secret` is blocked, and the `/secret` handler counter stays 0.
     - A 6-hop chain is stopped.
     - `https://public-tls.test` → `http://public.test` is blocked.
     - `http://public.test/page` → `https://public-tls.test/page` is **read**: call `readSourcePages` from `source-reader.js` with `fetchImpl` = `safeFetch` with that resolver and `ca`, and expect `evidenceMode === 'page'` and the page text in the passages.
3. **`tests/electron/safe-redirects.test.js`** (new, run outside the sandbox):
   - Setup:
     - Local HTTP server on `127.0.0.1`.
     - `SOVEREIGN_TEST_DNS` maps `public.test` and `public2.test` to report `93.184.216.34` and connect to `127.0.0.1`.
     - `app.commandLine.appendSwitch('host-resolver-rules', 'MAP public.test 127.0.0.1, MAP public2.test 127.0.0.1')` for Chromium's download step.
     - Temporary profile, `SOVEREIGN_TEST_DOWNLOAD_DIR`.
   - From the Ask page (`sovereign://ask/`, exact match):
     - (a) `window.sovereign.media.preflight({ url: 'http://public.test:P/redirect-to-loopback' })` rejects with the private-network message, and the server's `/secret` counter is 0.
     - (b) Preflight of `http://public.test:P/img-chain` (302 → `http://public2.test:P/img.png`, `image/png`) succeeds. The receipt (`privacy.getReceipts`) has entries for both `public.test` and `public2.test`, the second with `redirect from public.test`.
     - (c) `readSources({ question, results: [{ url: 'http://public.test:P/article', title, snippet }] })`, where `/article` 301s to `http://public2.test:P/article-final` (HTML with the question terms). It returns that source with `evidenceMode: 'page'`, and the receipt lists both hosts as `source-page`.
     - (d) The download guard: `/img-flip` answers `HEAD` and `GET`-range with `200 image/png`, but answers a full `GET` without `Range` with 302 → `http://127.0.0.1:P/secret`. `media.download({ url: 'http://public.test:P/img-flip' })`, then wait 2s. The `/secret` counter is 0 and no file is saved in the test download dir.
   - Exit with `app.exit(0)` or `app.exit(1)`. Do not use `process.exitCode` with `app.quit()`, because that exits 0.
   - Add the `test:electron:safe-redirects` script and its `check:tests` syntax-check entry.
   - Codex: Electron crashes in your sandbox. Only `node --check` this file. Claude runs it.

#### 6. Do not change
- Thumbnail `<img>` loading in the Ask page. It is out of scope, and thumbnails can legitimately come from a local SearXNG image proxy.
- `downloads:download-url`.
- Search requests to SearXNG.
- Model downloads.
- Receipt UI.
- Do not add cloud calls. The only network requests are the same page, image and download requests as before, now each listed per hop.

#### 7. Manual tests (Sandeep)
1. `npm run check` passes. Then run `npm run test:electron:safe-redirects`, which must print `"ok": true`.
2. `npm start`, then open Ask AI with **Search the web** on and ask a question whose top results use `http://` links or redirect to `www.` (for example `history of the http 301 status code`). Open the Privacy Receipt: `source-page` rows appear for both the first host and the redirected host (`… (redirect from <host>)`), and the answer cites the page, not just the snippet.
3. Ask `show me pictures of the Eiffel Tower`, then click **Download** on a Wikimedia `Special:FilePath` result. It downloads. The receipt lists `commons.wikimedia.org` and `upload.wikimedia.org (redirect from commons.wikimedia.org)`.
4. Optional, on your LAN: run `python3 -m http.server 8000` on another machine. You can't easily make a public URL redirect there by hand, so rely on step 1's tests for blocked cases.
5. Search for a normal topic on the Search page and check that results and the Downloads page work as before.

### CHANGES (Codex)

Implemented 2026-11-09, tests first. No commit or push.

- **`src/safe-fetch.js` (new):** Shared Node HTTP/HTTPS fetcher. Parses IPv4/IPv6 into numeric components, blocks the PLAN's address ranges (including embedded IPv4), rejects credentials, local hosts and HTTPS downgrades, validates every DNS answer, and pins socket lookup to those checked records. Follows at most five redirects, destroys redirect bodies, reports each checked hop, decodes gzip/deflate/Brotli, and keeps a single abort/timeout controller through redirects and body reading. No cookies are sent.
- **`src/source-reader.js`:** Replaced the private-address helpers and manual fetch loop with the shared checker/fetcher. Preserved the exported validator and hash stripping, source content checks, size limits and extraction. Threaded `onHop` and the new `{ response, finalUrl }` fetch contract through source reading.
- **`src/main.js`:** Source and media validation now use the shared fetcher and record every contacted hop with its purpose and redirect origin. Media HEAD validation retains the GET-range fallback and returns the validated final URL; checks without an active receipt go into the background receipt. Added the Chromium download redirect guard with five-redirect enforcement, checks before redirected requests, receipt entries and cleanup. Removed the old preflight redirect tracking; retained thumbnail attribution and `makeReceiptFetch` for search. DNS/socket overrides and the optional test CA use `testHook` and are ignored in packaged builds. The Downloads page's user-entered URL path remains unchanged.
- **Tests / `package.json`:** Added `tests/safe-fetch.test.js`, `tests/safe-fetch-integration.test.js`, and `tests/electron/safe-redirects.test.js`. Unit and real-socket tests are included in `check`; the Electron test has its own `test:electron:safe-redirects` script and a `check:tests` syntax entry. TLS integration generates its certificate/key in a temporary directory and removes them; no key is committed.

**Verification:**
- Wrote the three test files before implementation. The first `npm run check` reached the expected missing `src/safe-fetch` module failure.
- After implementation, all existing checks before the integration suite and all new safe-fetch unit tests pass. Unit tests also exercise source extraction through an HTTP-to-HTTPS redirect, all three compression formats, body timeout and caller cancellation.
- `npm run check` was run after each change batch. It currently exits nonzero at the real-socket integration suite because this sandbox denies `server.listen` on `127.0.0.1` (`EPERM`). This is not skipped or reported as a passing test. Real HTTP/HTTPS socket behavior and the integration suite's runtime remain unverified here.
- `npm run check:tests`, the integration test's syntax check, and `git diff --check` pass. Per PLAN, the Electron test was syntax-checked only; Claude must run it outside the sandbox.

**Manual verification (Sandeep / Claude):** Run `npm run check` outside the sandbox, then `npm run test:electron:safe-redirects` and expect `"ok": true`. In `npm start`, read sources whose URLs redirect and check both hosts' `source-page` receipt rows. Download a Wikimedia `Special:FilePath` image and check the redirect-origin labels. Verify normal Search and the Downloads page still work. The Electron fixture checks blocked private redirects without contacting `/secret`, successful public image/source redirects and their receipts, and a URL that changes from safe HEAD validation to a private redirect during Chromium's full download.

**Limits required by PLAN:**
- Source reading and media validation close the DNS-rebinding gap: the validated address is the socket address, with no second DNS query.
- Chromium media downloads narrow, but do not close, DNS rebinding. Redirect destinations are checked before the hop, but Chromium performs its own DNS lookup and can receive a different answer before connecting.
- Node HTTPS uses Node's CA trust instead of the macOS keychain, and these source/media validation requests no longer use configured system proxies or custom system root CAs.

**QUESTION FOR SANDEEP:** A follow-up could close Chromium download DNS rebinding by downloading through `safeFetch` and writing files ourselves, but that bypasses Chromium's Downloads manager. That change is deliberately outside this PLAN; decide separately whether to pursue it.

### REVIEW (Claude)
Reviewed 2026-11-09, round 1. **Verdict: DONE.** Codex built it. I checked the diff and the 4 new files against the PLAN, then ran everything outside the sandbox.

**MUST FIX:** none.

**SHOULD FIX (not blocking):**
- `safeFetch` builds `new Response(...)`, which throws a `RangeError` for statuses outside 200–599 (for example a stray 1xx or 999). The source or media check then fails with an unclear message instead of "HTTP <n>". This is rare and fails closed.
- `SOVEREIGN_TEST_DNS` is passed to `JSON.parse` at startup. Malformed JSON crashes the unpackaged app. It is test-only and ignored when packaged, so this is acceptable.
- `preflightMediaUrl` keeps an unused `_targetSession` parameter. Validation no longer uses the tab's Chromium session, which is intended: no cookies.
- The receipt labels an `http`→`https` hop on the same host as "redirect from wikipedia.org", by host only. That is correct, but it doesn't show the scheme change.

**OK:**
- **Addresses:** `isBlockedAddress` parses to bytes and covers every range in the PLAN, including the hex IPv4-mapped form (`::ffff:7f00:1`) that bypassed the old check, `fe80::/10` in full, NAT64, 6to4, multicast, zone ids, and fail-closed for non-IPs.
- **`checkHopUrl`:** blocks non-http(s) schemes, credentials, `localhost`, private literals, and `https`→`http`.
- **DNS pinning:** the socket's `lookup` answers only from the records that were checked (`connect || address`), with `agent: false` and TLS `servername` set to the real host. This closes DNS rebinding for source reading and media validation.
- **Hop limit:** 5 redirects are allowed and the 6th stops with "Stopped after 5 redirects.". `onHop` fires only after a hop passes its checks, so blocked hosts are never listed as contacted.
- **Source reading:** the old `net.fetch` `redirect: 'manual'` loop (which always failed in Electron 38) is gone. Abort still maps to `AbortError`, which `readOneSource` checks by name.
- **Media validation:** `HEAD`, with the `GET` range fallback, through `safeFetch`. Every hop is in the receipt, with the background receipt used when no activity is open. The returned URL is the checked final URL.
- **Download guard:** Chromium's redirect hops for `media:download` are checked in `onBeforeRequest` before they are sent, using the same request id (verified by probe). It enforces the 5-redirect limit, cleans up on `will-download`, `onCompleted` and `onErrorOccurred`, and leaves every other request on the unchanged synchronous path.
- **Dead code:** the old preflight redirect tracking was removed. Thumbnail attribution and `makeReceiptFetch` (still used by search) are kept. `downloads:download-url` is unchanged, as planned.
- **Test hooks:** `SOVEREIGN_TEST_DNS` and `SOVEREIGN_TEST_CA_FILE` go through `testHook` and are ignored when `app.isPackaged`.
- **Tests run outside the sandbox:**
  - `npm run check`: exit 0. It includes `safe-fetch.test.js`, with blocked hops for `127.0.0.1`, `10.x`, `192.168.x`, `169.254.169.254`, `[::1]`, `[::ffff:7f00:1]` and a name resolving to `10.0.0.7`; in each case the blocked hop is never contacted. It also covers 5 vs 6 redirects, `https`→`http`, pinning and decoding. It also includes `safe-fetch-integration.test.js`, which uses real sockets and a runtime-generated TLS certificate, reads an `http`→`https` page, and checks the `/secret` counter stays 0.
  - `npm run test:electron:safe-redirects`: `{"ok":true}`, exit 0. It covers a preflight blocked before `/secret`; a 2-host image chain with both hosts in the receipt ("redirect from public.test"); a 301 source page read as `page` with both hosts listed as `source-page`; and a download whose full `GET` flips to a loopback redirect, cancelled before `/secret`, with no file saved.
  - Regression: `media-chat`, `downloads` and `browser-features` pass.
  - Live sanity check from the dev machine: `http://wikipedia.org/` → `https://www.wikipedia.org/` read with 3 hops listed. Wikimedia `Special:FilePath` HEAD → `upload.wikimedia.org`, `image/jpeg`. `http://127.0.0.1/` is blocked.
- No cloud AI. No new kinds of request: the same page, image and download requests as before, now each hop listed.

**DNS rebinding (summary):** closed for source reading and media validation. Narrowed but not closed for the Chromium download step, as Codex's CHANGES says.

**QUESTION FOR SANDEEP:** Should media downloads move to `safeFetch` (we write the file ourselves) to close the last DNS-rebinding gap? It would bypass Chromium's Downloads manager, so this needs a separate decision. **Safest choice for now:** keep Chromium downloads with the per-hop guard.

**Answered (Sandeep, 2026-11-09):** keep Chromium downloads with the hop-by-hop check. Proxy and certificate behaviour is accepted for now. Both are recorded as known limits below. No code change.

#### Known limits (accepted by Sandeep, 2026-11-09)
1. **DNS rebinding on the media download step.**
   - `media:download` still hands the file to Chromium (`downloadURL`), so it goes through the normal Downloads manager.
   - Each redirect hop is checked in `onBeforeRequest` before it is sent: public address, no `https`→`http`, at most 5 redirects.
   - Chromium then does its **own** DNS lookup. A hostname that answers with a public address for our check and a private address for Chromium's connection can still reach the local network.
   - Source reading and image checks are **not** affected: they connect to the exact address that was checked.
   - Closing this would mean downloading through `safeFetch` and writing the file ourselves. Not planned for now.
2. **Source reading and image checks ignore system proxy settings.**
   - `safeFetch` uses Node's `http`/`https`, not Chromium's network stack, so it does not use the macOS or system proxy configuration.
   - **A future Tor/VPN or proxy routing feature must route these requests as well**, through `safeFetch`'s transport and the pinned DNS lookup. Otherwise source pages and image checks would bypass the tunnel and reveal the user's real IP address.
3. **Networks with TLS inspection will fail source reading.**
   - Node's `https` trusts only Node's built-in CA list, not certificates installed in the macOS keychain.
   - On corporate or school networks that inspect TLS with a keychain-installed root certificate, source pages (and HTTPS image checks) fail with a certificate error. Ask AI then falls back to the search snippets.
   - Normal browsing in tabs is not affected, because it uses Chromium.


## Task: No fake images from the local model
Status: DONE (reviewed 2026-11-09; built by Codex). Branch: `phase-0/safe-redirects`.

### PLAN (Claude)

#### 1. What happened (verified in code)
- With **Search the web** off, `answerQuestion()` (`src/ask.js` about line 2198) sends the question down the media path only if `SovereignMediaIntent.isMediaRequest(question)` is true.
- **`shoe me pictures of red pandas` returns false.** There are two ways to match today:
  - The request regex only knows real verbs (`show me`, `show`, `find`, and so on). `shoe` matches none of them.
  - The `leading` regex needs the question to *start* with `pictures of`.
- So the question went to `streamLocalAnswer()`. Its `CHAT_SYSTEM_PROMPT` (`src/ask.js` lines 34–43) says nothing about images, and the 1B model invented "Image 1: Red Panda in a Tree…".
- The **web-on** text path (`SEARCH_SYSTEM_PROMPT`, `src/search-utils.js` line 8) has the same gap for questions that aren't detected as media.

#### 2. Model instructions
- Move `CHAT_SYSTEM_PROMPT` out of `ask.js` into a new tiny UMD file, **`src/chat-prompt.js`**, built the same way as `media-intent.js`: it attaches `SovereignChatPrompt = { CHAT_SYSTEM_PROMPT, IMAGE_RULE }` to `window`, and uses `module.exports` under Node. This lets the prompt be unit-tested.
  - Load it in `src/ask.html` before `ask.js`.
  - In `ask.js`, replace the constant with `const CHAT_SYSTEM_PROMPT = window.SovereignChatPrompt.CHAT_SYSTEM_PROMPT;`.
  - Keep every existing sentence word for word.
- `IMAGE_RULE` is one string, appended to the end of `CHAT_SYSTEM_PROMPT`:
  > `You cannot see, show, create, generate, or retrieve images, photos, videos, or maps. If the user asks for pictures or other media, reply in one sentence that you cannot show images here and that they can turn on Search the web to find real images. Never describe imaginary images, never invent image titles, captions, file names, or links, and never use placeholders such as "Image 1".`
- Append the same `IMAGE_RULE` text to `SEARCH_SYSTEM_PROMPT` in `src/search-utils.js`. Write it inline there, because search-utils is also loaded in other pages and must not depend on `chat-prompt.js`.
  - Change the second sentence's ending to "…to find real images with **Find images**", **only if** that label exists. It doesn't: the real buttons are **Search web for images** (local-only consent) and **Show images**. So **do not** use the words "Find images". See the QUESTION below.
- Add `node --check src/chat-prompt.js && node tests/chat-prompt.test.js` to `npm run check`.

#### 3. Detection (`src/media-intent.js`)
Add one extra positive rule, **after** the existing negative early return (the `what is`, `how do`, `explain`, `describe`, `tell me about`, `imagine` and `picture this` regex). So everything that is excluded today stays excluded.

- **Short request prefix:** 1–5 words at the start, after the politeness phrases are stripped. Every word must be in this vocabulary:
  - **Real request verbs:** `show`, `find`, `get`, `give`, `see`, `display`, `download`, `pull`, `look`, `search`, `send`, `share`, `fetch`, `bring`
  - **Fillers:** `me`, `us`, `u`, `you`, `can`, `could`, `would`, `pls`, `plz`, `please`, `i`, `want`, `wanna`, `to`, `need`, `lemme`, `gimme`, `up`, `for`, `some`, `a`, `few`, `any`, `the`, `hey`, `just`, `quick`
  - **Typo verbs:** words within edit distance 1 of `show`, `find`, `give` or `send`. Count insert, delete, substitute and swap-adjacent, so `shoe`, `sho`, `shw`, `shwo`, `snow`, `fnd`, `fidn` and `giv` all count. A typo verb counts **only when the next word is `me`, `us` or `u`**, so "Shoe pictures of the 1920s" and "Snow pictures of Alaska" are *not* requests. Write a 15-line helper for the edit distance. Do not add a dependency.
  - The prefix must contain at least one real or typo verb.
- **Then:** an optional quantity, then a media unit (`pictures`, `pics`, `photos`, `photographs`, `images`, `videos`, `clips`, `wallpapers`, singular or plural; same list as `mediaUnit`), then `of`, `showing` or `from`, then at least one letter.
- **`mediaQueryForQuestion`:** when this new prefix matched (and the existing steps did not already strip a request), strip the prefix, then strip the `mediaUnit` as today. So `shoe me pictures of red pandas` → `red pandas`.
- `mediaTypeForQuestion` is unchanged.

#### 4. Tests (write first)
1. **`tests/media-intent.test.js`:** add positives as `[question, type, query]`:
   - `shoe me pictures of red pandas` → `images`, `red pandas`
   - `sho me pics of red pandas` → `images`, `red pandas`
   - `plz show pictures of koalas` → `images`, `koalas`
   - `pls sho me some photos of the Alps` → `images`, `the Alps`
   - `shwo me images of Mars` → `images`, `Mars`
   - `can u shoe me pictures of red pandas?` → `images`, `red pandas`
   - `fnd me videos of whales` → `videos`, `whales`
   - `gimme photos of Tokyo` → `images`, `Tokyo`

   Add negatives (`isMediaRequest` is false):
   - `Shoe pictures of the 1920s`
   - `Snow pictures of Alaska`
   - `I hate pictures of spiders`
   - `Explain the shoe me pictures meme`
   - `What are pictures of the soul in Plato?`
   - `How do I show me pictures of cats in React?`

   **All existing positive, negative and cleanup cases must still pass unchanged.**
2. **New `tests/chat-prompt.test.js`:**
   - `CHAT_SYSTEM_PROMPT` starts with the exact old first sentence and contains every old sentence. Copy them into the test.
   - It ends with `IMAGE_RULE`.
   - `IMAGE_RULE` matches `/cannot see, show, create, generate, or retrieve images/`, `/one sentence/`, `/Search the web/`, `/Never describe imaginary images/` and `/invent image titles/`.
   - `require('../src/search-utils').SEARCH_SYSTEM_PROMPT` (check how it is exported; `tests/dataset-collection.test.js` already uses it) contains the same rule.

#### 5. Do not change
- The media answer path or its buttons.
- `streamLocalAnswer`.
- Any other prompt (the sidebar summary).
- No network changes.

#### 6. QUESTION FOR SANDEEP
The request asked the model to suggest **"Find images"**, but no control has that name. The existing buttons are **Search web for images** and **Show images**, and Electron tests depend on those labels. **Safest choice taken:** the model says "turn on Search the web to find real images", and no buttons are renamed. Should the buttons be renamed to "Find images" in a later task?

#### 7. Manual tests (Sandeep)
1. `npm run check` passes.
2. `npm start` → Ask AI with **Search the web off** and the model loaded:
   - `shoe me pictures of red pandas` → **no model answer**. You get the "I can retrieve real image results… when you allow web retrieval" message with the **Search web for images** button. Click it: web search turns on and real red panda images appear.
   - Also try `sho me pics of koalas` and `plz show photos of the Alps`. Both behave the same.
3. Still with web off, ask something the detector should *not* catch but that invites made-up images, e.g. `Describe some pictures of red pandas for me`. The model answers in one sentence that it can't show images and suggests turning on Search the web. There is no "Image 1:" list and no invented titles. (A 1B model can still slip. Tell me if it does, with the exact text.)
4. Regression: `How do I resize an image in Python?` gives a normal text answer with no image search. `Snow pictures of Alaska` is not treated as an image request (it is answered as text).

### CHANGES (Codex)
Implemented 2026-11-09, tests first. No commit or push.

- **`src/chat-prompt.js` (new), `src/ask.js`, `src/ask.html`:** Moved the local chat prompt into the browser/Node wrapper, preserving every old sentence verbatim, appended the exact IMAGE_RULE, and loaded it before Ask AI.
- **`src/search-utils.js`:** Appended the same rule inline to the search prompt. It suggests turning on Search the web; no button labels changed.
- **`src/media-intent.js`:** Added the bounded, vocabulary-checked short request prefix after the existing exclusions. The 15-line edit helper supports insertion, deletion, substitution and adjacent swaps; typo verbs require a following me/us/u. Query cleanup strips the new prefix only if the existing steps have not stripped a request.
- **`tests/media-intent.test.js`, `tests/chat-prompt.test.js` (new), `package.json`:** Added all eight required positives and six negatives, retained all existing expectations, and added prompt-preservation/shared-rule assertions and the new check steps.
- **PLAN inconsistency resolved:** The required positive `gimme photos of Tokyo` conflicts with listing gimme only as a filler while requiring a verb. Treated gimme as a contracted request verb to satisfy the explicit test.
- No network changes, dependencies, media-path/button changes, sidebar prompt changes, or changes to streamLocalAnswer. Preserved the pre-existing safe-redirect work.

**Verification:**
- Before implementation, `npm run check` failed on the new `shoe me pictures of red pandas` assertion; the standalone prompt test failed because chat-prompt did not exist.
- After implementation, new tests and all existing media cases pass. `npm run check` fails only in `tests/safe-fetch-integration.test.js`: this sandbox blocks localhost sockets (`listen EPERM 127.0.0.1`).
- Ran every other top-level check step individually, including the build, all syntax/unit checks and `npm run check:tests`; all pass. `git diff --check` passes.
- Electron UI and live model behavior were not run here. Prompt instructions cannot guarantee a 1B model will always comply.

**Manual verification (Sandeep):**
1. Run `npm run check` outside the sandbox, then `npm start`.
2. With Search the web off, try `shoe me pictures of red pandas`, `sho me pics of koalas`, and `plz show photos of the Alps`. Expect the existing web-retrieval consent message and Search web for images button, with no model answer. Click the button and verify real images.
3. With web off and the model loaded, ask `Describe some pictures of red pandas for me`. Expect a one-sentence limitation and suggestion to enable Search the web, without imaginary captions or Image 1 lists.
4. Verify `How do I resize an image in Python?` and `Snow pictures of Alaska` stay on the text path.


### REVIEW (Claude)
Reviewed 2026-11-09, round 1. **Verdict: DONE.** Codex built it.

**MUST FIX:** none.

**SHOULD FIX (not blocking):**
- `gimme` is in both the verb and filler sets. That is harmless, and it is how the PLAN's own inconsistency (gimme listed only as a filler, yet the prefix needs a verb) was resolved; Codex noted it in CHANGES.
- The prefix words are split on whitespace only, so punctuation inside the prefix (`plz, show me pics of…`) is not caught by the new rule. It may still be caught by the existing regex.
- The prompt rule can't force a 1B model to obey. That's why detection does most of the work: a detected image request never reaches the model.

**OK:**
- **Prompt:** the prompt moved unchanged into `src/chat-prompt.js`, and `tests/chat-prompt.test.js` checks every old sentence. `IMAGE_RULE` is appended to both the Ask prompt and `SEARCH_SYSTEM_PROMPT`, and it never invents a "Find images" button.
- **Detection placement:** the new short-prefix rule runs **after** the existing exclusions (`what is…`, `how do…`, `explain`, `describe`, `tell me about`, `imagine`), so everything excluded before is still excluded.
- **Typo verbs:** words within edit distance 1 of show, find, give or send count only before `me`, `us` or `u`. So `Snow pictures of Alaska` and `Shoe pictures of the 1920s` stay text questions.
- **Search phrase:** `mediaQueryForQuestion` strips the new prefix, so `shoe me pictures of red pandas` searches for `red pandas`.
- **Unit tests:** all 8 new positives and 6 new negatives pass, and every existing positive, negative and cleanup case is unchanged.
- **Extra cases I checked (not in the tests):** compared with the committed detector, the only newly detected phrasing was `send me photos from my trip`, which is a real image request. These were already treated as image requests before this change and are unchanged: `display images of a dataframe in pandas`, `give me a summary of photos of the war`, `see pictures of`. `me pictures of cats` stays false.
- **Check:** `npm run check` exits 0 outside the sandbox, including `chat-prompt` and `media-intent`. (Codex's sandbox can't open localhost sockets, so its `npm run check` failed only on the safe-fetch integration test. It ran every other step individually.)
- **Electron:** `media-chat`, `ask-layout` (`"ok": true`) and `ui-smoke` pass, so loading the Ask page with the new `chat-prompt.js` script works.
- No network changes, and no button or answer-path changes.

**QUESTION FOR SANDEEP:** No button is named "Find images". The existing buttons are **Search web for images** and **Show images**, and Electron tests use those labels. **Safest choice taken:** the model tells the user to turn on Search the web, and no buttons were renamed. Do you want a later task to rename the buttons to "Find images"?

**Answered (Sandeep, 2026-11-09):** no rename. The labels stay **Search web for images** and **Show images**, and the model's suggestion to "turn on Search the web" stays.

## Batch summary (safe redirects + no fake images, phase-0/safe-redirects, 2026-11-09)
Both tasks are **DONE**. Codex built both. Claude wrote the PLAN and REVIEW and ran the Electron tests outside Codex's sandbox. Final `npm run check`: **exit 0**. Nothing committed.

| # | Task | Status | Built by | Files |
|---|---|---|---|---|
| 1 | Safe redirect handling | DONE | Codex | `src/safe-fetch.js` (new), `src/source-reader.js`, `src/main.js`, `package.json`, `tests/safe-fetch.test.js` (new), `tests/safe-fetch-integration.test.js` (new), `tests/electron/safe-redirects.test.js` (new) |
| 2 | No fake images from the local model | DONE | Codex | `src/chat-prompt.js` (new), `src/ask.js`, `src/ask.html`, `src/search-utils.js`, `src/media-intent.js`, `package.json`, `tests/media-intent.test.js`, `tests/chat-prompt.test.js` (new) |

**Test results:**
- `npm run check`: exit 0. It now includes:
  - `safe-fetch` unit tests: private targets blocked before contact, 5 vs 6 redirects, `https`→`http`, DNS pinning, decoding.
  - Real-socket tests, including an HTTPS server whose certificate is generated at test time.
  - `chat-prompt` and the extended `media-intent` tests.
- `npm run test:electron:safe-redirects`: `{"ok":true}`.
  - A private redirect is blocked before `/secret` is reached.
  - Image and source redirect chains work, with every host in the receipt.
  - A download that redirects to loopback is cancelled before it is sent.
- Regression (Electron): `media-chat`, `downloads`, `browser-features`, `ask-layout` and `ui-smoke` pass.
- Live sanity check: `http://wikipedia.org/` → `https://www.wikipedia.org/` is read. The Wikimedia `Special:FilePath` image resolves to `upload.wikimedia.org`. `http://127.0.0.1/` is blocked.

**Open questions for Sandeep:**
1. **(Task 1)** The Chromium download step is still exposed to DNS rebinding. Each redirect hop is checked first, but Chromium does its own DNS lookup. Closing this means downloading through `safeFetch` and writing the file ourselves, which bypasses Chromium's Downloads manager. Do it as a follow-up? *For now, Chromium downloads plus the per-hop guard.*
2. **(Task 1, side effect)** Source reading and media checks now use Node's network stack. They ignore system proxy settings and trust Node's built-in certificate list instead of the macOS keychain. Acceptable? *For now, accepted and documented.*
3. **(Task 2)** No button is called "Find images". The real labels are "Search web for images" and "Show images". Rename them? *For now, the model just says "turn on Search the web", and no buttons were renamed.*

**Answered (Sandeep, 2026-11-09):** Q1 keep Chromium downloads with the hop-by-hop check. Q2 accepted for now. Q3 no rename. The download DNS-rebinding gap, the ignored system proxy (a future Tor/VPN feature must route these requests too) and failures on TLS-inspecting networks are recorded under **Known limits** in the "Safe redirect handling" task. No code was changed.

**Manual tests:** see the chat summary for this batch, and each task's PLAN §7.

## Task: Offline mode (Phase 1, Task 1a)
Status: ready for manual testing (not committed). Branch: `phase-1/offline-mode`. **Feature built by Claude (Codex unavailable at the time); recovery-round tests built by Codex (2026-11-10).**

**Plan review decisions (Sandeep, 2026-11-09), applied below:**
1. Offline localhost access is an explicit allowlist, **empty by default**, editable in Settings with a forwarding warning (§2, §3.1, §3.6). `sovereign://` and local `file:///` are always allowed.
2. "Open in default browser" is refused while Offline with the exact message "Offline mode is on. Opening another app would leave Sovereign's protection." (§3.2 layer 5).
3. `SOVEREIGN_AUDIT_PROXY` works only when `!app.isPackaged`, with a test (§3.9).
4. Spellchecker dictionary downloads are disabled while Offline, with a test (§3.8).
5. Every automatic background request is listed with how Offline blocks it (§3.8).

**Recovery check (Claude, 2026-11-10, after the Mac shut down mid-task):**
- Nothing was lost. `git status` shows 33 modified files plus 4 untracked (`src/network-mode.js`, `tests/network-mode.test.js`, `tests/network-exits.test.js`, `tests/electron/offline-mode.test.js`). CHANGES and REVIEW below were already written before the shutdown.
- Built and matching the PLAN: `network-mode.js`, layers 1–5 in `main.js`, receipts (`blocked`, origin only, count, `Offline: N`), preferences and banner, toolbar and Settings UI, allowlist IPC, downloads pause, model check-only, `open-external` refusal, audit proxy via `testHook`, spellchecker, the Electron test (7 phases) and one regression line in each existing Electron test. `npm run check` exits 0.
- Missing against PLAN §5: `tests/network-mode.test.js` is 25 dense lines. It does not check the `reason` for blocked external URLs. It also does not check the §2 error messages for a missing port, a scheme, the audit proxy, duplicates or the 20-entry cap. The safe-fetch gate is tested only with fakes, not a real socket with 0 connections. In `privacy-receipt.test.js` the new asserts run after the "passed" log line.
- Codex had usage again on 2026-11-10, so the remaining test work went to Codex (see CHANGES, "Recovery round").

### PLAN (Claude)

#### 1. What exists today (verified in code)
- **One session.** Every tab (`createWebView`, `main.js` ~2903), internal page (`createTrustedInternalView`, ~2920), the sidebar, and the hidden model-setup window (`createModelSetupWindow`, ~800) use `session.defaultSession`. No `partition` is set anywhere. `app.on('session-created', setupPermissionHandling)` (~4196) already runs for any future session.
- **One `onBeforeRequest` listener** on the default session, in `setupAiNetworkMonitor` (~4029). It does AI-runtime logging, the download redirect guard and `recordPrivacyWebRequest`. Electron allows only one `onBeforeRequest` listener per session, so the offline check must go **inside this listener**, not in a second one.
- **Requests that never touch the session.** These bypass `webRequest` and the session proxy completely:
  - `safeFetch` (`src/safe-fetch.js`) uses Node `http`/`https`, and `safeFetchResolve` calls `dns.lookup` (OS resolver). Used by source reading and media preflight.
  - `shell.openExternal` (`browser:open-external`, ~5311) hands a URL to the system browser.
- **Requests through Electron's network stack from main:** `net.fetch` in `makeReceiptFetch` (~936, SearXNG search and media search) and `downloadSession.fetch` (~2111, download preflight). These go through the session, but we gate them in code anyway (§3.4) so the rule does not depend on `webRequest` seeing them.
- **Proxy.** `setupAuditProxyForSession` (~1096) calls `setProxy` only when `SOVEREIGN_AUDIT_PROXY` is set. Otherwise Chromium uses the system proxy settings. `AUDIT_PROXY` (~114) is read straight from `process.env`, **even in a packaged build** (fixed in §3.9).
- **No auto-updater and no crash reporter** are set up (`autoUpdater` / `crashReporter` do not appear in `src/`). The Electron spellchecker is on by default (no `spellcheck` setting anywhere).
- **The only localhost service the app uses is SearXNG** (`DEFAULT_SEARXNG_ENDPOINT = http://127.0.0.1:8080/search`, `search-backend.js`). The user can also point it at a private-network address. SearXNG forwards every query to public search engines, so **it counts as external** while Offline.
- **The AI model** runs in the renderer (WebLLM, `src/ai/ai-engine-entry.js`, IndexedDB cache). `hasModelInCache` is a local check. First-run auto-download (`shouldAutoStartModelSetup`, ~868) fetches model files through the default session.
- **Preferences** live in `userData/preferences.json` (`loadPreferences` ~1247, `savePreferences` ~1309). There is no network setting yet.
- **Receipts** (`src/privacy-receipt.js`): entries carry the full cleaned URL. `buildSummary` builds the one-line summary. `VALID_CATEGORIES` limits the categories.

#### 2. Behaviour (what Sandeep will see)
- **Toolbar switch.** A new button in the nav row of `src/index.html`, just left of the AI button: `#network-mode-toggle`, with `aria-pressed`. The label is always written out, never just an icon: **"Offline"** (filled, high-contrast style) or **"Online"**. Tooltip: "Offline mode: nothing leaves this computer. Click to go online." / "Online: websites and web search can use the internet. Click to go offline." One click switches; no confirm dialog either way.
- The same setting appears in **Settings** (`settings.html`) as a radio pair with one line of explanation, so it can be found without the toolbar.
- **New installs** (no `preferences.json` yet): start **Offline**. Nothing is asked.
- **Existing installs** (`preferences.json` exists, no `network` key): stay **Online**. On the first launch after the update, show a one-time banner under the toolbar (in-app, not a native dialog, so tests can drive it):
  > **New: Offline mode.** When it's on, Sovereign sends nothing to the internet. Ask AI still works with your downloaded model, attached files and pages you already have open. Websites, web search and image search pause until you switch back. [Turn on Offline mode] [Stay online]
  - Either button saves `network.choiceMade = true`. Closing the banner (×) counts as "Stay online" and also saves it, so it is asked **once**.
- **Websites while Offline.** Navigating to an external site shows the existing tab error UI (`sendTabError`) with "Offline mode is on, so this site can't load. Switch to Online to open it." Map `did-fail-load` error `-20` (`ERR_BLOCKED_BY_CLIENT`) to this message when the mode is offline. **Local addresses are blocked too unless they are on the Offline allowlist**; the message for a blocked local address says "This local address isn't on your Offline allowlist. You can add it in Settings."
- **Offline allowlist (Settings).** Under the Offline/Online radio pair: a list of allowed local addresses, **empty by default**, with an input and [Add] / [Remove] buttons. Above it, always visible, the warning:
  > Only add a local service you trust. Some local services (for example a search engine like SearXNG, a proxy or an AI server) forward what you send to the internet, and Offline mode can't see past them.
  - An entry is `host:port`. `host` must be a loopback host: `localhost`, `*.localhost`, `127.x.x.x` or `[::1]`. The port is required (keeps each entry narrow). Example: `127.0.0.1:3000`.
  - Rejected with a clear message: non-loopback hosts (`192.168.1.5:80` → "Only addresses on this computer can be allowed."), a missing port, the SearXNG endpoint's host:port ("SearXNG forwards searches to the internet, so it can't be allowed in Offline mode."), the audit proxy's host:port, duplicates, and more than 20 entries.
  - The entry allows `http`, `https`, `ws` and `wss` to exactly that host and port (default port 80/443 when the URL has none). `localhost:3000` and `127.0.0.1:3000` are separate entries; no DNS is involved.
  - Changes apply immediately, also while Offline.
- **Ask AI while Offline:**
  - Works: the local model, attachments (PDF/text), "use this page" / page text from tabs that are already open (`ai:extract-active-page-text` reads the already-rendered DOM; no new request).
  - **"Search the web"** (`#web-toggle` in `ask.html`) is unchecked and disabled, with the note "Off while Offline mode is on." next to it. The "Search web for images" / "Show images" buttons are hidden or disabled with the same note. A media question gets the existing "turn on Search the web" style reply, reworded to "Image search needs Online mode."
  - **Sovereign Search** page (`search.html`) and the toolbar search button: the search box is disabled with "Web search is off in Offline mode. Ask AI still works with your files and open pages."
- **Model download while Offline.** `ensureModelSetupService` runs the local `check` only, never `check-and-download`. If the model is not cached, the setup chip and Ask page say: "The AI model isn't on this computer yet. Offline mode is on, so it can't be downloaded. Switch to Online to download it (about 705 MB); you can turn Offline back on afterwards." with a **[Go online and download]** button. That button switches the mode to Online (visible in the toolbar) and then starts the download. It is never done silently.

#### 3. Design
##### 3.1 New module `src/network-mode.js` (plain Node, no Electron imports, unit-testable)
- `isLoopbackHost(hostname)`: true only for `localhost`, `*.localhost`, IPv4 literal in `127.0.0.0/8`, and `::1` (with or without `[]`). Parse IPs to bytes (reuse the parsing in `safe-fetch.js`; export it there if needed, don't duplicate). Not loopback: `0.0.0.0`, `::ffff:127.0.0.1` (mapped; block, keep the rule simple), private LAN ranges, any hostname that merely resolves to 127.x (no DNS is done here).
- `parseAllowlistEntry(text, { blockedHostPorts })` returns `{ ok: true, entry: 'host:port' }` (host lower-cased, IPv6 kept in `[]`) or `{ ok: false, error }` with the messages in §2. `normalizeAllowlist(list, opts)` drops invalid entries and duplicates and caps at 20 (used when loading preferences).
- `offlineDecision(url, { allowlist, blockedOrigins })` returns `{ allow: boolean, reason }`:
  - Allow schemes `sovereign:`, `data:`, `blob:`, `devtools:`, `about:`, `chrome:` (Chromium internal error pages).
  - Allow `file:` **only with an empty host** (`file:///…`). `file://server/share` is a network share: block.
  - Allow `http:`, `https:`, `ws:`, `wss:` only when `isLoopbackHost`, **and** the URL's `host:port` (default port filled in) is in `allowlist`, **and** it is not in `blockedOrigins`. With the default empty allowlist, every http/ws request is blocked. `reason` is `'external'`, `'local-not-allowed'` or `'blocked-local-service'` so the UI can pick the right message.
  - Everything else is blocked (fail closed), including unparseable URLs and `ftp:`.
- `blockedOrigins` is built in `main.js` from: the configured SearXNG endpoint's origin (any address, loopback included), and the audit-proxy origin when set.
- `initialNetworkState({ prefsFileExisted, parsed })` returns `{ mode, choiceMade }`:
  - No file: `{ mode: 'offline', choiceMade: true }`.
  - File exists and has a valid `network` object: use it.
  - File exists without `network`: `{ mode: 'online', choiceMade: false }` (show the banner).
  - File exists but is not valid JSON: `{ mode: 'offline', choiceMade: false }` (fail closed; the banner still offers the choice).
- `createNetworkMode({ initial, onChange })` holds the state: `isOffline()`, `set(mode)` (no-op if unchanged; calls `onChange(mode, previous)`), and `assertOnline(purpose)`, which throws `Error('Offline mode is on.')` with `code = 'OFFLINE_MODE'` and `purpose` attached.

##### 3.2 Enforcement layers in `main.js` (every layer applies to every session)
Keep a `Set` of sessions: `session.defaultSession` plus every session from `app.on('session-created')`. A new helper `applyNetworkModeToSession(ses)` runs on startup, on each new session, and on every mode change. Layers:
1. **`webRequest.onBeforeRequest` (main enforcement).** At the **top** of the existing listener, before anything else: if offline and `offlineDecision(details.url).allow` is false, record the blocked attempt (§3.5) and `callback({ cancel: true })`. This covers navigations, subresources, XHR/fetch, WebSocket handshakes (`ws:`/`wss:` show up as `resourceType: 'webSocket'`), service-worker fetches (`webContentsId` may be missing; the check does not need it), download requests (§3.3), and model-file fetches.
   - Generalise `setupAiNetworkMonitor()` into `setupNetworkMonitorForSession(ses)` so a session created later gets the same single listener. The default session behaves exactly as today when online.
2. **Proxy black-hole (catches what `webRequest` never sees: `<link rel=preconnect>`, speculative preconnects, DNS prefetch, WebRTC TCP fallback).** When offline: `ses.setProxy({ mode: 'fixed_servers', proxyRules: 'http=127.0.0.1:9;https=127.0.0.1:9;socks=127.0.0.1:9', proxyBypassRules: '<local>;localhost;127.0.0.1;[::1]' })`. Port 9 is the discard port with nothing listening, so a proxied connection fails at loopback. Chromium does not fall back to DIRECT for `fixed_servers`, and does not resolve DNS locally for proxied hosts. Then `await ses.closeAllConnections()`.
   - **With `SOVEREIGN_AUDIT_PROXY` set**, keep the audit proxy instead of the black-hole. Otherwise mitmproxy sees 0 requests for a trivial reason (we replaced it) and the manual audit proves nothing. The audit then tests layers 1, 3 and 4.
   - Going Online: restore the audit proxy if set, else `setProxy({ mode: 'system' })`, then `closeAllConnections()`.
3. **DNS (defence in depth).** When offline: `app.configureHostResolver({ secureDnsMode: 'secure', secureDnsServers: ['https://127.0.0.1:9/dns-query'] })`, so any Chromium lookup that slips past the proxy fails at loopback. Going online: `app.configureHostResolver({ secureDnsMode: 'off' })` (today's default). **Codex: check in a probe that `localhost` still resolves (Chromium special-cases it) and that this call is allowed after `ready` in Electron 38. If either fails, drop this layer and say so in CHANGES. Layers 1 and 2 are still required.**
4. **WebRTC.** On every `web-contents-created` (and for existing contents on change): offline → `contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')`; online → `'default'`. Combined with the black-hole proxy, no STUN/UDP leaves the machine.
5. **Main-process code gate.** `networkMode.assertOnline(purpose)` at every main-process exit point:
   - `safeFetch` callers: put it inside `safeFetchResolve` **and** inside the `fetchImpl` wrapper used by `handleReadSources` and `preflightMediaUrl`, so it runs before `dns.lookup`.
   - `makeReceiptFetch` (SearXNG search, media search).
   - `fetchForDownloadPreflight` / `preflightDownloadUrl` (`downloads:download-url`): allow when the typed URL passes `offlineDecision` (only an allowlisted local address), else reject with the offline message.
   - `media:preflight`, `media:download`.
   - `ensureModelSetupService` when the command would download (§2).
   - `browser:open-external`: when offline, do not call `shell.openExternal`. Show exactly **"Offline mode is on. Opening another app would leave Sovereign's protection."** in the status line of the window that asked (change it from `ipcMain.on` to `ipcMain.handle` returning `{ ok: false, offline: true, error }`, and update the preload/renderer caller). The other app is outside our control, so we refuse rather than leak.
   - IPC handlers that start web work (`search:query`, `search:media`, `search:read-sources`) check first and return `{ ok: false, offline: true, error }`, so the renderer can show the message instead of a generic failure.

##### 3.3 Downloads
- Starting a download while offline: the request is cancelled in layer 1. Also add a check at the top of the `will-download` handler (`setupDownloadHandlingForSession`, ~1969): if offline and the item's URL fails `offlineDecision`, call `item.cancel()` and add a Downloads row with state "Blocked: Offline mode". (Belt and braces: `will-download` fires after the response starts, so layer 1 is what stops the request; this handles anything that got past it.)
- **Switching to Offline mid-download:** for each item in `activeDownloadItems` whose URL fails `offlineDecision`, call `item.pause()` and label it "Paused: Offline mode". `closeAllConnections()` drops the socket. While offline, the Resume button is disabled with the same tooltip. Going online does **not** auto-resume; the user clicks Resume.

##### 3.4 Switching modes (`network:set-mode`)
Order matters: block first, then tidy up.
1. `networkMode.set('offline')`, so layer 1 and the code gate block from this moment on.
2. `applyNetworkModeToSession` for every session: proxy, DNS, then `closeAllConnections()`. This also closes open WebSockets and long-polls on tabs already open on websites.
3. Abort every controller in `activeSearchRequests`. Cancel model setup if it is `downloading`: `cancelModelSetup('Model download paused: Offline mode is on.')`. WebLLM keeps finished shards in IndexedDB, so the download continues from there later. Note: `cancelModelSetup` sets `setupCanceled = true`; when the user goes online and clicks the button, `forceStart` clears it (existing behaviour).
4. Pause downloads (§3.3). Update WebRTC policy.
5. Broadcast `network:mode-changed` to the toolbar UI and every internal view (Ask, sidebar, search, newtab, settings, downloads). Save preferences.

Switching to Online runs the same steps in reverse: set mode, restore proxy/DNS/WebRTC, broadcast, save. Nothing is reloaded or resumed automatically.

**Mid-answer:** local generation needs no network and continues. If the answer was still in the web step (search or source reading), that step is aborted. If no sources had arrived yet, the answer stops with "Offline mode turned on, so the web search was stopped. Ask again to answer from your files and open pages." If sources were already read, the local model finishes using them, and the message notes "Web search stopped when Offline mode turned on; answered from the N sources already read." Don't answer silently from the model alone when the user asked for a web-grounded answer.

**Tabs already open on websites:** the page stays on screen (it is already in memory). Further requests from it (scripts, XHR, images, WebSockets) are blocked and recorded. Reload shows the offline error page. Don't close or reload tabs automatically.

##### 3.5 Privacy Receipt
- New category `blocked` in `VALID_CATEGORIES`. Blocked entries **store the origin only** (`scheme://host:port`), never the path or query, because a blocked URL can contain the question (`?q=…`, a search URL typed into the address bar, a SearXNG URL). `whatWasSent: 'blocked (offline mode) – nothing sent'`.
- **Aggregate** blocked attempts per receipt by origin and resource type: one entry with a `count` field (`blocked (offline mode) ×37`) instead of 37 entries, so a busy page cannot push real entries out of `MAX_ENTRIES_PER_RECEIPT`.
- Attribution: use the existing `contextForPrivacyRequest` / `classifyPrivacyRequest` path. Attributed to an activity → that receipt. Otherwise → one rolling **"Offline mode"** receipt (fixed id like `PERMISSION_RECEIPT_ID`, created the first time a blocked attempt appears after switching to Offline). Do **not** use the background receipt for these; keep it for real background traffic.
- Receipts gain `offline: boolean`, set from the mode when the receipt is created and set to `false` if the mode goes online while it is still open.
- `buildSummary`: when `receipt.offline`, start with **`Offline: N external requests`**, where N counts entries that are not `blocked` and not `permission`. N should always be 0. **Compute it, don't hard-code it**: if a bug lets one request out, the receipt must say "Offline: 1 external request" rather than lie. Then `· M blocked (offline mode)` when M > 0, then "AI generated locally" for Ask receipts as today.
- `exportPayload` includes the new fields. Nothing new is written to disk except the `network` preference.

##### 3.6 Preferences (`main.js`)
- `loadPreferences`: record whether the file existed and parsed, then call `initialNetworkState`. `savePreferences` writes `network: { mode, choiceMade, offlineAllowlist: [] }`. IPC: `network:get-state` returns `{ mode, choiceMade, offlineAllowlist }`; `network:add-allowed` / `network:remove-allowed` validate with `parseAllowlistEntry` and save. If the SearXNG endpoint is changed to a host:port that is on the allowlist, remove that entry and tell the user in Settings. Load must happen before any window or network activity; it already does (`loadPreferences()` runs before `setupAuditProxyForSession`). Apply the mode to the default session **before** the first window is created and before the model-setup service can start.
- Test hook (via `testHook`, ignored when packaged): `SOVEREIGN_TEST_NETWORK_MODE=offline|online` overrides the start mode; `SOVEREIGN_TEST_OFFLINE_LAYERS=webrequest|proxy|all` (default `all`) turns individual layers off so each can be tested alone (§5).

##### 3.7 Renderer and preload
- `preload.js`: `window.sovereign.network = { getMode(), setMode(mode), onModeChange(cb), dismissIntro(choice) }`.
- `renderer.js` + `index.html`: the toggle, the one-time banner, the offline tab-error message.
- `ask.js` + `ask.html`: disable the web toggle and image buttons with the note; handle `{ offline: true }` replies; model-not-cached message with [Go online and download]; mid-answer messages (§3.4).
- `search.js`, `sidebar.js`, `model-setup.js`, `downloads.js`, `settings.js` / `settings.html`: the offline state and messages listed above. Keep each change small.
- `styles.css`: toggle states; must be readable in light and dark themes.

##### 3.8 Automatic background requests (everything found; how each is blocked while Offline)
Codex: grep again while building (`fetch(`, `loadURL(`, `downloadURL(`, `request(`, `lookup(`, `http`, `autoUpdater`, `crashReporter`, `spellcheck`, `favicon`) and add any new row to CHANGES.

| # | Source | Requests today | Offline handling | Test |
|---|---|---|---|---|
| 1 | **Spellchecker dictionaries** (Electron, Windows/Linux: Hunspell `.bdic` files from Google's CDN; macOS uses the system spellchecker and downloads nothing) | Automatic, on startup and when languages change | **Disabled:** `ses.setSpellCheckerEnabled(false)` for every session while Offline; on Online restore the previous value (store it per session). Layers 1/2 as backup. | Electron: Offline → `isSpellCheckerEnabled()` is false for every session; Online → true again. On Windows/Linux also `setSpellCheckerDictionaryDownloadURL('http://external.test:P/dict/')` + `setSpellCheckerLanguages(['fr'])` → 0 connections. On macOS that half is skipped and the test prints why. |
| 2 | **Auto-update** | None (`autoUpdater` not used) | Nothing to block. Guard: `network-exits` test fails if `autoUpdater` or `update-electron-app` appears in `src/` without an `assertOnline` call next to it. | Unit (guard) |
| 3 | **Crash reporter** | None (`crashReporter.start` never called; Electron uploads nothing unless started) | Nothing to block. Same guard for `crashReporter`. | Unit (guard) |
| 4 | **Favicons** | None by the app (no `page-favicon-updated` handler; Electron has no favicon service). A page's own `<link rel=icon>` is a normal page subresource. | Layer 1 (it's a session request). | Covered by the subresource cases |
| 5 | **Model auto-download** (`huggingface.co`) and **WebLLM runtime library** (`raw.githubusercontent.com`) | Automatic on first run (`shouldAutoStartModelSetup`) | `ensureModelSetupService` only runs `check` while Offline (§2); layer 1 blocks the fetches anyway. | Electron case 6 |
| 6 | **Session restore** ("Continue where you left off") reopens saved website tabs on launch | Automatic on launch | Tabs are restored but each shows the offline error page; saved tabs are **not** dropped. | Electron: start Offline with a saved session containing `http://external.test:P/` → 0 connections, tab still listed |
| 7 | **Chromium speculative requests:** `<link rel=preconnect/dns-prefetch/prefetch/prerender>`, `<a ping>`, `navigator.sendBeacon`, CSP/Reporting-API reports | Automatic, triggered by pages | Prefetch, ping, beacon and reports are session requests → layer 1. Preconnect and DNS prefetch never reach `webRequest` → layer 2 (proxy black-hole) and layer 3 (DNS). | Electron cases 2 and the per-layer runs; add `<a ping>` and `sendBeacon` to case 2 |
| 8 | **WebRTC** (STUN/TURN, ICE candidates) | Triggered by pages | Layer 4 (`disable_non_proxied_udp`) + layer 2. | Electron: `RTCPeerConnection` with `stun:external.test:U` → 0 UDP datagrams on a UDP counter |
| 9 | **QUIC / WebTransport** (UDP) | Triggered by pages | With a fixed proxy Chromium does not use QUIC; `new WebTransport()` fails. | Electron: `new WebTransport('https://external.test:U/')` → 0 UDP datagrams |
| 10 | **Service workers** (background sync, push, periodic fetches) | Can run with no visible tab | Layer 1 (no `webContentsId` needed) + layer 2. Push needs a push service Electron doesn't ship. | Electron case 3 |
| 11 | **Search, source reading, media preflight/download, download preflight** (main process) | User-triggered | Layer 5 code gate + IPC refusal. | Electron case 5, unit gate test |
| 12 | **`shell.openExternal`** | User-triggered | Refused (decision 2). | Electron case 7 |
| 13 | **New tab shortcuts** (Wikipedia, Python, MDN) | Links only; nothing is fetched until clicked | Clicking is a navigation → layer 1. | Covered by case 1 |
| 14 | **Hidden legacy-chat probe window** | Loads `sovereign://ask/…` only | Always allowed (internal scheme). | — |
| 15 | **Dataset batch mode** (`SOVEREIGN_DATASET_BATCH`, dev tool) | Search + source reading | Goes through the gated IPC handlers; refuses while Offline. | — |
| 16 | **Certificate revocation checks (OCSP/CRL/AIA)** | macOS does these in the system `trustd` process, only during a TLS connection | No TLS connection is made while Offline, so none is triggered. Outside the app otherwise (Known limits). | — |
| 17 | **Chromium telemetry, component updater, Safe Browsing, variations, network-time** | Not built into Electron | Nothing to block. | — |

##### 3.9 Audit proxy only in development builds
- Replace line ~114 with `const AUDIT_PROXY = normalizeAuditProxy(testHook('SOVEREIGN_AUDIT_PROXY', { isPackaged: app.isPackaged }));`. `testHook` already returns nothing when packaged.
- Tests: `tests/test-hooks.test.js` already shows `testHook` ignores env when `isPackaged` is true; add a case with `SOVEREIGN_AUDIT_PROXY` explicitly. In `tests/network-exits.test.js`, assert `src/main.js` reads `SOVEREIGN_AUDIT_PROXY` **only** through `testHook(` (no `process.env.SOVEREIGN_AUDIT_PROXY` anywhere). Same check for the new `SOVEREIGN_TEST_*` hooks of this task.

#### 4. Edge cases (summary; behaviour is in §2–3)
| Case | Behaviour |
|---|---|
| Switch to Offline mid-download | Download paused, labelled "Paused: Offline mode", socket closed, Resume disabled until Online. |
| Switch to Offline during model download | Setup cancelled with "Model download paused: Offline mode is on."; finished shards stay cached. |
| Switch to Offline mid-answer | Web step aborted; local generation continues; message says what happened (§3.4). |
| Tabs already open on websites | Stay visible; all further requests blocked and counted; open WebSockets closed; reload shows offline page. |
| SearXNG on localhost | Blocked while Offline even though it is loopback, because it forwards to the internet. Its origin is in `blockedOrigins`. If the user changes the endpoint while Offline, rebuild `blockedOrigins` immediately. |
| Other localhost services the user runs (dev server, a local proxy) | Blocked unless the user adds `host:port` to the Offline allowlist; Settings warns that a local service may forward to the internet. |
| Allowlisted service later becomes the SearXNG endpoint | Entry removed and the user told (§3.6). |
| `file://server/share`, LAN addresses (`192.168.x`, `10.x`), `0.0.0.0`, `::ffff:127.0.0.1` | Blocked. |
| Hostname that resolves to 127.x (`foo.nip.io`) | Blocked (we decide on the literal host, no DNS). |
| Service workers already registered on a site | Their fetches go through layer 1 and the proxy; blocked. |
| `shell.openExternal` / "open in default browser" | Refused: "Offline mode is on. Opening another app would leave Sovereign's protection." |
| Spellchecker dictionary download (Windows/Linux) | Spellchecker disabled while Offline (§3.8 row 1); restored on Online. |
| Launch with saved website tabs while Offline | Tabs restored showing the offline page; nothing loads; saved session kept. |
| Model not cached on a new install | Clear message plus [Go online and download]; nothing downloads by itself. |
| Corrupt `preferences.json` | Start Offline; banner offers the choice. |
| Audit proxy set and Offline | Audit proxy kept so mitmproxy can actually see a leak (§3.2 layer 2). |
| Rapid toggling | `set()` is idempotent; `applyNetworkModeToSession` serialised per session (chain promises like `auditProxySessions`). |
| App quit while Offline | Mode is saved; next launch starts Offline. |

#### 5. Tests (write first)
**Unit (`npm run check`):**
- `tests/network-mode.test.js` (new; add `node --check src/network-mode.js && node tests/network-mode.test.js` to `check`):
  - `offlineDecision` with the **default empty allowlist**: allowed only `sovereign://ask/`, `file:///tmp/a.pdf`, `data:`, `blob:`; blocked `http://127.0.0.1:3000/`, `ws://localhost:5173/`, `http://[::1]:8000/` (reason `local-not-allowed`).
  - With allowlist `['127.0.0.1:3000', 'localhost:5173', '[::1]:8000', 'foo.localhost:80']`: allowed `http://127.0.0.1:3000/x`, `ws://localhost:5173/`, `http://[::1]:8000/`, `http://foo.localhost/`; still blocked `http://127.0.0.1:3001/`, `http://localhost:3000/` (different host), `https://127.0.0.1/` (port 443 not listed).
  - Always blocked: `https://example.com/`, `wss://example.com/`, `http://192.168.1.10/`, `http://10.0.0.1/`, `http://0.0.0.0/`, `http://[::ffff:127.0.0.1]/`, `file://server/share/x`, `ftp://127.0.0.1/`, `not a url`, and `http://127.0.0.1:8080/search?q=x` when `127.0.0.1:8080` is in `blockedOrigins` even if it is also in the allowlist.
  - `parseAllowlistEntry`: accepts `127.0.0.1:3000`, `LOCALHOST:5173` (→ `localhost:5173`), `[::1]:8000`; rejects `192.168.1.5:80`, `example.com:80`, `127.0.0.1` (no port), `127.0.0.1:0`, `127.0.0.1:70000`, `http://127.0.0.1:3000` (scheme), the SearXNG host:port, with the §2 messages. `normalizeAllowlist` drops bad entries and caps at 20.
  - `initialNetworkState`: no file → offline/choiceMade; file without `network` → online/not chosen; valid `network` respected; invalid JSON → offline/not chosen.
  - `assertOnline` throws `OFFLINE_MODE` only when offline; `set` calls `onChange` once per real change.
- `tests/privacy-receipt.test.js` (extend): an offline receipt with no entries → summary starts `Offline: 0 external requests`; with blocked entries → `· 3 blocked (offline mode)`; blocked entries keep origin only (feed `https://example.com/search?q=SECRET123` and assert `SECRET123` appears nowhere in `getReceipts()` or `exportPayload()`); aggregation keeps one entry with `count`; one non-blocked entry → `Offline: 1 external request`.
- `tests/safe-fetch-integration.test.js` or a small new test: with the gate in the resolver/fetch wrapper, an offline call rejects with `OFFLINE_MODE` and the local test server sees **0 connections** and the resolver is called **0 times**.
- **Bypass guard** `tests/network-exits.test.js` (new): read `src/main.js` and fail if `net.fetch(`, `.fetch(`, `http.request`, `https.request`, `dns.lookup`, `shell.openExternal` or `downloadURL(` appear outside a short allow-list of wrapper functions that call `assertOnline` (or, for `downloadURL`, rely on layer 1). This keeps future code from adding an ungated exit.

**Electron: `tests/electron/offline-mode.test.js` (new; add `test:electron:offline-mode` and a `node --check` line in `check:tests`):**
- Setup: start raw TCP counting servers on 127.0.0.1 (one plain HTTP, one HTTPS using a certificate generated at test time like `safe-fetch-integration.test.js`, one WebSocket). Count **TCP connections**, not HTTP requests, so even a failed TLS handshake counts as a leak. Launch with `--host-resolver-rules="MAP external.test 127.0.0.1"` so `external.test` is treated as external by our rules but would land on the counting servers if it leaked. Use `SOVEREIGN_TEST_DNS` for the Node side (`external.test` → `93.184.216.34`, connect `127.0.0.1`). Start with `SOVEREIGN_TEST_NETWORK_MODE=offline`.
- Blocked (each asserts **0 connections** and a `blocked` receipt entry):
  1. Tab navigation to `http://external.test:P/` and `https://external.test:Q/`; the tab shows the offline message.
  2. From a loopback page (`http://127.0.0.1:R/`, allowed): `fetch('http://external.test:P/x?q=SECRET123')`, `<img>`, `new WebSocket('ws://external.test:W/')` (expect `onerror`/`onclose`), `<link rel=preconnect href="http://external.test:P">` and `<link rel=dns-prefetch>` (wait 2 s).
  3. A service worker registered from the loopback page fetches `http://external.test:P/sw`.
  4. `webContents.downloadURL('http://external.test:P/file.bin')` and the `downloads:download-url` IPC → no connection; Downloads shows "Blocked: Offline mode".
  5. IPC `search:query`, `search:read-sources`, `media:preflight`, `media:download` → `{ offline: true }`, 0 connections, and the fake SearXNG on loopback sees 0 requests.
  6. Model setup start → message "isn't on this computer yet", no request to the model host (point it at `external.test` via the existing model URL test hook if there is one; otherwise assert no `model-download` receipt entry and 0 connections).
  7. `browser:open-external` does not call `shell.openExternal` (stub it in the test) and returns the exact decision-2 message.
  8. Spellchecker (§3.8 row 1), session restore (row 6), `<a ping>` / `sendBeacon` (row 7), WebRTC STUN and WebTransport to a UDP counter (rows 8–9): 0 connections / 0 datagrams.
  9. With the **default empty allowlist**, the loopback test page itself is blocked (`local-not-allowed`, 0 connections).
- Allowed: `sovereign://ask/` loads; a `file:///` test page loads; after adding `127.0.0.1:R` through the real `network:add-allowed` IPC the loopback page loads; `ai:extract-active-page-text` returns that page's text. Adding the fake SearXNG's host:port through the same IPC is refused.
- **Each layer alone:** rerun the HTTP, WebSocket and download cases with `SOVEREIGN_TEST_OFFLINE_LAYERS=webrequest` and again with `=proxy` (preconnect only needs to pass with `proxy`). This proves the black-hole isn't the only thing stopping requests, and the reverse.
- **Mode switches:** start Online; open a WebSocket to `external.test` and start a slow download (server drips bytes). Switch to Offline: the WebSocket closes, the download shows "Paused: Offline mode", and the counting server sees no **new** connection afterwards. Switch back to Online: a new `fetch` to `external.test` **does** connect (proves the test is not vacuous).
- **Receipt:** after the blocked cases, the latest Offline receipt summary starts `Offline: 0 external requests`, entries say `blocked (offline mode)`, and `JSON.stringify(privacy:get-receipts)` plus the export payload do not contain `SECRET123`.
- **Prefs:** a run with no `preferences.json` starts Offline and shows no banner; a run with an old `preferences.json` (no `network`) starts Online and shows the banner once; clicking "Stay online" and relaunching shows no banner.
- **Regression:** `ui-smoke`, `browser-features`, `downloads`, `media-chat`, `safe-redirects`, `permissions`, `ask-layout` must still pass. They run Online: set `SOVEREIGN_TEST_NETWORK_MODE=online` in their launch env, because a fresh test profile would otherwise start Offline.

#### 6. Privacy impact
- **Positive:** a single switch that stops every request this app can make, enforced in the network stack (layers 1–4) and in main-process code (layer 5), not just hidden in the UI.
- **No new network requests.** Nothing in this task adds traffic; the banner, toggle and messages are local.
- **New stored data:** `preferences.json` gains `network: { mode, choiceMade, offlineAllowlist }`. Only `host:port` strings the user typed; no content.
- **Closes a dev-only leak path:** a packaged build can no longer be pointed at a proxy through `SOVEREIGN_AUDIT_PROXY`.
- **Spellchecker** stops while Offline (on Windows/Linux it would otherwise fetch dictionaries).
- **Receipts store less, not more:** blocked entries keep only the origin and a count, never the path, query or question text.
- **No cloud fallback** is involved; Ask AI still runs only on WebLLM.

#### 7. Known limits (for CHANGES and REVIEW to state plainly)
- Other apps and the OS (for example macOS background services) are outside this app. Offline mode covers Sovereign's own traffic only. Turning Wi-Fi off is still the only machine-wide switch.
- Pages already on screen keep whatever they had loaded before the switch; we don't wipe them.
- Layer 3 (DNS) may be dropped if the probe in §3.2 fails; layers 1 and 2 cover it.
- A local service the user adds to the Offline allowlist may forward to the internet. Settings warns about this; we can't see past it.
- The spellchecker download test only runs on Windows/Linux; on macOS there is no download to test.

#### 8. Do not change
- The safe-redirect logic in `safe-fetch.js` (only add the gate around its callers / resolver).
- Online behaviour: with the mode Online, every existing test and receipt must behave exactly as today.
- WebLLM model code and the model cache.
- Permissions handling, chat storage and deletion.

#### 9. Manual tests (Sandeep)
1. **Fresh profile:** move `~/Library/Application Support/Sovereign/preferences.json` aside (or use a new `--user-data-dir`). Launch: the toolbar says **Offline**, no banner. Ask AI with no model cached shows the "isn't on this computer yet" message. Click [Go online and download]: the toolbar flips to Online and the download starts.
2. **Existing profile:** put the old `preferences.json` back. Launch: toolbar says **Online** and the banner shows. Click "Stay online", relaunch: no banner.
3. **Allowlist:** with Offline on, run `python3 -m http.server 3000` and open `http://127.0.0.1:3000/`: it shows the "isn't on your Offline allowlist" message. In Settings add `127.0.0.1:3000` (read the warning): reload, it loads. Try adding `192.168.1.5:80`, `127.0.0.1` and `127.0.0.1:8080` (SearXNG): each is refused with its message. Remove the entry: reload is blocked again.
4. **Wi-Fi off, Offline on:** with the model cached, turn Wi-Fi off. Check: Ask AI answers a plain question; attach a PDF and ask about it; open a `file:///` page or an already-open tab and use it as the source; the sidebar summary works. "Search the web" and image buttons are disabled with the note. Sovereign Search shows the offline message.
5. **Wi-Fi on, Offline on, mitmproxy:** run mitmproxy in local-capture mode so Node-side requests are caught too, not only the browser proxy: `mitmproxy --mode local:Electron` (macOS; mitmproxy 11+). Also run `sudo tcpdump -n -i any 'port 53 or udp'` in another terminal. Launch Sovereign and turn Offline on. Visit 3–4 websites from the address bar, try Search, an image question, a download link, a page with a video call (WebRTC), and Ask AI with an attachment. Expect: **mitmproxy records 0 flows** from Sovereign; tcpdump shows no DNS or UDP from Sovereign; the Privacy Receipt says **"Offline: 0 external requests"** and lists the attempts as **"blocked (offline mode)"**, with origins only and no question text. Then also try with `SOVEREIGN_AUDIT_PROXY` set to mitmproxy's regular port (`npm start`, not packaged): still 0 flows. Also click a link that would open in the default browser: the decision-2 message appears and no browser opens.
6. **Switching mid-way:** Online, start a large download and an Ask AI answer with Search the web on. Switch to Offline during each: the download shows "Paused: Offline mode"; the answer shows the "web search was stopped" message. Switch back to Online and click Resume: the download continues.
7. **Open tabs:** Online, open a site with live updates (a chat or news ticker). Switch to Offline: the page stays, stops updating, and blocked entries appear in the receipt. Reload: offline message.
8. **Local SearXNG:** with SearXNG running on `127.0.0.1:8080` and Offline on, search does nothing and the SearXNG container log shows no new request.

#### Round 2 PLAN (Claude, 2026-11-10): Sandeep's decisions on the open questions
1. **Confirm before reloading website tabs.** Keep the reload on switch to Offline. Before switching, if N > 0 tabs show an `http(s)` page that `networkDecision` would block (a tab that would be reloaded), ask: **"Switching to Offline will reload N open website tabs. Unsaved text in forms may be lost."** with **[Continue] / [Cancel]**. Use "tab" for N = 1.
   - Enforce it in main, so every entry point (toolbar toggle, the Settings radio, the banner's "Turn on Offline mode") gets it. `network:set-mode` / `network:dismiss-intro` with `'offline'` and no `{ confirmed: true }` return `{ ok: false, needsConfirm: true, tabCount: N, message, state }` **without changing anything** when N > 0. Callers show the question in-app (not a native dialog, so tests can drive it), then call again with `{ confirmed: true }` on Continue. Cancel leaves the mode Online, and the Settings radio goes back to Online. With N = 0 the switch happens at once, as today.
   - Switching to Online, the startup mode and test hooks are unchanged. Any internal `setNetworkMode('offline')` call in main that does not come from these IPCs must be listed in CHANGES.
   - Test (Electron, offline-mode): Online with one website tab, `network:set-mode('offline')` returns `needsConfirm` with `tabCount: 1`, the mode stays Online and the tab is not reloaded. With `{ confirmed: true }` it switches. With no website tabs it switches at once.
2. **Disable QUIC for the whole app.** `app.commandLine.appendSwitch('disable-quic')` at startup before `ready`, next to the other startup switches. This closes the WebTransport/QUIC loopback gap and every QUIC path in both modes. Cost: sites that support HTTP/3 fall back to HTTP/2 over TCP when Online, which is slightly slower on lossy networks. Tests: `network-exits` asserts the switch is in `main.js` at top level (outside any function). The Electron offline-mode test asserts `app.commandLine.hasSwitch('disable-quic')` in the app process (or equivalent). It also adds a WebTransport case to a **loopback port that is not on the allowlist**, while Offline, aimed at the UDP counter: 0 datagrams.
3. **Known limit:** a running service worker may keep a connection it already had open.
4. **Keep:** going Offline mid-answer stops the answer (deviation 3 is accepted).
5. **Known limit:** removing an allowlist entry doesn't close an already-open WebSocket to that local address (local only).
6. **Known limit, made visible.** When a receipt drops entries over `MAX_ENTRIES_PER_RECEIPT` (both trims in `privacy-receipt.js`), count them in a new `droppedEntries` field. Keep it in `sanitizeReceipt` and `exportPayload`. Where the receipt rows are rendered (`ask.js`, `search.js`), show a last row **"N older entries not shown"** (N ≥ 1, "entry" for 1). Unit test in `privacy-receipt.test.js`: add 125 distinct entries to one receipt, then `droppedEntries === 5` and the export has it. The summary text does not change.

#### Round 2b PLAN (Claude, 2026-11-10): replaces item 2 (Sandeep's decision after the probe in REVIEW)
1. **Remove `disable-quic`** from `main.js`, along with its checks in `network-exits.test.js` and `offline-mode.test.js`. HTTP/3 stays on when Online, as before this task.
2. **Offline CSP (layer 6).** Add a `webRequest.onHeadersReceived` listener in `setupNetworkMonitorForSession` (no session has one today, and Electron allows one per session). While Offline (and when `offlineLayerOn('webrequest')`), add an **extra** `Content-Security-Policy` header to every `http:`/`https:` response, without touching the site's own CSP headers. Browsers enforce every CSP header, so this can only tighten. The header is `connect-src` followed by the page's own origin in its `http(s)` and `ws(s)` forms, then each allowlisted `host:port` in `http://`, `https://`, `ws://` and `wss://` forms. Online, the listener passes headers through unchanged. Put the header builder in `src/network-mode.js` as `offlineConnectSrc(pageUrl, allowlist)` and unit-test it (bracketed IPv6, default ports, empty allowlist → only the page's own origin).
   - Why it is enough: while Offline, the only `http(s)` documents that can load are allowlisted loopback pages, and switching to Offline reloads http(s) tabs, so every live web page has the header. `connect-src` covers fetch/XHR/WebSocket/EventSource/beacon **and WebTransport**, which `webRequest` never sees.
3. **Make the confirm count match the reload.** `offlineReloadTabCount` counts only blocked tabs, but `reloadWebTabsForOffline` reloads every `http(s)` tab, allowlisted ones included. Count exactly the tabs that will be reloaded (share one helper).
4. **Tests.** Codex's case `WebTransport to unallowlisted loopback UDP port` must now pass (0 datagrams). Add an **Online control** in the mode-switch phase: the same WebTransport makes at least 1 datagram, so the case isn't vacuous. The allowlisted page's own probes (same-origin fetch, local page text) must still pass. Unit tests for `offlineConnectSrc`.
5. **Known limit:** a `file:///` page can still open WebTransport to a loopback port (no response headers to attach a CSP to). Local only.

### CHANGES (Codex)
#### Round 2b (Codex, 2026-11-10)
- **Files changed:** `src/main.js`, `src/network-mode.js`, `tests/network-mode.test.js`, `tests/network-exits.test.js`, `tests/electron/offline-mode.test.js`; only this task's CHANGES section in `docs/HANDOFF.md`.
- **Items 1–2:** Removed the startup `disable-quic` switch/comment and its VM/runtime assertions. HTTP/3 remains available Online. Added/exported `offlineConnectSrc(pageUrl, allowlist)` and installed the session response listener: Offline + webrequest layer + HTTP(S) responses get an additional `connect-src` policy containing the response origin and its WebSocket form, plus all four schemes for each allowlisted host:port. Existing CSP values and other headers survive, regardless of header-name case. Other responses use `callback({})`. No new application network requests.
- **Item 3:** `webTabsForOfflineReload` selects live HTTP(S) tabs across windows for both confirmation counting and reloading, including allowlisted local tabs.
- **Tests first:** Builder tables cover empty allowlists, HTTP/HTTPS default ports, explicit ports and bracketed IPv6. New VM tests execute the real listener for existing CSP casing, missing CSP, preserved unrelated headers, Online/layer-disabled/non-HTTP pass-through, and the shared count/reload selection. The new builder and listener tests failed before implementation and pass now. Electron confirmation now includes an allowlisted tab; same-origin fetch and local-page text probes remain checked. Loopback WebTransport must send zero datagrams with the full stack and webrequest-only layer; proxy-only intentionally omits this loopback assertion because it disables CSP and bypasses loopback. The mode-switch phase reloads the page Online to discard its document CSP, suppresses automatic probes, and requires at least one datagram from WebTransport to the same UDP counter before running STUN. The final Online fetch control also reloads to discard CSP.
- **Validation:** Ran `npm run check` after test and implementation changes and after this handoff update. It reaches `safe-fetch-integration.test.js` then fails on the sandbox's `listen EPERM` for 127.0.0.1. Direct `node tests/network-mode.test.js`, `node tests/network-exits.test.js`, `node tests/privacy-receipt.test.js`, `node --check` on all five changed JavaScript files, and `npm run build:ai` pass. Electron and separate socket tests were not run; Claude must validate runtime UDP behavior outside the sandbox. No commit, push or git-config changes.
- **Manual / outside-sandbox checks:** Run `npm run check` and `npm run test:electron:offline-mode`. Online with an allowlisted local website open, request Offline: confirmation must include that tab; Cancel preserves it and Continue reloads it. Offline same-origin fetch/text should work, while WebTransport to an unallowlisted loopback UDP counter sends zero datagrams. Reload Online and verify the same WebTransport sends at least one. **Known limit:** `file:///` pages have no response header for this CSP and can still open loopback WebTransport.

#### Round 2 (Codex, 2026-11-10)
- **Files changed:** `src/main.js`, `src/preload.js`, `src/index.html`, `src/renderer.js`, `src/settings.html`, `src/settings.js`, `src/styles.css`, `src/privacy-receipt.js`, `src/ask.js`, `src/search.js`; `tests/privacy-receipt.test.js`, `tests/network-exits.test.js`, `tests/electron/offline-mode.test.js`; this CHANGES section only.
- **Item 1:** Both mode-changing IPCs require confirmation before an Online → Offline transition when blocked HTTP(S) website tabs are open, counted across windows using `networkDecision`. The exact question uses singular/plural tab wording; the response includes `ok: false`, `needsConfirm`, `tabCount`, `message`, and unchanged state, before preferences/mode/reloads change. Preload forwards optional `{ confirmed: true }`. Toolbar/banner use an in-app Continue/Cancel strip in the intro area, accounted for in chrome height; Settings shows the question inline and restores the Online radio while awaiting confirmation. Cancel leaves Online; Continue repeats the original action with confirmation. Theme variables provide light/dark colors. Zero blocked website tabs switch immediately. Existing reload behavior (including allowlisted HTTP(S) tabs) is retained. Online, startup and test-hook behavior are unchanged. **Internal `setNetworkMode('offline')` bypass calls: none**; the only callers are the two guarded IPC handlers.
- **Item 2:** Top-level `app.commandLine.appendSwitch('disable-quic')` runs immediately after importing Electron, before ready. QUIC/WebTransport is disabled in both modes, including loopback. **Online cost:** HTTP/3-capable sites fall back to HTTP/2 over TCP, slightly slower on lossy networks. No new network requests were added.
- **Item 6:** Both receipt trim paths accumulate omitted rows in `droppedEntries` (aggregated blocked attempts do not inflate it). Sanitized receipts and exports preserve the count. Ask and Search append “N older entries not shown” (singular “entry” for 1); summary logic is unchanged. Items 3–5 need no code and were left unchanged.
- **Tests first:** New receipt tests initially failed for the missing field; new startup QUIC test initially failed for the missing switch. Receipt tests cover 125 distinct ordinary and blocked rows → 120 retained / 5 dropped, export preservation, and aggregation without another drop. `network-exits` executes the startup prefix in a VM to require the QUIC switch at top level. Electron adds a confirmation phase for immediate switching with no website tabs, both IPCs returning confirmation for one website tab without changing mode/reloading, toolbar Cancel, and confirmed switching/reload. It asserts the running app's QUIC switch and probes WebTransport to an unallowlisted loopback UDP port with zero datagrams; the old proxy-only WebTransport comment was corrected. Existing mid-download switch explicitly confirms.
- **Validation:** `npm run check` was run after test, implementation and follow-up changes. After implementation it passes the earlier checks then fails at `tests/safe-fetch-integration.test.js` with sandbox `listen EPERM` on 127.0.0.1. Direct `node tests/privacy-receipt.test.js`, `node tests/network-mode.test.js`, `node tests/network-exits.test.js`, `node --check` for every changed JavaScript file (including the Electron test), and `npm run build:ai` pass. HTML/CSS/Markdown are not inputs to `node --check`. Electron tests were **not run**, as requested; runtime/UI/UDP validation remains for Claude outside the sandbox. No commit, push or git-config changes.
- **Manual test:** Online with an ordinary website containing unsaved form text, try Offline from the toolbar, first-run banner, and Settings. Verify the exact count/question, Cancel preserves the page/text and Online radio, Continue switches/reloads, and no website tabs switch immediately. Check the strip at compact widths in light/dark themes. With more than 120 receipt rows, check the final omission row in Ask/Search and `droppedEntries` in exported JSON. Claude should run `npm run check` and the Electron offline-mode suite outside the sandbox.

#### Recovery round (Codex, 2026-11-10)
- `tests/network-mode.test.js`: rewrote the dense checks as readable `[input, expected]` tables covering internal/local URLs, default-empty and explicit allowlists, every blocked reason, blocked-service precedence, loopback/LAN/mapped-address classification, exact allowlist validation errors (including a custom audit-proxy error), normalization/deduplication and the 20-entry cap, all four preference-start states, and mode transitions with exact callback arguments, return values and offline error purpose.
- `tests/offline-gate-integration.test.js` (new): extracts the real `safeFetchResolve` and `gatedSafeFetch` bodies into a VM with real `safeFetch`, a counting development DNS mapping and a raw TCP server on 127.0.0.1. Asserts both Offline gates reject with `OFFLINE_MODE`, zero resolver calls and zero connections; an Online fetch must return HTTP 200 / `ok`, resolve once and make exactly one TCP connection. All traffic is loopback-only; no OS DNS or external service is used. The server and sockets are cleaned up on failure too.
- `package.json`: adds the new socket test immediately after `network-exits` in `check`.
- `tests/privacy-receipt.test.js`: moved only the success log after the offline assertions; all assertions unchanged.
- `docs/HANDOFF.md`: added this recovery subsection only. No `src/` bug found or source fix made; no commits.
- Validation: `npm run check` exits **1**, because the existing `tests/safe-fetch-integration.test.js` cannot bind 127.0.0.1 in this sandbox (`listen EPERM`). The new socket test independently encounters the same restriction, so its runtime assertions remain unverified here; no test was skipped or weakened to hide the failure. `network-mode`, `network-exits`, and `privacy-receipt` pass when run directly; the new test passes `node --check`. Electron tests were not executed.
- To finish validation outside the sandbox: run `npm run check` (the new test must print its success line after verifying the Online control). Claude runs the Electron suite. Manual feature checks remain PLAN §9, especially Offline allowlist add/remove and switching Online.

**Built by Claude (Codex unavailable).** Codex hit its usage limit after writing the first unit tests (`tests/network-mode.test.js`, `tests/network-exits.test.js`, the `privacy-receipt` and `test-hooks` additions). Sandeep asked Claude to finish the build (2026-11-10). Codex's tests were kept as the spec; one fix to the `network-exits` helper (it dropped the `async` keyword when extracting a function body).

**Files**
- New: `src/network-mode.js` (rules: loopback check, allowlist parsing, `offlineDecision`, start state, `createNetworkMode`), `tests/electron/offline-mode.test.js`.
- New (Codex): `tests/network-mode.test.js`, `tests/network-exits.test.js` (+1 entry `chrome-error:` added by Claude).
- Changed: `src/main.js`, `src/privacy-receipt.js`, `src/preload.js`, `src/renderer.js`, `src/index.html`, `src/ask.js`, `src/ask.html`, `src/search.js`, `src/settings.js`, `src/settings.html`, `src/downloads.js`, `src/styles.css`, `package.json`, `tests/privacy-receipt.test.js`, `tests/test-hooks.test.js`, and one line in each existing `tests/electron/*.test.js` (`SOVEREIGN_TEST_NETWORK_MODE ||= 'online'`).

**How the PLAN was met**
- **Switch (§2):** toolbar button `#network-mode-toggle` ("Offline"/"Online", `aria-pressed`), Network section in Settings (radio pair + allowlist). New installs start Offline; existing installs stay Online and see a one-time strip (42px, added to the chrome height like the find bar); unreadable preferences start Offline. `SOVEREIGN_TEST_NETWORK_MODE` also counts as "choice made" so regression tests don't show the strip.
- **Allowlist (decision 1):** empty by default, `host:port` on loopback only, max 20, SearXNG and audit-proxy host:port refused, warning text as in §2. Changing the SearXNG endpoint to an allowlisted host:port removes the entry and Settings says so.
- **Layer 1:** first check in the single `onBeforeRequest` listener, now installed per session (`setupNetworkMonitorForSession`, via `trackNetworkSession` for the default session, `session-created` and `web-contents-created`).
- **Layer 2:** proxy `127.0.0.1:9`, empty bypass list (Chromium bypasses loopback implicitly). Audit proxy kept when set. Restored to the audit proxy or `system` when Online.
- **Layer 3 (DNS):** `app.configureHostResolver({ secureDnsMode: 'secure', secureDnsServers: ['https://127.0.0.1:9/dns-query'] })`; restore `automatic` (Electron's default). **Probe result:** the call works after `ready`; `localhost` still loads; `example.com` fails with `ERR_NAME_NOT_RESOLVED`; after restore it resolves. Layer kept.
- **Layer 4:** `disable_non_proxied_udp` on every web contents. Probe: 4 STUN datagrams with `default`, 0 with the policy (with or without a proxy).
- **Layer 5:** `assertOnline` in `safeFetchResolve`, `gatedSafeFetch` (the only caller of `safeFetch`), `makeReceiptFetch`, `fetchForDownloadPreflight`, `openExternalOnline`; search/media/source IPC refuse first and record the blocked origin.
- **Decision 2:** `browser:open-external` is now `ipcMain.handle`; Offline returns `{ ok: false, offline: true, error: "Offline mode is on. Opening another app would leave Sovereign's protection." }` and shows it in the window's status line (exposed as `window.sovereign.openExternal`; nothing called this IPC before).
- **Decision 3:** `AUDIT_PROXY` read through `testHook`, so it is ignored when packaged; `network-exits` asserts no `process.env.SOVEREIGN_AUDIT_PROXY` and the `testHook(...)` form; `test-hooks` test covers it.
- **Decision 4:** spellchecker disabled per session while Offline (synchronously in `session-created`, before preferences load, then restored if Online); previous value restored when Online.
- **Receipts (§3.5):** category `blocked`, origin only, `whatWasSent: 'blocked (offline mode) – nothing sent'`, aggregated per origin + resource type with `count`; unattributed attempts go to a rolling "Offline mode" receipt; `offline` flag; summary `Offline: N external requests` computed from entries.
- **Model (§2):** Offline runs only the cache check; a check that turns into a download is cancelled ("Model download paused: Offline mode is on."); toolbar chip and Ask card show the not-downloaded message with **Go online and download** (switches mode visibly, then starts).
- **Downloads (§3.3):** `will-download` check kept as a backstop; switching to Offline pauses non-allowed downloads as "Paused: Offline mode", Resume disabled (UI and IPC) until Online.

**§3.8 background requests (outcome)**
| # | Source | Result |
|---|---|---|
| 1 | Spellchecker | Disabled while Offline, restored Online (Electron test). Download half of the test is skipped on macOS (no download there). |
| 2–3 | Auto-update, crash reporter | Not present; `network-exits` guard fails if added without `assertOnline`. |
| 4 | Favicons | None by the app; page icons are subresources (layer 1). |
| 5 | Model auto-download | Cache check only (Electron test, fresh profile). |
| 6 | Session restore | Tab kept, 0 connections (Electron test). |
| 7 | Preconnect, dns-prefetch, ping, beacon | 0 connections in all-layer and proxy-only runs. |
| 8 | WebRTC STUN | 0 datagrams Offline vs 4 Online (Electron test). |
| 9 | QUIC / WebTransport | **Not seen by `webRequest` at all** (probe). Stopped by layer 2 for non-loopback hosts (0 datagrams with all layers). See REVIEW. |
| 10 | Service workers | Install fetch blocked (all three runs). |
| 11–12 | Main-process exits, open in another app | Refused (Electron test). |
| 13–17 | New-tab links, probe window, dataset mode, OCSP, Chromium telemetry | As planned; nothing new found in the grep. |

**Deviations from the PLAN**
1. **Web tabs are reloaded when switching to Offline.** Probe (Electron 38): `closeAllConnections()`, `enableNetworkEmulation({ offline: true })` and DevTools offline emulation all leave an open WebSocket open (page still `readyState 1`). `reloadWebTabsForOffline()` reloads every tab showing an `http(s)` page; a blocked page then shows the offline message, an allowlisted local page loads again. Unsaved form text on those pages is lost.
2. Search/media/source IPC **throw** an `OFFLINE_MODE` error with a readable message instead of returning `{ ok: false, offline: true }`; the pages show it. The UI disables these controls first, so this is the backstop.
3. Mid-answer: the web step is stopped and the answer ends with "Offline mode turned on, so the web search was stopped. Ask again to answer from your files and open pages." It does not continue from sources already read.
4. Downloads blocked by layer 1 never reach `will-download`, so they don't get a "Blocked: Offline mode" row; a link click shows the offline message in the status line, and the Downloads URL box shows the offline error.
5. `setOffline(false)` clears the `offline` flag on all receipts, not only open ones; blocked entries keep their label and count.

**Tests**
- `npm run check`: **exit 0** (includes `network-mode`, `network-exits`, extended `privacy-receipt` and `test-hooks`).
- `npm run test:electron:offline-mode`: **ok** in all 7 phases: `main` (all layers), `webrequest` only, `proxy` only, `fresh`, `old`, `old-again`, `corrupt`. Counters count raw TCP connections and UDP datagrams. Main summary: `Offline: 0 external requests · 3 blocked (offline mode) · AI generated locally`.
- Regression (Electron, Online): `ui-smoke`, `browser-features`, `downloads`, `media-chat`, `safe-redirects`, `permissions`, `ask-layout`, `attachments`, `home-attachments`, `pdf-attachments`, `chat-deletion`, `single-instance`, `stage1-usability`: all exit 0. Not run: `model-chat`, `generation-shutdown`, `auto-setup-shutdown`, `media-chat-live` (need the real model or the internet).

### REVIEW (Claude)
#### Round 2b review (2026-11-10): DONE, ready for manual testing
- **Sandeep's decision after the probe:** use the Offline CSP and remove `disable-quic`. Both are done. The `onHeadersReceived` listener adds `connect-src` (`offlineConnectSrc`, unit-tested) only while Offline. Online it passes headers through unchanged and never replaces the site's own CSP. The confirm count and the reload now share `webTabsForOfflineReload`, so N is exactly the number of tabs that reload.
- **Fixed by Claude (test only):** Codex's Online WebTransport control ran just before the switch to Offline. A probe showed that Chromium keeps retransmitting an unanswered QUIC handshake for about 4 s after `close()`, so a leftover datagram failed the "no STUN after Offline" check (9 vs 8). I moved the control to the end of the test, after the final switch back to Online. No `src/` change.
- **Results (outside the sandbox):** `npm run check` exits 0. `test:electron:offline-mode` passes all 8 phases (main, webrequest, proxy, confirm, fresh, old, old-again, corrupt). Offline WebTransport to a loopback port that is not on the allowlist sends 0 datagrams; the Online control sends 1. The 13 Electron regression tests (run Online, same list as the recovery round) all exit 0.
- **No MUST FIX.**

#### Known limits (final, Sandeep's decisions 2026-11-10; in addition to PLAN §7)
1. **Service workers:** a running service worker may keep a connection it already had open. Its new requests are blocked.
2. **Mid-answer:** going Offline stops the answer; it does not continue from sources already read (accepted).
3. **Allowlist removal:** removing an entry doesn't close an already-open WebSocket to that local address (local only).
4. **Receipts:** past `MAX_ENTRIES_PER_RECEIPT`, older entries are dropped, and the receipt shows "N older entries not shown".
5. **WebTransport/QUIC connections to local (127.0.0.1) ports not on the allowlist are not blocked in Offline mode; they stay on this computer, but a local service could forward them.** (Sandeep, 2026-11-10.) Scope today: the Offline CSP (Round 2b) blocks this for every `http(s)` page, and the Electron test checks it (0 datagrams). What's left is `file:///` pages (no response headers to carry the CSP) and handshakes started while Online (item 6). **No switch disables WebTransport in Electron 38.8.6.** Claude's probe used an http page and a `file:///` page with a UDP counter, checking `typeof WebTransport` and counting datagrams. All of these left WebTransport working (`function`, 4–5 datagrams): no switch, `--disable-blink-features=WebTransport` and `--disable-features=WebTransport` on the command line, `appendSwitch` with `disable-blink-features=WebTransport` and with `disable-features=WebTransport,WebTransportDedicatedConnection`, `webPreferences.disableBlinkFeatures: 'WebTransport'`, and `--disable-quic`. So no switch was added.
6. **In-flight QUIC handshake:** a QUIC/WebTransport connection attempt started while Online can keep retransmitting its handshake packet for a few seconds after switching to Offline (seen with loopback, about 4 s). No new content is sent.
7. **Pages loaded while Offline** keep the Offline CSP after switching back to Online, until they are reloaded. It only restricts them.
8. **Tab reload on switch to Offline** costs unsaved form text; the user is asked first (Continue / Cancel).
9. The spellchecker download test runs only on Windows/Linux.

#### Round 2 review (2026-11-10): items 1 and 6 DONE; item 2 BLOCKED on a decision (resolved by Round 2b)
- **Item 1 (confirm before reload): OK.** Enforced in main (`setNetworkMode` with `requireConfirm` for both IPCs), so the toolbar, banner and Settings all get it. Cancel leaves the mode Online and changes nothing. The confirm strip is counted in the chrome height. The Electron test covers `needsConfirm`/`tabCount: 1` → no switch, then `{ confirmed: true }` → switch.
- **Item 6 (`droppedEntries`): OK.** Both trims count dropped entries. The field is kept in sanitize/export, and a last row reads "N older entries not shown" in Ask and Search. The unit test checks 125 entries → 5.
- **Item 2 (QUIC): the PLAN's fix does not work.** `npm run check` exits 0, but `test:electron:offline-mode` **fails** on Codex's new case: `WebTransport to unallowlisted loopback UDP port sends nothing`, 3 datagrams instead of 0. I checked it with a separate probe (Electron 38, loopback page, UDP counter): WebTransport to a loopback UDP port sends **4 datagrams** with `disable-quic`, with `disable-quic` + the black-hole proxy + `disable_non_proxied_udp`, with `disable-features=WebTransport`, and with `disable-blink-features=WebTransport`. The only thing that stopped it was an injected `Content-Security-Policy: connect-src 'self'` response header: **0 datagrams**. The `disable-quic` switch is still in `main.js` (it does turn off HTTP/3), but it doesn't close the gap it was added for. Waiting for Sandeep: an Offline-only CSP `connect-src` (self + allowlisted origins) on http(s) documents, or accept the loopback-only gap as a known limit, and whether to keep `disable-quic`.

#### Recovery round review (2026-11-10): DONE, ready for manual testing
Build–review round 1 of 2 was enough, so no second round was needed. Codex made no `src/` changes in this round.
- **Tests now match PLAN §5.** `network-mode.test.js` checks every table row with its exact `reason` and error message. `offline-gate-integration.test.js` runs the real gate code against a real TCP server: Offline gives 0 resolver calls and 0 connections, and an Online control gives exactly 1 of each, so the test is not vacuous. One small point: the test uses its own audit-proxy message as a fixture, while `main.js` uses "The audit proxy can't be allowed in Offline mode.". The test only checks that a custom message is passed through, so this is fine.
- **Run outside Codex's sandbox:** `npm run check` exits 0. `test:electron:offline-mode` passes all 7 phases, with summary `Offline: 0 external requests · 3 blocked (offline mode) · AI generated locally`; STUN sends 4 datagrams Online and 0 Offline. The 13 Electron regression tests (ui-smoke, browser-features, downloads, media-chat, safe-redirects, permissions, ask-layout, attachments, home-attachments, pdf-attachments, chat-deletion, single-instance, stage1-usability) all exit 0.
- **Re-read the full diff against the PLAN.** I found no MUST FIX. Two minor points, added to the open questions:
  5. Removing an allowlist entry while Offline drops pooled connections but not a WebSocket that a tab already has open to that local address. The tab is not reloaded, unlike the switch to Offline. This is loopback only. Should we fix it now (reload tabs on that origin) or note it as a known limit?
  6. `addBlocked` still trims the oldest entries once a receipt has more than `MAX_ENTRIES_PER_RECEIPT` distinct blocked origins/types. A page that calls many different hosts could push older entries out of an Ask receipt. Grouping by origin makes this unlikely, but it can still happen.

#### Earlier self-review (before the shutdown)
Reviewed 2026-11-10 against the PLAN and the review decisions. Because Claude also built this round (Codex unavailable), this is a self-review; Sandeep's manual test is the independent check.

**Verdict:** meets the PLAN with the deviations listed in CHANGES. Ready for manual testing.

**Found and fixed during review**
- The tests were weaker than they looked: the `webrequest`-only run never loaded the local page (not allowlisted), so its subresource checks proved nothing; and the WebRTC check had no Online baseline. Fixed: every phase allowlists the page and asserts the probes ran; STUN is measured Online (4 datagrams) and Offline (0).
- Strengthening the test exposed that **WebTransport bypasses `webRequest`** (§3.8 table, row 9 in CHANGES). Layer 1 alone is not enough for QUIC; layer 2 covers non-loopback hosts.
- Switching to Offline mid model download only cancelled when auto-download was on. Fixed.
- The offline model text stayed after going Online. Fixed.
- "Stay online" kept Offline after a corrupt-preferences start. Fixed.
- `chrome-error://` error pages were being logged as blocked attempts. Now allowed (local).

**Open questions for Sandeep**
1. **Reloading web tabs on switch to Offline** (deviation 1): needed to close open WebSockets; costs unsaved form text on web pages. Accept, or prefer closing those tabs, or leave pages alone and list WebSockets as a known limit?
2. **WebTransport/QUIC to a loopback port that is not on the allowlist** is not blocked (it never reaches `webRequest`, and the proxy bypasses loopback). It stays on this computer, but it does bypass the allowlist. Accept as a known limit?
3. **Running service workers** can't be stopped in Electron 38; their new requests are blocked, but a connection they already held open survives until the worker stops. Accept as a known limit?
4. Mid-answer (deviation 3): keep the simple stop, or build "continue from sources already read"?

**Known limits (in addition to PLAN §7)**
- Items 2 and 3 above, until answered.
- The spellchecker download test runs only on Windows/Linux.
- The DNS check in the manual test (tcpdump) has not been run yet.

## Task: Sensitive-topic guard (Phase 1, Task 1b)
Status: **ready for manual testing** (not committed). Branch: `phase-1/sensitive-guard` (from `main` after Task 1a was merged, PR #7).

**Crisis text approved (Sandeep, 2026-11-10)** with one change, applied in §4.4: the last line of `CRISIS_REPLY` is now "You can keep writing here if it helps, and please reach out to one of the people above too." `CRISIS_SHORT_LINE` is approved as written.

**Plan review decisions (Sandeep, 2026-11-10), applied below:**
1. Receipts keep the query actually sent after "Search anyway". Those receipts are deleted with their chat and by Clear history (§4.5).
2. Crisis resources, in this order: local emergency number; US and Canada 988 (call or text); UK and Ireland Samaritans 116 123; Australia Lifeline 13 11 14; elsewhere findahelpline.com. The text is warm and short, encourages reaching out now, and makes no promises about confidentiality. Numbers are re-verified before each release (§4.4).
3. Landmark addresses are flagged; no allowlist (§5 row 49, §8).
4. The Search page offers **"Ask AI locally instead"** (§3).
5. **Strict is the default**, with Standard as an option (§3, §4.1, §4.2, §4.6, §5).

### PLAN (Claude)

#### 1. Goal and scope
Sensitive questions never leave the laptop unless the user deliberately chooses. This applies in **Online** mode: Offline mode (Task 1a) already blocks every request. Crisis handling (§4.4) applies in **both** modes and in local-only chats, because it changes the reply, not only the network.

"Leave the laptop" means: the SearXNG query (`search:query`, `search:media`), and source reading / media fetches that follow from that query (`search:read-sources`, `media:preflight`, `media:download`). Today these are the only places where question text, or URLs derived from it, leave the app. Chat history stays local (`chat-store.js`) and is out of scope.

#### 2. What exists today (verified in code)
- **Web toggle.** `#web-toggle` in `ask.html` has no `checked` attribute, so it starts off. But `applySeedQuestion` (`ask.js` ~2645) turns it on when the page URL has `?web=1`, which `main.js` adds from `options.web` (~3058, ~4694, ~3227). Nothing in `src/` passes `web: true` today, but the path exists. `answerQuestion` reads `options.webEnabled`.
- **Web entry points (all reach main through IPC):**
  - Ask AI: `streamWebAnswer` → `search:query` → `search:read-sources`. `streamMediaAnswer` → `search:media` → `media:preflight` / `media:download`. The "Search web for images" button (`runInlineMediaSearch`) turns the toggle on as consent.
  - Sovereign Search page: `search.js` ~316 → `search:query`. It is reached from the toolbar search, the new-tab search box (`browser:open-search`, mode `search`), and **any text typed in the address bar that is not an address** (`address-input.js`: text with a space → `search`). So the address bar is a web-search entry point.
  - Dataset batch mode (dev tool) uses the same `handleSearchQuery` path.
- **Main handlers:** `handleSearchQuery` (~5017) creates a receipt with `query` (full text, ≤300 chars), pushes `requestActivityEntry({ endpoint, query })` to the activity feed, and calls `searchSearxng` with `whatWasSent: 'Search query: …'`. `search:media` (~5084) and `handleReadSources` (~5203) follow the same pattern. `refuseWebWhileOffline` already shows how to refuse early.
- **Local model:** runs in the renderer only (`getEngineApi().summarize(messages, onChunk)` in `ask.js`). Main cannot call it. The system prompt is in `chat-prompt.js` (UMD, loaded in `ask.html`). `media-intent.js` is the pattern for a UMD rules module shared by main and renderer.
- **Receipts:** `createReceipt({ query })` stores the question. Task 1a added the `blocked` category (origin only, `count`) and `droppedEntries`.
- **Settings:** `settings.html` has Appearance, Network, Startup, Search Backend, Local Model and Downloads. Preferences live in `userData/preferences.json`.
- No test hook gives a fake model. Electron tests that need answers from the model are skipped without the real model (`model-chat` and others).

#### 3. Behaviour (what the user sees)
1. **Search the web is off in every new chat**, Online too. It is never turned on by a URL parameter, a saved preference or a previous chat. Turning it on is a click on the toggle, or on "Search web for images" (existing consent). `newChat()`, loading a saved chat and the home-page handoff all leave it off. The toggle state is not saved.
2. **Before any web step** (Ask with the toggle on, the image search button, a Search page query, address-bar search text), the question is classified locally (§4).
   - **Not sensitive:** the search runs as today.
   - **Sensitive (any category except crisis):** nothing is sent. Ask AI answers **locally** (the normal `streamLocalAnswer`, as if the toggle were off) and adds one sentence: **"I didn't search the web: this looks like a <category> question, so nothing was sent."** It also offers a **[Search anyway…]** button. The Search page has no model, so it shows the same sentence with "Nothing was sent.", no results, and two buttons: **[Ask AI locally instead]** and [Search anyway…]. "Ask AI locally instead" opens a new Ask AI tab with the question filled in and run, with Search the web **off**. It uses `browser:open-search` with mode `ask`, which no longer carries a `web` flag (§4.7). The question moves between Sovereign's own pages only; nothing is sent.
   - **[Search anyway…]** opens an inline panel:
     - an editable text box, prefilled with the query **after identifiers are removed** (§4.3);
     - a line saying what was removed, for example "Removed: 1 email address, 1 phone number". If nothing was removed: "No emails, phone numbers, addresses or ID numbers found.";
     - a live preview: **"This exact text will be sent to your search service (SearXNG), which forwards it to public search engines:"**, followed by the text in a box. The preview applies the same removal to whatever the user types, so it always shows exactly what main will send;
     - **[Send this search]** and **[Cancel]**. Cancel sends nothing.
   - **Crisis (self-harm, personal):** no search and no [Search anyway…], in both modes, with the web toggle on or off, Online or Offline. The reply is a fixed, warm message from the app with crisis resources (§4.4). The local model is **not called** for that turn.
3. **With the web toggle off**, sensitive questions are answered locally with no notice, because nothing would be sent anyway. The crisis check still runs.
4. **Settings → Sensitive topics:** a radio pair **Strict** (default) / **Standard**, with one line each:
   - Strict: "Health, legal, money and mental-health topics are never searched without asking. Most private."
   - Standard: "These topics are searched unless the question is about you or someone close to you."
   - Always shown: "Crisis support is always on." There is no "off".

#### 4. Design
##### 4.1 New module `src/sensitive-guard.js` (UMD like `media-intent.js`; plain JS, no Electron, no network)
- `classifyQuestion(text, { strictness = 'strict' })` returns `{ level: 'none' | 'sensitive' | 'crisis', categories: string[] }`. It is deterministic and pure. Categories: `self-harm`, `mental-health`, `medical`, `legal`, `sexual-health`, `finances`, `personal-identifiers`. User-facing labels: "self-harm or suicide", "mental health", "medical", "legal", "sexual health", "financial", "personal information".
- `removeIdentifiers(text)` returns `{ text, removed: { email, phone, address, idNumber } }` (counts only).
- `CRISIS_REPLY`, `CRISIS_RESOURCES` and `notSentSentence(categories)`: fixed strings, all in this one file.
- Steps, in order:
  1. **Normalise:** lower-case a copy, fold `’` to `'`, collapse spaces, and strip leading polite fillers ("can you", "please", "tell me", "show me", "help me understand", "explain") so that "tell me" is not read as personal framing.
  2. **Crisis (always, both levels):** first-person intent ("I want to die", "kill myself", "end my life", "don't want to live", "better off dead", "hurt myself", "cut myself") **or** a request for methods or means, with or without first person ("how many pills to overdose", "lethal dose of …", "painless way to die", "how to hang (myself)", "easiest way to kill myself", "how to commit suicide"). → `crisis`.
  3. **Negative guards** (checked before topics): phrases where a topic word has another meaning. "kill (a/the) process|task|job|server|thread|tab|switch|lights", "economic/great depression", "Depression-era", "Suicide Squad", "suicide doors", "suicide king(s)", "medical school/student/drama", "legal tender/size/pad", "bar exam" (as a topic only), "bank of (a|the) river", "execute (a) script|query", "shoot (a) photo|video". A matched phrase is removed before the topic step. It does not clear identifiers or crisis.
  4. **Identifiers (both levels):** email; phone (7+ digits with optional `+`, spaces, `-`, `.`, `()`; not dates like `2024-01-15`, years or ISO numbers); street address (house number + 1–4 words + suffix: St/Street/Ave/Avenue/Rd/Road/Blvd/Lane/Ln/Dr/Drive/Court/Ct/Way/Place/Pl); ID numbers (US SSN `ddd-dd-dddd`, 13–19 digit card numbers that pass Luhn, IBAN, and "passport/licence/license/ID/account number" followed by 6+ letters/digits). **Name with context:** two or three capitalised words (not at sentence start only, not a known place/brand list) **and** a personal-context word (address, lives, phone, email, arrested, diagnosed, pregnant, divorce, salary, dating, cheating, criminal record, DUI). Any hit → `personal-identifiers`.
  5. **Self-harm, general information (both levels):** "suicide", "self-harm", "suicidal", "self-injury" without a crisis match (for example "suicide rates in Japan") → `self-harm` as `sensitive`. Crisis always wins over this.
  6. **Sexual health (both levels):** STI/STD, HIV, herpes, chlamydia, gonorrhea, syphilis, HPV, PrEP, erectile dysfunction, morning-after pill, abortion pill, pregnancy test → `sexual-health`.
  7. **Mental health, medical, legal, finances** (term lists in the module, for example: depression/anxiety/bipolar/panic attack/therapist/antidepressant; diagnosis/symptoms/tumor/cancer/diabetes/medication/dosage/STD clinic; lawyer/sued/lawsuit/arrested/custody/divorce/immigration status/DUI/eviction; debt/bankruptcy/credit score/loan/mortgage/overdraft/tax return/salary/payday loan).
     - **Standard:** flagged only with **personal framing**: `I`, `I'm`, `I've`, `me`, `my`, `mine`, `we`, `our`, `us`, "am I", "do I", "should I", "can I", or "my <relation>" (wife, husband, partner, son, daughter, mom, dad, friend, boss, child, kid).
     - **Strict:** the topic term alone is enough.
  8. A question can have several categories. The order of `categories` follows the list in §4.1.
- **Strictness only changes step 7** (and the optional model check, §4.2). Crisis, identifiers, self-harm general and sexual health behave the same in both.
- English only (Known limits).

##### 4.2 Optional second check by the local model (Strict only, so on by default)
- Runs only in **Strict** (the default), only in Ask AI, only when the model is **already loaded** (never loads or downloads it), and only when the pattern step returned `none`. It is time-boxed to 4 s. Prompt: a fixed classification instruction plus the question. Expected reply: one word, either a category name or `none`. Parse strictly; anything else counts as `none`.
- It can only **add** a block, never remove one. It can never return `crisis`: crisis is pattern-only, so it stays deterministic and testable. A model "yes" is shown as "this may be a <category> question (checked by the local AI)".
- When it can't run (model not loaded, timeout, error), the patterns' result stands and nothing is shown. Cost: about 1–3 s before each web search in Strict. Strict is the default, so most users pay this whenever a search would run and the model is loaded. Standard skips the check for speed.
- **Never a cloud service.** It uses `getEngineApi()` (WebLLM), the same engine as answers.

##### 4.3 Enforcement in main (authoritative; the page UI can't bypass it)
- New `sensitiveGate(sender, text, { override })` in `main.js`, called at the **top** of `handleSearchQuery` and `search:media`, after the Offline refusal and **before** `createReceipt`, `pushSearchActivity` and any fetch.
  - `crisis` → refuse, always, even with `override`.
  - `sensitive` without `override` → refuse.
  - The refusal is `{ ok: false, sensitive: true, level, categories, suggestedQuery }`, where `suggestedQuery = removeIdentifiers(text).text`. It is returned, not thrown, so the page can render it. It records the receipt entry (§4.5).
  - `sensitive` with `override: true`: main sends **`removeIdentifiers(text).text`**, the same function the preview uses, so the user always sees exactly what is sent. Main also re-checks the edited text for crisis.
  - The strictness comes from main's preferences. The renderer can't lower it.
  - The model check (§4.2) reaches main only as an extra flag: `{ modelFlag: '<category>' }`. Main treats it like a pattern hit, so it can only block.
- `search:read-sources` and `media:preflight` / `media:download` don't carry the question to the network, but they follow a search. Main keeps a short-lived `Set` of request ids whose search passed the gate (deleted when the request ends). `handleReadSources` refuses an unknown id. Media preflight/download already only take result URLs from an allowed media search. CHANGES must confirm this (grep), or add the same id check.
- **Static guard** (extend the `network-exits` approach): a test fails if `searchSearxng(` or the media search call appears in `main.js` outside a function that calls `sensitiveGate` first.

##### 4.4 Crisis reply (stored in the app, works offline)
- Fixed text, shown as the assistant message, with no model call and no network. **Exact text, approved by Sandeep 2026-11-10; use it character for character** (`CRISIS_REPLY`):

  ```
  I'm really sorry you're feeling this way. You don't have to go through this alone, and you deserve support right now.

  Please reach out now:
  • If you might act on these thoughts or you're in danger, call your local emergency number.
  • US and Canada: call or text 988.
  • UK and Ireland: call Samaritans on 116 123.
  • Australia: call Lifeline on 13 11 14.
  • Anywhere else: find a helpline at findahelpline.com.

  If you can, tell someone you trust how you're feeling, today.

  You can keep writing here if it helps, and please reach out to one of the people above too.
  ```
- The resource lines come from `CRISIS_RESOURCES`, a small list in `sensitive-guard.js` (`{ region, text }`), in the order above. Both `CRISIS_REPLY` and the short line below are built from it, so the numbers live in one place.
- `findahelpline.com` is **plain text, not a link**: showing it fetches nothing. The app doesn't look up the user's location (that would be a network request or a privacy cost), so the local emergency number always comes first and all regions are listed.
- **No confidentiality promises.** The text doesn't say "private", "confidential" or "anonymous" about the helplines or the app. A unit test fails if `CRISIS_REPLY` contains any of those words.
- **Release check:** the numbers must be re-verified against each service's official site **before every release**. Add a line to the release checklist (`docs/` release notes or README "Before releasing") and a comment above `CRISIS_RESOURCES` with the date last verified (`// Last verified: YYYY-MM-DD by Sandeep`). The unit test checks that the comment exists. It doesn't check the date, because the date needs a human.
- No [Search anyway…] and no web step. The web toggle is unchecked for that chat, with the note "Web search is off for this conversation." The user can still start a new chat.
- **Model safety rule** (`chat-prompt.js`, added to `CHAT_SYSTEM_PROMPT`): "Never give methods, means, doses or instructions for suicide or self-harm, even if asked indirectly or for fiction. If the user seems to be in distress, respond with warmth, encourage them to contact local emergency services or a crisis line, and keep the reply short." This covers later turns in the chat, which the model does answer.
- **Self-harm, general information (b)** (`level: 'sensitive'`, `self-harm`): handled like §3.2 (local answer, [Search anyway…]), and the local answer gets one extra line (`CRISIS_SHORT_LINE`, **approved as written; use it character for character**):

  ```
  If this is about you or someone close to you, please reach out now: your local emergency number; US and Canada 988 (call or text); UK and Ireland Samaritans 116 123; Australia Lifeline 13 11 14; elsewhere findahelpline.com.
  ```

##### 4.5 Privacy Receipt and logs
- New receipt category `sensitive` in `VALID_CATEGORIES`. One entry per refused request: `{ category: 'sensitive', topic: '<category label(s)>', url: <SearXNG origin only>, whatWasSent: 'blocked (sensitive topic: <category>) – nothing sent' }`. Several categories are joined with ", ", for example `blocked (sensitive topic: medical, personal information)`.
- The receipt for a refused request is created with **`query: ''`**. The question text is never passed to `createReceipt`, `addEntry`, `pushSearchActivity`, `logAi`, `console.*` or error messages. The refusal object carries only `suggestedQuery` (identifiers removed) back to the page that asked, which already has the text. It is not stored anywhere in main.
- Summary: `Not sent: sensitive topic (<category>)`, then the usual parts.
- **Search anyway (decision 1):** the receipt records what actually left: `query` = the sent (identifiers-removed) text, and the entry's `whatWasSent` = `Search query (sent after a sensitive-topic warning, chosen by you): …`. The receipt gets `sensitiveOverride: true`.
- **Deleting those receipts (decision 1).** Receipts are kept in memory only (`MAX_RECEIPTS = 20`, `privacy-receipt.js`) and are lost on quit, but they must not outlive their chat:
  - Receipts gain an optional `chatId`. The Ask page sends its current chat id with `privacy:start-activity`, `search:query`, `search:media` and `search:read-sources`, and main stores it on the receipt (validated: same format as `chat-store` ids, ≤ 100 chars).
  - New `privacyReceipts.deleteReceipts(predicate)`, which also clears `backgroundReceiptId`/`offlineReceiptId` when it removes those receipts.
  - `chats:delete` (id) → delete receipts with `chatId === id`.
  - `chats:clear` (Clear history) → delete every receipt with a `chatId`, **and** every receipt with `sensitiveOverride: true`. That includes Search-page ones, which have no chat.
  - The chat-deletion-on-disable path (`chats:offer-delete-on-disable`) does the same as Clear history when it deletes.
  - Open Ask and Search pages are notified through the existing receipt update broadcast, so their receipt panels refresh.
  - A file the user already exported is theirs; this can't reach it (Known limits).
- Crisis turns create a local Ask receipt with `query: ''` and the summary "Nothing left this device: crisis support shown". No entry text.

##### 4.6 Preferences and settings
- `preferences.json` gains `privacy: { sensitiveTopics: 'strict' | 'standard' }`. Missing or invalid → **`strict`** (decision 5). This includes existing installs on their first launch after the update; no banner, because it only makes things stricter. IPC: `privacy:get-settings` and `privacy:update-settings` (validate the value; ignore anything else). It is broadcast to the Ask and Search pages so a change applies to the next question.

##### 4.7 Files
| File | Change |
|---|---|
| `src/sensitive-guard.js` (new) | Rules, identifier removal, crisis text and resources, sentences (§4.1, §4.4). |
| `src/main.js` | `sensitiveGate` in `handleSearchQuery` and `search:media`; allowed-request-id set for `handleReadSources`; receipt entries; preferences and IPC (§4.3, §4.5, §4.6). Stop adding `web=1` (~3058) and stop reading it (~3227); remove `web` from `browser:open-search` (~4694). |
| `src/privacy-receipt.js` | Category `sensitive`; summary text; `chatId`, `sensitiveOverride`, `deleteReceipts(predicate)`. |
| `src/main.js` (chats) | `chats:delete` / `chats:clear` / delete-on-disable also delete receipts (§4.5). |
| `docs/` release checklist (or README "Before releasing") | "Re-verify crisis numbers in `src/sensitive-guard.js`" (§4.4). |
| `src/preload.js` | `privacy.getSettings/updateSettings/onSettings`; let `search.query`/`search.media` pass `{ override, modelFlag }`. |
| `src/ask.html`, `src/ask.js` | Load `sensitive-guard.js`. Toggle off by default and never seeded from the URL. Crisis check before every answer. Handle `{ sensitive: true }` replies, the notice sentence, the [Search anyway…] panel and the Strict model check. |
| `src/search.html`, `src/search.js` | Load the module; same notice and panel (no local answer). |
| `src/settings.html`, `src/settings.js` | "Sensitive topics" section. |
| `src/chat-prompt.js` | Self-harm safety rule. |
| `src/styles.css` | Notice and panel, light and dark. |
| `package.json` | `node --check src/sensitive-guard.js && node tests/sensitive-guard.test.js` in `check`; `test:electron:sensitive-guard` and its `node --check` in `check:tests`. |
| `tests/sensitive-guard.test.js` (new), `tests/privacy-receipt.test.js`, `tests/network-exits.test.js`, `tests/electron/sensitive-guard.test.js` (new) | §6. |

#### 5. Example prompts and expected behaviour (also the unit-test table)
"Sensitive (x)" means: no web request; local answer plus the notice and [Search anyway…]. "Crisis" means: the fixed crisis reply, no search, no override. "None" means: searched as today (when the web toggle is on). The prompts with identifiers use made-up values.

**Strict is the default** (decision 5), so the Strict column is what a new user gets. The rows where the two modes differ are 13, 16, 23 and 26; in every other row the modes agree.

| # | Prompt | Strict (default) | Standard | Notes |
|---|---|---|---|---|
| 1 | I want to kill myself | Crisis | Crisis | first-person intent |
| 2 | how many pills to overdose | Crisis | Crisis | method/means |
| 3 | painless way to die | Crisis | Crisis | method/means |
| 4 | lethal dose of acetaminophen | Crisis | Crisis | means, no first person |
| 5 | i dont want to live anymore | Crisis | Crisis | no apostrophe, lower case |
| 6 | how to hang myself | Crisis | Crisis | |
| 7 | I keep thinking about hurting myself | Crisis | Crisis | |
| 8 | suicide rates in Japan | Sensitive (self-harm) | Sensitive (self-harm) | general info (b) |
| 9 | history of suicide prevention | Sensitive (self-harm) | Sensitive (self-harm) | general info (b) |
| 10 | how to help a friend who is suicidal | Sensitive (self-harm) | Sensitive (self-harm) | (b), plus the resource line |
| 11 | I think I have depression, what should I do | Sensitive (mental health) | Sensitive (mental health) | personal framing |
| 12 | best therapist for my anxiety near me | Sensitive (mental health) | Sensitive (mental health) | |
| 13 | symptoms of bipolar disorder | Sensitive (mental health) | None | no personal framing |
| 14 | my son has a fever of 39 should I worry | Sensitive (medical) | Sensitive (medical) | |
| 15 | I found a lump in my breast | Sensitive (medical) | Sensitive (medical) | |
| 16 | symptoms of type 2 diabetes | Sensitive (medical) | None | |
| 17 | can I take ibuprofen with my blood pressure medication | Sensitive (medical) | Sensitive (medical) | |
| 18 | I think I have HIV | Sensitive (sexual health) | Sensitive (sexual health) | |
| 19 | HIV symptoms | Sensitive (sexual health) | Sensitive (sexual health) | sexual health flags without framing |
| 20 | where to get a morning-after pill | Sensitive (sexual health) | Sensitive (sexual health) | |
| 21 | my landlord is evicting me what are my rights | Sensitive (legal) | Sensitive (legal) | |
| 22 | I got a DUI last night | Sensitive (legal) | Sensitive (legal) | |
| 23 | how does a divorce work in California | Sensitive (legal) | None | |
| 24 | I can't pay my credit card debt | Sensitive (finances) | Sensitive (finances) | |
| 25 | should I file for bankruptcy | Sensitive (finances) | Sensitive (finances) | "should I" framing |
| 26 | what is a good credit score | Sensitive (finances) | None | |
| 27 | jane.doe@example.com password reset | Sensitive (personal information) | Sensitive (personal information) | email removed in the suggestion |
| 28 | who owns the number +1 415 555 0134 | Sensitive (personal information) | Sensitive (personal information) | phone removed |
| 29 | 742 Evergreen Terrace Springfield owner | Sensitive (personal information) | Sensitive (personal information) | address removed (if "Terrace" is added to the suffix list; otherwise listed as a miss in CHANGES) |
| 30 | is SSN 123-45-6789 valid | Sensitive (personal information) | Sensitive (personal information) | ID removed |
| 31 | John Smith arrested in Denver | Sensitive (personal information) | Sensitive (personal information) | name with context |
| 32 | Maria Lopez address Austin | Sensitive (personal information) | Sensitive (personal information) | name with context |
| 33 | I think I have HIV, call me at 415-555-0134 | Sensitive (sexual health, personal information) | same | two categories; phone removed |
| 34 | economic depression of 1929 | None | None | negative guard |
| 35 | Suicide Squad movie cast | None | None | negative guard |
| 36 | how to kill a Python process | None | None | negative guard |
| 37 | medical school ranking | None | None | negative guard |
| 38 | legal tender meaning | None | None | negative guard |
| 39 | Great Depression causes | None | None | |
| 40 | kill all node processes on mac | None | None | |
| 41 | Depression-era recipes | None | None | |
| 42 | best legal size paper for printing | None | None | |
| 43 | how to execute a SQL query | None | None | |
| 44 | ISO 8601 date format 2024-01-15 | None | None | not a phone number |
| 45 | Apollo 11 launch 1969 | None | None | year, not an ID |
| 46 | tell me about the bank of a river | None | None | "tell me" isn't personal framing |
| 47 | weather in Paris tomorrow | None | None | |
| 48 | Python cancel asyncio task | None | None | |
| 49 | 1600 Pennsylvania Avenue history | Sensitive (personal information) | Sensitive (personal information) | **known false positive** (landmark address); accepted, no allowlist (decision 3) |
| 50 | suicide doors on cars | None | None | negative guard |
| 51 | RFC 5322 email address format | None | None | no actual address |
| 52 | Barack Obama birthday | None | None | name without a personal-context word |

#### 6. Tests (write first)
**Unit (`npm run check`):**
- `tests/sensitive-guard.test.js` (new): the §5 table as data `[id, prompt, strict, standard]`, checked for both strictness levels. `classifyQuestion(text)` with no options must equal the Strict column (the default). **Failure messages print the row id and expected/actual level only, never the prompt** (privacy of test output).
  - Plus `removeIdentifiers`: rows for email, phone formats (`+1 415 555 0134`, `(415) 555-0134`, `415.555.0134`), SSN, a Luhn-valid test card number vs a Luhn-invalid one, IBAN, street address. Each has the expected output text and counts. Non-identifiers (dates, years, version numbers like `3.12.1`, ISO codes) stay.
  - Crisis wins over everything (row 33 with crisis words added → `crisis`).
  - `classifyQuestion` is pure: same input, same output; no globals touched.
  - Crisis text: `CRISIS_REPLY` contains, in order, "local emergency number", "988", "116 123", "13 11 14", "findahelpline.com". It contains none of "confidential", "private", "anonymous" or "secret" (case-insensitive), and no `http`. `CRISIS_SHORT_LINE` lists the same numbers in the same order. The source has the `// Last verified:` comment above `CRISIS_RESOURCES`.
- `tests/privacy-receipt.test.js` (extend): `deleteReceipts` removes receipts by `chatId` and by `sensitiveOverride`, keeps the others, and resets `backgroundReceiptId`/`offlineReceiptId` when it removes those. A `sensitive` entry built from a request containing the marker `SECRETQ-7731` stores no question text. The marker appears nowhere in `getReceipts()` or `exportPayload()`. The entry label is `blocked (sensitive topic: medical) – nothing sent`, and the summary starts `Not sent: sensitive topic (medical)`.
- `tests/network-exits.test.js` (extend): `searchSearxng(` and the media search call appear only inside functions that call `sensitiveGate(` first. `handleReadSources` checks the allowed-id set.
- **Gate test** (run the real `sensitiveGate` body in a vm, like `offline-gate-integration`): with a counting fake `searchSearxng`, a fake `pushSearchActivity` and a fake receipt store:
  - a sensitive query → 0 search calls; no marker in activity or receipt;
  - `override: true` → 1 call with the identifiers-removed text;
  - a crisis query with `override: true` → 0 calls;
  - Strict from preferences can't be lowered by the renderer.

**Electron (`tests/electron/sensitive-guard.test.js`, new; Online via `SOVEREIGN_TEST_NETWORK_MODE=online`; fake SearXNG on loopback that counts requests and records nothing):**
1. A new Ask chat: `#web-toggle` is unchecked. Opening `sovereign://ask/?q=x&web=1` leaves it unchecked. A new chat after turning it on: unchecked again.
2. Web on, the row 18 prompt (with the marker appended) → SearXNG sees **0 requests**; the notice sentence is shown; [Search anyway…] is shown. The test profile has no model, so the local answer shows the existing "model isn't downloaded" path. Assert that this path was reached, not the answer text.
3. [Search anyway…] with the row 33 prompt → the box shows the text with the phone number removed; the preview equals it. Edit the text, then [Send this search] → SearXNG sees exactly **1** request, and its `q` equals the edited, identifiers-removed text.
4. Crisis (row 1) with web on → the fixed crisis reply, including "988"; no [Search anyway…]; 0 SearXNG requests. The same with **Offline** on and with the web toggle off.
5. Search page and address bar: typing the row 14 prompt in the address bar → Search page notice, 0 requests. Row 36 → 1 request (the negative isn't blocked).
6. Image search: "show me pictures of herpes" via the image button → 0 requests and the notice.
7. Receipts: `JSON.stringify(privacy:get-receipts)` and the export don't contain the marker. The entry reads `blocked (sensitive topic: …)`. The test's own console output doesn't contain the marker (the test prints only ids).
8. Settings: a fresh profile is **Strict** (Strict radio checked) and row 16 is blocked. Switch to Standard → row 16 searches; back to Strict → blocked again. The setting survives a relaunch. An old `preferences.json` without `privacy` starts Strict. No "off" option exists.
9. Regression: `ui-smoke`, `media-chat`, `safe-redirects`, `ask-layout`, `stage1-usability` and `offline-mode` still pass. Any test that relies on `web=1` or the toggle being on must click the toggle instead; list each one in CHANGES.
10. Search page: row 14 → [Ask AI locally instead] opens an Ask tab with the question and the web toggle **unchecked**, and SearXNG sees 0 requests.
11. Receipt deletion: chat A does Search anyway (row 33, edited) → its receipt holds the sent text. Delete chat A → that receipt is gone from `privacy:get-receipts`, and other receipts stay. Repeat, then Clear history → every receipt with a chat id or `sensitiveOverride` is gone, including one made from the Search page.

#### 7. Privacy impact
- **Positive:** sensitive questions stay on the laptop by default; crisis questions never leave, in any mode.
- **No new network requests.** The classifier, crisis text and resources are local. The optional model check uses the local WebLLM model only and never loads or downloads it.
- **Less stored:** refused requests store no question text in receipts, the activity feed or logs; the receipt has only the category and the SearXNG origin.
- **New stored data:** `preferences.json` gains `privacy.sensitiveTopics` (one word).
- **Search anyway** sends what the user saw and edited, with identifiers removed. The receipt shows that text (decision 1). It is kept in memory only and is deleted with its chat and by Clear history.
- **Unchanged:** chat history (local, `chat-store.js`) keeps the question as today.
- **Strict by default:** more questions stay local for new and existing users. When the model is loaded, the Strict model check adds about 1–3 s before a search would run.

#### 8. Known limits (for CHANGES and REVIEW to state plainly)
1. **Pattern rules can miss things.** Spelling mistakes, slang, indirect wording ("I'm so tired of everything"), and other languages (English only) may not be caught. They can also flag harmless text (row 49). Strict and the optional model check reduce misses but don't remove them.
2. **Crisis detection is not a safety service.** It shows resources and stops the search. It doesn't contact anyone, and it can miss indirect signals. The numbers are fixed in the app and **must be re-verified before each release** (§4.4). The app doesn't know the user's country, so it lists every region.
3. **Name detection is rough:** it needs capitalised names and a context word. Lower-case names, or names alone, pass. Removing identifiers does **not** remove names. The user can edit them out in the panel.
4. **Typing a search engine URL directly** (for example `https://example-search.com/?q=…`) is ordinary website navigation and is not checked. Only Sovereign's own search paths are guarded.
5. The model check runs only in Strict (the default), only when the model is loaded, and adds about 1–3 s.
6. Websites the user opens can still see what the user types into them. The guard covers Sovereign's search, image search and source reading only.
7. **Landmark addresses** (row 49) are flagged as personal information; no allowlist (decision 3).
8. **Exported receipts:** a receipt the user already exported to a file is outside the app, so deleting the chat can't remove that copy.
9. **Strict blocks more general questions** (rows 13, 16, 23, 26). The user clicks [Search anyway…] or switches to Standard; that is the intended privacy trade-off.
10. **Crisis text should be reviewed by a qualified professional (e.g. university counseling services) before public release.**

#### 9. Do not change
- Offline mode behaviour (Task 1a), safe-fetch redirect logic, the WebLLM engine and model cache, chat storage and deletion, permissions.
- Non-sensitive Online searches must behave exactly as today, apart from the toggle default.

#### 10. Open questions for Sandeep
- **Answered 2026-11-10** (see the decisions at the top of this task).
- Crisis texts approved 2026-11-10 (§4.4). Nothing open before the build.

#### 11. Manual tests (Sandeep)
1. **Default off:** Online, open Ask AI → "Search the web" is unchecked. Turn it on, click New chat → unchecked again. Relaunch → unchecked.
2. **Sensitive (Strict, the default):** web on, ask "I think I have depression, what should I do". Expect a local answer, the sentence "I didn't search the web: this looks like a mental health question, so nothing was sent.", and [Search anyway…]. The receipt says `blocked (sensitive topic: mental health)`, and the question text is nowhere in the receipt or its export. If you run `searxng/` locally, its log shows no request.
3. **Search anyway:** ask "I think I have HIV, call me at 415-555-0134". Click [Search anyway…]. The box shows the text without the phone number, and the preview matches. Edit it to "HIV testing options", then Send → results appear, and the receipt shows exactly "HIV testing options".
4. **Crisis:** type "I want to kill myself" with web on, then with web off, then in Offline mode. Each time: the warm fixed reply with 988 and the local emergency line, no [Search anyway…], and nothing in SearXNG's log.
5. **General self-harm info:** "suicide rates in Japan" → sensitive notice plus [Search anyway…] and the 988 line; not the crisis reply.
6. **Negatives:** with web on, "economic depression of 1929", "Suicide Squad movie cast", "how to kill a Python process", "medical school ranking", "legal tender meaning" → each searches normally.
7. **Address bar:** type "my son has a fever of 39 should I worry" in the address bar → the Search page shows the notice, with no results and no request.
8. **Strict is the default:** on a fresh profile, Settings → Sensitive topics shows **Strict** selected. "symptoms of type 2 diabetes" is blocked. With the model loaded, try an indirect sensitive question that the patterns miss, and check whether the model check catches it (it says "checked by the local AI"). Switch to Standard → it searches. Switch back to Strict.
10. **Ask AI locally instead:** on the Sovereign Search page, search "I found a lump in my breast" → the notice, no results, and two buttons. Click [Ask AI locally instead] → a new Ask tab answers locally with Search the web unchecked.
11. **Receipt deletion:** in an Ask chat, use Search anyway and check that the receipt shows the sent text. Delete that chat in the chat list → the receipt is gone from the receipt history. Do it again, then Clear history → all those receipts are gone, including one from Search anyway on the Search page.
12. **Crisis text:** read the crisis reply in the app and check every number against the official sites (988lifeline.org, samaritans.org, lifeline.org.au, findahelpline.com) before release.
9. **Image search:** "show me pictures of herpes" → no image search; notice shown.

#### Round 3 PLAN (Claude, 2026-11-10): crisis detection only (Sandeep's decisions)
Scope: `src/sensitive-guard.js` crisis step and `tests/sensitive-guard.test.js` only. Nothing else changes.
1. **Normalise before the crisis check:** lower-case; turn curly and straight apostrophes/quotes (`’ ‘ ‛ ʼ ′ " “ ”`) into one form, **and** also match with apostrophes removed ("i'm" and "im", "don't" and "dont"); collapse runs of spaces; trim.
2. **New crisis rows (all `crisis` in both modes):**

| # | Prompt |
|---|---|
| 65 | im suicidal |
| 66 | i am suicidal |
| 67 | Im suicidal |
| 68 | im sucidal |
| 69 | i feel suicidle |
| 70 | kms |
| 71 | i just want to kms |
| 72 | i want to die |
| 73 | dont want to live anymore |
| 74 | don't want to be here anymore |
| 75 | I’m better off dead |
| 76 | there's no reason to live |
| 77 | i'm going to end my life |

   The misspellings "sucidal" and "suicidle" are matched as listed. A general fuzzy match is not wanted, because it would cause false positives.
3. **"kms" also means kilometres.** It is crisis only when it stands as a word that is **not** next to a number or a distance word (to, from, away, per, in a, run, drive, miles). New negative rows (`none` in both modes): 78 "10 kms to miles", 79 "how many kms is a marathon", 80 "100 kms per hour in mph".
4. **All existing rows must still pass**, especially the negatives: 34–52, 58–64 (Suicide Squad, kill a Python process, hang curtains, meal prep, std::vector, and the others).
5. **Accepted (Sandeep, 2026-11-10):** idioms such as "kill myself laughing" and "I cut myself shaving" give the crisis reply.

#### Round 4 PLAN (Claude, 2026-11-10): crisis check first on every surface (bug from Sandeep's manual test)
**Bug:** in Offline mode, "I want to kill myself" on the Sovereign Search page shows only "Web search is off in Offline mode…", with no crisis text and no helplines. **Cause (verified):** `search.js` `runSearch` returns on `networkOffline` before any check. Main's `handleSearchQuery` and `search:media` also call `refuseWebWhileOffline` **before** `sensitiveGate`.

**Rule:** the crisis check (`classifyQuestion(...).level === 'crisis'`, which also covers harm to others once Task 1c adds it) runs **first** on every surface: before the Offline check, the web toggle, the attachment-extraction check, model readiness and any other gate. Its result is the approved crisis text in every mode. Nothing is sent.

**Every entry point (verified):** the address bar, the New Tab box and the toolbar search button open either the Search page or Ask AI (`browser:open-search`; no Offline gate on the way). So the places to fix are:
1. `src/search.js` `runSearch`: classify the query first. On crisis, show `CRISIS_REPLY` through `SovereignSensitiveUI.render` with a local `{ level: 'crisis', categories }` result (no IPC needed for display), record an empty-query crisis receipt through the existing local crisis-receipt path, show no results, and return. Do this before the `networkOffline` check and without calling `search:query`. A seeded run (`?q=…&run=1`) must reach this even while the input is disabled in Offline.
2. `src/main.js` `handleSearchQuery` and `search:media`: run the crisis part of `sensitiveGate` **before** `refuseWebWhileOffline`. It returns the crisis refusal (empty-query receipt), so a crisis request never yields the Offline error, even if a page skips step 1. The non-crisis sensitive check can stay after the Offline check.
3. `src/ask.js` `submitQuestion`: the crisis check runs before the "Still extracting the attached file" check. `answerQuestion` already checks crisis before the web/Offline/model logic; keep that.
4. `src/ask.js` `runInlineMediaSearch`: check crisis before the `networkOffline` return. (The question comes from an earlier turn, so it shouldn't be crisis, but keep the order consistent.)
5. Any other path found by grepping for `networkOffline`/`refuseWebWhileOffline`/`MEDIA_OFFLINE_TEXT`/`SEARCH_OFFLINE_TEXT` that returns before a crisis check: list it in CHANGES and fix it.

**Tests (write first):**
- **Static** (`tests/network-exits.test.js` or `tests/sensitive-gate.test.js`): in `handleSearchQuery` and the `search:media` handler, the crisis check appears before `refuseWebWhileOffline`. In `search.js` `runSearch`, `classifyQuestion` appears before `networkOffline`. In `ask.js` `submitQuestion`, the crisis check appears before the extraction check.
- **vm gate test:** with the network mode Offline, the real `handleSearchQuery` gate on a row-1 prompt returns `{ sensitive: true, level: 'crisis' }` (not the Offline error), with 0 search calls.
- **Electron** (`tests/electron/sensitive-guard.test.js`, new case 18; row 1 prompt plus the marker; counting SearXNG):
  - Search page: Offline, Online.
  - Address bar: Offline, Online.
  - New Tab box: Offline, Online.
  - Ask AI: Offline, Online with web off, Online with web on.
  - Image search in Ask: web on, a crisis-worded media request.

  Each must show `CRISIS_REPLY` in the page (including "988" and "local emergency number"), not show "Web search is off in Offline mode" or the media Offline text, and send **0** SearXNG requests. Receipts must hold no marker.
- Every existing case 1–17 and the regression tests still pass.

### CHANGES (Codex)
#### Round 4 (Codex, finished by Claude because Codex hit its usage limit, 2026-11-10)
**Who:** Codex wrote the source changes and the tests, then hit its usage limit (resets 2026-11-11 01:59) before running anything or writing this entry. Claude checked Codex's partial edits, fixed one test check, ran everything outside the sandbox and wrote this entry.

**Entry points fixed (crisis check now first):**
- `src/search.js` `runSearch`: `classifyQuestion` runs before `networkOffline`. On crisis it renders `CRISIS_REPLY` through `SovereignSensitiveUI`, records an empty-query crisis receipt (`privacy:start-activity`, `crisis: true`) and doesn't call `search:query`. A seeded Offline run (address bar, New Tab box, `?q=…&run=1`) reaches it even though the input is disabled.
- `src/main.js`: `sensitiveGate(..., { crisisOnly: true })` runs before `refuseWebWhileOffline` in `handleSearchQuery`, the media search handler and `handleReadSources` (the last one wasn't listed in the PLAN; added for consistency). The full sensitive gate stays after the Offline check.
- `src/ask.js` `submitQuestion`: crisis questions skip the "Still extracting the attached file" check. `runInlineMediaSearch`: crisis goes to `answerQuestion` before the Offline return. `answerQuestion` already checked crisis first.
- Grep (`networkOffline`, `refuseWebWhileOffline`, `MEDIA_OFFLINE_TEXT`, `SEARCH_OFFLINE_TEXT`): no other early return before a crisis check. The address bar, New Tab box and toolbar search only open the Search page or Ask AI.

**Tests:**
- `tests/sensitive-gate.test.js`: static order checks G14–G20 (crisis before Offline in `handleSearchQuery`, the media handler, `handleReadSources`, `runSearch`, `submitQuestion`, `runInlineMediaSearch`); the vm gate with Offline on returns the crisis refusal and makes 0 calls.
- `tests/electron/sensitive-guard.test.js` case 18: Search page, address bar and New Tab box (Offline and Online); Ask AI (Offline; Online with web off; Online with web on); image search (web on). Each checks the crisis text with "988" and "local emergency number", no Offline/media-Offline message, 0 SearXNG requests, and no marker in receipts.
- **Claude's test fix:** case 18 compared the page text with `CRISIS_REPLY` exactly, but Ask renders it as paragraphs and a list (newlines and "•" change), so `18-ask-offline-local` failed although the reply was there (case 4 checks `messages.at(-1).content` and passes). The check now compares letters and digits only, which still requires the whole reply.

**Run (Claude, outside the sandbox):** `npm run check` exit 0; `test:electron:sensitive-guard` exit 0 (cases 1–18 plus its six regression tests). Mutation check: with the Offline return moved back before the crisis check in `runSearch`, the suite fails at `18-search-offline-reply`; `src/search.js` was then restored.


#### Round 3 (Codex, 2026-11-10)

- **Crisis detection only — `src/sensitive-guard.js`:** added crisis-local lowercasing, quote/apostrophe unification, whitespace collapse/trim and an apostrophe-free matching form. Added explicit missing-apostrophe and listed spelling variants (`sucidal`, `suicidle`), plus the requested not-wanting-to-be-here phrase. No fuzzy matching; approved crisis texts and other categories are unchanged.
- **`kms`:** checks standalone occurrences individually, excluding adjacent numbers and the listed distance words/phrase, plus the requested “how many kms” negative. “want to kms” explicitly treats “to” as intent rather than distance.
- **Tests first — `tests/sensitive-guard.test.js`:** added §5 rows 65–80 verbatim (65–77 crisis/crisis; 78–80 none/none). Before implementation, both the direct guard test and `npm run check` failed at row 65. Assertion failures now print only the row id. Added quote/case/spacing, distance-adjacency, word-boundary and accepted-idiom checks. All rows 1–80 and existing extra checks pass, including exact approved-text equality.
- **Validation:** ran `node tests/sensitive-guard.test.js`, `node tests/sensitive-gate.test.js` and all other non-socket top-level unit tests: all 16 suites pass. `npm run check:tests` passes (syntax only). Ran `npm run check` after edits: its stages pass up to `safe-fetch-integration.test.js`, which cannot bind localhost (`listen EPERM`). No Electron run; socket suites were excluded from the direct unit-test sweep.
- **Manual test:** in Strict and Standard, try rows 65–77 in Ask and confirm the unchanged crisis reply with no web request; try rows 78–80 and confirm ordinary handling. Check quote/apostrophe variants and repeated spaces. Run the full `npm run check` outside the sandbox.
- Only the crisis step, guard tests and this task's CHANGES section were edited. No commit, push or git-config changes.


#### Round 2 (Codex, 2026-11-10)

- **MUST FIX 1 — `tests/electron/sensitive-guard.test.js`:** select the Ask document URL exactly (allow query/hash), excluding the hidden legacy-chat probe, including the local-Ask handoff. Every polling wait now has a case-id label; the handoff uses a labelled wait instead of a fixed delay. Failure reports contain only a case id and numeric stack line/column locations, never error messages, paths or prompt text. The orchestrator accepts only this validated diagnostic format from children and preserves child stack locations; other child output remains suppressed.
- **MUST FIX 2 — `src/sensitive-guard.js`:** first-person suicidal statements, wanting to commit suicide, thinking about suicide/killing oneself, and the requested end-it-all/no-reason-to-live/disappear-forever phrases take the crisis path. Approved crisis texts remain unchanged.
- **MUST FIX 3:** hanging instructions require myself/yourself/oneself or a noose; ordinary picture/curtain instructions no longer trigger crisis. Existing row 6 remains crisis.
- **MUST FIX 4:** standalone PrEP is case-sensitive; HIV context still triggers sexual health. C++ std and std before :: are excluded; ordinary STD statements remain sensitive in both modes.
- **SHOULD FIX 5:** Standard personal framing uses original-case text, excludes uppercase US and the type I/World War I/phase I contexts.
- **SHOULD FIX 6:** numeric candidates consisting only of 1900–2099 years separated by spaces, hyphens or slashes are preserved rather than counted as phones or cards.
- **Tests first — `tests/sensitive-guard.test.js`:** added §5 rows 53–64 with exactly the requested expectations, plus S1–S12 for the additional review phrases and sexual-health preservation, and R12–R13 for year separators. Failure assertions retain row-id-only diagnostics. Ran `npm run check` before production changes: it failed at row 53 as expected. All original 52 rows and all new rows now pass in Strict, Standard and default mode; approved-text equality checks pass.
- **Validation:** ran `npm run check` after changes; all stages before the socket integration test pass, then `safe-fetch-integration.test.js` stops at localhost `listen EPERM`. Ran all 18 top-level test files directly with Node: 16 pass; `safe-fetch-integration` and `offline-gate-integration` are blocked by that sandbox restriction. `npm run check:tests` passes (syntax only). No Electron process was launched. `git diff --check` reports the pre-existing blank line at EOF in REVIEW; it was left untouched to honor CHANGES-only ownership.
- **Manual check:** outside the sandbox, run `npm run check` and `npm run test:electron:sensitive-guard`. In Ask, verify the new crisis phrases show the unchanged crisis reply without search; picture/curtain and meal-prep/coding requests follow the ordinary path. On Search, compare the US mortgage/type I diabetes examples in Strict versus Standard; confirm ordinary STD and HIV PrEP stay sensitive and year comparisons do not show identifier removal.
- **Known limits (accepted review finding):** idioms such as “kill myself laughing” and “I cut myself shaving” still produce the crisis reply; users can rephrase. No code exception was added.

Only this task's CHANGES section was edited in this document. No commit, push or git-config changes.

#### Round 1 (Codex, 2026-11-10)

Implemented on `phase-1/sensitive-guard`, tests first. No commit, push, or git-config changes. Only this task's CHANGES section was edited; the pre-existing PLAN, decisions and REVIEW were preserved.

**Files and PLAN coverage**
- **§3, §4.1, §5:** new `src/sensitive-guard.js` is a browser/Node UMD module with pure Strict-default classification, ordered categories, negative guards, crisis priority, identifier removal/counts, labels and notice text. Terrace is included. Card removal requires Luhn; invalid cards are not reinterpreted as phones. Dates and version numbers are separated from phone candidates. Capitalised names require context and are not removed from the suggested text. **All 52 rows pass in Strict, Standard, and default mode; no unmet rows and no weakened expectations.**
- **§4.2:** `src/ask.js` runs the extra check only in Strict, only for pattern `none`, only with an already-loaded local engine. It accepts only an exact category token, rejects `crisis` and explanatory output, and times out after four seconds. Timeout interrupts the generation and releases the search; subsequent answer generation waits for the interrupted model job to settle. No model load/download is initiated by this check.
- **§4.3:** `src/main.js` calls `sensitiveGate` after the Offline backstop and before normal receipt creation, activity entries, fixture handling, or SearXNG calls in both text and media handlers. Preferences are authoritative; model flags can only add a block. Overrides recheck crisis and send identifier-removed text. Refusals return normally, use a fresh empty-query receipt and never enter the activity feed. Source grants are sender-bound, URL-bound, expire after five minutes, and are consumed before reading; unknown, expired, other-sender and unreturned URLs are refused. Grants are bounded and cleared on cancellation/sender destruction.
- **Media grep finding / §4.3:** preflight/download previously accepted arbitrary URLs from Ask/Search, not just search results. Added a sender-bound, expiring result-URL allowlist before either preflight or download. Validated redirect destinations are remembered for subsequent download. Reopening saved media renews grants from the stored chat's result URLs, not arbitrary renderer-supplied URLs. Existing safe-fetch redirect enforcement is unchanged.
- **§4.4:** `src/sensitive-guard.js` builds the approved `CRISIS_REPLY` and `CRISIS_SHORT_LINE` from `CRISIS_RESOURCES`; tests compare both character for character as well as checking resource order and prohibited promises. Ask checks crisis before model readiness, attachments, downloads or any answer path, including local-only/Offline turns. Crisis produces an empty-query local receipt, fixed reply and disabled/unchecked web toggle, with no override. General self-harm information gets the resource line. `src/chat-prompt.js` contains the exact safety rule. `README.md` now has “Before releasing” with number verification and professional review.
- **§4.5:** `src/privacy-receipt.js` adds `sensitive`, origin-only entries with a fixed blocked label, the refusal summary, crisis summary, validated `chatId`, `sensitiveOverride`, and `deleteReceipts(predicate)`. Sensitive entries discard caller-supplied `whatWasSent` and URL paths/queries. Deletion resets rolling background/offline IDs and broadcasts a refresh without deleted content. Main deletes chat receipts on single deletion and chat/override receipts on confirmed Clear history and delete-on-disable. Allowed override receipts retain the sent text and the specified “chosen by you” label. Ask supplies chat IDs for local activities, saved-media activities, search, media and source reading.
- **§3, §4.6–4.7:** `src/main.js` persists and broadcasts `privacy.sensitiveTopics`, defaulting missing/invalid values to Strict; `src/preload.js` exposes get/update/subscribe. Existing search bridge methods already forward request objects, including override/modelFlag. All main/Ask `web=1` handling was removed. New chats, restored chats, deleted-chat resets and URL/home handoffs leave the toggle off. `src/settings.html`/`src/settings.js` provide only Strict and Standard, with the requested descriptions and always-on crisis-support text.
- **Ask/Search UI:** `src/ask.html` and `src/search.html` load the guard and new shared DOM-only `src/sensitive-ui.js`. `src/ask.js` renders local refusals even without a downloaded model; `src/search.js` renders the refusal plus “Ask AI locally instead”. Both use the same editable override panel, removal counts, live exact-text preview, Send and Cancel. Main sanitizes the edited input using the same function as the preview. Media overrides bypass ordinary media-query wording cleanup so it cannot change the previewed text. `src/styles.css` supplies light/dark notice and panel styles. Crisis resource domains are plain text.
- **Dataset path:** `src/main.js` maps the batch reader to its allowed search ID and preserves the original grant/expiry for trusted batch retries. `src/dataset-collection.js` omits refused question text from its skip log. `tests/dataset-collection.test.js` verifies this with a made-up marker.
- **§6 / scripts:** `package.json` adds guard/UI syntax checks, the guard and VM unit tests, Electron syntax checking, and `test:electron:sensitive-guard`.

**Tests added before implementation**
- `tests/sensitive-guard.test.js`: §5 as `[id, prompt, strict, standard]` data, every mode/default expectation, category order, identifier-removal/count cases, valid/invalid Luhn cards, IBAN, dates/years/versions, crisis priority, determinism/global-key check, exact approved texts, resource order, no confidentiality claims/links, and last-verified comment presence. Assertions print row IDs, not prompt values.
- `tests/privacy-receipt.test.js`: sensitive marker absent from snapshots/export, fixed label/summary, deletion by chat ID/override, preservation of unrelated receipts and recreation of rolling background/offline receipts.
- `tests/network-exits.test.js`: text/media search calls confined to handlers whose gate precedes receipt/activity/search calls; source-reader grant check.
- `tests/sensitive-gate.test.js`: runs production main gate/handler bodies in a VM with counting fakes, checks zero calls/activity leakage on refusal, sanitized override, non-overridable crisis, and renderer inability to lower Strict. Extended during implementation with actual source-reader grant checks and actual renderer Strict-check tests (unloaded, Standard, exact category, invalid/crisis output, timeout).
- `tests/electron/sensitive-guard.test.js`: cases 1–11, counting loopback SearXNG (no request log), explicit toggle clicks, absent-model refusal, editable override/preview/sent text/chat ID, crisis in three modes, address-bar/search/image paths, receipt/export/console-marker checks, Settings switches, fresh/old profiles and Standard/Strict relaunches, local Ask handoff and receipt deletion. The orchestrator also runs the six case-9 regression scripts. Child output is checked for the marker but not forwarded; failure output contains only case IDs. **Written and syntax-checked, not executed.**

**Existing Electron test adjustments**
- `tests/electron/media-chat.test.js`: replaced all three programmatic web-toggle-on assignments with conditional clicks.
- `tests/electron/model-chat.test.js`: replaced its web-toggle-on assignment with a conditional click.
- `tests/electron/safe-redirects.test.js`: its direct preflight/source calls now first obtain genuine allowed searches from its loopback fixture; original redirect/download assertions remain. The fixture returns the specific URLs under test.
- No existing Electron test used `web=1`; the new suite deliberately uses it to verify that it is ignored. No existing Online query needed a Standard exemption or replacement. `ui-smoke`, `ask-layout`, `stage1-usability` and `offline-mode` required no toggle/query edits. They are included in the new suite's regression orchestration along with `media-chat` and `safe-redirects`.

**Deviations and implementation decisions**
1. The `// Last verified:` comment explicitly says **pending human verification by Sandeep before release**, with the text-approval date. The supplied plan establishes text approval, not an independently verified date for the numbers. No verification date was fabricated. The release checklist requires completing it.
2. The source allowlist is a bounded `Map` rather than a bare `Set`, so it can enforce sender ownership, returned URLs and expiry. Media required its own URL grants after the grep showed the existing assumption was false.
3. Added `src/sensitive-ui.js` to share the preview/panel between Ask and Search, and the small dataset adapter/log changes to avoid breaking the existing batch source-reading path or logging refused text.
4. To honor the exact table, generic “symptoms” does not add medical on top of an explicit mental/sexual-health topic (rows 13/19), and “arrested” attached to a contextual name is represented by personal information (row 31). Explicit other legal/medical terms can still add their categories. These resolve ambiguity between §4.1's example term lists and §5; the table expectations are unchanged.
5. The override editor follows the existing backend's 300-character search limit. No new network service, fallback, dependency, location lookup, or request type was added.

**Validation actually run**
- `npm run check`: attempted after implementation changes. Guard/VM tests, AI/PDF asset build, production syntax checks and unit tests before the socket stage pass. The command stops with **`listen EPERM` on `127.0.0.1` in `tests/safe-fetch-integration.test.js`**, as expected in this sandbox; it is **not** reported as a full pass.
- `node tests/offline-gate-integration.test.js`: also attempted directly; **`listen EPERM`**, before its TCP assertions. Neither socket integration suite could complete.
- Every other unit test was run directly with `node`, all **16 passed**: `address-input`, `audit-compare`, `chat-prompt`, `chat-store`, `dataset-collection`, `media-intent`, `network-exits`, `network-mode`, `permission-policy`, `privacy-attribution`, `privacy-receipt`, `safe-fetch`, `search-backend-engines`, `sensitive-gate`, `sensitive-guard`, `test-hooks` (all under `tests/`, ending `.test.js`).
- `npm run check:tests`: **passed**, syntax only. `git diff --check`: **passed**. No Electron process or Electron test was run. Claude must run `npm run check` and `npm run test:electron:sensitive-guard` outside the sandbox; the latter includes the requested six regressions.

**Manual test / remaining limits**
Follow PLAN §11: verify default-off across new/restored/URL chats; a sensitive Ask turn with and without a model; live preview after adding/removing a made-up identifier and Cancel; override text in the receipt; crisis with web on/off and Offline; Strict/Standard switches and relaunch; Search's local-Ask handoff; image refusal; deletion and exported receipts. Electron/UI behavior remains unverified here.

The PLAN §8 limits remain: English pattern matching can miss indirect/slang/other-language wording and can overblock; landmark addresses intentionally flag; names are approximate and are not removed; direct search-engine URLs and website forms are outside the guard; this is not a crisis service and contacts nobody; exported receipt files cannot be recalled. Strict's loaded-model check adds latency. Crisis numbers need human re-verification each release and crisis text needs professional review before public release.

### REVIEW (Claude)
#### Round 4 review (2026-11-10): DONE, ready for manual testing
- **Bug fixed:** the crisis check now runs before the Offline check on the Search page, in main (search, media search, source reading) and in Ask AI (submit and inline media). Verified by Electron case 18 across Search page, address bar, New Tab box, Ask AI and image search, in Offline and Online, with web off and on: the crisis text with helplines every time, 0 requests.
- **The test catches the bug:** reintroducing the old order makes case 18 fail.
- **Self-review note:** Claude finished this round after Codex stopped, and changed one test check (not product code). Sandeep's manual test is the independent check.
- **Minor, not fixed:** in the [Search anyway…] editor, typing crisis words disables Send but doesn't show the crisis text. The editor only opens for a question already classified as sensitive, not crisis.
- **Task 1c note:** harm to others will be crisis level, so it inherits this order (added to the 1c PLAN §10).

#### Round 3 review (2026-11-10): DONE, ready for manual testing
Scope respected: only `src/sensitive-guard.js` and `tests/sensitive-guard.test.js` changed. The approved texts are unchanged.
- **Checked by running `classifyQuestion`:** all 13 required variants (rows 65–77) give `crisis` in both modes, plus extras I tried: curly-apostrophe "I’m suicidal", extra spaces, "gonna kms lol". The kilometre cases give `none`: rows 78–80, plus "ran 5 kms today" and "kms from paris to lyon". The existing negatives still pass (Suicide Squad, kill a Python process, hang curtains, meal prep); "suicide rates in Japan" is still `sensitive`, not crisis.
- **Results (outside the sandbox):** `npm run check` **exit 0** (`sensitive-guard tests passed (80 rows plus review regressions)`). `test:electron:sensitive-guard` **passes** (cases 1–11 plus its six regression tests).
- **New edge cases found (not fixed; for Sandeep):** "i want to die my hair blue" (a "dye" typo) and "what does kms mean" give the crisis reply. They're in the same family as the accepted idioms.

#### Round 2 review (2026-11-10): DONE, ready for manual testing
Build–review round 2 of 2. All six Round 1 items are fixed. I re-ran `classifyQuestion` on every Round 1 case: crisis statements (rows 53–57) now give `crisis`; "how to hang a picture frame"/"curtains", "meal prep ideas", "std::vector push_back" and "compare sales 2019 2020" give `none`; "US mortgage rates" and "type I diabetes" give `none` in Standard. "how to hang myself", "HIV PrEP cost" and "I think I have an STD" still flag.

**Results (outside the sandbox):** `npm run check` **exit 0**. `test:electron:sensitive-guard` **passes** (cases 1–11, plus its regressions: ui-smoke, media-chat, safe-redirects, ask-layout, stage1-usability, offline-mode). Also run separately, all exit 0: browser-features, downloads, permissions, attachments, home-attachments, pdf-attachments, chat-deletion, single-instance. Not run (they need the real model): model-chat, generation-shutdown, auto-setup-shutdown, media-chat-live.

**Known limits added by this review (in addition to PLAN §8):**
1. Crisis wording without an apostrophe, "im suicidal", gets the general self-harm path, not crisis: no search, local answer plus the resource line. Indirect wording ("I'm so tired of everything") isn't caught at all.
2. Idioms such as "kill myself laughing" and "I cut myself shaving" get the crisis reply. Accepted: it errs on the side of caution, and the user can rephrase.
3. The `// Last verified:` comment says the numbers are pending verification. Sandeep must verify them and set the date before release, together with the professional review of the crisis text (§8 item 10).
4. Media preflight/download now need a URL that came from an allowed search result (Codex's extra fix; it closes an arbitrary-URL fetch path that existed before).

#### Round 1 review (2026-11-10): CHANGES REQUESTED
Ran outside the sandbox: `npm run check` **exit 0** (including both socket suites). `test:electron:sensitive-guard` **fails**, because the main phase waits forever (details in item 1). The structure matches the PLAN: the gate is in main before receipts/activity/fetch, crisis can't be overridden, the override sends `removeIdentifiers` text, Strict is the default, receipts have `chatId`/`sensitiveOverride` and are deleted with chats, the approved texts are exact, and the media URL grants are a sound extra. The rules have the gaps below, which I confirmed by running `classifyQuestion` directly. The ids in brackets are new §5 rows to add as tests.

**MUST FIX**
1. **Electron test can't start.** `find('sovereign://ask/')` also matches the hidden legacy-chat probe window (`sovereign://ask/legacy-chat-probe.html`, `main.js` ~5512), so the wait for `newChat` never ends. Select the visible Ask tab (exclude `legacy-chat-probe`). Also, a failed `wait()` reports only "wait", which can't be debugged. Give every wait a case-id label and print the id plus stack line numbers (never messages that could hold prompt text).
2. **Crisis misses (the model answers, or the question is searched).** "I'm suicidal", "I am feeling suicidal tonight" and "I want to commit suicide" give `sensitive (self-harm)`, the general-information path. "I want to end it all" gives **`none`**, so with web on it would be **sent to SearXNG**. First-person suicide/suicidal statements ("I'm/I am/I feel/feeling suicidal", "I want to commit suicide", "thinking about (killing myself|suicide)" with I/I'm) and "end it all", "no reason to live", "want to disappear forever" must be `crisis`. [rows 53–57]
3. **Crisis false positives (no override, no answer).** "how to hang a picture frame" and "how to hang curtains" give `crisis`, because `how to hang(?: myself)?` matches "how to hang" alone. Require a self-object (myself/yourself/oneself) or "noose". [rows 58–59]
4. **Sexual-health false positives in both modes.** "meal prep ideas" (`prep`) and "std::vector push_back" (`std`) are flagged. Match PrEP case-sensitively ("PrEP") or with HIV context, and don't treat "std" before `::` or after "c++" as STD. [rows 60–61]

**SHOULD FIX**
5. **Standard framing on lower-cased text:** "US mortgage rates today" counts "us" as personal, and "type I diabetes symptoms" counts "i". Check `us`/`I` framing against the original case and word context ("US" upper-case isn't framing; "type I", "World War I", "phase I" aren't). [rows 62–63, Standard column None]
6. **Years read as a phone number:** "compare sales 2019 2020" gives `personal-identifiers`. Skip candidates made only of 4-digit years (1900–2099) separated by spaces, `-` or `/`. [row 64]

**Accepted (add to Known limits, no code):** idioms such as "kill myself laughing" and "I cut myself shaving" give the crisis reply. That errs on the side of caution; the user can rephrase.


## Task: Sensitive-topic guard: more categories (Phase 1, Task 1c)
Status: **planning** (PLAN only, no code yet). Branch: build after Sandeep commits Task 1b (`phase-1/sensitive-guard`, or a new branch from it).

**Plan review decisions (Sandeep, 2026-11-10), applied below:**
1. Both texts approved with changes. `HARM_REPLY`'s last line is now "You can keep writing here if it helps, and please reach out to one of the people above too." `ABUSE_RESOURCES` gains "UK: National Domestic Abuse Helpline, 0808 2000 247". **Every** helpline number goes on the re-verify-before-release list (§4, §6).
2. Keep the delete-chat line. **New:** chats that trigger crisis, harm-to-others or abuse are not auto-saved. The chat asks "Save this chat? Anyone using this computer could see it." with [Save] / [Don't save] (§4.4).
3. Search anyway is allowed for abuse, with the identifier-removing preview (as planned).
4. Standard **also** flags general questions about sexual orientation, gender identity and immigration (§3, §5 rows 123 and 130).
5. (Sandeep, 2026-11-10) Agreed: [Don't save] also deletes the copy saved before the trigger, and its receipts. The bar must say so (§4.4).

### PLAN (Claude)

#### 1. Goal and scope
Add eight categories to `src/sensitive-guard.js`, using the same rules as Task 1b:
- blocked by default in Strict; with web search on, the question is answered locally with the one-sentence notice and [Search anyway…] (identifier-removed preview, editable);
- the question text is never stored in receipts, logs or test output.

Two of the new categories get fixed resources (abuse) or a fixed reply (harm to others), like self-harm.

Everything from Task 1b stays: the main-process `sensitiveGate`, Strict as the default, receipt deletion with chats, and rows 1–80 with their current expected results.

#### 2. What exists today (verified in code, Task 1b on `phase-1/sensitive-guard`)
- `LABELS` (`sensitive-guard.js` line 2): `self-harm`, `mental-health`, `medical`, `legal`, `sexual-health`, `finances`, `personal-identifiers`. `categories` follows this order.
- The legal terms (line ~77) include **`immigration status`** and **`arrested`** (`arrested` next to a contextual name counts as personal information only; row 31).
- The sexual-health terms include `pregnancy test`, `morning-after pill`, `abortion pill` (row 20).
- **Crisis plumbing** (`level: 'crisis'`) already does everything harm to others needs: main refuses even with `override`; Ask shows a fixed reply without calling the model, unchecks web for the conversation (`crisisConversation`) and creates an empty-query receipt with `crisis: true` (summary "Nothing left this device: crisis support shown"). A restored chat is recognised as a crisis chat by `message.content === CRISIS_REPLY` (`ask.js` ~1790).
- General self-harm questions get `CRISIS_SHORT_LINE` under the local answer (`ask.js` ~2004). That is the pattern for the abuse resources.
- `notSentSentence` always writes "a <label> question". With the new labels this needs "an" for vowels ("an immigration question").
- The Strict line in Settings reads "Health, legal, money and mental-health topics…" and must be widened.

#### 3. Categories and rules
Keep the same Standard/Strict meaning as Task 1b: **Strict** flags a category's terms on their own; **Standard** flags them only with personal framing (`I`, `my`, `we`, `should I`, `my <relation>` and the rest, as in Task 1b). The exceptions are marked below. Terms are matched on the normalised text from Round 3, and each category has negative guards for its other meanings.

| Key | Label (in the notice) | Strict | Standard | Main terms (examples; full list in code) | Negative guards (examples) |
|---|---|---|---|---|---|
| `harm-to-others` | harm to others | **crisis level** | **crisis level** | first-person intent to hurt someone ("I want to hurt/kill/stab/shoot/beat up/poison" + someone/him/her/them/people/my <relation>/my boss), "im going to beat him up", and requests to plan or hide harm ("how to poison someone", "get away with murder", "make someone disappear", "hurt someone without getting caught") | "How to Get Away with Murder" + cast/season/episode/show; kill + weeds/time/process/bacteria/mold; "murder mystery" |
| `abuse` | abuse or domestic violence | terms alone | personal framing | "hits/beats/hurts/threatens me", "abusive (partner/husband/wife/boyfriend/girlfriend/parent)", "domestic violence", "scared of my <relation>", "child abuse", "controls my money/phone" | "abuse of power", "substance abuse" (goes to drugs), "abuse a function/API" |
| `crime` | crime | terms alone | personal framing | arrested (moved here from legal), charged with, warrant, felony, misdemeanor, probation, parole, criminal record, plea deal, public defender, expunge, court date, "police questioned/searched/came to" | "crime rate(s)", "true crime", "Law and Order", "police academy", "court of appeals" |
| `drugs-alcohol` | drugs or alcohol | terms alone | personal framing | cocaine, heroin, meth, fentanyl, MDMA, LSD, ketamine, opioid(s), weed/marijuana/cannabis, addicted/addiction, rehab, relapse, withdrawal, sober/sobriety, alcoholic/alcoholism, "drinking problem", "drink every night", drug test, AA meeting(s), substance abuse | "how alcohol is made", "rubbing/isopropyl alcohol", "weed killer/control", "seaweed", "Prohibition", "drug store" |
| `reproductive-health` | pregnancy or reproductive health | terms alone | personal framing | pregnant, pregnancy, miscarriage, abortion, IVF, fertility, ovulation, birth control, contraception, "trying to conceive", "period is late", "missed (my) period" | "pregnant pause", "fertile soil", "fertilizer", "birth rate", "period of (history)" |
| `orientation-gender` | sexual orientation or gender identity | terms alone | **terms alone** (decision 4) | gay, lesbian, bisexual, transgender, trans (as a word, not "trans fat"), nonbinary, queer, LGBTQ, "coming out", "come out to", gender dysphoria, HRT with gender context | "trans fat", "transmission", "Queer Eye", "gay" in "Gay Nineties" |
| `immigration` | immigration | terms alone | **terms alone** (decision 4) | overstay(ed) visa, undocumented, deport(ed/ation), green card, asylum, DACA, `ICE` (upper case only, as the agency), immigration status (moved here from legal), work permit, "citizenship test" | "ice cream", "Visa card/credit/debit/gift", "Ellis Island", "immigration statistics/history" |
| `beliefs` | religion or politics | **personal framing only** | personal framing | with framing only: "my religion/faith/beliefs/political views", "leave my religion/the church", "lose/losing my faith", "convert to <religion>", "become an atheist/a Muslim/…", "who should I vote for", "my parents are conservative/liberal…" | general facts with no framing: "history of the Catholic Church", "what do Buddhists believe", "who won the 2020 election", "how do I register to vote" (voting logistics, not a belief) |

- **Order of `categories`** (and of labels in the notice): `self-harm`, `harm-to-others`, `abuse`, `mental-health`, `medical`, `legal`, `sexual-health`, `finances`, `crime`, `drugs-alcohol`, `reproductive-health`, `orientation-gender`, `immigration`, `beliefs`, `personal-identifiers`. The existing categories keep their relative order, so rows 1–80 don't change.
- **Moves:** `arrested` and `immigration status` leave the legal list. No existing row depends on them except row 31, which stays personal information only (the contextual-name rule is unchanged). `DUI`, `lawyer` and `eviction` stay legal (rows 21–22 unchanged). The pregnancy test, morning-after pill and abortion pill terms stay in sexual health, so row 20 is unchanged. New pregnancy terms go to reproductive health.
- **Crisis level:** `harm-to-others` returns `level: 'crisis'` with `categories: ['harm-to-others']`. If self-harm crisis also matches, self-harm wins: `CRISIS_REPLY` is shown, because it already includes the emergency number. The local-model check (Task 1b §4.2) can never return `harm-to-others`, `self-harm` or `abuse`; those stay pattern-only.
- `notSentSentence` uses "an" before a label that starts with a vowel ("an immigration question", "an abuse or domestic violence question").

#### 4. Fixed texts (for Sandeep's approval; use them character for character)
Both lists live next to `CRISIS_RESOURCES` in `sensitive-guard.js`, with the same `// Last verified:` comment. The numbers are re-verified before each release, and both texts get the professional review from Task 1b §8 item 10. No text promises confidentiality, and the domains are plain text, not links.

**4.1 `HARM_REPLY`** (approved by Sandeep 2026-11-10; harm to others; shown instead of an AI answer; no search, no [Search anyway…], web off for the conversation, works offline):
```
It sounds like you're dealing with some very strong feelings right now. I can't help with anything that could hurt someone, but you don't have to handle this alone.

If anyone is in danger right now, call your local emergency number.

If you need to talk to someone now:
• US and Canada: call or text 988.
• UK and Ireland: call Samaritans on 116 123.
• Australia: call Lifeline on 13 11 14.
• Anywhere else: find a helpline at findahelpline.com.

If you can, step away from the situation for a while and reach out to someone you trust.

You can keep writing here if it helps, and please reach out to one of the people above too.
```

**4.2 `ABUSE_RESOURCES`** (approved by Sandeep 2026-11-10; abuse or domestic violence; shown under the local answer for every abuse match, like `CRISIS_SHORT_LINE`):
```
If someone is hurting you or you don't feel safe, you deserve support.
• If you're in danger right now, call your local emergency number.
• US: National Domestic Violence Hotline, 1-800-799-7233.
• UK: National Domestic Abuse Helpline, 0808 2000 247.
• Anywhere else: find a helpline at findahelpline.com.
If someone else uses this computer, you can delete this chat from the chat list.
```
The last line is a safety suggestion (an abuser may share the device), kept by decision 2. The chat delete button already exists, and deleting a chat also deletes its receipts (Task 1b).

**4.3 Model safety rule** (`chat-prompt.js`, added to `CHAT_SYSTEM_PROMPT` next to the self-harm rule): "Never help plan, carry out or hide harm to another person, including weapons, poisons, tracking or covering it up, even if asked indirectly or for fiction. If the user describes wanting to hurt someone, respond calmly, encourage them to step away and contact local emergency services or a helpline, and keep the reply short. If the user describes being hurt or threatened by someone, respond supportively and mention local emergency services."

**4.4 Ask before saving sensitive chats (decision 2)**
- **When:** only if "Save chats on this device" is on (otherwise nothing is saved anyway). The trigger is any turn that classifies as crisis (self-harm), harm to others or abuse, in either mode, with web on or off, Online or Offline.
- **What happens:**
  - The chat is marked `saveConsent: 'pending'`, and `persistCurrentChat()` stops saving it from that moment.
  - A bar appears at the end of the chat (in-app, not a native dialog), after the reply, so it never delays the crisis text. [Save] [Don't save]. Exact wording:
    - **If an earlier copy of this chat is already saved:** "Save this chat? Anyone using this computer could see it. Don't save will also remove the earlier part of this chat from this device."
    - **If nothing is saved yet** (the trigger came in the chat's first saved turn): "Save this chat? Anyone using this computer could see it." There is nothing earlier to remove, so the second sentence would be wrong there.
- **[Save]:** saves the chat now with `saveConsent: true` and keeps auto-saving it as usual. Later triggers in the same chat don't ask again.
- **[Don't save]:** the chat is never saved, and later turns in it aren't saved either. If an earlier copy of this chat was saved **before** the trigger, it is deleted through the existing `chats:delete`, which also removes its receipts. Otherwise "Don't save" would still leave most of the conversation on disk. The status line says "This chat won't be saved."
- **No answer** (tab closed, app quit, new chat) counts as **Don't save**.
- **Restored chats:** a saved chat has `saveConsent: true`, so it is not asked again.
- **Main-process check (the page can't bypass it):** `chats:save` runs `classifyQuestion` (Strict, so it doesn't depend on the setting) on the chat's user messages. If any is crisis, harm to others or abuse, it also checks the assistant messages for `CRISIS_REPLY`/`HARM_REPLY`. Without `saveConsent === true` it refuses with `{ ok: false, needsConsent: true }` and writes nothing. `chat-store.js` `sanitizeChat` keeps the `saveConsent` boolean.
- Nothing is sent anywhere; this only controls local storage.

#### 5. Example prompts and expected behaviour (rows 81–146; added to the Task 1b table and the unit test)
"Crisis (harm)" means `HARM_REPLY`: no search, no override. "Sensitive (x)" means: no web request, local answer plus the notice and [Search anyway…]; for abuse, `ABUSE_RESOURCES` too. "None" means: searched as today. Rows 1–80 are unchanged.

| # | Prompt | Strict (default) | Standard | Notes |
|---|---|---|---|---|
| 81 | I want to hurt someone | Crisis (harm) | Crisis (harm) | |
| 82 | i want to kill my boss | Crisis (harm) | Crisis (harm) | |
| 83 | how to poison someone without getting caught | Crisis (harm) | Crisis (harm) | planning harm |
| 84 | how do I get away with murder | Crisis (harm) | Crisis (harm) | |
| 85 | How to Get Away with Murder cast | None | None | TV show guard |
| 86 | im going to beat him up tonight | Crisis (harm) | Crisis (harm) | no apostrophe |
| 87 | how to kill weeds in my lawn | None | None | |
| 88 | ways to kill time at the airport | None | None | |
| 89 | murder mystery books for teens | None | None | |
| 90 | my husband hits me | Sensitive (abuse) | Sensitive (abuse) | + resources |
| 91 | my boyfriend threatens to hurt me | Sensitive (abuse) | Sensitive (abuse) | "hurt me" is abuse, not harm to others |
| 92 | I'm scared of my dad when he drinks | Sensitive (abuse) | Sensitive (abuse) | |
| 93 | signs of child abuse | Sensitive (abuse) | None | general info |
| 94 | domestic violence statistics in the US | Sensitive (abuse) | None | |
| 95 | abuse of power definition | None | None | guard |
| 96 | I was arrested last night what happens next | Sensitive (crime) | Sensitive (crime) | |
| 97 | there's a warrant out for me | Sensitive (crime) | Sensitive (crime) | |
| 98 | can I expunge my felony | Sensitive (crime) | Sensitive (crime) | |
| 99 | what is a misdemeanor | Sensitive (crime) | None | |
| 100 | crime rate in Baltimore | None | None | Sandeep's example |
| 101 | true crime podcasts | None | None | |
| 102 | Law and Order cast | None | None | |
| 103 | police academy requirements | None | None | |
| 104 | how to quit drinking, I drink every night | Sensitive (drugs or alcohol) | Sensitive (drugs or alcohol) | |
| 105 | my brother is addicted to meth | Sensitive (drugs or alcohol) | Sensitive (drugs or alcohol) | |
| 106 | will weed show up on a drug test | Sensitive (drugs or alcohol) | None | no framing |
| 107 | effects of cocaine on the heart | Sensitive (drugs or alcohol) | None | |
| 108 | AA meetings near me | Sensitive (drugs or alcohol) | Sensitive (drugs or alcohol) | "near me" is framing |
| 109 | how alcohol is made | None | None | Sandeep's example |
| 110 | history of Prohibition | None | None | |
| 111 | best weed killer for lawns | None | None | guard |
| 112 | rubbing alcohol uses | None | None | guard |
| 113 | I think I'm pregnant | Sensitive (pregnancy or reproductive health) | Sensitive (pregnancy or reproductive health) | |
| 114 | my period is two weeks late | Sensitive (pregnancy or reproductive health) | Sensitive (pregnancy or reproductive health) | |
| 115 | we've been trying to conceive for a year | Sensitive (pregnancy or reproductive health) | Sensitive (pregnancy or reproductive health) | |
| 116 | how does IVF work | Sensitive (pregnancy or reproductive health) | None | |
| 117 | fertile soil for tomatoes | None | None | guard |
| 118 | pregnant pause meaning | None | None | guard |
| 119 | birth rate in Japan | None | None | |
| 120 | I think I might be gay | Sensitive (sexual orientation or gender identity) | Sensitive (sexual orientation or gender identity) | |
| 121 | how do I come out to my parents | Sensitive (sexual orientation or gender identity) | Sensitive (sexual orientation or gender identity) | |
| 122 | I'm nonbinary, how do I change my name | Sensitive (sexual orientation or gender identity) | Sensitive (sexual orientation or gender identity) | |
| 123 | LGBTQ rights in Japan | Sensitive (sexual orientation or gender identity) | Sensitive (sexual orientation or gender identity) | general; Standard flags too (decision 4) |
| 124 | trans fat foods to avoid | None | None | guard |
| 125 | transmission repair cost | None | None | |
| 126 | Queer Eye cast | None | None | guard |
| 127 | I overstayed my visa what should I do | Sensitive (immigration) | Sensitive (immigration) | |
| 128 | can ICE deport my mom | Sensitive (immigration) | Sensitive (immigration) | |
| 129 | my green card expired | Sensitive (immigration) | Sensitive (immigration) | |
| 130 | how to apply for asylum | Sensitive (immigration) | Sensitive (immigration) | general; Standard flags too (decision 4) |
| 131 | history of Ellis Island | None | None | |
| 132 | best ice cream near me | None | None | lower-case "ice" |
| 133 | Visa card travel rewards | None | None | guard |
| 134 | immigration statistics 1900 | None | None | facts about history, not a status term |
| 135 | should I leave my religion | Sensitive (religion or politics) | Sensitive (religion or politics) | Sandeep's example |
| 136 | I'm losing my faith | Sensitive (religion or politics) | Sensitive (religion or politics) | |
| 137 | who should I vote for | Sensitive (religion or politics) | Sensitive (religion or politics) | |
| 138 | my parents are conservative and I'm liberal | Sensitive (religion or politics) | Sensitive (religion or politics) | |
| 139 | history of the Catholic Church | None | None | Sandeep's example; personal only |
| 140 | what do Buddhists believe | None | None | |
| 141 | who won the 2020 election | None | None | |
| 142 | how do I register to vote | None | None | voting logistics, not a belief |
| 143 | I'm undocumented and was arrested | Sensitive (crime, immigration) | Sensitive (crime, immigration) | order per §3 |
| 144 | my husband hits me, call me at 415-555-0134 | Sensitive (abuse, personal information) | same | phone removed in the suggestion |
| 145 | I want to kill myself and my ex | Crisis (self-harm) | Crisis (self-harm) | both match; `CRISIS_REPLY` wins |
| 146 | what is substance abuse | Sensitive (drugs or alcohol) | None | not abuse |

#### 6. Files
| File | Change |
|---|---|
| `src/sensitive-guard.js` | New categories, labels, guards, moves (§3); `HARM_REPLY`, `ABUSE_RESOURCES` and their resource lists (§4); "a"/"an" in `notSentSentence`. |
| `src/ask.js` | The consent bar and `saveConsent` handling in `persistCurrentChat` (§4.4). The crisis path picks `HARM_REPLY` for `harm-to-others` (else `CRISIS_REPLY`). A restored chat counts as a crisis chat if a message equals either text. Abuse matches get `ABUSE_RESOURCES` under the local answer. The model check's allowed category list is extended, excluding self-harm, harm-to-others and abuse. |
| `src/search.js` | A crisis-level refusal for harm to others shows `HARM_REPLY` (same place the Search page shows the crisis text today), with no [Search anyway…] and no [Ask AI locally instead]. Abuse refusals show `ABUSE_RESOURCES`. |
| `src/main.js` | `chats:save` consent check (§4.4). Otherwise no new logic expected: `sensitiveGate` already refuses `crisis` and uses `categoryLabels`. CHANGES must confirm (grep) that nothing in main assumes crisis means self-harm. |
| `src/chat-store.js` | Keep the `saveConsent` boolean in `sanitizeChat`. |
| `src/privacy-receipt.js` | Crisis-level summary reads "Nothing left this device: support information shown", so it fits harm too. |
| `src/chat-prompt.js` | Rule §4.3. |
| `src/settings.html` | Strict line: "Health, legal, money, relationships, beliefs and other personal topics are never searched without asking. Most private." |
| `README.md` "Before releasing" | List **every** helpline number to re-verify: 988 (US and Canada), Samaritans 116 123 (UK and Ireland), Lifeline 13 11 14 (Australia), National Domestic Violence Hotline 1-800-799-7233 (US), National Domestic Abuse Helpline 0808 2000 247 (UK), findahelpline.com. The professional review covers `CRISIS_REPLY`, `CRISIS_SHORT_LINE`, `HARM_REPLY` and `ABUSE_RESOURCES`. |
| `tests/sensitive-guard.test.js`, `tests/sensitive-gate.test.js`, `tests/privacy-receipt.test.js`, `tests/electron/sensitive-guard.test.js` | §7. |

#### 7. Tests (write first)
**Unit:**
- `tests/sensitive-guard.test.js`: rows 81–146 added to the table data (Strict, Standard and default); failure output prints row ids only. Rows 1–80 must still pass unchanged.
  - `HARM_REPLY` and `ABUSE_RESOURCES` equal the approved texts character for character, and the resource order is checked.
  - Neither text contains "confidential", "private", "anonymous", "secret" or `http`.
  - The `// Last verified:` comment covers the new lists.
  - `notSentSentence(['immigration'])` and `notSentSentence(['abuse'])` use "an"; `notSentSentence(['crime'])` uses "a".
  - Category order follows §3 (rows 143–144).
- `tests/sensitive-gate.test.js`: harm to others with `override: true` → 0 search calls (like crisis). An abuse question with `override: true` → 1 call with identifiers removed (row 144: no phone number in the sent text).
- Chat-store unit test: `sanitizeChat` keeps `saveConsent: true` and drops non-boolean values.
- `tests/privacy-receipt.test.js`: the summary for a crisis-level receipt reads "support information shown". A refused abuse request with the marker `SECRETQ-7731` stores no question text.

**Electron (`tests/electron/sensitive-guard.test.js`, new cases 12–16):**
- 12: harm to others (row 81) with web on → `HARM_REPLY` shown, no [Search anyway…], web toggle unchecked and disabled, SearXNG 0 requests. Repeat with web off and Offline.
- 13: abuse (row 90) with web on → local path, the notice "…this looks like an abuse or domestic violence question…", `ABUSE_RESOURCES` shown, [Search anyway…] offered, 0 requests. Search anyway with row 144 → exactly 1 request, without the phone number.
- 14: one positive per new category (rows 96, 104, 113, 120, 127, 135) via the Search page → notice, 0 requests. One negative per category (rows 100, 109, 117, 124, 131, 139) → 1 request each.
- 15: restore a saved chat that contains `HARM_REPLY` → web toggle stays off for that chat.
- 16: receipts and export never contain the marker; entry labels read `blocked (sensitive topic: <new label>)`.
- 17 (save consent), with saving on:
  - (a) Row 81 → the consent bar appears; nothing is written (`chats:list` has no entry). [Don't save] → still nothing after further turns.
  - (b) New chat, ordinary question (saved), then row 90 → the bar appears with the long wording (it includes "Don't save will also remove the earlier part of this chat from this device."). [Don't save] → the earlier saved copy is gone from `chats:list`, and its receipts are gone too. In (a), the bar uses the short wording.
  - (c) Row 90 → [Save] → saved with `saveConsent: true`; a later trigger in the chat doesn't ask again.
  - (d) `chats:save` called directly with a row-1 chat and no consent → `needsConsent`, nothing written.
  - (e) Saving off → no bar.
- Regressions as in Task 1b (the suite already runs them).

#### 8. Privacy impact
- More personal topics stay local by default (Strict). No new network requests: the classifier, texts and resources are local, and the domains are plain text.
- No new stored data. Receipts store only the category label for refused requests, as in Task 1b.
- The abuse text suggests deleting the chat on a shared computer. That uses the existing deletion, which also removes the receipts.

#### 9. Known limits (in addition to Task 1b's)
1. Pattern rules miss indirect wording ("he gets angry and I have to be careful", "I want him to pay for this") and other languages. They can over-flag (rows such as 108 "near me").
2. **Harm-to-others detection is not a threat assessment.** It shows a calm reply and refuses help; it doesn't contact anyone. Fiction or venting ("I could kill my brother for eating my fries") gets `HARM_REPLY`, which errs on the side of caution, like the accepted self-harm idioms.
3. **Beliefs are personal-only in both modes,** so a personal belief question phrased without "I/my" ("is it wrong to leave Islam") is not flagged.
4. Strict flags general questions in the new categories (rows 93, 99, 106, 116, 123, 130), as it does for health and money. Standard also flags general orientation/gender and immigration questions (rows 123, 130; decision 4).
7. The save-consent check uses the pattern rules. A sensitive chat the rules miss is auto-saved as before. "Don't save" removes the app's copy, but not an exported file or a backup of the user data folder.
5. Chat history is stored locally if chat saving is on. Someone with access to the computer can read it; the abuse text points to deletion.
6. **All** helpline numbers must be re-verified before each release, and the new texts need professional review before public release.

#### 10. Do not change
- The crisis-first ordering from Task 1b Round 4 (crisis-level checks before the Offline check and every other gate). Harm to others is crisis level, so it inherits that ordering. Add a harm-to-others prompt to Task 1b's Electron case 18.
- Rows 1–80 and their expected results, `CRISIS_REPLY` and `CRISIS_SHORT_LINE`, the main-process gate design, Offline mode, Strict as the default.

#### 11. Open questions for Sandeep
- All answered 2026-11-10 (decisions at the top of this task).

#### 12. Manual tests (Sandeep)
1. **Harm to others:** with web on, type "I want to hurt someone" → `HARM_REPLY`, no [Search anyway…], and web search turns off for the chat. Repeat with web off and in Offline mode. Nothing appears in the SearXNG log.
2. **Abuse:** "my husband hits me" → a local answer, the sentence "…an abuse or domestic violence question…", the resources with the emergency number first, 1-800-799-7233 (US) and 0808 2000 247 (UK), and [Search anyway…]. The receipt says `blocked (sensitive topic: abuse or domestic violence)` with no question text.
3. **Each new category (Strict):** "I was arrested last night what happens next", "my brother is addicted to meth", "I think I'm pregnant", "I think I might be gay", "I overstayed my visa what should I do", "should I leave my religion" → each shows the notice with its category; nothing sent.
4. **Negatives:** "crime rate in Baltimore", "history of the Catholic Church", "how alcohol is made", "fertile soil for tomatoes", "trans fat foods to avoid", "best ice cream near me", "How to Get Away with Murder cast", "how to kill weeds in my lawn" → each searches normally.
5. **Standard:** switch to Standard. "what is a misdemeanor" and "how does IVF work" now search. "LGBTQ rights in Japan", "how to apply for asylum" and "I think I'm pregnant" are still blocked. Switch back to Strict.
6. **Search anyway:** "my husband hits me, call me at 415-555-0134" → the preview has no phone number; send an edited query and check the receipt shows exactly that text.
7. **Restored chat:** after test 1 (choose [Save] in the consent bar), close and reopen that chat from the list → web search is still off for it.
8. **Save consent:** turn on "Save chats on this device" in Settings.
   - Ask an ordinary question, then "my husband hits me" → the bar appears: "Save this chat? Anyone using this computer could see it. Don't save will also remove the earlier part of this chat from this device." Click [Don't save] → the chat disappears from the chat list (the earlier copy is deleted), and its receipts are gone.
   - In a new chat, start with "my husband hits me" → the bar shows only the first two sentences.
   - Repeat with "I want to hurt someone" and [Save] → the chat appears in the list and stays saved after more messages.
   - Repeat and close the tab without choosing → the chat is not in the list.

### CHANGES (Codex)
_Not started._

### REVIEW (Claude)
_Not started._
