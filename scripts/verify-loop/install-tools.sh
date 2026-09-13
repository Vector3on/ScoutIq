#!/usr/bin/env bash
# Install the pinned confirmer toolchain for the verify-loop.
#
# Versions are pinned in tools.pinned.json. This script is idempotent and
# best-effort per tool: a tool that fails to install is reported and skipped so
# the rest still install. The verify-loop degrades gracefully when a confirmer
# is absent (it reports "unavailable" and kills the candidate at the gate), so a
# partial toolchain is a valid, honest setup.
#
# Usage:
#   scripts/verify-loop/install-tools.sh [static|contracts|web|all]   (default: all)
#
# Requires: python3 + pipx (static/symbolic), curl (foundry/echidna/codeql),
# and docker (web local-run harness, operator-provided).
set -uo pipefail

group="${1:-all}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

have() { command -v "$1" >/dev/null 2>&1; }
note() { printf '[verify-loop install] %s\n' "$*"; }
warn() { printf '[verify-loop install] WARN: %s\n' "$*" >&2; }

ensure_pipx() {
  if have pipx; then return 0; fi
  if have python3; then
    note "installing pipx"
    python3 -m pip install --user pipx >/dev/null 2>&1 && python3 -m pipx ensurepath >/dev/null 2>&1 && return 0
  fi
  warn "pipx unavailable; skipping pip-based tools (slither, semgrep, halmos, mythril)"
  return 1
}

install_static() {
  ensure_pipx || return 0
  for spec in "slither-analyzer==0.10.4" "semgrep==1.86.0"; do
    note "pipx install ${spec}"
    pipx install "${spec}" 2>/dev/null || pipx upgrade "${spec%%==*}" 2>/dev/null || warn "failed: ${spec}"
  done
  if have curl && ! have codeql; then
    note "installing CodeQL bundle v2.19.3 to ~/.verify-loop/codeql"
    mkdir -p "${HOME}/.verify-loop"
    if curl -fsSL "https://github.com/github/codeql-action/releases/download/codeql-bundle-v2.19.3/codeql-bundle-linux64.tar.gz" -o /tmp/codeql.tgz; then
      tar -xzf /tmp/codeql.tgz -C "${HOME}/.verify-loop" && note "add ${HOME}/.verify-loop/codeql to PATH"
    else
      warn "codeql bundle download failed"
    fi
  fi
}

install_contracts() {
  ensure_pipx && {
    for spec in "halmos==0.2.4" "mythril==0.24.8"; do
      note "pipx install ${spec}"
      pipx install "${spec}" 2>/dev/null || warn "failed: ${spec}"
    done
  }
  if ! have forge && have curl; then
    note "installing Foundry (foundryup)"
    curl -fsSL https://foundry.paradigm.xyz | bash 2>/dev/null && "${HOME}/.foundry/bin/foundryup" --version nightly-2024-11-01 2>/dev/null || warn "foundry install failed"
  fi
  if ! have echidna && have curl; then
    note "installing Echidna v2.2.4 to ~/.verify-loop"
    mkdir -p "${HOME}/.verify-loop/echidna"
    if curl -fsSL "https://github.com/crytic/echidna/releases/download/v2.2.4/echidna-2.2.4-x86_64-linux.tar.gz" -o /tmp/echidna.tgz; then
      tar -xzf /tmp/echidna.tgz -C "${HOME}/.verify-loop/echidna" && note "add ${HOME}/.verify-loop/echidna to PATH"
    else
      warn "echidna download failed"
    fi
  fi
}

install_web() {
  ensure_pipx && { note "pipx install atheris==2.3.0"; pipx install "atheris==2.3.0" 2>/dev/null || warn "atheris failed (needs clang)"; }
  have docker || warn "docker not found — the web runtime harness needs a local container you build"
  have afl-fuzz || warn "afl++ not found — install via your package manager (e.g. apt-get install afl++) for the fuzz step"
}

case "${group}" in
  static) install_static ;;
  contracts) install_contracts ;;
  web) install_web ;;
  all) install_static; install_contracts; install_web ;;
  *) warn "unknown group '${group}' (use static|contracts|web|all)"; exit 2 ;;
esac

note "done. Re-run 'node scripts/verify-loop.mjs --target <path>' — available confirmers are listed at the top of the report."
note "manifest: ${here}/tools.pinned.json"
