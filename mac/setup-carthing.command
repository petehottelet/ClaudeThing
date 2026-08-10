#!/bin/bash
#
# Car Thing AI Usage Dashboard — macOS setup.
# Double-click this file. If macOS blocks it ("unidentified developer"):
# right-click -> Open -> Open.
#
# This is a thin launcher: it ensures Homebrew and Node exist, then hands
# off to the cross-platform orchestrator at setup/setup.mjs.
#
set -u
cd "$(dirname "$0")/.." || exit 1

say() { printf "\n\033[1m%s\033[0m\n" "$*"; }
fail() { printf "\n\033[31mSTOP: %s\033[0m\n" "$*"; read -r -p "Press Enter to close. " _; exit 1; }

command -v softwareupdate >/dev/null 2>&1 || fail "This launcher is for macOS."

if ! command -v git >/dev/null 2>&1; then
  say "git is missing — macOS will prompt to install the Command Line Tools."
  xcode-select --install 2>/dev/null || true
  fail "Install the Command Line Tools from the dialog, then run this file again."
fi

if ! command -v brew >/dev/null 2>&1; then
  say "Installing Homebrew (you may be asked for your password)…"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || fail "Homebrew installation failed."
fi
eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv 2>/dev/null)" || true

if ! command -v node >/dev/null 2>&1; then
  say "Installing Node…"
  brew install node || fail "Could not install Node with Homebrew."
fi

exec node setup/setup.mjs "$@"
