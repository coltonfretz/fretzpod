#!/usr/bin/env bash
# Swaps the Home Assistant token fretzpod-speakers uses, without the token
# touching the screen, the shell history or a file. Paste it at the prompt.
#
# Make the token as a dedicated, non-admin HA user (Settings > People > Add
# person, "Allow login" on, admin off), log in as that user, Profile >
# Security > Long-lived access tokens > Create. Non-admin can still play,
# group and pause speakers, but can't change HA's configuration or users.
set -euo pipefail
cd "$(dirname "$0")/.."
NS=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('namespace') or 'fretzpod')" "${1:-site}/site.json")
read -rsp "Paste the new HA token, then Enter: " TOKEN; echo
[ -n "$TOKEN" ] || { echo "No token entered, nothing changed."; exit 1; }
B64=$(printf %s "$TOKEN" | base64 -w0)
unset TOKEN
# Through stdin (printf is a shell builtin), so the token never shows up in
# the process list either.
printf '{"data":{"HA_TOKEN":"%s"}}' "$B64" | kubectl -n "$NS" patch secret fretzpod-speakers --type merge --patch-file /dev/stdin >/dev/null
unset B64
kubectl -n "$NS" rollout restart deploy/fretzpod-speakers >/dev/null
kubectl -n "$NS" rollout status deploy/fretzpod-speakers --timeout=120s
echo "Done. Play something on Speakers to check it."
