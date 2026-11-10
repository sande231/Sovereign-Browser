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

## Batch summary
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
