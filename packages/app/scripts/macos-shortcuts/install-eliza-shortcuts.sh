#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
source_script="$script_dir/eliza-assistant-handoff.sh"
source_verify_script="$script_dir/verify-eliza-shortcuts.sh"
target_dir="${ELIZA_SHORTCUT_INSTALL_DIR:-$HOME/Library/Application Support/elizaOS/Shortcuts}"
target_script="$target_dir/eliza-assistant-handoff.sh"
target_verify_script="$target_dir/verify-eliza-shortcuts.sh"

if [ ! -f "$source_script" ]; then
  echo "install-eliza-shortcuts: missing handoff script: $source_script" >&2
  exit 1
fi
if [ ! -f "$source_verify_script" ]; then
  echo "install-eliza-shortcuts: missing verifier script: $source_verify_script" >&2
  exit 1
fi

mkdir -p "$target_dir"
cp "$source_script" "$target_script"
cp "$source_verify_script" "$target_verify_script"
chmod 755 "$target_script"
chmod 755 "$target_verify_script"

dry_run_url="$(sh "$target_script" --dry-run "remind me to test Eliza Shortcuts")"
verify_summary="$(sh "$target_verify_script" --helper "$target_script" --helper-only)"

cat <<EOF
Installed Eliza macOS Shortcuts handoff helper:
  $target_script

Installed verification helper:
  $target_verify_script

Dry-run URL:
  $dry_run_url

Verification summary:
$verify_summary

Create the user-facing Shortcut in the macOS Shortcuts app:
  1. New Shortcut named "Ask Eliza".
  2. Add "Ask for Input" with Text input.
  3. Add "Run Shell Script".
  4. Set "Pass Input" to stdin.
  5. Use this shell body:
       "$target_script"

Optional LifeOps-focused shortcut:
  Use the same shell body with an action override:
       ELIZA_SHORTCUT_ACTION=lifeops.create "$target_script"

Verification:
  printf 'remind me to stand up in 20 minutes' | "$target_script" --dry-run
  printf 'remind me to stand up in 20 minutes' | "$target_script"
  "$target_verify_script" --helper "$target_script" --require-shortcut
  tmp_input="\$(mktemp "\${TMPDIR:-/tmp}/eliza-shortcuts-input.XXXXXX")"
  printf 'remind me to stand up in 20 minutes\n' >"\$tmp_input"
  shortcuts run "Ask Eliza" --input-path "\$tmp_input"
  rm -f "\$tmp_input"

The Shortcut creation itself remains a macOS UI step because shortcuts(1) can
run, list, view, and sign shortcuts, but creation/editing is owned by the
Shortcuts app.
EOF
