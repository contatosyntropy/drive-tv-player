const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Range, If-Range, Content-Type",
  "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, Content-Type, Content-Encoding, ETag, Last-Modified"
};

const JSON_HEADERS = {
  ...CORS_HEADERS,
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff"
};

function jsonError(message, status = 502, details = {}) {
  return new Response(JSON.stringify({ error: message, ...details }), {
    status,
    headers: JSON_HEADERS
  });
}

async function fetchDriveMedia(request, fileId, apiKey) {
  const headers = new Headers();
  for (const name of ["Range", "If-Range"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("Accept-Encoding", "identity");

  const driveUrl = new URL("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId));
  driveUrl.searchParams.set("alt", "media");
  driveUrl.searchParams.set("key", apiKey);
  driveUrl.searchParams.set("supportsAllDrives", "true");
  driveUrl.searchParams.set("acknowledgeAbuse", "true");

  if (request.method === "HEAD") headers.set("Range", "bytes=0-0");

  return fetch(driveUrl.toString(), {
    method: "GET",
    redirect: "follow",
    headers
  });
}

async function proxyDriveFile(request, url, fileId, apiKey, mode, fileName = "") {
  try {
    const upstream = await fetchDriveMedia(request, fileId, apiKey);
    const contentType = upstream.headers.get("Content-Type") || "";
    if (!upstream.ok && contentType.includes("application/json")) {
      const data = await upstream.json().catch(() => ({}));
      return jsonError(
        (data.error && data.error.message) || "Google Drive respondeu com HTTP " + upstream.status + ".",
        upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502,
        { upstreamStatus: upstream.status }
      );
    }

    if (upstream.ok && contentType.includes("application/json")) {
      const data = await upstream.json().catch(() => ({}));
      return jsonError((data.error && data.error.message) || "O Google Drive retornou uma resposta inesperada.", 502);
    }

    const responseHeaders = new Headers(CORS_HEADERS);
    for (const name of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Content-Encoding", "ETag", "Last-Modified"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }

    if (mode === "video") {
      const extensionMatch = fileName.match(/\.([^.]+)$/);
      const extension = extensionMatch ? extensionMatch[1].toLowerCase() : "";
      const mimeTypes = {
        mkv: "video/x-matroska",
        webm: "video/webm",
        mp4: "video/mp4",
        m4v: "video/mp4",
        mov: "video/mp4",
        avi: "video/x-msvideo",
        mpg: "video/mpeg",
        mpeg: "video/mpeg",
        ts: "video/mp2t"
      };
      const mimeOverride = url.searchParams.get("mime");
      if (mimeOverride === "octet") {
        responseHeaders.set("Content-Type", "application/octet-stream");
      } else if (mimeOverride === "mp4") {
        responseHeaders.set("Content-Type", "video/mp4");
      } else if (mimeTypes[extension]) {
        responseHeaders.set("Content-Type", mimeTypes[extension]);
      }
      responseHeaders.set("Accept-Ranges", "bytes");
      responseHeaders.set("Content-Disposition", "inline");
    }

    responseHeaders.set("Cache-Control", "no-store, no-transform");
    responseHeaders.set("X-Content-Type-Options", "nosniff");

    if (request.method === "HEAD") {
      const contentRange = upstream.headers.get("Content-Range") || "";
      const totalSize = contentRange.split("/").pop();
      if (totalSize && Number.isFinite(Number(totalSize))) responseHeaders.set("Content-Length", totalSize);
      responseHeaders.delete("Content-Range");
      if (upstream.body) await upstream.body.cancel();
      return new Response(null, { status: 200, headers: responseHeaders });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders
    });
  } catch (error) {
    return jsonError("Falha de comunicação com o Google Drive: " + error.message, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
        return jsonError("Método não permitido.", 405);
      }

      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      const videoMatch = url.pathname.match(/^\/api\/video\/([A-Za-z0-9_-]+)(?:\/([^/]+))?$/);
      const subtitleMatch = url.pathname.match(/^\/api\/subtitle\/([A-Za-z0-9_-]+)$/);
      const match = videoMatch || subtitleMatch;
      if (!match) return jsonError("Rota de mídia não encontrada.", 404);

      const apiKey = url.searchParams.get("key");
      if (!apiKey) return jsonError("Chave da API do Google Drive não informada.", 400);

      return proxyDriveFile(
        request,
        url,
        match[1],
        apiKey,
        videoMatch ? "video" : "subtitle",
        videoMatch && videoMatch[2] ? decodeURIComponent(videoMatch[2]) : ""
      );
    }

    return env.ASSETS.fetch(request);
  }
};