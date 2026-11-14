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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      if (request.method !== "GET") {
        return jsonError("Método não permitido.", 405);
      }

      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) {
        return jsonError("Origem não autorizada.", 403);
      }

      const match = url.pathname.match(/^\/api\/subtitle\/([A-Za-z0-9_-]+)$/);
      if (!match) {
        return jsonError("Rota de legenda não encontrada.", 404);
      }

      const fileId = match[1];
      const apiKey = url.searchParams.get("key");
      if (!apiKey) {
        return jsonError("Chave da API do Google Drive não informada.", 400);
      }

      const driveUrl = new URL(
        "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId)
      );
      driveUrl.searchParams.set("alt", "media");
      driveUrl.searchParams.set("key", apiKey);

      try {
        const upstream = await fetch(driveUrl.toString(), {
          method: "GET",
          redirect: "follow",
          headers: {
            "Referer": request.headers.get("Referer") || url.origin + "/"
          }
        });

        if (!upstream.ok) {
          const raw = await upstream.text();
          let message = "Google Drive respondeu com HTTP " + upstream.status + ".";
          try {
            const data = JSON.parse(raw);
            message = data.error?.message || message;
          } catch (_) {
            if (raw.trim()) message += " " + raw.trim().slice(0, 240);
          }
          return jsonError(message, 502, { upstreamStatus: upstream.status });
        }

        const contentType = upstream.headers.get("Content-Type") || "";
        if (contentType.includes("application/json")) {
          const data = await upstream.json().catch(() => ({}));
          return jsonError(
            data.error?.message || "O Google Drive retornou uma resposta inesperada.",
            502
          );
        }

        return new Response(upstream.body, {
          status: 200,
          headers: {
            "Content-Type": contentType || "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"
          }
        });
      } catch (error) {
        return jsonError("Falha de comunicação com o Google Drive: " + error.message, 502);
      }
    }

    return env.ASSETS.fetch(request);
  }
};
