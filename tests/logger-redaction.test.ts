import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Logger, redact } from "../src/logger/index.js";
import { cleanup, makeTmpDir } from "./helpers.js";

describe("logger redaction", () => {
  const directories: string[] = [];

  afterEach(() => {
    while (directories.length > 0) cleanup(directories.pop()!);
  });

  it("redacts MCP transport tokens and quoted secret fields in messages and extras", () => {
    const directory = makeTmpDir("logger-redaction");
    directories.push(directory);
    const file = path.join(directory, "test.log");
    const token = `c2c_mcp_${"c".repeat(43)}`;
    const logger = new Logger({ file, level: "info" });

    logger.info(`request /mcp/${token}`, {
      password: "password with spaces",
      nested: { secret: 'secret with "quotes"' },
      api_key: "short api key",
    });

    const line = fs.readFileSync(file, "utf8");
    expect(line).not.toContain(token);
    expect(line).not.toContain("password with spaces");
    expect(line).not.toContain("short api key");
    expect(line).toContain("/mcp/[REDACTED]");

    const extra = JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>;
    expect(extra).toEqual({
      password: "[REDACTED]",
      nested: { secret: "[REDACTED]" },
      api_key: "[REDACTED]",
    });
  });

  it("keeps short diagnostic codes while redacting long code and token values", () => {
    const diagnostic = 'code=2 {"code":"ENOENT"}';
    expect(redact(diagnostic)).toBe(diagnostic);

    const longValue = "x".repeat(16);
    const redacted = redact(`code=${longValue} {"token":"${longValue}"}`);
    expect(redacted).not.toContain(longValue);
    expect(redacted.match(/\[REDACTED\]/g)).toHaveLength(2);
  });
});
