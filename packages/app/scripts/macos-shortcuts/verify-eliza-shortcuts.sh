#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
Usage:
  verify-eliza-shortcuts.sh [options]

Options:
  --helper PATH            Handoff helper to verify. Defaults to the installed
                           elizaOS Shortcuts helper.
  --shortcut-name NAME     User-created macOS Shortcut name. Defaults to
                           "Ask Eliza".
  --require-shortcut       Fail if the Shortcut is not present in Shortcuts.app.
  --run-shortcut           Run the Shortcut with test input. Implies
                           --require-shortcut.
  --live-open              Open the desktop URL scheme with test input.
  --helper-only            Verify the shell helper without querying Shortcuts.app.
  --no-shortcuts-warning   Suppress the warning when the Shortcut is not found.
  -h, --help               Show this help.

This verifier checks the installed shell handoff and, when requested, the
user-created macOS Shortcut. It never writes LifeOps state; live runs hand text
to the normal app/runtime deep-link path.
EOF
}

default_helper="$HOME/Library/Application Support/elizaOS/Shortcuts/eliza-assistant-handoff.sh"
helper="${ELIZA_SHORTCUT_HELPER:-$default_helper}"
shortcut_name="${ELIZA_SHORTCUT_NAME:-Ask Eliza}"
require_shortcut=0
run_shortcut=0
live_open=0
shortcuts_warning=1
helper_only=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --helper)
      shift
      if [ "$#" -eq 0 ]; then
        echo "verify-eliza-shortcuts: --helper requires a path" >&2
        exit 2
      fi
      helper="$1"
      shift
      ;;
    --shortcut-name)
      shift
      if [ "$#" -eq 0 ]; then
        echo "verify-eliza-shortcuts: --shortcut-name requires a value" >&2
        exit 2
      fi
      shortcut_name="$1"
      shift
      ;;
    --require-shortcut)
      require_shortcut=1
      shift
      ;;
    --run-shortcut)
      require_shortcut=1
      run_shortcut=1
      shift
      ;;
    --live-open)
      live_open=1
      shift
      ;;
    --helper-only)
      helper_only=1
      shift
      ;;
    --no-shortcuts-warning)
      shortcuts_warning=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "verify-eliza-shortcuts: unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if [ "$helper_only" -eq 1 ] && { [ "$require_shortcut" -eq 1 ] || [ "$live_open" -eq 1 ]; }; then
  echo "verify-eliza-shortcuts: --helper-only cannot be combined with live verification" >&2
  exit 2
fi

if [ ! -x "$helper" ]; then
  echo "verify-eliza-shortcuts: handoff helper is not executable: $helper" >&2
  echo "Run packages/app/scripts/macos-shortcuts/install-eliza-shortcuts.sh first." >&2
  exit 1
fi

expected_url="elizaos://assistant?text=Remind%20me%20at%205%20%26%20call%20mom&source=macos-shortcuts&action=ask"
actual_url="$(
  ELIZA_URL_SCHEME=elizaos \
  ELIZA_SHORTCUT_SOURCE=macos-shortcuts \
  ELIZA_SHORTCUT_ACTION=ask \
  sh "$helper" --dry-run "Remind me at 5 & call mom"
)"

if [ "$actual_url" != "$expected_url" ]; then
  echo "verify-eliza-shortcuts: helper built unexpected URL" >&2
  echo "expected: $expected_url" >&2
  echo "actual:   $actual_url" >&2
  exit 1
fi

stdin_url="$(
  printf '%s' "check in on me tomorrow morning" | \
    ELIZA_URL_SCHEME=elizaos \
    ELIZA_SHORTCUT_SOURCE=macos-shortcuts \
    ELIZA_SHORTCUT_ACTION=lifeops.create \
    sh "$helper" --dry-run
)"
expected_stdin_url="elizaos://assistant?text=check%20in%20on%20me%20tomorrow%20morning&source=macos-shortcuts&action=lifeops.create"

if [ "$stdin_url" != "$expected_stdin_url" ]; then
  echo "verify-eliza-shortcuts: stdin handoff built unexpected URL" >&2
  echo "expected: $expected_stdin_url" >&2
  echo "actual:   $stdin_url" >&2
  exit 1
fi

multiline_url="$(
  printf '%s' "line one
it's 100% (done) * now!" | \
    ELIZA_URL_SCHEME=elizaos \
    ELIZA_SHORTCUT_SOURCE=macos-shortcuts \
    ELIZA_SHORTCUT_ACTION=ask \
    sh "$helper" --dry-run
)"
expected_multiline_url="elizaos://assistant?text=line%20one%0Ait%27s%20100%25%20%28done%29%20%2A%20now%21&source=macos-shortcuts&action=ask"

if [ "$multiline_url" != "$expected_multiline_url" ]; then
  echo "verify-eliza-shortcuts: multiline stdin built unexpected URL" >&2
  echo "expected: $expected_multiline_url" >&2
  echo "actual:   $multiline_url" >&2
  exit 1
fi

shortcut_present=0
if [ "$helper_only" -eq 1 ]; then
  : # Installation checks only the helper; native inventory is an explicit verification.
elif command -v shortcuts >/dev/null 2>&1; then
  if shortcuts list 2>/dev/null | grep -Fx -- "$shortcut_name" >/dev/null 2>&1; then
    shortcut_present=1
  fi
else
  if [ "$require_shortcut" -eq 1 ]; then
    echo "verify-eliza-shortcuts: shortcuts(1) is not available on this host" >&2
    exit 1
  fi
fi

if [ "$require_shortcut" -eq 1 ] && [ "$shortcut_present" -ne 1 ]; then
  echo "verify-eliza-shortcuts: Shortcut not found: $shortcut_name" >&2
  echo "Create it in Shortcuts.app with Ask for Input -> Run Shell Script." >&2
  exit 1
fi

if [ "$run_shortcut" -eq 1 ]; then
  tmp_input="$(mktemp "${TMPDIR:-/tmp}/eliza-shortcuts-input.XXXXXX")"
  trap 'rm -f "$tmp_input"' EXIT INT HUP TERM
  printf '%s\n' "remind me to stand up in 20 minutes" >"$tmp_input"
  shortcuts run "$shortcut_name" --input-path "$tmp_input"
fi

if [ "$live_open" -eq 1 ]; then
  sh "$helper" "remind me to stand up in 20 minutes" >/dev/null
fi

echo "PASS helper builds assistant deep links"
echo "PASS stdin can request action=lifeops.create through the runtime route"
echo "PASS multiline stdin and punctuation are percent-encoded"
if [ "$shortcut_present" -eq 1 ]; then
  echo "PASS Shortcut exists: $shortcut_name"
elif [ "$helper_only" -eq 0 ] && [ "$shortcuts_warning" -eq 1 ]; then
  echo "WARN Shortcut not found yet: $shortcut_name"
fi
