import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir } from "../config/paths.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_FIELD_PATTERN =
  /(^|[^A-Za-z0-9_-])("?(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|code[_-]?verifier|api[_-]?key|private[_-]?key|credential|credentials|password|passwd|passphrase|secret|authorization|code|token)"?\s*[:=]\s*)(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|((?:(?:bearer|basic)\s+)?[^\s,;}\]"']+))/gim;

/**
 * Secret redaction. Logs must never contain tokens, pairing codes or credentials.
 */
const REDACT_PATTERNS: RegExp[] = [
  /c2c_(?:at|rt|ac|admin|ctx|lease|fence|mcp)_[A-Za-z0-9_-]+/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /(authorization"?\s*[:=]\s*"?bearer\s+)[^\s"']+/gi,
  /\b[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}\b/g, // pairing-code shaped strings
];

export function redact(input: string): string {
  let out = input;
  for (const pattern of REDACT_PATTERNS) {
    out = out.replace(pattern, (_m, prefix) =>
      typeof prefix === "string" ? `${prefix}[REDACTED]` : "[REDACTED]"
    );
  }
  return out.replace(
    SECRET_FIELD_PATTERN,
    (
      _match,
      boundary: string,
      prefix: string,
      doubleQuoted: string | undefined,
      singleQuoted: string | undefined,
      bare: string | undefined,
    ) => {
      const field = prefix.match(/"?([A-Za-z0-9_-]+)"?\s*[:=]\s*$/)?.[1]?.toLowerCase();
      const value = doubleQuoted ?? singleQuoted ?? bare ?? "";
      const credential = value.replace(/^(?:bearer|basic)\s+/i, "");
      if ((field === "code" || field === "token") && credential.length < 16) return _match;
      if (doubleQuoted !== undefined) return `${boundary}${prefix}"[REDACTED]"`;
      if (singleQuoted !== undefined) return `${boundary}${prefix}'[REDACTED]'`;
      return `${boundary}${prefix}[REDACTED]`;
    }
  );
}

export interface LoggerOptions {
  name?: string;
  level?: LogLevel;
  file?: string | null;
  console?: boolean;
}

export class Logger {
  private level: number;
  private file: string | null;
  private useConsole: boolean;
  private name: string;

  constructor(opts: LoggerOptions = {}) {
    this.name = opts.name ?? "c2c";
    this.level = LEVELS[opts.level ?? (process.env.C2C_LOG_LEVEL as LogLevel) ?? "info"] ?? LEVELS.info;
    this.useConsole = opts.console ?? false;
    if (opts.file === undefined) {
      const dir = ensureDir(path.join(getStateDir(), "logs"));
      this.file = path.join(dir, `${this.name}.log`);
    } else {
      this.file = opts.file;
    }
  }

  private write(level: LogLevel, msg: string, extra?: unknown): void {
    if (LEVELS[level] < this.level) return;
    const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), `[${this.name}]`, redact(msg)];
    if (extra !== undefined) {
      try {
        parts.push(redact(JSON.stringify(extra)));
      } catch {
        parts.push("[unserializable]");
      }
    }
    const line = parts.join(" ") + "\n";
    if (this.file) {
      try {
        fs.appendFileSync(this.file, line, { mode: 0o600 });
      } catch {
        // logging must never crash the bridge
      }
    }
    if (this.useConsole) process.stderr.write(line);
  }

  debug(msg: string, extra?: unknown): void {
    this.write("debug", msg, extra);
  }
  info(msg: string, extra?: unknown): void {
    this.write("info", msg, extra);
  }
  warn(msg: string, extra?: unknown): void {
    this.write("warn", msg, extra);
  }
  error(msg: string, extra?: unknown): void {
    this.write("error", msg, extra);
  }
}

export const nullLogger = new Logger({ file: null, console: false, level: "error" });
