(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const ui={
    dropZone:$('dropZone'),fileInput:$('fileInput'),browseButton:$('browseButton'),filePanel:$('filePanel'),fileName:$('fileName'),fileSubline:$('fileSubline'),replaceButton:$('replaceButton'),metadataGrid:$('metadataGrid'),formatNote:$('formatNote'),qualitySelect:$('qualitySelect'),speedSelect:$('speedSelect'),convertButton:$('convertButton'),idleActions:$('idleActions'),progressPanel:$('progressPanel'),progressTitle:$('progressTitle'),progressDetail:$('progressDetail'),progressBar:$('progressBar'),cancelButton:$('cancelButton'),elapsedValue:$('elapsedValue'),fpsValue:$('fpsValue'),etaValue:$('etaValue'),frameValue:$('frameValue'),errorBox:$('errorBox'),engineText:$('engineText'),engineBadge:$('engineBadge'),resultCard:$('resultCard'),resultTitle:$('resultTitle'),resultMeta:$('resultMeta'),downloadButton:$('downloadButton'),previewStage:$('previewStage'),previewVideo:$('previewVideo'),previewNote:$('previewNote'),convertAnotherButton:$('convertAnotherButton'),isolationValue:$('isolationValue'),threadValue:$('threadValue'),workerFsValue:$('workerFsValue'),logOutput:$('logOutput')
  };
  const state={file:null,header:null,worker:null,workerReady:false,workerThreads:1,phase:'booting',jobId:0,startedAt:0,timer:null,lastFrame:0,lastFrameAt:0,smoothedFps:0,outputUrl:null};

  const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function bytes(n){if(!Number.isFinite(n))return'—';const u=['B','KiB','MiB','GiB'];let i=0;while(n>=1024&&i<u.length-1){n/=1024;i++}return`${n.toFixed(i? (n>=100?0:n>=10?1:2):0)} ${u[i]}`}
  function duration(s){if(!Number.isFinite(s)||s<0)return'—';s=Math.round(s);const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;return h?`${h}:${String(m).padStart(2,'0')}:${String(x).padStart(2,'0')}`:`${m}:${String(x).padStart(2,'0')}`}

  function parseBink(buffer){
    if(buffer.byteLength<44)throw new Error('This file is too short to contain a Bink header.');
    const magic=String.fromCharCode(...new Uint8Array(buffer,0,4));
    const bink2=/^KB2./.test(magic),bink1=/^BIK./.test(magic);
    if(!bink2&&!bink1)throw new Error(`Unsupported Bink header ${JSON.stringify(magic)}. Expected KB2x or BIKx.`);
    const v=new DataView(buffer),h={magic,kind:bink2?'Bink 2':'Bink',frames:v.getUint32(8,true),width:v.getUint32(20,true),height:v.getUint32(24,true),fpsNum:v.getUint32(28,true),fpsDen:v.getUint32(32,true),flags:v.getUint32(36,true),audioTracks:v.getUint32(40,true)};
    h.alpha=!!(h.flags&0x00100000);h.fps=h.fpsDen?h.fpsNum/h.fpsDen:0;
    if(!h.frames||!h.width||!h.height)throw new Error('The Bink header contains invalid frame or resolution information.');
    return h;
  }

  function setEngine(kind,label,detail){ui.engineBadge.className=`engine-badge ${kind}`;ui.engineBadge.innerHTML=`<span></span>${esc(label)}`;ui.engineText.textContent=detail}
  function showError(m){ui.errorBox.textContent=m||'Unknown conversion error.';ui.errorBox.classList.remove('hidden')}
  function clearError(){ui.errorBox.textContent='';ui.errorBox.classList.add('hidden')}
  function revoke(){if(state.outputUrl)URL.revokeObjectURL(state.outputUrl);state.outputUrl=null;ui.previewVideo.removeAttribute('src');ui.previewVideo.load();ui.downloadButton.removeAttribute('href')}
  function resetProgress(){state.startedAt=state.lastFrame=state.lastFrameAt=state.smoothedFps=0;if(state.timer)clearInterval(state.timer);state.timer=null;ui.progressBar.style.width='0%';ui.progressDetail.textContent='0%';ui.elapsedValue.textContent='0:00';ui.fpsValue.textContent=ui.etaValue.textContent='—';ui.frameValue.textContent=`0 / ${state.header?.frames||0}`}
  function updateControls(){const busy=state.phase==='converting';ui.convertButton.disabled=!state.file||!state.workerReady||busy;ui.replaceButton.disabled=busy;ui.qualitySelect.disabled=busy;ui.speedSelect.disabled=busy}

  function renderFile(){
    const h=state.header,f=state.file;if(!h||!f)return ui.filePanel.classList.add('hidden');ui.filePanel.classList.remove('hidden');ui.fileName.textContent=f.name;ui.fileSubline.textContent=`${bytes(f.size)} · ${h.kind} · ${h.magic}`;
    const cells=[['Resolution',`${h.width} × ${h.height}`],['Frames',h.frames.toLocaleString()],['Frame rate',h.fps?`${h.fps.toFixed(3).replace(/\.000$/,'')} fps`:'Unknown'],['Transparency',h.alpha?'Alpha present':'None'],['Audio',h.audioTracks?`${h.audioTracks} Bink stream${h.audioTracks===1?'':'s'}`:'No audio'],['Duration',h.fps?duration(h.frames/h.fps):'Unknown'],['Format',h.kind],['Input size',bytes(f.size)]];
    ui.metadataGrid.innerHTML=cells.map(([a,b])=>`<div class="metadata-item"><span>${esc(a)}</span><strong title="${esc(b)}">${esc(b)}</strong></div>`).join('');
    ui.formatNote.innerHTML=`<strong>${h.alpha?'VP9 with alpha':'VP9'} WebM.</strong>${h.audioTracks?' Audio will be transcoded to Opus.':''} OPFS streaming is used when supported.`;
  }

  async function selectFile(file){if(!file||state.phase==='converting')return;clearError();revoke();ui.resultCard.classList.add('hidden');resetProgress();try{state.header=parseBink(await file.slice(0,64).arrayBuffer());state.file=file;state.phase='ready';renderFile()}catch(e){state.file=state.header=null;ui.filePanel.classList.add('hidden');showError(e?.message||String(e))}updateControls()}
  function appendLog(text){if(!text)return;ui.logOutput.textContent+=`${text}\n`;if(ui.logOutput.textContent.length>50000)ui.logOutput.textContent=ui.logOutput.textContent.slice(-40000);ui.logOutput.scrollTop=ui.logOutput.scrollHeight}
  function startTimer(){if(state.timer)clearInterval(state.timer);state.timer=setInterval(()=>{if(state.phase==='converting')ui.elapsedValue.textContent=duration((performance.now()-state.startedAt)/1000)},250)}
  function stopTimer(){if(state.timer)clearInterval(state.timer);state.timer=null}
  function inputProgress(loaded,total){const f=total?Math.min(1,loaded/total):0,p=f*5;ui.progressBar.style.width=`${p}%`;ui.progressDetail.textContent=`Loading ${(f*100).toFixed(f<.1?1:0)}%`;ui.progressTitle.textContent=f>=1?'Initializing codecs…':'Loading Bink…';ui.frameValue.textContent=`0 / ${state.header?.frames||0}`}
  function progress(frame,total){const now=performance.now();total=total||state.header?.frames||0;if(state.lastFrameAt&&frame>state.lastFrame){const inst=(frame-state.lastFrame)/((now-state.lastFrameAt)/1000);state.smoothedFps=state.smoothedFps?state.smoothedFps*.78+inst*.22:inst}state.lastFrame=frame;state.lastFrameAt=now;const p=total?Math.min(100,5+frame/total*95):5;ui.progressBar.style.width=`${p}%`;ui.progressDetail.textContent=total?`${p.toFixed(p<10?1:0)}%`:'Working…';ui.frameValue.textContent=total?`${frame.toLocaleString()} / ${total.toLocaleString()}`:String(frame);ui.fpsValue.textContent=state.smoothedFps?`${state.smoothedFps.toFixed(1)} fps`:'—';ui.etaValue.textContent=state.smoothedFps&&total>frame?duration((total-frame)/state.smoothedFps):'—';ui.progressTitle.textContent=frame?'Encoding video…':'Initializing codecs…'}

  function destroyWorker(){state.worker?.terminate();state.worker=null;state.workerReady=false}
  function createWorker(){
    destroyWorker();state.phase=state.file?'ready':'booting';setEngine('loading','Loading','Starting the multithreaded decoder…');ui.threadValue.textContent=ui.workerFsValue.textContent='—';
    let w;try{w=new Worker('./bink2-worker.js')}catch(e){state.phase='error';showError(`Could not start worker: ${e?.message||e}`);return}state.worker=w;
    w.onmessage=e=>{const m=e.data||{};if(m.jobId!=null&&m.jobId!==state.jobId)return;switch(m.type){
      case'ready':state.workerReady=true;state.workerThreads=m.threads||1;state.phase=state.file?'ready':'idle';setEngine('ready','Ready',`${state.workerThreads} worker thread${state.workerThreads===1?'':'s'} available`);ui.threadValue.textContent=String(state.workerThreads);ui.workerFsValue.textContent=m.opfs?'OPFS streaming available':'MEMFS fallback';updateControls();break;
      case'input-mode':ui.workerFsValue.textContent=m.mode==='opfs'?'OPFS streaming (disk-backed)':m.mode==='staged'?'Chunked MEMFS fallback':'Memory input';ui.progressTitle.textContent='Loading Bink…';break;
      case'input-progress':inputProgress(m.loaded||0,m.total||state.file?.size||0);break;
      case'progress':progress(m.frame||0,m.total||state.header?.frames||0);break;
      case'done':finish(m);break;
      case'error':fail(m.message||'Conversion failed.');break;
      case'log':appendLog(m.text);break;
    }};
    w.onerror=e=>fail(`Converter worker crashed: ${e.message||'unknown worker error'}`);updateControls();
  }

  async function start(){if(!state.file||!state.header||!state.workerReady||state.phase==='converting')return;clearError();revoke();ui.resultCard.classList.add('hidden');state.phase='converting';state.jobId++;resetProgress();state.startedAt=performance.now();ui.idleActions.classList.add('hidden');ui.progressPanel.classList.remove('hidden');ui.progressTitle.textContent='Loading Bink…';setEngine('ready','Working',`${state.workerThreads} threads · conversion in progress`);updateControls();startTimer();try{state.worker.postMessage({type:'convert',jobId:state.jobId,file:state.file,crf:Number(ui.qualitySelect.value),cpuUsed:Number(ui.speedSelect.value),threads:state.workerThreads,alpha:state.header.alpha,audioTracks:state.header.audioTracks})}catch(e){fail(`Could not send file to converter: ${e?.message||e}`)}}

  function finish(m){
    if(state.phase!=='converting')return;stopTimer();state.phase='done';const blob=m.file instanceof Blob?m.file:new Blob([m.data],{type:'video/webm'});state.outputUrl=URL.createObjectURL(blob);const elapsed=(performance.now()-state.startedAt)/1000,frames=m.frames||state.header?.frames||0,avg=elapsed?frames/elapsed:0;
    ui.progressBar.style.width='100%';ui.progressDetail.textContent='100%';ui.elapsedValue.textContent=duration(elapsed);ui.fpsValue.textContent=avg?`${avg.toFixed(1)} fps`:'—';ui.etaValue.textContent='Done';ui.frameValue.textContent=`${frames.toLocaleString()} / ${frames.toLocaleString()}`;ui.progressTitle.textContent='Conversion complete';
    const base=(state.file?.name||'converted').replace(/\.(bk2|bik)$/i,'');ui.downloadButton.href=state.outputUrl;ui.downloadButton.download=`${base}.webm`;ui.previewVideo.src=state.outputUrl;ui.previewVideo.load();ui.previewStage.classList.toggle('alpha',!!state.header?.alpha);ui.previewNote.textContent=state.header?.alpha?'Checkerboard indicates transparent areas.':`Previewing the converted WebM locally${m.outputMode==='opfs'?' from OPFS':''}.`;
    const audio=state.header?.audioTracks?`${state.header.audioTracks} audio stream${state.header.audioTracks===1?'':'s'} → Opus`:'No audio';ui.resultTitle.textContent=`${base}.webm`;ui.resultMeta.textContent=`${bytes(blob.size)} · ${frames.toLocaleString()} frames · ${avg.toFixed(1)} fps conversion · ${audio}${m.outputMode==='opfs'?' · OPFS streamed':''}`;ui.resultCard.classList.remove('hidden');ui.idleActions.classList.remove('hidden');ui.progressPanel.classList.add('hidden');setEngine('ready','Ready',`${state.workerThreads} worker threads available`);updateControls();ui.resultCard.scrollIntoView({behavior:'smooth',block:'start'});
  }
  function fail(msg){stopTimer();state.phase='ready';ui.progressPanel.classList.add('hidden');ui.idleActions.classList.remove('hidden');showError(msg);setEngine(state.workerReady?'ready':'error',state.workerReady?'Ready':'Error',state.workerReady?`${state.workerThreads} worker threads available`:'Decoder unavailable');updateControls()}
  function cancel(){if(state.phase!=='converting')return;state.jobId++;stopTimer();state.phase='ready';ui.progressPanel.classList.add('hidden');ui.idleActions.classList.remove('hidden');showError('Conversion cancelled.');createWorker();updateControls()}
  function choose(e){e?.stopPropagation?.();if(state.phase!=='converting')ui.fileInput.click()}

  ui.dropZone.addEventListener('click',choose);ui.browseButton.addEventListener('click',choose);ui.replaceButton.addEventListener('click',choose);ui.fileInput.addEventListener('change',()=>{const f=ui.fileInput.files?.[0];ui.fileInput.value='';if(f)selectFile(f)});ui.dropZone.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choose(e)}});for(const n of['dragenter','dragover'])ui.dropZone.addEventListener(n,e=>{e.preventDefault();if(state.phase!=='converting')ui.dropZone.classList.add('dragging')});for(const n of['dragleave','drop'])ui.dropZone.addEventListener(n,e=>{e.preventDefault();ui.dropZone.classList.remove('dragging')});ui.dropZone.addEventListener('drop',e=>{if(state.phase!=='converting'){const f=e.dataTransfer?.files?.[0];if(f)selectFile(f)}});ui.convertButton.addEventListener('click',start);ui.cancelButton.addEventListener('click',cancel);ui.convertAnotherButton.addEventListener('click',choose);window.addEventListener('beforeunload',revoke);

  const isolated=!!window.crossOriginIsolated;ui.isolationValue.textContent=isolated?'Enabled':'Not enabled';if(!window.isSecureContext){state.phase='error';setEngine('error','HTTPS required','Multithreaded WebAssembly requires HTTPS or localhost.');showError('This converter must be served over HTTPS or localhost.')}else if(!isolated){setEngine('loading','Preparing','Enabling browser isolation… the page may reload once.')}else createWorker();
})();
