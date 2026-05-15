#!/usr/bin/env node
/**
 * @reidar80/webshelf-mcp — Model Context Protocol server for Webshelf.
 *
 * Speaks MCP over stdio. The first run launches the OAuth 2.0 device
 * flow against `WEBSHELF_BASE_URL` (default https://webshelf.app), prints
 * a one-time URL the user opens in their browser, then waits for the
 * polling exchange to succeed before serving any tool calls.
 *
 * Environment variables:
 *   WEBSHELF_BASE_URL          — defaults to https://webshelf.app
 *   WEBSHELF_CLIENT_NAME       — defaults to "MCP (<hostname>)"
 *   WEBSHELF_CREDENTIALS_FILE  — override credentials cache location
 *
 * Tools exposed to the MCP client:
 *   webshelf_whoami         — verify the session and surface identity
 *   webshelf_list_collections — list collections the caller can write to
 *   webshelf_list_files     — list files (own / by collection)
 *   webshelf_get_file       — metadata for a single file
 *   webshelf_read_file      — fetch file contents (HTML or markdown)
 *   webshelf_create_file    — upload a new HTML or markdown file
 *   webshelf_update_file    — rename / move / re-describe
 *   webshelf_delete_file    — soft-delete a file (recycle bin)
 */

import { hostname } from "node:os";
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createApiClient } from "./api.js";

const BASE_URL =
  process.env.WEBSHELF_BASE_URL?.replace(/\/$/, "") ?? "https://webshelf.app";
const CLIENT_NAME =
  process.env.WEBSHELF_CLIENT_NAME ?? `MCP (${hostname()})`;

const client = createApiClient({ baseUrl: BASE_URL, clientName: CLIENT_NAME });

const tools = [
  {
    name: "webshelf_whoami",
    description:
      "Return the email and id of the Webshelf user the MCP server is acting on behalf of. Use as a connectivity sanity check.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    handler: async () => {
      const { user } = await client.me();
      return text(
        `Signed in as ${user.email} (${user.displayName ?? "no display name"})`,
      );
    },
  },
  {
    name: "webshelf_list_collections",
    description:
      "List collections the authenticated user can see, including which workspace they belong to. Returns id, name, workspace, and protection.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    handler: async () => {
      const { collections } = await client.listCollections();
      return text(
        collections
          .map(
            (c) =>
              `${c.id}  ${JSON.stringify(c.name)}  workspace=${c.company?.slug ?? "(personal)"}  protection=${c.protection}`,
          )
          .join("\n") || "(no collections visible)",
      );
    },
  },
  {
    name: "webshelf_list_files",
    description:
      "List files. By default returns the caller's own files across all collections. Pass collectionId to list files inside a specific collection (caller must be a member). Pass personal=true to limit to standalone personal files.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        collectionId: { type: "string", format: "uuid" },
        personal: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "string", format: "date-time" },
      },
    },
    handler: async (input: unknown) => {
      const parsed = z
        .object({
          collectionId: z.string().uuid().optional(),
          personal: z.boolean().optional(),
          limit: z.number().int().min(1).max(100).optional(),
          cursor: z.string().datetime().optional(),
        })
        .parse(input ?? {});
      const { files, nextCursor } = await client.listFiles(parsed);
      const body =
        files
          .map(
            (f) =>
              `${f.id}  ${JSON.stringify(f.name)}  format=${f.format}  collection=${f.collectionId ?? "(personal)"}  ${formatBytes(f.sizeBytes)}  ${f.protection}  updated=${f.updatedAt}`,
          )
          .join("\n") || "(no files match)";
      return text(
        nextCursor ? `${body}\n\nnextCursor=${nextCursor}` : body,
      );
    },
  },
  {
    name: "webshelf_get_file",
    description:
      "Get metadata for a single file by id (no body). Use webshelf_read_file to retrieve the HTML payload.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", format: "uuid" },
      },
    },
    handler: async (input: unknown) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(input);
      const { file } = await client.getFile(id);
      return text(JSON.stringify(file, null, 2));
    },
  },
  {
    name: "webshelf_read_file",
    description:
      "Return the contents of a file by id. Returns the raw source — HTML for `format=html` files, markdown for `format=markdown` files. The response is a text block; the MCP client can save it, render it, or feed it back into a tool call.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", format: "uuid" },
      },
    },
    handler: async (input: unknown) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(input);
      const { content, name, format } = await client.getFileContent(id);
      const ext = format === "markdown" ? "md" : "html";
      return text(`Filename: ${name}.${ext}\nFormat: ${format}\n\n${content}`);
    },
  },
  {
    name: "webshelf_create_file",
    description:
      "Upload a new file. `format` may be \"html\" (default) or \"markdown\"; pass the bytes in `content`. Set collectionId to a uuid to place inside a collection (caller must be owner/manager), or null for a standalone personal file. Returns the created file's metadata.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "content"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 200 },
        description: { type: "string", maxLength: 2000 },
        collectionId: { type: ["string", "null"], format: "uuid" },
        protection: {
          type: "string",
          enum: ["public", "authenticated", "inherit", "individual"],
        },
        format: { type: "string", enum: ["html", "markdown"] },
        content: { type: "string" },
      },
    },
    handler: async (input: unknown) => {
      const parsed = z
        .object({
          name: z.string().min(1).max(200),
          description: z.string().max(2000).optional(),
          collectionId: z.string().uuid().nullable().default(null),
          protection: z
            .enum(["public", "authenticated", "inherit", "individual"])
            .optional(),
          format: z.enum(["html", "markdown"]).optional(),
          content: z.string().min(1),
        })
        .parse(input);
      const { file } = await client.createFile(parsed);
      return text(
        `Created ${file.format} file ${file.id} (${file.name}) — ${formatBytes(file.sizeBytes)}\n${BASE_URL}/app/files/${file.id}`,
      );
    },
  },
  {
    name: "webshelf_update_file",
    description:
      "Rename, re-describe, or move a file. Pass only the fields you want to change.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", format: "uuid" },
        name: { type: "string", minLength: 1, maxLength: 200 },
        description: { type: ["string", "null"], maxLength: 2000 },
        collectionId: { type: ["string", "null"], format: "uuid" },
      },
    },
    handler: async (input: unknown) => {
      const parsed = z
        .object({
          id: z.string().uuid(),
          name: z.string().min(1).max(200).optional(),
          description: z.string().max(2000).nullable().optional(),
          collectionId: z.string().uuid().nullable().optional(),
        })
        .parse(input);
      const { id, ...rest } = parsed;
      const { file } = await client.updateFile(id, rest);
      return text(`Updated file ${file.id}: ${JSON.stringify(file, null, 2)}`);
    },
  },
  {
    name: "webshelf_delete_file",
    description:
      "Soft-delete a file (moves it to the recycle bin; restorable from the web UI for 30 days).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string", format: "uuid" } },
    },
    handler: async (input: unknown) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(input);
      await client.deleteFile(id);
      return text(`Moved ${id} to recycle bin.`);
    },
  },
] as const;

const server = new Server(
  {
    name: "@reidar80/webshelf-mcp",
    version: "0.2.2",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = tools.find((t) => t.name === request.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [
        { type: "text" as const, text: `Unknown tool: ${request.params.name}` },
      ],
    };
  }
  try {
    const result = await tool.handler(request.params.arguments ?? {});
    return { content: [result] };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }
});

function text(body: string): { type: "text"; text: string } {
  return { type: "text", text: body };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

async function runCliAuthFlow(): Promise<void> {
  // Manual / interactive authorization: kick off a device flow, print
  // the verification URL to stdout, and poll until the user approves
  // (or the device_code expires). Reuses the same `ensureCredentials`
  // surface as the stdio handlers, but in a loop so the CLI can sit
  // and wait — the 4-minute MCP-host timeout doesn't apply here.
  const { ensureCredentials, DeviceFlowPendingError } = await import(
    "./auth.js"
  );

  process.stdout.write("\n┌─ Webshelf authorization ──────────────────\n");
  // Each iteration: ensureCredentials either returns creds (done) or
  // throws DeviceFlowPendingError (still waiting). We poll every 3s.
  const pollIntervalMs = 3000;
  // RFC 8628 device-code TTL ceiling; we'll give up earlier if the
  // server signals expiry via ensureCredentials throwing a non-pending
  // error and re-starting the flow.
  const deadline = Date.now() + 11 * 60 * 1000;
  let lastPrinted: string | null = null;
  while (Date.now() < deadline) {
    try {
      await ensureCredentials(BASE_URL, CLIENT_NAME);
      process.stdout.write(
        "│ Authorization complete. Token stored.\n└────────────────────────────────────────\n",
      );
      return;
    } catch (err) {
      if (err instanceof DeviceFlowPendingError) {
        if (lastPrinted !== err.verificationUriComplete) {
          process.stdout.write(`│ Open this URL in your browser:\n`);
          process.stdout.write(`│   ${err.verificationUriComplete}\n`);
          process.stdout.write(`│ Or visit ${err.verificationUri}\n`);
          process.stdout.write(`│ and enter code ${err.userCode}\n│\n`);
          process.stdout.write(`│ Waiting for approval…\n`);
          lastPrinted = err.verificationUriComplete;
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error("device code expired before user approval");
}

async function main() {
  // If a human is at the terminal (no MCP host piping stdio) and the
  // first positional arg is `auth`, or stdin is a TTY without args at
  // all, run the device flow eagerly so they can authorize from the
  // command line. Otherwise speak stdio MCP as normal.
  const arg = process.argv[2];
  const interactive =
    arg === "auth" || (!arg && process.stdin.isTTY === true);
  if (interactive) {
    await runCliAuthFlow();
    return;
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(
    `webshelf-mcp failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
