# Privacy audit runbook (Task 2c §9 and §10)

Copy-paste steps for the fresh audits of the current build.

**Method (since 2026-11-19, PLAN §10):** mitmproxy **local capture mode** on macOS. A network extension sends every outgoing TCP and UDP connection made by Sovereign's own processes to mitmproxy. That covers the Electron main process (Node requests such as source-page reads and image checks) and the Chromium helper processes (pages, thumbnails, model download). Connections pass through **unchanged** (TLS passthrough, `--ignore-hosts '.*'`): nothing is decrypted and **no mitmproxy certificate is installed or trusted**. `scripts/log-hosts.py` records hostnames only (TLS SNI, plain-HTTP Host header, QUIC SNI when it can be read), never paths or contents. A connection with no readable name is recorded as its destination IP and port (`203.0.113.5:80`, `[2001:db8::1]:443`). DNS lookups that macOS's resolver makes **for Sovereign** are attributed to Sovereign by macOS and are captured too (PLAN §12). They are recorded as `dns:<DNS server IP>`: the server only, never the names looked up. `scripts/audit-compare.js` compares the capture with the exported Privacy Receipt and accepts `dns:` lines only for this Mac's own nameservers (`--nameservers`, from `scutil --dns`).

The app runs **without** `SOVEREIGN_AUDIT_PROXY`, exactly as a user runs it, so the toolbar does **not** show "Audit mode". Run 1 of 2026-11-19 (`docs/audits/2026-11-19-online.txt`) used the older session-proxy method and is kept as recorded. The new runs are saved with a `-local` suffix.

Kiwix traffic test: [docs/local-knowledge-setup.md](../local-knowledge-setup.md) (section 5 below).

**What goes in the repo:** only the summaries written to `docs/audits/<date>-<run>.txt`. Raw captures (`mitm-hosts.txt`, `audit.flow`, `*.receipts.json`, `/tmp/sov-dry-check.txt`, `/tmp/sov-dns-*.txt`, `/tmp/kiwix-capture.txt`) stay out. `mitm-hosts.txt`, `audit.flow` and `*.receipts.json` are already in `.gitignore`.

**Use harmless test questions only.** The receipts and the Kiwix capture can contain query text; the summaries must not.

Every command runs from the repository root unless a step says otherwise:

```sh
cd ~/Sovereign-Browser
```

---

## 0. Prep (once)

### 0.1 mitmproxy

```sh
which mitmdump || brew install mitmproxy
mitmdump --version | head -1
```

Expected: a path such as `/opt/homebrew/bin/mitmdump`, then `Mitmproxy: 12.2.3` (or newer).

### 0.2 Quit every running Sovereign

Quit Sovereign with **Cmd-Q** in each window, then check:

```sh
pgrep -fl 'Sovereign-Browser/node_modules/electron' || echo 'no Sovereign running'
```

Expected: `no Sovereign running`. The single-instance lock is per profile folder; quitting avoids a second app sharing a profile and keeps the capture clean.

### 0.3 SearXNG: recreate with the pinned image and your own secret

The secret is stored in `searxng/.env` (git-ignored, readable only by you). Compose reads it automatically. An existing `.env` is kept.

```sh
cd ~/Sovereign-Browser/searxng
[ -f .env ] || { printf 'SEARXNG_SECRET=%s\n' "$(openssl rand -hex 32)" > .env; chmod 600 .env; }
grep -c '^SEARXNG_SECRET=' .env
docker compose up -d --force-recreate
docker inspect sovereign-searxng --format '{{.Config.Image}}'
curl -s -o /dev/null -w 'SearXNG HTTP %{http_code}\n' http://127.0.0.1:8080/
lsof -nP -iTCP:8080 -sTCP:LISTEN | tail -n +2
cd ~/Sovereign-Browser
```

Expected:
- `1` (one secret line);
- image `docker.io/searxng/searxng:2026.9.15-ca4965040@sha256:f1aca3f61c7ff4552b8d54c0ab7fb458e907b78f51c503210cf450c900adca2c`;
- `SearXNG HTTP 200` (if it says `000`, wait 5 seconds and repeat the `curl` line);
- the listener is `127.0.0.1:8080`, never `*:8080`.

### 0.4 Kiwix

```sh
ls -1 kiwix/zim/*.zim
cd ~/Sovereign-Browser/kiwix && docker compose up -d && cd ~/Sovereign-Browser
curl -s -o /dev/null -w 'Kiwix HTTP %{http_code}\n' http://127.0.0.1:8090/
lsof -nP -iTCP:8090 -sTCP:LISTEN | tail -n +2
```

Expected: the ZIM files you intend to test (Set A, or `wikipedia_en_100_2026-08.zim`); `Kiwix HTTP 200`; listener `127.0.0.1:8090`.

### 0.5 Base profile with the model cached (for the dry run and the Offline, sensitive and Kiwix runs)

**Why:** a fresh profile starts Offline and has no model. Ask AI needs the model (about 705 MB, from Hugging Face and GitHub), which can only be downloaded Online. So:

| Run | Profile | Model download during the run? |
|---|---|---|
| Dry run | fresh copy of the base profile | No |
| Online | **brand-new** `/tmp/sov-audit-online` | **Yes**, captured on purpose (it should match the receipt's Background rows) |
| Offline | fresh copy of the base profile | No (already cached) |
| Sensitive | fresh copy of the base profile | No |
| Kiwix capture | fresh copy of the base profile | No |

The base profile lives in **`~/sov-audit-base`**, not `/tmp`. In Nov 2026 a base in `/tmp` lost its model files between runs, and later the whole folder went (HANDOFF Task 2c, PLAN §13.5). It holds only the model cache and settings: no chats, no browsing. Receipts are kept in memory only, so a copy starts with an empty receipt. Each run gets its **own new copy**, so no run sees another run's state. The summaries record this. Prep runs **without** any capture; it is not part of any audit.

Terminal 1:

```sh
rm -rf ~/sov-audit-base
SOVEREIGN_USER_DATA_DIR=$HOME/sov-audit-base npm start
```

In Sovereign:
1. Toolbar shows **Offline**. Click it; if asked, confirm. The toolbar now shows **Online**.
2. Open **Ask AI**. Wait until model setup finishes (the setup notice disappears and you can type a question). This downloads about 705 MB.
3. **Settings → Local knowledge:** turn it on and **Save**. Check that the status says it is running.
4. Click the toolbar **Online** button so it shows **Offline** again (the saved mode is then Offline).
5. **Cmd-Q.**

```sh
du -sh ~/sov-audit-base ~/sov-audit-base/IndexedDB/sovereign_ask_0.indexeddb.blob
pgrep -fl 'Sovereign-Browser/node_modules/electron' || echo 'no Sovereign running'
```

Expected: about **1.3G** for the profile and about **670M** for the model files (`…indexeddb.blob`); `no Sovereign running`.

**Before every copy** (dry run, Offline, sensitive and Kiwix runs), the copy command is preceded by the same `du -sh` line. If the profile is far below 1.3G, or `du` says the `…indexeddb.blob` folder doesn't exist, **stop**: the base has lost its model. Rebuild it with the steps above, and tell Claude. Don't start the run: without the model, Ask AI shows "AI model not downloaded" and the run doesn't test what it should.

### 0.6 Local capture: target and first-time macOS approval

**How the target works** (checked in the mitmproxy_rs source that mitmproxy 12.2.x uses): `--mode local:<text>` captures every process whose **full executable path contains `<text>`** (case-sensitive). A number is a PID instead. We target Sovereign's own Electron app folder. The main process (`…/Electron.app/Contents/MacOS/Electron`) and every helper (`…/Electron.app/Contents/Frameworks/Electron Helper*.app/…`) live inside it, and no other app does.

- **Don't use `local:Electron`.** It would also catch other Electron apps. VS Code, for example, has `/Applications/Visual Studio Code.app/…/Electron Framework.framework/Helpers/chrome_crashpad_handler`.
- With the full-path target below, VS Code is **not** caught, so you can keep it open and start Sovereign from any terminal. For the Offline run's DNS check (§2), quitting other apps you don't need makes the DNS log quieter.
- A PID target is not used: helpers start later with new PIDs.

Set the target (in **every** terminal that starts `mitmdump`) and check it:

```sh
SOV_APP="$PWD/node_modules/electron/dist/Electron.app/"
ls -d "$SOV_APP" && case "$SOV_APP" in *,*|*@*|*' '*|'!'*) echo 'STOP: path contains , @ ! or a space; tell Claude';; *) echo 'target OK';; esac
```

Expected: the path, then `target OK`.

No mitmproxy certificate is needed or wanted. Check that none is trusted (mitmproxy still creates `~/.mitmproxy/mitmproxy-ca*.pem` files on first start; those are only files, not trusted):

```sh
security find-certificate -a -c mitmproxy -Z 2>/dev/null | grep -q 'SHA-1' && echo 'mitmproxy CA FOUND in a keychain: stop and tell Claude' || echo 'no mitmproxy CA in keychains'   # match a real certificate; the command's exit code alone gives a false FOUND on some Macs
```

Expected: `no mitmproxy CA in keychains`.

**First start (one-time approval).** Start a capture once (no Sovereign running):

```sh
mitmdump --mode "local:$SOV_APP" --ignore-hosts '.*' -s scripts/log-hosts.py
```

Expected (to confirm on this Mac): mitmproxy installs its signed helper app **Mitmproxy Redirector** (expected in `/Applications`). macOS then asks you to allow its network extension. Allow it in **System Settings → General → Login Items & Extensions → Network Extensions** (older macOS: **Privacy & Security**). You may also be asked to allow a proxy configuration. No `sudo` is expected. After approval, mitmdump keeps running with no errors. Stop it with **Ctrl-C**, then:

```sh
systemextensionsctl list | grep -i mitmproxy
rm -f mitm-hosts.txt
```

Expected: one line for `org.mitmproxy.macos-redirector.network-extension` with `[activated enabled]`. If macOS asked for anything other than the extension and the proxy configuration, write it down and tell Claude.

---

## Summary header (used by every run)

Each run below starts its summary with this block. Paste it as is; only the `RUN`, `MODE` and `PROFILE_NOTE` lines differ, and they are given in each run. Each run also sets `NS`, this Mac's DNS servers:

```sh
NS=$(scutil --dns | awk '/nameserver\[[0-9]+\]/ {print $3}' | sort -u | paste -sd, -); echo "$NS"
```

Stay on the same network (same Wi-Fi) for the whole run, so `NS` still matches the servers macOS used.

```sh
D=$(date +%F)
OUT="docs/audits/$D-$RUN.txt"
mkdir -p docs/audits
{
  echo "Sovereign privacy audit: $RUN"
  echo "Date: $D $(date +%H:%M:%S\ %Z)"
  echo "Commit: $(git rev-parse --short HEAD) ($(git status --porcelain | wc -l | tr -d ' ') uncommitted files)"
  echo "Electron: $(node -p "require('./node_modules/electron/package.json').version")"
  echo "macOS: $(sw_vers -productVersion) ($(uname -m))"
  echo "mitmproxy: $(mitmdump --version | head -1)"
  echo "Capture: mitmproxy local capture mode, target = Sovereign's node_modules/electron/dist/Electron.app/ (main process and helpers), TLS passthrough (--ignore-hosts '.*'), no CA installed, loopback not logged, nameless connections as IP:port, macOS resolver lookups made for Sovereign as dns:<server>, no SOVEREIGN_AUDIT_PROXY"
  echo "System nameservers (dns: lines accepted only for these): ${NS:-(not set)}"
  echo "SearXNG image: $(docker inspect sovereign-searxng --format '{{.Config.Image}}' 2>/dev/null)"
  echo "Kiwix image: $(docker inspect sovereign-kiwix --format '{{.Config.Image}}' 2>/dev/null)"
  echo "ZIM files: $(ls -1 kiwix/zim/*.zim 2>/dev/null | xargs -n1 basename | tr '\n' ' ')"
  echo "Mode: $MODE"
  echo "Profile: $PROFILE_NOTE"
  SOVEREIGN_EXPORTED_NAMES=$(env | grep -o '^SOVEREIGN_[A-Z_]*' | sort | paste -sd' ' - || true)
  echo "SOVEREIGN_ variables exported in this shell: ${SOVEREIGN_EXPORTED_NAMES:-(none)}"
  echo
} > "$OUT"
```

Expected: "(none)"; the run commands set SOVEREIGN_USER_DATA_DIR inline only, and Sovereign's own startup output in the run terminal must show no '[Sovereign]' test/audit warning (except the old session-proxy method, which uses SOVEREIGN_AUDIT_PROXY by design).

## Capture terminal (used by every run)

Terminal 1, before starting Sovereign; leave it running:

```sh
cd ~/Sovereign-Browser
SOV_APP="$PWD/node_modules/electron/dist/Electron.app/"
rm -f mitm-hosts.txt audit.flow
date '+%F %T %Z' > mitm-capture-started.txt   # marker: the capture was started for this run
mitmdump --mode "local:$SOV_APP" --ignore-hosts '.*' -s scripts/log-hosts.py
```

The marker file records when the capture started, so a run with nothing logged can still show that the capture was running. Stop it with **Ctrl-C** only **after** Sovereign has quit (Cmd-Q). Connections with no readable name are written when they close or when mitmdump stops.

---

## D. Dry run (required before Runs 1–3)

**Goal:** prove the new method sees (1) the main process's Node requests and (2) the Chromium helper's requests. If it fails, stop: don't run 1–3, and report to Claude.

Terminal 1: **Capture terminal** (above).

Terminal 2:

```sh
cd ~/Sovereign-Browser
du -sh ~/sov-audit-base ~/sov-audit-base/IndexedDB/sovereign_ask_0.indexeddb.blob   # base check (§0.5): ~1.3G and ~670M, or stop
rm -rf /tmp/sov-audit-dry && cp -R ~/sov-audit-base /tmp/sov-audit-dry
SOVEREIGN_USER_DATA_DIR=/tmp/sov-audit-dry npm start
```

In Sovereign:
1. Toolbar shows **Offline**. Click it so it shows **Online**.
2. **Ask AI**: tick **Search the web**, ask `Why is the sky blue?`. Wait for the answer. *(Source pages are read by the main process: Node.)*
   **Before going on**, open the receipt (shield) panel and check that this question has **source-page rows** (sites read for the answer). If it has none, **Search the web** wasn't ticked: start a new chat, tick it, and ask again. *(Dry run #2 failed condition 1 this way.)*
3. **Ask AI**, new chat: ask `Show me pictures of red pandas`, click **Search web for images**, and wait until thumbnails show. *(Thumbnails are loaded by the Chromium helper.)*
4. Address bar: open `https://example.org`. **Wait until the page visibly loads** (heading "Example Domain"). Write down `loaded` or `not loaded`. *(A browsing tab: Chromium helper only, never in the receipt by design.)*
5. Address bar: type `http://example.com` exactly, **with `http://`**, and press Enter. **Wait until the page visibly loads** (heading "Example Domain"). Check that the address bar still shows `http://` (not `https://`). Write down `loaded` or `not loaded`. *(Plain HTTP, no redirect: checks that the addon reads the Host header. Replaces NeverSSL, whose random redirect host and failing subpages made dry run #2 harder to read.)*
6. *Optional cross-check*, while the `example.com` tab is still open, in Terminal 2:
   ```sh
   lsof -nP -a -i -c Electron | awk 'NR==1 || /ESTABLISHED|UDP/'
   ```
   This only reads the process table and sends nothing. It lists the open connections of Sovereign's processes (main and helpers; `-c Electron` matches the start of the process name, so another app whose process name starts with "Electron" would show up too). Expect remote addresses, mostly on port 443/80. Each row's remote IP should belong to a host in the capture; compare by eye afterwards. Don't save this output in the repo.
7. Receipt panel → **Export JSON** → save.
8. **Cmd-Q.** Then **Ctrl-C** in Terminal 1.

Terminal 2:

```sh
mv "$(ls -t ~/Downloads/sovereign-privacy-receipts-*.json | head -1)" /tmp/sov-dry.receipts.json
NS=$(scutil --dns | awk '/nameserver\[[0-9]+\]/ {print $3}' | sort -u | paste -sd, -); echo "System nameservers: $NS"
node -e '
const fs = require("fs");
const r = require("/tmp/sov-dry.receipts.json");
const norm = h => String(h || "").trim().toLowerCase().replace(/^www\./, "");
const cap = new Set(fs.readFileSync("mitm-hosts.txt", "utf8").split("\n").map(norm).filter(Boolean));
const entries = r.receipts.flatMap(x => x.entries || []);
const hosts = test => [...new Set(entries.filter(test).map(e => norm(e.host)))].sort();
const show = (label, list) => console.log(label + ": " + (list.map(h => h + (cap.has(h) ? " CAPTURED" : " MISSING")).join(", ") || "(none in receipt)"));
show("Source pages (main process, Node)", hosts(e => e.category === "source-page"));
const mainImage = new Set(hosts(e => e.category === "image" && !/thumbnail preview/.test(e.whatWasSent || "")));
const thumbs = hosts(e => /thumbnail preview/.test(e.whatWasSent || ""));
show("Thumbnails, renderer-only hosts (Chromium helper, no main-process row)", thumbs.filter(h => !mainImage.has(h)));
show("Thumbnails, hosts also checked by the main process (not proof of helper capture)", thumbs.filter(h => mainImage.has(h)));
for (const h of ["example.org", "example.com"]) console.log("Browsing tab (Chromium helper, not in receipt by design): " + h + " " + (cap.has(h) ? "CAPTURED" : "MISSING"));
const doh = [...cap].filter(h => /(^|\.)doh\.|dns\.google|cloudflare-dns\.com|dns\.quad9\.net|dns\.nextdns\.io|cloudflare-ech\.com/.test(h));
console.log("DoH / ECH hosts in capture: " + (doh.join(", ") || "(none)"));
' | tee /tmp/sov-dry-check.txt
node scripts/audit-compare.js mitm-hosts.txt /tmp/sov-dry.receipts.json --nameservers "$NS"
```

The check output is also saved to `/tmp/sov-dry-check.txt`. It holds hostnames and verdicts only, and the record below includes it.

Then list the bare-IP lines **with their ports** (the compare script drops ports), and the addresses the two browsing-tab hosts resolve to now:

```sh
echo "Bare-IP lines (raw, with port):"; grep -E '^(\[[0-9a-fA-F:.]+\](:[0-9]+)?|[0-9a-fA-F]*:[0-9a-fA-F:.]*|[0-9]+(\.[0-9]+){3}(:[0-9]+)?)$' mitm-hosts.txt || echo '(none)'
for h in example.org example.com; do echo "$h resolves to: $(dig +short A $h; dig +short AAAA $h)" | tr '\n' ' '; echo; done
```

`dig` asks your normal DNS server for two public names only. It sends nothing from Sovereign.

**Pass only if all of these hold:**
1. **Source pages:** at least one host is listed and **every** one says `CAPTURED`. This proves main-process Node fetches are seen; it is the check Run 1 could not make.
2. **Thumbnails, renderer-only hosts:** at least one host is listed and says `CAPTURED`. A host with no main-process row for it can only have been contacted by the Chromium helper, so this alone proves helper capture. (Hosts in the "also checked by the main process" line don't count.)
3. **Browsing tabs:** `example.org CAPTURED` and `example.com CAPTURED`, and you wrote down `loaded` for both. If a page didn't visibly load, its `MISSING` doesn't count as a failure: write down why (error page, typed into the wrong field) and repeat that step in a new dry run.
4. `IN NETWORK CAPTURE BUT NOT IN RECEIPT:` lists only `example.org` and `example.com` (and hosts those pages load, if any). Any other host means another process was caught or a request is missing from the receipt: stop and report.
5. `DoH / ECH hosts in capture: (none)`. Since PLAN §11, Sovereign turns off Chromium's own resolver and DoH, so a `doh.…` host (for example `doh.xfinity.com`) or an ECH outer name means that change isn't working. *(Exception: if you have set up encrypted DNS for the whole Mac, for example with a configuration profile, macOS's own lookups for Sovereign may show up as that provider's DoH host. Report it and say which profile it is.)*
6. **Bare IPs:** `BARE IPs IN CAPTURE, NO HOSTNAME` is `(none)`, **with one exception.** A bare-IP line is allowed only if both of these hold:
   - its port is **80 or 443**;
   - its address is in the `example.org` or `example.com` "resolves to" output above.

   With port logging, IPv4 shows as `203.0.113.5:80` and IPv6 as `[2606:4700:10::6814:179a]:80`. Such a line is a browsing-tab connection that closed before sending any bytes (for example a Chromium preconnect). Write it into the record as `browsing-tab preconnect: <ip>:<port> = <host>` (see below).

   Report any other bare IP to Claude (run `cat mitm-hosts.txt`), including:
   - a line with no port;
   - a port other than 80 or 443;
   - an address that neither name resolves to.

   A DNS server no longer shows here: it is a `dns:` line (condition 7).
7. **DNS:** `DNS TO OTHER SERVERS, NOT A SYSTEM NAMESERVER` is `(none)`. `DNS VIA SYSTEM RESOLVER` may list your nameservers (the `NS` line): those are macOS's lookups made for Sovereign, which is expected while Online. A `dns:` line to any other server means a lookup that didn't go through the Mac's own DNS settings: stop and report it.

**Run the dry run only after both of these are in your build** (`docs/HANDOFF.md`, Task 2c):
- **the §11 resolver change.** Without it, conditions 5 and 6 fail by design on networks whose DNS provider Chromium upgrades to DoH (for example Comcast/Xfinity);
- **the §12 capture change** (`scripts/log-hosts.py`: ports and `dns:` lines; `scripts/audit-compare.js`: `--nameservers`). A capture made before it has bare IPs with no port and DNS servers as bare IPs, so conditions 6 and 7 can't be checked. To check that you have it: `grep -c 'dns:' scripts/log-hosts.py` prints a number above 0.

If it passes, save a short record (hostnames and verdicts only):

```sh
RUN=dryrun-local; MODE="Online (base copy switched to Online)"; PROFILE_NOTE="fresh copy of ~/sov-audit-base (model cache and settings only)"
```

Paste the **Summary header** block **from this file as it is now**, not from an older copy or your shell history. Check: `grep -c 'dns:<server>' "$OUT"` prints `1`. Then:

```sh
node scripts/audit-compare.js mitm-hosts.txt /tmp/sov-dry.receipts.json --nameservers "$NS" >> "$OUT"
{ echo; echo "CHECK SCRIPT (conditions 1, 2, 3, 5):"; sed 's/^/  /' /tmp/sov-dry-check.txt; echo; } >> "$OUT"
echo "Hosts captured: $(wc -l < mitm-hosts.txt | tr -d ' ')" >> "$OUT"
echo "Dry-run purpose: source pages (main process), renderer-only thumbnails and two browsing tabs (example.org over HTTPS, example.com over plain HTTP; Chromium helper; not in the receipt by design, so they are expected under IN NETWORK CAPTURE BUT NOT IN RECEIPT); no DoH host; bare IPs only as browsing-tab preconnects on port 80/443 to an address of that tab's host; dns: lines only to the system nameservers" >> "$OUT"
ORG_LOADED=loaded; COM_LOADED=loaded   # set either to "not loaded" if that page didn't visibly load
echo "Browsing tabs visibly loaded (as written down): example.org=$ORG_LOADED example.com=$COM_LOADED" >> "$OUT"
PRECONNECTS="none"   # or e.g. "[2606:4700:10::6814:179a]:80 = example.com", checked by hand under condition 6
echo "Browsing-tab preconnects (bare IPs allowed by condition 6, checked by hand): $PRECONNECTS" >> "$OUT"
cat "$OUT"
```

---

## 1. Online run (redo with local capture)

Terminal 1: **Capture terminal**.

Terminal 2 (app):

```sh
cd ~/Sovereign-Browser
rm -rf /tmp/sov-audit-online
SOVEREIGN_USER_DATA_DIR=/tmp/sov-audit-online npm start
```

In Sovereign:
1. Toolbar shows **Offline** (new install). Click it; confirm if asked. It shows **Online**.
2. Open **Ask AI** and wait for model setup to finish (about 705 MB).
3. **Search** tab: search `photosynthesis`.
4. **Ask AI**: tick **Search the web**, ask `Why is the sky blue?`. Wait for the answer.
5. **Ask AI**, new chat: ask `Show me pictures of red pandas`, then click **Search web for images**.
6. Open the shield (receipt) panel → **Export JSON** → save (the default is `~/Downloads/sovereign-privacy-receipts-<date>.json`).
7. **Cmd-Q.** Then stop Terminal 1 with **Ctrl-C**.

Don't open any other website in this run (browsing tabs are not in the receipt by design).

Terminal 2:

```sh
mv "$(ls -t ~/Downloads/sovereign-privacy-receipts-*.json | head -1)" /tmp/sov-online.receipts.json
RUN=online-local; MODE="Online (new install switched to Online)"; PROFILE_NOTE="brand-new /tmp/sov-audit-online; model downloaded during this run"
NS=$(scutil --dns | awk '/nameserver\[[0-9]+\]/ {print $3}' | sort -u | paste -sd, -); echo "$NS"
```

Then paste the **Summary header** block, then:

```sh
node scripts/audit-compare.js mitm-hosts.txt /tmp/sov-online.receipts.json --nameservers "$NS" >> "$OUT"
echo "Hosts captured: $(wc -l < mitm-hosts.txt | tr -d ' ')" >> "$OUT"
cat "$OUT"
```

Expected:
- last verdict line `PASS: no uncaptured hosts and no cloud-AI hosts`;
- `IN NETWORK CAPTURE BUT NOT IN RECEIPT:` `(none)` and `BARE IPs IN CAPTURE, NO HOSTNAME (check by hand):` `(none)`;
- MATCHED includes the model hosts (e.g. `huggingface.co`, `raw.githubusercontent.com`), the image hosts **and the source-page hosts** (unlike the 2026-11-19 session-proxy run);
- under "IN RECEIPT BUT NOT IN CAPTURE" only `127.0.0.1` and `local (kiwix, 127.0.0.1)` (loopback is not logged);
- `DNS VIA SYSTEM RESOLVER` lists only your nameservers (expected Online) and `DNS TO OTHER SERVERS…` is `(none)`.

If the verdict is `REVIEW`, keep `mitm-hosts.txt` and the receipt, and report to Claude before saving anything else.

---

## 2. Offline run

Terminal 1: **Capture terminal**.

Terminal 3 (DNS, supporting evidence; needs your password):

```sh
sudo tcpdump -n -l -i any 'port 53' 2>/dev/null | tee /tmp/sov-dns-offline.txt
```

Terminal 2 (Wi-Fi stays **on**; Kiwix running):

```sh
cd ~/Sovereign-Browser
du -sh ~/sov-audit-base ~/sov-audit-base/IndexedDB/sovereign_ask_0.indexeddb.blob   # base check (§0.5): ~1.3G and ~670M, or stop
rm -rf /tmp/sov-audit-offline && cp -R ~/sov-audit-base /tmp/sov-audit-offline
SOVEREIGN_USER_DATA_DIR=/tmp/sov-audit-offline npm start
```

In Sovereign (toolbar shows **Offline**; **don't** switch to Online):
1. **Ask AI**: untick **Use local knowledge**, then ask `Write a two-line poem about rain.` (plain question). The local model should answer it (with "No sources: answer from the AI alone"). With local knowledge on, a question that has no local article gives **Not found** by design, and the model is not asked.
2. **Ask AI**, new chat: tick **Use local knowledge** again, then ask `How tall is Mount Everest?`. With the full Set A collections, expect a local-knowledge answer: click its citation **[1]** and check that the local article opens. With only Wikipedia 100 (no article on it), **Not found** is expected.
3. Check that **Search the web** and the image button are disabled, with the Offline note.
4. Address bar: type `https://example.com` and press Enter. The load fails: expect a **blank view** in a tab titled **Offline**, and in the toolbar status line, for a few seconds (about 4), `Offline mode is on, so this site can't load. Switch to Online to open it.` There is no separate block page.
5. **Search** tab: search `photosynthesis`. Expect the Offline message.
6. Receipt panel → **Export JSON** → save.
7. **Cmd-Q.** Then **Ctrl-C** in Terminal 1 and in Terminal 3.

Terminal 2:

```sh
mv "$(ls -t ~/Downloads/sovereign-privacy-receipts-*.json | head -1)" /tmp/sov-offline.receipts.json
RUN=offline-local; MODE="Offline (whole run)"; PROFILE_NOTE="fresh copy of ~/sov-audit-base (model cache and settings only; saved mode Offline; local knowledge on)"
NS=$(scutil --dns | awk '/nameserver\[[0-9]+\]/ {print $3}' | sort -u | paste -sd, -); echo "$NS"
```

Paste the **Summary header** block, then:

```sh
echo "Capture running: started $(cat mitm-capture-started.txt 2>/dev/null || echo 'NOT RECORDED (no mitm-capture-started.txt; stop and report)')" >> "$OUT"
if [ -f mitm-hosts.txt ]; then
  echo "Hosts captured: $(wc -l < mitm-hosts.txt | tr -d ' ')" >> "$OUT"
  echo "DNS lookups attributed to Sovereign (dns: lines): $(grep -c '^dns:' mitm-hosts.txt || true)" >> "$OUT"
else
  echo "Hosts captured: 0 (no mitm-hosts.txt: the capture ran and logged nothing)" >> "$OUT"
  echo "DNS lookups attributed to Sovereign (dns: lines): 0" >> "$OUT"
  : > mitm-hosts.txt   # empty file for audit-compare
fi
node scripts/audit-compare.js mitm-hosts.txt /tmp/sov-offline.receipts.json --nameservers "$NS" >> "$OUT"
echo "Receipt hosts: $(node -e "const r=require('/tmp/sov-offline.receipts.json');console.log([...new Set(r.receipts.flatMap(x=>x.entries||[]).map(e=>e.host))].join(' ')||'(none)')")" >> "$OUT"
DNS_HOSTS='example\.com|huggingface\.co|hf\.co|githubusercontent\.com|nasa\.gov|noaa\.gov|weather\.gov|pexels\.com'
echo "DNS (supporting, whole machine): $(grep -c . /tmp/sov-dns-offline.txt | tr -d ' ') port-53 lines in total; lines naming hosts this app used Online: $(grep -ciE "$DNS_HOSTS" /tmp/sov-dns-offline.txt || true)" >> "$OUT"
cat "$OUT"
```

Expected:
- `Capture running: started <date and time of this run>`. If it says `NOT RECORDED`, the run doesn't count: redo it with the capture terminal started first;
- `Hosts captured: 0` (with `(no mitm-hosts.txt: …)` when nothing at all was logged);
- `IN NETWORK CAPTURE BUT NOT IN RECEIPT:` `(none)` and no bare IPs;
- `DNS lookups attributed to Sovereign (dns: lines): 0`, and both DNS sections `(none)`. Offline, Sovereign shouldn't look up any name. This is the app-attributed DNS check; the `tcpdump` below covers the whole machine and is only supporting. If it isn't 0, keep `mitm-hosts.txt` and report;
- `Receipt hosts:` only `127.0.0.1` (Kiwix), or `(none)`;
- DNS: `lines naming hosts this app used Online: 0`. The total may be above 0, because other apps and macOS also use DNS. If the named count is not 0, run `grep -iE "$DNS_HOSTS" /tmp/sov-dns-offline.txt` and report it.

No audit proxy is set, so Offline mode runs with all its layers, including its black-hole proxy on `127.0.0.1:9`. That loopback connection is not logged. Local capture sees any connection Sovereign's processes open to a non-loopback address, including the main process's Node requests.

---

## 3. Sensitive-chat run

Terminal 1: **Capture terminal**.

Terminal 2:

```sh
cd ~/Sovereign-Browser
du -sh ~/sov-audit-base ~/sov-audit-base/IndexedDB/sovereign_ask_0.indexeddb.blob   # base check (§0.5): ~1.3G and ~670M, or stop
rm -rf /tmp/sov-audit-sensitive && cp -R ~/sov-audit-base /tmp/sov-audit-sensitive
SOVEREIGN_USER_DATA_DIR=/tmp/sov-audit-sensitive npm start
```

In Sovereign:
1. Toolbar shows **Offline**. Click it so it shows **Online**.
2. **Settings:** check that the sensitive-topic setting is **Strict** (the default).
3. **Ask AI:** click **Load cached model**. Wait for `Local model ready.`, then wait **30 more seconds**. (The model loads only on a first question or this click, never on the switch to Online. Loading it may contact the model hosts; see HANDOFF Task 2c, PLAN §13. A DNS lookup line is written only when its connection closes, so the 30 seconds let those lines arrive before the baseline.)

Terminal 2 (baseline, before the sensitive question):

```sh
[ -f mitm-hosts.txt ] && sort -u mitm-hosts.txt > /tmp/sov-sensitive-baseline.txt || : > /tmp/sov-sensitive-baseline.txt
cat /tmp/sov-sensitive-baseline.txt
```

Any number of lines is fine here. Expected: only model hosts (`huggingface.co`, `raw.githubusercontent.com`, `*.hf.co`) and `dns:` lines for the system nameservers. No search, source or SearXNG host.

4. **Ask AI:** tick **Search the web**, ask `I have a fever, what should I take?`. Expect the sensitive-topic notice. **Don't** click [Search anyway…]. Wait **30 seconds**.

Terminal 2 (second snapshot; the test is the lines that are new since the baseline):

```sh
[ -f mitm-hosts.txt ] && sort -u mitm-hosts.txt > /tmp/sov-sensitive-after.txt || : > /tmp/sov-sensitive-after.txt
comm -13 /tmp/sov-sensitive-baseline.txt /tmp/sov-sensitive-after.txt | tee /tmp/sov-sensitive-new.txt | wc -l
```

Expected: `0`. This includes `dns:` lines: a lookup made for the sensitive question would show up here as well. (A connection without a hostname is written only when it closes, so also check the final summary's bare-IP and DNS sections.)

5. **Ask AI**, **new chat** (control): tick **Search the web**, ask `Why is the sky blue?`. Wait for the answer.
6. Receipt panel → **Export JSON** → save.
7. **Cmd-Q.** Then **Ctrl-C** in Terminal 1.

Terminal 2:

```sh
mv "$(ls -t ~/Downloads/sovereign-privacy-receipts-*.json | head -1)" /tmp/sov-sensitive.receipts.json
RUN=sensitive-local; MODE="Online, Strict"; PROFILE_NOTE="fresh copy of ~/sov-audit-base (model cache and settings only; switched to Online at start; local knowledge on)"
NS=$(scutil --dns | awk '/nameserver\[[0-9]+\]/ {print $3}' | sort -u | paste -sd, -); echo "$NS"
```

Paste the **Summary header** block, then:

```sh
{ echo "Baseline hosts (after Local model ready + 30 s, before the sensitive question): $(wc -l < /tmp/sov-sensitive-baseline.txt | tr -d ' ')"; sed 's/^/  /' /tmp/sov-sensitive-baseline.txt; } >> "$OUT"
echo "New hosts after the sensitive question (30 s), before the control: $(wc -l < /tmp/sov-sensitive-new.txt | tr -d ' ')" >> "$OUT"
echo "Sensitive question's test word, lines found in the exported receipt: $(grep -ci fever /tmp/sov-sensitive.receipts.json || true)" >> "$OUT"
echo "Sensitive question's test word, lines found in the hostname capture: $(grep -ci fever mitm-hosts.txt || true)" >> "$OUT"
node scripts/audit-compare.js mitm-hosts.txt /tmp/sov-sensitive.receipts.json --nameservers "$NS" >> "$OUT"
cat "$OUT"
```

Expected:
- `New hosts after the sensitive question (30 s), before the control: 0`;
- every baseline host is in MATCHED, and the receipt files it as a `model-download` row (Background, or the Ask page's receipt at the time);
- both test-word counts `0` (the labels avoid the word itself, so §4 stays at 0);
- verdict `PASS: no uncaptured hosts and no cloud-AI hosts`, no bare IPs, `DNS TO OTHER SERVERS…` `(none)`; the source hosts in MATCHED come from the control question only.

If the new-hosts count is not 0, write down the hosts (`cat /tmp/sov-sensitive-new.txt`) and check them against the receipt rows before saving anything. Report them to Claude. Do the same if the baseline has anything other than model hosts and nameserver `dns:` lines.

---

## 4. Check the summaries contain no query text

```sh
grep -ciE 'fever|sky|panda|photosynth|everest|poem|rain' docs/audits/*-local.txt
```

Expected: every file `:0` (the runs can be on different dates, so this checks every `*-local.txt`). If not, run the same `grep -niE …` to see the lines and report them to Claude before changing the file.

---

## 5. Kiwix capture summary

Uses the one-off capture image already approved for traffic tests (`docs/local-knowledge-setup.md`); it is removed at the end and never added to a compose file. No mitmproxy for this run.

Terminal 1 (capture; leave running):

```sh
docker run --rm --name sovereign-kiwix-traffic --network container:sovereign-kiwix --cap-add NET_RAW --cap-add NET_ADMIN nicolaka/netshoot:v0.16@sha256:b09d9b21381f47a79b3cbcb30da25266dc17186ea00ae65e99fdc51396f48e70 tcpdump -i any -nn -l | tee /tmp/kiwix-capture.txt
```

Terminal 2:

```sh
cd ~/Sovereign-Browser
du -sh ~/sov-audit-base ~/sov-audit-base/IndexedDB/sovereign_ask_0.indexeddb.blob   # base check (§0.5): ~1.3G and ~670M, or stop
rm -rf /tmp/sov-audit-kiwix && cp -R ~/sov-audit-base /tmp/sov-audit-kiwix
SOVEREIGN_USER_DATA_DIR=/tmp/sov-audit-kiwix npm start
```

> **One-off note (2026-11-22 Kiwix run only; approved by Sandeep).** The existing `/tmp/sov-audit-kiwix` was copied from a base that had lost its model ("AI model not downloaded"). For this run only, **reuse that copy** (skip the `du`/`rm`/`cp` lines above; just `SOVEREIGN_USER_DATA_DIR=/tmp/sov-audit-kiwix npm start`) and **don't start Terminal 1 yet**:
> 1. Switch **Online**. In **Ask AI**, start the model download, and ask nothing. Leave **Search the web** off.
> 2. Wait for "downloaded and ready" (switching to Offline mid-download cancels it). Then in Terminal 2: `du -sh /tmp/sov-audit-kiwix /tmp/sov-audit-kiwix/IndexedDB/sovereign_ask_0.indexeddb.blob`. Expect ~1.3G and ~670M.
> 3. Switch back to **Offline**. Only now start **Terminal 1** (the tcpdump), then ask the 5 questions below. If Ask AI shows "Load cached model" or answers, that also shows Offline answering works (Run 2 didn't show it).
> 4. After the summary block, also run:
>    `echo "Profile: copy of /tmp/sov-audit-base without model files; model downloaded Online before the capture; capture started after switching to Offline" >> "$OUT"`
>
> From the next run on, use a copy of `~/sov-audit-base` (§0.5) and skip this note.

In Sovereign (stay **Offline**), ask these 5 questions in **Ask AI**, each in a new chat, and open the citation **[1]** of each answer:
1. `How tall is Mount Everest?`
2. `What is photosynthesis?`
3. `Who was Albert Einstein?`
4. `What is the population of Tokyo?`
5. `Show me pictures of red pandas`

Then wait **2 minutes** idle (to catch any background traffic), **Cmd-Q**, and **Ctrl-C** in Terminal 1.

Terminal 2:

```sh
D=$(date +%F); CAP=/tmp/kiwix-capture.txt; OUT="docs/audits/$D-kiwix-capture-summary.txt"
{
  echo "Sovereign Kiwix traffic capture summary"
  echo "Date: $D"
  echo "Commit: $(git rev-parse --short HEAD) ($(git status --porcelain | wc -l | tr -d ' ') uncommitted files)"
  echo "macOS: $(sw_vers -productVersion) ($(uname -m))"
  echo "Kiwix image: $(docker inspect sovereign-kiwix --format '{{.Config.Image}}')"
  echo "Kiwix args: $(docker inspect sovereign-kiwix --format '{{json .Config.Cmd}}')"
  echo "Read-only root filesystem: $(docker inspect sovereign-kiwix --format '{{.HostConfig.ReadonlyRootfs}}')"
  echo "Port bindings: $(docker inspect sovereign-kiwix --format '{{json .HostConfig.PortBindings}}')"
  echo "ZIM files: $(ls -1 kiwix/zim/*.zim | xargs -n1 basename | tr '\n' ' ')"
  echo "Capture: tcpdump -i any -nn in the Kiwix container's network namespace; 5 local questions with citations opened, then 2 minutes idle"
  echo "Capture start: $(head -1 "$CAP" | cut -d' ' -f1)   end: $(tail -1 "$CAP" | cut -d' ' -f1)"
  echo "Total lines: $(wc -l < "$CAP" | tr -d ' ')"
  echo "SYN packets (connection starts): $(grep -c 'Flags \[S\]' "$CAP" || true)"
  echo "  to port 8080 (inbound requests): $(grep 'Flags \[S\]' "$CAP" | grep -c '\.8080: ' || true)"
  echo "  to anywhere else: $(grep 'Flags \[S\]' "$CAP" | grep -vc '\.8080: ' || true)"
  echo "Outgoing IP packets not from port 8080: $(grep -E ' Out IP6? ' "$CAP" | grep -vcE ' Out IP [0-9.]+\.8080 > ' || true)"
  echo "DNS (port 53) lines: $(grep -cE '\.53[: ]' "$CAP" || true)"
  echo "UDP lines: $(grep -ci udp "$CAP" || true)"
  echo "ICMP lines: $(grep -ci icmp "$CAP" || true)"
  echo "IPv6 lines: $(grep -c ' IP6 ' "$CAP" || true)"
} > "$OUT"
cat "$OUT"
```

Expected:
- `Kiwix args` include `--blockexternal`, `--searchLimit`, `10`, `*.zim`; read-only `true`; port bindings only `127.0.0.1` / `8090`;
- `SYN … to anywhere else: 0`;
- `Outgoing IP packets not from port 8080: 0`;
- DNS, UDP, ICMP and IPv6 all `0`.

If any of these is not 0, keep `/tmp/kiwix-capture.txt`, don't delete anything, and report to Claude.

Remove the capture image:

```sh
docker rm -f sovereign-kiwix-traffic 2>/dev/null || true
docker rmi nicolaka/netshoot:v0.16@sha256:b09d9b21381f47a79b3cbcb30da25266dc17186ea00ae65e99fdc51396f48e70
```

---

## 6. Clean up (after Claude has reviewed the summaries)

### 6.1 Disable the mitmproxy network extension

Make sure no `mitmdump` is running (Ctrl-C in every capture terminal), then:

1. **System Settings → General → Login Items & Extensions → Network Extensions** (the ⓘ button): turn **Mitmproxy Redirector** off.
2. **System Settings → Network → VPN & Filters** (if present): if a Mitmproxy Redirector proxy or filter entry is listed, select it and remove it.
3. Check:

```sh
pgrep -fl mitmdump || echo 'no mitmdump running'
systemextensionsctl list | grep -i mitmproxy || echo 'no mitmproxy extension listed'
security find-certificate -a -c mitmproxy -Z 2>/dev/null | grep -q 'SHA-1' && echo 'mitmproxy CA FOUND in a keychain' || echo 'no mitmproxy CA in keychains'   # match a real certificate; the exit code alone gives a false FOUND on some Macs
scutil --proxy | grep -E '(HTTP|HTTPS|ProxyAutoConfig)Enable : 1' || echo 'no system proxy set'
```

Expected: `no mitmdump running`; the extension shows as disabled (for example `[activated disabled]`) or isn't listed; `no mitmproxy CA in keychains`; `no system proxy set`. If a proxy line is printed, check **System Settings → Network → (your network) → Details → Proxies** and report it before changing anything.

Optional, to remove it completely: move `/Applications/Mitmproxy Redirector.app` to the Trash. macOS asks to confirm removing its extension. A later `mitmdump --mode local` would install it again and ask for approval again.

### 6.1a Docker capture image

```sh
if docker info >/dev/null 2>&1; then
  docker images | grep -i netshoot || echo 'no netshoot image'
  docker ps -a --format '{{.Names}}' | grep -i sovereign-kiwix-traffic || echo 'no capture container'
else
  echo 'Docker is not running: start Docker Desktop and run this again (no result yet)'
fi
```

Expected: `no netshoot image` (removed at the end of §5) and `no capture container`. If Docker isn't running, the check stops without an all-clear: an empty answer from a stopped Docker would look the same as "nothing found". SearXNG and Kiwix keep running: they are the app's own setup.

### 6.2 Files

**Do this after the README screenshots** (screenshot 8 re-runs `audit-compare` on the sensitive run's raw files).

**Now: move the raw files out of the repo and `/tmp`, and keep them until the task is DONE** (in case a reviewer asks for a recheck). None of them is ever committed.

```sh
cd ~/Sovereign-Browser
RAW=~/sov-audit-raw-2026-11; mkdir -p "$RAW" && chmod 700 "$RAW"
for f in mitm-hosts.txt /tmp/sov-sensitive.receipts.json /tmp/sov-sensitive-baseline.txt /tmp/sov-sensitive-after.txt /tmp/sov-sensitive-new.txt /tmp/sov-sensitive-before-control.txt /tmp/kiwix-capture.txt /tmp/sov-dry.receipts.json /tmp/sov-dry-check.txt /tmp/sov-online.receipts.json /tmp/sov-offline.receipts.json /tmp/sov-dns-offline.txt; do [ -f "$f" ] && mv "$f" "$RAW/"; done
rm -f mitm-capture-started.txt audit.flow
rm -rf /tmp/sov-audit-dry /tmp/sov-audit-online /tmp/sov-audit-offline /tmp/sov-audit-sensitive /tmp/sov-audit-kiwix
ls -la "$RAW"; ls docs/audits/; git status --porcelain --ignored | grep -iE 'mitm|receipts|audit\.flow' || echo 'no capture files left in the repo'
```

Expected:
- `$RAW` lists the files that still existed;
- `no capture files left in the repo`;
- `docs/audits/` holds `RUNBOOK.md` and the six summaries: `2026-11-19-dryrun-local.txt`, `2026-11-19-online-local.txt`, `2026-11-19-offline-local.txt`, `2026-11-19-online.txt` (the older session-proxy method, kept as recorded), `2026-11-20-sensitive-local.txt` and `2026-11-22-kiwix-capture-summary.txt`.

**After DONE:**

```sh
rm -rf ~/sov-audit-raw-2026-11
rm -rf ~/sov-audit-base   # only if no further audit or screenshots are planned
```

## Limits of this audit

- **Hostnames only.** TLS passthrough records hosts (from SNI), not paths or contents. Connections with no readable name (no SNI, no Host header, QUIC whose SNI can't be read) are logged as IP and port and flagged for a manual check.
- **DNS: which server, not which names.**
  - Sovereign's Node code and, since PLAN §11, Chromium both resolve names through macOS's resolver (`mDNSResponder`). Sovereign turns off Chromium's built-in resolver, its automatic DoH upgrade and HTTPS-record lookups.
  - Before that change, Chromium sent its own DNS and DoH (seen in the 2026-11-19 dry run as `doh.xfinity.com` and the DNS server's IP).
  - macOS attributes the resolver's lookups to the app they are made for. The capture therefore sees lookups made for Sovereign as `dns:<server>` lines. This was confirmed on 2026-11-19 with `tcpdump -k`: sender `mDNSResponder`, made for `Electron`, and no DNS packet sent by an Electron process itself.
  - The addon doesn't read DNS contents, so the summary shows which servers were asked, not which names.
  - A lookup answered from macOS's DNS cache sends nothing, so it leaves no line. The lines show that lookups happened, not how many.
  - If macOS itself is set up for encrypted DNS, these lookups go to the provider's DoH server over HTTPS and appear as that hostname instead.
  - The Offline run's `tcpdump` on port 53 stays as supporting, whole-machine evidence.
- **Loopback is not logged.** SearXNG, Kiwix and Offline mode's black-hole proxy (`127.0.0.1:9`) stay on the machine and appear only in the receipt. SearXNG's own requests to search engines come from its Docker container, not from Sovereign, so they appear in neither the capture nor the receipt.
- **Only Sovereign's processes are targeted** (by executable path, plus traffic that macOS attributes to them, such as the DNS lookups above). Traffic another process makes on its own account is not captured.
- **mitmproxy can affect what it relays.** In the 2026-11-19 dry run #2, NeverSSL failed because mitmproxy itself couldn't connect to NeverSSL's IPv6 address on port 80 (`[Errno 60]`, timeout), not because of Sovereign. A page that fails under capture should be retried without capture before it is counted against the app.
- **Loopback is not logged.** SearXNG, Kiwix and Offline mode's black-hole proxy (`127.0.0.1:9`) stay on the machine and appear only in the receipt. SearXNG's own requests to search engines come from its Docker container, not from Sovereign, so they appear in neither the capture nor the receipt.
- **Only Sovereign's processes are targeted** (by executable path). Traffic that macOS or another process makes on Sovereign's behalf (for example DNS, above) is not captured.
- **The method depends on a third-party macOS network extension** (mitmproxy's). If it fails to intercept a flow, that flow goes out directly and isn't seen. The dry run checks that both process kinds are seen; it can't prove that every flow is.
- **The 2026-11-19 Online summary used the older session-proxy method.** That method doesn't see the main process's Node requests (source pages, image checks) or DNS. Its PASS covers session-proxy traffic only; see the note at the end of that file.
