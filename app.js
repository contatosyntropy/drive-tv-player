(() => {
  const config = window.APP_CONFIG || {};
  const grid = document.getElementById("videos");
  const message = document.getElementById("message");
  const status = document.getElementById("status");
  const player = document.getElementById("player");
  const video = document.getElementById("video");
  const nowPlaying = document.getElementById("now-playing");
  const supported = /\.(mp4|m4v|webm|ogv|ogg|mov)$/i;
  const subtitlePattern = /\.(srt|vtt)$/i;
  let items = [];
  let subtitleFiles = [];
  let folders = [];
  let currentFolderId = config.folderId;
  let visibleVideos = [];
  let subtitleUrl = null;

  const formatSize = bytes => {
    if (!bytes) return "";
    const units = ["B", "KB", "MB", "GB"];
    let n = Number(bytes), i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return n.toFixed(i ? 1 : 0) + " " + units[i];
  };

  function setMessage(text) { message.textContent = text; }

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
    const subtitle = findSubtitle(videoFile);
    if (!subtitle) return;
    try {
      const url = "/api/subtitle/" + encodeURIComponent(subtitle.id) +
        "?key=" + encodeURIComponent(config.apiKey);
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || data.message || "HTTP " + response.status);
      }
      const buffer = await response.arrayBuffer();
      if (!buffer.byteLength) throw new Error("O arquivo de legenda está vazio.");
      let content = decodeSubtitle(buffer, response.headers.get("content-type")).replace(/^\uFEFF/, "");
      if (/\.srt$/i.test(subtitle.name)) {
        content = "WEBVTT\n\n" + content
          .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
          .replace(/^\s*\d+\s*$/gm, "");
      } else if (!content.trimStart().startsWith("WEBVTT")) {
        content = "WEBVTT\n\n" + content;
      }
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
      console.error("Falha ao carregar legenda:", subtitle.name, error);
      setPlaybackMessage("Falha ao carregar a legenda (" + subtitle.name + "): " + error.message);
    }
  }

  function play(index) {
    const file = visibleVideos[index];
    if (!file) return;
    nowPlaying.textContent = file.name;
    document.getElementById("next-episode").classList.add("hidden");
    player.classList.remove("hidden");
    document.getElementById("library").classList.add("hidden");
    video.dataset.index = String(index);
    video.dataset.fallbackUsed = "false";
    clearSubtitle();
    // Mantém o link direto do Drive como fonte principal, que era o método funcional antes da regressão.
    video.src = "https://drive.google.com/uc?export=download&id=" + encodeURIComponent(file.id);
    video.load();
    loadSubtitle(file);
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
  });
  video.addEventListener("error", () => {
    const file = visibleVideos[Number(video.dataset.index)];
    if (!file) return;
    if (video.dataset.fallbackUsed !== "true") {
      video.dataset.fallbackUsed = "true";
      video.src = "https://www.googleapis.com/drive/v3/files/" +
        encodeURIComponent(file.id) + "?alt=media&key=" + encodeURIComponent(config.apiKey);
      video.load();
      video.play().catch(() => {});
      return;
    }
    const code = video.error?.code;
    const detail = code === 4
      ? "Formato ou endereço não suportado. Converta o vídeo para MP4 (H.264 + AAC) e confirme que está compartilhado como “Qualquer pessoa com o link”."
      : "O Google Drive não entregou o vídeo ao navegador. Verifique o compartilhamento e tente novamente.";
    setPlaybackMessage(detail);
    console.error("Falha ao reproduzir vídeo:", file.name, video.error);
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

  loadLibrary();
})();