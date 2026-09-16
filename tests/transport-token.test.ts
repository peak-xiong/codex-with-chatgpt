import { afterEach, describe, expect, it } from "vitest";
import {
  bearerTokenFromHeader,
  presentedTransportToken,
  transportTokenFromPath,
  urlTransportTokenEnabled,
} from "../src/gateway/transport-token.js";

const TOKEN = `c2c_mcp_${"a".repeat(43)}`;

afterEach(() => {
  delete process.env.C2C_DISABLE_URL_TOKEN;
});

describe("transport token channels", () => {
  it("reads a bearer header case-insensitively and ignores other schemes", () => {
    expect(bearerTokenFromHeader(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(bearerTokenFromHeader(`bearer ${TOKEN}`)).toBe(TOKEN);
    expect(bearerTokenFromHeader(`BEARER   ${TOKEN}  `)).toBe(TOKEN);
    expect(bearerTokenFromHeader(`Basic ${TOKEN}`)).toBeNull();
    expect(bearerTokenFromHeader(undefined)).toBeNull();
    expect(bearerTokenFromHeader("")).toBeNull();
  });

  it("reads exactly one extra path segment after /mcp", () => {
    expect(transportTokenFromPath(`/mcp/${TOKEN}`)).toBe(TOKEN);
    expect(transportTokenFromPath("/mcp")).toBeNull();
    expect(transportTokenFromPath("/mcp/")).toBeNull();
    expect(transportTokenFromPath(`/mcp/${TOKEN}/extra`)).toBeNull();
    expect(transportTokenFromPath(`/mcpx/${TOKEN}`)).toBeNull();
    expect(transportTokenFromPath(`/admin/${TOKEN}`)).toBeNull();
  });

  it("does not decode percent-escapes, so an encoded value cannot pass as a token", () => {
    expect(transportTokenFromPath("/mcp/c2c_mcp_%61%61")).toBe("c2c_mcp_%61%61");
  });

  it("prefers the Authorization header over the URL", () => {
    expect(presentedTransportToken({ authorizationHeader: `Bearer ${TOKEN}`, pathname: "/mcp" })).toEqual({
      source: "authorization-header",
      token: TOKEN,
    });
    expect(
      presentedTransportToken({ authorizationHeader: `Bearer ${TOKEN}`, pathname: "/mcp/other" })
    ).toEqual({ source: "authorization-header", token: TOKEN });
  });

  it("lets a present-but-wrong header fail instead of falling back to a valid URL token", () => {
    expect(
      presentedTransportToken({ authorizationHeader: "Bearer stale", pathname: `/mcp/${TOKEN}` })
    ).toEqual({ source: "authorization-header", token: "stale" });
    expect(
      presentedTransportToken({ authorizationHeader: "Basic abc", pathname: `/mcp/${TOKEN}` })
    ).toEqual({ source: "authorization-header", token: null });
  });

  it("resolves URL channels in order when no header is present", () => {
    expect(presentedTransportToken({ pathname: `/mcp/${TOKEN}` })).toEqual({
      source: "url-path",
      token: TOKEN,
    });
    expect(presentedTransportToken({ pathname: "/mcp", queryToken: TOKEN })).toEqual({
      source: "url-query",
      token: TOKEN,
    });
    expect(presentedTransportToken({ pathname: `/mcp/${TOKEN}`, queryToken: "other" })).toEqual({
      source: "url-path",
      token: TOKEN,
    });
  });

  it("reports no token for an untokened, malformed, or empty request", () => {
    expect(presentedTransportToken({ pathname: "/mcp" })).toEqual({ source: "none", token: null });
    expect(presentedTransportToken({ pathname: "/mcp", queryToken: "" })).toEqual({
      source: "none",
      token: null,
    });
    // A repeated query parameter arrives as an array, which is not a token.
    expect(presentedTransportToken({ pathname: "/mcp", queryToken: [TOKEN, TOKEN] })).toEqual({
      source: "none",
      token: null,
    });
    expect(presentedTransportToken({ authorizationHeader: "   ", pathname: "/mcp" })).toEqual({
      source: "none",
      token: null,
    });
  });

  it("can be restricted to the header-only contract", () => {
    process.env.C2C_DISABLE_URL_TOKEN = "1";
    expect(urlTransportTokenEnabled()).toBe(false);
    expect(presentedTransportToken({ pathname: `/mcp/${TOKEN}` })).toEqual({ source: "none", token: null });
    expect(presentedTransportToken({ pathname: "/mcp", queryToken: TOKEN })).toEqual({
      source: "none",
      token: null,
    });
    // The header keeps working, so a client that can send one is unaffected.
    expect(presentedTransportToken({ authorizationHeader: `Bearer ${TOKEN}`, pathname: "/mcp" })).toEqual({
      source: "authorization-header",
      token: TOKEN,
    });
  });
});
