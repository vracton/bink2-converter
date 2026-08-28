(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const ui = {
    dropZone: $('dropZone'), fileInput: $('fileInput'), browseButton: $('browseButton'),
    filePanel: $('filePanel'), fileName: $('fileName'), fileSubline: $('fileSubline'),
    replaceButton: $('replaceButton'), metadataGrid: $('metadataGrid'), formatNote: $('formatNote'),
    qualitySelect: $('qualitySelect'), speedSelect: $('speedSelect'), convertButton: $('convertButton'),
    idleActions: $('idleActions'), progressPanel: $('progressPanel'), progressTitle: $('progressTitle'),
    progressDetail: $('progressDetail'), progressBar: $('progressBar'), cancelButton: $('cancelButton'),
    elapsedValue: $('elapsedValue'), fpsValue: $('fpsValue'), etaValue: $('etaValue'), frameValue: $('frameValue'),
    errorBox: $('errorBox'), engineText: $('engineText'), engineBadge: $('engineBadge'),
    resultCard: $('resultCard'), resultTitle: $('resultTitle'), resultMeta: $('resultMeta'),
    downloadButton: $('downloadButton'), previewStage: $('previewStage'), previewVideo: $('previewVideo'),
    previewNote: $('previewNote'), convertAnotherButton: $('convertAnotherButton'),
    isolationValue: $('isolationValue'), threadValue: $('threadValue'), workerFsValue: $('workerFsValue'), logOutput: $('logOutput')
  };

  const state = {
    file: null,
    header: null,
    worker: null,
    workerReady: false,
    workerThreads: 1,
    directFileAccess: false,
    phase: 'booting',
    jobId: 0,
    startedAt: 0,
    timer: null,
    lastFrame: 0,
    lastFrameAt: 0,
    smoothedFps: 0,
    outputUrl: null
  };

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    const units = ['B', 'KiB', 'MiB', 'GiB'];
    let value = bytes, unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    const digits = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
    return `${value.toFixed(digits)} ${units[unit]}`;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    seconds = Math.max(0, Math.round(seconds));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  }

  function parseBK2(buffer) {
    if (buffer.byteLength < 44) throw new Error('This file is too short to contain a valid Bink 2 header.');
    const bytes = new Uint8Array(buffer, 0, 4);
    const magic = String.fromCharCode(...bytes);
    if (!/^KB2./.test(magic)) throw new Error(`This does not look like a Bink 2 file (found ${JSON.stringify(magic)} instead of KB2x).`);
    const v = new DataView(buffer);
    const header = {
      magic,
      frames: v.getUint32(8, true),
      width: v.getUint32(20, true),
      height: v.getUint32(24, true),
      fpsNum: v.getUint32(28, true),
      fpsDen: v.getUint32(32, true),
      flags: v.getUint32(36, true),
      audioTracks: v.getUint32(40, true)
    };
    header.alpha = !!(header.flags & 0x00100000);
    header.fps = header.fpsDen ? header.fpsNum / header.fpsDen : 0;
    if (!header.frames || !header.width || !header.height) throw new Error('The Bink 2 header contains invalid frame or resolution information.');
    return header;
  }

  function setEngine(kind, label, detail) {
    ui.engineBadge.className = `engine-badge ${kind}`;
    ui.engineBadge.innerHTML = `<span></span>${escapeHTML(label)}`;
    ui.engineText.textContent = detail;
  }

  function showError(message) {
    ui.errorBox.textContent = message || 'Unknown conversion error.';
    ui.errorBox.classList.remove('hidden');
  }

  function clearError() {
    ui.errorBox.textContent = '';
    ui.errorBox.classList.add('hidden');
  }

  function revokeOutput() {
    if (state.outputUrl) URL.revokeObjectURL(state.outputUrl);
    state.outputUrl = null;
    ui.previewVideo.removeAttribute('src');
    ui.previewVideo.load();
    ui.downloadButton.removeAttribute('href');
  }

  function resetProgress() {
    state.startedAt = 0;
    state.lastFrame = 0;
    state.lastFrameAt = 0;
    state.smoothedFps = 0;
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    ui.progressBar.style.width = '0%';
    ui.progressDetail.textContent = '0%';
    ui.elapsedValue.textContent = '0:00';
    ui.fpsValue.textContent = '—';
    ui.etaValue.textContent = '—';
    ui.frameValue.textContent = `0 / ${state.header?.frames || 0}`;
  }

  function updateControls() {
    const canConvert = !!state.file && state.workerReady && state.phase !== 'converting';
    ui.convertButton.disabled = !canConvert;
    ui.replaceButton.disabled = state.phase === 'converting';
    ui.qualitySelect.disabled = state.phase === 'converting';
    ui.speedSelect.disabled = state.phase === 'converting';
  }

  function renderFile() {
    const h = state.header;
    const f = state.file;
    if (!h || !f) {
      ui.filePanel.classList.add('hidden');
      return;
    }
    ui.filePanel.classList.remove('hidden');
    ui.fileName.textContent = f.name;
    ui.fileSubline.textContent = `${formatBytes(f.size)} · ${h.magic}`;
    const cells = [
      ['Resolution', `${h.width} × ${h.height}`],
      ['Frames', h.frames.toLocaleString()],
      ['Frame rate', h.fps ? `${h.fps.toFixed(3).replace(/\.000$/, '')} fps` : 'Unknown'],
      ['Transparency', h.alpha ? 'Alpha present' : 'None'],
      ['Audio', h.audioTracks ? `${h.audioTracks} Bink stream${h.audioTracks === 1 ? '' : 's'}` : 'No audio'],
      ['Duration', h.fps ? formatDuration(h.frames / h.fps) : 'Unknown'],
      ['Revision', h.magic],
      ['Input size', formatBytes(f.size)]
    ];
    ui.metadataGrid.innerHTML = cells.map(([label, value]) =>
      `<div class="metadata-item"><span>${escapeHTML(label)}</span><strong title="${escapeHTML(value)}">${escapeHTML(value)}</strong></div>`
    ).join('');

    const videoCodec = h.alpha ? 'VP9 with alpha' : 'VP9';
    const audioText = h.audioTracks ? ` Audio will be transcoded to Opus.` : '';
    ui.formatNote.innerHTML = `<strong>${videoCodec} WebM.</strong>${audioText} Conversion stays on this device.`;
  }

  async function selectFile(file) {
    if (!file || state.phase === 'converting') return;
    clearError();
    revokeOutput();
    ui.resultCard.classList.add('hidden');
    resetProgress();
    try {
      const header = parseBK2(await file.slice(0, 64).arrayBuffer());
      state.file = file;
      state.header = header;
      state.phase = 'ready';
      renderFile();
      updateControls();
    } catch (error) {
      state.file = null;
      state.header = null;
      state.phase = 'ready';
      ui.filePanel.classList.add('hidden');
      showError(error?.message || String(error));
      updateControls();
    }
  }

  function appendLog(text) {
    const value = String(text || '');
    if (!value) return;
    ui.logOutput.textContent += `${value}\n`;
    if (ui.logOutput.textContent.length > 50000) ui.logOutput.textContent = ui.logOutput.textContent.slice(-40000);
    ui.logOutput.scrollTop = ui.logOutput.scrollHeight;
  }

  function startTimer() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => {
      if (state.phase !== 'converting') return;
      ui.elapsedValue.textContent = formatDuration((performance.now() - state.startedAt) / 1000);
    }, 250);
  }

  function updateProgress(frame, total) {
    const now = performance.now();
    total = total || state.header?.frames || 0;
    if (state.lastFrameAt && frame > state.lastFrame) {
      const instant = (frame - state.lastFrame) / ((now - state.lastFrameAt) / 1000);
      state.smoothedFps = state.smoothedFps ? state.smoothedFps * 0.78 + instant * 0.22 : instant;
    }
    state.lastFrame = frame;
    state.lastFrameAt = now;
    const pct = total > 0 ? Math.min(100, frame / total * 100) : 0;
    ui.progressBar.style.width = `${pct}%`;
    ui.progressDetail.textContent = total ? `${pct.toFixed(pct < 10 ? 1 : 0)}%` : 'Working…';
    ui.frameValue.textContent = total ? `${frame.toLocaleString()} / ${total.toLocaleString()}` : frame.toLocaleString();
    ui.fpsValue.textContent = state.smoothedFps ? `${state.smoothedFps.toFixed(1)} fps` : '—';
    ui.etaValue.textContent = state.smoothedFps && total > frame ? formatDuration((total - frame) / state.smoothedFps) : '—';
    ui.progressTitle.textContent = frame === 0 ? 'Preparing conversion…' : 'Encoding video…';
  }

  function destroyWorker() {
    if (state.worker) state.worker.terminate();
    state.worker = null;
    state.workerReady = false;
  }

  function createWorker() {
    destroyWorker();
    state.phase = state.file ? 'ready' : 'booting';
    setEngine('loading', 'Loading', 'Starting the multithreaded decoder…');
    ui.threadValue.textContent = '—';
    ui.workerFsValue.textContent = '—';

    let worker;
    try {
      worker = new Worker('./bink2-worker.js');
    } catch (error) {
      state.phase = 'error';
      setEngine('error', 'Unavailable', 'The conversion worker could not start.');
      showError(`Could not start the converter worker: ${error?.message || error}`);
      updateControls();
      return;
    }
    state.worker = worker;

    worker.onmessage = event => {
      const message = event.data || {};
      if (message.jobId != null && message.jobId !== state.jobId) return;
      switch (message.type) {
        case 'ready':
          state.workerReady = true;
          state.workerThreads = message.threads || 1;
          state.directFileAccess = !!message.workerfs;
          state.phase = state.file ? 'ready' : 'idle';
          setEngine('ready', 'Ready', `${state.workerThreads} worker thread${state.workerThreads === 1 ? '' : 's'} available`);
          ui.threadValue.textContent = String(state.workerThreads);
          ui.workerFsValue.textContent = state.directFileAccess ? 'Enabled' : 'Fallback copy';
          updateControls();
          break;
        case 'input-mode':
          ui.workerFsValue.textContent = message.mode === 'direct' ? 'Enabled' : 'Fallback copy';
          ui.progressTitle.textContent = message.mode === 'direct' ? 'Opening BK2…' : 'Copying BK2 into decoder memory…';
          break;
        case 'progress': updateProgress(message.frame || 0, message.total || state.header?.frames || 0); break;
        case 'done': finishConversion(message); break;
        case 'error': failConversion(message.message || 'Conversion failed.'); break;
        case 'log': appendLog(message.text); break;
      }
    };

    worker.onerror = event => failConversion(`Converter worker crashed: ${event.message || 'unknown worker error'}`);
    updateControls();
  }

  async function startConversion() {
    if (!state.file || !state.header || !state.workerReady || state.phase === 'converting') return;
    clearError();
    revokeOutput();
    ui.resultCard.classList.add('hidden');
    state.phase = 'converting';
    state.jobId++;
    resetProgress();
    state.startedAt = performance.now();
    state.lastFrameAt = state.startedAt;
    ui.idleActions.classList.add('hidden');
    ui.progressPanel.classList.remove('hidden');
    ui.progressTitle.textContent = 'Opening BK2…';
    ui.progressDetail.textContent = '0%';
    setEngine('ready', 'Working', `${state.workerThreads} threads · conversion in progress`);
    updateControls();
    startTimer();

    try {
      state.worker.postMessage({
        type: 'convert', jobId: state.jobId, file: state.file,
        crf: Number(ui.qualitySelect.value), cpuUsed: Number(ui.speedSelect.value),
        threads: state.workerThreads, alpha: state.header.alpha, audioTracks: state.header.audioTracks
      });
    } catch (error) {
      failConversion(`Could not send the file to the converter: ${error?.message || error}`);
    }
  }

  function stopTimer() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
  }

  function finishConversion(message) {
    if (state.phase !== 'converting') return;
    stopTimer();
    state.phase = 'done';
    const blob = new Blob([message.data], { type: 'video/webm' });
    state.outputUrl = URL.createObjectURL(blob);
    const elapsed = (performance.now() - state.startedAt) / 1000;
    const frames = message.frames || state.header?.frames || 0;
    const avgFps = elapsed > 0 ? frames / elapsed : 0;

    const base = (state.file?.name || 'converted').replace(/\.bk2$/i, '');
    ui.downloadButton.href = state.outputUrl;
    ui.downloadButton.download = `${base}.webm`;
    ui.previewVideo.src = state.outputUrl;
    ui.previewVideo.load();
    ui.previewStage.classList.toggle('alpha', !!state.header?.alpha);
    ui.previewNote.textContent = state.header?.alpha ? 'Checkerboard indicates transparent areas.' : 'Previewing the converted WebM locally.';
    const audioLabel = state.header?.audioTracks ? `${state.header.audioTracks} audio stream${state.header.audioTracks === 1 ? '' : 's'} → Opus` : 'No audio';
    ui.resultTitle.textContent = `${base}.webm`;
    ui.resultMeta.textContent = `${formatBytes(blob.size)} · ${frames.toLocaleString()} frames · ${avgFps.toFixed(1)} fps conversion · ${audioLabel}`;
    ui.resultCard.classList.remove('hidden');
    ui.idleActions.classList.remove('hidden');
    ui.progressPanel.classList.add('hidden');
    setEngine('ready', 'Ready', `${state.workerThreads} worker thread${state.workerThreads === 1 ? '' : 's'} available`);
    updateControls();
    ui.resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function failConversion(message) {
    stopTimer();
    state.phase = 'ready';
    ui.progressPanel.classList.add('hidden');
    ui.idleActions.classList.remove('hidden');
    showError(message);
    setEngine(state.workerReady ? 'ready' : 'error', state.workerReady ? 'Ready' : 'Error', state.workerReady ? `${state.workerThreads} worker threads available` : 'Decoder unavailable');
    updateControls();
  }

  function cancelConversion() {
    if (state.phase !== 'converting') return;
    state.jobId++;
    stopTimer();
    state.phase = 'ready';
    ui.progressPanel.classList.add('hidden');
    ui.idleActions.classList.remove('hidden');
    showError('Conversion cancelled.');
    createWorker();
    updateControls();
  }

  function chooseFileDialog(event) {
    event?.stopPropagation?.();
    if (state.phase !== 'converting') ui.fileInput.click();
  }

  ui.dropZone.addEventListener('click', chooseFileDialog);
  ui.browseButton.addEventListener('click', chooseFileDialog);
  ui.replaceButton.addEventListener('click', chooseFileDialog);
  ui.dropZone.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chooseFileDialog(event); }
  });
  ui.fileInput.addEventListener('change', () => {
    const file = ui.fileInput.files?.[0];
    ui.fileInput.value = '';
    if (file) selectFile(file);
  });
  for (const name of ['dragenter', 'dragover']) ui.dropZone.addEventListener(name, event => {
    event.preventDefault();
    if (state.phase !== 'converting') ui.dropZone.classList.add('dragging');
  });
  for (const name of ['dragleave', 'drop']) ui.dropZone.addEventListener(name, event => {
    event.preventDefault();
    ui.dropZone.classList.remove('dragging');
  });
  ui.dropZone.addEventListener('drop', event => {
    if (state.phase === 'converting') return;
    const file = event.dataTransfer?.files?.[0];
    if (file) selectFile(file);
  });
  ui.convertButton.addEventListener('click', startConversion);
  ui.cancelButton.addEventListener('click', cancelConversion);
  ui.convertAnotherButton.addEventListener('click', chooseFileDialog);
  window.addEventListener('beforeunload', revokeOutput);

  function boot() {
    const isolated = !!window.crossOriginIsolated;
    ui.isolationValue.textContent = isolated ? 'Enabled' : 'Not enabled';
    if (!window.isSecureContext) {
      state.phase = 'error';
      setEngine('error', 'HTTPS required', 'Multithreaded WebAssembly requires HTTPS or localhost.');
      showError('This converter must be served over HTTPS or localhost so the browser can enable SharedArrayBuffer.');
      updateControls();
      return;
    }
    if (!isolated) {
      setEngine('loading', 'Preparing', 'Enabling browser isolation… the page may reload once.');
      setTimeout(() => {
        if (!window.crossOriginIsolated && !state.worker) {
          state.phase = 'error';
          setEngine('error', 'Isolation failed', 'Could not enable multithreaded WebAssembly.');
          showError('Browser isolation did not activate. Reload the page once; if this persists, clear this site\'s service worker and reload.');
        }
      }, 4000);
      return;
    }
    createWorker();
  }

  boot();
})();
