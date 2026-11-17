/*
 * Experimental on-device MKV audio conversion for LG webOS 6.
 * FFmpeg runs in a Web Worker on the TV. The source is exposed as an
 * Emscripten lazy file so FFmpeg can request byte ranges instead of
 * downloading the entire MKV before starting.
 *
 * Test scope: first 120 seconds only. HLS output is held in browser memory.
 */
(() => {
  const video = document.getElementById("video");
  const CORE_JS = "https://unpkg.com/@ffmpeg/core-st@0.11.1/dist/ffmpeg-core.js";
  const MAX_TEST_SECONDS = 120;
  let ffmpeg = null;
  let hls = null;
  let objectUrls = [];
  let running = false;

  function message(text) {
    let node = document.getElementById("playback-message");
    if (!node && video) {
      node = document.createElement("p");
      node.id = "playback-message";
      node.className = "message";
      video.insertAdjacentElement("afterend", node);
    }
    if (node) node.textContent = text;
  }

  function releaseOutput() {
    if (hls) {
      hls.destroy();
      hls = null;
    }
    objectUrls.forEach(url => URL.revokeObjectURL(url));
    objectUrls = [];
  }

  function cleanupVirtualFs(engine) {
    if (!engine) return;
    try { engine.FS("unlink", "/input.mkv"); } catch (_) {}
    try { engine.FS("unlink", "/index.m3u8"); } catch (_) {}
    try { engine.FS("unlink", "/init.mp4"); } catch (_) {}
    try {
      const entries = engine.FS("readdir", "/");
      entries.forEach(name => {
        if (/^segment_\d+\.(ts|m4s)$/.test(name)) {
          try { engine.FS("unlink", "/" + name); } catch (_) {}
        }
      });
    } catch (_) {}
  }

  async function verifyRangeSource(sourceUrl, expectedSize) {
    message("Verificando leitura HTTP por partes no Google Drive…");
    const response = await fetch(sourceUrl, {
      method: "GET",
      headers: { Range: "bytes=0-4095" },
      cache: "no-store"
    });
    const contentRange = response.headers.get("Content-Range") || "";
    const validRange = response.status === 206 && /^bytes\s+0-\d+\/\d+$/i.test(contentRange);
    if (response.body) await response.body.cancel().catch(() => {});
    if (!validRange) {
      throw new Error("O Worker/Google Drive não confirmou HTTP Range. Esperado HTTP 206 com Content-Range; recebido HTTP " +
        response.status + (contentRange ? " (" + contentRange + ")" : "") + ".");
    }
    const total = Number(contentRange.split("/").pop());
    if (Number.isFinite(total) && expectedSize && total !== Number(expectedSize)) {
      throw new Error("O tamanho informado pelo catálogo diverge do tamanho entregue por HTTP Range.");
    }
    return total;
  }

  async function getFFmpeg() {
    if (ffmpeg) return ffmpeg;
    if (!window.FFmpeg || !window.FFmpeg.createFFmpeg) {
      throw new Error("Biblioteca FFmpeg.wasm não carregou. Verifique a conexão da TV.");
    }
    message("Carregando o motor FFmpeg na TV (primeira execução pode demorar)…");
    ffmpeg = window.FFmpeg.createFFmpeg({
      corePath: CORE_JS,
      mainName: "main",
      log: true,
      progress: ({ ratio }) => {
        if (Number.isFinite(ratio)) {
          message("Convertendo na TV: " + Math.max(0, Math.min(100, Math.round(ratio * 100))) + "% (amostra de 2 minutos)");
        }
      }
    });
    try {
      await ffmpeg.load();
    } catch (error) {
      const detail = error && error.message ? error.message : String(error);
      throw new Error("A TV não conseguiu reservar memória para iniciar o FFmpeg WebAssembly (modo de uma thread). Detalhe: " + detail);
    }
    return ffmpeg;
  }

  async function playMkvOnTv(file, sourceUrl) {
    if (running) throw new Error("Já existe uma conversão em andamento.");
    running = true;
    releaseOutput();
    let engine = null;
    try {
      if (Number(file.size) > 2000000000) {
        throw new Error("Este arquivo tem " + (Number(file.size) / 1000000000).toFixed(2) + " GB. O FFmpeg.wasm 0.11 tem limite documentado de entrada de 2 GB.");
      }

      await verifyRangeSource(sourceUrl, file.size);

      message("Iniciando FFmpeg na TV. O arquivo original permanece no Google Drive.");
      engine = await getFFmpeg();

      cleanupVirtualFs(engine);
      try {
        engine.FS("createLazyFile", "/", "input.mkv", sourceUrl, true, false);
      } catch (error) {
        throw new Error("O core FFmpeg não expõe o sistema de arquivos lazy necessário para leitura por partes (createLazyFile). Detalhe: " + error.message);
      }

      message("Leitura HTTP por partes confirmada. Convertendo o áudio para AAC…");
      await engine.run(
        "-analyzeduration", "10000000",
        "-probesize", "10000000",
        "-fflags", "+genpts",
        "-i", "/input.mkv",
        "-t", String(MAX_TEST_SECONDS),
        "-map", "0:v:0",
        "-map", "0:a:0?",
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        "-ac", "2",
        "-avoid_negative_ts", "make_zero",
        "-f", "hls",
        "-hls_time", "10",
        "-hls_playlist_type", "vod",
        "-hls_segment_type", "fmp4",
        "-hls_fmp4_init_filename", "init.mp4",
        "-hls_flags", "independent_segments",
        "-hls_segment_filename", "/segment_%03d.m4s",
        "/index.m3u8"
      );

      let playlist = new TextDecoder("utf-8").decode(engine.FS("readFile", "/index.m3u8"));
      const rootEntries = engine.FS("readdir", "/");
      const segmentNames = rootEntries.filter(name => /^segment_\d+\.m4s$/.test(name)).sort();
      if (!segmentNames.length) throw new Error("O FFmpeg terminou sem gerar segmentos HLS.");

      const urlsByName = {};
      if (rootEntries.includes("init.mp4")) {
        const initBytes = engine.FS("readFile", "/init.mp4");
        const initUrl = URL.createObjectURL(new Blob([initBytes], { type: "video/mp4" }));
        objectUrls.push(initUrl);
        urlsByName["init.mp4"] = initUrl;
      }

      segmentNames.forEach(name => {
        const bytes = engine.FS("readFile", "/" + name);
        const url = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
        objectUrls.push(url);
        urlsByName[name] = url;
      });

      cleanupVirtualFs(engine);

      playlist = playlist
        .split(/\r?\n/)
        .map(line => {
          const trimmed = line.trim();
          if (trimmed.startsWith("#EXT-X-MAP:")) {
            return trimmed.replace(/URI="([^"]+)"/, (_match, uri) => {
              return urlsByName[uri] ? `URI="${urlsByName[uri]}"` : `URI="${uri}"`;
            });
          }
          return urlsByName[trimmed] || line;
        })
        .join("\n");

      const playlistUrl = URL.createObjectURL(new Blob([playlist], { type: "application/vnd.apple.mpegurl" }));
      objectUrls.push(playlistUrl);

      video.classList.remove("hidden");
      video.controls = true;
      if (window.Hls && window.Hls.isSupported()) {
        hls = new window.Hls({
          enableWorker: false,
          maxBufferLength: 30,
          maxBufferHole: 0.5,
          nudgeOffset: 0.1,
          nudgeMaxRetry: 5,
          startPosition: 0
        });
        hls.loadSource(playlistUrl);
        hls.attachMedia(video);
        hls.on(window.Hls.Events.ERROR, (_event, data) => {
          if (data && data.fatal) message("Erro do player HLS: " + data.details);
        });
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = playlistUrl;
      } else {
        throw new Error("Este webOS não reconheceu HLS no elemento de vídeo.");
      }

      video.play().catch(error => message("Conversão concluída. Pressione Play no controle da TV. " + error.message));
      message("Conversão concluída na TV. Esta versão reproduz somente os primeiros 120 segundos para validar o processamento local.");
    } finally {
      cleanupVirtualFs(engine);
      running = false;
    }
  }

  function stopTvTranscode() {
    releaseOutput();
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
  }

  window.playMkvOnTv = playMkvOnTv;
  window.stopTvTranscode = stopTvTranscode;
})();
