import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ensureDir, getStateDir, readJsonIfExists, withFileLock, writeSecureJson } from "./paths.js";

/**
 * Bearer token that guards the HTTP MCP endpoint.
 *
 * The official Secure MCP Tunnel used to authenticate the transport, which is
 * why the ChatGPT connector could be configured with `Authentication: None`.
 * A public tunnel (ngrok) removes that guarantee, so the endpoint needs its own
 * credential before it is reachable from the internet.
 *
 * This is a transport gate only. It does not replace C2C's turn capabilities:
 * a caller that passes this check still needs a valid `context_id` issued by
 * `control open` before any tool will act on a workspace.
 */

const TOKEN_PREFIX = "c2c_mcp_";
const TOKEN_BYTES = 32;

const tokenSchema = z.string().regex(/^c2c_mcp_[A-Za-z0-9_-]{43}$/);

const authFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    token: tokenSchema,
    createdAt: z.string().datetime(),
    rotatedAt: z.string().datetime().optional(),
  })
  .strict();

export type HttpAuthState = z.infer<typeof authFileSchema>;

export class HttpAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpAuthError";
  }
}

function authDirectory(): string {
  return path.join(getStateDir(), "http");
}

export function httpAuthFile(): string {
  return path.join(authDirectory(), "auth.json");
}

function newToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
}

function readAuthFile(): HttpAuthState | null {
  const file = httpAuthFile();
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new HttpAuthError("HTTP auth state must be a regular file");
  }
  const parsed = authFileSchema.safeParse(readJsonIfExists<unknown>(file));
  if (!parsed.success) throw new HttpAuthError("HTTP auth state is invalid");
  return parsed.data;
}

/**
 * Read the token, generating one on first use. The token is created lazily so
 * an existing installation keeps working without a migration step.
 */
export function requireHttpAuthToken(): HttpAuthState {
  const existing = readAuthFile();
  if (existing) return existing;
  return rotateHttpAuthToken();
}

/** Issue a fresh token, invalidating the previous one. */
export function rotateHttpAuthToken(): HttpAuthState {
  const directory = ensureDir(authDirectory());
  const lockFile = path.join(directory, "auth.lock");
  return withFileLock(lockFile, () => {
    const previous = readAuthFile();
    const now = new Date().toISOString();
    const next = authFileSchema.parse({
      schemaVersion: 1,
      token: newToken(),
      createdAt: previous?.createdAt ?? now,
      ...(previous ? { rotatedAt: now } : {}),
    });
    writeSecureJson(httpAuthFile(), next);
    return next;
  });
}

/** Status view that never leaks the token itself. */
export interface HttpAuthStatus {
  configured: boolean;
  createdAt: string | null;
  rotatedAt: string | null;
  tokenHint: string | null;
}

export function httpAuthStatus(): HttpAuthStatus {
  const state = readAuthFile();
  if (!state) return { configured: false, createdAt: null, rotatedAt: null, tokenHint: null };
  return {
    configured: true,
    createdAt: state.createdAt,
    rotatedAt: state.rotatedAt ?? null,
    // Enough to distinguish two tokens, not enough to use one.
    tokenHint: `${state.token.slice(0, TOKEN_PREFIX.length + 4)}…${state.token.slice(-4)}`,
  };
}

/**
 * Constant-time comparison of a presented token against the stored one.
 * Returns false rather than throwing so callers can answer 401 uniformly.
 */
export function verifyHttpAuthToken(presented: string | null | undefined): boolean {
  if (typeof presented !== "string" || !tokenSchema.safeParse(presented).success) return false;
  const state = readAuthFile();
  if (!state) return false;
  const expected = Buffer.from(state.token, "utf8");
  const actual = Buffer.from(presented, "utf8");
  if (expected.length !== actual.length) return false;
  try {
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
