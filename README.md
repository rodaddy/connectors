# connectors

A TypeScript npm workspace of business API connectors, one package per
service. Today it holds one connector, GoHighLevel (GHL), plus a read-only MCP
server on top of it.

| Package                                                        | What it is                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------ |
| `packages/highlevel` (`@rodaddy/connectors-highlevel`)         | A GoHighLevel API client                                     |
| `packages/highlevel-mcp` (`@rodaddy/connectors-highlevel-mcp`) | A stdio MCP server exposing allowlisted, read-only GHL tools |

## Why it exists

Several of the author's apps talked to GoHighLevel, each with its own partial
client and its own copy of the same lessons. This repo is the one place those
lessons live (`docs/decisions.md`). It is published as a reference for anyone
building on the GHL API.

## GoHighLevel client (`packages/highlevel`)

- **Every official endpoint.** The GHL v2/v3 REST API with a Private
  Integration token. Every operation in the official API is reachable through
  a catalog generated from GHL's published OpenAPI files, pinned to one
  upstream commit; typed helpers cover contacts, opportunities, pipelines,
  notes, tags, tasks, custom fields, conversations, workflows, emails,
  locations and phone numbers.
- **Account guard.** A client is built for one account and refuses any request
  that names another known account's location. Tokens are passed in by the
  caller and never stored. Edit `src/accounts.ts` to list your own locations;
  the ids shipped there are placeholders.
- **Writes are opt-in.** A client sends writes only when built with
  `allowWrites: true`.
- **Webhooks.** Signature verification, a replay store, and typed event names
  generated from the published webhook schemas.
- Retries with backoff, typed errors, and an OAuth helper with a pluggable
  token store.

## MCP server (`packages/highlevel-mcp`)

JSON-RPC over stdio. Configure it with `GHL_MCP_ACCOUNT` (an account name from
`src/accounts.ts`), and exactly one of `GHL_MCP_TOKEN` or `GHL_MCP_TOKEN_FILE`.
Only the `read` capability is accepted today; write tools are refused at boot
rather than silently ignored.

```sh
npm ci
GHL_MCP_ACCOUNT=primary GHL_MCP_TOKEN_FILE=$HOME/.config/ghl/token \
  npm start -w @rodaddy/connectors-highlevel-mcp
```

## Develop

```sh
npm ci
npm run hooks:install   # optional: pre-commit lint/format/typecheck, pre-push tests
npm run check           # lint, typecheck, tests, every package
npm run build           # dist/ in each package
```

Node 24 (native type stripping), npm workspaces, `node:test`. Tests use fake
fetch functions; none call GoHighLevel.

`npm run catalog:check -w @rodaddy/connectors-highlevel` regenerates the GHL
catalogs from the pinned upstream and fails on drift. It is manual, not in
`npm run check`: run `catalog:fetch` first (it clones the upstream docs repo
under the OS temp dir; `HIGHLEVEL_UPSTREAM_ROOT` overrides where).

## Status

In progress, version 0.1.0. A few behaviors were checked against live GHL
accounts (for example decision D8), and the ported helpers carry over logic
from earlier tooling that ran against live accounts. Most of the catalog's
operations have never been called from here, and nothing in this repo has run
for anyone but the author. The packages are not published to npm.

## What it does not do

- It does not store, fetch, or rotate credentials.
- It is not an official GoHighLevel SDK and is not affiliated with HighLevel.
- The MCP server does not expose writes.

## License

MIT (see `LICENSE`). The generated GHL catalogs derive from GoHighLevel's
CC0-licensed API docs; see `NOTICE`.
