/**
 * Where a request's transport token came from.
 *
 * The endpoint was built around `Authorization: Bearer <token>`, which is the
 * only channel an ordinary MCP client needs. ChatGPT is not one of those: its
 * app creation form offers `OAuth` / `No authentication` / `Mixed` and no field
 * for a static token, and OpenAI's Apps SDK documentation is explicit that
 * ChatGPT "cannot present custom API keys". OAuth is not an option here either,
 * because this gateway deliberately runs no authorization server, so a URL
 * channel is what makes `No authentication` usable at all.
 *
 * Accepting a secret in the URL is a real downgrade — URLs are written by the
 * tunnel provider and by every hop in front of it — so this module keeps the
 * header authoritative, lets an operator disable the URL channels entirely, and
 * leaves the trade-off documented in `docs/security.md` rather than pretending
 * the channels are equivalent.
 */

const BEARER_PREFIX = "bearer ";
const URL_TOKEN_PARAMETER = "token";

/** The one path that serves MCP over the public tunnel. */
export const MCP_PATH = "/mcp";

export type TransportTokenSource = "authorization-header" | "url-path" | "url-query" | "none";

export interface PresentedTransportToken {
  /** Which channel carried a token, or `none`. Never the token itself. */
  source: TransportTokenSource;
  /** The candidate to verify, or null when the caller presented none. */
  token: string | null;
}

export interface TransportTokenCandidates {
  /** Raw `Authorization` header as the HTTP layer produced it. */
  authorizationHeader?: string | undefined;
  /** Request path exactly as received, e.g. `/mcp/c2c_mcp_…`. */
  pathname: string;
  /** Parsed value of the `token` query parameter, when the framework surfaced it. */
  queryToken?: unknown;
}

/** The name of the supported query parameter, for help text and diagnostics. */
export const TRANSPORT_TOKEN_QUERY_PARAMETER = URL_TOKEN_PARAMETER;

/** Extract the value of an `Authorization: Bearer …` header. */
export function bearerTokenFromHeader(header: string | undefined): string | null {
  const value = header ?? "";
  return value.toLowerCase().startsWith(BEARER_PREFIX) ? value.slice(BEARER_PREFIX.length).trim() : null;
}

/**
 * Read a token from the path: `/mcp/<token>`. Exactly one extra segment counts —
 * `/mcp/a/b` is not a token form and is left alone. Percent-encoding is
 * deliberately not decoded: the token alphabet is URL-safe, so an encoded value
 * can only be an attempt to smuggle something past the format check.
 */
export function transportTokenFromPath(pathname: string): string | null {
  if (!pathname.startsWith(`${MCP_PATH}/`)) return null;
  const segment = pathname.slice(MCP_PATH.length + 1);
  if (segment.length === 0 || segment.includes("/")) return null;
  return segment;
}

/**
 * True while the URL channels are enabled. A client that can send a header has
 * no reason to use them, so `C2C_DISABLE_URL_TOKEN=1` restores the
 * header-only contract; the connector then needs the tunnel to inject the
 * header instead.
 */
export function urlTransportTokenEnabled(): boolean {
  return process.env.C2C_DISABLE_URL_TOKEN !== "1";
}

/**
 * Resolve the token a caller presented, in precedence order.
 *
 * A non-empty `Authorization` header decides alone, even when it is malformed
 * and a perfectly good token sits in the URL. Letting the gateway fall back
 * would mean two credentials disagree about who is calling, and "was this
 * request rejected, and on which credential" would stop being answerable during
 * a rotation or an incident.
 */
export function presentedTransportToken(candidates: TransportTokenCandidates): PresentedTransportToken {
  if (candidates.authorizationHeader?.trim()) {
    return { source: "authorization-header", token: bearerTokenFromHeader(candidates.authorizationHeader) };
  }
  if (!urlTransportTokenEnabled()) return { source: "none", token: null };

  const fromPath = transportTokenFromPath(candidates.pathname);
  if (fromPath !== null) return { source: "url-path", token: fromPath };

  if (typeof candidates.queryToken === "string" && candidates.queryToken.length > 0) {
    return { source: "url-query", token: candidates.queryToken };
  }
  return { source: "none", token: null };
}
