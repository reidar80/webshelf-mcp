# @reidar80/webshelf-mcp

Model Context Protocol server for [Webshelf](https://webshelf.app). Lets
any MCP-aware client (Claude Desktop, Claude Code, Cursor, Continue, etc.)
list, read, upload and manage HTML and markdown files on your Webshelf
account.

## Associated repository

The Webshelf web app — the host this MCP server talks to — lives in
[`reidar80/webshelf`](https://github.com/reidar80/webshelf). That repo
owns the database schema, the Next.js app, and the `/api/v1/*` HTTP
surface this client wraps. The authoritative API contract is published
there as [`openapi/webshelf.yaml`](https://github.com/reidar80/webshelf/blob/main/openapi/webshelf.yaml);
keep `src/api.ts` and `src/index.ts` here in sync with it.

## Install

The package runs as a one-off via `npx`, so most users don't install it
globally:

```bash
npx -y @reidar80/webshelf-mcp
```

Or pin a version in your MCP client config (preferred for stability).

## Use Webshelf from Claude

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows) and
add:

```json
{
  "mcpServers": {
    "webshelf": {
      "command": "npx",
      "args": ["-y", "@reidar80/webshelf-mcp"]
    }
  }
}
```

Restart Claude. The first launch prints a one-time
`https://webshelf.app/app/device` URL + `user_code` to stderr — open it
in your browser, sign in to Webshelf, and approve the connection.
Credentials persist in `~/.webshelf/credentials.json` (mode 0600);
access tokens refresh automatically.

### Claude Code

```bash
claude mcp add webshelf -- npx -y @reidar80/webshelf-mcp
```

Then run `claude` as usual — the same device-flow approval happens on
the first MCP call.

### Other clients

Anything that runs MCP servers over stdio works the same way. Point it
at `npx -y @reidar80/webshelf-mcp`.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `WEBSHELF_BASE_URL` | `https://webshelf.app` | Override for staging / self-hosted instances. |
| `WEBSHELF_CLIENT_NAME` | `MCP (<hostname>)` | Label that shows up on your "API sessions" page. |
| `WEBSHELF_CREDENTIALS_FILE` | `~/.webshelf/credentials.json` | Where the OAuth tokens are cached. |

## Tools

| Tool | What it does |
|------|--------------|
| `webshelf_whoami` | Identity sanity check. |
| `webshelf_list_collections` | List collections you can upload into. |
| `webshelf_list_files` | List your files (or files in a collection). |
| `webshelf_get_file` | Metadata for a single file. |
| `webshelf_read_file` | Fetch the body of a file (HTML or markdown). |
| `webshelf_create_file` | Upload a new HTML or markdown file. |
| `webshelf_update_file` | Rename, re-describe, or move a file. |
| `webshelf_delete_file` | Move a file to the recycle bin. |

## How auth works

On first launch the server runs the OAuth 2.0 device-authorization
grant (RFC 8628):

1. It calls `POST /api/oauth/device` to get a one-time `user_code`.
2. It prints the verification URL + code to stderr.
3. You open the URL in your browser, sign in to Webshelf, and approve
   the connection.
4. The server polls `POST /api/oauth/token` until the approval comes
   through, then caches the resulting `access_token` + `refresh_token`
   in `~/.webshelf/credentials.json` (mode 0600).

The access token has a 1-hour TTL and refreshes automatically. To
revoke a session, visit **Settings → API sessions** on webshelf.app and
hit "Revoke" on the matching row.

## Permissions

The MCP server inherits the signed-in user's permissions exactly — it
cannot read or write any file the user couldn't read or write from the
browser. There's no separate API-level role.

## Development

```bash
npm install
npm run typecheck    # tsc --noEmit
npm run build        # tsc → dist/
npm start            # node dist/index.js (runs the device flow)
```

The HTTP surface this client wraps is documented in
[`openapi/webshelf.yaml`](https://github.com/reidar80/webshelf/blob/main/openapi/webshelf.yaml)
in the Webshelf web-app repo. Any change to a request/response shape
there needs a matching update in `src/api.ts` and `src/index.ts` here,
followed by a `version` bump in `package.json` so the next push to
`main` publishes a new npm release.

## Reporting issues

Open an issue at https://github.com/reidar80/webshelf-mcp/issues.
Include the MCP client name + version, the tool you were calling, and
the full error message (with any token values redacted).
