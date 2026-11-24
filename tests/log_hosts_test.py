"""Unit tests for scripts/log-hosts.py. Run by tests/log-hosts.test.js (python3 -I)."""

import importlib.util
import os
import pathlib
import sys
import tempfile
from types import SimpleNamespace

sys.dont_write_bytecode = True  # keep scripts/ free of __pycache__
ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("log_hosts", ROOT / "scripts" / "log-hosts.py")
lh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lh)


def client_hello(sni=None, extra_first=True):
    """Build a minimal TLS 1.2-style ClientHello handshake message."""
    exts = b""
    if extra_first:  # an unrelated extension before server_name
        exts += (0x000b).to_bytes(2, "big") + (2).to_bytes(2, "big") + b"\x01\x00"
    if sni is not None:
        name = sni.encode("ascii")
        entry = b"\x00" + len(name).to_bytes(2, "big") + name
        sn = len(entry).to_bytes(2, "big") + entry
        exts += (0).to_bytes(2, "big") + len(sn).to_bytes(2, "big") + sn
    body = b"\x03\x03" + b"\x11" * 32 + b"\x00" + b"\x00\x02\x13\x01" + b"\x01\x00"
    body += len(exts).to_bytes(2, "big") + exts
    return b"\x01" + len(body).to_bytes(3, "big") + body


def records(handshake, split=None):
    parts = [handshake] if split is None else [handshake[:split], handshake[split:]]
    return b"".join(b"\x16\x03\x01" + len(p).to_bytes(2, "big") + p for p in parts)


# --- SNI parsing ---
assert lh.parse_tls_sni(records(client_hello("SpacePlace.NASA.gov"))) == "spaceplace.nasa.gov"
assert lh.parse_tls_sni(records(client_hello("weather.gov."), split=20)) == "weather.gov", "fragmented across records"
assert lh.parse_tls_sni(records(client_hello(None))) is None, "no SNI"
assert lh.parse_tls_sni(records(client_hello("example.com"))[:30]) is None, "truncated"
assert lh.parse_tls_sni(b"") is None
assert lh.parse_tls_sni(b"GET / HTTP/1.1\r\n") is None

# --- HTTP Host parsing (hostname only, no path) ---
assert lh.parse_http_host(b"GET /secret?q=fever HTTP/1.1\r\nHost: Example.com:8080\r\n\r\n") == "example.com"
assert lh.parse_http_host(b"GET / HTTP/1.1\r\nhost: [2001:db8::1]:80\r\n\r\n") == "2001:db8::1"
assert lh.parse_http_host(b"\x16\x03\x01junk") is None
assert lh.parse_http_host(b"CONNECT a.example:443 HTTP/1.1\r\nHost: a.example:443\r\n\r\n") is None, "CONNECT is logged by http_connect"
assert lh.name_from_client_data(records(client_hello("a.example"))) == "a.example"

# --- loopback and IP detection ---
for host in ["127.0.0.1", "127.9.9.9", "::1", "[::1]", "::ffff:127.0.0.1", "localhost", "kiwix.localhost"]:
    assert lh.is_loopback(host), host
for host in ["93.184.215.14", "2606:4700::1", "example.com", "10.0.0.1"]:
    assert not lh.is_loopback(host), host
assert lh.is_ip("93.184.215.14") and lh.is_ip("[2606:4700::1]") and not lh.is_ip("example.com")

# --- what gets logged per connection ---
assert lh.destination_label("93.184.215.14", "example.com") == "example.com", "SNI preferred over IP"
assert lh.destination_label("93.184.215.14", None) == "93.184.215.14", "IP fallback"
assert lh.destination_label("127.0.0.1", "example.com") is None, "loopback destination never logged"
assert lh.destination_label("::1", None) is None
assert lh.destination_label("search.example", None) == "search.example", "regular mode hostname"
assert lh.destination_label("93.184.215.14", "localhost") == "93.184.215.14"

# --- ports and DNS (PLAN §12): nameless flows keep their port; port 53 is dns:<server> ---
assert lh.destination_label("93.184.215.14", None, 80) == "93.184.215.14:80"
assert lh.destination_label("2606:4700:10::6814:179a", None, 443) == "[2606:4700:10::6814:179a]:443", "IPv6 bracketed"
assert lh.destination_label("[2600:1f13::1]", None, 80) == "[2600:1f13::1]:80"
assert lh.destination_label("2001:558:feed::1", None, 53) == "dns:2001:558:feed::1", "DNS server only"
assert lh.destination_label("75.75.75.75", None, 53) == "dns:75.75.75.75"
assert lh.destination_label("127.0.0.1", None, 53) is None, "loopback DNS never logged"
assert lh.destination_label("::1", None, 53) is None
assert lh.destination_label("93.184.215.14", "example.com", 443) == "example.com", "a name still wins over IP:port"
assert lh.destination_label("search.example", None, 443) == "search.example", "regular mode: hostname, no port"
for bad in [None, 0, 70000, "80", True]:
    assert lh.destination_label("93.184.215.14", None, bad) == "93.184.215.14", bad

# --- hooks end to end with fake mitmproxy objects ---
with tempfile.TemporaryDirectory() as tmp:
    lh.HOSTS_FILE = os.path.join(tmp, "hosts.txt")
    lh.seen_hosts.clear()
    lh._client_names.clear()

    def layer(client, data, ip, port):
        ctx = SimpleNamespace(client=client, server=SimpleNamespace(address=(ip, port)))
        lh.next_layer(SimpleNamespace(context=ctx, data_client=lambda: data))

    def connect(cid, data, ip, port=443, udp=False, close=True):
        client = SimpleNamespace(id=cid, transport_protocol="udp" if udp else "tcp")
        # eager strategy: server_connect first, then the client bytes arrive in pieces
        lh.server_connect(SimpleNamespace(client=client, server=SimpleNamespace(address=(ip, port))))
        layer(client, b"", ip, port)
        layer(client, data[:10], ip, port)
        layer(client, data, ip, port)
        if close:
            lh.client_disconnected(client)

    connect("c1", records(client_hello("spaceplace.nasa.gov")), "52.1.2.3")
    connect("c2", records(client_hello(None)), "203.0.113.7")
    connect("c3", b"GET /x HTTP/1.1\r\nHost: 127.0.0.1:8090\r\n\r\n", "127.0.0.1", 8090)
    connect("c4", records(client_hello("spaceplace.nasa.gov")), "52.1.2.4")  # duplicate host
    connect("c5", b"", "::1", 9)
    connect("c6", records(client_hello("kiwix.example")), "127.0.0.1", 8090)  # loopback, even with an SNI
    connect("c7", b"\x00\x01", "198.51.100.9", 53, udp=True, close=False)  # still open at shutdown
    # a DNS query to an IPv6 nameserver: logged as the server only, never the name asked for
    dns_query = b"\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x05fever\x07example\x00\x00\x01\x00\x01"
    connect("c9", dns_query, "2001:558:feed::1", 53, udp=True)
    connect("c10", dns_query, "2001:558:feed::1", 53, udp=True)  # same server again: one line
    connect("c11", b"", "2600:1f13:37c:1400::5", 80)  # plain-HTTP preconnect that sent nothing
    connect("c12", b"", "2600:1f13:37c:1400::5", 443)  # same IP, other port: its own line
    # regular proxy mode: CONNECT bytes first (no destination yet), then the ClientHello
    proxied = SimpleNamespace(id="c8", transport_protocol="tcp")
    lh.next_layer(SimpleNamespace(context=SimpleNamespace(client=proxied, server=SimpleNamespace(address=None)),
                                  data_client=lambda: b"CONNECT 52.9.9.9:443 HTTP/1.1\r\nHost: 52.9.9.9:443\r\n\r\n"))
    layer(proxied, records(client_hello("source.example")), "52.9.9.9", 443)
    lh.client_disconnected(proxied)
    lh.http_connect(SimpleNamespace(request=SimpleNamespace(host="huggingface.co")))
    lh.request(SimpleNamespace(request=SimpleNamespace(host="localhost")))
    lh.done()

    lines = pathlib.Path(lh.HOSTS_FILE).read_text().splitlines()
    assert lines == [
        "spaceplace.nasa.gov",
        "203.0.113.7:443",
        "dns:2001:558:feed::1",
        "[2600:1f13:37c:1400::5]:80",
        "[2600:1f13:37c:1400::5]:443",
        "source.example",
        "huggingface.co",
        "dns:198.51.100.9",
    ], lines
    assert not any("fever" in line for line in lines), "DNS query names are never logged"
    assert lh._client_names == {}, "per-connection state cleaned up"

print("log-hosts tests passed")
