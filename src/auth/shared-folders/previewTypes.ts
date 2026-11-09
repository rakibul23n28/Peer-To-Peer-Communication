import { PREVIEW_LIMITS } from "../../shared/previewProtocol"

export type PreviewKind = "image" | "pdf" | "text" | "markdown" | "video" | "audio" | "docx" | "unsupported"

export interface PreviewDescriptor {
  kind: PreviewKind
  mime: string
  maxBytes: number
}

const textExtensions = new Set([
  "txt", "md", "markdown", "log", "csv", "tsv", "json", "jsonl", "yaml", "yml",
  "xml", "html", "css", "js", "jsx", "ts", "tsx", "py", "go", "rs", "java",
  "c", "h", "cpp", "hpp", "sh", "sql", "toml", "ini", "conf", "tex", "bib",
  "rst", "mdx", "properties", "env", "lock",
])

const imageMime: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  gif: "image/gif", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon",
  svg: "image/svg+xml",
}

const videoMime: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm",
}

const audioMime: Record<string, string> = {
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg",
  flac: "audio/flac", aac: "audio/aac",
}

export function getPreviewDescriptor(name: string, size: number): PreviewDescriptor {
  const extension = name.split(".").pop()?.toLowerCase() ?? ""
  if (extension === "pdf") return { kind: "pdf", mime: "application/pdf", maxBytes: Number.MAX_SAFE_INTEGER }
  if (extension === "docx") return { kind: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", maxBytes: PREVIEW_LIMITS.docxMaxBytes }
  if (textExtensions.has(extension)) return {
    kind: extension === "md" || extension === "markdown" ? "markdown" : "text",
    mime: "text/plain",
    maxBytes: PREVIEW_LIMITS.textMaxBytes,
  }
  if (imageMime[extension]) return { kind: "image", mime: imageMime[extension], maxBytes: Number.MAX_SAFE_INTEGER }
  if (videoMime[extension]) return { kind: "video", mime: videoMime[extension], maxBytes: Number.MAX_SAFE_INTEGER }
  if (audioMime[extension]) return { kind: "audio", mime: audioMime[extension], maxBytes: Number.MAX_SAFE_INTEGER }
  return { kind: "unsupported", mime: "application/octet-stream", maxBytes: size }
}

function startsWith(bytes: Uint8Array, values: number[]): boolean {
  return values.every((value, index) => bytes[index] === value)
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length))
}

export function previewMagicMatches(kind: PreviewKind, name: string, bytes: Uint8Array): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  if (kind === "image") {
    if (["jpg", "jpeg"].includes(ext)) return startsWith(bytes, [0xff, 0xd8, 0xff])
    if (ext === "png") return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    if (ext === "gif") return ["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))
    if (ext === "webp") return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP"
    if (ext === "avif") return ascii(bytes, 4, 4) === "ftyp" && /avif|avis/.test(ascii(bytes, 8, 16))
    if (ext === "bmp") return ascii(bytes, 0, 2) === "BM"
    if (ext === "ico") return startsWith(bytes, [0, 0, 1, 0])
    if (ext === "svg") return /<svg(?:\s|>)/i.test(new TextDecoder().decode(bytes.subarray(0, 8192)))
  }

  if (kind === "pdf") return ascii(bytes, 0, 5) === "%PDF-"
  if (kind === "video") {
    if (ext === "webm") return startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])
    return ascii(bytes, 4, 4) === "ftyp"
  }
  if (kind === "audio") {
    if (ext === "wav") return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE"
    if (ext === "ogg") return ascii(bytes, 0, 4) === "OggS"
    if (ext === "flac") return ascii(bytes, 0, 4) === "fLaC"
    if (ext === "aac") return startsWith(bytes, [0xff]) && (bytes[1] & 0xf6) === 0xf0
    if (ext === "m4a") return ascii(bytes, 4, 4) === "ftyp"
    return ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
  }
  if (kind === "docx") return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])
  if (kind === "text" || kind === "markdown") {
    return !bytes.subarray(0, 8192).includes(0)
  }
  return false
}

export function zipHasRootEntry(bytes: Uint8Array, name: string): boolean {
  const minimum = Math.max(0, bytes.length - 65_557)
  let eocd = -1
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes[offset] === 0x50 && bytes[offset + 1] === 0x4b &&
      bytes[offset + 2] === 0x05 && bytes[offset + 3] === 0x06) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const entries = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  const decoder = new TextDecoder()
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > bytes.length ||
      view.getUint32(offset, true) !== 0x02014b50) return false
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const end = offset + 46 + nameLength
    if (end > bytes.length) return false
    if (decoder.decode(bytes.subarray(offset + 46, end)) === name) return true
    offset = end + extraLength + commentLength
  }
  return false
}

export function zipIsWithinPreviewBounds(
  bytes: Uint8Array,
  maxExpandedBytes = 100 * 1024 * 1024,
): boolean {
  const minimum = Math.max(0, bytes.length - 65_557)
  let eocd = -1
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes[offset] === 0x50 && bytes[offset + 1] === 0x4b &&
      bytes[offset + 2] === 0x05 && bytes[offset + 3] === 0x06) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const entries = view.getUint16(eocd + 10, true)
  if (entries > 10_000) return false
  let offset = view.getUint32(eocd + 16, true)
  let expandedBytes = 0
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) return false
    const compressedBytes = view.getUint32(offset + 20, true)
    const uncompressedBytes = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength
    if (nextOffset > bytes.length) return false
    if (compressedBytes === 0xffffffff || uncompressedBytes === 0xffffffff) return false
    if (uncompressedBytes > 1024 * 1024 && uncompressedBytes > compressedBytes * 200) return false
    expandedBytes += uncompressedBytes
    if (expandedBytes > maxExpandedBytes) return false
    offset = nextOffset
  }
  return true
}
