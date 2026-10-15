import fs from "node:fs/promises";
import { constants } from "node:fs";
import { Workspace, WorkspaceError } from "./manager.js";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type WorkspaceImageFormat = "png" | "jpeg" | "gif" | "webp";
export type WorkspaceImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface WorkspaceImage {
  path: string;
  format: WorkspaceImageFormat;
  mediaType: WorkspaceImageMediaType;
  sizeBytes: number;
  bytes: Buffer;
}

function imageFormat(bytes: Buffer): WorkspaceImageFormat | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 6 && (bytes.toString("ascii", 0, 6) === "GIF87a" || bytes.toString("ascii", 0, 6) === "GIF89a")) return "gif";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

const MEDIA_TYPES: Record<WorkspaceImageFormat, WorkspaceImageMediaType> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export async function readWorkspaceImage(workspace: Workspace, requested: string): Promise<WorkspaceImage> {
  const { abs, rel } = workspace.resolve(requested);
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(abs, flags);
  } catch {
    throw new WorkspaceError("FILE_NOT_FOUND", `Image file not found: ${rel}`);
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new WorkspaceError("NOT_A_FILE", `Not a regular image file: ${rel}`);
    if (stat.size > MAX_IMAGE_BYTES) {
      throw new WorkspaceError("FILE_TOO_LARGE", `Image exceeds the ${MAX_IMAGE_BYTES}-byte limit: ${rel}`);
    }

    const buffer = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    let sizeBytes = 0;
    while (sizeBytes < buffer.length) {
      const { bytesRead } = await handle.read(buffer, sizeBytes, Math.min(64 * 1024, buffer.length - sizeBytes), sizeBytes);
      if (bytesRead === 0) break;
      sizeBytes += bytesRead;
    }
    if (sizeBytes > MAX_IMAGE_BYTES) {
      throw new WorkspaceError("FILE_TOO_LARGE", `Image exceeds the ${MAX_IMAGE_BYTES}-byte limit: ${rel}`);
    }

    const bytes = buffer.subarray(0, sizeBytes);
    const format = imageFormat(bytes);
    if (!format) {
      throw new WorkspaceError("UNSUPPORTED_IMAGE_FORMAT", "Image must have a PNG, JPEG, GIF, or WebP signature.");
    }
    return { path: rel, format, mediaType: MEDIA_TYPES[format], sizeBytes, bytes };
  } finally {
    await handle.close();
  }
}
