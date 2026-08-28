let core = null;
let initializing = null;
let converting = false;

const hardwareThreads = Math.max(1, Math.min(16, self.navigator?.hardwareConcurrency || 4));

function send(type, payload = {}, transfer = []) {
  self.postMessage({ type, ...payload }, transfer);
}

function getWorkerFS(module) {
  return module?.WORKERFS || module?.FS?.filesystems?.WORKERFS || null;
}

async function init() {
  if (core) return core;
  if (initializing) return initializing;
  initializing = (async () => {
    try {
      importScripts('./core/bink2-core.js');
      if (typeof createBink2Core !== 'function') throw new Error('Bink2 WASM loader did not define createBink2Core().');
      core = await createBink2Core({
        locateFile(path) {
          return new URL('./core/' + path, self.location.href).href;
        },
        print(text) { send('log', { text }); },
        printErr(text) { send('log', { text: '[stderr] ' + text }); }
      });
      send('ready', { threads: hardwareThreads, workerfs: !!getWorkerFS(core) });
      return core;
    } catch (err) {
      send('error', { message: 'Could not load the Bink2 decoder: ' + (err?.message || String(err)) });
      throw err;
    }
  })();
  return initializing;
}

async function stageBrowserFile(module, file, path, jobId) {
  const CHUNK_SIZE = 16 * 1024 * 1024;
  const size = file.size;

  module.FS.writeFile(path, new Uint8Array(0));
  module.FS.truncate(path, size);
  const stream = module.FS.open(path, 'r+');
  try {
    let loaded = 0;
    while (loaded < size) {
      const end = Math.min(size, loaded + CHUNK_SIZE);
      const chunk = new Uint8Array(await file.slice(loaded, end).arrayBuffer());
      module.FS.write(stream, chunk, 0, chunk.byteLength, loaded);
      loaded = end;
      send('input-progress', { jobId, loaded, total: size });
    }
  } finally {
    module.FS.close(stream);
  }
}

async function prepareInput(module, message, jobId) {
  const copiedInput = '/input.bk2';

  // FFmpeg performs many small seeks while probing Bink. Reading those through
  // WORKERFS turns each seek into a synchronous Blob read and can leave large
  // files at frame 0 for a long time. Stage into MEMFS once instead. Chunking
  // avoids holding a second full-file ArrayBuffer in JavaScript while copying.
  if (message.file) {
    send('input-mode', { jobId, mode: 'staged' });
    await stageBrowserFile(module, message.file, copiedInput, jobId);
    return { path: copiedInput };
  }

  if (message.data) {
    send('input-mode', { jobId, mode: 'memory' });
    module.FS.writeFile(copiedInput, new Uint8Array(message.data));
    send('input-progress', { jobId, loaded: message.data.byteLength, total: message.data.byteLength });
    return { path: copiedInput };
  }

  throw new Error('No BK2 input was provided.');
}

async function convert(message) {
  if (converting) throw new Error('A conversion is already running.');
  converting = true;
  const jobId = message.jobId ?? 0;
  const module = await init();
  const output = '/output.webm';
  let inputInfo = null;

  try {
    try { module.FS.unlink('/input.bk2'); } catch (_) {}
    try { module.FS.unlink(output); } catch (_) {}
    inputInfo = await prepareInput(module, message, jobId);

    const crf = Number.isFinite(message.crf) ? message.crf : 18;
    const cpuUsed = Number.isFinite(message.cpuUsed) ? message.cpuUsed : 8;
    const threads = Math.max(1, Math.min(hardwareThreads,
      Number.isFinite(message.threads) ? message.threads : hardwareThreads));

    const frames = module.ccall(
      'transcode_bk2',
      'number',
      ['string', 'string', 'number', 'number', 'number'],
      [inputInfo.path, output, crf, cpuUsed, threads]
    );

    if (frames < 0) {
      const ptr = module._bink2_last_error();
      const reason = ptr ? module.UTF8ToString(ptr) : 'Unknown decoder error';
      throw new Error(reason || 'Bink2 conversion failed.');
    }

    const bytes = module.FS.readFile(output);
    const shared = typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer;
    const result = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && !shared
      ? bytes.buffer
      : bytes.slice().buffer;

    send('done', {
      jobId,
      data: result,
      frames,
      threads,
      codec: 'VP9',
      audioTracks: message.audioTracks || 0
    }, [result]);
  } finally {
    try { module.FS.unlink(output); } catch (_) {}
    try { module.FS.unlink('/input.bk2'); } catch (_) {}
    converting = false;
  }
}

self.onmessage = async event => {
  const message = event.data || {};
  if (message.type !== 'convert') return;
  try {
    await convert(message);
  } catch (err) {
    send('error', { jobId: message.jobId ?? 0, message: err?.message || String(err) });
  }
};

init().catch(() => {});
