#!/bin/bash
# Vercel "Ignored Build Step": exit 0 = skip this deploy, exit 1 = build.
# The bots commit data every few minutes; only build when dashboard/ itself changed.
prev="$VERCEL_GIT_PREVIOUS_SHA"
[ -z "$prev" ] && exit 1                      # first deploy
if git cat-file -e "${prev}^{commit}" 2>/dev/null; then
  git diff --quiet "$prev" HEAD -- . && exit 0 || exit 1
fi
# last live deploy is outside the shallow clone: judge this commit alone
git diff --quiet HEAD^ HEAD -- . && exit 0
exit 1
