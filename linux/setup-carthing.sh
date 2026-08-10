#!/bin/bash
#
# Car Thing AI Usage Dashboard — Linux setup.
# Run: bash linux/setup-carthing.sh
#
# Thin launcher: checks for Node, then hands off to the cross-platform
# orchestrator at setup/setup.mjs. Raw USB access for the device unlock
# runs under sudo; the orchestrator prompts before anything risky.
#
set -u
cd "$(dirname "$0")/.." || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node is required. Install it with your package manager, e.g.:"
  echo "  sudo apt-get install -y nodejs npm    # Debian/Ubuntu"
  echo "  sudo dnf install -y nodejs npm        # Fedora"
  exit 1
fi

exec node setup/setup.mjs "$@"
