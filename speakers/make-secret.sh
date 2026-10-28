#!/usr/bin/env bash
# One-time setup for fretzpod-speakers: makes the Secret it reads its keys
# from. Prints no secret values. Refuses to run once the Secret exists (a
# rerun would make a new SIGN_KEY, breaking links already in a speaker's
# queue); to swap the HA token later, use set-ha-token.sh.
#
#   HA_TOKEN  a Home Assistant long-lived token, pasted at the prompt (or from
#             HA_TOKEN_FILE). Make it as a non-admin HA user: it can still
#             play, group and pause speakers, but can't change HA itself.
#   JF_KEY    a Jellyfin API key named "Fretzpod speakers", created here if it
#             doesn't exist. Needs an admin key once to do that: pasted at
#             the prompt (Dashboard > API Keys), never stored.
#   SIGN_KEY  random; signs the song links.
#
# Usage: JF_URL=http://<jellyfin>:8096 speakers/make-secret.sh [site_dir]
set -euo pipefail
cd "$(dirname "$0")/.."
SITE=${1:-site}
NS=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('namespace') or 'fretzpod')" "$SITE/site.json")
JF=${JF_URL:?set JF_URL to the Jellyfin address this machine can reach, e.g. JF_URL=http://192.168.1.10:8096}
if kubectl -n "$NS" get secret fretzpod-speakers >/dev/null 2>&1; then
  echo "Secret fretzpod-speakers already exists in $NS; nothing changed. New HA token: speakers/set-ha-token.sh" >&2
  exit 1
fi
read -rsp "Paste a Jellyfin admin API key (only used to make the speakers key): " ADMIN; echo
H="Authorization: MediaBrowser Token=\"$ADMIN\""
find_key() {
  curl -s -H "$H" "$JF/Auth/Keys" | python3 -c '
import json, sys
print(next((k["AccessToken"] for k in json.load(sys.stdin)["Items"] if k["AppName"] == "Fretzpod speakers"), ""))'
}
KEY=$(find_key)
if [ -z "$KEY" ]; then
  curl -sf -X POST -H "$H" "$JF/Auth/Keys?app=Fretzpod%20speakers" >/dev/null
  KEY=$(find_key)
fi
unset ADMIN H
[ -n "$KEY" ] || { echo "couldn't create the Jellyfin key" >&2; exit 1; }
if [ -n "${HA_TOKEN_FILE:-}" ]; then
  HA=$(cat "$HA_TOKEN_FILE")
else
  read -rsp "Paste the Home Assistant token: " HA; echo
fi
[ -n "$HA" ] || { echo "No HA token, nothing changed." >&2; exit 1; }
# The values go in through the environment and out through a pipe, never on
# a command line, so they don't show up in the process list.
FP_HA="$HA" FP_KEY="$KEY" python3 -c '
import base64, json, os
d = {k: base64.b64encode(v.encode()).decode() for k, v in
     (("HA_TOKEN", os.environ["FP_HA"].strip()), ("JF_KEY", os.environ["FP_KEY"]), ("SIGN_KEY", os.urandom(32).hex()))}
print(json.dumps({"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "fretzpod-speakers"}, "data": d}))
' | kubectl -n "$NS" apply -f - >/dev/null
unset HA KEY
echo "Secret fretzpod-speakers written in $NS (HA_TOKEN, JF_KEY, SIGN_KEY)"
