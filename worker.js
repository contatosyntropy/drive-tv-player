const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, If-Range, Content-Type",
  "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified"
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

function getCookieHeader(response) {
  const raw = response.headers.get("Set-Cookie") || "";
  const matches = raw.match(/download_warning[^=;,\s]*=[^;,\s]+/gi) || [];
  return matches.join("; ");
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
  // O Drive pode responder com um formulário contendo parâmetros ocultos
  // (confirm, uuid, at etc.). Preserve todos eles na URL final.
  const formMatch = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/i);
  if (formMatch) {
    const formTag = formMatch[0].slice(0, formMatch[0].indexOf(">") + 1);
    const action = getHtmlAttribute(formTag, "action") || baseUrl;
    const target = new URL(action, baseUrl);
    const params = new URLSearchParams(target.search);
    const inputPattern = /<input\b[^>]*>/gi;
    let input;
    while ((input = inputPattern.exec(formMatch[0]))) {
      const name = getHtmlAttribute(input[0], "name");
      const value = getHtmlAttribute(input[0], "value");
      if (name) params.set(name, value);
    }
    if (!params.has("id")) params.set("id", fileId);
    if (!params.has("export")) params.set("export", "download");
    target.search = params.toString();
    return target.toString();
  }

  // Algumas versões apresentam um link em vez de um formulário.
  const anchorPattern = /<a\b[^>]*>/gi;
  let anchor;
  while ((anchor = anchorPattern.exec(html))) {
    const href = getHtmlAttribute(anchor[0], "href");
    if (!href) continue;
    const candidate = new URL(href, baseUrl);
    if (candidate.hostname.endsWith("google.com") &&
        (candidate.searchParams.has("confirm") || candidate.hostname === "drive.usercontent.google.com")) {
      if (!candidate.searchParams.has("id")) candidate.searchParams.set("id", fileId);
      if (!candidate.searchParams.has("export")) candidate.searchParams.set("export", "download");
      return candidate.toString();
    }
  }

  // Tokens também podem aparecer em links/scripts ou inputs fora do form.
  const tokenMatch =
    html.match(/[?&]confirm=([^&"'\s]+)/i) ||
    html.match(/name=["']confirm["'][^>]*value=["']([^"']+)["']/i) ||
    html.match(/["']confirm["']\s*:\s*["']([^"']+)["']/i);
  const token = tokenMatch?.[1] ? decodeHtml(tokenMatch[1]) : "";

  if (token || /download|virus|large file|arquivo muito grande/i.test(html)) {
    const target = new URL("https://drive.usercontent.google.com/download");
    target.searchParams.set("id", fileId);
    target.searchParams.set("export", "download");
    target.searchParams.set("confirm", token || "t");
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
  // Media players precisam de bytes idênticos aos do arquivo original.\n  // Evita compressão automática do upstream, que pode invalidar offsets HTTP Range.\n  rangeHeaders.set("Accept-Encoding", "identity");\n  if (request.method === "HEAD") rangeHeaders.set("Range", "bytes=0-0");

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

    const responseHeaders = new Headers(CORS_HEADERS);
    for (const name of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Content-Encoding", "ETag", "Last-Modified"]) {
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

      // O app webOS instalado pode executar em origem local (file://).
      // O proxy entrega apenas arquivos já compartilhados no Google Drive.
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
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
