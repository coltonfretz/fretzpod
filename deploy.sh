#!/usr/bin/env bash
# Kubernetes deploy: builds the site (build.py), pushes the app, nginx config
# and helper code into ConfigMaps, applies the site's manifests, restarts only
# the pods whose files changed. Usage: ./deploy.sh [site_dir]  (default: site/)
#
# site_dir holds site.json plus the manifests to apply: fretzpod.yaml, and
# speakers.yaml / scores.yaml for the optional helpers (start from
# examples/kubernetes/). A helper without its manifest is simply not deployed.
#
# Safe to run any time for phones: they stream from Jellyfin, not from here.
# A Sonos playing through Speakers downloads each song through the
# fretzpod-speakers pod, which only restarts when speakers.py changes.
set -euo pipefail
cd "$(dirname "$0")"
SITE=${1:-site}
NS=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('namespace') or 'fretzpod')" "$SITE/site.json")

BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT
python3 build.py "$SITE" "$BUILD"

# Server-side apply: a plain `kubectl apply` copies the whole ConfigMap into an
# annotation capped at 256 KB, which app files will outgrow long before the
# ConfigMap's own 1 MiB limit.
cm() {
  local name=$1; shift
  kubectl -n "$NS" create configmap "$name" "$@" --dry-run=client -o yaml \
    | kubectl apply --server-side --force-conflicts -f -
}
cm fretzpod-app --from-file="$BUILD/html/"
# --from-file=dir/ skips subfolders; vendor (hls.js) is its own ConfigMap.
cm fretzpod-vendor --from-file="$BUILD/vendor/"
cm fretzpod-nginx --from-file=default.conf="$BUILD/default.conf"
DEPLOYS=(fretzpod)
manifests=(-f "$SITE/fretzpod.yaml")
for helper in speakers scores; do
  if [ -f "$SITE/$helper.yaml" ]; then
    cm "fretzpod-$helper-code" --from-file="$helper/$helper.py"
    manifests+=(-f "$SITE/$helper.yaml")
    DEPLOYS+=("fretzpod-$helper")
  fi
done
kubectl apply "${manifests[@]}"

# Restart only what changed: each pod template carries a hash of the files
# it serves. Patching in the same hash is a no-op, so an unchanged pod keeps
# running (a playing speaker isn't cut off by a page-only deploy); a new hash
# rolls the pod right away instead of waiting up to a minute for the
# ConfigMap volume to catch up.
stamp() {
  kubectl -n "$NS" patch deploy "$1" --type merge \
    -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"fretzpod/inputs\":\"$2\"}}}}}"
}
stamp fretzpod "$(cat "$BUILD"/html/* "$BUILD"/vendor/* "$BUILD/default.conf" "$SITE/fretzpod.yaml" | sha256sum | cut -c1-16)"
for helper in speakers scores; do
  if [ -f "$SITE/$helper.yaml" ]; then
    stamp "fretzpod-$helper" "$(cat "$helper/$helper.py" "$SITE/$helper.yaml" | sha256sum | cut -c1-16)"
  fi
done
for d in "${DEPLOYS[@]}"; do
  kubectl -n "$NS" rollout status "deploy/$d" --timeout=120s
done

# Optional: a hook the site can use to record the live state somewhere
# (mine commits the cluster's manifests to a private repo).
if [ -x "$SITE/after-deploy.sh" ]; then
  "$SITE/after-deploy.sh"
fi
