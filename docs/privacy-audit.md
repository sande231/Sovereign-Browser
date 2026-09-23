# Sovereign Privacy Receipt Audit

This guide compares Sovereign's in-app privacy receipt with a hostname-level network capture. It is intended for development verification, not as a production privacy guarantee.

The audit uses Electron's normal proxy support. Sovereign does **not** disable certificate checks and does not add `ignore-certificate-errors`. The mitmproxy command below uses TLS passthrough, so it records hostnames without decrypting HTTPS content.

## 1. Install mitmproxy

```sh
brew install mitmproxy
```

## 2. Start the Hostname Capture

From the Sovereign project folder:

```sh
rm -f mitm-hosts.txt audit.flow
mitmdump --listen-port 8081 --ignore-hosts '.*' -s scripts/log-hosts.py -w audit.flow
```

The addon in `scripts/log-hosts.py` writes each observed CONNECT/request host to `mitm-hosts.txt`, one hostname per line. `audit.flow` is also written for mitmproxy inspection if needed.

Notes:

- `--ignore-hosts '.*'` keeps TLS in passthrough mode.
- The hostname log intentionally does not capture request bodies, cookies, prompts, page text, model output, or downloaded file contents.
- Leave this terminal running while you test Sovereign.

## 3. Launch Sovereign With a Fresh Profile and Proxy

Open a second terminal in the Sovereign project folder:

```sh
SOVEREIGN_AUDIT_PROXY=http://127.0.0.1:8081 SOVEREIGN_USER_DATA_DIR=/tmp/sovereign-audit npm start
```

When audit mode is active, Sovereign shows an **Audit mode** label in the browser chrome.

Sovereign configures Electron sessions with `session.setProxy`. It keeps normal TLS validation enabled and bypasses local loopback hosts such as `127.0.0.1` and `localhost`.

## 4. Run a Small Test Script Manually

Do not browse normal website tabs during this audit. Normal browsing tabs are intentionally excluded from the receipt, so extra browsing will create network-capture hosts that are not expected in the receipt.

Run these actions:

1. Run one normal Search.
2. Run one Ask AI question with **Search the web** enabled.
3. Use **Read sources for a fuller answer**.
4. Ask for one image, then click **Search web for images**.

If local model setup starts during the test, its model/runtime requests should appear in the receipt history under **Background**.

## 5. Export the Receipt JSON

In Sovereign:

1. Open the shield receipt panel in Search or Ask AI.
2. Use the receipt dropdown to inspect the latest Search, Ask AI, and Background receipts.
3. Click **Export JSON**.
4. Save the file, for example as `/tmp/sovereign-receipts.json`.

## 6. Compare Capture vs Receipt

After stopping mitmproxy, run:

```sh
node scripts/audit-compare.js mitm-hosts.txt /tmp/sovereign-receipts.json
```

The script prints:

1. **MATCHED**: hosts found in both mitmproxy's hostname log and Sovereign's receipt export.
2. **IN NETWORK CAPTURE BUT NOT IN RECEIPT**: potential receipt gaps. This is the most important section to review.
3. **IN RECEIPT BUT NOT IN CAPTURE**: expected for some local or bypassed traffic.

It also flags known cloud-AI API hosts using the list in `src/privacy-receipt.js`.

Final verdicts:

- `PASS: no uncaptured hosts and no cloud-AI hosts` means every captured host appeared in the receipt and no known cloud-AI host appeared.
- `REVIEW: ...` means at least one captured host was missing from the receipt or a known cloud-AI host appeared.

## 7. Interpreting Expected Differences

- `127.0.0.1` and `localhost` traffic, including local SearXNG at `http://127.0.0.1:8080/search`, bypasses the proxy by design. It can appear in Sovereign's receipt but not in `mitm-hosts.txt`.
- SearXNG's own upstream search-provider requests come from the Docker container, not from the Electron app. Those upstream hosts may not appear in Sovereign's app-session receipt or in the app proxy capture.
- Model-download hosts may appear in a **Background** receipt if setup happens at startup or outside a user query.
- Unknown app/AI hosts should appear in the receipt as category `other`.
- Requests whose app/AI origin cannot be attributed should appear in the **Background** receipt with `other (unattributed)` in the "what was sent" summary.

## Limitations

- This audit is hostname-level only. It does not inspect encrypted content.
- TLS passthrough records hosts, not full request paths or response bodies.
- Docker-originated SearXNG upstream traffic is outside the Electron app session.
- DNS, cache behavior, connection reuse, and proxy bypass rules can cause expected differences.
- The receipt intentionally excludes normal browsing tabs, cookies, auth headers, request bodies, prompts, page text, model output, and downloaded file contents.
