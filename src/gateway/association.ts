import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ensureDir, getStateDir, readJsonIfExists, withFileLock, writeSecureJsonExclusive } from "../config/paths.js";

/**
 * A stable association id for this machine's gateway.
 *
 * The official tunnel config used to carry this value, so it survived
 * restarts. The gateway now generates its own, and a value that changes on
 * every start would make the stored connector binding report `stale` each
 * time. Persist it once instead.
 */

const associationSchema = z
  .object({
    schemaVersion: z.literal(1),
    associationId: z.string().regex(/^assoc-[a-f0-9]{32}$/),
    createdAt: z.string().datetime(),
  })
  .strict();

export type MachineAssociation = z.infer<typeof associationSchema>;

export function machineAssociationFile(): string {
  return path.join(ensureDir(path.join(getStateDir(), "machine")), "association.json");
}

function readAssociation(file: string): MachineAssociation | null {
  const value = readJsonIfExists<unknown>(file);
  if (value === null) {
    if (fs.existsSync(file)) throw new Error("machine association is unreadable or malformed");
    return null;
  }
  const parsed = associationSchema.safeParse(value);
  if (!parsed.success) throw new Error("machine association failed validation");
  return parsed.data;
}

/** Read the persistent association id, creating it on first use. */
export function resolveMachineAssociation(): MachineAssociation {
  const file = machineAssociationFile();
  const lock = path.join(path.dirname(file), "association.lock");
  return withFileLock(lock, () => {
    const existing = readAssociation(file);
    if (existing) return existing;
    const created: MachineAssociation = {
      schemaVersion: 1,
      associationId: `assoc-${randomBytes(16).toString("hex")}`,
      createdAt: new Date().toISOString(),
    };
    try {
      writeSecureJsonExclusive(file, created);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const published = readAssociation(file);
    if (!published) throw new Error("machine association could not be created");
    return published;
  });
}

/** Nonce is per-boot: it proves a running gateway is the one we just started. */
export function newAssociationNonce(): string {
  return randomBytes(32).toString("base64url");
}
