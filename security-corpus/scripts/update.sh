#!/usr/bin/env bash
# Refresh the whole corpus: re-fetch the data feeds, shallow-update the git repositories,
# stamp .last-update, regenerate the status block in README.md and print a storage
# report. The exit status is non-zero if any source failed (everything else still runs).
#
# Schedule it, e.g. weekly on Sunday 03:00 (the CVE feeds and KEV change daily; ATT&CK,
# CWE and CAPEC a few times a year; the git repositories continuously):
#   0 3 * * 0  /path/to/security-corpus/scripts/update.sh >> /path/to/security-corpus/update.log 2>&1
#
# Extra arguments are passed through to fetch_data.py, e.g.:
#   scripts/update.sh --nvd-api-days 7    # also pull same-week deltas from the NVD 2.0 API
#   scripts/update.sh --no-decompress     # keep only the .xz feeds to save space
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
LOCK="$ROOT/.update.lock"

# One update at a time (cron overlap protection); mkdir is atomic and portable.
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "update.sh: another update is running (or a stale lock is left at $LOCK); exiting" >&2
  exit 1
fi
trap 'rmdir "$LOCK"' EXIT

echo "== security-corpus update started $(date -u +'%Y-%m-%d %H:%M UTC') =="
status=0
python3 "$DIR/fetch_data.py" "$@" || status=1
echo
bash "$DIR/clone_repos.sh" || status=1

date -u +"Last updated: %Y-%m-%d %H:%M UTC" > "$ROOT/.last-update"

# Refresh the generated status section of README.md (between the two markers).
readme="$ROOT/README.md"
if grep -q '<!-- status:start -->' "$readme" 2>/dev/null; then
  block="$ROOT/.status.tmp"
  if python3 "$DIR/fetch_data.py" --status > "$block"; then
    awk -v f="$block" '
      /<!-- status:start -->/ { print; while ((getline line < f) > 0) print line; skip = 1; next }
      /<!-- status:end -->/   { skip = 0 }
      !skip                   { print }
    ' "$readme" > "$readme.tmp" && mv "$readme.tmp" "$readme"
  fi
  rm -f "$block" "$readme.tmp"
fi

echo
echo "== storage report =="
du -sh "$ROOT"/*/ 2>/dev/null | sort -h
du -sh "$ROOT" | awk '{ print $1 "\t" $2 "  (total)" }'
echo "== finished $(date -u +'%Y-%m-%d %H:%M UTC'), exit $status =="
exit "$status"
