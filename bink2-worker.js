let core = null;
let initializing = null;
let converting = false;

const hardwareThreads = Math.max(1, Math.min(16, self.navigator?.hardwareConcurrency || 4));

function send(type, payload = {}, transfer = []) {
  self.postMessage({ type, ...payload }, transfer);
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
      send('ready', { threads: hardwareThreads, workerfs: !!core.WORKERFS });
      return core;
    } catch (err) {
      send('error', { message: 'Could not load the Bink2 decoder: ' + (err?.message || String(err)) });
      throw err;
    }
  })();
  return initializing;
}

async function convert(message) {
  if (converting) throw new Error('A conversion is already running.');
  converting = true;
  const m = await init();
  const mountpoint = '/source';
  const mountedInput = '/source/input.bk2';
  const copiedInput = '/input.bk2';
  const output = '/output.webm';
  let input = copiedInput;
  let mounted = false;

  try {
    try { m.FS.unlink(copiedInput); } catch (_) {}
    try { m.FS.unlink(output); } catch (_) {}

    // WORKERFS lets FFmpeg seek/read the browser File directly instead of
    // copying a potentially multi-hundred-MiB BK2 into the WASM heap.
    if (message.file && m.WORKERFS) {
      try { m.FS.mkdir(mountpoint); } catch (_) {}
      m.FS.mount(m.WORKERFS, {
        blobs: [{ name: 'input.bk2', data: message.file }]
      }, mountpoint);
      mounted = true;
      input = mountedInput;
    } else if (message.data) {
      // Retained for Node/test harnesses and older callers.
      m.FS.writeFile(copiedInput, new Uint8Array(message.data));
    } else {
      throw new Error('No BK2 input was provided.');
    }

    const crf = Number.isFinite(message.crf) ? message.crf : 18;
    const cpuUsed = Number.isFinite(message.cpuUsed) ? message.cpuUsed : 8;
    const threads = Math.max(1, Math.min(hardwareThreads,
      Number.isFinite(message.threads) ? message.threads : hardwareThreads));

    const frames = m.ccall(
      'transcode_bk2',
      'number',
      ['string', 'string', 'number', 'number', 'number'],
      [input, output, crf, cpuUsed, threads]
    );

    if (frames < 0) {
      const ptr = m._bink2_last_error();
      const reason = ptr ? m.UTF8ToString(ptr) : 'Unknown decoder error';
      throw new Error(reason || 'Bink2 conversion failed.');
    }

    const bytes = m.FS.readFile(output);
    // readFile normally returns a standalone ArrayBuffer. Avoid another full
    // output copy when that is true; fall back safely if the view is sliced.
    const result = bytes.byteOffset === 0 &&
      bytes.byteLength === bytes.buffer.byteLength &&
      !(bytes.buffer instanceof SharedArrayBuffer)
        ? bytes.buffer
        : bytes.slice().buffer;

    send('done', {
      data: result,
      frames,
      threads,
      codec: message.alpha ? 'VP9' : 'VP8',
      audioTracks: message.audioTracks || 0,
      surroundDownmix: (message.audioTracks || 0) === 8
    }, [result]);
  } finally {
    try { m.FS.unlink(output); } catch (_) {}
    try { m.FS.unlink(copiedInput); } catch (_) {}
    if (mounted) {
      try { m.FS.unmount(mountpoint); } catch (_) {}
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
    send('error', { message: err?.message || String(err) });
  }
};

init().catch(() => {});
