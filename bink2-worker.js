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

async function prepareInput(module, message, jobId) {
  const mountpoint = '/source';
  const mountedInput = `${mountpoint}/input.bk2`;
  const copiedInput = '/input.bk2';
  const workerFS = getWorkerFS(module);

  if (message.file && workerFS) {
    try { module.FS.mkdir(mountpoint); } catch (_) {}
    try {
      module.FS.mount(workerFS, { blobs: [{ name: 'input.bk2', data: message.file }] }, mountpoint);
      send('input-mode', { jobId, mode: 'direct' });
      return { path: mountedInput, mounted: true, mountpoint };
    } catch (error) {
      send('log', { text: `[workerfs] Direct file mount failed; using safe memory fallback: ${error?.message || error}` });
      try { module.FS.unmount(mountpoint); } catch (_) {}
    }
  }

  let buffer = message.data || null;
  if (!buffer && message.file && typeof message.file.arrayBuffer === 'function') {
    send('input-mode', { jobId, mode: 'copy' });
    buffer = await message.file.arrayBuffer();
  }
  if (!buffer) throw new Error('No BK2 input was provided.');

  module.FS.writeFile(copiedInput, new Uint8Array(buffer));
  return { path: copiedInput, mounted: false, mountpoint };
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
    if (inputInfo?.mounted) {
      try { module.FS.unmount(inputInfo.mountpoint); } catch (_) {}
    }
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
