const JSON_HEADERS = {
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

function getCookieHeader(response) {
  const raw = response.headers.get("Set-Cookie") || "";
  const match = raw.match(/(download_warning[^=;,]*=[^;,\s]+)/i);
  return match ? match[1] : "";
}

function decodeHtml(value) {
  return value.replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function getHtmlAttribute(tag, attribute) {
  const escaped = attribute.replace(/[.*+?^{}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp("(?:^|\\s)" + escaped + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i"));
  return match ? decodeHtml(match[1] ?? match[2] ?? match[3] ?? "") : "";
}

function parseDownloadForm(html, fileId, baseUrl) {
  const formMatch = html.match(/<form\b[^>]*>([\s\S]*?)<\/form>/i);
  if (formMatch) {
    const formTag = formMatch[0].slice(0, formMatch[0].indexOf(">") + 1);
    const action = getHtmlAttribute(formTag, "action") || baseUrl;
    const target = new URL(action, baseUrl);
    const params = new URLSearchParams(target.search);
    const inputPattern = /<input\b[^>]*>/gi;
    let input;
    while ((input = inputPattern.exec(formMatch[1]))) {
      const name = getHtmlAttribute(input[0], "name");
      const value = getHtmlAttribute(input[0], "value");
      if (name) params.set(name, value);
    }
    if (!params.has("id")) params.set("id", fileId);
    if (!params.has("export")) params.set("export", "download");
    target.search = params.toString();
    return target.toString();
  }

  // Algumas versões do Drive apresentam o link de confirmação em vez de um form.
  const hrefPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let anchor;
  while ((anchor = hrefPattern.exec(html))) {
    const href = decodeHtml(anchor[1]);
    if (/confirm=|drive\.usercontent\.google\.com\/download/i.test(href)) {
      return new URL(href, baseUrl).toString();
    }
  }

  const confirm = html.match(/[?&]confirm=([\\w-]+)/i)?.[1] ||
    html.match(/name=["']confirm["']\s+value=["']([^"']+)["']/i)?.[1];
  if (confirm) {
    const target = new URL("https://drive.usercontent.google.com/download");
    target.searchParams.set("id", fileId);
    target.searchParams.set("export", "download");
    target.searchParams.set("confirm", confirm);
    return target.toString();
  }

  // O Drive usa o token "t" em algumas páginas de confirmação simplificadas.
  if (/download|virus|large file|arquivo muito grande/i.test(html)) {
    const target = new URL("https://drive.usercontent.google.com/download");
    target.searchParams.set("id", fileId);
    target.searchParams.set("export", "download");
    target.searchParams.set("confirm", "t");
    return target.toString();
  }
  return null;
}

async function fetchDriveMedia(request, url, fileId, apiKey, mode, fileName) {
  const rangeHeaders = new Headers();
  for (const name of ["Range", "If-Range"]) {
    const value = request.headers.get(name);
    if (value) rangeHeaders.set(name, value);
  }
  if (request.method === "HEAD") rangeHeaders.set("Range", "bytes=0-0");

  // Legendas continuam usando a API oficial. Vídeos usam o endpoint de
  // download do Drive, que permite tratar a confirmação de arquivos grandes.
  if (mode !== "video") {
    const apiUrl = new URL("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId));
    apiUrl.searchParams.set("alt", "media");
    apiUrl.searchParams.set("key", apiKey);
    return fetch(apiUrl.toString(), { method: "GET", redirect: "follow", headers: rangeHeaders });
  }

  const downloadUrl = new URL("https://drive.google.com/uc");
  downloadUrl.searchParams.set("export", "download");
  downloadUrl.searchParams.set("id", fileId);

  const initial = await fetch(downloadUrl.toString(), {
    method: "GET",
    redirect: "follow",
    headers: rangeHeaders
  });
  const initialType = initial.headers.get("Content-Type") || "";
  if (!initialType.toLowerCase().includes("text/html")) return initial;

  const html = await initial.text();
  const confirmedUrl = parseDownloadForm(html, fileId, initial.url || downloadUrl.toString());
  if (!confirmedUrl) {
    return jsonError(
      "O Google Drive apresentou uma página intermediária, mas não foi possível identificar a confirmação de download. Verifique se o arquivo está compartilhado para qualquer pessoa com o link.",
      502,
      { upstreamStatus: initial.status, upstreamContentType: initialType }
    );
  }

  const cookie = getCookieHeader(initial);
  const confirmedHeaders = new Headers(rangeHeaders);
  confirmedHeaders.set("Referer", initial.url || downloadUrl.toString());
  if (cookie) confirmedHeaders.set("Cookie", cookie);

  const confirmed = await fetch(confirmedUrl, {
    method: "GET",
    redirect: "follow",
    headers: confirmedHeaders
  });
  const confirmedType = (confirmed.headers.get("Content-Type") || "").toLowerCase();
  if (confirmedType.includes("text/html")) {
    const body = await confirmed.text();
    return jsonError(
      "O Google Drive não liberou o conteúdo do arquivo após a confirmação de download.",
      502,
      { upstreamStatus: confirmed.status, responsePreview: body.slice(0, 300) }
    );
  }
  return confirmed;
}

async function proxyDriveFile(request, url, fileId, apiKey, mode, fileName = "") {
  try {
    const upstream = await fetchDriveMedia(request, url, fileId, apiKey, mode, fileName);
    const contentType = upstream.headers.get("Content-Type") || "";
    if (!upstream.ok && contentType.includes("application/json")) {
      const data = await upstream.json().catch(() => ({}));
      return jsonError(
        data.error?.message || "Google Drive respondeu com HTTP " + upstream.status + ".",
        upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502,
        { upstreamStatus: upstream.status }
      );
    }

    if (upstream.ok && contentType.includes("application/json")) {
      const data = await upstream.json().catch(() => ({}));
      return jsonError(data.error?.message || "O Google Drive retornou uma resposta inesperada.", 502);
    }

    const responseHeaders = new Headers();
    for (const name of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    if (mode === "video") {
      const extension = (fileName.match(/\.([^.]+)$/) || [])[1]?.toLowerCase();
      const mimeTypes = {
        mkv: "video/x-matroska", mp4: "video/mp4", m4v: "video/mp4",
        webm: "video/webm", mov: "video/quicktime", avi: "video/x-msvideo",
        mpg: "video/mpeg", mpeg: "video/mpeg", ts: "video/mp2t"
      };
      if (mimeTypes[extension]) responseHeaders.set("Content-Type", mimeTypes[extension]);
      responseHeaders.set("Content-Disposition", "inline");
    }
    responseHeaders.set("Cache-Control", "no-store");
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
      if (request.method !== "GET" && request.method !== "HEAD") {
        return jsonError("Método não permitido.", 405);
      }

      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) {
        return jsonError("Origem não autorizada.", 403);
      }

      const videoMatch = url.pathname.match(/^\/api\/video\/([A-Za-z0-9_-]+)(?:\/([^/]+))?$/);
      const subtitleMatch = url.pathname.match(/^\/api\/subtitle\/([A-Za-z0-9_-]+)$/);
      const match = videoMatch || subtitleMatch;
      if (!match) {
        return jsonError("Rota de mídia não encontrada.", 404);
      }

      const apiKey = url.searchParams.get("key");
      if (!apiKey) {
        return jsonError("Chave da API do Google Drive não informada.", 400);
      }

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
