(() => {
  "use strict";
  const config = window.APP_CONFIG || {};
  const grid = document.getElementById("videos");
  const message = document.getElementById("message");
  const status = document.getElementById("status");
  const player = document.getElementById("player");
  const video = document.getElementById("video");
  const closeBtn = document.getElementById("close-player");
  const titleNode = document.getElementById("player-title");
  const playBtn = document.getElementById("play-pause");
  const seek = document.getElementById("seek");
  const currentTimeNode = document.getElementById("current-time");
  const durationNode = document.getElementById("duration");
  const audioButton = document.getElementById("audio-button");
  const audioMenu = document.getElementById("audio-menu");
  const subtitleButton = document.getElementById("subtitle-button");
  const subtitleMenu = document.getElementById("subtitle-menu");
  const subtitleSelect = document.getElementById("subtitle-select");
  const subtitleOverlay = document.getElementById("subtitle-overlay");
  const subtitleSyncValue = document.getElementById("subtitle-sync-value");
  const subtitleSize = document.getElementById("subtitle-size");
  const volumeButton = document.getElementById("volume-button");
  const volumeRange = document.getElementById("volume-range");
  const supported = /(mp4|m4v|webm|ogv|ogg|mov|mkv)$/i;
  const subtitlePattern = /\.(srt|vtt)$/i;
  const folderMime = "application/vnd.google-apps.folder";

  let items = [];
  let subtitleFiles = [];
  let folders = [];
  let currentFolderId = config.folderId;
  let visibleVideos = [];
  let currentVideoIndex = -1;
  let currentFile = null;
  let activeMode = "none";
  let activeMime = "";
  let subtitleCues = [];
  let subtitleOffset = 0;
  let subtitleFontSize = "medium";
  let subtitleLoadToken = 0;
  let backBtnTimer = null;
  let controlTimer = null;
  let controlsVisible = true;
  let audioTracksAvailable = false;

  const formatSize = bytes => {
    if (!bytes) return "";
    const units = ["B", "KB", "MB", "GB"];
    let n = Number(bytes), i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return n.toFixed(i ? 1 : 0) + " " + units[i];
  };

  function setMessage(text) { message.textContent = text; }
  function apiUrl(path) { return (config.apiBaseUrl || "").replace(/\/$/, "") + path; }
  function videoSourceUrl(file, mime) {
    const path = "/api/video/" + encodeURIComponent(file.id) + "/" + encodeURIComponent(file.name || "video.mp4");
    let url = apiUrl(path) + "?key=" + encodeURIComponent(config.apiKey);
    if (mime === "matroska") url += "&mime=matroska";
    if (mime === "mp4") url += "&mime=mp4";
    return url;
  }
  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return (h ? String(h).padStart(2, "0") + ":" : "") +
      String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }
  function mediaOptionType(mime) {
    const options = {};
    return mime + ";mediaOption=" + encodeURI(JSON.stringify(options));
  }
  function clearVideoSources() {
    video.pause();
    while (video.firstChild) video.removeChild(video.firstChild);
    video.removeAttribute("src");
    video.load();
  }
  function appendVideoSource(file, mime) {
    clearVideoSources();
    const source = document.createElement("source");
    source.src = videoSourceUrl(file, mime);
    source.type = mediaOptionType(mime === "matroska" ? "video/x-matroska" : mime === "mp4" ? "video/mp4" : mime);
    video.appendChild(source);
    activeMime = mime;
    video.load();
  }
  function setControlsVisible(visible) {
    controlsVisible = visible;
    player.classList.toggle("controls-hidden", !visible);
    if (visible) {
      clearTimeout(controlTimer);
      controlTimer = setTimeout(() => {
        if (!video.paused && activeMode === "native" && !audioMenu.classList.contains("hidden") === false &&
            !subtitleMenu.classList.contains("hidden") === false) setControlsVisible(false);
      }, 5000);
    }
  }
  function showControls() {
    setControlsVisible(true);
    clearTimeout(controlTimer);
    if (!video.paused) {
      controlTimer = setTimeout(() => {
        if (activeMode === "native" && audioMenu.classList.contains("hidden") && subtitleMenu.classList.contains("hidden") &&
            !isInteractiveFocus()) setControlsVisible(false);
      }, 5000);
    }
  }
  function isInteractiveFocus() {
    const el = document.activeElement;
    return !!el && (el === audioMenu || audioMenu.contains(el) || el === subtitleMenu || subtitleMenu.contains(el) ||
      el === closeBtn || el === playBtn || el === seek || el === audioButton || el === subtitleButton);
  }
  function showBackButtonTemporarily() {
    closeBtn.classList.remove("autohide");
    clearTimeout(backBtnTimer);
    backBtnTimer = setTimeout(() => {
      if (!player.classList.contains("hidden")) closeBtn.classList.add("autohide");
    }, 3500);
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
        throw new Error(data.error && data.error.message || "Erro HTTP " + response.status);
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
      items = files.filter(file => (file.mimeType && file.mimeType.startsWith("video/")) || supported.test(file.name || ""));
      subtitleFiles = files.filter(file => subtitlePattern.test(file.name || ""));
      const episodeCode = name => {
        const match = name.match(/S({1,2})*E({1,3})/i);
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


  function subtitleStem(name) {
    return name.replace(/\.(srt|vtt)$/i, "").toLocaleLowerCase();
  }
  function findSubtitles(file) {
    const stem = (file.name || "").replace(/\.[^.]+$/, "").toLocaleLowerCase();
    return subtitleFiles.filter(sub => {
      if ((sub.parentFolderId || "") !== (file.parentFolderId || "")) return false;
      const candidate = subtitleStem(sub.name || "");
      return candidate === stem || candidate.indexOf(stem + ".") === 0 ||
        candidate.indexOf(stem + "_") === 0 || candidate.indexOf(stem + "-") === 0;
    }).sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { numeric: true, sensitivity: "base" }));
  }
  async function decodeSubtitle(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return new TextDecoder("utf-8").decode(bytes.subarray(3));
    }
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch (_) { return new TextDecoder("windows-1252").decode(bytes); }
  }
  function timeToSeconds(value) {
    const m = value.trim().replace(",", ".").match(/^(\d{1,2}):(\d{2}):(\d{2})\.(\d{1,3})$/);
    if (!m) return NaN;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(("0." + m[4]));
  }
  function parseSubtitle(text, isSrt) {
    let normalized = text.replace(/^\uFEFF/, "").replace(/\r/g, "");
    if (isSrt) normalized = normalized.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, "$1.$2");
    const blocks = normalized.split(/\n\s*\n/);
    const cues = [];
    blocks.forEach(block => {
      const lines = block.split("\n");
      const timeIndex = lines.findIndex(line => line.indexOf("-->") >= 0);
      if (timeIndex < 0) return;
      const times = lines[timeIndex].split("-->");
      const start = timeToSeconds(times[0]);
      const end = timeToSeconds((times[1] || "").trim().split(/\s+/)[0]);
      const body = lines.slice(timeIndex + 1).join("\n").trim();
      if (Number.isFinite(start) && Number.isFinite(end) && end > start && body) {
        cues.push({ start: start, end: end, text: body.replace(/<[^>]*>/g, "") });
      }
    });
    return cues;
  }
  function clearSubtitles() {
    subtitleLoadToken++;
    subtitleCues = [];
    subtitleOverlay.textContent = "";
    subtitleSelect.innerHTML = '<option value="">Desativadas</option>';
    subtitleSyncValue.textContent = "0,0s";
  }
  async function loadSubtitleOption(file, token) {
    const url = apiUrl("/api/subtitle/" + encodeURIComponent(file.id)) + "?key=" + encodeURIComponent(config.apiKey);
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const buffer = await response.arrayBuffer();
    if (token !== subtitleLoadToken) return [];
    const text = await decodeSubtitle(buffer);
    return parseSubtitle(text, /\.srt$/i.test(file.name || ""));
  }
  async function loadSubtitleChoices(file) {
    clearSubtitles();
    const token = subtitleLoadToken;
    const matches = findSubtitles(file);
    if (!matches.length) {
      subtitleButton.disabled = true;
      subtitleButton.textContent = "Legendas —";
      return;
    }
    subtitleButton.disabled = false;
    subtitleButton.textContent = "Legendas";
    for (let i = 0; i < matches.length; i++) {
      if (token !== subtitleLoadToken) return;
      const option = document.createElement("option");
      option.value = String(i);
      option.textContent = matches[i].name.replace(/\.(srt|vtt)$/i, "");
      option.dataset.fileId = matches[i].id;
      subtitleSelect.appendChild(option);
      try {
        matches[i].parsedCues = await loadSubtitleOption(matches[i], token);
      } catch (error) {
        console.warn("Não foi possível carregar a legenda " + matches[i].name, error);
        option.disabled = true;
        option.textContent += " (indisponível)";
      }
    }
    subtitleSelect._subtitleFiles = matches;
    if (matches.length) {
      const firstAvailable = matches.findIndex(file => file.parsedCues && file.parsedCues.length);
      if (firstAvailable >= 0) {
        subtitleSelect.value = String(firstAvailable);
        subtitleCues = matches[firstAvailable].parsedCues;
        subtitleOverlay.classList.remove("hidden");
        updateSubtitleOverlay();
      }
    }
  }
  function updateSubtitleOverlay() {
    if (!subtitleCues.length || video.paused && video.readyState < 2) {
      subtitleOverlay.textContent = "";
      return;
    }
    const now = video.currentTime + subtitleOffset;
    const active = subtitleCues.filter(cue => now >= cue.start && now <= cue.end);
    subtitleOverlay.textContent = active.map(cue => cue.text).join("\n");
    subtitleOverlay.classList.toggle("hidden", active.length === 0);
    subtitleOverlay.classList.remove("size-small", "size-medium", "size-large");
    subtitleOverlay.classList.add("size-" + subtitleFontSize);
  }
  function setSubtitleSelection(value) {
    if (value === "") {
      subtitleCues = [];
      subtitleOverlay.textContent = "";
      subtitleOverlay.classList.add("hidden");
      return;
    }
    const files = subtitleSelect._subtitleFiles || [];
    const selected = files[Number(value)];
    subtitleCues = selected && selected.parsedCues ? selected.parsedCues : [];
    updateSubtitleOverlay();
  }
  function renderAudioTracks() {
    audioMenu.innerHTML = "";
    const tracks = video.audioTracks;
    if (!tracks || !tracks.length) {
      audioButton.disabled = true;
      audioButton.textContent = "Áudio —";
      audioTracksAvailable = false;
      return;
    }
    audioTracksAvailable = true;
    audioButton.disabled = false;
    audioButton.textContent = "Áudio";
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const button = document.createElement("button");
      button.type = "button";
      button.className = "menu-option";
      const label = track.label || track.language || ("Faixa " + (i + 1));
      button.textContent = (track.enabled ? "✓ " : "") + label;
      button.addEventListener("click", () => {
        for (let j = 0; j < tracks.length; j++) tracks[j].enabled = j === i;
        renderAudioTracks();
        audioMenu.classList.add("hidden");
        audioButton.focus();
      });
      audioMenu.appendChild(button);
    }
  }
  function toggleMenu(menu) {
    const opening = menu.classList.contains("hidden");
    audioMenu.classList.add("hidden");
    subtitleMenu.classList.add("hidden");
    if (opening) {
      menu.classList.remove("hidden");
      const first = menu.querySelector("button,select");
      if (first) first.focus();
      showControls();
    }
  }
  function play(index) {
    const file = visibleVideos[index];
    if (!file) return;
    currentVideoIndex = index;
    currentFile = file;
    player.classList.remove("hidden");
    document.getElementById("library").classList.add("hidden");
    titleNode.textContent = file.name;
    clearSubtitles();
    audioMenu.classList.add("hidden");
    subtitleMenu.classList.add("hidden");
    clearVideoSources();
    activeMode = "native";
    const isMkv = /\.mkv$/i.test(file.name || "");
    if (isMkv) appendVideoSource(file, "matroska");
    else {
      const ext = ((file.name || "").match(/\.([^.]+)$/) || [])[1];
      const mimeMap = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/mp4", webm: "video/webm", ogv: "video/ogg", ogg: "video/ogg" };
      appendVideoSource(file, mimeMap[(ext || "").toLowerCase()] || "video/mp4");
    }
    showBackButtonTemporarily();
    showControls();
    video.play().catch(() => {});
    loadSubtitleChoices(file);
    renderAudioTracks();
    video.focus();
  }
  function closePlayer() {
    clearTimeout(backBtnTimer);
    clearTimeout(controlTimer);
    activeMode = "none";
    clearSubtitles();
    clearVideoSources();
    player.classList.add("hidden");
    document.getElementById("library").classList.remove("hidden");
    audioMenu.classList.add("hidden");
    subtitleMenu.classList.add("hidden");
    const cards = grid.querySelectorAll(".video-card");
    const targetCard = cards[currentVideoIndex];
    if (targetCard) targetCard.focus();
  }
  function fallbackMkvToMp4() {
    if (!currentFile || !/\.mkv$/i.test(currentFile.name || "") || activeMime !== "matroska") return false;
    console.warn("Falha no MIME Matroska; tentando video/mp4 com mediaOption.");
    appendVideoSource(currentFile, "mp4");
    video.play().catch(() => {});
    return true;
  }

  video.addEventListener("error", () => {
    if (player.classList.contains("hidden") || activeMode !== "native") return;
    if (!fallbackMkvToMp4()) {
      status.textContent = "Falha na reprodução";
      console.error("Erro do player HTMLMediaElement", video.error ? video.error.code : "desconhecido");
    }
  });
  video.addEventListener("loadedmetadata", () => {
    durationNode.textContent = formatTime(video.duration);
    seek.max = Number.isFinite(video.duration) ? String(Math.floor(video.duration)) : "0";
    renderAudioTracks();
  });
  video.addEventListener("timeupdate", () => {
    currentTimeNode.textContent = formatTime(video.currentTime);
    if (!seek.matches(":active")) seek.value = String(Math.floor(video.currentTime || 0));
    updateSubtitleOverlay();
  });
  video.addEventListener("play", () => { playBtn.textContent = "Ⅱ Pausar"; showControls(); });
  video.addEventListener("pause", () => { playBtn.textContent = "▶ Reproduzir"; setControlsVisible(true); });
  video.addEventListener("durationchange", () => {
    durationNode.textContent = formatTime(video.duration);
    seek.max = Number.isFinite(video.duration) ? String(Math.floor(video.duration)) : "0";
  });
  if (video.audioTracks) {
    video.audioTracks.addEventListener("addtrack", renderAudioTracks);
    video.audioTracks.addEventListener("removetrack", renderAudioTracks);
    video.audioTracks.addEventListener("change", renderAudioTracks);
  }

  playBtn.addEventListener("click", () => {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
    showControls();
  });
  seek.addEventListener("input", () => {
    if (Number.isFinite(video.duration)) video.currentTime = Number(seek.value);
  });
  audioButton.addEventListener("click", () => toggleMenu(audioMenu));
  subtitleButton.addEventListener("click", () => toggleMenu(subtitleMenu));
  subtitleSelect.addEventListener("change", () => {
    setSubtitleSelection(subtitleSelect.value);
    subtitleMenu.classList.add("hidden");
    subtitleButton.focus();
  });
  document.getElementById("subtitle-sync-minus").addEventListener("click", () => {
    subtitleOffset -= 0.5;
    subtitleSyncValue.textContent = (subtitleOffset > 0 ? "+" : "") + subtitleOffset.toFixed(1).replace(".", ",") + "s";
    updateSubtitleOverlay();
  });
  document.getElementById("subtitle-sync-plus").addEventListener("click", () => {
    subtitleOffset += 0.5;
    subtitleSyncValue.textContent = (subtitleOffset > 0 ? "+" : "") + subtitleOffset.toFixed(1).replace(".", ",") + "s";
    updateSubtitleOverlay();
  });
  subtitleSize.addEventListener("change", () => {
    subtitleFontSize = subtitleSize.value;
    updateSubtitleOverlay();
  });
  volumeRange.addEventListener("input", () => { video.volume = Number(volumeRange.value) / 100; });
  volumeButton.addEventListener("click", () => {
    video.muted = !video.muted;
    volumeButton.textContent = video.muted ? "Som desligado" : "Som";
  });
  closeBtn.addEventListener("click", closePlayer);
  window.addEventListener("keydown", event => {
    if (player.classList.contains("hidden")) return;
    showBackButtonTemporarily();
    if (event.keyCode === 461 || event.key === "Escape" || event.key === "Back") {
      event.preventDefault();
      closePlayer();
      return;
    }
    if (event.key === "MediaPlayPause" || event.keyCode === 415 || event.keyCode === 19) {
      event.preventDefault();
      if (video.paused) video.play().catch(() => {}); else video.pause();
      return;
    }
    const target = document.activeElement;
    const onControl = target && (target.tagName === "BUTTON" || target.tagName === "SELECT" || target.tagName === "INPUT");
    if (!onControl && (event.key === "ArrowLeft" || event.keyCode === 412)) {
      event.preventDefault();
      video.currentTime = Math.max(0, video.currentTime - 10);
      showControls();
    } else if (!onControl && (event.key === "ArrowRight" || event.keyCode === 417)) {
      event.preventDefault();
      video.currentTime = Math.min(video.duration || video.currentTime + 10, video.currentTime + 10);
      showControls();
    } else if (event.key === "Enter" && target === video) {
      event.preventDefault();
      if (video.paused) video.play().catch(() => {}); else video.pause();
    }
  });
  player.addEventListener("mousemove", showControls);
  player.addEventListener("click", showControls);
  document.getElementById("refresh").addEventListener("click", loadLibrary);
  loadLibrary();
})();