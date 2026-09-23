from mitmproxy import http


HOSTS_FILE = "mitm-hosts.txt"
seen_hosts = set()


def _record(host: str) -> None:
    clean = (host or "").strip().lower()
    if not clean or clean in seen_hosts:
        return
    seen_hosts.add(clean)
    with open(HOSTS_FILE, "a", encoding="utf-8") as handle:
        handle.write(f"{clean}\n")


def http_connect(flow: http.HTTPFlow) -> None:
    _record(flow.request.host)


def request(flow: http.HTTPFlow) -> None:
    _record(flow.request.host)
