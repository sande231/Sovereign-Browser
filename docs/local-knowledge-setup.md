# Local knowledge with Kiwix

Ask AI can search local encyclopedias without internet access. Search and the address bar remain web-only. No ZIM files are downloaded by the app. The feature starts disabled.

## Disk space and approved collections

Install Docker Desktop yourself first. From the repository root, create `kiwix/zim` and check space with `df -h .`. Keep **at least 20 GB free**, including Docker's image and VM storage (not included in the figures below). GB here means 1,000,000,000 bytes. Sizes recorded in the approved plan on 2026-11-15 from the official `.meta4` files:

| File | Exact bytes | Folder |
|---|---:|---|
| wikipedia_en_top_maxi_2026-09.zim | 6,991,081,681 | wikipedia |
| mdwiki_en_all_maxi_2025-11.zim | 2,302,838,768 | other |
| wikivoyage_en_all_nopic_2026-09.zim | 272,495,142 | wikivoyage |
| wikipedia_en_100_2026-08.zim (test, remove after setup) | 333,429,922 | wikipedia |

Set A totals **9,566,415,591 bytes** (9.57 GB); including the test file, **9,899,845,513 bytes**. Starting with 38 GB free leaves about 28.4 GB before Docker overhead. Test with the small file first. The real-server fixture, entrypoint, CSP and traffic checks below are still pending; the app's built-in entry claim is contingent on Sandeep confirming that test before release.

## Download and verify in Terminal

These are manual instructions, not commands run by Sovereign. From the repository root:

```sh
mkdir -p kiwix/zim
cd kiwix/zim
curl -fL -C - -O https://download.kiwix.org/zim/wikipedia/wikipedia_en_100_2026-08.zim
curl -fL -O https://download.kiwix.org/zim/wikipedia/wikipedia_en_100_2026-08.zim.sha256
shasum -a 256 -c wikipedia_en_100_2026-08.zim.sha256
```

Continue only if the official checksum reports `OK`. After the traffic test, stop Kiwix, remove the test ZIM, and download set A:

```sh
curl -fL -C - -O https://download.kiwix.org/zim/wikipedia/wikipedia_en_top_maxi_2026-09.zim
curl -fL -O https://download.kiwix.org/zim/wikipedia/wikipedia_en_top_maxi_2026-09.zim.sha256
shasum -a 256 -c wikipedia_en_top_maxi_2026-09.zim.sha256
curl -fL -C - -O https://download.kiwix.org/zim/other/mdwiki_en_all_maxi_2025-11.zim
curl -fL -O https://download.kiwix.org/zim/other/mdwiki_en_all_maxi_2025-11.zim.sha256
shasum -a 256 -c mdwiki_en_all_maxi_2025-11.zim.sha256
curl -fL -C - -O https://download.kiwix.org/zim/wikivoyage/wikivoyage_en_all_nopic_2026-09.zim
curl -fL -O https://download.kiwix.org/zim/wikivoyage/wikivoyage_en_all_nopic_2026-09.zim.sha256
shasum -a 256 -c wikivoyage_en_all_nopic_2026-09.zim.sha256
```

The `.sha256` files alongside the approved downloads are the official verification source. Do not substitute a locally generated hash for that check. The test file's approved SHA-256 is `2eb7fd115bfb8644a08a9482f01f52b507428b1b8a30129fead92f7b6715440b`.

## Start, use and stop

From the repository root:

```sh
cd kiwix
docker compose up -d
lsof -nP -iTCP:8090 -sTCP:LISTEN
```

The published listener must be **127.0.0.1:8090**, never `*:8090`. A second device on the LAN must not reach `http://<Mac LAN IP>:8090`. Open `http://127.0.0.1:8090` locally. Settings → Local knowledge → enable, Save, Check: confirm each book and its full-text index. Ask starts new chats with Use local knowledge checked when reachable; Search the web remains a separate checkbox.

Turn Wi-Fi off and choose Offline. Ask a factual question and open its numbered local citation. Try an image request: only local article images should appear. `nopic` collections have few or no images. The receipt should show zero external requests and local Kiwix entries. Sensitive questions can use local knowledge; crisis questions cannot. In a flagged chat, only ordinary follow-ups can use it.

```sh
# From kiwix/
docker compose stop
# Restart later
docker compose up -d
# Remove the stopped container when no longer needed
docker compose down
```

With Kiwix stopped, a local-only answer offers **Answer without sources**. Clicking runs only the on-device model and labels the answer accordingly. Turning the feature off in Settings removes its built-in Offline entry.

## One-off traffic test (Sandeep / Claude)

Run before accepting the feature. Claude also reviews the pinned kiwix-tools/libkiwix server source for HTTP clients/downloaders. These steps deliberately pull the approved images and are **not run by Codex**. Use only harmless test queries; captures can contain query text.

1. Start Kiwix with only the checksum-verified test ZIM. Inspect its command and read-only settings:

   ```sh
   docker inspect sovereign-kiwix --format '{{json .Config.Cmd}} {{.HostConfig.ReadonlyRootfs}} {{json .HostConfig.PortBindings}}'
   docker logs sovereign-kiwix
   docker top sovereign-kiwix
   ```

   Confirm `--blockexternal`, `--searchLimit 10` and the ZIM glob reach kiwix-serve, it starts under the read-only filesystem, and there is no `DOWNLOAD` or remote library configuration. If pass-through fails, stop and report for a reviewed entrypoint correction.

2. In a second terminal, capture **all** traffic in Kiwix's network namespace. Capture startup as well: start the capture against the running container, then `docker compose restart kiwix` and verify the capture remains attached; if the namespace changes, repeat with a capture started before the server process. Save a reviewed startup capture before signing off.

   ```sh
   docker run --rm --name sovereign-kiwix-traffic --network container:sovereign-kiwix --cap-add NET_RAW --cap-add NET_ADMIN nicolaka/netshoot:v0.16@sha256:b09d9b21381f47a79b3cbcb30da25266dc17186ea00ae65e99fdc51396f48e70 tcpdump -i any -nn -l
   ```

3. Exercise search, article, catalog and images in Sovereign, Offline and Online. Capture the real feed from the repository root:

   ```sh
   curl -f 'http://127.0.0.1:8090/search?pattern=Earth&format=xml&pageLength=10' -o /tmp/kiwix-search-real.xml
   curl -f 'http://127.0.0.1:8090/catalog/v2/entries' -o /tmp/kiwix-catalog-real.xml
   ```

   Replace `tests/fixtures/kiwix-search.xml` with the reviewed real capture, adapt only if necessary, and run `npm run check`. Verify real book names and FT-index tags. Open actual viewer pages and check the imposed CSP allows local functionality while external images/scripts remain blocked in both modes.

4. Expected capture: inbound Docker-forwarded local client requests to port 8080 and their replies only. Docker namespace addresses need not literally be loopback. There must be **no independently initiated DNS, TCP, UDP or other internet traffic from Kiwix**, including while idle. Distinguish replies from initiated connections. If any egress is seen, stop and report; Claude removes the feature before DONE. Record evidence, image digest, command pass-through, read-only result, listener binding, and CSP results in REVIEW.

5. Ctrl-C the capture, then remove the one-off image (never add it to compose):

   ```sh
   docker rm -f sovereign-kiwix-traffic 2>/dev/null || true
   docker rmi nicolaka/netshoot:v0.16@sha256:b09d9b21381f47a79b3cbcb30da25266dc17186ea00ae65e99fdc51396f48e70
   ```

   Delete temporary captures after review. Stop Kiwix and delete `kiwix/zim/wikipedia_en_100_2026-08.zim` before loading the final set.

## Updating and licences

Before updating, re-check the dated filename, official `.meta4` size and `.sha256`, available disk, and the new version's traffic behaviour. Download and verify the replacement, stop Kiwix, remove the old version, then `docker compose up -d` (or restart after swapping). Keeping old and new top_maxi temporarily peaks at about 16.56 GB of ZIMs, leaving about 21.44 GB from the initial 38 GB, excluding Docker. If free space before a replacement is below about 27 GB, remove the old file first; ensure at least 20 GB remains throughout. Never use an unverified file. Keep the digest pin until an approved update and repeat the traffic test.

Wikipedia text: [CC BY-SA 4.0 and GFDL](https://en.wikipedia.org/wiki/Wikipedia:Copyrights). MDWiki text: [CC BY-SA 4.0](https://mdwiki.org/wiki/WikiProjectMed:Copyrights). Wikivoyage text: [CC BY-SA 4.0](https://en.wikivoyage.org/wiki/Wikivoyage:Copyleft), with some older imported text under CC BY-SA 3.0, not GFDL. Images have individual licences. Article pages provide attribution and licence links; preserve those when reusing content. The selected MDWiki maxi has pictures, not the video in the larger all file.

## Privacy and limits

Downloading a collection reveals your IP address and collection choice to Kiwix's download server and the mirror it redirects to. **Downloads never include questions.** Afterwards questions go only to your loopback kiwix-serve. Sovereign never downloads ZIM files itself and never sends AI generation to a cloud service. The app cannot observe independent container egress, which is why the traffic test is required. Its receipt covers requests made by Sovereign, with local query strings removed.

Quality depends on the local 1B model and collection coverage; top Wikipedia is not all Wikipedia. The provisional XML parser must be checked against 3.8.2 and fails closed on malformed feeds. Even an ordinary query in a flagged chat can retrieve sensitive material; crisis-classified results are withheld.
