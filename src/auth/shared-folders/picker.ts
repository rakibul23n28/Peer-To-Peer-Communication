import {
  SHARED_FOLDER_LIMITS,
  sharedFolderManifestSchema,
  type SharedFolderEntry,
  type SharedFolderManifest,
} from "../../shared/sharedFolders"

export interface LocalFolderDirectoryHandle extends FileSystemDirectoryHandle {
  entries(): AsyncIterable<[string, LocalFolderDirectoryHandle | FileSystemFileHandle]>
}

export interface PickedFolder {
  rootName: string
  entries: SharedFolderEntry[]
  handle?: LocalFolderDirectoryHandle
  filesByPath?: Map<string, File>
}

export class FolderScanLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FolderScanLimitError"
  }
}

function isDirectoryHandle(
  handle: LocalFolderDirectoryHandle | FileSystemFileHandle,
): handle is LocalFolderDirectoryHandle {
  return "entries" in handle
}

function isJunkName(name: string): boolean {
  return [".DS_Store", "Thumbs.db", "desktop.ini"].includes(name)
}

function isHiddenPath(path: string): boolean {
  return path.split("/").some((part) => part.startsWith("."))
}

function validatePath(path: string): void {
  const parts = path.split("/")
  if (
    path.length > SHARED_FOLDER_LIMITS.maxPathLength ||
    path.startsWith("/") ||
    path.includes("\\") ||
    parts.length > SHARED_FOLDER_LIMITS.maxDepth ||
    parts.some((part) =>
      !part ||
      part === "." ||
      part === ".." ||
      part.length > SHARED_FOLDER_LIMITS.maxNameLength ||
      /[\u0000-\u001f\u007f-\u009f]/.test(part),
    )
  ) {
    throw new FolderScanLimitError("This folder contains a name or path that exceeds Orbit's supported limits.")
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

async function scanDirectory(
  root: LocalFolderDirectoryHandle,
  signal: AbortSignal,
  onProgress: (count: number) => void,
): Promise<PickedFolder> {
  const entries: SharedFolderEntry[] = []
  const filesByPath = new Map<string, File>()
  const queue: Array<{ handle: LocalFolderDirectoryHandle; path: string }> = [
    { handle: root, path: "" },
  ]
  let scanned = 0

  while (queue.length) {
    if (signal.aborted) throw new DOMException("Scan cancelled", "AbortError")
    const current = queue.shift()
    if (!current) continue
    const children: Array<{ name: string; path: string; handle: LocalFolderDirectoryHandle | FileSystemFileHandle }> = []
    for await (const [name, handle] of current.handle.entries()) {
      if (signal.aborted) throw new DOMException("Scan cancelled", "AbortError")
      if (isJunkName(name)) continue
      const path = current.path ? `${current.path}/${name}` : name
      validatePath(path)
      children.push({ name, path, handle })
      if (entries.length + queue.length + children.length > SHARED_FOLDER_LIMITS.maxEntries) {
        throw new FolderScanLimitError("This folder has more than 50,000 items. Choose a smaller folder.")
      }
    }

    for (let offset = 0; offset < children.length; offset += 16) {
      if (signal.aborted) throw new DOMException("Scan cancelled", "AbortError")
      const batch = children.slice(offset, offset + 16)
      const results = await Promise.all(batch.map(async ({ name, path, handle }) => {
        if (isDirectoryHandle(handle)) {
          return { directory: { handle, path }, entry: { p: path, k: "d" as const } }
        }
        const file = await handle.getFile()
        filesByPath.set(path, file)
        return {
          entry: { p: path, k: "f" as const, s: file.size, m: file.lastModified },
        }
      }))
      for (const result of results) {
        if ("directory" in result && result.directory) queue.push(result.directory)
        const entry = result.entry
        entries.push({ id: entries.length, ...entry })
      }
      scanned += batch.length
      onProgress(scanned)
      if (entries.length > SHARED_FOLDER_LIMITS.maxEntries) {
        throw new FolderScanLimitError("This folder has more than 50,000 items. Choose a smaller folder.")
      }
      await yieldToEventLoop()
    }
  }
  return { rootName: root.name, entries, handle: root, filesByPath }
}

async function selectFallbackFolder(
  signal: AbortSignal,
  onProgress: (count: number) => void,
): Promise<PickedFolder | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input")
    input.type = "file"
    input.multiple = true
    input.setAttribute("webkitdirectory", "")
    input.setAttribute("directory", "")
    input.className = "orbit-visually-hidden"
    document.body.append(input)

    const cleanup = () => {
      input.removeEventListener("change", onChange)
      input.removeEventListener("cancel", onCancel)
      window.removeEventListener("focus", onWindowFocus)
      signal.removeEventListener("abort", onAbort)
      input.remove()
    }
    const onCancel = () => {
      cleanup()
      resolve(null)
    }
    const onAbort = () => {
      cleanup()
      resolve(null)
    }
    const onWindowFocus = () => {
      window.setTimeout(() => {
        if (input.isConnected && !input.files?.length) onCancel()
      }, 250)
    }
    const onChange = () => {
      const files = Array.from(input.files ?? [])
      cleanup()
      void (async () => {
        if (!files.length) {
          resolve(null)
          return
        }
        const rootName = files[0].webkitRelativePath.split("/")[0]
        const entries: SharedFolderEntry[] = []
        const directoryPaths = new Set<string>()
        const filesByPath = new Map<string, File>()
        for (let offset = 0; offset < files.length; offset += 16) {
          if (signal.aborted) {
            resolve(null)
            return
          }
          for (const file of files.slice(offset, offset + 16)) {
            const parts = file.webkitRelativePath.split("/")
            if (parts[0] !== rootName || parts.length < 2) continue
            const relative = parts.slice(1).join("/")
            if (isJunkName(parts[parts.length - 1])) continue
            validatePath(relative)
            for (let index = 1; index < parts.length - 1; index += 1) {
              const dirPath = parts.slice(1, index + 1).join("/")
              if (!directoryPaths.has(dirPath)) {
                directoryPaths.add(dirPath)
                entries.push({ id: entries.length, p: dirPath, k: "d" })
              }
            }
            entries.push({
              id: entries.length,
              p: relative,
              k: "f",
              s: file.size,
              m: file.lastModified,
            })
            filesByPath.set(relative, file)
            if (entries.length > SHARED_FOLDER_LIMITS.maxEntries) {
              reject(new FolderScanLimitError("This folder has more than 50,000 items. Choose a smaller folder."))
              return
            }
          }
          onProgress(Math.min(files.length, offset + 16))
          await yieldToEventLoop()
        }
        // The directory-input fallback cannot discover empty directories because browsers expose files only.
        resolve({ rootName, entries, filesByPath })
      })().catch(reject)
    }
    input.addEventListener("change", onChange, { once: true })
    input.addEventListener("cancel", onCancel, { once: true })
    window.addEventListener("focus", onWindowFocus, { once: true })
    signal.addEventListener("abort", onAbort, { once: true })
    input.click()
  })
}

export async function pickFolder(
  signal: AbortSignal,
  onProgress: (count: number) => void,
): Promise<PickedFolder | null> {
  const pickerWindow = window as Window & {
    showDirectoryPicker?: (options: { mode: "read" }) => Promise<LocalFolderDirectoryHandle>
  }
  if (pickerWindow.showDirectoryPicker) {
    try {
      const root = await pickerWindow.showDirectoryPicker({ mode: "read" })
      return await scanDirectory(root, signal, onProgress)
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return null
      throw error
    }
  }
  if ("webkitdirectory" in document.createElement("input")) {
    return selectFallbackFolder(signal, onProgress)
  }
  throw new Error("Your browser can't select folders. Try a desktop browser.")
}

export function makeManifest(
  folder: PickedFolder,
  includeHidden: boolean,
): SharedFolderManifest {
  const entries = folder.entries.filter((entry) =>
    includeHidden || !isHiddenPath(entry.p),
  ).map((entry, id) => ({ ...entry, id }))
  const manifest = sharedFolderManifestSchema.parse({
    v: 1,
    rootName: folder.rootName,
    scannedAt: Date.now(),
    entries,
  })
  return manifest
}

export function summarizeManifest(manifest: SharedFolderManifest) {
  let files = 0
  let folders = 0
  let totalSize = 0
  for (const entry of manifest.entries) {
    if (entry.k === "d") folders += 1
    else {
      files += 1
      totalSize += entry.s ?? 0
    }
  }
  return { files, folders, totalSize }
}

export function previewEntries(manifest: SharedFolderManifest): string[] {
  return manifest.entries.slice(0, 8).map(({ p, k }) => `${k === "d" ? "Folder" : "File"} · ${p}`)
}
