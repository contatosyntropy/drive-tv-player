
const DRIVE_ROOT_FOLDER_ID = "14dQVrC1byIovscznOp8baAcsBlMY5klA";
let cachedDriveToken = "";
let cachedDriveTokenExpiresAt = 0;
let driveTokenPromise = null;

async function getDriveAccessToken(env) {
  const clientId = String(env?.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(env?.GOOGLE_CLIENT_SECRET || "").trim();
  const refreshToken = String(env?.GOOGLE_REFRESH_TOKEN || "").trim();

  if (!clientId || !clientSecret || !refreshToken) {
    const error = new Error("Credenciais OAuth do Google Drive incompletas no Worker.");
    error.googleError = "missing_oauth_credentials";
    error.googleErrorDescription = "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e GOOGLE_REFRESH_TOKEN são obrigatórios.";
    throw error;
  }

  if (cachedDriveToken && Date.now() < cachedDriveTokenExpiresAt - 60000) return cachedDriveToken;
  if (driveTokenPromise) return driveTokenPromise;
  driveTokenPromise = (async () => {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token"
      }).toString()
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
      const error = new Error(data.error_description || data.error || "Não foi possível renovar o acesso OAuth.");
      error.googleError = data.error || "oauth_token_request_failed";
      error.googleErrorDescription = data.error_description || "";
      error.upstreamStatus = response.status;
      throw error;
    }
    cachedDriveToken = data.access_token;
    cachedDriveTokenExpiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
    return cachedDriveToken;
  })();
  try { return await driveTokenPromise; }
  finally { driveTokenPromise = null; }
}

async function driveJson(url, env) {
  const accessToken = await getDriveAccessToken(env);
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

// A validação de pertencimento é repetida em cada requisição HTTP Range.
 // Mantemos somente autorizações positivas por um período curto para evitar
 // consultas de metadados redundantes durante a reprodução e os seeks.
const folderValidationCache = new Map();
const folderValidationInFlight = new Map();
const FOLDER_VALIDATION_TTL_MS = 60 * 1000;
const FOLDER_VALIDATION_CACHE_LIMIT = 500;

function cacheAuthorizedFile(fileId) {
  if (!fileId) return;
  const now = Date.now();
  for (const [key, entry] of folderValidationCache) {
    if (entry.expiresAt <= now) folderValidationCache.delete(key);
  }
  if (!folderValidationCache.has(fileId)) {
    while (folderValidationCache.size >= FOLDER_VALIDATION_CACHE_LIMIT) {
      const oldestKey = folderValidationCache.keys().next().value;
      if (oldestKey === undefined) break;
      folderValidationCache.delete(oldestKey);
    }
  } else {
    folderValidationCache.delete(fileId);
  }
  folderValidationCache.set(fileId, { expiresAt: now + FOLDER_VALIDATION_TTL_MS });
}

async function isWithinConfiguredFolder(fileId, env) {
  if (!fileId) return false;

  const now = Date.now();
  const cached = folderValidationCache.get(fileId);
  if (cached && cached.expiresAt > now) {
    // Atualiza a posição no Map para manter os itens mais usados.
    folderValidationCache.delete(fileId);
    folderValidationCache.set(fileId, cached);
    return true;
  }
  if (cached) folderValidationCache.delete(fileId);

  const pending = folderValidationInFlight.get(fileId);
  if (pending) return pending;

  const validation = (async () => {
    let currentId = fileId;
    const visited = new Set();
    let allowed = false;

    for (let depth = 0; depth < 30 && currentId; depth++) {
      if (currentId === DRIVE_ROOT_FOLDER_ID) {
        allowed = true;
        break;
      }
      if (visited.has(currentId)) break;
      visited.add(currentId);

      const metadataUrl = new URL("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(currentId));
      metadataUrl.searchParams.set("fields", "id,mimeType,parents,trashed");
      metadataUrl.searchParams.set("supportsAllDrives", "true");
      const metadata = await driveJson(metadataUrl.toString(), env);
      if (metadata.trashed || !metadata.parents || !metadata.parents.length) break;
      currentId = metadata.parents[0];
    }

    // Não armazenamos recusas nem erros: somente uma autorização confirmada.
    if (allowed) cacheAuthorizedFile(fileId);

    return allowed;
  })();

  folderValidationInFlight.set(fileId, validation);
  try {
    return await validation;
  } finally {
    folderValidationInFlight.delete(fileId);
  }
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

async function fetchDriveMedia(request, fileId, env) {
  const accessToken = await getDriveAccessToken(env);
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
async function proxyDriveFile(request, url, fileId, env, mode, fileName = "") {
  try {
    const upstream = await fetchDriveMedia(request, fileId, env);
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
    return jsonError("Falha de comunicação com o Google Drive: " + error.message, 502, error.googleError ? { error: error.googleError, error_description: error.googleErrorDescription || "" } : {});
  }
}


const PUBLIC_PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "public, max-age=3600",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
};

function publicPage(title, content) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="index,follow">
  <title>${title} — Drive TV Player</title>
  <style>
    :root{color-scheme:dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#10131a;color:#e8edf5}
    *{box-sizing:border-box}body{margin:0;padding:40px 18px;line-height:1.65}
    main{max-width:820px;margin:0 auto;background:#191f2b;border:1px solid #30394a;border-radius:18px;padding:clamp(22px,5vw,48px)}
    header{margin-bottom:32px}a{color:#9abaff}nav{display:flex;gap:18px;flex-wrap:wrap;margin:18px 0 30px}
    h1{font-size:clamp(1.8rem,5vw,2.5rem);line-height:1.2;margin:0 0 8px}
    h2{font-size:1.2rem;margin:30px 0 8px;color:#fff}p,li{color:#c7d0df}
    .eyebrow{color:#9abaff;font-size:.82rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
    footer{margin-top:36px;padding-top:18px;border-top:1px solid #30394a;color:#9aa7ba;font-size:.9rem}
  </style>
</head>
<body>
<main>
  <header><div class="eyebrow">Aplicativo pessoal</div><h1>Drive TV Player</h1><p>Reprodução de vídeos da biblioteca do Google Drive em uma televisão LG com webOS.</p></header>
  <nav aria-label="Navegação principal"><a href="/">Início</a><a href="/privacy">Política de Privacidade</a><a href="/terms">Termos de Serviço</a></nav>
  <article><h1>${title}</h1>${content}</article>
  <footer>Drive TV Player · Última atualização: 26 de novembro de 2026</footer>
</main>
</body>
</html>`;
}

const PUBLIC_PAGES = {
  "/": publicPage("Sobre o aplicativo", `
    <p>O Drive TV Player é um aplicativo de uso pessoal que permite navegar por uma pasta selecionada do Google Drive e reproduzir na televisão vídeos e arquivos de legenda armazenados nessa biblioteca.</p>
    <p>Para funcionar, o aplicativo utiliza a autorização da conta Google do próprio usuário. Os nomes, identificadores e metadados dos arquivos são consultados para montar a biblioteca; o conteúdo de vídeo e das legendas é transmitido sob solicitação para a televisão.</p>
    <p>O aplicativo não oferece catálogo próprio, não hospeda vídeos e não disponibiliza conteúdo de terceiros. O usuário escolhe os arquivos a partir do seu próprio Google Drive.</p>
    <p>Leia como os dados são tratados na <a href="/privacy">Política de Privacidade</a> e as condições de uso nos <a href="/terms">Termos de Serviço</a>.</p>
  `),
  "/privacy": publicPage("Política de Privacidade", `
    <p>Esta Política de Privacidade descreve como o Drive TV Player acessa e trata informações quando o usuário conecta sua conta Google para reproduzir arquivos do Google Drive.</p>
    <h2>Informações acessadas</h2>
    <p>Mediante autorização do usuário, o aplicativo acessa informações necessárias para localizar e reproduzir arquivos dentro da biblioteca configurada no Google Drive, incluindo nomes, identificadores, tipos, tamanhos, pastas e metadados disponíveis dos arquivos. Quando solicitado, também acessa o conteúdo dos vídeos e arquivos de legenda escolhidos pelo usuário.</p>
    <h2>Como as informações são utilizadas</h2>
    <p>Essas informações são utilizadas exclusivamente para listar a biblioteca, validar que os arquivos pertencem à pasta configurada e transmitir o vídeo ou a legenda para o dispositivo de reprodução. O aplicativo não utiliza os dados do Google para publicidade, perfilamento ou venda de informações.</p>
    <h2>Armazenamento e compartilhamento</h2>
    <p>O Drive TV Player não mantém uma cópia própria dos vídeos ou das legendas nem oferece armazenamento permanente do conteúdo. As solicitações passam pelo serviço de infraestrutura Cloudflare e pelos serviços do Google necessários para autenticação e acesso ao Drive. As credenciais OAuth usadas pelo serviço são mantidas como segredos de ambiente do Worker e não são exibidas na interface do player.</p>
    <p>O aplicativo não vende dados pessoais nem compartilha dados do Google com terceiros para finalidades independentes. O tráfego é processado apenas para fornecer a funcionalidade solicitada pelo usuário e pela infraestrutura técnica envolvida.</p>
    <h2>Controle e revogação do acesso</h2>
    <p>O usuário pode revogar a autorização do aplicativo nas configurações de segurança da Conta Google, na seção de conexões com apps e serviços de terceiros. A remoção das credenciais OAuth configuradas no serviço também interrompe o acesso ao Drive.</p>
    <h2>Segurança</h2>
    <p>As comunicações com o Google e com o serviço de reprodução utilizam HTTPS. Nenhum sistema de transmissão pela internet pode garantir segurança absoluta, mas o aplicativo busca limitar o acesso aos arquivos à biblioteca configurada e utilizar as credenciais apenas no servidor.</p>
    <h2>Dados de crianças</h2>
    <p>O aplicativo é uma ferramenta de uso pessoal e não é direcionado a crianças.</p>
    <h2>Alterações e contato</h2>
    <p>Esta política poderá ser atualizada para refletir mudanças no funcionamento do aplicativo. A versão vigente estará disponível nesta página.</p>
    <p>O uso e a transferência de informações recebidas das APIs do Google para qualquer outro aplicativo seguirão a <a href="https://developers.google.com/terms/api-services-user-data-policy" rel="noopener noreferrer">Política de Dados do Usuário dos Serviços de API do Google</a>, incluindo os requisitos de uso limitado (Limited Use).</p>
  `),
  "/terms": publicPage("Termos de Serviço", `
    <h2>1. Finalidade</h2>
    <p>O Drive TV Player é uma ferramenta de uso pessoal destinada a navegar e reproduzir, em dispositivos compatíveis, arquivos que o próprio usuário pode acessar em sua conta Google Drive.</p>
    <h2>2. Conta e autorização</h2>
    <p>O usuário é responsável pela conta Google conectada, pela autorização concedida ao aplicativo e pela proteção de suas credenciais. O acesso depende da disponibilidade dos serviços do Google e da Cloudflare.</p>
    <h2>3. Direitos sobre o conteúdo</h2>
    <p>O usuário declara que possui os direitos ou as permissões necessárias para acessar e reproduzir os arquivos selecionados. O aplicativo não concede licença sobre vídeos, áudios, legendas ou quaisquer outros conteúdos armazenados no Google Drive.</p>
    <h2>4. Uso permitido</h2>
    <p>O aplicativo deve ser utilizado de forma lícita e pessoal. É proibido utilizá-lo para violar direitos autorais, contornar controles de acesso, acessar arquivos sem autorização ou prejudicar os serviços de terceiros.</p>
    <h2>5. Disponibilidade</h2>
    <p>O aplicativo é fornecido no estado em que se encontra, sem garantia de disponibilidade contínua, compatibilidade com todos os formatos ou funcionamento ininterrupto. Alterações nas APIs, nos serviços de terceiros, na rede ou nos dispositivos podem afetar a reprodução.</p>
    <h2>6. Serviços de terceiros</h2>
    <p>O funcionamento depende de serviços fornecidos pelo Google e pela Cloudflare, que possuem termos e políticas próprios. O Drive TV Player não controla nem garante a disponibilidade desses serviços.</p>
    <h2>7. Limitação de responsabilidade</h2>
    <p>Na máxima extensão permitida pela legislação aplicável, o responsável pelo aplicativo não será responsável por indisponibilidades, perda de acesso decorrente de serviços de terceiros ou uso não autorizado da conta ou dos conteúdos pelo próprio usuário.</p>
    <h2>8. Alterações dos termos</h2>
    <p>Estes termos podem ser atualizados quando necessário. A versão vigente será publicada nesta página. O uso continuado do aplicativo após uma atualização representa ciência dos termos revisados.</p>
  `)
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
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

      if (url.pathname === "/api/oauth/start") {
        if (env && env.GOOGLE_REFRESH_TOKEN) {
          return new Response("GOOGLE_REFRESH_TOKEN já está configurado. Remova temporariamente o secret para iniciar uma nova autorização.", { status: 403 });
        }
        if (!env || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
          return new Response("Configure GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET na Cloudflare antes de acessar.", { status: 400 });
        }
        const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
        authUrl.searchParams.set("redirect_uri", url.origin + "/api/oauth/callback");
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/drive.readonly");
        authUrl.searchParams.set("access_type", "offline");
        authUrl.searchParams.set("prompt", "consent");
        return Response.redirect(authUrl.toString(), 302);
      }

      if (url.pathname === "/api/oauth/callback") {
        if (env && env.GOOGLE_REFRESH_TOKEN) {
          return new Response("GOOGLE_REFRESH_TOKEN já está configurado. O fluxo de autorização está bloqueado.", { status: 403 });
        }
        if (!env || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
          return new Response("Credenciais OAuth incompletas no Worker.", { status: 400 });
        }
        const code = url.searchParams.get("code");
        if (!code) {
          return new Response("Autorização não concluída: " + (url.searchParams.get("error") || "código ausente"), { status: 400 });
        }
        const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            redirect_uri: url.origin + "/api/oauth/callback",
            grant_type: "authorization_code"
          }).toString()
        });
        const data = await tokenResp.json().catch(() => ({}));
        if (!tokenResp.ok || !data.refresh_token) {
          return new Response("Falha ao obter Refresh Token. HTTP " + tokenResp.status + ": " + (data.error_description || data.error || "o Google não retornou refresh_token."), { status: 400 });
        }
        return new Response(
          "<!doctype html><html lang=\"pt-BR\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Token gerado</title><body style=\"font:16px system-ui;max-width:760px;margin:48px auto;padding:0 20px;background:#10131a;color:#e8edf5\"><h1>Autorização concluída</h1><p>Copie o valor abaixo e salve-o no Cloudflare como o secret <strong>GOOGLE_REFRESH_TOKEN</strong>. Não compartilhe este valor.</p><textarea readonly style=\"width:100%;min-height:130px;padding:12px;box-sizing:border-box\">" + data.refresh_token + "</textarea><p>Depois de salvar o novo secret, teste <a style=\"color:#9abaff\" href=\"/api/files\">/api/files</a>. Esta página contém uma credencial privada.</p></body></html>",
          { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } }
        );
      }

      if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
        return jsonError("Método não permitido.", 405);
      }

      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      if (url.pathname === "/api/files") {
        const folderId = url.searchParams.get("folderId") || DRIVE_ROOT_FOLDER_ID;
        if (!await isWithinConfiguredFolder(folderId, env)) {
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
          const data = await driveJson(listUrl.toString(), env);

          // A consulta já foi limitada a filhos diretos de uma pasta autorizada.
          // Pré-autoriza esses IDs para que a primeira abertura do vídeo não
          // precise fazer outra consulta de metadados antes do streaming.
          for (const file of data.files || []) {
            if (file.id && Array.isArray(file.parents) && file.parents.includes(folderId)) {
              cacheAuthorizedFile(file.id);
            }
          }

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
        if (!await isWithinConfiguredFolder(match[1], env)) {
          return jsonError("Arquivo fora da biblioteca autorizada.", 403);
        }
      } catch (error) {
        return jsonError("Não foi possível validar o arquivo no Google Drive: " + error.message, error.status || 502, error.googleError ? { error: error.googleError, error_description: error.googleErrorDescription || "" } : {});
      }

      return proxyDriveFile(
        request,
        url,
        match[1],
        env,
        videoMatch ? "video" : "subtitle",
        videoMatch && videoMatch[2] ? decodeURIComponent(videoMatch[2]) : ""
      );
    }

    const publicPageHtml = PUBLIC_PAGES[url.pathname];
    if (publicPageHtml) {
      return new Response(publicPageHtml, { status: 200, headers: PUBLIC_PAGE_HEADERS });
    }

    return env.ASSETS.fetch(request);
  }
};