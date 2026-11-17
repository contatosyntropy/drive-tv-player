// Deploy trigger: ensure PROBE_LOGS KV binding configuration is picked up.
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

  const driveUrl = new URL(
    "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId)
  );
  driveUrl.searchParams.set("alt", "media");
  driveUrl.searchParams.set("key", apiKey);
  driveUrl.searchParams.set("supportsAllDrives", "true");

  if (request.method === "HEAD") headers.set("Range", "bytes=0-0");

  return fetch(driveUrl.toString(), {
    method: "GET",
    redirect: "follow",
    headers
  });
}

async function proxyDriveFile(request, fileId, apiKey, mode, fileName = "") {
  try {
    const upstream = await fetchDriveMedia(request, fileId, apiKey);
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
      const mimeOverride = new URL(request.url).searchParams.get("mime");
      const extension = (fileName.match(/\.([^.]+)$/) || [])[1]?.toLowerCase();
      const mimeTypes = {
        mkv: "video/webm",
        webm: "video/webm",
        mp4: "video/mp4",
        m4v: "video/mp4",
        mov: "video/mp4",
        avi: "video/x-msvideo",
        mpg: "video/mpeg",
        mpeg: "video/mpeg",
        ts: "video/mp2t"
      };
      if (mimeOverride === "matroska") {
        responseHeaders.set("Content-Type", "video/x-matroska");
      } else if (mimeOverride === "mp4") {
        responseHeaders.set("Content-Type", "video/mp4");      } else if (mimeTypes[extension]) {
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

    if (url.pathname === "/api/probe-log/status" && request.method === "GET") {
      if (env.PROBE_LOG_STORE) {
        const storeId = env.PROBE_LOG_STORE.idFromName("global");
        const store = env.PROBE_LOG_STORE.get(storeId);
        const latest = await store.fetch("https://probe-log-store/latest");
        return new Response(JSON.stringify({
          worker: "drive-tv-player",
          storage: "durable-object",
          durableObjectBinding: true,
          kvBinding: !!env.PROBE_LOGS,
          latestStatus: latest.status,
          latestAvailable: latest.ok
        }), { status: 200, headers: JSON_HEADERS });
      }
      return new Response(JSON.stringify({
        worker: "drive-tv-player",
        storage: env.PROBE_LOGS ? "kv-fallback" : "unconfigured",
        durableObjectBinding: false,
        kvBinding: !!env.PROBE_LOGS
      }), { status: 200, headers: JSON_HEADERS });
    }

    if (url.pathname === "/api/probe-log" && request.method === "POST") {
      try {
        const report = await request.text();
        if (!report || report.length > 24000) {
          return jsonError("Relatório vazio ou maior que 24 KB.", 413);
        }
        const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ";
        const random = new Uint8Array(8);
        crypto.getRandomValues(random);
        const id = Array.from(random, byte => alphabet[byte % alphabet.length]).join("");
        const reportUrl = new URL("/api/probe-log/" + id, url.origin);
        const storedReport = report + "\nREPORT_ID=" + id;

        if (env.PROBE_LOG_STORE) {
          const storeId = env.PROBE_LOG_STORE.idFromName("global");
          const store = env.PROBE_LOG_STORE.get(storeId);
          const saved = await store.fetch("https://probe-log-store/report/" + id, {
            method: "PUT",
            body: storedReport
          });
          if (!saved.ok) throw new Error("Durable Object storage returned HTTP " + saved.status);
        } else if (env.PROBE_LOGS) {
          await env.PROBE_LOGS.put("report:" + id, storedReport, { expirationTtl: 86400 });
          await env.PROBE_LOGS.put("latest", id, { expirationTtl: 86400 });
        } else {
          throw new Error("PROBE_LOG_STORE binding is not configured.");
        }
        return new Response(JSON.stringify({
          id,
          url: reportUrl.toString(),
          storage: env.PROBE_LOG_STORE ? "durable-object" : (env.PROBE_LOGS ? "kv-fallback" : "unconfigured"),
          expiresIn: 86400
        }), {
          status: 201,
          headers: JSON_HEADERS
        });
      } catch (error) {
        return jsonError("Não foi possível armazenar o diagnóstico: " + error.message, 500);
      }
    }

    if (url.pathname === "/api/probe-log/latest" && request.method === "GET") {
      if (env.PROBE_LOG_STORE) {
        const storeId = env.PROBE_LOG_STORE.idFromName("global");
        const store = env.PROBE_LOG_STORE.get(storeId);
        const result = await store.fetch("https://probe-log-store/latest");
        return new Response(result.body, {
          status: result.status,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"
          }
        });
      }
      if (env.PROBE_LOGS) {
        const id = await env.PROBE_LOGS.get("latest");
        if (!id) return jsonError("Ainda não há diagnóstico recente.", 404);
        const report = await env.PROBE_LOGS.get("report:" + id);
        if (!report) return jsonError("Diagnóstico recente expirado ou ainda não sincronizado.", 404);
        return new Response(report, {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"
          }
        });
      }
      return jsonError("Armazenamento de diagnósticos não configurado.", 503);
    }

    const probeLogMatch = url.pathname.match(/^\/api\/probe-log\/([A-Z]{8})$/);
    if (probeLogMatch && request.method === "GET") {
      let report = null;
      if (env.PROBE_LOG_STORE) {
        const storeId = env.PROBE_LOG_STORE.idFromName("global");
        const store = env.PROBE_LOG_STORE.get(storeId);
        const result = await store.fetch("https://probe-log-store/report/" + probeLogMatch[1]);
        report = result.ok ? await result.text() : null;
      } else if (env.PROBE_LOGS) {
        report = await env.PROBE_LOGS.get("report:" + probeLogMatch[1]);
      }
      if (!report) return jsonError("Relatório não encontrado ou expirado.", 404);
      return new Response(report, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        }
      });
    }

    if (url.pathname.startsWith("/api/")) {
      if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
        return jsonError("Método não permitido.", 405);
      }

      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      if (url.pathname === "/api/reference-mkv") {
        const headers = new Headers({ "Accept-Encoding": "identity" });
        for (const name of ["Range", "If-Range"]) {
          const value = request.headers.get(name);
          if (value) headers.set(name, value);
        }
        try {
          const upstream = await fetch(
            "https://pnb-website-bucket.s3.us-east-2.amazonaws.com/samples/videos/mkv/sample-video-480x270-1mb.mkv",
            { method: request.method, headers, redirect: "follow" }
          );
          const responseHeaders = new Headers(CORS_HEADERS);
          for (const name of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Content-Encoding", "ETag", "Last-Modified"]) {
            const value = upstream.headers.get(name);
            if (value) responseHeaders.set(name, value);
          }
          responseHeaders.set("Cache-Control", "no-store, no-transform");
          if (request.method === "HEAD") {
            if (upstream.body) await upstream.body.cancel();
            return new Response(null, { status: upstream.status, headers: responseHeaders });
          }
          return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
        } catch (error) {
          return jsonError("Falha ao consultar o MKV externo de referência: " + error.message, 502);
        }
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
        match[1],
        apiKey,
        videoMatch ? "video" : "subtitle",
        videoMatch && videoMatch[2] ? decodeURIComponent(videoMatch[2]) : ""
      );
    }

    return env.ASSETS.fetch(request);
  }
};

export class ProbeLogStore {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const reportMatch = url.pathname.match(/^\/report\/([A-Z]{8})$/);

    if (request.method === "PUT" && reportMatch) {
      const report = await request.text();
      if (!report || report.length > 24000) {
        return new Response("Invalid diagnostic report.", { status: 413 });
      }
      await this.ctx.storage.put("report:" + reportMatch[1], report);
      await this.ctx.storage.put("latest", reportMatch[1]);
      return new Response("stored", { status: 201 });
    }

    if (request.method === "GET" && url.pathname === "/latest") {
      const id = await this.ctx.storage.get("latest");
      if (!id) return new Response("Ainda não há diagnóstico recente.", { status: 404 });
      const report = await this.ctx.storage.get("report:" + id);
      if (!report) return new Response("Diagnóstico recente não encontrado.", { status: 404 });
      return new Response(report, { status: 200 });
    }

    if (request.method === "GET" && reportMatch) {
      const report = await this.ctx.storage.get("report:" + reportMatch[1]);
      return report
        ? new Response(report, { status: 200 })
        : new Response("Relatório não encontrado ou expirado.", { status: 404 });
    }

    return new Response("Not found.", { status: 404 });
  }
}