let core=null,initializing=null,converting=false;
const started=performance.now();
const hardwareThreads=Math.max(1,Math.min(8,self.navigator?.hardwareConcurrency||4));
function send(type,payload={},transfer=[]){self.postMessage({type,...payload},transfer)}
function stamp(){return `[worker +${((performance.now()-started)/1000).toFixed(3)}s]`}
function log(text){send('log',{text:`${stamp()} ${text}`})}
function nativeLog(channel,text){if(text)send('log',{text:`${stamp()} [${channel}] ${text}`})}
function ext(file){return /\.bik$/i.test(file?.name||'')?'.bik':'.bk2'}
function hasOpfs(){return !!self.navigator?.storage?.getDirectory}

async function init(){
  if(core)return core;
  if(initializing)return initializing;
  initializing=(async()=>{
    log('Importing WASM core');
    importScripts('./core/bink2-core.js');
    if(typeof createBink2Core!=='function')throw new Error('Bink WASM loader is missing.');
    core=await createBink2Core({
      locateFile:path=>new URL('./core/'+path,self.location.href).href,
      print:text=>nativeLog('stdout',text),
      printErr:text=>nativeLog('stderr',text)
    });
    log(`WASM ready; OPFS=${hasOpfs()}; threads=${hardwareThreads}`);
    send('ready',{threads:hardwareThreads,opfs:hasOpfs()});
    return core;
  })().catch(err=>{send('error',{message:'Could not load the Bink decoder: '+(err?.message||err)});throw err});
  return initializing;
}

function writeAll(handle,bytes,offset){
  let done=0;
  while(done<bytes.byteLength){
    const n=handle.write(bytes.subarray(done),{at:offset+done});
    if(!(n>0))throw new Error('OPFS write returned zero bytes.');
    done+=n;
  }
}

async function prepareOpfs(module,file,jobId){
  if(!hasOpfs())throw new Error('OPFS unavailable');
  const root=await navigator.storage.getDirectory();
  const dir=await root.getDirectoryHandle('bink2-converter',{create:true});
  const inputHandle=await dir.getFileHandle('current-input.bink',{create:true});
  const outputHandle=await dir.getFileHandle('current-output.webm',{create:true});
  if(typeof inputHandle.createSyncAccessHandle!=='function')throw new Error('Synchronous OPFS unavailable');
  const inputAccess=await inputHandle.createSyncAccessHandle();
  let outputAccess;
  try{
    inputAccess.truncate(0);
    const chunkSize=16*1024*1024;
    for(let loaded=0;loaded<file.size;){
      const end=Math.min(file.size,loaded+chunkSize);
      const chunk=new Uint8Array(await file.slice(loaded,end).arrayBuffer());
      writeAll(inputAccess,chunk,loaded);
      loaded=end;
      send('input-progress',{jobId,loaded,total:file.size});
    }
    inputAccess.flush();
    outputAccess=await outputHandle.createSyncAccessHandle();
    outputAccess.truncate(0);
    module.bink2OpfsInputHandle=inputAccess;
    module.bink2OpfsOutputHandle=outputAccess;
    module.bink2OpfsError='';
    send('input-mode',{jobId,mode:'opfs'});
    log(`OPFS input ready: ${inputAccess.getSize()} bytes; source is outside WASM heap`);
    return{mode:'opfs',path:`opfs-input${ext(file)}`,inputAccess,outputAccess,outputHandle};
  }catch(err){
    try{outputAccess?.close()}catch(_){}
    try{inputAccess.close()}catch(_){}
    module.bink2OpfsInputHandle=null;module.bink2OpfsOutputHandle=null;
    throw err;
  }
}

async function prepareMemfs(module,file,jobId){
  const path=`/input${ext(file)}`,chunkSize=16*1024*1024;
  module.FS.writeFile(path,new Uint8Array(0));
  module.FS.truncate(path,file.size);
  const stream=module.FS.open(path,'r+');
  try{
    for(let loaded=0;loaded<file.size;){
      const end=Math.min(file.size,loaded+chunkSize);
      const chunk=new Uint8Array(await file.slice(loaded,end).arrayBuffer());
      module.FS.write(stream,chunk,0,chunk.byteLength,loaded);
      loaded=end;send('input-progress',{jobId,loaded,total:file.size});
    }
  }finally{module.FS.close(stream)}
  send('input-mode',{jobId,mode:'staged'});
  return{mode:'memfs',path};
}

function closeOpfs(module,info){
  if(info?.mode!=='opfs')return;
  try{info.outputAccess?.flush()}catch(_){}
  try{info.outputAccess?.close()}catch(_){}
  try{info.inputAccess?.close()}catch(_){}
  module.bink2OpfsInputHandle=null;module.bink2OpfsOutputHandle=null;
}

async function convert(message){
  if(converting)throw new Error('A conversion is already running.');
  converting=true;
  const module=await init(),jobId=message.jobId??0,output='/output.webm';
  let info=null;
  try{
    try{module.FS.unlink('/input.bk2')}catch(_){}try{module.FS.unlink('/input.bik')}catch(_){}try{module.FS.unlink(output)}catch(_){}
    if(!message.file)throw new Error('No Bink input was provided.');
    try{info=await prepareOpfs(module,message.file,jobId)}catch(err){log(`OPFS fallback: ${err?.message||err}`);info=await prepareMemfs(module,message.file,jobId)}
    const crf=Number.isFinite(message.crf)?message.crf:18;
    const cpuUsed=Number.isFinite(message.cpuUsed)?message.cpuUsed:8;
    const threads=Math.max(1,Math.min(hardwareThreads,Number.isFinite(message.threads)?message.threads:hardwareThreads));
    log(`Starting ${info.mode.toUpperCase()} transcode: ${info.path}, threads=${threads}`);
    const frames=module.ccall('transcode_bk2','number',['string','string','number','number','number'],[info.path,output,crf,cpuUsed,threads]);
    if(frames<0){
      const ptr=module._bink2_last_error();
      let reason=ptr?module.UTF8ToString(ptr):'Unknown decoder error';
      if(module.bink2OpfsError)reason+=` (${module.bink2OpfsError})`;
      throw new Error(reason);
    }
    if(info.mode==='opfs'){
      info.outputAccess.flush();
      const size=info.outputAccess.getSize();
      closeOpfs(module,info);
      const file=await info.outputHandle.getFile();
      info=null;
      log(`OPFS output complete: ${size} bytes; no WebM accumulated in WASM`);
      send('done',{jobId,file,frames,threads,codec:'VP9',audioTracks:message.audioTracks||0,outputMode:'opfs'});
    }else{
      const bytes=module.FS.readFile(output),shared=typeof SharedArrayBuffer!=='undefined'&&bytes.buffer instanceof SharedArrayBuffer;
      const data=bytes.byteOffset===0&&bytes.byteLength===bytes.buffer.byteLength&&!shared?bytes.buffer:bytes.slice().buffer;
      send('done',{jobId,data,frames,threads,codec:'VP9',audioTracks:message.audioTracks||0,outputMode:'memfs'},[data]);
    }
  }finally{
    closeOpfs(module,info);
    try{module.FS.unlink(output)}catch(_){}try{module.FS.unlink('/input.bk2')}catch(_){}try{module.FS.unlink('/input.bik')}catch(_){}
    converting=false;
  }
}

self.onmessage=async event=>{const m=event.data||{};if(m.type!=='convert')return;try{await convert(m)}catch(err){log(`Conversion error: ${err?.message||err}`);send('error',{jobId:m.jobId??0,message:err?.message||String(err)})}};
log('Worker script loaded');init().catch(()=>{});
