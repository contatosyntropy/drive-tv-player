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

  function videoSourceUrl(file) {
    const path = "/api/video/" + encodeURIComponent(file.id) + "/" +
      encodeURIComponent(file.name || "video");
    return apiUrl(path) + "?key=" + encodeURIComponent(config.apiKey);
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

  async function diagnoseMediaDelivery(sourceUrl, file) {
    const result = { head: null, ranges: [] };
    const readHeaders = response => ({
      status: response.status,
      contentType: response.headers.get("Content-Type"),
      contentLength: response.headers.get("Content-Length"),
      contentRange: response.headers.get("Content-Range"),
      acceptRanges: response.headers.get("Accept-Ranges"),
      contentEncoding: response.headers.get("Content-Encoding"),
      disposition: response.headers.get("Content-Disposition")
    });
    // Nunca carregar o arquivo inteiro na memória: lê apenas 16 bytes e cancela.
    const readRange = async (label, range, url = sourceUrl) => {
      const response = await fetch(url, {
        method: "GET",
        headers: { Range: range },
        cache: "no-store"
      });
      const headers = readHeaders(response);
      let sample = new Uint8Array(0);
      if (response.body) {
        const reader = response.body.getReader();
        try {
          const part = await reader.read();
          if (!part.done) sample = part.value.slice(0, 16);
        } finally {
          await reader.cancel().catch(() => {});
        }
      }
      return {
        label, range, ...headers,
        sampleHex: Array.from(sample).map(value => value.toString(16).padStart(2, "0").toUpperCase()).join(" ")
      };
    };

    try {
      const head = await fetch(sourceUrl, { method: "HEAD", cache: "no-store" });
      result.head = readHeaders(head);
      const size = Number(result.head.contentLength || file?.size || 0);
      const ranges = [
        ["início", "bytes=0-4095"],
        ["1 MiB", "bytes=1048576-1052671"]
      ];
      if (Number.isSafeInteger(size) && size > 8192) {
        const middle = Math.floor(size / 2);
        const late = Math.floor(size * 0.9);
        ranges.push(
          ["meio", "bytes=" + middle + "-" + (middle + 4095)],
          ["90%", "bytes=" + late + "-" + (late + 4095)],
          ["final", "bytes=" + Math.max(0, size - 4096) + "-" + (size - 1)]
        );
      }
      for (const [label, range] of ranges) {
        try { result.ranges.push(await readRange(label, range)); }
        catch (error) { result.ranges.push({ label, range, error: error.message }); }
      }
    } catch (error) {
      result.head = { error: error.message };
    }

    // Referência externa que já foi reproduzida no player nativo da TV.
    try {
      result.externalReference = await readRange(
        "MKV externo conhecido",
        "bytes=900000-900255",
        apiUrl("/api/reference-mkv")
      );
    } catch (error) {
      result.externalReference = { error: error.message };
    }

    console.group("Diagnóstico de entrega de mídia");
    console.log("Arquivo:", file?.name || "atual");
    console.log("HEAD Worker:", result.head);
    console.table(result.ranges);
    console.log("Referência MKV externa:", result.externalReference);
    console.groupEnd();
    const head = result.head || {};
    const lines = [
      "Diagnóstico HTTP — " + (file?.name || "arquivo"),
      "HEAD: " + (head.status || "falhou") + " • " + (head.contentType || "sem MIME") +
        " • tamanho " + (head.contentLength || "?") + " • Accept-Ranges " + (head.acceptRanges || "?"),
      ...result.ranges.map(item =>
        item.label + ": " + (item.status || "falhou") + " • " +
        (item.contentRange || "sem Content-Range") + " • " +
        (item.contentLength || "?") + " bytes declarados" +
        (item.error ? " • " + item.error : "")
      ),
      "MKV externo: " + (result.externalReference.status || "falhou") + " • " +
        (result.externalReference.contentRange || "sem Content-Range")
    ];
    return { details: result, summary: lines.join("\n") };
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

    // A reprodução passa a ser feita pelo visualizador oficial do Google Drive.
    // /preview entrega a página do player, não o arquivo de mídia bruto.
    video.dataset.index = "-1";
    video.pause();
    video.removeAttribute("src");
    video.load();
    clearSubtitle();

    const preview = document.getElementById("drive-preview");
    nowPlaying.textContent = file.name;
    video.dataset.index = String(index);
    player.classList.remove("hidden");
    document.getElementById("library").classList.add("hidden");

    preview.src = "https://drive.google.com/file/d/" +
      encodeURIComponent(file.id) + "/preview";
    preview.focus();
  }

  function closePlayer() {
    const preview = document.getElementById("drive-preview");
    if (preview) preview.src = "about:blank";
    video.pause();
    clearSubtitle();
    video.removeAttribute("src");
    video.load();
    player.classList.add("hidden");
    document.getElementById("library").classList.remove("hidden");
  }

  document.getElementById("back").addEventListener("click", closePlayer);
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

  document.addEventListener("keydown", event => {
    if (player.classList.contains("hidden")) return;
    // webOS TVs commonly report the remote's Back key as keyCode 461.
    if (event.key === "Escape" || event.key === "Backspace" ||
        event.key === "GoBack" || event.keyCode === 461) {
      event.preventDefault();
      closePlayer();
    }
  });

  loadLibrary();
})();