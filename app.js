(() => {
  const config = window.APP_CONFIG || {};
  const grid = document.getElementById("videos");
  const message = document.getElementById("message");
  const status = document.getElementById("status");
  const player = document.getElementById("player");
  const video = document.getElementById("video");
  const nowPlaying = document.getElementById("now-playing");
  const supported = /\.(mp4|m4v|webm|ogv|ogg|mov|mkv)$/i;
  const subtitlePattern = /\.(srt|vtt)$/i;

  let items = [];
  let subtitleFiles = [];
  let folders = [];
  let currentFolderId = config.folderId;
  let visibleVideos = [];
  let subtitleUrl = null;
  let subtitleLoadToken = 0;

  const formatSize = bytes => {
    if (!bytes) return "";
    const units = ["B", "KB", "MB", "GB"];
    let n = Number(bytes), i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return n.toFixed(i ? 1 : 0) + " " + units[i];
  };

  function setMessage(text) { message.textContent = text; }

  function apiUrl(path) {
    const base = (config.apiBaseUrl || "").replace(/\/$/, "");
    return base + path;
  }

  const folderMime = "application/vnd.google-apps.folder";

  async function listFolder(folderId, folderPath, visited) {
    if (visited.has(folderId)) return [];
    visited.add(folderId);
    let pageToken = "";
    const collected = [];
    do {
      const query = "'" + folderId + "' in parents and trashed = false";
      const fields = "nextPageToken,files(id,name,mimeType,size,thumbnailLink,webViewLink,parents)";
      let url = "https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent(query) +
        "&pageSize=1000&orderBy=name&fields=" + encodeURIComponent(fields) +
        "&key=" + encodeURIComponent(config.apiKey);
      if (pageToken) url += "&pageToken=" + encodeURIComponent(pageToken);
      const response = await fetch(url);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error?.message || "Erro HTTP " + response.status);
      }
      const data = await response.json();
      for (const file of (data.files || [])) {
        if (file.mimeType === folderMime) {
          const folder = { id: file.id, name: file.name, parentId: folderId, folderPath };
          folders.push(folder);
          collected.push(...await listFolder(file.id, folderPath ? folderPath + " / " + file.name : file.name, visited));
        } else {
          file.folderPath = folderPath;
          file.parentFolderId = folderId;
          collected.push(file);
        }
      }
      pageToken = data.nextPageToken || "";
    } while (pageToken);
    return collected;
  }

  async function loadLibrary() {
    grid.innerHTML = "";
    if (!config.folderId || !config.apiKey || config.apiKey.includes("COLE_SUA")) {
      status.textContent = "Configuração necessária";
      setMessage("Adicione sua chave da API do Google Drive no arquivo config.js para carregar os vídeos.");
      return;
    }
    status.textContent = "Carregando…";
    setMessage("Organizando pastas e vídeos do Google Drive…");
    try {
      folders = [];
      const files = await listFolder(config.folderId, "", new Set());
      items = files.filter(file => file.mimeType?.startsWith("video/") || supported.test(file.name || ""));
      subtitleFiles = files.filter(file => subtitlePattern.test(file.name || ""));
      const episodeCode = name => {
        const match = name.match(/\bS(\d{1,2})\s*E(\d{1,3})\b/i);
        return match ? { season: Number(match[1]), episode: Number(match[2]) } : null;
      };
      items.sort((a, b) => {
        const ea = episodeCode(a.name), eb = episodeCode(b.name);
        if (ea && eb) return ea.season - eb.season || ea.episode - eb.episode ||
          a.name.localeCompare(b.name, "pt-BR", { numeric: true, sensitivity: "base" });
        if (ea) return -1;
        if (eb) return 1;
        return a.name.localeCompare(b.name, "pt-BR", { numeric: true, sensitivity: "base" });
      });
      folders.sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { numeric: true, sensitivity: "base" }));
      currentFolderId = config.folderId;
      render();
      status.textContent = items.length + " vídeo(s) • " + folders.length + " pasta(s)";
    } catch (error) {
      console.error(error);
      status.textContent = "Falha ao carregar";
      setMessage("Não foi possível acessar a pasta: " + error.message + ". Verifique a chave da API, as permissões e se os vídeos estão compartilhados para acesso.");
    }
  }

  function renderBreadcrumbs() {
    const nav = document.getElementById("breadcrumbs");
    if (!nav) return;
    nav.innerHTML = "";
    const chain = [];
    let cursor = currentFolderId;
    while (cursor && cursor !== config.folderId) {
      const folder = folders.find(item => item.id === cursor);
      if (!folder) break;
      chain.unshift(folder);
      cursor = folder.parentId;
    }
    const root = document.createElement("button");
    root.className = "breadcrumb";
    root.textContent = "Início";
    root.addEventListener("click", () => { currentFolderId = config.folderId; render(); });
    nav.appendChild(root);
    chain.forEach(folder => {
      const separator = document.createElement("span");
      separator.className = "breadcrumb-separator";
      separator.textContent = "›";
      nav.appendChild(separator);
      const button = document.createElement("button");
      button.className = "breadcrumb";
      button.textContent = folder.name;
      button.addEventListener("click", () => { currentFolderId = folder.id; render(); });
      nav.appendChild(button);
    });
  }

  function render() {
    grid.innerHTML = "";
    renderBreadcrumbs();
    const currentFolders = folders.filter(folder => folder.parentId === currentFolderId);
    visibleVideos = items.filter(file => file.parentFolderId === currentFolderId);
    if (!currentFolders.length && !visibleVideos.length) {
      setMessage("Esta pasta está vazia.");
      return;
    }
    setMessage("");
    currentFolders.forEach(folder => {
      const card = document.createElement("button");
      card.className = "video-card folder-card";
      card.type = "button";
      card.innerHTML = '<span class="thumb folder-thumb"><span class="folder-symbol">📁</span></span><span class="video-title"></span><span class="video-meta">Abrir pasta</span>';
      card.querySelector(".video-title").textContent = folder.name;
      card.addEventListener("click", () => { currentFolderId = folder.id; render(); });
      grid.appendChild(card);
    });
    visibleVideos.forEach((file, index) => {
      const card = document.createElement("button");
      card.className = "video-card";
      card.type = "button";
      card.innerHTML = '<span class="thumb"><span class="play">▶</span></span><span class="video-title"></span><span class="video-meta"></span>';
      card.querySelector(".video-title").textContent = file.name;
      card.querySelector(".video-meta").textContent = formatSize(file.size) || "Vídeo";
      const thumb = card.querySelector(".thumb");
      if (file.thumbnailLink) {
        const img = document.createElement("img");
        img.src = file.thumbnailLink;
        img.alt = "";
        img.loading = "lazy";
        thumb.prepend(img);
      }
      card.addEventListener("click", () => play(index));
      grid.appendChild(card);
    });
  }

  function clearSubtitle() {
    subtitleLoadToken++;
    video.querySelectorAll("track").forEach(track => track.remove());
    if (subtitleUrl) URL.revokeObjectURL(subtitleUrl);
    subtitleUrl = null;
  }

  function findSubtitle(videoFile) {
    const videoBase = videoFile.name.replace(/\.[^.]+$/, "").trim().toLocaleLowerCase();
    const sameFolder = subtitleFiles.find(file =>
      (file.folderPath || "") === (videoFile.folderPath || "") &&
      file.name.replace(/\.(srt|vtt)$/i, "").trim().toLocaleLowerCase() === videoBase
    );
    if (sameFolder) return sameFolder;
    const matches = subtitleFiles.filter(file =>
      file.name.replace(/\.(srt|vtt)$/i, "").trim().toLocaleLowerCase() === videoBase
    );
    return matches.length === 1 ? matches[0] : null;
  }

  function decodeSubtitle(buffer, contentType) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return new TextDecoder("utf-8").decode(bytes.subarray(3));
    }
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
      return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    }
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
      return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    }
    const declared = (contentType || "").match(/charset=([^;]+)/i);
    if (declared) {
      try { return new TextDecoder(declared[1].replace(/["']/g, "").trim()).decode(bytes); } catch (_) {}
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (_) {
      return new TextDecoder("windows-1252").decode(bytes);
    }
  }



  async function loadSubtitle(videoFile) {
    clearSubtitle();
    const requestToken = subtitleLoadToken;
    const subtitle = findSubtitle(videoFile);
    if (!subtitle) return;
    try {
      const url = apiUrl("/api/subtitle/" + encodeURIComponent(subtitle.id)) +
        "?key=" + encodeURIComponent(config.apiKey);
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || data.message || "HTTP " + response.status);
      }
      const buffer = await response.arrayBuffer();
      if (requestToken !== subtitleLoadToken) return;
      if (!buffer.byteLength) throw new Error("O arquivo de legenda está vazio.");
      let content = decodeSubtitle(buffer, response.headers.get("content-type")).replace(/^\uFEFF/, "");
      if (/\.srt$/i.test(subtitle.name)) {
        content = "WEBVTT\n\n" + content
          .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
          .replace(/^\s*\d+\s*$/gm, "");
      } else if (!content.trimStart().startsWith("WEBVTT")) {
        content = "WEBVTT\n\n" + content;
      }
      if (requestToken !== subtitleLoadToken) return;
      subtitleUrl = URL.createObjectURL(new Blob([content], { type: "text/vtt;charset=utf-8" }));
      const track = document.createElement("track");
      track.kind = "subtitles";
      track.label = "Português";
      track.srclang = "pt";
      track.src = subtitleUrl;
      track.default = true;
      video.appendChild(track);
      track.track.mode = "showing";
      setPlaybackMessage("Legenda carregada: " + subtitle.name);
    } catch (error) {
      if (requestToken !== subtitleLoadToken) return;
      console.error("Falha ao carregar legenda:", subtitle.name, error);
      setPlaybackMessage("Falha ao carregar a legenda (" + subtitle.name + "): " + error.message);
    }
  }

  function nativePlayerPayload(file, sourceUrl) {
    // Prefer the actual container extension: Drive can return a generic MIME type.
    const extension = (file.name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase();
    const mimeByExtension = {
      mkv: "video/x-matroska",
      mp4: "video/mp4",
      m4v: "video/mp4",
      webm: "video/webm",
      mov: "video/quicktime",
      avi: "video/x-msvideo",
      mpg: "video/mpeg",
      mpeg: "video/mpeg",
      ts: "video/mp2t"
    };
    const mime = mimeByExtension[extension] || file.mimeType || "application/octet-stream";
    return {
      fullPath: new URL(sourceUrl, window.location.href).href,
      artist: "",
      subtitle: "",
      dlnaInfo: {
        flagVal: 4096,
        cleartextSize: String(file.size || -1),
        contentLength: String(file.size || -1),
        opVal: 1,
        protocolInfo: "http-get:*:" + mime + ":DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000",
        duration: 0
      },
      mediaType: "VIDEO",
      thumbnail: file.thumbnailLink || "",
      deviceType: "DMR",
      album: "",
      fileName: file.name.replace(/\.[^.]+$/, ""),
      lastPlayPosition: -1
    };
  }

  async function diagnoseMediaDelivery(sourceUrl) {
    const result = { head: null, signature: null, largerRange: null, offsetRange: null };
    const readHeaders = response => ({
      status: response.status,
      contentType: response.headers.get("Content-Type"),
      contentLength: response.headers.get("Content-Length"),
      contentRange: response.headers.get("Content-Range"),
      acceptRanges: response.headers.get("Accept-Ranges"),
      disposition: response.headers.get("Content-Disposition")
    });
    const readRange = async (label, range) => {
      const response = await fetch(sourceUrl, {
        method: "GET",
        headers: { Range: range },
        cache: "no-store"
      });
      const headers = readHeaders(response);
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { label, range, ...headers, receivedBytes: bytes.byteLength, bytes };
    };
    const hex = bytes => Array.from(bytes).map(value => value.toString(16).padStart(2, "0").toUpperCase()).join(" ");

    try {
      const head = await fetch(sourceUrl, { method: "HEAD", cache: "no-store" });
      result.head = readHeaders(head);
    } catch (error) {
      result.head = { error: error.message };
    }

    try {
      const first = await readRange("início", "bytes=0-4095");
      const signature = first.bytes.slice(0, 4);
      const isMkv = signature.length === 4 &&
        signature[0] === 0x1A && signature[1] === 0x45 &&
        signature[2] === 0xDF && signature[3] === 0xA3;
      result.signature = {
        status: first.status,
        contentType: first.contentType,
        contentRange: first.contentRange,
        receivedBytes: first.receivedBytes,
        firstFourBytes: hex(signature),
        isMkv
      };
      result.largerRange = {
        status: first.status,
        contentRange: first.contentRange,
        receivedBytes: first.receivedBytes
      };
    } catch (error) {
      result.signature = { error: error.message };
      result.largerRange = { error: error.message };
    }

    try {
      const offset = await readRange("offset", "bytes=1048576-1052671");
      result.offsetRange = {
        status: offset.status,
        contentRange: offset.contentRange,
        receivedBytes: offset.receivedBytes
      };
    } catch (error) {
      result.offsetRange = { error: error.message };
    }

    console.group("Diagnóstico de entrega do Google Drive");
    console.log("URL:", sourceUrl.replace(/([?&]key=)[^&]+/i, "$1[OCULTA]"));
    console.log("HEAD:", result.head);
    console.log("Assinatura MKV e faixa inicial bytes=0-4095:", result.signature);
    console.log("Faixa em offset bytes=1048576-1052671:", result.offsetRange);
    console.groupEnd();

    const headText = result.head.error
      ? "HEAD falhou: " + result.head.error
      : "HEAD " + result.head.status + " • " + (result.head.contentType || "sem MIME") +
        " • tamanho " + (result.head.contentLength || "?");
    const signatureText = result.signature.error
      ? "Assinatura falhou: " + result.signature.error
      : "início " + result.signature.firstFourBytes +
        (result.signature.isMkv ? " (MKV válido)" : " (não corresponde à assinatura MKV)") +
        " • faixa " + result.signature.status + " / " + result.signature.receivedBytes + " bytes";
    const offsetText = result.offsetRange.error
      ? "offset falhou: " + result.offsetRange.error
      : "offset " + result.offsetRange.status + " • " +
        (result.offsetRange.contentRange || "?") +
        " • recebido " + result.offsetRange.receivedBytes + " byte(s)";
    return { details: result, summary: headText + " • " + signatureText + " • " + offsetText };
  }

  function launchNativePlayer(file, sourceUrl) {
    const payload = nativePlayerPayload(file, sourceUrl);
    const params = { payload: [payload] };

    // webOS TV 6.x uses the Media Discovery app for the built-in media player.
    if (window.webOS && window.webOS.service &&
        typeof window.webOS.service.request === "function") {
      return new Promise(resolve => {
        window.webOS.service.request("luna://com.webos.applicationManager", {
          method: "launch",
          parameters: {
            id: "com.webos.app.mediadiscovery",
            params
          },
          onSuccess: response => resolve({ ok: true, response }),
          onFailure: error => resolve({ ok: false, error })
        });
      });
    }

    if (window.webOSDev && typeof window.webOSDev.launch === "function") {
      return new Promise(resolve => {
        window.webOSDev.launch({
          id: "com.webos.app.mediadiscovery",
          params,
          onSuccess: response => resolve({ ok: true, response }),
          onFailure: error => resolve({ ok: false, error })
        });
      });
    }

    return Promise.resolve({
      ok: false,
      unavailable: true,
      error: { errorText: "As APIs webOS não estão disponíveis nesta sessão do navegador." }
    });
  }

  function directDriveUrls(file) {
    const id = encodeURIComponent(file.id);
    return [
      { label: "Link /view", url: "https://drive.google.com/file/d/" + id + "/view" },
      { label: "Download direto", url: "https://drive.google.com/uc?export=download&id=" + id }
    ];
  }

  function openDirectSource(source) {
    // Abre a URL fora do elemento <video>. Assim o navegador pode exibir a
    // confirmação do Drive ou iniciar o download sem exigir suporte a MKV.
    const opened = window.open(source.url, "_blank", "noopener");
    if (opened) {
      setPlaybackMessage(source.label + " aberto em uma nova aba. Observe se o Drive mostra uma confirmação ou inicia o download.");
    } else {
      setPlaybackMessage("O navegador bloqueou a nova aba. Permita pop-ups para este site e tente novamente.");
    }
  }

  async function tryDirectSource(file, source) {
    setPlaybackMessage("Enviando " + source.label + " ao player nativo da TV…");
    if (window.webOS && window.webOS.service &&
        typeof window.webOS.service.request === "function") {
      const nativeResult = await launchNativePlayer(file, source.url);
      if (nativeResult.ok) {
        video.pause();
        video.removeAttribute("src");
        video.load();
        player.classList.add("hidden");
        document.getElementById("library").classList.remove("hidden");
        status.textContent = "Reprodução transferida para a TV (" + source.label + ")";
        return;
      }
      setPlaybackMessage("O player da TV recusou " + source.label + ": " +
        (nativeResult.error?.errorText || nativeResult.error?.message || "erro não identificado"));
      return;
    }
    setPlaybackMessage("Este teste abre o player nativo da TV. No computador, use os botões de abrir origem ou diagnosticar Worker; o navegador pode não reproduzir MKV.");
  }

  function play(index) {
    const file = visibleVideos[index];
    if (!file) return;

    // Finaliza a fonte anterior antes de abrir a próxima.
    video.dataset.index = "-1";
    video.pause();
    video.removeAttribute("src");
    video.load();
    clearSubtitle();

    nowPlaying.textContent = file.name;
    document.getElementById("next-episode").classList.add("hidden");
    video.dataset.index = String(index);
    video.dataset.fallbackUsed = "false";
    video.dataset.subtitleLoaded = "false";
    player.classList.remove("hidden");
    document.getElementById("library").classList.add("hidden");

    // Restaura a estratégia original que funcionava: o elemento de vídeo
    // recebe diretamente o link de download do Google Drive.
    const sourceUrl = "https://drive.google.com/uc?export=download&id=" +
      encodeURIComponent(file.id);
    video.src = sourceUrl;
    video.load();
    video.play().catch(error => {
      console.warn("Reprodução não iniciada automaticamente:", error);
      setPlaybackMessage("Toque em ▶ no controle do vídeo para iniciar a reprodução.");
    });
  }

  function closePlayer() {
    video.pause();
    clearSubtitle();
    video.removeAttribute("src");
    video.load();
    player.classList.add("hidden");
    document.getElementById("library").classList.remove("hidden");
  }

  document.getElementById("back").addEventListener("click", closePlayer);
  document.getElementById("next-episode").addEventListener("click", () => {
    const next = Number(video.dataset.index) + 1;
    if (next < visibleVideos.length) play(next);
  });
  document.getElementById("refresh").addEventListener("click", loadLibrary);
  function setPlaybackMessage(text) {
    let notice = document.getElementById("playback-message");
    if (!notice) {
      notice = document.createElement("p");
      notice.id = "playback-message";
      notice.className = "message";
      video.insertAdjacentElement("afterend", notice);
    }
    notice.textContent = text;
  }

  video.addEventListener("playing", () => {
    const notice = document.getElementById("playback-message");
    if (notice && notice.textContent.startsWith("Toque em")) notice.textContent = "";

    // Carrega a legenda em paralelo somente após o vídeo iniciar.
    const index = Number(video.dataset.index);
    const file = visibleVideos[index];
    if (file && video.dataset.subtitleLoaded !== "true") {
      video.dataset.subtitleLoaded = "true";
      loadSubtitle(file);
    }
  });
  video.addEventListener("error", () => {
    const file = visibleVideos[Number(video.dataset.index)];
    if (!file) return;

    // Fallback histórico: se o link direto falhar, tenta a mídia pela Drive API.
    if (video.dataset.fallbackUsed !== "true") {
      video.dataset.fallbackUsed = "true";
      const fallbackUrl = "https://www.googleapis.com/drive/v3/files/" +
        encodeURIComponent(file.id) + "?alt=media&key=" + encodeURIComponent(config.apiKey);
      console.warn("Link direto do Drive falhou; tentando fallback da Drive API.");
      video.src = fallbackUrl;
      video.load();
      video.play().catch(() => {});
      return;
    }

    const code = video.error?.code;
    const detail = code === 4
      ? "O navegador/player não reconheceu o formato ou a resposta enviada pelo Google Drive."
      : "Não foi possível receber o vídeo do Google Drive. Verifique o compartilhamento e tente novamente.";
    setPlaybackMessage(detail);
    console.error("Falha nas duas fontes de reprodução:", file.name, video.error);
  });

  video.addEventListener("ended", () => {
    const next = Number(video.dataset.index) + 1;
    const nextButton = document.getElementById("next-episode");
    if (next < visibleVideos.length) {
      nextButton.classList.remove("hidden");
      nextButton.focus();
    } else {
      setPlaybackMessage("Você chegou ao final desta pasta.");
    }
  });
  document.addEventListener("keydown", event => {
    if (player.classList.contains("hidden")) return;
    if (event.key === "Escape" || event.key === "Backspace") {
      event.preventDefault(); closePlayer();
    } else if (event.key === "ArrowRight") {
      video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10);
    } else if (event.key === "ArrowLeft") {
      video.currentTime = Math.max(0, video.currentTime - 10);
    }
  });

  // Diagnostic: test the LG native player independently from Google Drive.
  const nativeTestButton = document.createElement("button");
  nativeTestButton.type = "button";
  nativeTestButton.className = "icon-button";
  nativeTestButton.textContent = "Testar player LG";
  nativeTestButton.addEventListener("click", async () => {
    status.textContent = "Testando player nativo…";
    const testFile = {
      name: "sintel-trailer.mp4",
      size: -1,
      mimeType: "video/mp4",
      thumbnailLink: ""
    };
    const result = await launchNativePlayer(testFile, "https://media.w3.org/2010/05/sintel/trailer.mp4");
    if (result.ok) {
      status.textContent = "Player LG aberto — verifique se o MP4 reproduz.";
      console.info("Teste do player nativo:", result.response);
    } else {
      status.textContent = "Falha ao abrir player LG: " + (result.error?.errorText || result.error?.message || "erro desconhecido");
      console.error("Teste do player nativo falhou:", result.error);
    }
  });
  const mkvTestButton = document.createElement("button");
  mkvTestButton.type = "button";
  mkvTestButton.className = "icon-button";
  mkvTestButton.textContent = "Testar MKV externo";
  mkvTestButton.addEventListener("click", async () => {
    status.textContent = "Testando MKV público no player LG…";
    const testFile = {
      name: "sample-video-480x270-1mb.mkv",
      size: 947682,
      mimeType: "video/x-matroska",
      thumbnailLink: ""
    };
    const testUrl = "https://pnb-website-bucket.s3.us-east-2.amazonaws.com/samples/videos/mkv/sample-video-480x270-1mb.mkv";
    const result = await launchNativePlayer(testFile, testUrl);
    if (result.ok) {
      status.textContent = "Player LG aberto com MKV externo — verifique se reproduz.";
      console.info("Teste MKV externo:", result.response);
    } else {
      status.textContent = "Falha ao abrir player LG com MKV: " + (result.error?.errorText || result.error?.message || "erro desconhecido");
      console.error("Teste MKV externo falhou:", result.error);
    }
  });
  const topActions = document.querySelector(".top-actions");
  if (topActions) {
    topActions.insertBefore(mkvTestButton, document.getElementById("refresh"));
    topActions.insertBefore(nativeTestButton, mkvTestButton);
  }

  loadLibrary();
})();