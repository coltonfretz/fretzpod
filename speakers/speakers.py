"""fretzpod-speakers: lets Fretzpod play on Sonos speakers (optional; only
the Jellyfin accounts in ALLOWED_USERS).

See DESIGN.md, "Speakers". In short:

- The phone (through nginx at /speakers/api/) asks this service to play
  songs on a speaker. This service tells Home Assistant, which already
  controls the Sonos speakers, to queue them up.
- A Sonos downloads each song itself, from PUBLIC_BASE + /speakers/audio/,
  which lands here. Where I run it the speakers sit on a separate network
  that must never reach into the server's, so PUBLIC_BASE is Fretzpod's
  public https address and the songs come in from outside like any visitor.
- The addresses handed to the speakers carry no Jellyfin key, only a signed,
  12-hour link to one song. HA's history stores every address a speaker
  played, and anything on the speakers' network can read a Sonos queue, so a key
  in there would be a key handed out. This service holds the real key and
  fetches the song from Jellyfin itself.

Standard library only, so the pod runs the stock python image with this file
mounted from a ConfigMap (no image to build). Logs nothing about requests or
songs (privacy: gather nothing that isn't needed).
"""
import base64
import hashlib
import hmac
import json
import os
import re
import signal
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HA_URL = os.environ["HA_URL"].rstrip("/")
HA_TOKEN = os.environ["HA_TOKEN"].strip()   # the token file ends in a newline
JF_URL = os.environ["JF_URL"].rstrip("/")
JF_KEY = os.environ["JF_KEY"].strip()
SIGN_KEY = os.environ["SIGN_KEY"].encode()
ALLOWED_USERS = set(os.environ["ALLOWED_USERS"].split(","))
# entity_id=LAN address, e.g. media_player.kitchen=192.168.1.20
SPEAKER_HOSTS = dict(x.strip().split("=", 1) for x in os.environ["SPEAKERS"].split(",") if x.strip())
SPEAKERS = list(SPEAKER_HOSTS)
# Where the speakers fetch songs: an address of Fretzpod they can reach.
PUBLIC_BASE = os.environ["PUBLIC_BASE"].rstrip("/")

LINK_TTL = 12 * 3600      # a queued song stays playable this long
AUTH_TTL = 600            # how long a checked phone sign-in is trusted
MAX_ITEMS = 60            # per request; the app tops the queue up as it goes

JF_AUTH = f'MediaBrowser Client="Fretzpod speakers", Device="k8s", DeviceId="fretzpod-speakers", Version="1", Token="{JF_KEY}"'
ID_RE = re.compile(r"^[0-9a-f]{32}$")


def log(msg):
    # Only service-level events (start, upstream failures); never songs or callers.
    print(time.strftime("%H:%M:%S"), msg, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Upstreams
# ---------------------------------------------------------------------------

def call(url, method="GET", body=None, headers=None, timeout=15):
    data = json.dumps(body).encode() if body is not None else None
    h = dict(headers or {})
    if data is not None:
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


def ha(path, body=None, method=None):
    return call(f"{HA_URL}/api/{path}", method or ("POST" if body is not None else "GET"), body,
                {"Authorization": f"Bearer {HA_TOKEN}"}, timeout=30)


def ha_service(domain, service, **data):
    return ha(f"services/{domain}/{service}", data)


def jf(path):
    return call(f"{JF_URL}{path}", headers={"Authorization": JF_AUTH})


# ---------------------------------------------------------------------------
# Signed song links
# ---------------------------------------------------------------------------
#
# <id>.<mode>.<expiry>.<sig>.<ext>   mode o = the original file, t = converted
# to 320k MP3. The extension is for the speaker's benefit; the signature covers
# id, mode and expiry, so a link can't be bent into a different song, a longer
# life or a different conversion.

def _sig(payload):
    mac = hmac.new(SIGN_KEY, payload.encode(), hashlib.sha256).digest()[:18]
    return base64.urlsafe_b64encode(mac).decode().rstrip("=")


# Sonos (S2) plays these as they are; FLAC only up to 48 kHz.
SONOS_OK = {"mp3": "mp3", "flac": "flac", "m4a": "m4a", "aac": "m4a"}


def song_links(ids):
    """Signed links for the given song ids, in order. One Jellyfin call finds
    each file's format, so the speaker gets the original whenever it can."""
    found = jf("/Items?" + urllib.parse.urlencode({
        "Ids": ",".join(ids), "Fields": "MediaSources", "EnableImages": "false"}))["Items"]
    info = {}
    for it in found:
        src = (it.get("MediaSources") or [{}])[0]
        audio = next((s for s in src.get("MediaStreams", []) if s.get("Type") == "Audio"), {})
        ext = SONOS_OK.get((src.get("Container") or "").lower())
        rate = audio.get("SampleRate") or 0
        if ext and not (ext == "flac" and rate > 48000):
            info[it["Id"]] = ("o", ext)
        else:
            info[it["Id"]] = ("t", "mp3")
    exp = int(time.time()) + LINK_TTL
    links = []
    for i in ids:
        mode, ext = info.get(i, ("t", "mp3"))
        payload = f"{i}.{mode}.{exp}"
        links.append(f"{PUBLIC_BASE}/speakers/audio/{payload}.{_sig(payload)}.{ext}")
    return links


def check_link(name):
    parts = name.split(".")
    if len(parts) != 5:
        return None
    sid, mode, exp, sig, _ext = parts
    if not ID_RE.match(sid) or mode not in ("o", "t") or not exp.isdigit():
        return None
    if not hmac.compare_digest(sig, _sig(f"{sid}.{mode}.{exp}")):
        return None
    if int(exp) < time.time():
        return None
    return sid, mode


# ---------------------------------------------------------------------------
# Who may use the control API
# ---------------------------------------------------------------------------

_auth_cache = {}   # sha256(header) -> expiry; only allowed users get cached
_auth_lock = threading.Lock()


def allowed(auth_header):
    """The phone sends its own Jellyfin sign-in. Jellyfin says whose it is;
    only the users in ALLOWED_USERS get through."""
    if not auth_header or 'Token="' not in auth_header:
        return False
    key = hashlib.sha256(auth_header.encode()).hexdigest()
    now = time.time()
    with _auth_lock:
        if _auth_cache.get(key, 0) > now:
            return True
    try:
        me = call(f"{JF_URL}/Users/Me", headers={"Authorization": auth_header}, timeout=8)
    except Exception:
        return False
    if me.get("Id") not in ALLOWED_USERS:
        return False
    with _auth_lock:
        _auth_cache[key] = now + AUTH_TTL
    return True


# ---------------------------------------------------------------------------
# Speaker control (through Home Assistant)
# ---------------------------------------------------------------------------

# Bumped by every play request per speaker, so a slow background top-up from
# an earlier play stops instead of mixing old songs into the new queue.
_gen = {}
_gen_lock = threading.Lock()


def _bump(speaker):
    with _gen_lock:
        _gen[speaker] = _gen.get(speaker, 0) + 1
        return _gen[speaker]


def _current(speaker, gen):
    with _gen_lock:
        return _gen.get(speaker) == gen


def _add(speaker, link):
    ha_service("media_player", "play_media", entity_id=speaker, media_content_id=link,
               media_content_type="music", enqueue="add")


def _add_rest(speaker, links, gen):
    for link in links:
        if not _current(speaker, gen):
            return
        try:
            _add(speaker, link)
        except Exception as e:
            log(f"adding to queue failed: {e}")
            return


def play(speaker, ids, start, offset, alone=False):
    """Replace the speaker's queue with ids and start at ids[start], offset
    seconds in. Songs up to the start one go in first (so Previous works),
    the rest are added in the background so the music starts right away.
    alone: take the speaker out of any group first (music just moved to this
    one speaker; a group lead would otherwise drag its followers along, and a
    follower would hand the songs to its lead)."""
    gen = _bump(speaker)
    links = song_links(ids)
    if alone:
        ha_service("media_player", "unjoin", entity_id=speaker)
    ha_service("media_player", "clear_playlist", entity_id=speaker)
    for link in links[:start + 1]:
        _add(speaker, link)
    # play_queue counts from 0 (it's SoCo's play_from_queue underneath).
    ha_service("sonos", "play_queue", entity_id=speaker, queue_position=start)
    if offset > 2:
        # The speaker has to be playing the song before it can seek in it.
        time.sleep(1.5)
        try:
            ha_service("media_player", "media_seek", entity_id=speaker, seek_position=offset)
        except Exception as e:
            log(f"seek after start failed: {e}")
    threading.Thread(target=_add_rest, args=(speaker, links[start + 1:], gen), daemon=True).start()


def add(speaker, ids):
    gen = _gen.get(speaker, 0)
    threading.Thread(target=_add_rest, args=(speaker, song_links(ids), gen), daemon=True).start()


# Reading state goes to the speaker itself, not HA. HA's copy of a Sonos runs
# ~30 s stale when the speakers sit on another network and can't push their
# change events back to HA (they can't on my setup, on purpose), and HA's
# "refresh now" doesn't help since it believes its subscription is live.
# Asking the speaker (UPnP on :1400, the same calls HA makes, server ->
# speaker) takes ~0.1 s.

def _soap(host, service, action, args=""):
    body = ('<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
            's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>'
            f'<u:{action} xmlns:u="urn:schemas-upnp-org:service:{service}:1"><InstanceID>0</InstanceID>{args}'
            f'</u:{action}></s:Body></s:Envelope>').encode()
    req = urllib.request.Request(
        f"http://{host}:1400/MediaRenderer/{service}/Control", data=body, method="POST",
        headers={"Content-Type": 'text/xml; charset="utf-8"',
                 "SOAPACTION": f'"urn:schemas-upnp-org:service:{service}:1#{action}"'})
    with urllib.request.urlopen(req, timeout=4) as r:
        return r.read().decode()


def _tag(xml, tag):
    m = re.search(f"<{tag}>(.*?)</{tag}>", xml)
    return m.group(1) if m else None


def _secs(hms):
    try:
        h, m, sec = (int(x) for x in (hms or "").split(":"))
        return h * 3600 + m * 60 + sec
    except ValueError:
        return 0


def state(speaker):
    host = SPEAKER_HOSTS[speaker]
    pos = _soap(host, "AVTransport", "GetPositionInfo")
    transport = _tag(_soap(host, "AVTransport", "GetTransportInfo"), "CurrentTransportState")
    # Group volume: for one speaker it's just its volume; for a group it's the
    # Sonos app's group slider (members keep their balance).
    volume = _tag(_soap(host, "GroupRenderingControl", "GetGroupVolume"), "CurrentVolume")
    track = _tag(pos, "Track")
    # Which song, if it's one of ours: our links carry the song id. Anything
    # else (the PC stream, the Sonos app, nothing) gives None, which tells a
    # reopened Fretzpod the speaker has moved on.
    ours = re.search(r"/speakers/audio/([0-9a-f]{32})\.", _tag(pos, "TrackURI") or "")
    return {
        "songId": ours.group(1) if ours else None,
        # TRANSITIONING is the moment between songs; count it as playing.
        "state": "playing" if transport in ("PLAYING", "TRANSITIONING") else "paused",
        "volume": int(volume) / 100 if volume and volume.isdigit() else None,
        "queuePosition": int(track) if track and track.isdigit() else None,   # counts from 1
        "position": _secs(_tag(pos, "RelTime")),
        "positionAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


COMMANDS = {
    "play": ("media_player", "media_play", None),
    "pause": ("media_player", "media_pause", None),
    "next": ("media_player", "media_next_track", None),
    "prev": ("media_player", "media_previous_track", None),
    "seek": ("media_player", "media_seek", "seek_position"),
    "volume": None,   # straight to the speaker, below
}


def command(speaker, cmd, value):
    if cmd == "volume":
        # HA only sets one speaker's own volume; the group volume lives on the
        # group's lead speaker. 0..1 from the app, 0..100 on the speaker.
        v = max(0, min(100, round(float(value) * 100)))
        _soap(SPEAKER_HOSTS[speaker], "GroupRenderingControl", "SetGroupVolume", f"<DesiredVolume>{v}</DesiredVolume>")
        return
    domain, service, field = COMMANDS[cmd]
    data = {"entity_id": speaker}
    if field:
        data[field] = float(value)
    ha_service(domain, service, **data)


def speakers():
    out = []
    for sp in SPEAKERS:
        try:
            s = ha(f"states/{sp}")
            out.append({"id": sp, "name": s["attributes"].get("friendly_name", sp), "state": s["state"]})
        except Exception:
            out.append({"id": sp, "name": sp, "state": "unavailable"})
    return out


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

PASS_HEADERS = ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "fretzpod-speakers"
    sys_version = ""

    def log_message(self, *args):
        pass   # no request log, on purpose (see top of file)

    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def deny(self, code=404):
        self.send_json(code, {"error": "not found" if code == 404 else "not allowed"})

    # ---- song links (fetched by the speakers from PUBLIC_BASE) ----

    def audio(self, head):
        link = check_link(self.path.rsplit("/", 1)[-1].split("?")[0])
        if not link:
            return self.deny()
        sid, mode = link
        if mode == "o":
            url = f"{JF_URL}/Audio/{sid}/stream?static=true"
        else:
            url = f"{JF_URL}/Audio/{sid}/stream.mp3?" + urllib.parse.urlencode(
                {"static": "false", "AudioCodec": "mp3", "AudioBitRate": "320000"})
        headers = {"Authorization": JF_AUTH}
        # Byte ranges only make sense on the original file; a conversion is
        # made on the fly and has no fixed bytes to point into.
        if mode == "o" and self.headers.get("Range"):
            headers["Range"] = self.headers["Range"]
        req = urllib.request.Request(url, method="HEAD" if head else "GET", headers=headers)
        try:
            up = urllib.request.urlopen(req, timeout=30)
        except urllib.error.HTTPError as e:
            if e.code == 416:
                up = e
            else:
                log(f"song fetch failed: {e.code}")
                return self.deny(502)
        except Exception as e:
            log(f"song fetch failed: {e}")
            return self.deny(502)
        with up:
            self.send_response(up.status)
            for h in PASS_HEADERS:
                if up.headers.get(h):
                    self.send_header(h, up.headers[h])
            length = up.headers.get("Content-Length")
            if not length:
                self.send_header("Connection", "close")
                self.close_connection = True
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if head:
                return
            try:
                while chunk := up.read(64 * 1024):
                    self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass   # the speaker skipped or seeked; it asks again

    def do_HEAD(self):
        if self.path.startswith("/speakers/audio/"):
            return self.audio(head=True)
        self.deny()

    # ---- control API (both copies; only allowed Jellyfin accounts) ----

    def api_ok(self):
        if not allowed(self.headers.get("Authorization", "")):
            self.deny(403)
            return False
        return True

    def speaker_arg(self, value):
        if value not in SPEAKERS:
            self.deny(404)
            return None
        return value

    def do_GET(self):
        if self.path.startswith("/speakers/audio/"):
            return self.audio(head=False)
        if self.path == "/healthz":
            return self.send_json(200, {"ok": True})
        if not self.path.startswith("/speakers/api/"):
            return self.deny()
        if not self.api_ok():
            return None
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        try:
            if u.path == "/speakers/api/list":
                return self.send_json(200, speakers())
            if u.path == "/speakers/api/state":
                sp = self.speaker_arg((q.get("speaker") or [""])[0])
                return sp and self.send_json(200, state(sp))
        except Exception as e:
            log(f"api failed: {e}")
            return self.send_json(502, {"error": "home assistant didn't answer"})
        self.deny()

    def do_POST(self):
        # Read the body before anything can refuse the request: an unread body
        # stays on the connection and gets parsed as the next request.
        try:
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if 0 < n <= 64 * 1024 else b""
        except Exception:
            n, raw = 0, b""
        if n > 64 * 1024:
            self.close_connection = True
            return self.send_json(413, {"error": "too big"})
        if not self.path.startswith("/speakers/api/"):
            return self.deny()
        if not self.api_ok():
            return None
        try:
            body = json.loads(raw or b"{}")
        except Exception:
            return self.send_json(400, {"error": "bad request"})
        sp = self.speaker_arg(body.get("speaker"))
        if not sp:
            return None
        ids = [i for i in (body.get("ids") or []) if isinstance(i, str) and ID_RE.match(i)][:MAX_ITEMS]
        try:
            if self.path == "/speakers/api/play" and ids:
                start = max(0, min(int(body.get("start") or 0), len(ids) - 1))
                play(sp, ids, start, float(body.get("offset") or 0), bool(body.get("alone")))
                return self.send_json(200, {"ok": True})
            # Both speakers at once: Sonos groups them, the lead's queue plays
            # on both in sync. join: member follows speaker (the lead).
            if self.path == "/speakers/api/join":
                member = body.get("member")
                if member not in SPEAKERS or member == sp:
                    return self.deny()
                ha_service("media_player", "join", entity_id=sp, group_members=[member])
                return self.send_json(200, {"ok": True})
            if self.path == "/speakers/api/unjoin":
                ha_service("media_player", "unjoin", entity_id=sp)
                return self.send_json(200, {"ok": True})
            if self.path == "/speakers/api/add" and ids:
                add(sp, ids)
                return self.send_json(200, {"ok": True})
            if self.path == "/speakers/api/command" and body.get("cmd") in COMMANDS:
                command(sp, body["cmd"], body.get("value") or 0)
                return self.send_json(200, {"ok": True})
        except Exception as e:
            log(f"api failed: {e}")
            return self.send_json(502, {"error": "home assistant didn't answer"})
        self.send_json(400, {"error": "bad request"})


if __name__ == "__main__":
    # As the container's first process, Python ignores SIGTERM unless told
    # otherwise, so every restart would wait out the 30 s grace period.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    log(f"listening on :8080 for {len(SPEAKERS)} speakers")
    ThreadingHTTPServer(("", 8080), Handler).serve_forever()
