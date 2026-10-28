#!/usr/bin/env python3
"""Builds Fretzpod for one site: python3 build.py [site_dir] [out_dir]

Reads site_dir/site.json (default: site/) and writes out_dir (default: build/):
  html/          the app, ready to serve (from app/, minus vendor/)
  vendor/        hls.js, served at /vendor/ (TV only)
  default.conf   the nginx config

WHY a build step at all, when the app is plain JavaScript: a few things
differ per site or per deploy, and filling them in here keeps the repo files
generic and nobody hand-editing them:
- app/config.js is replaced with the site's settings (server name, which
  Jellyfin each address of the app talks to).
- sw.js gets __BUILD__ = version + a fingerprint of the app files, so any
  change makes phones install a fresh copy (no hand-bumped cache name), and
  __SHELL__ = every app file, so the offline copy never misses a new one.
- nginx/default.conf gets the same Jellyfin table (for its Content Security
  Policy), the TV servers from app/tv-hosts.json, and the optional helpers
  (Speakers, High Scores): their sections become a plain 404 when the site
  doesn't run them, which is also how the app knows to hide Speakers.

site.json (see examples/site.json):
  serverName   "Sign in to <serverName>"
  purpleName   Settings > Body name for the purple body (default "Purple")
  jellyfin     {"default": URL, "byHost": {"host[:port]": URL}}
  helpers      optional {"resolver": DNS IP, "speakers": URL, "scores": URL}
  namespace    Kubernetes only, used by deploy.sh
"""
import hashlib
import json
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SITE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "site")
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "build")
APP = os.path.join(ROOT, "app")


def fail(msg):
    sys.exit(f"build.py: {msg}")


try:
    with open(os.path.join(SITE, "site.json")) as f:
        site = json.load(f)
except FileNotFoundError:
    fail(f"no {SITE}/site.json. Copy examples/site.json there and fill it in (README, Install).")

jf = site.get("jellyfin") or {}
default_jf = (jf.get("default") or "").rstrip("/")
by_host = {h: u.rstrip("/") for h, u in (jf.get("byHost") or {}).items()}
if not default_jf:
    fail('site.json needs jellyfin.default, the Jellyfin address the app uses (e.g. "https://jellyfin.example.com")')
for url in [default_jf, *by_host.values()]:
    if not re.fullmatch(r"https?://[^\s/\"';]+", url):
        fail(f"not a plain http(s)://host[:port] address: {url!r}")
for host in by_host:
    if not re.fullmatch(r"[A-Za-z0-9.-]+(:\d+)?", host):
        fail(f"byHost keys are the app's host[:port] as typed in the browser, got {host!r}")

shutil.rmtree(OUT, ignore_errors=True)
html = os.path.join(OUT, "html")
os.makedirs(html)

# ---- app ----
for name in sorted(os.listdir(APP)):
    src = os.path.join(APP, name)
    if os.path.isfile(src):
        shutil.copy(src, html)
shutil.copytree(os.path.join(APP, "vendor"), os.path.join(OUT, "vendor"))

config = {
    "serverName": site.get("serverName") or "Jellyfin",
    "purpleName": site.get("purpleName") or "Purple",
    "jellyfin": {"default": default_jf, "byHost": by_host},
}
with open(os.path.join(html, "config.js"), "w") as f:
    f.write("// Written by build.py from site/site.json. Edit that, not this.\n")
    f.write("export default " + json.dumps(config, indent=2) + ";\n")

with open(os.path.join(APP, "api.js")) as f:
    version = re.search(r"^export const VERSION = '([^']*)'", f.read(), re.M).group(1)
digest = hashlib.sha256()
for name in sorted(os.listdir(html)):
    with open(os.path.join(html, name), "rb") as f:
        digest.update(f.read())
shell = ",".join(n for n in sorted(os.listdir(html)) if n != "sw.js")
sw = os.path.join(html, "sw.js")
with open(sw) as f:
    text = f.read()
text = text.replace("__BUILD__", f"{version}-{digest.hexdigest()[:10]}").replace("__SHELL__", shell)
with open(sw, "w") as f:
    f.write(text)

# ---- nginx ----
with open(os.path.join(APP, "tv-hosts.json")) as f:
    tv_hosts = " ".join("https://" + h for h in json.load(f)["hosts"])
with open(os.path.join(ROOT, "nginx", "default.conf")) as f:
    conf = f.read()

rows = [f'    default "{default_jf}";'] + [f'    "{h}" "{u}";' for h, u in by_host.items()]
helpers = site.get("helpers") or {}
conf = (conf.replace("__JELLYFIN_MAP__", "\n".join(rows))
            .replace("__TV_HOSTS__", tv_hosts)
            .replace("__RESOLVER__", helpers.get("resolver") or "127.0.0.11"))

STUB = {"speakers": "    location /speakers/ { return 404; }",
        "scores": "    location /scores/api/ { return 404; }"}
for name, stub in STUB.items():
    block = re.compile(rf"    # BEGIN {name}\n.*?    # END {name}", re.S)
    url = helpers.get(name)
    if url:
        if not re.fullmatch(r"https?://[^\s;\"']+", url):
            fail(f"helpers.{name} must be a plain http(s) address, got {url!r}")
        conf = conf.replace(f"__{name.upper()}_URL__", url)
    else:
        conf = block.sub(stub, conf)
if "__" in re.sub(r"#.*", "", conf):
    fail("an nginx placeholder was left unfilled")
with open(os.path.join(OUT, "default.conf"), "w") as f:
    f.write(conf)

print(f"built {OUT} (v{version}; helpers: {', '.join(k for k in STUB if helpers.get(k)) or 'none'})")
