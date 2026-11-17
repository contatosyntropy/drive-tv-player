(() => {
  const config = window.APP_CONFIG || {};
  const grid = document.getElementById("videos");
  const message = document.getElementById("message");
  const status = document.getElementById("status");
  const player = document.getElementById("player");
  const video = document.getElementById("video");
  const playerHud = document.getElementById("player-hud");
  const playerTitle = document.getElementById("player-title");
  const playerBadge = document.getElementById("player-badge");
  const playbackMessage = document.getElementById("playback-message");
  const subtitleOverlay = document.getElementById("subtitle-overlay");
  const closeBtn = document.getElementById("close-player");
  const seekBar = document.getElementById("seek-bar");
  const seekBuffered = document.getElementById("seek-buffered");
  const seekProgress = document.getElementById("seek-progress");
  const seekThumb = document.getElementById("seek-thumb");
  const btnRewind = document.getElementById("btn-rewind");
  const btnPlayPause = document.getElementById("btn-play-pause");
  const btnForward = document.getElementById("btn-forward");
  const timeDisplay = document.getElementById("time-display");
  const btnAudio = document.getElementById("btn-audio");
  const btnSubtitles = document.getElementById("btn-subtitles");
  const audioMenu = document.getElementById("audio-menu");
  const audioList = document.getElementById("audio-list");
  const subtitleMenu = document.getElementById("subtitle-menu");
  const subtitleList = document.getElementById("subtitle-list");
  const subSizeSmall = document.getElementById("sub-size-small");
  const subSizeMedium = document.getElementById("sub-size-medium");
  const subSizeLarge = document.getElementById("sub-size-large");
  const subSyncMinus = document.getElementById("sub-sync-minus");
  const subSyncValue = document.getElementById("sub-sync-value");
  const subSyncPlus = document.getElementById("sub-sync-plus");

  const supported = /\.(mp4|m4v|webm|ogv|ogg|mov|mkv|avi|ts)$/i;
  const subtitlePattern = /\.(srt|vtt)$/i;
  let items = [];
  let subtitleFiles = [];
  let folders = [];
  let currentFolderId = config.folderId;
  let visibleVideos = [];
  let currentVideoIndex = -1;
  let retriedAlternativeMime = false;
  let playbackAttempt = 0;
  let fallbackTransitionPending = false;
  let fallbackTransitionTimer = null;
  let playbackSessionToken = 0;
  let startupWatchdog = null;
  let probedAudioForIndex = -1;
  let playerHistoryActive = false;
  let hudTimer = null;
  let toastTimer = null;
  let subtitleRenderRaf = null;
  let mkvAudioHints = [];
  let availableSubtitles = [];
  let activeSubtitleId = "off";
  let parsedCues = [];
  let subtitleOffsetSec = 0;
  let subtitleLoadToken = 0;
  let lastRenderedCueText = "";

  function isWebOS() {
    return Boolean(window.webOS || window.PalmSystem || /Web0S|webOS|WebAppManager|LG Browser|NetCast|SmartTV/i.test(navigator.userAgent || ""));
  }

  function formatSize(bytes) {
    if (!bytes) return "";
    const units = ["B", "KB", "MB", "GB"];
    let n = Number(bytes);
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return n.toFixed(i ? 1 : 0) + " " + units[i];
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = v => (v < 10 ? "0" + v : String(v));
    return h > 0 ? h + ":" + pad(m) + ":" + pad(s) : pad(m) + ":" + pad(s);
  }

  function setMessage(text) { message.textContent = text; }

  function showToast(text, persistent) {
    clearTimeout(toastTimer);
    if (!text) {
      playbackMessage.textContent = "";
      playbackMessage.classList.add("hidden");
      return;
    }
    playbackMessage.textContent = text;
    playbackMessage.classList.remove("hidden");
    if (!persistent) toastTimer = setTimeout(() => playbackMessage.classList.add("hidden"), 2800);
  }

  function apiUrl(path) {
    const base = (config.apiBaseUrl || "").replace(/\/$/, "");
    return base + path;
  }

  function videoSourceUrl(file, mimeParam) {
    const path = "/api/video/" + encodeURIComponent(file.id) + "/" + encodeURIComponent(file.name || "video.mp4");
    let url = apiUrl(path) + "?key=" + encodeURIComponent(config.apiKey);
    if (mimeParam) url += "&mime=" + encodeURIComponent(mimeParam);
    return url;
  }

  async function inspectMkvMedia(file) {
    const result = {
      httpStatus: 0, httpError: "", networkError: "", contentType: "",
      bytesRead: 0, videoTracks: [], audioTracks: []
    };
    if (!/\.mkv$/i.test(file.name || "")) return result;
    try {
      const response = await fetch(videoSourceUrl(file), {
        method: "GET",
        headers: { Range: "bytes=0-262143" },
        cache: "no-store"
      });
      result.httpStatus = response.status;
      result.contentType = response.headers.get("content-type") || "";
      if (!response.ok && response.status !== 206) {
        let detail = "";
        try {
          const data = await response.json();
          detail = data && data.error ? data.error : "";
        } catch (_) {}
        result.httpError = detail || ("HTTP " + response.status + " " + response.statusText);
        return result;
      }
      const buf = new Uint8Array(await response.arrayBuffer());
      result.bytesRead = buf.length;
      let pos = 0;
      const readVintId = offset => {
        if (offset >= buf.length) return null;
        const b0 = buf[offset];
        let width = 0;
        for (let i = 0; i < 4; i++) if (b0 & (0x80 >> i)) { width = i + 1; break; }
        if (!width || offset + width > buf.length) return null;
        let id = 0;
        for (let i = 0; i < width; i++) id = id * 256 + buf[offset + i];
        return { id, width };
      };
      const readVintSize = offset => {
        if (offset >= buf.length) return null;
        const b0 = buf[offset];
        let width = 0;
        for (let i = 0; i < 8; i++) if (b0 & (0x80 >> i)) { width = i + 1; break; }
        if (!width || offset + width > buf.length) return null;
        const mask = 0xff >>> width;
        let val = b0 & mask;
        let allOnes = val === mask;
        for (let i = 1; i < width; i++) {
          const b = buf[offset + i];
          val = val * 256 + b;
          if (b !== 0xff) allOnes = false;
        }
        return { size: allOnes ? null : val, width };
      };
      const decodeUtf8 = (offset, length) => {
        try { return new TextDecoder("utf-8").decode(buf.subarray(offset, offset + length)).replace(/\0+$/, ""); }
        catch (_) { return ""; }
      };
      let inTracks = false, tracksEnd = buf.length, inEntry = false, entryEnd = 0, current = null;
      const finishTrack = () => {
        if (!current) return;
        if (current.type === 1) result.videoTracks.push(current);
        else if (current.type === 2) result.audioTracks.push(current);
        current = null;
      };
      while (pos + 2 < buf.length) {
        if (inEntry && pos >= entryEnd) { finishTrack(); inEntry = false; }
        if (inTracks && pos >= tracksEnd) break;
        const idInfo = readVintId(pos);
        if (!idInfo) break;
        const sizeInfo = readVintSize(pos + idInfo.width);
        if (!sizeInfo) break;
        const dataStart = pos + idInfo.width + sizeInfo.width;
        const size = sizeInfo.size;
        if (idInfo.id === 0x18538067) { pos = dataStart; continue; }
        if (idInfo.id === 0x1654ae6b) {
          inTracks = true;
          tracksEnd = size !== null ? Math.min(buf.length, dataStart + size) : buf.length;
          pos = dataStart; continue;
        }
        if (idInfo.id === 0xae && inTracks) {
          if (inEntry) finishTrack();
          inEntry = true;
          entryEnd = size !== null ? Math.min(tracksEnd, dataStart + size) : tracksEnd;
          current = { type: 0, name: "", lang: "", codec: "", avcProfile: null, bitDepth: null };
          pos = dataStart; continue;
        }
        if (idInfo.id === 0x1f43b675) { if (inEntry) finishTrack(); break; }
        if (size === null || dataStart + size > buf.length) break;
        if (inEntry && current) {
          if (idInfo.id === 0x83) {
            let value = 0;
            for (let i = 0; i < size; i++) value = value * 256 + buf[dataStart + i];
            current.type = value;
          } else if (idInfo.id === 0x536e) current.name = decodeUtf8(dataStart, size);
          else if (idInfo.id === 0x22b59c || idInfo.id === 0x22b59d) {
            const lang = decodeUtf8(dataStart, size);
            if (lang && lang !== "und") current.lang = lang;
          } else if (idInfo.id === 0x86) current.codec = decodeUtf8(dataStart, size);
          else if (idInfo.id === 0x63a2 && size >= 4) {
            // AVCDecoderConfigurationRecord: configurationVersion, AVCProfileIndication, profile_compatibility, AVCLevelIndication.
            current.avcProfile = buf[dataStart + 1];
          } else if (idInfo.id === 0x55b0 && size > 0) {
            current.bitDepth = buf[dataStart + size - 1];
          }
        }
        pos = dataStart + size;
      }
      if (inEntry && current) finishTrack();
      return result;
    } catch (error) {
      result.networkError = error && error.message ? error.message : String(error || "Falha de rede");
      return result;
    }
  }

  function probeMkvAudioHints(file) {
    return inspectMkvMedia(file).then(result => result.audioTracks || []);
  }

  function friendlyLangName(code) {
    if (!code) return "";
    const map = {
      por: "Português", pt: "Português", "pt-br": "Português (Brasil)", "pt-pt": "Português (Portugal)",
      eng: "Inglês", en: "Inglês", "en-us": "Inglês (EUA)", spa: "Espanhol", es: "Espanhol",
      jpn: "Japonês", ja: "Japonês", fre: "Francês", fra: "Francês", fr: "Francês",
      ger: "Alemão", deu: "Alemão", de: "Alemão", ita: "Italiano", it: "Italiano", kor: "Coreano", ko: "Coreano"
    };
    const key = String(code).trim().toLowerCase();
    return map[key] || String(code).toUpperCase();
  }

  function isAnyMenuOpen() {
    return !audioMenu.classList.contains("hidden") || !subtitleMenu.classList.contains("hidden");
  }
  function isHudVisible() { return !playerHud.classList.contains("hud-hidden"); }
  function showHud() {
    playerHud.classList.remove("hud-hidden");
    player.classList.add("hud-visible");
    clearTimeout(hudTimer);
    if (!video.paused && !isAnyMenuOpen()) {
      hudTimer = setTimeout(() => {
        if (!player.classList.contains("hidden") && !video.paused && !isAnyMenuOpen()) hideHud();
      }, 4200);
    }
  }
  function hideHud() {
    if (isAnyMenuOpen()) return;
    playerHud.classList.add("hud-hidden");
    player.classList.remove("hud-visible");
  }
  function closeMenus(restoreFocusBtn) {
    audioMenu.classList.add("hidden");
    subtitleMenu.classList.add("hidden");
    btnAudio.setAttribute("aria-expanded", "false");
    btnSubtitles.setAttribute("aria-expanded", "false");
    if (restoreFocusBtn) restoreFocusBtn.focus();
    showHud();
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
        throw new Error((data.error && data.error.message) || "Erro HTTP " + response.status);
      }
      const data = await response.json();
      for (const file of (data.files || [])) {
        if (file.mimeType === folderMime) {
          const folder = { id: file.id, name: file.name, parentId: folderId, folderPath: folderPath };
          folders.push(folder);
          collected.push.apply(collected, await listFolder(file.id, folderPath ? folderPath + " / " + file.name : file.name, visited));
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
        const match = name.match(/\bS(\d{1,2})\s*E(\d{1,3})\b/i);
        return match ? { season: Number(match[1]), episode: Number(match[2]) } : null;
      };
      items.sort((a, b) => {
        const ea = episodeCode(a.name);
        const eb = episodeCode(b.name);
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
      setMessage("Não foi possível acessar a pasta: " + error.message);
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
    if (!currentFolders.length && !visibleVideos.length) { setMessage("Esta pasta está vazia."); return; }
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

  function renderAudioMenu() {
    audioList.innerHTML = "";
    const tracks = video.audioTracks;
    const count = tracks ? tracks.length : 0;
    if (!count) {
      const empty = document.createElement("div");
      empty.className = "popover-item";
      empty.textContent = mkvAudioHints.length
        ? "Faixa padrão em reprodução (" + mkvAudioHints.length + " detectada(s))"
        : "Áudio padrão (faixa única)";
      audioList.appendChild(empty);
      return;
    }
    for (let i = 0; i < count; i++) {
      const track = tracks[i];
      const hint = mkvAudioHints[i] || {};
      const langLabel = friendlyLangName(track.language || hint.lang);
      const customName = track.label || hint.name || "";
      const primaryText = customName && langLabel && customName.toLowerCase() !== langLabel.toLowerCase()
        ? langLabel + " — " + customName : (customName || langLabel || ("Faixa de Áudio " + (i + 1)));
      const subParts = ["Faixa " + (i + 1)];
      if (hint.codec) subParts.push(hint.codec);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "popover-item" + (track.enabled ? " active" : "");
      btn.innerHTML = '<span><span></span><span class="popover-item-sub"></span></span><span class="popover-check">' + (track.enabled ? "✓" : "") + "</span>";
      btn.querySelector("span > span").textContent = primaryText;
      btn.querySelector(".popover-item-sub").textContent = subParts.join(" • ");
      btn.addEventListener("click", () => {
        for (let j = 0; j < tracks.length; j++) tracks[j].enabled = (j === i);
        renderAudioMenu();
        showToast("Áudio: " + primaryText);
        closeMenus(btnAudio);
      });
      audioList.appendChild(btn);
    }
  }

  function clearSubtitles() {
    subtitleLoadToken++;
    parsedCues = [];
    lastRenderedCueText = "";
    subtitleOverlay.innerHTML = "";
    subtitleOverlay.classList.add("hidden");
  }

  function findFolderSubtitles(videoFile) {
    const videoBase = videoFile.name.replace(/\.[^.]+$/, "").trim().toLowerCase();
    const epMatch = videoBase.match(/\bs\d{1,2}\s*e\d{1,3}\b/i);
    const epTag = epMatch ? epMatch[0].replace(/\s+/g, "").toLowerCase() : "";
    const inSameFolder = subtitleFiles.filter(f => (f.folderPath || "") === (videoFile.folderPath || ""));
    const exactMatches = [];
    const episodeMatches = [];
    const otherFolderSubs = [];
    inSameFolder.forEach(sub => {
      const subBase = sub.name.replace(/\.(srt|vtt)$/i, "").trim().toLowerCase();
      if (subBase === videoBase || subBase.startsWith(videoBase + ".")) exactMatches.push(sub);
      else if (epTag && subBase.replace(/\s+/g, "").includes(epTag)) episodeMatches.push(sub);
      else otherFolderSubs.push(sub);
    });
    return exactMatches.concat(episodeMatches, otherFolderSubs).map(sub => {
      const rawNoExt = sub.name.replace(/\.(srt|vtt)$/i, "");
      const videoNoExt = videoFile.name.replace(/\.[^.]+$/, "");
      let label = rawNoExt;
      if (rawNoExt.toLowerCase().startsWith(videoNoExt.toLowerCase() + ".")) {
        const suffix = rawNoExt.slice(videoNoExt.length + 1);
        label = friendlyLangName(suffix) + " (" + suffix + ")";
      } else if (rawNoExt.toLowerCase() === videoNoExt.toLowerCase()) label = "Português / Padrão";
      return { file: sub, label: label };
    });
  }

  function decodeSubtitleBuffer(buffer, contentType) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF)
      return new TextDecoder("utf-8").decode(bytes.subarray(3));
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE)
      return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF)
      return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    const declared = (contentType || "").match(/charset=([^;]+)/i);
    if (declared) {
      try { return new TextDecoder(declared[1].replace(/["']/g, "").trim()).decode(bytes); } catch (_) {}
    }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch (_) { return new TextDecoder("windows-1252").decode(bytes); }
  }

  function parseTimestampToSeconds(ts) {
    const clean = ts.trim().replace(",", ".");
    const parts = clean.split(":");
    if (parts.length === 3) return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
    if (parts.length === 2) return Number(parts[0]) * 60 + Number(parts[1]);
    return NaN;
  }

  function parseSrtOrVtt(rawText) {
    const text = rawText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const blocks = text.split(/\n{2,}/);
    const cues = [];
    for (let i = 0; i < blocks.length; i++) {
      const lines = blocks[i].trim().split("\n");
      if (!lines.length || lines[0].startsWith("WEBVTT") || lines[0].startsWith("NOTE")) continue;
      let timeLineIdx = 0;
      if (lines.length >= 2 && lines[1].indexOf("-->") !== -1) timeLineIdx = 1;
      else if (lines[0].indexOf("-->") === -1) continue;
      const timeParts = lines[timeLineIdx].split("-->");
      if (timeParts.length < 2) continue;
      const start = parseTimestampToSeconds(timeParts[0]);
      const end = parseTimestampToSeconds(timeParts[1].trim().split(/\s+/)[0]);
      const bodyLines = lines.slice(timeLineIdx + 1).join("\n").trim();
      if (Number.isFinite(start) && Number.isFinite(end) && bodyLines) {
        const cleaned = bodyLines.replace(/\{\\[^}]+\}/g, "").replace(/<[^>]+>/g, "").trim();
        if (cleaned) cues.push({ start: start, end: end, text: cleaned });
      }
    }
    return cues;
  }

  async function selectSubtitle(subEntry, silent) {
    clearSubtitles();
    if (!subEntry) {
      activeSubtitleId = "off";
      renderSubtitleMenu();
      if (!silent) showToast("Legendas desativadas");
      return;
    }
    const token = ++subtitleLoadToken;
    activeSubtitleId = subEntry.file.id;
    renderSubtitleMenu();
    try {
      const url = apiUrl("/api/subtitle/" + encodeURIComponent(subEntry.file.id)) + "?key=" + encodeURIComponent(config.apiKey);
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const buffer = await response.arrayBuffer();
      if (token !== subtitleLoadToken) return;
      parsedCues = parseSrtOrVtt(decodeSubtitleBuffer(buffer, response.headers.get("content-type")));
      lastRenderedCueText = "";
      if (!silent) showToast("Legenda: " + subEntry.label);
    } catch (error) {
      if (token !== subtitleLoadToken) return;
      console.error("Erro ao carregar legenda:", error);
      activeSubtitleId = "off";
      renderSubtitleMenu();
      if (!silent) showToast("Falha ao carregar legenda");
    }
  }

  function renderSubtitleOverlayNow() {
    if (player.classList.contains("hidden") || activeSubtitleId === "off" || !parsedCues.length) {
      if (lastRenderedCueText !== "") {
        lastRenderedCueText = "";
        subtitleOverlay.innerHTML = "";
        subtitleOverlay.classList.add("hidden");
      }
      return;
    }
    const t = video.currentTime - subtitleOffsetSec;
    const activeLines = [];
    for (let i = 0; i < parsedCues.length; i++) {
      const cue = parsedCues[i];
      if (t >= cue.start && t <= cue.end) activeLines.push(cue.text);
      else if (cue.start > t + 5 && activeLines.length > 0) break;
    }
    const combined = activeLines.join("\n");
    if (combined !== lastRenderedCueText) {
      lastRenderedCueText = combined;
      if (!combined) {
        subtitleOverlay.innerHTML = "";
        subtitleOverlay.classList.add("hidden");
      } else {
        subtitleOverlay.innerHTML = "";
        const box = document.createElement("span");
        box.className = "subtitle-box";
        box.textContent = combined;
        subtitleOverlay.appendChild(box);
        subtitleOverlay.classList.remove("hidden");
      }
    }
  }

  function startSubtitleLoop() {
    cancelAnimationFrame(subtitleRenderRaf);
    const tick = () => {
      renderSubtitleOverlayNow();
      if (!player.classList.contains("hidden")) subtitleRenderRaf = requestAnimationFrame(tick);
    };
    subtitleRenderRaf = requestAnimationFrame(tick);
  }

  function renderSubtitleMenu() {
    subtitleList.innerHTML = "";
    const offBtn = document.createElement("button");
    offBtn.type = "button";
    offBtn.className = "popover-item" + (activeSubtitleId === "off" ? " active" : "");
    offBtn.innerHTML = '<span>Desativada</span><span class="popover-check">' + (activeSubtitleId === "off" ? "✓" : "") + "</span>";
    offBtn.addEventListener("click", () => { selectSubtitle(null, false); closeMenus(btnSubtitles); });
    subtitleList.appendChild(offBtn);
    if (!availableSubtitles.length) {
      const none = document.createElement("div");
      none.className = "popover-item";
      none.innerHTML = '<span class="popover-item-sub">Nenhum arquivo .srt ou .vtt encontrado nesta pasta.</span>';
      subtitleList.appendChild(none);
      return;
    }
    availableSubtitles.forEach(entry => {
      const isSelected = activeSubtitleId === entry.file.id;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "popover-item" + (isSelected ? " active" : "");
      btn.innerHTML = '<span><span></span><span class="popover-item-sub"></span></span><span class="popover-check">' + (isSelected ? "✓" : "") + "</span>";
      btn.querySelector("span > span").textContent = entry.label;
      btn.querySelector(".popover-item-sub").textContent = entry.file.name;
      btn.addEventListener("click", () => { selectSubtitle(entry, false); closeMenus(btnSubtitles); });
      subtitleList.appendChild(btn);
    });
  }

  function updateProgressUi() {
    const duration = video.duration;
    const current = video.currentTime || 0;
    timeDisplay.textContent = formatTime(current) + " / " + formatTime(duration);
    if (Number.isFinite(duration) && duration > 0) {
      const pct = Math.max(0, Math.min(100, current / duration * 100));
      seekProgress.style.width = pct.toFixed(2) + "%";
      seekThumb.style.left = pct.toFixed(2) + "%";
      seekBar.setAttribute("aria-valuenow", String(Math.round(pct)));
      if (video.buffered && video.buffered.length > 0) {
        const buffEnd = video.buffered.end(video.buffered.length - 1);
        seekBuffered.style.width = Math.max(0, Math.min(100, buffEnd / duration * 100)).toFixed(2) + "%";
      }
    } else {
      seekProgress.style.width = "0%";
      seekThumb.style.left = "0%";
      seekBuffered.style.width = "0%";
    }
  }

  function seekRelative(deltaSec) {
    if (!Number.isFinite(video.currentTime)) return;
    const maxTime = Number.isFinite(video.duration) ? video.duration : video.currentTime + Math.abs(deltaSec);
    video.currentTime = Math.max(0, Math.min(maxTime, video.currentTime + deltaSec));
    updateProgressUi();
    renderSubtitleOverlayNow();
    showToast((deltaSec < 0 ? "↺ " : "↻ +") + deltaSec + "s");
    showHud();
  }

  function togglePlayPause() {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
    showHud();
  }

  function resetVideoSources() {
    clearTimeout(startupWatchdog);
    video.pause();
    video.removeAttribute("src");
    while (video.firstChild) video.removeChild(video.firstChild);
    video.load();
  }

  function buildWebOSMediaOption() {
    const options = {
      mediaTransportType: "URI",
      option: {
        mediaFormat: {
          type: "video"
        }
      }
    };
    return encodeURI(JSON.stringify(options));
  }

  async function diagnosePlaybackFailure(file, sessionToken) {
    if (sessionToken !== playbackSessionToken || player.classList.contains("hidden")) return;
    const mediaError = video.error;
    const errorCode = mediaError ? mediaError.code : 0;
    const errorNames = { 1: "MEDIA_ERR_ABORTED", 2: "MEDIA_ERR_NETWORK", 3: "MEDIA_ERR_DECODE", 4: "MEDIA_ERR_SRC_NOT_SUPPORTED" };
    const browserMessage = mediaError && mediaError.message ? mediaError.message : "";
    showToast("Código " + (errorCode || "desconhecido") + " — analisando MKV e conexão…", true);
    const report = await inspectMkvMedia(file);
    if (sessionToken !== playbackSessionToken || player.classList.contains("hidden")) return;
    const videoTrack = report.videoTracks[0];
    const audioTrack = report.audioTracks[0];
    const codecParts = [];
    if (videoTrack) {
      let videoLabel = videoTrack.codec || "codec de vídeo não identificado";
      if (videoTrack.avcProfile !== null && videoTrack.avcProfile !== undefined) {
        const profileNames = { 66: "Baseline", 77: "Main", 88: "Extended", 100: "High", 110: "High 10 (10-bit)", 122: "High 4:2:2", 244: "High 4:4:4" };
        videoLabel += " / perfil " + (profileNames[videoTrack.avcProfile] || videoTrack.avcProfile);
      }
      codecParts.push("Vídeo: " + videoLabel);
    } else codecParts.push("Vídeo: faixa não identificada");
    if (audioTrack) codecParts.push("Áudio: " + (audioTrack.codec || "codec não identificado"));
    else codecParts.push("Áudio: faixa não identificada");
    let diagnosis = "";
    if (videoTrack && /V_MPEG4\/ISO\/AVC/i.test(videoTrack.codec) && videoTrack.avcProfile === 110) {
      diagnosis = "H.264 High 10 / Hi10P (10-bit): incompatível com a decodificação H.264 por hardware da TV. ";
    } else if (videoTrack && /V_MPEGH\/ISO\/HEVC/i.test(videoTrack.codec)) {
      diagnosis = "Vídeo HEVC/H.265 detectado; perfil, nível e profundidade podem exceder o suporte do modelo. ";
    } else if (videoTrack && /V_AV1/i.test(videoTrack.codec)) {
      diagnosis = "AV1 detectado; não presumir suporte por hardware neste modelo webOS 6. ";
    }
    const networkParts = [];
    if (report.httpStatus) networkParts.push("HTTP " + report.httpStatus);
    if (report.httpError) networkParts.push("Resposta do servidor: " + report.httpError);
    if (report.networkError) networkParts.push("Rede: " + report.networkError);
    if (!networkParts.length) networkParts.push("Rede: inspeção respondeu; " + report.bytesRead + " bytes lidos");
    const details = [
      diagnosis + "Falha " + (errorNames[errorCode] || "de reprodução") + " (código " + (errorCode || "?") + ").",
      codecParts.join(" | "),
      networkParts.join(" | "),
      "MIME: " + (report.contentType || "não informado"),
      browserMessage ? "video.error.message: " + browserMessage : "video.error.message: indisponível no webOS"
    ];
    showToast(details.join(" — "), true);
    showHud();
    console.error("[Drive TV Player] Diagnóstico de reprodução", {
      file: file.name, errorCode, errorName: errorNames[errorCode] || "unknown",
      videoErrorMessage: browserMessage, httpStatus: report.httpStatus,
      httpError: report.httpError, networkError: report.networkError,
      contentType: report.contentType, bytesRead: report.bytesRead,
      videoTracks: report.videoTracks, audioTracks: report.audioTracks
    });
  }

  function isDriveQuotaError(status, detail) {
    return Number(status) === 403 &&
      /downloadQuotaExceeded|download quota exceeded|quota.{0,30}(exceeded|limit)|too many users have viewed or downloaded/i.test(String(detail || ""));
  }

  async function checkDriveQuota(file) {
    try {
      const response = await fetch(videoSourceUrl(file), {
        method: "GET",
        headers: { Range: "bytes=0-0" },
        cache: "no-store"
      });
      if (response.status !== 403) {
        if (response.body) await response.body.cancel().catch(() => {});
        return { exceeded: false, status: response.status, detail: "" };
      }
      let detail = "";
      const contentType = response.headers.get("content-type") || "";
      if (/json|text/i.test(contentType)) {
        try {
          const payload = await response.clone().json();
          detail = [
            payload.error,
            payload.message,
            payload.reason,
            payload.details && JSON.stringify(payload.details)
          ].filter(Boolean).join(" ");
        } catch (_) {
          try { detail = await response.text(); } catch (_) {}
        }
      }
      return { exceeded: isDriveQuotaError(response.status, detail), status: response.status, detail };
    } catch (error) {
      return { exceeded: false, status: 0, detail: error && error.message ? error.message : String(error) };
    }
  }

  function showQuotaExceededMessage() {
    clearTimeout(startupWatchdog);
    showToast(
      "Cota de download do Google Drive excedida para este arquivo (HTTP 403). " +
      "Para assistir agora, abra o Google Drive, clique com o botão direito no vídeo e escolha “Fazer uma cópia”. " +
      "Depois reproduza a cópia.",
      true
    );
    showHud();
  }

  function triggerNextAttempt(file, sessionToken, failedAttempt) {
    if (sessionToken !== playbackSessionToken || player.classList.contains("hidden")) return;
    if (playbackAttempt !== failedAttempt || fallbackTransitionPending) return;
    fallbackTransitionPending = true;
    clearTimeout(fallbackTransitionTimer);

    // Verifica a cota antes de alternar MIME ou iniciar outra tentativa.
    checkDriveQuota(file).then(quota => {
      if (sessionToken !== playbackSessionToken || player.classList.contains("hidden")) return;
      if (quota.exceeded) {
        showQuotaExceededMessage();
        return;
      }

      fallbackTransitionTimer = setTimeout(() => { fallbackTransitionPending = false; }, 1200);
      const isMkv = /\\.mkv$/i.test(file.name || "");
      if (isWebOS() && isMkv && failedAttempt < 3) {
        startStreamAttempt(file, failedAttempt + 1, sessionToken);
        return;
      }
      if (failedAttempt < 2) {
        startStreamAttempt(file, failedAttempt + 1, sessionToken);
        return;
      }
      clearTimeout(startupWatchdog);
      diagnosePlaybackFailure(file, sessionToken);
    }).catch(error => {
      console.warn("[Drive TV Player] Falha ao verificar cota do Drive:", error);
      fallbackTransitionPending = false;
    });
  }

  function startStreamAttempt(file, attempt, sessionToken) {
    if (sessionToken !== playbackSessionToken || player.classList.contains("hidden")) return;
    playbackAttempt = attempt;
    resetVideoSources();
    const isMkv = /\.mkv$/i.test(file.name || "");
    const isWebOsMkv = isWebOS() && isMkv;
    const sourceAttempt = isWebOS() && (attempt === 1 || (isWebOsMkv && attempt === 2));
    if (sourceAttempt) {
      const source = document.createElement("source");
      let sourceType = "video/mp4";
      let sourceUrl = videoSourceUrl(file);
      if (isWebOsMkv && attempt === 1) sourceType = "video/x-matroska";
      else if (isWebOsMkv && attempt === 2) {
        sourceType = "video/mp4";
        sourceUrl = videoSourceUrl(file, "octet");
      }
      source.setAttribute("src", sourceUrl);
      source.setAttribute("type", sourceType + ";mediaOption=" + buildWebOSMediaOption());
      source.addEventListener("error", () => triggerNextAttempt(file, sessionToken, attempt));
      video.appendChild(source);
      video.load();
    } else {
      video.src = videoSourceUrl(file);
      video.load();
    }
    startupWatchdog = setTimeout(() => {
      if (sessionToken !== playbackSessionToken || player.classList.contains("hidden")) return;
      if (video.readyState === 0) triggerNextAttempt(file, sessionToken, attempt);
    }, 6500);
    video.play().then(() => {
      if (sessionToken !== playbackSessionToken) return;
      if (video.readyState >= 3) showToast("");
      btnPlayPause.focus();
      showHud();
    }).catch(error => {
      if (sessionToken !== playbackSessionToken) return;
      if (error && error.name === "NotAllowedError") {
        showToast("Pressione OK / Play no controle da TV para iniciar.", true);
        btnPlayPause.focus();
      }
    });
  }
  async function play(index) {
    const file = visibleVideos[index];
    if (!file) return;
    currentVideoIndex = index;
    fallbackTransitionPending = false;
    clearTimeout(fallbackTransitionTimer);
    retriedAlternativeMime = false;
    probedAudioForIndex = -1;
    mkvAudioHints = [];
    subtitleOffsetSec = 0;
    subSyncValue.textContent = "0.0s";
    playerTitle.textContent = file.name;
    playerBadge.textContent = formatSize(file.size) || "Reproduzindo na TV";
    player.classList.remove("hidden");
    document.getElementById("library").classList.add("hidden");
    closeMenus();
    showHud();
    if (!playerHistoryActive) {
      history.pushState({ drivePlayer: true }, "", "#player");
      playerHistoryActive = true;
    }
    showToast("Carregando vídeo na TV…", true);
    availableSubtitles = findFolderSubtitles(file);
    if (availableSubtitles.length > 0) selectSubtitle(availableSubtitles[0], true);
    else selectSubtitle(null, true);
    const sessionToken = ++playbackSessionToken;
    startSubtitleLoop();
    startStreamAttempt(file, 1, sessionToken);
  }

  function closePlayer(fromHistory) {
    playbackSessionToken++;
    clearTimeout(startupWatchdog);
    clearTimeout(hudTimer);
    clearTimeout(toastTimer);
    cancelAnimationFrame(subtitleRenderRaf);
    showToast("");
    closeMenus();
    clearSubtitles();
    resetVideoSources();
    player.classList.add("hidden");
    document.getElementById("library").classList.remove("hidden");
    const cards = grid.querySelectorAll(".video-card");
    const targetCard = cards[currentVideoIndex];
    if (targetCard) targetCard.focus();
    if (!fromHistory && playerHistoryActive) {
      playerHistoryActive = false;
      history.back();
    } else if (fromHistory) playerHistoryActive = false;
  }

  video.addEventListener("loadedmetadata", () => {
    clearTimeout(startupWatchdog);
    fallbackTransitionPending = false;
    clearTimeout(fallbackTransitionTimer);
    updateProgressUi();
    renderAudioMenu();
    if (video.videoWidth && video.videoHeight) {
      const res = video.videoWidth + "×" + video.videoHeight;
      if (playerBadge.textContent.indexOf(res) === -1)
        playerBadge.textContent = res + (playerBadge.textContent ? " • " + playerBadge.textContent : "");
    }

    const file = visibleVideos[currentVideoIndex];
    if (file && probedAudioForIndex !== currentVideoIndex) {
      probedAudioForIndex = currentVideoIndex;
      inspectMkvMedia(file).then(probe => {
        if (currentVideoIndex !== probedAudioForIndex) return;
        mkvAudioHints = probe.audioTracks || [];
        if (mkvAudioHints.length > 0 && mkvAudioHints[0].codec) {
          playerBadge.textContent = (playerBadge.textContent ? playerBadge.textContent + " • " : "") +
            mkvAudioHints[0].codec + " • " + mkvAudioHints.length + " faixa(s)";
        }
        renderAudioMenu();
      });
    }
  });

  if (video.audioTracks && typeof video.audioTracks.addEventListener === "function") {
    video.audioTracks.addEventListener("addtrack", renderAudioMenu);
    video.audioTracks.addEventListener("change", renderAudioMenu);
  }

  video.addEventListener("canplay", () => {
    clearTimeout(startupWatchdog);
    if (!video.paused) showToast("");
  });
  video.addEventListener("playing", () => { btnPlayPause.textContent = "⏸ Pausar"; showToast(""); showHud(); });
  video.addEventListener("pause", () => { btnPlayPause.textContent = "▶ Play"; showHud(); });
  video.addEventListener("waiting", () => showToast("Carregando buffer…", true));
  video.addEventListener("seeked", () => {
    if (!video.paused && video.readyState >= 3) showToast("");
  });
  video.addEventListener("timeupdate", () => {
    updateProgressUi();
    renderSubtitleOverlayNow();
    if (!video.paused && video.readyState >= 3 &&
        playbackMessage.textContent.indexOf("Carregando") !== -1) showToast("");
  });
  video.addEventListener("progress", updateProgressUi);
  video.addEventListener("ended", () => { btnPlayPause.textContent = "▶ Play"; showHud(); });

  video.addEventListener("error", () => {
    if (player.classList.contains("hidden")) return;
    const file = visibleVideos[currentVideoIndex];
    if (file) triggerNextAttempt(file, playbackSessionToken, playbackAttempt);
  });

  closeBtn.addEventListener("click", () => closePlayer(false));
  btnPlayPause.addEventListener("click", togglePlayPause);
  btnRewind.addEventListener("click", () => seekRelative(-15));
  btnForward.addEventListener("click", () => seekRelative(15));
  seekBar.addEventListener("click", event => {
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    const rect = seekBar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    video.currentTime = ratio * video.duration;
    updateProgressUi();
    renderSubtitleOverlayNow();
    showHud();
  });

  btnAudio.addEventListener("click", () => {
    const opening = audioMenu.classList.contains("hidden");
    closeMenus();
    if (opening) {
      renderAudioMenu();
      audioMenu.classList.remove("hidden");
      btnAudio.setAttribute("aria-expanded", "true");
      const activeItem = audioList.querySelector(".popover-item.active") || audioList.querySelector("button");
      if (activeItem) activeItem.focus();
    }
  });
  btnSubtitles.addEventListener("click", () => {
    const opening = subtitleMenu.classList.contains("hidden");
    closeMenus();
    if (opening) {
      renderSubtitleMenu();
      subtitleMenu.classList.remove("hidden");
      btnSubtitles.setAttribute("aria-expanded", "true");
      const activeItem = subtitleList.querySelector(".popover-item.active") || subtitleList.querySelector("button");
      if (activeItem) activeItem.focus();
    }
  });

  function setSubtitleSize(sizeClass, activeBtn) {
    subtitleOverlay.classList.remove("size-small", "size-medium", "size-large");
    subtitleOverlay.classList.add(sizeClass);
    [subSizeSmall, subSizeMedium, subSizeLarge].forEach(b => b.classList.remove("active"));
    activeBtn.classList.add("active");
    showHud();
  }
  subSizeSmall.addEventListener("click", () => setSubtitleSize("size-small", subSizeSmall));
  subSizeMedium.addEventListener("click", () => setSubtitleSize("size-medium", subSizeMedium));
  subSizeLarge.addEventListener("click", () => setSubtitleSize("size-large", subSizeLarge));
  subSyncMinus.addEventListener("click", () => {
    subtitleOffsetSec = Math.round((subtitleOffsetSec - 0.5) * 10) / 10;
    subSyncValue.textContent = (subtitleOffsetSec > 0 ? "+" : "") + subtitleOffsetSec.toFixed(1) + "s";
    renderSubtitleOverlayNow();
    showHud();
  });
  subSyncPlus.addEventListener("click", () => {
    subtitleOffsetSec = Math.round((subtitleOffsetSec + 0.5) * 10) / 10;
    subSyncValue.textContent = (subtitleOffsetSec > 0 ? "+" : "") + subtitleOffsetSec.toFixed(1) + "s";
    renderSubtitleOverlayNow();
    showHud();
  });

  window.addEventListener("popstate", () => { if (playerHistoryActive) closePlayer(true); });
  window.addEventListener("keydown", event => {
    if (player.classList.contains("hidden")) return;
    if (event.keyCode === 461 || event.key === "Escape") {
      event.preventDefault();
      if (!audioMenu.classList.contains("hidden")) closeMenus(btnAudio);
      else if (!subtitleMenu.classList.contains("hidden")) closeMenus(btnSubtitles);
      else closePlayer(false);
      return;
    }
    if (event.key === "MediaPlayPause" || event.keyCode === 415 || event.keyCode === 19) {
      event.preventDefault(); togglePlayPause(); return;
    }
    if (event.key === "MediaRewind" || event.keyCode === 412) {
      event.preventDefault(); seekRelative(-15); return;
    }
    if (event.key === "MediaFastForward" || event.keyCode === 417) {
      event.preventDefault(); seekRelative(15); return;
    }
    if (event.key === "MediaStop" || event.keyCode === 413) {
      event.preventDefault(); closePlayer(false); return;
    }
    if (isAnyMenuOpen()) {
      const openMenu = !audioMenu.classList.contains("hidden") ? audioMenu : subtitleMenu;
      const focusables = Array.from(openMenu.querySelectorAll("button"));
      const idx = focusables.indexOf(document.activeElement);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        const next = focusables[(idx + 1) % focusables.length];
        if (next) next.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        const prev = focusables[(idx - 1 + focusables.length) % focusables.length];
        if (prev) prev.focus();
      }
      return;
    }
    if (!isHudVisible()) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault(); togglePlayPause(); btnPlayPause.focus();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault(); seekRelative(-15);
      } else if (event.key === "ArrowRight") {
        event.preventDefault(); seekRelative(15);
      } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault(); showHud(); btnPlayPause.focus();
      }
      return;
    }
    showHud();
    const active = document.activeElement;
    const bottomButtons = [btnRewind, btnPlayPause, btnForward, btnAudio, btnSubtitles];
    if (active === seekBar) {
      if (event.key === "ArrowLeft") { event.preventDefault(); seekRelative(-15); }
      else if (event.key === "ArrowRight") { event.preventDefault(); seekRelative(15); }
      else if (event.key === "ArrowDown") { event.preventDefault(); btnPlayPause.focus(); }
      else if (event.key === "ArrowUp") { event.preventDefault(); closeBtn.focus(); }
      else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); togglePlayPause(); }
      return;
    }
    const btnIdx = bottomButtons.indexOf(active);
    if (btnIdx !== -1) {
      if (event.key === "ArrowRight") { event.preventDefault(); bottomButtons[(btnIdx + 1) % bottomButtons.length].focus(); }
      else if (event.key === "ArrowLeft") { event.preventDefault(); bottomButtons[(btnIdx - 1 + bottomButtons.length) % bottomButtons.length].focus(); }
      else if (event.key === "ArrowUp") { event.preventDefault(); seekBar.focus(); }
      return;
    }
    if (active === closeBtn && event.key === "ArrowDown") { event.preventDefault(); seekBar.focus(); }
  });

  video.addEventListener("click", () => {
    if (isAnyMenuOpen()) { closeMenus(); return; }
    if (isHudVisible()) togglePlayPause();
    else { showHud(); btnPlayPause.focus(); }
  });
  player.addEventListener("mousemove", () => { if (!isAnyMenuOpen()) showHud(); });
  document.getElementById("refresh").addEventListener("click", loadLibrary);
  loadLibrary();
})();