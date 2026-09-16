import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ensureDir, getStateDir, readJsonIfExists, withFileLock, writeSecureJson } from "./paths.js";

/**
 * How ChatGPT reaches this machine.
 *
 * `tunnel` was the official OpenAI Secure MCP Tunnel: the runtime API key
 * authenticated the transport and the connector used `Authentication: None`.
 * `public` exposes the gateway over a third-party tunnel (ngrok) instead, so
 * the credential moves into the app: `POST /mcp` requires a bearer token.
 *
 * This network blocks the OpenAI endpoint at the TLS SNI layer, so `tunnel`
 * cannot connect here at all; `public` is the transport that works.
 */

const publicEndpointSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** Public base URL as reported by the tunnel, e.g. https://x.ngrok-free.dev */
    baseUrl: z
      .string()
      .url()
      .refine((value) => value.startsWith("https://"), "the public endpoint must use https"),
    /** Loopback port the gateway binds; the tunnel forwards to it. */
    localPort: z.number().int().min(1).max(65_535),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type PublicEndpoint = z.infer<typeof publicEndpointSchema>;

export function publicEndpointFile(): string {
  return path.join(ensureDir(path.join(getStateDir(), "http")), "endpoint.json");
}

function readEndpoint(): PublicEndpoint | null {
  const file = publicEndpointFile();
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("public endpoint state must be a regular file");
  }
  const parsed = publicEndpointSchema.safeParse(readJsonIfExists<unknown>(file));
  if (!parsed.success) throw new Error("public endpoint state is invalid");
  return parsed.data;
}

export function publicEndpointStatus(): PublicEndpoint | null {
  return readEndpoint();
}

export function setPublicEndpoint(input: { baseUrl: string; localPort: number }): PublicEndpoint {
  const file = publicEndpointFile();
  return withFileLock(path.join(path.dirname(file), "endpoint.lock"), () => {
    const next = publicEndpointSchema.parse({
      schemaVersion: 1,
      baseUrl: input.baseUrl.replace(/\/+$/, ""),
      localPort: input.localPort,
      updatedAt: new Date().toISOString(),
    });
    writeSecureJson(file, next);
    return next;
  });
}

export function clearPublicEndpoint(): void {
  fs.rmSync(publicEndpointFile(), { force: true });
}

/** The MCP URL a ChatGPT connector should be pointed at. */
export function publicMcpUrl(endpoint: PublicEndpoint | null): string | null {
  return endpoint ? `${endpoint.baseUrl}/mcp` : null;
}
