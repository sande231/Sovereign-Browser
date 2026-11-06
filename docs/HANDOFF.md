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
