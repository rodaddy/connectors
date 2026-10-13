# Decisions

The design decisions behind this repo, as they were made (2026-10-07). It
started as a single GoHighLevel library and became a workspace for every
connector (D9). A change is a new dated entry that names the one it replaces.

- **D1: one common GoHighLevel library, in its own repo.** Every app that talks
  to GoHighLevel uses this library. No consumer grows its own GHL client.
- **D2: built from what already exists.** The base was an earlier private SDK
  (the request core, the official-endpoint catalog and its generator),
  extended with lessons from earlier
  Python tooling: a non-default `User-Agent`, which GHL's Cloudflare front
  needs, and the rule that one account's token never touches another account.
- **D3: every endpoint is reachable.** Every operation in the official v2 API
  is callable through the catalog-driven client, pinned to a commit of
  [GoHighLevel/highlevel-api-docs](https://github.com/GoHighLevel/highlevel-api-docs).
  Typed helpers exist for what consumers use. Only the official, published
  API is covered; undocumented web-app routes are out of scope.
- **D4: credentials are never stored here.** A caller passes the token. An
  account profile (`src/accounts.ts`) names the location each account owns,
  and the client refuses a location that does not match the account it was
  built for. The profiles shipped here are placeholders.
- **D5: writes are opt-in.** A client only sends a write when it was built with
  `allowWrites: true`.
- **D6: no undocumented web-app endpoints.** This repo ships only the official
  API. Routes of the authenticated GHL web app are not included.
- **D7: distribution.** Built JS plus type declarations (`npm run build`).
- **D8 (proven live 2026-10-07): a contact note can link an opportunity.**
  `relations: [{ objectKey: "opportunity", recordId }]` on
  `POST/PUT /contacts/{contactId}/notes` is stored and returned, although the
  published schema does not list it.
- **D9: one repo for every connector.** Connectors (GoHighLevel first; others
  later) live in one npm workspace, one package per connector under
  `packages/`. The GoHighLevel library of D1 is `packages/highlevel`.
- **D10: a connector is complete, not minimal.** Each connector carries every
  capability its consumers already had for that service, as generic
  primitives, so nothing has to be added back later. Business-specific uses
  stay in their own repos, built on these primitives.
