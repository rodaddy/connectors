#!/usr/bin/env bash
# install.sh -- point this repo's core.hooksPath at the tracked _githooks/.
#
# THE TRAP THIS EXISTS TO CATCH
#
# `git config core.hooksPath` overrides .git/hooks entirely. A global hooksPath
# may be set on a machine (~/.config/git/hooks: gitleaks and the protected-branch
# guard), so copying files into .git/hooks would install nothing: git reports
# no error and every commit passes. That happened in one of the repos the
# standard came from.
#
# So this repo sets a LOCAL core.hooksPath to _githooks/, which wins over the
# global one. Because that shadows the global hooks, pre-commit and pre-push
# chain them first, unchanged -- secret scanning is not given up for this.
#
# An installer that cannot install must say so, so the result is read back.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$here" rev-parse --show-toplevel 2>/dev/null)"

if [[ -z "$repo_root" ]]; then
  printf 'install.sh: not inside a git repository.\n'
  exit 1
fi

for hook in pre-commit commit-msg pre-push post-merge; do
  src="$here/$hook"
  [[ -f "$src" ]] || { printf '  MISSING SOURCE: %s\n' "$src"; exit 1; }
  chmod +x "$src"
done

git -C "$repo_root" config --local core.hooksPath _githooks

resolved="$(git -C "$repo_root" config --get core.hooksPath || true)"
if [[ "$resolved" != "_githooks" ]]; then
  printf '\nINSTALL FAILED: core.hooksPath resolves to %s, not _githooks.\n\n' "${resolved:-<unset>}"
  exit 1
fi

printf 'core.hooksPath = %s (repo-local)\n' "$resolved"
printf 'Hooks fire from %s/_githooks; the global hooks are chained from there.\n' "$repo_root"
