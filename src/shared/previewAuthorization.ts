import { PREVIEW_LIMITS } from "./previewProtocol.js"
import type { SharedFolderEntry, SharedFolderManifest } from "./sharedFolders.js"

export function resolvePreviewPathSegments(path: string): string[] | null {
  const segments = path.split("/")
  if (segments.some((segment) =>
    !segment || segment === "." || segment === ".." ||
    segment.includes("/") || segment.includes("\\"),
  )) return null
  return segments
}

export function resolvePreviewFileEntry(
  manifest: SharedFolderManifest,
  entryId: number,
): SharedFolderEntry | null {
  const entry = manifest.entries.find(({ id }) => id === entryId)
  return entry?.k === "f" ? entry : null
}

export function previewFileChanged(entry: SharedFolderEntry, file: Pick<File, "size" | "lastModified">): boolean {
  return entry.k !== "f" ||
    file.size !== entry.s ||
    (entry.m !== undefined && file.lastModified !== entry.m)
}

export function previewReadIsBusy(activeReads: number): boolean {
  return activeReads >= PREVIEW_LIMITS.maxInflightReads
}
