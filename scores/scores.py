"""fretzpod-scores: the shared high score boards for Vortex and Space Sheep.

One board per game that everyone on Fretzpod shares.
See DESIGN.md, "High scores".

Kept apart from fretzpod-speakers on purpose: that one holds the Home
Assistant token and only answers allowed accounts, while this answers
everyone signed in. This
service holds no secrets at all. It knows who's asking by passing the phone's
own Jellyfin sign-in to Jellyfin's /Users/Me, the same check the speakers
helper does.

Names on the board are ones people pick themselves: you
show as "Player 3" until you choose one, and Jellyfin names are never
stored or shown. Names are unique, A-Z 0-9 space and dash, up to 10.

What it keeps, and nothing more (gather nothing about friends that isn't
needed): per Jellyfin user id, a number (the "3" in Player 3) and the name
they picked, if any; per game, their best score and the day they set it.
One file, /data/scores.json, on its own small volume. No request log.

  GET  /scores/api/board?game=vortex       the top 10, where you stand, your name
  POST /scores/api/submit {game, score}    keeps it if it beats your best
  POST /scores/api/name {name}             sets your name ("" goes back to Player N)

Anyone signed in can send any number, so a friend who knows curl can post a
fake score. It's a board among friends; if one shows up, remove it from the
file (DESIGN.md, "High scores").
"""
import hashlib
import json
import os
import re
import signal
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

JF_URL = os.environ["JF_URL"].rstrip("/")
DATA = os.environ.get("DATA", "/data/scores.json")
# The games with boards, and the highest score each could plausibly reach
# (a typo guard, not cheat protection).
GAMES = {"vortex": 10_000_000, "sheep": 10_000_000}
TOP = 10
AUTH_TTL = 600          # seconds a phone's sign-in stays trusted before asking Jellyfin again
SUBMIT_GAP = 1.0        # seconds between submits (or renames) from one person
NAME_RE = re.compile(r"^[A-Z0-9][A-Z0-9 -]{0,9}$")
# "Player 7" is what people without a name are called; nobody gets to pick it.
DEFAULT_RE = re.compile(r"^PLAYER *[0-9]+$")


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


# ---------------------------------------------------------------------------
# Who's asking
# ---------------------------------------------------------------------------

_auth_cache = {}        # sha256(header) -> (expires, user id)
_auth_lock = threading.Lock()


def who(auth_header):
    """The Jellyfin user id behind the phone's sign-in, or None. Only the id:
    the name Jellyfin returns too is left alone."""
    if not auth_header or 'Token="' not in auth_header:
        return None
    key = hashlib.sha256(auth_header.encode()).hexdigest()
    now = time.time()
    with _auth_lock:
        hit = _auth_cache.get(key)
        if hit and hit[0] > now:
            return hit[1]
    req = urllib.request.Request(f"{JF_URL}/Users/Me", headers={"Authorization": auth_header})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            me = json.load(r)
    except Exception:
        return None
    uid = me.get("Id")
    if not uid:
        return None
    with _auth_lock:
        # Forget expired sign-ins so the cache can't grow without end.
        for k in [k for k, v in _auth_cache.items() if v[0] <= now]:
            del _auth_cache[k]
        _auth_cache[key] = (now + AUTH_TTL, uid)
    return uid


# ---------------------------------------------------------------------------
# The boards
# ---------------------------------------------------------------------------

_lock = threading.Lock()   # around every read-change-write of the file
_last = {}                # (user id, game or "name") -> time of their last change


def load():
    # Read fresh on every request rather than kept in memory: the file is a
    # few KB, and removing a fake score by hand then works without a restart.
    try:
        with open(DATA) as f:
            d = json.load(f)
    except FileNotFoundError:
        d = {}
    d.setdefault("users", {})
    for g in GAMES:
        d.setdefault(g, {})
    return d


def save(d):
    # Write a new file and swap it in, so a crash mid-write can't leave half
    # a file behind.
    tmp = DATA + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f, indent=1, sort_keys=True)
    os.replace(tmp, DATA)


def record(d, uid):
    """This person's record, numbered in the order people first showed up."""
    users = d["users"]
    if uid not in users:
        users[uid] = {"n": max((u["n"] for u in users.values()), default=0) + 1, "nick": None}
    return users[uid]


def shown(d, uid):
    u = d["users"].get(uid)
    if not u:
        return None
    return u["nick"] or f"Player {u['n']}"


def too_soon(uid, what):
    """One change a second per person and thing. Call holding _lock."""
    now = time.time()
    if now - _last.get((uid, what), 0) < SUBMIT_GAP:
        return True
    _last[(uid, what)] = now
    return False


def ranked(entries):
    # Highest first; on a tie, whoever got there first.
    return sorted(entries.items(), key=lambda kv: (-kv[1]["score"], kv[1]["date"]))


def board(d, game, uid):
    order = ranked(d[game])
    top = [{"name": shown(d, k), "score": e["score"], "date": e["date"], "you": k == uid}
           for k, e in order[:TOP]]
    you = None
    for i, (k, e) in enumerate(order):
        if k == uid:
            you = {"rank": i + 1, "score": e["score"]}
            break
    u = d["users"].get(uid)
    me = {"name": shown(d, uid), "named": bool(u and u["nick"])}
    return {"game": game, "top": top, "you": you, "players": len(order), "me": me}


def clean_name(raw):
    """The name as it'll be stored, or None if it isn't allowed. Upper case,
    single spaces, no spaces at the ends."""
    if not isinstance(raw, str):
        return None
    name = re.sub(r" +", " ", raw.upper()).strip()
    if name and (not NAME_RE.match(name) or DEFAULT_RE.match(name)):
        return None
    return name


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "fretzpod-scores"
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

    def caller(self):
        """The asker's Jellyfin user id; answers 403 and returns None if
        their sign-in doesn't check out."""
        uid = who(self.headers.get("Authorization"))
        if not uid:
            self.deny(403)
        return uid

    def do_GET(self):
        if self.path == "/healthz":
            return self.send_json(200, {"ok": True})
        u = urllib.parse.urlsplit(self.path)
        if u.path != "/scores/api/board":
            return self.deny()
        game = urllib.parse.parse_qs(u.query).get("game", [""])[0]
        if game not in GAMES:
            return self.deny()
        uid = self.caller()
        if not uid:
            return None
        with _lock:
            return self.send_json(200, board(load(), game, uid))

    def do_POST(self):
        # Read the body before anything can refuse the request: an unread body
        # stays on the connection and gets parsed as the next request.
        try:
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if 0 < n <= 4096 else b""
        except Exception:
            n, raw = 0, b""
        if n > 4096:
            self.close_connection = True
            return self.send_json(413, {"error": "too big"})
        if self.path == "/scores/api/name":
            return self.set_name(raw)
        if self.path != "/scores/api/submit":
            return self.deny()
        try:
            body = json.loads(raw or b"{}")
            game, score = body.get("game"), body.get("score")
        except Exception:
            return self.send_json(400, {"error": "bad request"})
        # (bool is an int in Python, so true would pass as 1 without the check.)
        if game not in GAMES or not isinstance(score, int) or isinstance(score, bool) or not 0 < score <= GAMES[game]:
            return self.send_json(400, {"error": "bad request"})
        uid = self.caller()
        if not uid:
            return None
        with _lock:
            if too_soon(uid, game):
                return self.send_json(429, {"error": "slow down"})
            d = load()
            mine = d[game].get(uid)
            best = not mine or score > mine["score"]
            if best:
                record(d, uid)
                d[game][uid] = {"score": score, "date": time.strftime("%Y-%m-%d")}
                save(d)
            out = board(d, game, uid)
        out["newBest"] = best
        return self.send_json(200, out)

    def set_name(self, raw):
        try:
            name = clean_name(json.loads(raw or b"{}").get("name"))
        except Exception:
            name = None
        if name is None:
            return self.send_json(400, {"error": "bad name"})
        uid = self.caller()
        if not uid:
            return None
        with _lock:
            if too_soon(uid, "name"):
                return self.send_json(429, {"error": "slow down"})
            d = load()
            if name and any(u["nick"] == name for k, u in d["users"].items() if k != uid):
                return self.send_json(409, {"error": "taken"})
            record(d, uid)["nick"] = name or None
            save(d)
            return self.send_json(200, {"me": {"name": shown(d, uid), "named": bool(name)}})


if __name__ == "__main__":
    # As the container's first process, Python ignores SIGTERM unless told
    # otherwise, so every restart would wait out the 30 s grace period.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    with _lock:
        save(load())          # fails loudly at start if /data isn't writable
    log(f"listening on :8080, boards for {', '.join(GAMES)}")
    ThreadingHTTPServer(("", 8080), Handler).serve_forever()
