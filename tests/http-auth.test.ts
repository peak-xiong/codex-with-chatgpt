import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  httpAuthFile,
  httpAuthStatus,
  requireHttpAuthToken,
  rotateHttpAuthToken,
  verifyHttpAuthToken,
} from "../src/config/http-auth.js";
import { cleanup, isolateStateDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach(cleanup);
  delete process.env.C2C_STATE_DIR;
});

describe("HTTP bearer token", () => {
  it("generates a token on first use and reuses it afterwards", () => {
    dirs.push(isolateStateDir());

    const first = requireHttpAuthToken();
    const second = requireHttpAuthToken();

    expect(first.token).toMatch(/^c2c_mcp_[A-Za-z0-9_-]{43}$/);
    expect(second.token).toBe(first.token);
    expect(verifyHttpAuthToken(first.token)).toBe(true);
  });

  it("stores the token owner-only", () => {
    dirs.push(isolateStateDir());
    requireHttpAuthToken();

    if (process.platform !== "win32") {
      expect(fs.statSync(httpAuthFile()).mode & 0o777).toBe(0o600);
    }
    expect(httpAuthStatus().permissionsSafe).toBe(true);
  });

  it("invalidates the previous token on rotation", () => {
    dirs.push(isolateStateDir());
    const first = requireHttpAuthToken();
    const rotated = rotateHttpAuthToken();

    expect(rotated.token).not.toBe(first.token);
    expect(verifyHttpAuthToken(rotated.token)).toBe(true);
    // The old value must stop working immediately.
    expect(verifyHttpAuthToken(first.token)).toBe(false);
    expect(httpAuthStatus().rotatedAt).not.toBeNull();
  });

  it("rejects malformed, empty, and absent tokens", () => {
    dirs.push(isolateStateDir());
    const { token } = requireHttpAuthToken();

    expect(verifyHttpAuthToken(null)).toBe(false);
    expect(verifyHttpAuthToken(undefined)).toBe(false);
    expect(verifyHttpAuthToken("")).toBe(false);
    expect(verifyHttpAuthToken("c2c_mcp_short")).toBe(false);
    // Same length, different value.
    const counterfeit = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    expect(verifyHttpAuthToken(counterfeit)).toBe(false);
  });

  it("never exposes the token in its status view", () => {
    dirs.push(isolateStateDir());
    const { token } = requireHttpAuthToken();
    const status = httpAuthStatus();

    expect(status.configured).toBe(true);
    expect(status.tokenHint).not.toBe(token);
    // The hint must be a strict prefix/suffix abbreviation, not the whole value.
    expect(status.tokenHint!.length).toBeLessThan(token.length);
    expect(JSON.stringify(status)).not.toContain(token);
  });

  // The token is the only thing in front of a public endpoint, so a widened
  // file mode is an exposure rather than a style issue.
  it("reports an unsafe file mode instead of only reporting configured", () => {
    dirs.push(isolateStateDir());
    requireHttpAuthToken();

    if (process.platform === "win32") return;
    fs.chmodSync(httpAuthFile(), 0o644);
    const status = httpAuthStatus();

    expect(status.configured).toBe(true);
    expect(status.permissionsSafe).toBe(false);
    expect(status.fileMode).toBe("644");
  });

  it("reports unconfigured status without throwing when no token exists", () => {
    dirs.push(isolateStateDir());
    const status = httpAuthStatus();

    expect(status.configured).toBe(false);
    expect(status.tokenHint).toBeNull();
    expect(status.permissionsSafe).toBe(false);
  });
});
