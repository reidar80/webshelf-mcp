# CLAUDE.md

Guidance for Claude Code when working in this repository. Keep edits
here targeted — this file is for things that aren't obvious from a quick
`ls`, not a re-statement of the README.

## What this repo is

`@reidar80/webshelf-mcp` — a stdio Model Context Protocol server that
wraps the Bearer-authed `/api/v1/*` HTTP surface of
[Webshelf](https://webshelf.app). Published to npm under the `reidar80`
org. MCP-aware clients (Claude Desktop, Claude Code, Cursor, Continue,
…) launch it via `npx -y @reidar80/webshelf-mcp` and call its tools to
list/read/upload/manage Webshelf files.

## Associated repository

The Webshelf web app — Next.js + Supabase, owner of the DB schema and
the `/api/v1/*` routes this server talks to — lives in
**[`reidar80/webshelf`](https://github.com/reidar80/webshelf)**. The
authoritative API contract is `openapi/webshelf.yaml` in that repo.
Tool signatures and the typed client in `src/api.ts` here must stay
in sync with it; any wire-shape change there demands a matching change
+ version bump here.

## Stack

- **TypeScript** strict, ESM, target `ES2022`
- **`@modelcontextprotocol/sdk`** for the stdio MCP server + handler
  plumbing
- **`zod`** for input validation at the tool boundary
- **Node ≥20** (matches `engines.node` and the publish workflow)
- Package manager: **npm** (lockfile committed)
- No bundler: `tsc` emits plain ESM into `dist/`; the published tarball
  ships `dist/` + `README.md` only

## Repository layout

```
src/
  index.ts      Tool registry + stdio MCP server (entry point).
                Defines webshelf_whoami, webshelf_list_collections,
                webshelf_list_files, webshelf_get_file,
                webshelf_read_file, webshelf_create_file,
                webshelf_update_file, webshelf_delete_file.
                Each tool has an inputSchema (JSON Schema for the MCP
                client) AND a zod parser (defence in depth at the
                handler boundary).
  api.ts        Thin typed client around /api/v1/*. Owns the auth
                lifecycle: pulls credentials from auth.ts, attaches
                the Bearer header, refreshes on 401, retries once.
                The wire format matches openapi/webshelf.yaml in the
                webshelf repo verbatim — no client-side renaming.
  auth.ts       OAuth 2.0 device-authorization (RFC 8628) flow.
                Reads/writes ~/.webshelf/credentials.json (mode 0600,
                overridable via WEBSHELF_CREDENTIALS_FILE). Refreshes
                automatically when access token is within 60s of
                expiry, or when api.ts forces a refresh on 401.
tsconfig.json   target ES2022, module ES2022, outDir dist, strict on.
package.json    bin: webshelf-mcp → dist/index.js. Only dist/ + README
                are in the published `files` whitelist.
.github/workflows/
  ci.yml        typecheck on every push / PR.
  publish.yml   On push to main: typecheck → build → publish to npm if
                package.json version isn't already on the registry.
```

There is **no test suite yet**. Type correctness + the upstream API
contract are the safety net. If you change a tool's behaviour, exercise
it through a real MCP client against a staging Webshelf instance.

## Auth flow

1. First launch: no `~/.webshelf/credentials.json` → `ensureCredentials`
   runs `runDeviceFlow`, which `POST`s to `/api/oauth/device`, prints
   the verification URL + `user_code` to stderr, then polls
   `/api/oauth/token` until approval (or denial / expiry).
2. Successful approval persists `accessToken`, `refreshToken`,
   `accessExpiresAtMs`, `refreshExpiresAtMs`, and `baseUrl` to the
   credentials file with mode 0600.
3. Every `request()` in `api.ts` checks expiry; within 60s of expiry it
   calls `refreshAccessToken`. On 401 it forces a refresh and retries
   once. Refresh tokens are single-use and rotated on every exchange.
4. Revocation happens server-side at `/app/settings/tokens`; the next
   refresh will fail and the user is told to re-run the device flow.

`baseUrl` is captured in the credentials file so switching
`WEBSHELF_BASE_URL` (e.g. between prod and staging) triggers a fresh
device flow instead of replaying tokens against the wrong host.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `WEBSHELF_BASE_URL` | `https://webshelf.app` | Override for staging / self-hosted instances. Trailing slash is stripped. |
| `WEBSHELF_CLIENT_NAME` | `MCP (<hostname>)` | Label that shows up on `/app/settings/tokens`. |
| `WEBSHELF_CREDENTIALS_FILE` | `~/.webshelf/credentials.json` | Override the cache location (handy for multi-account setups). |

## Conventions

- **Tool signatures live in two places** — the JSON Schema in
  `inputSchema` (what the MCP client sees) and a `zod` parser inside
  the handler. Keep them aligned; the zod parse is the actual
  enforcement.
- **Errors thrown from a handler are caught in `index.ts`** and turned
  into `{ isError: true, content: [{ type: "text", text: msg }] }`.
  Don't wrap with custom error classes — `Error` with a useful message
  is enough.
- **Stderr is the log channel.** stdout belongs to the MCP transport.
  Anything printed to stdout corrupts the protocol; the device-flow
  prompts and any future diagnostics must use stderr.
- **No telemetry, no analytics.** This server runs on user machines;
  it must not phone home anywhere other than `WEBSHELF_BASE_URL`.
- **Bare tokens stay in `auth.ts` + the credentials file.** They're
  returned to `api.ts` only via the `Credentials` object's
  `accessToken` field. Never log them, never include them in error
  messages, never embed them in URLs.
- **No new external deps without a real reason.** The package
  intentionally has a tiny dep surface (MCP SDK + zod). Anything else
  has to justify itself — every dep is a supply-chain risk for users
  who `npx` this.
- **Editing existing files beats creating new ones.** No new `.md`
  files beyond this one and the README unless the user asks.

## Commands

```bash
npm install              # install deps (often absent in Claude sessions)
npm run typecheck        # tsc --noEmit
npm run build            # tsc → dist/
npm start                # node dist/index.js (runs the device flow over stdio)
```

`node_modules` is usually absent in Claude Code sessions, so
`npm run typecheck` and `npm run build` will fail with "Cannot find
module" errors for `@modelcontextprotocol/sdk`, `zod`, etc. That's
expected. Trust type correctness from inspection and rely on CI to do
the real typecheck. Only run `npm install` if the user explicitly asks
or the task genuinely requires executing code.

## Publish workflow

`.github/workflows/publish.yml` runs on every push to `main`. It
typechecks, builds, and then consults `npm view` — if the version in
`package.json` is already on the registry the step is a no-op,
otherwise it `npm publish`es with public access.

- **Bump `package.json` `version`** whenever the MCP surface (tools,
  env vars, behaviour, error shapes) changes. SemVer applies: tool
  additions are minor, breaking changes to existing tool inputs/outputs
  are major.
- **Repo secret `NPM_TOKEN`** must hold an automation token with
  publish rights on the `reidar80` npm org
  (https://www.npmjs.com/settings/reidar80/). **The current token
  expires 2026-07-14** (60 days from 2026-05-15, minus the 10-minute
  buffer noted on the secret). Rotate before that date or pushes to
  `main` will start failing the publish step.
- **`--provenance` is intentionally omitted** while the source repo is
  private — sigstore refuses to mint an attestation pointing at a
  private GitHub repo. Add `--provenance` and `id-token: write` back
  in the workflow when the repo goes public.
- **Branch guard:** `if: github.ref == 'refs/heads/main'` so a stale
  feature branch can't ship via `workflow_dispatch`.

## When you're stuck

- "Where is X declared on the server side?" → it's the `reidar80/webshelf`
  repo, not this one. Check `openapi/webshelf.yaml` there for the wire
  contract before guessing.
- "Tool fails with 401 over and over" → refresh-token rotation may
  have desynced (e.g. two MCP processes sharing one credentials file).
  Delete `~/.webshelf/credentials.json` and re-run the device flow.
- "Why does `npm run typecheck` fail locally?" → `node_modules`
  probably isn't installed in this session. Not your bug.
