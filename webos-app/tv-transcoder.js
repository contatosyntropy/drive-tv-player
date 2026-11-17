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
  const FFMPEG_JS = "https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js";
  const CORE_JS = "https://unpkg.com/@ffmpeg/core-st@0.11.1/dist/ffmpeg-core.js";
  const HLS_JS = "https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js";
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

  function loadExternalScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector('script[src="' + src + '"]');
      if (existing) {
        if (existing.dataset.loaded === "1") return resolve();
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error("Falha ao carregar " + src)), { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.onload = () => { script.dataset.loaded = "1"; resolve(); };
      script.onerror = () => reject(new Error("Falha ao carregar " + src));
      document.head.appendChild(script);
    });
  }

  async function ensureLibraries() {
    if (!window.FFmpeg || !window.FFmpeg.createFFmpeg) await loadExternalScript(FFMPEG_JS);
    if (!window.Hls) await loadExternalScript(HLS_JS);
    if (!window.FFmpeg || !window.FFmpeg.createFFmpeg) throw new Error("FFmpeg.wasm não foi carregado. Verifique a conexão da TV.");
    if (!window.Hls) throw new Error("HLS.js não foi carregado. Verifique a conexão da TV.");
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

  // Lê os timestamps reais (PTS) de cada fotograma de vídeo diretamente dos blocos Matroska.
  async function extractMkvVideoPts(sourceUrl, maxSeconds) {
    message("Mapeando timestamps originais dos frames no MKV…");
    const response = await fetch(sourceUrl, {
      method: "GET",
      headers: { Range: "bytes=0-" },
      cache: "no-store"
    });
    if (!response.ok || !response.body) {
      throw new Error("Não foi possível ler o fluxo Matroska para extrair os timestamps.");
    }

    const reader = response.body.getReader();
    let buf = new Uint8Array(0);
    let eof = false;
    let skipRemaining = 0;

    const appendChunk = chunk => {
      if (!buf.length) {
        buf = chunk;
        return;
      }
      const next = new Uint8Array(buf.length + chunk.length);
      next.set(buf, 0);
      next.set(chunk, buf.length);
      buf = next;
    };

    const consume = n => {
      buf = buf.subarray(n);
    };

    const ensureBytes = async n => {
      while (buf.length < n && !eof) {
        const { value, done } = await reader.read();
        if (done) {
          eof = true;
          break;
        }
        if (value && value.length) appendChunk(value);
      }
      return buf.length >= n;
    };

    const skipBytes = async n => {
      let left = n;
      while (left > 0) {
        if (buf.length > 0) {
          const take = Math.min(buf.length, left);
          consume(take);
          left -= take;
        } else {
          if (eof) return false;
          const { value, done } = await reader.read();
          if (done) {
            eof = true;
            return false;
          }
          if (value && value.length) appendChunk(value);
        }
      }
      return true;
    };

    const readVintId = () => {
      if (buf.length < 1) return null;
      const b0 = buf[0];
      let width = 0;
      for (let i = 0; i < 4; i++) {
        if (b0 & (0x80 >> i)) {
          width = i + 1;
          break;
        }
      }
      if (!width || buf.length < width) return null;
      let id = 0;
      for (let i = 0; i < width; i++) id = id * 256 + buf[i];
      return { id, width };
    };

    const readVintSize = offset => {
      if (buf.length <= offset) return null;
      const b0 = buf[offset];
      let width = 0;
      for (let i = 0; i < 8; i++) {
        if (b0 & (0x80 >> i)) {
          width = i + 1;
          break;
        }
      }
      if (!width || buf.length < offset + width) return null;
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

    const readUintBE = (offset, len) => {
      let val = 0;
      for (let i = 0; i < len; i++) val = val * 256 + buf[offset + i];
      return val;
    };

    const CONTAINER_IDS = new Set([
      0x18538067, // Segment
      0x1549a966, // Info
      0x1654ae6b, // Tracks
      0xae,       // TrackEntry
      0x1f43b675, // Cluster
      0xa0        // BlockGroup
    ]);

    let timecodeScale = 1000000; // 1 ms por padrão
    let videoTrackNumber = 1;
    let inTrackEntry = false;
    let trackEntryEnd = 0;
    let currentTrackNum = null;
    let currentTrackType = null;
    let streamOffset = 0;
    let clusterTimecode = 0;
    const videoPtsMs = [];
    const limitMs = (maxSeconds + 6) * 1000;

    try {
      while (true) {
        if (inTrackEntry && streamOffset >= trackEntryEnd) {
          if (currentTrackType === 1 && currentTrackNum !== null) {
            videoTrackNumber = currentTrackNum;
          }
          inTrackEntry = false;
        }

        if (!(await ensureBytes(12))) break;
        const idInfo = readVintId();
        if (!idInfo) break;
        const sizeInfo = readVintSize(idInfo.width);
        if (!sizeInfo) {
          if (!(await ensureBytes(idInfo.width + 8))) break;
          continue;
        }

        const headerLen = idInfo.width + sizeInfo.width;
        const { id } = idInfo;
        const { size } = sizeInfo;

        if (CONTAINER_IDS.has(id)) {
          consume(headerLen);
          streamOffset += headerLen;
          if (id === 0xae && size !== null) {
            inTrackEntry = true;
            trackEntryEnd = streamOffset + size;
            currentTrackNum = null;
            currentTrackType = null;
          }
          continue;
        }

        if (size === null) {
          consume(headerLen);
          streamOffset += headerLen;
          continue;
        }

        if (id === 0x2ad7b1 || id === 0xd7 || id === 0x83 || id === 0xe7) {
          if (!(await ensureBytes(headerLen + size))) break;
          const val = readUintBE(headerLen, size);
          if (id === 0x2ad7b1) timecodeScale = val || 1000000;
          else if (id === 0xd7) currentTrackNum = val;
          else if (id === 0x83) currentTrackType = val;
          else if (id === 0xe7) {
            clusterTimecode = val;
            if ((clusterTimecode * timecodeScale) / 1000000 > limitMs) {
              break;
            }
          }
          consume(headerLen + size);
          streamOffset += headerLen + size;
          continue;
        }

        if (id === 0xa3 || id === 0xa1) {
          const probeLen = Math.min(size, 12);
          if (!(await ensureBytes(headerLen + probeLen))) break;
          const trackVint = readVintSize(headerLen);
          if (trackVint && headerLen + trackVint.width + 2 <= buf.length) {
            const trackNum = trackVint.size;
            const relOffset = headerLen + trackVint.width;
            const rawRel = (buf[relOffset] << 8) | buf[relOffset + 1];
            const relTime = rawRel >= 0x8000 ? rawRel - 0x10000 : rawRel;
            if (trackNum === videoTrackNumber) {
              const ptsMs = ((clusterTimecode + relTime) * timecodeScale) / 1000000;
              videoPtsMs.push(ptsMs);
            }
          }
          consume(headerLen);
          streamOffset += headerLen;
          if (!(await skipBytes(size))) break;
          streamOffset += size;
          continue;
        }

        consume(headerLen);
        streamOffset += headerLen;
        if (!(await skipBytes(size))) break;
        streamOffset += size;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }

    return videoPtsMs;
  }

  function findBoxes(bytes, start = 0, end = bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const boxes = [];
    let pos = start;
    while (pos + 8 <= end) {
      let size = view.getUint32(pos);
      const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
      let headerSize = 8;
      if (size === 1) {
        if (pos + 16 > end) break;
        size = Number(view.getBigUint64(pos + 8));
        headerSize = 16;
      } else if (size === 0) {
        size = end - pos;
      }
      if (size < headerSize || pos + size > end) break;
      boxes.push({ type, start: pos, contentStart: pos + headerSize, end: pos + size, size });
      pos += size;
    }
    return boxes;
  }

  function parseInitMp4(initBytes) {
    const view = new DataView(initBytes.buffer, initBytes.byteOffset, initBytes.byteLength);
    const moov = findBoxes(initBytes).find(b => b.type === "moov");
    if (!moov) return null;

    let videoTrackId = 1;
    let videoTimescale = 24000;
    let videoDefaultDuration = 1001;
    let audioTrackId = 2;
    let audioTimescale = 48000;

    const moovChildren = findBoxes(initBytes, moov.contentStart, moov.end);
    for (const trak of moovChildren.filter(b => b.type === "trak")) {
      const trakChildren = findBoxes(initBytes, trak.contentStart, trak.end);
      const tkhd = trakChildren.find(b => b.type === "tkhd");
      const mdia = trakChildren.find(b => b.type === "mdia");
      if (!tkhd || !mdia) continue;

      const tkhdVer = initBytes[tkhd.contentStart];
      const trackId = view.getUint32(tkhd.contentStart + (tkhdVer === 1 ? 20 : 12));

      const mdiaChildren = findBoxes(initBytes, mdia.contentStart, mdia.end);
      const mdhd = mdiaChildren.find(b => b.type === "mdhd");
      const hdlr = mdiaChildren.find(b => b.type === "hdlr");
      if (!mdhd || !hdlr) continue;

      const mdhdVer = initBytes[mdhd.contentStart];
      const timescale = view.getUint32(mdhd.contentStart + (mdhdVer === 1 ? 20 : 12));
      const handler = String.fromCharCode(
        initBytes[hdlr.contentStart + 8],
        initBytes[hdlr.contentStart + 9],
        initBytes[hdlr.contentStart + 10],
        initBytes[hdlr.contentStart + 11]
      );

      if (handler === "vide") {
        videoTrackId = trackId;
        videoTimescale = timescale;
      } else if (handler === "soun") {
        audioTrackId = trackId;
        audioTimescale = timescale;
      }
    }

    const mvex = moovChildren.find(b => b.type === "mvex");
    if (mvex) {
      for (const trex of findBoxes(initBytes, mvex.contentStart, mvex.end).filter(b => b.type === "trex")) {
        const trackId = view.getUint32(trex.contentStart + 4);
        const defDur = view.getUint32(trex.contentStart + 12);
        if (trackId === videoTrackId && defDur > 0) {
          videoDefaultDuration = defDur;
        }
      }
    }

    return { videoTrackId, videoTimescale, videoDefaultDuration, audioTrackId, audioTimescale };
  }

  function inspectFragmentTrack(m4sBytes, targetTrackId, fallbackDuration) {
    const view = new DataView(m4sBytes.buffer, m4sBytes.byteOffset, m4sBytes.byteLength);
    const moof = findBoxes(m4sBytes).find(b => b.type === "moof");
    if (!moof) return null;

    for (const traf of findBoxes(m4sBytes, moof.contentStart, moof.end).filter(b => b.type === "traf")) {
      const trafChildren = findBoxes(m4sBytes, traf.contentStart, traf.end);
      const tfhd = trafChildren.find(b => b.type === "tfhd");
      const tfdt = trafChildren.find(b => b.type === "tfdt");
      const trun = trafChildren.find(b => b.type === "trun");
      if (!tfhd || !trun) continue;

      const tfhdFlags = (m4sBytes[tfhd.contentStart + 1] << 16) | (m4sBytes[tfhd.contentStart + 2] << 8) | m4sBytes[tfhd.contentStart + 3];
      const trackId = view.getUint32(tfhd.contentStart + 4);
      if (trackId !== targetTrackId) continue;

      let tfhdPos = tfhd.contentStart + 8;
      if (tfhdFlags & 0x000001) tfhdPos += 8;
      if (tfhdFlags & 0x000002) tfhdPos += 4;
      let defaultDuration = fallbackDuration;
      if (tfhdFlags & 0x000008) {
        defaultDuration = view.getUint32(tfhdPos);
      }

      let baseDecodeTime = 0;
      if (tfdt) {
        const tfdtVer = m4sBytes[tfdt.contentStart];
        baseDecodeTime = tfdtVer === 1
          ? Number(view.getBigUint64(tfdt.contentStart + 4))
          : view.getUint32(tfdt.contentStart + 4);
      }

      const trunFlags = (m4sBytes[trun.contentStart + 1] << 16) | (m4sBytes[trun.contentStart + 2] << 8) | m4sBytes[trun.contentStart + 3];
      const sampleCount = view.getUint32(trun.contentStart + 4);
      let cursor = trun.contentStart + 8;
      if (trunFlags & 0x000001) cursor += 4;
      if (trunFlags & 0x000004) cursor += 4;

      const hasDur = !!(trunFlags & 0x000100);
      const hasSize = !!(trunFlags & 0x000200);
      const hasFlags = !!(trunFlags & 0x000400);
      const hasCts = !!(trunFlags & 0x000800);

      const durations = [];
      for (let i = 0; i < sampleCount; i++) {
        const dur = hasDur ? view.getUint32(cursor) : defaultDuration;
        durations.push(dur);
        if (hasDur) cursor += 4;
        if (hasSize) cursor += 4;
        if (hasFlags) cursor += 4;
        if (hasCts) cursor += 4;
      }

      return { moof, traf, tfdt, trun, baseDecodeTime, durations };
    }
    return null;
  }

  function patchFragmentCts(m4sBytes, meta, ctsList, audioShiftTicks) {
    const view = new DataView(m4sBytes.buffer, m4sBytes.byteOffset, m4sBytes.byteLength);
    const vInfo = inspectFragmentTrack(m4sBytes, meta.videoTrackId, meta.videoDefaultDuration);
    if (!vInfo || !ctsList.length) return m4sBytes;

    // Ajusta o tfdt do áudio se houver deslocamento positivo no vídeo para manter sincronia labial exata.
    if (audioShiftTicks > 0) {
      const aInfo = inspectFragmentTrack(m4sBytes, meta.audioTrackId, 1024);
      if (aInfo && aInfo.tfdt) {
        const tfdtVer = m4sBytes[aInfo.tfdt.contentStart];
        if (tfdtVer === 1) {
          const cur = view.getBigUint64(aInfo.tfdt.contentStart + 4);
          view.setBigUint64(aInfo.tfdt.contentStart + 4, cur + BigInt(audioShiftTicks));
        } else {
          const cur = view.getUint32(aInfo.tfdt.contentStart + 4);
          view.setUint32(aInfo.tfdt.contentStart + 4, (cur + audioShiftTicks) >>> 0);
        }
      }
    }

    const { moof, traf, trun } = vInfo;
    const trunVersion = m4sBytes[trun.contentStart];
    const oldFlags = (m4sBytes[trun.contentStart + 1] << 16) | (m4sBytes[trun.contentStart + 2] << 8) | m4sBytes[trun.contentStart + 3];
    const sampleCount = view.getUint32(trun.contentStart + 4);
    const hadCts = !!(oldFlags & 0x000800);
    const newFlags = oldFlags | 0x000800;
    const addedBytes = hadCts ? 0 : sampleCount * 4;

    const newTrunSize = trun.size + addedBytes;
    const newTrun = new Uint8Array(newTrunSize);
    const newTrunView = new DataView(newTrun.buffer);

    newTrunView.setUint32(0, newTrunSize);
    newTrun.set([0x74, 0x72, 0x75, 0x6e], 4); // 'trun'
    newTrun[8] = trunVersion;
    newTrun[9] = (newFlags >> 16) & 0xff;
    newTrun[10] = (newFlags >> 8) & 0xff;
    newTrun[11] = newFlags & 0xff;
    newTrunView.setUint32(12, sampleCount);

    let inPos = trun.contentStart + 8;
    let outPos = 16;

    if (oldFlags & 0x000001) {
      const oldDataOffset = view.getInt32(inPos);
      newTrunView.setInt32(outPos, oldDataOffset + addedBytes);
      inPos += 4;
      outPos += 4;
    }
    if (oldFlags & 0x000004) {
      newTrunView.setUint32(outPos, view.getUint32(inPos));
      inPos += 4;
      outPos += 4;
    }

    const hasDur = !!(oldFlags & 0x000100);
    const hasSize = !!(oldFlags & 0x000200);
    const hasFlags = !!(oldFlags & 0x000400);

    for (let i = 0; i < sampleCount; i++) {
      if (hasDur) {
        newTrunView.setUint32(outPos, view.getUint32(inPos));
        inPos += 4;
        outPos += 4;
      }
      if (hasSize) {
        newTrunView.setUint32(outPos, view.getUint32(inPos));
        inPos += 4;
        outPos += 4;
      }
      if (hasFlags) {
        newTrunView.setUint32(outPos, view.getUint32(inPos));
        inPos += 4;
        outPos += 4;
      }
      if (hadCts) inPos += 4;
      const cts = i < ctsList.length ? ctsList[i] : 0;
      newTrunView.setUint32(outPos, cts >>> 0);
      outPos += 4;
    }

    const outBytes = new Uint8Array(m4sBytes.length + addedBytes);
    outBytes.set(m4sBytes.subarray(0, trun.start), 0);
    outBytes.set(newTrun, trun.start);
    outBytes.set(m4sBytes.subarray(trun.end), trun.start + newTrunSize);

    const outView = new DataView(outBytes.buffer);
    outView.setUint32(moof.start, moof.size + addedBytes);
    outView.setUint32(traf.start, traf.size + addedBytes);
    return outBytes;
  }

  async function getFFmpeg() {
    if (ffmpeg) return ffmpeg;
    await ensureLibraries();
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

      await ensureLibraries();
      await verifyRangeSource(sourceUrl, file.size);
      const mkvVideoPtsMs = await extractMkvVideoPts(sourceUrl, MAX_TEST_SECONDS);

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
      let initMeta = null;
      if (rootEntries.includes("init.mp4")) {
        const initBytes = engine.FS("readFile", "/init.mp4");
        initMeta = parseInitMp4(initBytes);
        const initUrl = URL.createObjectURL(new Blob([initBytes], { type: "video/mp4" }));
        objectUrls.push(initUrl);
        urlsByName["init.mp4"] = initUrl;
      }

      const segmentBuffers = segmentNames.map(name => ({
        name,
        bytes: engine.FS("readFile", "/" + name)
      }));

      // Libera os arquivos do MEMFS assim que forem lidos para poupar RAM na TV.
      cleanupVirtualFs(engine);

      if (initMeta && mkvVideoPtsMs.length > 0) {
        const firstPtsMs = mkvVideoPtsMs[0];
        const perSegmentFrames = [];
        let frameIndex = 0;
        let minDiffTicks = 0;

        for (const seg of segmentBuffers) {
          const info = inspectFragmentTrack(seg.bytes, initMeta.videoTrackId, initMeta.videoDefaultDuration);
          const frames = [];
          if (info) {
            let dts = info.baseDecodeTime;
            for (const dur of info.durations) {
              const rawPtsTicks = frameIndex < mkvVideoPtsMs.length
                ? Math.round(((mkvVideoPtsMs[frameIndex] - firstPtsMs) * initMeta.videoTimescale) / 1000)
                : dts;
              const diff = rawPtsTicks - dts;
              if (diff < minDiffTicks) minDiffTicks = diff;
              frames.push({ dts, rawPtsTicks });
              dts += dur;
              frameIndex++;
            }
          }
          perSegmentFrames.push(frames);
        }

        const shiftVideoTicks = minDiffTicks < 0 ? -minDiffTicks : 0;
        const shiftAudioTicks = shiftVideoTicks > 0
          ? Math.round((shiftVideoTicks * initMeta.audioTimescale) / initMeta.videoTimescale)
          : 0;

        segmentBuffers.forEach((seg, idx) => {
          const ctsList = perSegmentFrames[idx].map(f => Math.max(0, f.rawPtsTicks + shiftVideoTicks - f.dts));
          seg.bytes = patchFragmentCts(seg.bytes, initMeta, ctsList, shiftAudioTicks);
        });
      }

      segmentBuffers.forEach(seg => {
        const url = URL.createObjectURL(new Blob([seg.bytes], { type: "video/mp4" }));
        objectUrls.push(url);
        urlsByName[seg.name] = url;
      });

      playlist = playlist
        .split(/\r?\n/)
        .map(line => {
          const trimmed = line.trim();
          if (trimmed.startsWith("#EXT-X-MAP:")) {
            return trimmed.replace(/URI="([^"]+)"/, (_match, uri) => {
              return urlsByName[uri] ? 'URI="' + urlsByName[uri] + '"' : 'URI="' + uri + '"';
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
