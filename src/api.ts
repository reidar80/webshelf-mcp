/**
 * Thin typed client around Webshelf's `/api/v1/*` surface.
 *
 * Owns the auth lifecycle: pulls credentials from auth.ts, attaches the
 * Bearer header, refreshes on 401, retries once. Beyond that, the wire
 * format matches the OpenAPI spec exactly — no client-side renaming.
 *
 * Credentials are resolved lazily — on the first request, not at module
 * load — so that a missing or pending device flow surfaces as a tool
 * error (DeviceFlowPendingError carries the URL the user must visit),
 * never as a four-minute hang while the MCP host waits for the stdio
 * server to respond.
 */

import { ensureCredentials, forceRefresh } from "./auth.js";

export interface ApiFile {
  id: string;
  name: string;
  description: string | null;
  collectionId: string | null;
  ownerId: string;
  protection: "public" | "authenticated" | "inherit" | "individual";
  format: "html" | "markdown";
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ApiCollection {
  id: string;
  name: string;
  ownerId: string;
  companyId: string | null;
  company: { id: string; name: string; slug: string } | null;
  protection: "private" | "public";
  createdAt: string;
}

export interface ApiClient {
  me(): Promise<{ user: { id: string; email: string; displayName: string | null } }>;
  listFiles(params?: {
    collectionId?: string;
    personal?: boolean;
    limit?: number;
    cursor?: string;
  }): Promise<{ files: ApiFile[]; nextCursor: string | null }>;
  getFile(id: string): Promise<{ file: ApiFile }>;
  getFileContent(
    id: string,
  ): Promise<{ name: string; content: string; format: ApiFile["format"] }>;
  createFile(input: {
    name: string;
    description?: string | null;
    collectionId: string | null;
    protection?: ApiFile["protection"];
    format?: ApiFile["format"];
    content: string;
  }): Promise<{ file: ApiFile }>;
  updateFile(
    id: string,
    input: {
      name?: string;
      description?: string | null;
      collectionId?: string | null;
    },
  ): Promise<{ file: ApiFile }>;
  deleteFile(id: string): Promise<{ deleted: boolean }>;
  listCollections(): Promise<{ collections: ApiCollection[] }>;
}

export function createApiClient(options: {
  baseUrl: string;
  clientName: string;
}): ApiClient {
  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    // Lazy — only kicks the device flow when a tool actually needs the
    // API. Missing/pending credentials surface as DeviceFlowPendingError
    // (handled by the MCP server wrapper), not a hung Promise.
    let creds = await ensureCredentials(options.baseUrl, options.clientName);
    let res = await fetch(`${creds.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${creds.accessToken}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401) {
      // Stale access token; refresh and retry once.
      creds = await forceRefresh(creds);
      res = await fetch(`${creds.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${creds.accessToken}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status} ${method} ${path}: ${text}`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return (await res.json()) as T;
    }
    return (await res.text()) as unknown as T;
  }

  return {
    me: () => request("GET", "/api/v1/me"),
    listFiles: (params = {}) => {
      const search = new URLSearchParams();
      if (params.collectionId) search.set("collectionId", params.collectionId);
      if (params.personal) search.set("personal", "true");
      if (params.limit) search.set("limit", String(params.limit));
      if (params.cursor) search.set("cursor", params.cursor);
      const qs = search.toString();
      return request("GET", `/api/v1/files${qs ? `?${qs}` : ""}`);
    },
    getFile: (id) => request("GET", `/api/v1/files/${id}`),
    getFileContent: async (id) => {
      const json = await request<{
        contentBase64: string;
        contentType: string;
        sizeBytes: number;
        name: string;
        format: ApiFile["format"];
      }>("GET", `/api/v1/files/${id}/content?as=base64`);
      const content = Buffer.from(json.contentBase64, "base64").toString("utf8");
      return { name: json.name, content, format: json.format };
    },
    createFile: (input) => request("POST", "/api/v1/files", input),
    updateFile: (id, input) => request("PATCH", `/api/v1/files/${id}`, input),
    deleteFile: (id) => request("DELETE", `/api/v1/files/${id}`),
    listCollections: () => request("GET", "/api/v1/collections"),
  };
}
