(() => {
  const config = window.APP_CONFIG || {};
  const grid = document.getElementById("videos");
  const message = document.getElementById("message");
  const status = document.getElementById("status");
  const player = document.getElementById("player");
  const video = document.getElementById("video");
  const closeBtn = document.getElementById("close-player");
  const playbackMessage = document.getElementById("playback-message");

  const supported = /\.(mp4|m4v|webm|ogv|ogg|mov|mkv)$/i;
  const subtitlePattern = /\.(srt|vtt)$/i;

  let items = [];
  let subtitleFiles = [];
  let folders = [];
  let currentFolderId = config.folderId;
  let visibleVideos = [];
  let currentVideoIndex = -1;
  let isCurrentMkv = false;
  let subtitleUrl = null;
  let subtitleLoadToken = 0;
  let playerHistoryActive = false;
  let backBtnTimer = null;
  let messageTimer = null;

  const formatSize = bytes => {
    if (!bytes) return "";
    const units = ["B", "KB", "MB", "GB"];
    let n = Number(bytes), i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return n.toFixed(i ? 1 : 0) + " " + units[i];
  };

  function setMessage(text) {
    message.textContent = text;
  }

  function setPlaybackMessage(text, persistent = false) {
    if (!playbackMessage) return;
    clearTimeout(messageTimer);
    if (!text) {
      playbackMessage.textContent = "";
      playbackMessage.classList.add("hidden");
      return;
    }
    playbackMessage.textContent = text;
    playbackMessage.classList.remove("hidden");
    if (!persistent) {
      messageTimer = setTimeout(() => {
        playbackMessage.classList.add("hidden");
      }, 4500);
    }
  }

  function showBackButtonTemporarily() {
    if (!closeBtn) return;
    closeBtn.classList.remove("autohide");
    clearTimeout(backBtnTimer);
    if (!video.paused) {
      backBtnTimer = setTimeout(() => {
        if (!player.classList.contains("hidden") && !video.paused) closeBtn.classList.add("autohide");
      }, 3500);
    }
  }

  function apiUrl(path) {
    const base = (config.apiBaseUrl || "").replace(/\/$/, "");
    return base + path;
  }

  function videoSourceUrl(file, forceMatroskaMime = false) {
    const path = "/api/video/" + encodeURIComponent(file.id) + "/" +
      encodeURIComponent(file.name || "video.mp4");
    let url = apiUrl(path) + "?key=" + encodeURIComponent(config.apiKey);
    if (forceMatroskaMime) url += "&mime=matroska";
    return url;
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
    if (video) {
      video.querySelectorAll("track").forEach(track => track.remove());
    }
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
      
    } catch (error) {
      if (requestToken !== subtitleLoadToken) return;
      console.error("Falha ao carregar legenda:", subtitle.name, error);
      setPlaybackMessage("Legenda indisponível (" + subtitle.name + "): " + error.message);
    }
  }

  function formatMediaError(mediaError) {
    if (!mediaError) return "Erro desconhecido ao reproduzir na TV.";
    const reasons = {
      1: "Reprodução interrompida.",
      2: "Erro de rede ao ler o vídeo do Google Drive.",
      3: "A TV não conseguiu decodificar o vídeo/áudio (codec incompatível).",
      4: "Formato de vídeo não suportado pelo player da TV."
    };
    const base = reasons[mediaError.code] || ("Erro de mídia (código " + mediaError.code + ").");
    return mediaError.message ? base + " (" + mediaError.message + ")" : base;
  }

  async function play(index) {
    const file = visibleVideos[index];
    if (!file) return;
    currentVideoIndex = index;
    isCurrentMkv = (file.name || "").toLowerCase().endsWith(".mkv");
    player.classList.remove("hidden");
    document.getElementById("library").classList.add("hidden");
    if (!playerHistoryActive) {
      history.pushState({ drivePlayer: true }, "", "#player");
      playerHistoryActive = true;
    }
    if (window.stopTvTranscode) window.stopTvTranscode();
    video.pause();
    video.removeAttribute("src");
    video.load();
    setPlaybackMessage("Carregando vídeo…", true);
    showBackButtonTemporarily();
    await loadSubtitle(file);

    if (isCurrentMkv) {
      if (typeof window.playMkvOnTv !== "function") {
        setPlaybackMessage("O módulo de conversão MKV não foi carregado.", true);
        return;
      }
      try {
        await window.playMkvOnTv(file, videoSourceUrl(file));
        showBackButtonTemporarily();
        video.focus();
      } catch (error) {
        console.error("Falha ao preparar MKV:", error);
        setPlaybackMessage(error.message || String(error), true);
        showBackButtonTemporarily();
      }
      return;
    }

    video.src = videoSourceUrl(file);
    video.load();
    try {
      await video.play();
      setPlaybackMessage("");
      showBackButtonTemporarily();
    } catch (error) {
      if (error && error.name === "NotAllowedError") {
        setPlaybackMessage("Pressione Play / OK no controle da TV para iniciar.", true);
      } else if (!video.error) {
        setPlaybackMessage("Não foi possível iniciar: " + (error.message || error), true);
      }
    }
    video.focus();
  }

  function closePlayer(fromHistory = false) {
    clearTimeout(backBtnTimer);
    isCurrentMkv = false;
    if (window.stopTvTranscode) window.stopTvTranscode();
    clearTimeout(messageTimer);
    setPlaybackMessage("");

    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    clearSubtitle();
    player.classList.add("hidden");
    document.getElementById("library").classList.remove("hidden");

    const cards = grid.querySelectorAll(".video-card");
    const targetCard = cards[currentVideoIndex];
    if (targetCard) targetCard.focus();

    if (!fromHistory && playerHistoryActive) {
      playerHistoryActive = false;
      history.back();
    } else if (fromHistory) {
      playerHistoryActive = false;
    }
  }

  video.addEventListener("playing", () => {
    setPlaybackMessage("");
    showBackButtonTemporarily();
  });
  video.addEventListener("pause", showBackButtonTemporarily);

  video.addEventListener("waiting", () => setPlaybackMessage("Carregando buffer…", true));
  video.addEventListener("error", () => {
    if (player.classList.contains("hidden") || isCurrentMkv) return;
    console.error("Erro no player da TV:", video.error);
    setPlaybackMessage(formatMediaError(video.error), true);
    showBackButtonTemporarily();
  });

  document.getElementById("close-player")?.addEventListener("click", () => closePlayer());

  window.addEventListener("popstate", () => {
    if (playerHistoryActive) closePlayer(true);
  });

  // Controles do controle remoto da TV quando o player nativo está aberto
  window.addEventListener("keydown", event => {
    if (player.classList.contains("hidden")) return;
    showBackButtonTemporarily();

    // Botão Voltar da LG webOS (keyCode 461)
    if (event.keyCode === 461) {
      event.preventDefault();
      closePlayer();
      return;
    }


    const isButtonFocused = document.activeElement && document.activeElement.tagName === "BUTTON";

    if (event.key === "MediaPlayPause" || event.keyCode === 415 || event.keyCode === 19 ||
        ((event.key === "Enter" || event.key === " ") && !isButtonFocused)) {
      event.preventDefault();
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    } else if (event.key === "ArrowLeft" || event.key === "MediaRewind" || event.keyCode === 412) {
      if (!isButtonFocused || event.keyCode === 412) {
        event.preventDefault();
        if (Number.isFinite(video.currentTime)) {
          video.currentTime = Math.max(0, video.currentTime - 15);
          setPlaybackMessage("⏪ -15s");
        }
      }
    } else if (event.key === "ArrowRight" || event.key === "MediaFastForward" || event.keyCode === 417) {
      if (!isButtonFocused || event.keyCode === 417) {
        event.preventDefault();
        if (Number.isFinite(video.currentTime)) {
          const maxTime = Number.isFinite(video.duration) ? video.duration : video.currentTime + 15;
          video.currentTime = Math.min(maxTime, video.currentTime + 15);
          setPlaybackMessage("⏩ +15s");
        }
      }
    }
  });

  player.addEventListener("mousemove", showBackButtonTemporarily);
  document.getElementById("refresh").addEventListener("click", loadLibrary);

  loadLibrary();
})();