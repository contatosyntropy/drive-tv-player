(() => {
  const config = window.APP_CONFIG || {};
  const grid = document.getElementById("videos");
  const message = document.getElementById("message");
  const status = document.getElementById("status");
  const player = document.getElementById("player");
  const video = document.getElementById("video");
  const nowPlaying = document.getElementById("now-playing");
  const supported = /\.(mp4|m4v|webm|ogv|ogg|mov)$/i;
  let items = [];

  const formatSize = bytes => {
    if (!bytes) return "";
    const units = ["B", "KB", "MB", "GB"];
    let n = Number(bytes), i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return n.toFixed(i ? 1 : 0) + " " + units[i];
  };

  function setMessage(text) { message.textContent = text; }

  async function loadLibrary() {
    grid.innerHTML = "";
    if (!config.folderId || !config.apiKey || config.apiKey.includes("COLE_SUA")) {
      status.textContent = "Configuração necessária";
      setMessage("Adicione sua chave da API do Google Drive no arquivo config.js para carregar os vídeos.");
      return;
    }
    status.textContent = "Carregando…";
    setMessage("Buscando vídeos no Google Drive…");
    try {
      const q = encodeURIComponent("'" + config.folderId + "' in parents and trashed = false");
      const fields = encodeURIComponent("files(id,name,mimeType,size,thumbnailLink,webViewLink)");
      const url = "https://www.googleapis.com/drive/v3/files?q=" + q + "&pageSize=1000&orderBy=name&fields=" + fields + "&key=" + encodeURIComponent(config.apiKey);
      const response = await fetch(url);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error?.message || "Erro HTTP " + response.status);
      }
      const data = await response.json();
      items = (data.files || []).filter(file => file.mimeType?.startsWith("video/") || supported.test(file.name || ""));
      render();
      status.textContent = items.length + " vídeo(s)";
      setMessage(items.length ? "" : "Nenhum vídeo encontrado nessa pasta.");
    } catch (error) {
      console.error(error);
      status.textContent = "Falha ao carregar";
      setMessage("Não foi possível acessar a pasta: " + error.message + ". Verifique a chave da API, as permissões e se os vídeos estão compartilhados para acesso.");
    }
  }

  function render() {
    grid.innerHTML = "";
    items.forEach((file, index) => {
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

  function play(index) {
    const file = items[index];
    if (!file) return;
    nowPlaying.textContent = file.name;
    player.classList.remove("hidden");
    document.getElementById("library").classList.add("hidden");
    video.src = "https://drive.google.com/uc?export=download&id=" + encodeURIComponent(file.id);
    video.load();
    video.play().catch(() => {});
    video.dataset.index = String(index);
  }

  function closePlayer() {
    video.pause();
    video.removeAttribute("src");
    video.load();
    player.classList.add("hidden");
    document.getElementById("library").classList.remove("hidden");
  }

  document.getElementById("back").addEventListener("click", closePlayer);
  document.getElementById("refresh").addEventListener("click", loadLibrary);
  video.addEventListener("ended", () => {
    const next = Number(video.dataset.index) + 1;
    if (next < items.length) play(next);
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