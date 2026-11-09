import { parsePreviewRange, previewRangeHeaders } from "./preview-range.js";

const WINDOW_BYTES = 1024 * 1024;
const routes = new Map();
const pending = new Map();

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || typeof message !== "object") return;
  if (message.type === "register" && typeof message.token === "string" && event.source?.id) {
    routes.set(message.token, {
      clientId: event.source.id,
      entries: message.entries,
    });
    event.ports[0]?.postMessage({ ok: true });
  } else if (message.type === "unregister" && typeof message.token === "string") {
    routes.delete(message.token);
    for (const [requestId, routeToken] of pending) {
      if (routeToken === message.token) pending.delete(requestId);
    }
  } else if (message.type === "cancel" && typeof message.requestId === "string") {
    pending.delete(message.requestId);
  }
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    url.origin !== self.location.origin ||
    url.pathname === "/__preview/sw.js" ||
    !url.pathname.startsWith("/__preview/")
  ) return;
  event.respondWith(handlePreviewRequest(event.request, event.clientId));
});

async function lookupRoute(clientId, token) {
  const client = await self.clients.get(clientId);
  if (!client) return undefined;
  const channel = new MessageChannel();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      channel.port1.close();
      resolve(undefined);
    }, 1000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timeout);
      channel.port1.close();
      const entries = event.data?.entries;
      resolve(entries && typeof entries === "object"
        ? { clientId, entries }
        : undefined);
    };
    client.postMessage({ type: "lookup", token }, [channel.port2]);
  });
}

async function handlePreviewRequest(request, clientId) {
  const parts = new URL(request.url).pathname.split("/");
  const token = parts[2];
  const entryId = Number(parts[3]);
  let route = routes.get(token);
  if (!route && clientId) {
    route = await lookupRoute(clientId, token);
    if (route) routes.set(token, route);
  }
  const entry = Number.isSafeInteger(entryId) ? route?.entries?.[entryId] : undefined;
  if (!route || route.clientId !== clientId || !entry || request.method !== "GET") {
    return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  const rangeHeader = request.headers.get("Range");
  const range = parsePreviewRange(rangeHeader, entry.size, WINDOW_BYTES);
  if (!range) {
    return new Response(null, {
      status: 416,
      headers: {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "Content-Range": `bytes */${entry.size}`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  const client = await self.clients.get(route.clientId);
  if (!client) return new Response(null, { status: 404 });
  const requestId = crypto.randomUUID();
  const channel = new MessageChannel();
  pending.set(requestId, token);
  let rejectBytes;
  const bytesPromise = new Promise((resolve, reject) => {
    rejectBytes = reject;
    channel.port1.onmessage = (message) => {
      pending.delete(requestId);
      channel.port1.close();
      if (message.data?.error) reject(new Error("Preview range unavailable."));
      else resolve(message.data?.bytes);
    };
    channel.port1.onmessageerror = () => {
      pending.delete(requestId);
      channel.port1.close();
      reject(new Error("Preview range unavailable."));
    };
  });
  client.postMessage({
    type: "read",
    requestId,
    token,
    entryId,
    start: range.start,
    end: range.end,
  }, [channel.port2]);
  const abort = () => {
    pending.delete(requestId);
    client.postMessage({ type: "cancel", requestId });
    channel.port1.close();
    rejectBytes(new Error("Preview range cancelled."));
  };
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    const bytes = await bytesPromise;
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== range.end - range.start) {
      return new Response(null, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
    const headers = previewRangeHeaders(range.start, range.end, entry.size, entry.mime);
    if (!rangeHeader && range.start === 0 && range.end === entry.size) {
      headers.delete("Content-Range");
      return new Response(bytes, { status: 200, headers });
    }
    return new Response(bytes, { status: 206, headers });
  } catch {
    return new Response(null, {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "1" },
    });
  } finally {
    request.signal.removeEventListener("abort", abort);
    pending.delete(requestId);
  }
}
