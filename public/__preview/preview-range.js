export function parsePreviewRange(header, size, maxBytes) {
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  if (!header) return { start: 0, end: Math.min(size, maxBytes) };
  if (header.includes(",") || !header.startsWith("bytes=")) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - Math.min(suffix, maxBytes)), end: size };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) + 1 : size;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size) return null;
  const end = Math.min(requestedEnd, start + maxBytes, size);
  return end > start ? { start, end } : null;
}

export function previewRangeHeaders(start, end, size, mime) {
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Length": String(end - start),
    "Content-Range": `bytes ${start}-${end - 1}/${size}`,
    "Content-Type": mime,
    "X-Content-Type-Options": "nosniff",
  });
  if (mime === "image/svg+xml") {
    headers.set("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'");
  }
  return headers;
}
