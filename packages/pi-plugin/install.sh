#!/usr/bin/env bash
# Install the pi extension that lets a session wake itself up at a chosen time.
#
#   ./install.sh            link the package into ~/.pi/agent/extensions/
#   ./install.sh --uninstall remove the link
#
# The extension is linked, not copied: edits in this checkout take effect on the
# next pi session. Pi loads it as a directory with a package.json manifest, so
# the "pi" field in the manifest is what makes the loader pick it up.
#
# A global link is safe: without a scheduled wake-up the extension does nothing.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
INSTALL_DIR="$PI_AGENT_DIR/extensions/pi-wake"
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

log() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

if [ "$UNINSTALL" = 1 ]; then
  if [ -L "$INSTALL_DIR" ] || [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
    log "removed $INSTALL_DIR"
  else
    log "nothing installed at $INSTALL_DIR"
  fi
  exit 0
fi

[ -f "$REPO_DIR/package.json" ] || die "no package.json in $REPO_DIR"

mkdir -p "$(dirname "$INSTALL_DIR")"
if [ -e "$INSTALL_DIR" ] || [ -L "$INSTALL_DIR" ]; then
  if [ -L "$INSTALL_DIR" ] && [ "$(readlink "$INSTALL_DIR")" = "$REPO_DIR" ]; then
    log "already linked: $INSTALL_DIR -> $REPO_DIR"
    exit 0
  fi
  die "$INSTALL_DIR exists and is not a link to this checkout; remove it first"
fi

ln -s "$REPO_DIR" "$INSTALL_DIR"
log "linked $INSTALL_DIR -> $REPO_DIR"
log "the next pi session loads the extension"
