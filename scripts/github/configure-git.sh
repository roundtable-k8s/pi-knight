# shellcheck shell=bash
# Sourced by entrypoint.sh (Phase 4.9): configure git HTTPS credentials.
#
# With GITHUB_TOKEN_FILE (a token Secret the operator mounts and the kubelet
# refreshes in place), git uses git-credential-roundtable, which re-reads the
# file on every call. Otherwise keep the env-token behaviour: gh as the helper
# when installed, else a static store written from GH_TOKEN.
#
# Overridable for tests: ROUNDTABLE_CREDENTIAL_HELPER.

_cfg_log() {
  if declare -F log >/dev/null 2>&1; then log "$@"; else echo "$*"; fi
}

ROUNDTABLE_CREDENTIAL_HELPER="${ROUNDTABLE_CREDENTIAL_HELPER:-/usr/local/bin/git-credential-roundtable}"

if [ -n "${GITHUB_TOKEN_FILE:-}" ]; then
  git config --global --replace-all credential.helper "$ROUNDTABLE_CREDENTIAL_HELPER"
  # A previous boot's token-store fallback left a frozen token here.
  rm -f "$HOME/.git-credentials"
  if [ -r "$GITHUB_TOKEN_FILE" ]; then
    _cfg_log "Phase 4.9: Git credential helper configured (token file $GITHUB_TOKEN_FILE) ✓"
  else
    _cfg_log "Phase 4.9: WARNING: GITHUB_TOKEN_FILE=$GITHUB_TOKEN_FILE is not readable; push will fail until it is"
  fi
elif command -v gh >/dev/null 2>&1; then
  git config --global credential.helper '!gh auth git-credential'
  _cfg_log "Phase 4.9: Git credential helper configured (gh) ✓"
elif [ -n "${GH_TOKEN:-}" ]; then
  # Fallback: write a static credential helper using GH_TOKEN directly
  git config --global credential.helper store
  echo "https://x-access-token:${GH_TOKEN}@github.com" > "$HOME/.git-credentials"
  chmod 600 "$HOME/.git-credentials"
  _cfg_log "Phase 4.9: Git credential helper configured (token store) ✓"
else
  _cfg_log "Phase 4.9: No git credentials available — push will fail"
fi
