import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";

/** Maximum size for one message attachment (25 MB). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const EXT_TO_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".htm": "text/html",
  ".svg": "image/svg+xml",
  ".xml": "application/xml",
  ".zip": "application/zip",
};

/** Safe MIME types that browsers can preview inline without executing active content. */
const INLINE_MIMES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);

/** Cleans an uploaded filename for display, removing path separators and control characters. */
export function sanitizeFilename(raw: string): string {
  const leaf = basename(raw.replaceAll("\\", "/"));
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "attachment";
  return cleaned.length > 180 ? cleaned.slice(0, 180) : cleaned;
}

/** Normalizes a MIME type or infers one from the filename extension when missing or generic. */
export function normalizeMimeType(raw: string | null | undefined, filename: string): string {
  const base = (raw ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (base && base !== "application/octet-stream") return base;
  const ext = extname(filename).toLowerCase();
  return EXT_TO_MIME[ext] ?? "application/octet-stream";
}

export function isInlineMime(mimeType: string): boolean {
  return INLINE_MIMES.has(mimeType.toLowerCase());
}

/** Builds a safe Content-Disposition header value with both ASCII fallback and UTF-8 filename. */
export function contentDisposition(name: string, inline: boolean): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name);
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Writes attachment bytes to `<attachmentsDir>/<threadId>/<id><ext>` and returns the relative storage path. */
export function writeAttachmentFile(
  attachmentsDir: string,
  threadId: string,
  attachmentId: string,
  name: string,
  bytes: Uint8Array,
): string {
  const rawExt = extname(name).toLowerCase();
  const safeExt = /^\.[a-z0-9]{1,10}$/.test(rawExt) ? rawExt : "";
  const relativePath = `${threadId}/${attachmentId}${safeExt}`;
  const fullPath = resolveAttachmentPath(attachmentsDir, relativePath);
  mkdirSync(join(attachmentsDir, threadId), { recursive: true, mode: 0o700 });
  writeFileSync(fullPath, bytes, { mode: 0o600 });
  return relativePath;
}

/** Resolves a stored relative attachment path and ensures it stays inside `attachmentsDir`. */
export function resolveAttachmentPath(attachmentsDir: string, storagePath: string): string {
  const root = resolve(attachmentsDir);
  const full = resolve(root, storagePath);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error("Attachment path escapes the attachments directory.");
  }
  return full;
}

export function deleteThreadAttachmentFiles(attachmentsDir: string, threadId: string): void {
  const dir = resolveAttachmentPath(attachmentsDir, threadId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/**
 * Copies a stored attachment into `<workspace>/attachments/` so that a sandboxed harness
 * can read it, and returns the workspace-relative path.
 */
export function copyAttachmentToWorkspace(
  attachmentsDir: string,
  storagePath: string,
  attachmentId: string,
  displayName: string,
  workspaceDir: string,
): string {
  const source = resolveAttachmentPath(attachmentsDir, storagePath);
  const safeName = displayName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "file";
  const filename = `${attachmentId.slice(0, 8)}-${safeName}`;
  const destDir = join(workspaceDir, "attachments");
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  copyFileSync(source, join(destDir, filename));
  return `attachments/${filename}`;
}

/** Formats a byte count for display in prompts or logs. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
