#!/usr/bin/env bash
# checks.sh -- the standard-specific source checks no off-the-shelf linter does.
#
# ONE copy, run by both _githooks/pre-commit (on the staged checkout) and
# .github/workflows/ci.yml (on every tracked file). Two copies of these regexes
# would drift, and a check that only the hook runs is skipped by --no-verify.
#
# Usage:
#   scripts/checks.sh <file>...   check exactly these files (the hook)
#   scripts/checks.sh             check every tracked TypeScript file (CI)
#
# Exit 0 when clean, 1 when any check finds a violation. FAIL CLOSED: a missing
# rg is a failure, not a skip.

set -uo pipefail

if ! command -v rg >/dev/null 2>&1; then
  printf '\n[checks] MISSING TOOL: rg -- failing closed.\n\n'
  exit 1
fi

files=("$@")
if [[ ${#files[@]} -eq 0 ]]; then
  repo_root="$(git rev-parse --show-toplevel)" || exit 1
  cd "$repo_root" || exit 1
  mapfile -t files < <(git ls-files -- '*.ts' '*.tsx' '*.mts' '*.cts')
fi

if [[ ${#files[@]} -eq 0 ]]; then
  printf '\n[checks] no TypeScript files -- nothing to check\n'
  exit 0
fi

fail=0
note() { printf '  %s\n' "$*"; }
step() { printf '\n[checks] %s\n' "$*"; }

# check <title> <rg args...> -- report matches and mark the run failed.
# rg exits 0 on a match (the failure case here), 1 on no match, and 2 on an
# error. An error is a failure too: an rg built without PCRE2, or a missing
# file, must not read as "clean".
check() {
  local found status
  found=$(rg -nH "${@:2}" -- "${files[@]}" 2>&1)
  status=$?
  [[ $status -eq 1 ]] && return 0
  step "$1"
  printf '%s\n' "$found" | sed 's/^/  /'
  [[ $status -eq 0 ]] || note "ERROR: rg exited $status -- failing closed."
  return 1
}

if ! check "naive Date (must be explicit UTC)" --pcre2 'new Date\(\)(?!\s*\.\s*getTime)'; then
  note "FAILED. Construct dates from an explicit UTC instant."
  note "A bare new Date() renders in whatever timezone the host happens to"
  note "have, so the same log line means two different instants on two boxes."
  fail=1
fi

if ! check "any-typed catch (must be 'unknown' and narrowed)" \
  'catch\s*\([A-Za-z_$][A-Za-z0-9_$]*\s*:\s*any\s*\)'; then
  note "FAILED. Use 'catch (error: unknown)' and narrow with instanceof."
  note "'catch (e: any)' lets e.message compile against a thrown string and"
  note "then reads undefined at runtime, in the error path, under load."
  fail=1
fi

# oxlint's no-console already covers src/. This catches the case oxlint cannot:
# a console call added to a file the .oxlintrc.json overrides exempt, where the
# exemption was for ONE specific reason and has now been borrowed for another.
if ! check "console.* outside the sanctioned files" 'console\.(log|debug|info)\('; then
  note "FAILED. A library does not write to the console; return or throw."
  note "console bypasses the correlation id, the level filter, and every sink,"
  note "so the line you most want during an incident is the one not in the file."
  note "console.error in an entry-point catch is the sanctioned exception."
  fail=1
fi

if ! check "TODO without an issue reference" --pcre2 'TODO(?!\()'; then
  note "FAILED. Write TODO(#123) so the work is tracked somewhere that is"
  note "read. A bare TODO is a note to a person who will never see it."
  fail=1
fi

if [[ $fail -ne 0 ]]; then
  exit 1
fi

printf '\n[checks] naive Date, any catch, console, bare TODO: clean (%d files)\n' "${#files[@]}"
exit 0
