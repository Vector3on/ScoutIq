#!/usr/bin/env bash
# Shallow-clone (first run) or shallow-update (later runs) the git-hosted sources of the
# security reference corpus: methodology guides, payload libraries, wordlists, disclosed
# write-ups and the Exploit-DB archive.
#
# Idempotent and safe to re-run. Every repository is kept at --depth=1 because SecLists
# and Exploit-DB are large. Updates use `git fetch --depth=1` + `git reset --hard
# FETCH_HEAD` rather than `git pull --depth=1 --ff-only`: once upstream has moved, the
# freshly fetched tip has no parents inside a depth-1 clone, so git refuses to
# fast-forward ("Not possible to fast-forward, aborting"). The hard reset is safe because
# these are read-only reference copies; a clone with local modifications is skipped
# (set CORPUS_FORCE_RESET=1 to discard them).
#
# Upstream LICENSE files are left exactly as cloned. Only the repositories listed in
# REPOS are contacted.
#
# Environment:
#   CORPUS_GIT_RETRIES   attempts per clone/fetch (default 3; a clone restarts, it cannot resume)
#   CORPUS_FORCE_RESET   set to 1 to update a clone even if it has local modifications
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RETRIES="${CORPUS_GIT_RETRIES:-3}"

export GIT_TERMINAL_PROMPT=0
# Abort a transfer that crawls below 1 KiB/s for 60 s (proxies sometimes stall long
# transfers) instead of hanging forever; the retry loop starts it again.
export GIT_HTTP_LOW_SPEED_LIMIT="${GIT_HTTP_LOW_SPEED_LIMIT:-1024}"
export GIT_HTTP_LOW_SPEED_TIME="${GIT_HTTP_LOW_SPEED_TIME:-60}"

# repository URL | destination relative to the corpus root
REPOS=(
  "https://github.com/OWASP/wstg|methodology/owasp-wstg"
  "https://github.com/OWASP/ASVS|methodology/owasp-asvs"
  "https://github.com/OWASP/Top10|methodology/owasp-top10"
  "https://github.com/OWASP/CheatSheetSeries|methodology/owasp-cheatsheets"
  "https://github.com/swisskyrepo/PayloadsAllTheThings|methodology/payloadsallthethings"
  "https://github.com/danielmiessler/SecLists|wordlists/seclists"
  "https://github.com/devanshbatham/Awesome-Bugbounty-Writeups|writeups/awesome-bugbounty-writeups"
  "https://github.com/ngalongc/bug-bounty-reference|writeups/bug-bounty-reference"
  "https://github.com/edoverflow/bugbounty-cheatsheet|writeups/bugbounty-cheatsheet"
  "https://gitlab.com/exploit-database/exploitdb|exploits-reference/exploitdb"
)

backoff() { sleep $((2 ** $1)); }

tracked_branch() {
  # The branch a clone follows: its checked-out branch, else origin's HEAD.
  local dest=$1 ref
  if ref=$(git -C "$dest" symbolic-ref -q --short HEAD); then
    printf '%s\n' "$ref"
  elif ref=$(git -C "$dest" symbolic-ref -q --short refs/remotes/origin/HEAD); then
    printf '%s\n' "${ref#origin/}"
  else
    return 1
  fi
}

summarize() {
  local dest=$1 license
  license=$(cd "$dest" && ls LICENSE* LICENCE* COPYING* 2>/dev/null | head -n 1)
  printf '      %s  %s  %s on disk  license file: %s\n' \
    "$(git -C "$dest" rev-parse --short HEAD)" \
    "$(git -C "$dest" log -1 --format=%cs)" \
    "$(du -sh "$dest" | cut -f1)" \
    "${license:-none in repo (see upstream README)}"
}

clone_repo() {
  local url=$1 dest=$2 attempt=1
  while :; do
    if git clone --depth=1 --single-branch --no-tags --quiet "$url" "$dest"; then
      return 0
    fi
    rm -rf "$dest"
    if [ "$attempt" -ge "$RETRIES" ]; then
      return 1
    fi
    echo "  .. clone attempt $attempt/$RETRIES failed; retrying in $((2 ** attempt))s"
    backoff "$attempt"
    attempt=$((attempt + 1))
  done
}

update_repo() {
  local dest=$1 branch before after attempt=1
  if [ -n "$(git -C "$dest" status --porcelain --untracked-files=no)" ] \
     && [ "${CORPUS_FORCE_RESET:-0}" != 1 ]; then
    echo "  !! local modifications present; not updating (reference clones should stay"
    echo "     pristine; set CORPUS_FORCE_RESET=1 to discard the changes)"
    return 1
  fi
  branch=$(tracked_branch "$dest") || { echo "  !! cannot determine which branch to follow"; return 1; }
  before=$(git -C "$dest" rev-parse HEAD)
  while :; do
    if git -C "$dest" fetch --depth=1 --no-tags --quiet origin "$branch"; then
      break
    fi
    if [ "$attempt" -ge "$RETRIES" ]; then
      echo "  !! fetch failed after $attempt attempts"
      return 1
    fi
    echo "  .. fetch attempt $attempt/$RETRIES failed; retrying in $((2 ** attempt))s"
    backoff "$attempt"
    attempt=$((attempt + 1))
  done
  after=$(git -C "$dest" rev-parse FETCH_HEAD)
  if [ "$before" = "$after" ]; then
    echo "  ==  up to date"
    return 0
  fi
  git -C "$dest" reset -q --hard FETCH_HEAD || return 1
  git -C "$dest" update-ref "refs/remotes/origin/$branch" FETCH_HEAD
  # Drop the now-unreachable previous snapshot so the clone stays depth-1 sized.
  git -C "$dest" reflog expire --expire=now --all
  git -C "$dest" gc --quiet --prune=now
  echo "  ok  updated ${before:0:7} -> ${after:0:7}"
}

failed=()
for entry in "${REPOS[@]}"; do
  url="${entry%%|*}"
  relative="${entry##*|}"
  dest="$ROOT/$relative"
  if [ -d "$dest/.git" ]; then
    echo "[update] $relative"
    update_repo "$dest" || failed+=("$relative")
  else
    echo "[clone] $url -> $relative"
    mkdir -p "$(dirname "$dest")"
    if clone_repo "$url" "$dest"; then
      echo "  ok  cloned"
    else
      echo "  !! clone failed: $url"
      failed+=("$relative")
      continue
    fi
  fi
  summarize "$dest"
done

if [ "${#failed[@]}" -gt 0 ]; then
  echo "Done with ${#failed[@]} failure(s): ${failed[*]}"
  exit 1
fi
echo "Done: all ${#REPOS[@]} repositories are current."
