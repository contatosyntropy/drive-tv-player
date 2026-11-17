
const DRIVE_ROOT_FOLDER_ID = "14dQVrC1byIovscznOp8baAcsBlMY5klA";
let cachedDriveToken = "";
let cachedDriveTokenExpiresAt = 0;
let driveTokenPromise = null;

async function getDriveAccessToken(env) {
  if (cachedDriveToken && Date.now() < cachedDriveTokenExpiresAt - 60000) return cachedDriveToken;
  if (driveTokenPromise) return driveTokenPromise;
  driveTokenPromise = (async () => {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
      throw new Error("Credenciais OAuth do Google Drive incompletas no Worker.");
    }
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: env.GOOGLE_REFRESH_TOKEN,
        grant_type: "refresh_token"
      }).toString()
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
      throw new Error((data.error_description || data.error || "Não foi possível renovar o acesso OAuth.") + " (HTTP " + response.status + ")");
    }
    cachedDriveToken = data.access_token;
    cachedDriveTokenExpiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
    return cachedDriveToken;
  })();
  try { return await driveTokenPromise; }
  finally { driveTokenPromise = null; }
}

async function driveJson(url, accessToken) {
  const response = await fetch(url, {
    headers: { Authorization: "Bearer " + accessToken }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error((data.error && data.error.message) || "Google Drive respondeu com HTTP " + response.status + ".");
    error.status = response.status;
    throw error;
  }
  return data;
}

async function isWithinConfiguredFolder(fileId, accessToken) {
  let currentId = fileId;
  const visited = new Set();
  for (let depth = 0; depth < 30 && currentId; depth++) {
    if (currentId === DRIVE_ROOT_FOLDER_ID) return true;
    if (visited.has(currentId)) return false;
    visited.add(currentId);
    const metadataUrl = new URL("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(currentId));
    metadataUrl.searchParams.set("fields", "id,mimeType,parents,trashed");
    metadataUrl.searchParams.set("supportsAllDrives", "true");
    const metadata = await driveJson(metadataUrl.toString(), accessToken);
    if (metadata.trashed || !metadata.parents || !metadata.parents.length) return false;
    currentId = metadata.parents[0];
  }
  return false;
}

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

async function fetchDriveMedia(request, fileId, accessToken) {
  const headers = new Headers();
  for (const name of ["Range", "If-Range"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("Accept-Encoding", "identity");
  headers.set("Authorization", "Bearer " + accessToken);

  const driveUrl = new URL("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId));
  driveUrl.searchParams.set("alt", "media");
  driveUrl.searchParams.set("supportsAllDrives", "true");
  driveUrl.searchParams.set("acknowledgeAbuse", "true");

  if (request.method === "HEAD") headers.set("Range", "bytes=0-0");

  const primary = await fetch(driveUrl.toString(), {
    method: "GET",
    redirect: "follow",
    headers
  });

  if (primary.status !== 403) return primary;

  // O endpoint usercontent usa uma rota de download alternativa. Reutilizamos
  // exatamente os mesmos cabeçalhos, inclusive Range/If-Range.
  const fallbackUrl = new URL("https://drive.usercontent.google.com/download");
  fallbackUrl.searchParams.set("id", fileId);
  fallbackUrl.searchParams.set("export", "download");
  fallbackUrl.searchParams.set("confirm", "t");

  try {
    const secondary = await fetch(fallbackUrl.toString(), {
      method: "GET",
      redirect: "follow",
      headers
    });
    const secondaryType = secondary.headers.get("Content-Type") || "";
    const isDownload = secondary.ok &&
      !/text\/html|application\/json/i.test(secondaryType);

    if (isDownload) {
      if (primary.body) await primary.body.cancel().catch(() => {});
      return secondary;
    }

    // Se o fallback também reportar a cota, devolve sua resposta JSON para
    // que o app possa identificar downloadQuotaExceeded sem tentar outros MIME.
    let secondaryText = "";
    try { secondaryText = await secondary.clone().text(); } catch (_) {}
    if (secondary.status === 403 && /downloadQuotaExceeded|quota/i.test(secondaryText)) {
      if (primary.body) await primary.body.cancel().catch(() => {});
      return secondary;
    }
    if (secondary.body) await secondary.body.cancel().catch(() => {});
  } catch (_) {
    // Mantém a resposta original do Drive como diagnóstico caso o fallback falhe.
  }

  return primary;
}
async function proxyDriveFile(request, url, fileId, accessToken, mode, fileName = "") {
  try {
    const upstream = await fetchDriveMedia(request, fileId, accessToken);
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
      } else if (mimeOverride === "mkv" || extension === "mkv") {
        responseHeaders.set("Content-Type", "video/x-matroska");
      } else if (mimeOverride === "mp4") {
        responseHeaders.set("Content-Type", "video/mp4");
      } else if (extension !== "webm" && /^video\/webm(?:;|$)/i.test(contentType)) {
        // O Drive pode rotular MKV/outros contêineres como WebM; não propague esse MIME falso.
        responseHeaders.set("Content-Type", "video/x-matroska");
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
      if (url.pathname.startsWith("/api/oauth/")) {
        return new Response("Autorização OAuth já concluída. Esta rota foi desativada.", { status: 410 });
      }

      if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
        return jsonError("Método não permitido.", 405);
      }

      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      if (url.pathname === "/api/oauth/status") {
        if (request.method !== "GET") {
          return jsonError("Método não permitido.", 405);
        }
        return new Response(JSON.stringify({
          hasClientId: Boolean(env.GOOGLE_CLIENT_ID),
          hasClientSecret: Boolean(env.GOOGLE_CLIENT_SECRET),
          hasRefreshToken: Boolean(env.GOOGLE_REFRESH_TOKEN)
        }), {
          status: 200,
          headers: JSON_HEADERS
        });
      }

      let accessToken;
      try {
        accessToken = await getDriveAccessToken(env);
      } catch (error) {
        return jsonError("Falha na autenticação do Google Drive: " + error.message, 502);
      }

      if (url.pathname === "/api/files") {
        const folderId = url.searchParams.get("folderId") || DRIVE_ROOT_FOLDER_ID;
        if (!await isWithinConfiguredFolder(folderId, accessToken)) {
          return jsonError("Pasta fora da biblioteca autorizada.", 403);
        }
        const query = "'" + folderId.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "' in parents and trashed = false";
        const listUrl = new URL("https://www.googleapis.com/drive/v3/files");
        listUrl.searchParams.set("q", query);
        listUrl.searchParams.set("pageSize", "1000");
        listUrl.searchParams.set("orderBy", "name");
        listUrl.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,size,thumbnailLink,webViewLink,parents)");
        listUrl.searchParams.set("supportsAllDrives", "true");
        listUrl.searchParams.set("includeItemsFromAllDrives", "true");
        const pageToken = url.searchParams.get("pageToken");
        if (pageToken) listUrl.searchParams.set("pageToken", pageToken);
        try {
          const data = await driveJson(listUrl.toString(), accessToken);
          return new Response(JSON.stringify(data), { status: 200, headers: JSON_HEADERS });
        } catch (error) {
          return jsonError(error.message, error.status || 502);
        }
      }

      const videoMatch = url.pathname.match(/^\/api\/video\/([A-Za-z0-9_-]+)(?:\/([^/]+))?$/);
      const subtitleMatch = url.pathname.match(/^\/api\/subtitle\/([A-Za-z0-9_-]+)$/);
      const match = videoMatch || subtitleMatch;
      if (!match) return jsonError("Rota de mídia não encontrada.", 404);

      try {
        if (!await isWithinConfiguredFolder(match[1], accessToken)) {
          return jsonError("Arquivo fora da biblioteca autorizada.", 403);
        }
      } catch (error) {
        return jsonError("Não foi possível validar o arquivo no Google Drive: " + error.message, error.status || 502);
      }

      return proxyDriveFile(
        request,
        url,
        match[1],
        accessToken,
        videoMatch ? "video" : "subtitle",
        videoMatch && videoMatch[2] ? decodeURIComponent(videoMatch[2]) : ""
      );
    }

    return env.ASSETS.fetch(request);
  }
};