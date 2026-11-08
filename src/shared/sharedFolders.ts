import { z } from "zod"

export const SHARED_FOLDER_LIMITS = {
  maxEntries: 50_000,
  maxDepth: 64,
  maxNameLength: 255,
  maxPathLength: 1_024,
  maxPayloadBytes: 4 * 1024 * 1024,
  maxManifestBytes: 64 * 1024 * 1024,
} as const

const controls = /[\u0000-\u001f\u007f-\u009f]/

export const sharedFolderEntrySchema = z.object({
  id: z.number().int().nonnegative().safe(),
  p: z.string().min(1).max(SHARED_FOLDER_LIMITS.maxPathLength),
  k: z.enum(["f", "d"]),
  s: z.number().int().nonnegative().safe().optional(),
  m: z.number().int().nonnegative().safe().optional(),
}).strict().superRefine((entry, context) => {
  if ((entry.k === "f") !== (entry.s !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid file size field" })
  }
  if (entry.k === "d" && entry.m !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Directories cannot have mtimes" })
  }
  const segments = entry.p.split("/")
  if (
    entry.p.startsWith("/") ||
    entry.p.includes("\\") ||
    segments.length > SHARED_FOLDER_LIMITS.maxDepth ||
    segments.some((segment) =>
      !segment ||
      segment === "." ||
      segment === ".." ||
      segment.length > SHARED_FOLDER_LIMITS.maxNameLength ||
      controls.test(segment),
    )
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid relative path" })
  }
})

export const untrustedSharedFolderManifestSchema = z.object({
  v: z.literal(1),
  rootName: z.string(),
  scannedAt: z.number(),
  entries: z.array(z.object({
    id: z.number(),
    p: z.string(),
    k: z.enum(["f", "d"]),
    s: z.number().optional(),
    m: z.number().optional(),
  }).strict()).max(SHARED_FOLDER_LIMITS.maxEntries),
}).strict().superRefine((manifest, context) => {
  manifest.entries.forEach((entry, index) => {
    if (entry.id !== index) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["entries", index, "id"], message: "Entry ids must be stable array indices" })
    }
  })
})

export const sharedFolderManifestSchema = z.object({
  v: z.literal(1),
  rootName: z.string().min(1).max(SHARED_FOLDER_LIMITS.maxNameLength),
  scannedAt: z.number().int().nonnegative(),
  entries: z.array(sharedFolderEntrySchema).max(SHARED_FOLDER_LIMITS.maxEntries),
}).strict().superRefine((manifest, context) => {
  if (controls.test(manifest.rootName)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid root name" })
  }
  const ids = new Set<number>()
  for (const [index, entry] of manifest.entries.entries()) {
    if (ids.has(entry.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["entries", index, "id"], message: "Duplicate entry id" })
    }
    ids.add(entry.id)
  }
})

export type SharedFolderEntry = z.infer<typeof sharedFolderEntrySchema>
export type SharedFolderManifest = z.infer<typeof sharedFolderManifestSchema>

export interface SharedFolderRecord {
  id: string
  conversationId: string
  ownerId: string
  ciphertext: string
  iv: string
  formatVersion: number
  compressed: boolean
  payloadBytes: number
  createdAt: string
  revokedAt: string | null
}

export const sharedFolderRecordSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  ownerId: z.string().uuid(),
  ciphertext: z.string().min(24).max(Math.ceil(SHARED_FOLDER_LIMITS.maxPayloadBytes / 3) * 4),
  iv: z.string().length(16),
  formatVersion: z.literal(1),
  compressed: z.boolean(),
  payloadBytes: z.number().int().min(16).max(SHARED_FOLDER_LIMITS.maxPayloadBytes),
  createdAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
}).strict()

export interface SharedFolderTreeNode {
  name: string
  path: string
  kind: "f" | "d"
  entryId?: number
  size?: number
  modifiedAt?: number
  children: Map<string, SharedFolderTreeNode>
}

export function sanitizeManifestEntries(entries: SharedFolderEntry[]): {
  entries: SharedFolderEntry[]
  hiddenCount: number
} {
  const valid: SharedFolderEntry[] = []
  let hiddenCount = 0
  for (const entry of entries) {
    const segments = entry.p.split("/")
    const invalid = entry.p.length > SHARED_FOLDER_LIMITS.maxPathLength ||
      entry.p.startsWith("/") ||
      entry.p.includes("\\") ||
      segments.length > SHARED_FOLDER_LIMITS.maxDepth ||
      segments.some((segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.length > SHARED_FOLDER_LIMITS.maxNameLength ||
        controls.test(segment),
      )
    if (invalid) {
      hiddenCount += 1
      continue
    }
    valid.push(entry)
  }
  return { entries: valid, hiddenCount }
}

export function buildSharedFolderTree(entries: SharedFolderEntry[]): SharedFolderTreeNode {
  const root: SharedFolderTreeNode = {
    name: "",
    path: "",
    kind: "d",
    children: new Map(),
  }
  const sanitized = sanitizeManifestEntries(entries)
  for (const entry of sanitized.entries) {
    const parts = entry.p.split("/")
    let node = root
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index]
      if (!name) break
      const path = parts.slice(0, index + 1).join("/")
      let child = node.children.get(name)
      if (!child) {
        child = {
          name,
          path,
          kind: index === parts.length - 1 ? entry.k : "d",
          children: new Map(),
        }
        node.children.set(name, child)
      }
      if (index < parts.length - 1 && child.kind === "f") {
        sanitized.hiddenCount += 1
        break
      }
      if (index === parts.length - 1) {
        child.kind = entry.k
        child.entryId = entry.id
        child.size = entry.s
        child.modifiedAt = entry.m
      }
      node = child
    }
  }
  return root
}

const naturalCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
})

export function sortSharedFolderNodes(
  nodes: SharedFolderTreeNode[],
): SharedFolderTreeNode[] {
  return nodes.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "d" ? -1 : 1
    return naturalCollator.compare(
      left.name.normalize("NFC"),
      right.name.normalize("NFC"),
    )
  })
}
