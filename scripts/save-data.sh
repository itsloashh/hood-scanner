#!/usr/bin/env bash
# Commit this job's data files without ever fighting other commits.
# Usage: scripts/save-data.sh "<commit message>" <path> [<path> ...]
# Each job only restores the files it owns, on top of the latest main, then pushes.
# Retries if someone else pushed in between. Safe because scans and research never
# run at the same time (shared concurrency group).
set -u
msg="$1"; shift
stash="$(mktemp -d)"
for p in "$@"; do
  if [ -e "$p" ]; then mkdir -p "$stash/$(dirname "$p")"; cp -r "$p" "$stash/$p"; fi
done
git config user.name "hood-scanner-bot"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
for i in 1 2 3 4 5; do
  git fetch --quiet origin main || { sleep $((i * 3)); continue; }
  git reset --quiet --hard origin/main
  for p in "$@"; do
    if [ -e "$stash/$p" ]; then rm -rf "$p"; mkdir -p "$(dirname "$p")"; cp -r "$stash/$p" "$p"; fi
  done
  for p in "$@"; do [ -e "$p" ] && git add -- "$p"; done
  if git diff --cached --quiet; then echo "save-data: nothing new to save"; exit 0; fi
  git commit --quiet -m "$msg"
  if git push --quiet origin HEAD:main; then echo "save-data: saved on attempt $i"; exit 0; fi
  echo "save-data: push rejected (attempt $i), retrying…"
  sleep $((i * 5))
done
echo "save-data: FAILED after 5 attempts"
git status --short | head -20
exit 1
