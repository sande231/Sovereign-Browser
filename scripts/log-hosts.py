"""Hostname logger for the Sovereign privacy audit (mitmproxy addon).

Writes one destination per line to mitm-hosts.txt: hostnames only, never
paths, headers, bodies or query text. Works in two capture setups:

* regular proxy mode (Electron session proxy): CONNECT and request hosts;
* local capture mode (`--mode local:<path>`) with TLS passthrough
  (`--ignore-hosts '.*'`): there is no CONNECT and, for ignored connections,
  mitmproxy fires no tcp/udp/tls hooks. So the addon reads the TLS SNI (or
  the plain-HTTP Host header, or the QUIC SNI when mitmproxy can parse it)
  from the first client bytes in `next_layer`, and records the connection at
  `server_connect`. A connection with no readable name is logged as its bare
  destination IP and port (`203.0.113.5:80`, `[2001:db8::1]:443`), which
  scripts/audit-compare.js flags for a manual check.

DNS: macOS's resolver (mDNSResponder) sends lookups on Sovereign's behalf, and
macOS attributes those flows to Sovereign, so the redirector captures them. A
nameless flow to port 53 is logged as `dns:<server IP>`: the DNS server only,
never the names looked up (the addon doesn't read DNS payloads).

Loopback destinations (127.0.0.0/8, ::1, localhost) are never logged: they
don't leave the machine (SearXNG, Kiwix, Offline mode's black-hole proxy).
"""

import ipaddress

try:  # Only available inside mitmproxy; the unit tests run without it.
    from mitmproxy.proxy.layers.quic import quic_parse_client_hello_from_datagrams
except Exception:  # pragma: no cover
    quic_parse_client_hello_from_datagrams = None


HOSTS_FILE = "mitm-hosts.txt"
seen_hosts = set()
_client_names = {}


# ---------- pure helpers (unit-tested in tests/log_hosts_test.py) ----------

def clean_host(host):
    value = str(host or "").strip().lower()
    if value.startswith("[") and "]" in value:
        value = value[1:value.index("]")]
    return value.rstrip(".")


def is_ip(host):
    try:
        ipaddress.ip_address(clean_host(host))
        return True
    except ValueError:
        return False


def is_loopback(host):
    value = clean_host(host)
    if value == "localhost" or value.endswith(".localhost"):
        return True
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    mapped = getattr(address, "ipv4_mapped", None)
    return address.is_loopback or bool(mapped and mapped.is_loopback)


def parse_tls_sni(data):
    """Return the SNI host name from a TLS ClientHello, or None.

    Accepts the raw client bytes (one or more TLS records). Returns None for
    anything that is not a complete ClientHello with a host_name entry.
    """
    try:
        data = bytes(data or b"")
        handshake = b""
        offset = 0
        while offset + 5 <= len(data) and data[offset] == 0x16:
            length = int.from_bytes(data[offset + 3:offset + 5], "big")
            handshake += data[offset + 5:offset + 5 + length]
            offset += 5 + length
            if len(handshake) >= 4 and len(handshake) >= 4 + int.from_bytes(handshake[1:4], "big"):
                break
        if len(handshake) < 4 or handshake[0] != 0x01:
            return None
        body_length = int.from_bytes(handshake[1:4], "big")
        body = handshake[4:4 + body_length]
        if len(body) < body_length:
            return None
        pos = 2 + 32  # client version, random
        pos += 1 + body[pos]  # session id
        pos += 2 + int.from_bytes(body[pos:pos + 2], "big")  # cipher suites
        pos += 1 + body[pos]  # compression methods
        if pos + 2 > len(body):
            return None
        end = pos + 2 + int.from_bytes(body[pos:pos + 2], "big")
        pos += 2
        while pos + 4 <= min(end, len(body)):
            ext_type = int.from_bytes(body[pos:pos + 2], "big")
            ext_len = int.from_bytes(body[pos + 2:pos + 4], "big")
            ext = body[pos + 4:pos + 4 + ext_len]
            pos += 4 + ext_len
            if ext_type != 0:
                continue
            i = 2  # server_name_list length
            while i + 3 <= len(ext):
                name_type = ext[i]
                name_len = int.from_bytes(ext[i + 1:i + 3], "big")
                name = ext[i + 3:i + 3 + name_len]
                i += 3 + name_len
                if name_type == 0 and len(name) == name_len and name:
                    return clean_host(name.decode("ascii"))
            return None
        return None
    except (IndexError, UnicodeDecodeError, ValueError):
        return None


_HTTP_METHODS = (b"GET ", b"HEAD ", b"POST ", b"PUT ", b"DELETE ", b"OPTIONS ", b"PATCH ", b"TRACE ")  # CONNECT: logged by http_connect


def parse_http_host(data):
    """Return the Host header (without port) of a plain HTTP request, or None."""
    data = bytes(data or b"")
    if not data.startswith(_HTTP_METHODS):
        return None
    head = data.split(b"\r\n\r\n", 1)[0]
    for line in head.split(b"\r\n")[1:]:
        name, sep, value = line.partition(b":")
        if sep and name.strip().lower() == b"host":
            try:
                host = value.strip().decode("ascii")
            except UnicodeDecodeError:
                return None
            if host.startswith("["):
                return clean_host(host) or None
            return clean_host(host.rsplit(":", 1)[0] if host.count(":") == 1 else host) or None
    return None


def name_from_client_data(data, udp=False):
    if udp:
        if quic_parse_client_hello_from_datagrams is None:
            return None
        try:
            hello = quic_parse_client_hello_from_datagrams([bytes(data)])
            return clean_host(hello.sni) if hello and hello.sni else None
        except Exception:
            return None
    return parse_tls_sni(data) or parse_http_host(data)


DNS_PORT = 53


def _valid_port(port):
    return isinstance(port, int) and not isinstance(port, bool) and 0 < port < 65536


def destination_label(address_host, learned_name, port=None):
    """What to log for a connection, or None to log nothing.

    address_host is the destination from mitmproxy: an IP in local mode, a
    hostname in regular proxy mode. port is the destination port, when known.
    """
    host = clean_host(address_host)
    if not host or is_loopback(host):
        return None
    if not is_ip(host):
        return host
    if learned_name and not is_loopback(learned_name):
        return clean_host(learned_name)
    if not _valid_port(port):
        return host
    if port == DNS_PORT:
        return f"dns:{host}"
    return f"[{host}]:{port}" if ":" in host else f"{host}:{port}"


# ---------- recording ----------

def _record(label):
    """Append one line. label comes from destination_label (already clean,
    loopback already dropped); None means log nothing."""
    if not label or label in seen_hosts:
        return
    seen_hosts.add(label)
    with open(HOSTS_FILE, "a", encoding="utf-8") as handle:
        handle.write(f"{label}\n")


# ---------- mitmproxy hooks ----------
#
# Per client connection we keep the destination and whether a name was found.
# The name is logged as soon as it is parsed. The bare-IP fallback is logged
# only when the connection ends (or when mitmproxy stops), because with the
# default connection_strategy=eager mitmproxy opens the server connection
# before the ClientHello has arrived.

def _state(client):
    return _client_names.setdefault(client.id, {"dest": None, "port": None, "named": False})


def _remember_destination(client, address):
    if address:
        state = _state(client)
        port = address[1] if len(address) > 1 else None
        if state["dest"] != address[0] or state["port"] != port:
            # New destination on the same client connection (e.g. after a
            # CONNECT in regular proxy mode): look for its name again.
            state["dest"] = address[0]
            state["port"] = port
            state["named"] = False


def _flush(client_id):
    state = _client_names.pop(client_id, None)
    if state and not state["named"] and state["dest"]:
        label = destination_label(state["dest"], None, state["port"])
        _record(label)


def http_connect(flow):
    _record(destination_label(flow.request.host, None))


def request(flow):
    _record(destination_label(flow.request.host, None))


def next_layer(nextlayer):
    # Runs before mitmproxy's own NextLayer addon, possibly several times per
    # connection while data arrives. Only reads; never sets nextlayer.layer.
    try:
        context = nextlayer.context
        client = context.client
        _remember_destination(client, context.server.address)
        state = _state(client)
        if state["named"]:
            return
        udp = getattr(client, "transport_protocol", "tcp") == "udp"
        name = name_from_client_data(nextlayer.data_client(), udp=udp)
        if name:
            state["named"] = True
            label = destination_label(state["dest"] or name, name)
            if label:
                _record(label)
    except Exception:
        pass


def server_connect(data):
    try:
        _remember_destination(data.client, data.server.address)
    except Exception:
        pass


def client_disconnected(client):
    _flush(getattr(client, "id", None))


def done():
    for client_id in list(_client_names):
        _flush(client_id)
