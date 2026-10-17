import { z } from "zod";
import { Workspace, WorkspaceError, type ReadFileResult } from "./manager.js";

export const readManyFilesSchema = z.array(z.object({
  path: z.string().min(1).max(1024),
  start_line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
}).strict().refine((file) => file.end_line === undefined || file.end_line >= (file.start_line ?? 1),
  "end_line must be at least start_line")).min(1).max(16);

export const READ_MANY_MAX_BYTES = 64 * 1024;
type ReadItem = { index: number; file: ReadFileResult } | { index: number; error: string };

/** Reuse all single-file access checks; bound the entire JSON response, not just content. */
export async function readMany(workspace: Workspace, input: z.infer<typeof readManyFilesSchema>, maxBytes = READ_MANY_MAX_BYTES) {
  const files = readManyFilesSchema.parse(input);
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > READ_MANY_MAX_BYTES) {
    throw new WorkspaceError("INVALID_CONFIG", "read_many byte budget must be 1024..65536");
  }
  const items: ReadItem[] = [];
  const observedAt = new Date().toISOString();
  workspace.ignoreRules.refresh();
  // Reserve metadata and one bounded error per remaining file.
  let budget = maxBytes - 256 - files.length * 80;
  for (const [index, file] of files.entries()) {
    let item: ReadItem;
    if (budget < 1024) item = { index, error: "BATCH_LIMIT_REACHED" };
    else {
      try {
        item = { index, file: await workspace.readFileAfterIgnoreRefresh(file.path, {
          startLine: file.start_line, endLine: file.end_line, maxBytes: budget,
        }) };
        const bytes = Buffer.byteLength(JSON.stringify(item));
        if (bytes > budget) item = { index, error: "BATCH_LIMIT_REACHED" };
        else budget -= bytes;
      } catch (error) {
        if (!(error instanceof WorkspaceError)) throw error;
        // Error codes suffice; never echo absolute paths or OS error text.
        item = { index, error: error.code };
      }
    }
    items.push(item);
  }
  return { observedAt, atomicSnapshot: false as const, items };
}
