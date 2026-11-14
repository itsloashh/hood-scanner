#!/bin/bash
# Vercel "Ignored Build Step": exit 0 = skip this deploy, exit 1 = build.
# The scanner commits data every few minutes; only build when dashboard/ changed
# since the last deployment that actually went live.
prev="$VERCEL_GIT_PREVIOUS_SHA"
[ -z "$prev" ] && exit 1
git cat-file -e "${prev}^{commit}" 2>/dev/null || git fetch -q --depth=1 origin "$prev" 2>/dev/null || exit 1
git diff --quiet "$prev" HEAD -- . && exit 0
exit 1
