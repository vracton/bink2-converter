let core = null;
let initializing = null;
let converting = false;

const workerStartedAt = performance.now();
const hardwareThreads = Math.max(1, Math.min(16, self.navigator?.hardwareConcurrency || 4));
const pendingLogs = [];
let pendingLogChars = 0;
let logFlushTimer = null;

function send(type, payload = {}, transfer = []) {
  self.postMessage({ type, ...payload }, transfer);
}

function flushLogs() {
  if (logFlushTimer) {
    clearTimeout(logFlushTimer);
    logFlushTimer = null;
  }
  if (!pendingLogs.length) return;
  const text = pendingLogs.join('\n');
  pendingLogs.length = 0;
  pendingLogChars = 0;
  send('log', { text });
}

function queueLog(text) {
  const value = String(text || '');
  if (!value) return;
  pendingLogs.push(value);
  pendingLogChars += value.length + 1;

  // FFmpeg can emit thousands of messages in a burst. Posting every line
  // separately makes the main thread repeatedly rebuild the diagnostics <pre>
  // and can make conversion look frozen even while the WASM worker is active.
  if (pendingLogs.length >= 128 || pendingLogChars >= 24 * 1024) {
    flushLogs();
  } else if (!logFlushTimer) {
    logFlushTimer = setTimeout(flushLogs, 100);
  }
}

function trace(text) {
  const elapsed = ((performance.now() - workerStartedAt) / 1000).toFixed(3);
  queueLog(`[worker +${elapsed}s] ${text}`);
}

function getWorkerFS(module) {
  return module?.WORKERFS || module?.FS?.filesystems?.WORKERFS || null;
}

async function init() {
  if (core) return core;
  if (initializing) return initializing;
  initializing = (async () => {
    try {
      trace('Importing ./core/bink2-core.js');
      importScripts('./core/bink2-core.js');
      trace('WASM loader script imported');
      if (typeof createBink2Core !== 'function') throw new Error('Bink2 WASM loader did not define createBink2Core().');
      trace('Instantiating Emscripten module');
      core = await createBink2Core({
        locateFile(path) {
          const url = new URL('./core/' + path, self.location.href).href;
          trace(`locateFile ${path} -> ${url}`);
          return url;
        },
        print(text) { trace(`[stdout] ${text}`); },
        printErr(text) { trace(`[stderr] ${text}`); }
      });
      trace(`Emscripten module ready; WORKERFS=${!!getWorkerFS(core)}; hardwareThreads=${hardwareThreads}`);
      flushLogs();
      send('ready', { threads: hardwareThreads, workerfs: !!getWorkerFS(core) });
      return core;
    } catch (err) {
      trace(`Initialization failed: ${err?.stack || err?.message || String(err)}`);
      flushLogs();
      send('error', { message: 'Could not load the Bink2 decoder: ' + (err?.message || String(err)) });
      throw err;
    }
  })();
  return initializing;
}

async function stageBrowserFile(module, file, path, jobId) {
  const CHUNK_SIZE = 16 * 1024 * 1024;
  const size = file.size;
  trace(`Staging browser File into MEMFS: name=${file.name} size=${size} bytes chunkSize=${CHUNK_SIZE}`);

  module.FS.writeFile(path, new Uint8Array(0));
  trace(`Created ${path}`);
  module.FS.truncate(path, size);
  trace(`Preallocated ${path} to ${size} bytes`);
  const stream = module.FS.open(path, 'r+');
  trace(`Opened ${path} for chunked writes`);
  try {
    let loaded = 0;
    let chunkIndex = 0;
    while (loaded < size) {
      const end = Math.min(size, loaded + CHUNK_SIZE);
      trace(`Reading input chunk ${chunkIndex}: ${loaded}-${end}`);
      const chunk = new Uint8Array(await file.slice(loaded, end).arrayBuffer());
      module.FS.write(stream, chunk, 0, chunk.byteLength, loaded);
      loaded = end;
      chunkIndex++;
      send('input-progress', { jobId, loaded, total: size });
      trace(`Input staged: ${loaded}/${size} bytes`);
    }
  } finally {
    module.FS.close(stream);
    trace(`Closed staged input file ${path}`);
  }
}

async function prepareInput(module, message, jobId) {
  const copiedInput = '/input.bk2';

  if (message.file) {
    trace('Input mode: browser File -> chunked MEMFS staging');
    send('input-mode', { jobId, mode: 'staged' });
    await stageBrowserFile(module, message.file, copiedInput, jobId);
    return { path: copiedInput };
  }

  if (message.data) {
    trace(`Input mode: ArrayBuffer -> MEMFS (${message.data.byteLength} bytes)`);
    send('input-mode', { jobId, mode: 'memory' });
    module.FS.writeFile(copiedInput, new Uint8Array(message.data));
    send('input-progress', { jobId, loaded: message.data.byteLength, total: message.data.byteLength });
    trace('ArrayBuffer input written to MEMFS');
    return { path: copiedInput };
  }

  throw new Error('No BK2 input was provided.');
}

async function convert(message) {
  if (converting) throw new Error('A conversion is already running.');
  converting = true;
  const jobId = message.jobId ?? 0;
  trace(`Conversion job ${jobId} accepted`);
  const module = await init();
  const output = '/output.webm';
  let inputInfo = null;

  try {
    trace('Cleaning stale MEMFS input/output files');
    try { module.FS.unlink('/input.bk2'); } catch (_) {}
    try { module.FS.unlink(output); } catch (_) {}
    inputInfo = await prepareInput(module, message, jobId);

    const crf = Number.isFinite(message.crf) ? message.crf : 18;
    const cpuUsed = Number.isFinite(message.cpuUsed) ? message.cpuUsed : 8;
    const threads = Math.max(1, Math.min(hardwareThreads,
      Number.isFinite(message.threads) ? message.threads : hardwareThreads));

    trace(`Input ready at ${inputInfo.path}`);
    trace(`Calling transcode_bk2(input=${inputInfo.path}, output=${output}, crf=${crf}, cpuUsed=${cpuUsed}, threads=${threads}, alpha=${!!message.alpha}, audioTracks=${message.audioTracks || 0})`);
    trace('Native/FFmpeg milestone logging begins below');
    flushLogs();

    const frames = module.ccall(
      'transcode_bk2',
      'number',
      ['string', 'string', 'number', 'number', 'number'],
      [inputInfo.path, output, crf, cpuUsed, threads]
    );

    trace(`transcode_bk2 returned ${frames}`);

    if (frames < 0) {
      const ptr = module._bink2_last_error();
      const reason = ptr ? module.UTF8ToString(ptr) : 'Unknown decoder error';
      trace(`Native error: ${reason}`);
      throw new Error(reason || 'Bink2 conversion failed.');
    }

    trace(`Reading completed WebM from ${output}`);
    const bytes = module.FS.readFile(output);
    trace(`WebM read from MEMFS: ${bytes.byteLength} bytes`);
    const shared = typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer;
    const result = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && !shared
      ? bytes.buffer
      : bytes.slice().buffer;

    trace(`Posting completed job ${jobId} to UI`);
    flushLogs();
    send('done', {
      jobId,
      data: result,
      frames,
      threads,
      codec: 'VP9',
      audioTracks: message.audioTracks || 0
    }, [result]);
  } finally {
    trace(`Cleaning job ${jobId} files`);
    try { module.FS.unlink(output); } catch (_) {}
    try { module.FS.unlink('/input.bk2'); } catch (_) {}
    converting = false;
    trace(`Conversion job ${jobId} finished/aborted`);
    flushLogs();
  }
}

self.onmessage = async event => {
  const message = event.data || {};
  if (message.type !== 'convert') return;
  trace(`Received message type=${message.type} jobId=${message.jobId ?? 0}`);
  try {
    await convert(message);
  } catch (err) {
    trace(`Conversion exception: ${err?.stack || err?.message || String(err)}`);
    flushLogs();
    send('error', { jobId: message.jobId ?? 0, message: err?.message || String(err) });
  }
};

trace('Worker script loaded');
init().catch(() => {});
