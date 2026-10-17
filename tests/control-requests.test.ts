import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  cancelControlRequest,
  getActiveControlRequestStatus,
  getControlRequestStatus,
  getControlRequestsDir,
  openControlRequest,
  pruneControlRequests,
  renewControlRequest,
  retireControlRequestSession,
} from "../src/control/requests.js";
import { writeSecureJsonExclusive } from "../src/config/paths.js";
import { cleanup, isolateStateDir } from "./helpers.js";

const WORKSPACE_A = "workspaceaaa";
const WORKSPACE_B = "workspacebbb";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

let stateDir: string;

function correlation(iteration = 0, phase: "BOOT" | "RESEARCH" | "PLAN" | "REVIEW" = "PLAN") {
  return { taskId: "c2c_plan", iteration, phase } as const;
}

beforeEach(() => {
  stateDir = isolateStateDir();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanup(stateDir);
  delete process.env.C2C_STATE_DIR;
});

describe("control request storage", () => {
  it("normalizes retained request, active pointer, and renewal records", () => {
    const request = openControlRequest(WORKSPACE_A, {
      localSessionId: "session-legacy",
      ...correlation(),
      ttlMs: 60_000,
    });
    const root = getControlRequestsDir(WORKSPACE_A);
    const requestPath = path.join(root, "requests", `${request.requestId}.json`);
    const activePath = path.join(root, "active", "session-legacy.json");
    const stored = JSON.parse(fs.readFileSync(requestPath, "utf8")) as Record<string, unknown>;
    const { surfaceGeneration: _generation, surfaceTabId: _tabId, ...legacy } = stored;
    const legacyRequest = { ...legacy, schemaVersion: 1 };
    fs.writeFileSync(requestPath, JSON.stringify(legacyRequest));
    fs.writeFileSync(activePath, JSON.stringify(legacyRequest));

    renewControlRequest(
      WORKSPACE_A,
      request.requestId,
      "session-legacy",
      correlation(),
      () => new Date(Date.now() + 120_000).toISOString(),
    );
    const renewalPath = path.join(root, "renewals", `${request.requestId}.json`);
    const renewal = JSON.parse(fs.readFileSync(renewalPath, "utf8")) as {
      request: Record<string, unknown>;
      expiresAt: string;
    };
    fs.writeFileSync(renewalPath, JSON.stringify({ request: legacyRequest, expiresAt: renewal.expiresAt }));

    expect(getActiveControlRequestStatus(WORKSPACE_A, "session-legacy")).toMatchObject({
      status: "pending",
      request: {
        schemaVersion: 2,
        surfaceGeneration: null,
        surfaceTabId: null,
        expiresAt: renewal.expiresAt,
      },
    });
  });

  it("binds lookup to the exact request, local session, and optional correlation", () => {
    const expected = { taskId: "c2c_plan", iteration: 4, phase: "REVIEW" as const };
    const request = openControlRequest(WORKSPACE_A, { localSessionId: "session-a", ...expected });

    expect(getControlRequestStatus(WORKSPACE_A, request.requestId, "session-a", expected))
      .toMatchObject({ status: "pending", request: { requestId: request.requestId, ...expected } });
    expect(() => getControlRequestStatus(WORKSPACE_A, request.requestId, "session-b", expected))
      .toThrow(/another local session/);
    expect(() => getControlRequestStatus(WORKSPACE_A, request.requestId, "session-a", {
      ...expected,
      iteration: 3,
    })).toThrow(/does not match/);
    expect(getControlRequestStatus(WORKSPACE_B, request.requestId, "session-a", expected))
      .toMatchObject({ status: "not_found", request: null });
    expect(() => getControlRequestStatus(WORKSPACE_A, "../../outside", "session-a", expected))
      .toThrow(/safe identifier/);
  });

  it("recovers the same unfinished request and isolates other local sessions", () => {
    const first = openControlRequest(WORKSPACE_A, {
      localSessionId: "session-a",
      ...correlation(),
    });
    expect(openControlRequest(WORKSPACE_A, {
      localSessionId: "session-a",
      ...correlation(),
    }).requestId).toBe(first.requestId);
    expect(() => openControlRequest(WORKSPACE_A, {
      localSessionId: "session-a",
      ...correlation(1),
    })).toThrow(/unfinished request/);

    const independent = openControlRequest(WORKSPACE_A, {
      localSessionId: "session-b",
      ...correlation(),
    });
    expect(independent.requestId).not.toBe(first.requestId);
    expect(getActiveControlRequestStatus(WORKSPACE_A, "session-b")?.requestId).toBe(independent.requestId);
  });

  it("cancels only the exact request and rejects a terminal marker copied from another request", () => {
    const first = openControlRequest(WORKSPACE_A, { localSessionId: "session-a", ...correlation() });
    expect(cancelControlRequest(WORKSPACE_A, first.requestId, "session-a", correlation()).status).toBe("cancelled");
    expect(cancelControlRequest(WORKSPACE_A, first.requestId, "session-a", correlation()).status).toBe("cancelled");

    const second = openControlRequest(WORKSPACE_A, { localSessionId: "session-a", ...correlation(1) });
    const root = getControlRequestsDir(WORKSPACE_A);
    fs.copyFileSync(
      path.join(root, "cancelled", `${first.requestId}.json`),
      path.join(root, "cancelled", `${second.requestId}.json`),
    );
    expect(() => getControlRequestStatus(WORKSPACE_A, second.requestId, "session-a", correlation(1)))
      .toThrow(/does not match the exact control request/);
  });

  it("retires only one session's active request and preserves unrelated work", () => {
    const retiring = openControlRequest(WORKSPACE_A, { localSessionId: "session-retire", ...correlation() });
    const other = openControlRequest(WORKSPACE_A, { localSessionId: "session-keep", ...correlation() });

    expect(retireControlRequestSession(WORKSPACE_A, "session-retire")).toEqual({
      localSessionId: "session-retire",
      pendingCancelled: 1,
      activeRequestCleared: true,
    });
    expect(getControlRequestStatus(WORKSPACE_A, retiring.requestId, "session-retire", correlation()).status)
      .toBe("cancelled");
    expect(getActiveControlRequestStatus(WORKSPACE_A, "session-retire")).toBeNull();
    expect(getControlRequestStatus(WORKSPACE_A, other.requestId, "session-keep", correlation()).status)
      .toBe("pending");
    expect(getActiveControlRequestStatus(WORKSPACE_A, "session-keep")?.requestId).toBe(other.requestId);
  });

  it("prunes only expired terminal requests after retention", () => {
    const first = openControlRequest(WORKSPACE_A, { localSessionId: "session-a", ...correlation() });
    const otherWorkspace = openControlRequest(WORKSPACE_B, { localSessionId: "session-b", ...correlation() });
    cancelControlRequest(WORKSPACE_A, first.requestId, "session-a", correlation());
    const retentionElapsed = Date.now() + 8 * 24 * 60 * 60 * 1_000;

    expect(pruneControlRequests(WORKSPACE_A, retentionElapsed)).toBe(1);
    expect(getControlRequestStatus(WORKSPACE_A, first.requestId, "session-a", correlation()).status)
      .toBe("not_found");
    expect(getControlRequestStatus(WORKSPACE_B, otherWorkspace.requestId, "session-b", correlation()).status)
      .toBe("pending");
    expect(pruneControlRequests(WORKSPACE_B, Date.now())).toBe(0);
  });

  it("fails closed on unknown request fields and noncanonical timestamps", () => {
    const request = openControlRequest(WORKSPACE_A, { localSessionId: "session-integrity", ...correlation() });
    const requestPath = path.join(getControlRequestsDir(WORKSPACE_A), "requests", `${request.requestId}.json`);
    const stored = JSON.parse(fs.readFileSync(requestPath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(requestPath, JSON.stringify({ ...stored, unrecognized: true }));
    expect(() => getControlRequestStatus(WORKSPACE_A, request.requestId, "session-integrity", correlation()))
      .toThrow(/stored request schema is invalid/);

    const { unrecognized: _ignored, ...known } = JSON.parse(fs.readFileSync(requestPath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(requestPath, JSON.stringify({ ...known, expiresAt: "not-a-timestamp" }));
    expect(() => getControlRequestStatus(WORKSPACE_A, request.requestId, "session-integrity", correlation()))
      .toThrow(/timestamps are invalid/);
  });

  it("does not scan another session's damaged request while opening a turn", () => {
    const damaged = openControlRequest(WORKSPACE_A, { localSessionId: "session-damaged", ...correlation() });
    const file = path.join(getControlRequestsDir(WORKSPACE_A), "requests", `${damaged.requestId}.json`);
    fs.writeFileSync(file, "not-json");

    const independent = openControlRequest(WORKSPACE_A, { localSessionId: "session-independent", ...correlation() });
    expect(independent.requestId).not.toBe(damaged.requestId);
    expect(() => getControlRequestStatus(WORKSPACE_A, damaged.requestId, "session-damaged", correlation()))
      .toThrow(/unreadable or malformed/);
  });

  it("serializes same-session request opens across processes", async () => {
    const moduleUrl = pathToFileURL(path.join(projectRoot, "src", "control", "requests.ts")).href;
    const script = `
      import { openControlRequest } from ${JSON.stringify(moduleUrl)};
      const request = openControlRequest(${JSON.stringify(WORKSPACE_A)}, {
        localSessionId: "session-cross-process",
        taskId: "cross_process_task",
        iteration: 0,
        phase: "PLAN",
      });
      process.stdout.write(request.requestId);
    `;
    const options = {
      cwd: projectRoot,
      env: { ...process.env, C2C_STATE_DIR: stateDir },
      timeout: 30_000,
      encoding: "utf8" as const,
    };
    const [left, right] = await Promise.all([
      execFileAsync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", script], options),
      execFileAsync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", script], options),
    ]);
    expect(left.stdout).toMatch(/^[a-f0-9]{48}$/);
    expect(right.stdout).toBe(left.stdout);
  });

  it("publishes exclusive JSON without replacing the winning value", () => {
    const file = path.join(stateDir, "exclusive", "request.json");
    writeSecureJsonExclusive(file, { requestId: "first" });

    expect(() => writeSecureJsonExclusive(file, { requestId: "second" })).toThrow();
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ requestId: "first" });
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
