# How connectors was built

This repo was published on 2026-10-13 as a scrubbed snapshot, so the public
git log is short. The history below comes from the private repository on the
author's self-hosted Forgejo instance (151 commits including merges, 65 of them
non-merge, almost all on 2026-10-07), its 18 build issues and their pull requests, and
[decisions.md](decisions.md). Issue numbers refer to that private tracker and
are given only to show sequence.

## The problem and the first version

Several of the author's apps talked to the GoHighLevel (GHL) CRM API, each
with its own partial client and its own copy of the same lessons: GHL's
Cloudflare front rejects the default `User-Agent`, one sub-account's token must
never touch another sub-account, and writes need a deliberate switch. On
2026-10-07 the author decided on one repo for every business connector, one
npm package per connector, starting with GoHighLevel. The whole GHL library and
its MCP server were built that day.

## Timeline

All on 2026-10-07 unless noted. The work was cut into one issue per capability
and run in three waves, each wave merged through its own integration branch.

| Phase        | Issues           | What landed                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation   | #1, #2           | Project config, CI, git hooks and the decisions log. The request core was ported from an earlier private SDK to Node 24. The repo was restructured into an npm workspace, and a capability inventory of everything existing consumers already did with GHL became the build map.                                                                                                                                                                    |
| Wave 1       | #3, #4, #15, #16 | GHL's OpenAPI files pinned to one upstream commit and a generated catalog of every v2 and v3 operation, with `callOperation` for any of them; account profiles and the location guard; `User-Agent`, timeouts, dry-run plans and an error classifier; retries for 429 and 5xx with `Retry-After` and a concurrency limiter.                                                                                                                         |
| Wave 2       | #5, #17-#22      | Typed helpers for contacts, notes, opportunities and pipelines; tasks, tags, custom fields and values; locations and a one-call location audit, workflows, email templates, phone numbers; conversations and an inbound poll with a seen-store; message sending with E.164 normalisation and carrier-error and opt-out classifiers; webhook verification (Ed25519 first, legacy RSA second) with typed events; OAuth with a refreshing token store. |
| Wave 3       | #6, #23-#25      | `highlevel-mcp`, a stdio JSON-RPC MCP server with a read-only tool registry and a capability policy; a tag-triggered package publish job.                                                                                                                                                                                                                                                                                                           |
| Review fixes |                  | A fix pass across the client: error text redacted, relative paths refused, retries limited to idempotent requests, abort honoured, the CRM cursor pair used for paging, opt-out made fail-safe.                                                                                                                                                                                                                                                     |
| 2026-10-13   |                  | Public release, followed the same day by a fix that removed references to files the public release does not ship.                                                                                                                                                                                                                                                                                                                                   |

## Key design decisions

The decisions are recorded in [decisions.md](decisions.md) (D1-D10). The ones
that shaped the code most:

- **Every endpoint is reachable (D3).** Rather than hand-writing a method per
  endpoint, a generator reads GHL's published OpenAPI files at a pinned commit
  and writes a catalog. `callOperation` can call any operation in it; typed
  helpers exist only where a consumer needs them.
- **One account per client (D4).** A client is built for one account and
  refuses a request that names another account's location, in the path, the
  query or the body, before `fetch` runs.
- **Writes are opt-in (D5).** A client sends writes only when built with
  `allowWrites: true`. A later change decided read-only status for POST
  endpoints from the spec: a POST whose operation only searches, lists or gets
  is treated as a read, minus an explicit exclusion list. The PR records that
  22 POST operations became reads, including contact and opportunity search.
- **A connector is complete, not minimal (D10).** Each connector carries every
  capability its consumers already had, as generic primitives, so nothing has
  to be added back later.
- **Prove undocumented behaviour live (D8).** A contact note can link an
  opportunity through a `relations` field the published schema does not list.
  That was checked against a live account before the helper relied on it.

## How AI models and agents were used

- Each build issue was one lane for a Claude coding agent. PR bodies
  carry an agent line naming the model and the seat that ran it.
- Lanes were stacked: each wave's feature branches merged into an integration
  branch, which merged to `main` once the wave was green. This let several
  lanes build at once without merging into each other's half-finished work.
- PR bodies record that every new test was seen failing once against a
  deliberate break in the code before it was trusted.
- Pre-commit and pre-push hooks ran the full check on every lane, so no lane
  could push red work.

## How it is tested

- `npm run check` runs lint (oxlint, type-aware), the TypeScript type check
  and the tests; `format:check` runs prettier. On 2026-10-27: 271 tests in `packages/highlevel` and 19 in
  `packages/highlevel-mcp`, all passing.
- `catalog:check` fails if the generated catalog drifts from the pinned
  upstream spec.
- `scripts/checks.sh` runs shared regex checks, and CI runs a pinned gitleaks
  secret scan.
- Tests inject a recording `fetchImpl` into the client; they do not call GoHighLevel. A few
  behaviours, such as D8, were checked against a live account by hand.

## What did not work, and what changed

- **Search was blocked as a write.** GHL implements many searches as POST, so
  a read-only client could not search contacts or opportunities. The spec-based
  read decision fixed this without loosening the write switch.
- **Paging and retries needed a second pass.** The review fixes changed paging
  for contacts and opportunities to GHL's cursor pair and limited retries to
  idempotent requests, so a timed-out write is not sent twice.
- **Scope of the public release.** The private repo also built a client for
  routes of the GHL web app that are not in the published API. Those are not
  part of this release; decision D6 keeps the public library to the official
  API.

## Current state

Experimental, version 0.1.0, not published to npm. The GoHighLevel package and
its MCP server are complete for the capabilities listed in the README. More
connectors are planned for the same workspace.
