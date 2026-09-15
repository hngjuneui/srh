const $ = (id) => document.getElementById(id);
const elements = (q) => [...document.querySelectorAll(q)];
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const connections = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28]];
const presets = {economy:{width:640,fps:4,quality:.48},balanced:{width:960,fps:8,quality:.62},detail:{width:1280,fps:12,quality:.78}};
let sid = new URL(location.href).searchParams.get('session') || localStorage.getItem('rally-session');
let mode = 'analysis', settings = {}, names = {A:'TEAM A',B:'TEAM B'};
let stream, ws, timer, watchdog, pendingFrame, sequence = 0, stopped = true, reconnectTimer;
let activeJob, jobTimer, currentClips = [], playlist = [], playlistIndex = -1;
let recorder, chunks = [], recordingBytes = 0, recordingTimer, wakeLock;
let calibration = false, courtPoints = [], lastResult, sourceType = 'none';
let monitorBusy = false, monitorUrl, preset = localStorage.getItem('rally-preset') || 'balanced';
let syncView = true, networkSamples = [], health, toastTimer;
let maxUploadBytes = 512*1024*1024;
const deploymentReady = fetch('/api/deployment').then(r=>r.ok?r.json():null).then(config=>{
  if(config?.max_upload_bytes)maxUploadBytes=config.max_upload_bytes;
}).catch(()=>{});
const capture = document.createElement('canvas');
const ctx = capture.getContext('2d', {alpha:false});
const output = $('analysisCanvas'), overlay = $('overlayCanvas'), video = $('video');

function toast(message) { $('toast').textContent=message; $('toast').hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').hidden=true,6000); }
async function api(path, options={}) {
  const r = await fetch(path, {...options, headers: {...(options.body instanceof FormData?{}:{'Content-Type':'application/json'}), ...options.headers}});
  if(r.status===401) { if(!$('loginDialog').open) $('loginDialog').showModal(); throw new Error('PC 연결 코드를 입력하세요.'); }
  if(!r.ok) { let body={}; try {body=await r.json();}catch{} throw new Error(typeof body.detail==='string'?body.detail:`요청을 처리하지 못했습니다 (${r.status}).`); }
  return r.json();
}
const run = (fn) => (...args) => Promise.resolve().then(()=>fn(...args)).catch(e=>toast(e.message));
const show = (id) => { if(!$(id).open) $(id).showModal(); };
function selectMode(next) {
  mode=next;
  document.body.classList.toggle('score-mode',mode==='score');
  elements('[data-mode]').forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));
  $('coachPanel').hidden=mode!=='analysis'; $('scorePanel').hidden=mode!=='score';
  $('evidenceArea').hidden=mode!=='score'; $('eventList').hidden=mode!=='score';
  $('breadcrumbMode').textContent=mode==='analysis'?'영상 분석':'자동 스코어';
  $('pageTitle').innerHTML=mode==='analysis'?'플레이에 집중하세요.<br><span>분석은 랠리에게.</span>':'숫자는 맡겨두고,<br><span>다음 랠리에 집중하세요.</span>';
  $('pageSubtitle').textContent=mode==='analysis'?'당신의 클리어, 놓친 랠리, 다음 플레이를 위한 작은 발견.':'네 명의 플레이, 하나의 스코어. 잘못된 득점은 양팔 X로.';
  $('modeNote').textContent=mode==='analysis'?'포핸드 클리어 · 시간축 관찰':'복식 경기 · 실험적 자동 판정';
  if(mode==='score'&&sourceType==='file') toast('업로드 영상은 분석 모드로 처리됩니다. 자동 스코어는 실시간 카메라에서 시험하세요.');
}
elements('[data-mode]').forEach(b=>b.onclick=()=>selectMode(b.dataset.mode));
elements('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());
['guideOpen','referencesOpen'].forEach(id=>$(id).onclick=()=>show('guideDialog'));
['pairOpen','connectionHelp'].forEach(id=>$(id).onclick=()=>{ $('sessionLink').value=location.href; show('connectionDialog'); });
$('copyLink').onclick=run(async()=>{await navigator.clipboard.writeText(location.href);toast('경기 주소를 복사했습니다. 외부 접속에는 HTTPS 주소가 필요합니다.');});
['settingsOpen','settingsOpen2'].forEach(id=>$(id).onclick=()=>{
  const form=$('settingsForm');
  Object.entries(settings).forEach(([k,v])=>{const input=form.elements.namedItem(k);if(input) input.type==='checkbox'?input.checked=v:input.value=v;});
  $('networkPreset').value=preset; $('syncView').checked=syncView;
  $('thresholdLabel').value=Number(settings.threshold||.6).toFixed(2);$('settingsError').textContent='';show('settingsDialog');
});
$('settingsForm').elements.threshold.oninput=e=>$('thresholdLabel').value=Number(e.target.value).toFixed(2);
$('settingsForm').onsubmit=async e=>{
  e.preventDefault();
  try {
    const form=e.currentTarget, next={...settings};
    Object.keys(settings).forEach(k=>{const input=form.elements.namedItem(k);if(input) next[k]=input.type==='checkbox'?input.checked:['number','range'].includes(input.type)?Number(input.value):input.value;});
    settings=await api(`/api/sessions/${sid}/settings`,{method:'PUT',body:JSON.stringify(next)});
    preset=$('networkPreset').value; syncView=$('syncView').checked; localStorage.setItem('rally-preset',preset);
    $('settingsDialog').close(); updateView(); toast('설정을 적용했습니다.');
    document.querySelector('.gesture-card p').innerHTML=`랠리가 끝나면 카메라를 보고<br>양팔 X를 ${settings.hold_seconds}초 유지하세요.`;
    document.querySelector('.score-disclaimer').textContent=`4명 중 누구나 · 득점 후 ${settings.correction_window}초 이내 1회 · 가림·끊김 시 인식 불가`;
  }catch(err){$('settingsError').textContent=err.message;}
};

async function boot() {
  health=await api('/api/health');
  const sessions=await api('/api/sessions');
  if(!sessions.some(s=>s.id===sid)) sid=(await api('/api/sessions',{method:'POST'})).id;
  localStorage.setItem('rally-session',sid);
  history.replaceState(null,'',`?session=${sid}`);
  const s=await api(`/api/sessions/${sid}`); settings=s.settings; names=s.names; renderScore(s.score);
  $('serverPill').classList.add('connected');$('serverPill').innerHTML='<i></i>PC 서버 연결됨';
  $('sessionLink').value=location.href;
  if(!health.model_installed) toast('PC 포즈 모델이 없습니다. setup.ps1를 실행해 설치하세요.');
}
$('loginForm').onsubmit=async e=>{
  e.preventDefault(); $('loginError').textContent='';
  try { await api('/api/login',{method:'POST',body:JSON.stringify({code:$('accessCode').value.trim()})});$('loginDialog').close();await boot(); }
  catch(err){$('loginError').textContent=err.message;}
};
$('newSession').onclick=run(async()=>{
  await stopCamera(); sid=(await api('/api/sessions',{method:'POST'})).id;
  localStorage.setItem('rally-session',sid);history.replaceState(null,'',`?session=${sid}`);await boot();
  lastResult=null; $('evidenceList').textContent='랠리 종료를 기다리고 있습니다.';toast('새 경기를 만들었습니다.');
});

function renderScore(score) {
  for(const team of ['A','B']) { $('score'+team).textContent=score.points[team];$('games'+team).textContent=`${score.games[team]} GAME`;$('name'+team).textContent=names[team]; }
  $('scoreState').textContent=score.match_over?'경기 종료 · 새 경기를 시작하세요':`${score.server?`${names[score.server]} 서브권`:'서브권 미지정'} · ${settings.target||21}점 연습 규칙`;
  $('eventList').innerHTML=score.events.slice(-12).reverse().map(e=>`<span>#${e.id} ${esc(names[e.winner])} ${e.source==='manual'?'수동':'시험 자동'}${e.corrected?' · 수정됨':''}</span>`).join('');
  $('flipPoint').disabled=!score.events.length; $('undoPoint').disabled=!score.events.length;
  elements('[data-point]').forEach(b=>b.disabled=score.match_over);
}
async function scoreAction(action) {renderScore(await api(`/api/sessions/${sid}/score/${action}`,{method:'POST'}));}
elements('[data-point]').forEach(b=>b.onclick=run(()=>scoreAction(b.dataset.point)));
$('flipPoint').onclick=run(()=>scoreAction('flip'));$('undoPoint').onclick=run(()=>scoreAction('undo'));
elements('[data-name]').forEach(b=>b.onclick=run(async()=>{const value=prompt('팀 이름',names[b.dataset.name]);if(value===null)return;names=await api(`/api/sessions/${sid}/names`,{method:'PUT',body:JSON.stringify({...names,[b.dataset.name]:value})});b.textContent=value;}));

function updateView() {
  const live=sourceType==='live', file=sourceType==='file', monitor=sourceType==='monitor';
  $('emptyView').hidden=sourceType!=='none'; video.hidden=!(file||live&&!syncView);
  output.hidden=!(monitor||live&&syncView); overlay.hidden=!(monitor||live||calibration);
  if(live&&!syncView&&!calibration) overlay.hidden=true; // Never put old PC pose on current camera frame.
  $('stageTop').hidden=!(live||monitor);$('stageMessage').hidden=true;
  $('recordButton').disabled=!live; $('stopButton').disabled=sourceType==='none';
}
async function requestWakeLock() {try{wakeLock=await navigator.wakeLock?.request('screen');}catch{} }
async function startCamera() {
  if(!sid)throw new Error('PC 연결 코드를 먼저 입력하세요.');
  if(!window.isSecureContext) throw new Error('휴대폰 카메라를 사용하려면 HTTPS 주소로 접속하세요.');
  await stopCamera();
  clearTimeout(jobTimer);activeJob=null;playlist=[];playlistIndex=-1;
  if(!navigator.mediaDevices?.getUserMedia)throw new Error('이 브라우저에서 카메라를 사용할 수 없습니다.');
  stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30}},audio:false});
  video.srcObject=stream; video.controls=false; video.muted=true;
  await video.play();sourceType='live';stopped=false;updateView();await requestWakeLock();connectSocket();
}
$('startCamera').onclick=run(startCamera);
function connectSocket() {
  if(stopped)return;
  ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws/${sid}`);
  ws.onopen=()=>{ $('sourceChip').textContent='카메라 → PC';$('streamDot').classList.add('on');$('streamLabel').textContent='PC 분석 프레임 수신 중';sendFrame(); };
  ws.onmessage=e=>{
    const result=JSON.parse(e.data);
    if(result.error){toast(result.error);return;}
    if(!pendingFrame||result.seq!==pendingFrame.seq)return;
    clearTimeout(watchdog);
    const now=performance.now(), rtt=now-pendingFrame.sent;
    if(syncView) {output.width=capture.width;output.height=capture.height;output.getContext('2d').drawImage(capture,0,0);}
    renderResult(result,capture.width,capture.height);
    networkSamples.push({time:now,bytes:pendingFrame.bytes});networkSamples=networkSamples.filter(s=>now-s.time<5000);
    const period=networkSamples.length>1?(now-networkSamples[0].time)/1000:0;
    $('latencyValue').innerHTML=`${Math.round(rtt)} <small>ms</small>`;$('processValue').innerHTML=`${result.processing_ms} <small>ms</small>`;
    $('fpsValue').innerHTML=`${period>=1?((networkSamples.length-1)/period).toFixed(1):'—'} <small>fps</small>`;
    $('dataValue').innerHTML=`${period>=1?(networkSamples.slice(1).reduce((s,x)=>s+x.bytes,0)*8/period/1e6).toFixed(2):'—'} <small>Mbps</small>`;
    $('frameLabel').textContent=`#${result.seq} · ${capture.width} × ${capture.height}`;
    pendingFrame=null;
    const targetInterval=1000/presets[preset].fps;
    timer=setTimeout(sendFrame,Math.max(0,targetInterval-rtt));
  };
  ws.onclose=e=>{
    clearTimeout(watchdog);clearTimeout(timer);pendingFrame=null;$('streamDot').classList.remove('on');
    if(stopped)return;
    $('streamLabel').textContent='연결 끊김 · 분석/자동 기록 중지';
    if(e.code===4409){toast('다른 기기가 이 경기에 영상을 전송 중입니다. 별도 경기를 만들거나 해당 카메라를 중지하세요.');stopCamera();return;}
    if(e.code===4401){show('loginDialog');stopCamera();return;}
    toast('연결이 끊겼습니다. 3초 후 재연결합니다. 누락된 영상은 자동 복구되지 않습니다.');
    reconnectTimer=setTimeout(connectSocket,3000);
  };
  ws.onerror=()=>{$('streamLabel').textContent='연결 오류 · HTTPS/WSS 경로 확인';};
}
function sendFrame() {
  if(stopped||!ws||ws.readyState!==1||pendingFrame||video.readyState<2)return;
  if(document.hidden){timer=setTimeout(sendFrame,1000);return;}
  const p=presets[preset], width=Math.min(p.width,video.videoWidth),height=Math.round(video.videoHeight*width/video.videoWidth);
  capture.width=width;capture.height=height;ctx.drawImage(video,0,0,width,height);
  const jpeg=capture.toDataURL('image/jpeg',p.quality).split(',')[1];
  const packet=JSON.stringify({seq:++sequence,mode,source_time:video.currentTime,jpeg});
  pendingFrame={seq:sequence,sent:performance.now(),bytes:packet.length};
  ws.send(packet);
  watchdog=setTimeout(()=>{if(ws&&ws.readyState===1)ws.close(4000,'analysis timeout');},15000);
}
async function stopCamera() {
  stopped=true; clearTimeout(timer);clearTimeout(watchdog);clearTimeout(reconnectTimer);
  if(recorder?.state==='recording')recorder.stop();
  clearTimeout(recordingTimer);
  if(ws){ws.onclose=null;ws.close();ws=null;}pendingFrame=null;
  stream?.getTracks().forEach(t=>t.stop()); stream=null; video.srcObject=null;
  await wakeLock?.release().catch(()=>{});wakeLock=null;
  video.pause(); video.removeAttribute('src'); video.load();
  calibration=false;courtPoints=[];$('stage').classList.remove('calibrating');playlist=[];playlistIndex=-1;
  sourceType='none';networkSamples=[];updateView();
  for(const id of ['latencyValue','processValue','fpsValue','dataValue'])$(id).innerHTML=`— <small>${id==='dataValue'?'Mbps':id==='fpsValue'?'fps':'ms'}</small>`;
  $('streamDot').classList.remove('on');$('streamLabel').textContent='영상 입력이 중지되었습니다.';$('sourceChip').textContent='입력 대기';
}
$('stopButton').onclick=run(stopCamera);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&stream)requestWakeLock();});
window.addEventListener('pagehide',()=>{stopped=true;stream?.getTracks().forEach(t=>t.stop());ws?.close();});

function drawOverlay(result, width, height) {
  overlay.width=width;overlay.height=height;const c=overlay.getContext('2d');c.clearRect(0,0,width,height);
  c.lineWidth=Math.max(2,width/480);c.lineCap='round';
  for(const player of result?.people||[]) {
    const p=player.pose;c.strokeStyle=player.x?'#ffa477':player.team==='B'?'#efb186':'#deef9c';c.fillStyle=c.strokeStyle;
    for(const [a,b] of connections) if(p[a][2]>.55&&p[b][2]>.55){c.beginPath();c.moveTo(p[a][0]*width,p[a][1]*height);c.lineTo(p[b][0]*width,p[b][1]*height);c.stroke();}
    for(const q of p)if(q[2]>.6){c.beginPath();c.arc(q[0]*width,q[1]*height,Math.max(2,width/260),0,Math.PI*2);c.fill();}
    c.font=`${Math.max(12,width/55)}px sans-serif`;c.fillText(`${player.team||'P'}${player.id} · ${player.phase}`,p[0][0]*width,Math.max(16,p[0][1]*height-18));
  }
  if(result?.shuttle){c.strokeStyle='#ffb274';c.beginPath();c.arc(result.shuttle[0]*width,result.shuttle[1]*height,9,0,Math.PI*2);c.stroke();}
  const points=calibration?courtPoints:settings.court||[];
  if(points.length){c.strokeStyle='#ecf6aa';c.fillStyle='#ecf6aa';c.beginPath();points.forEach((p,i)=>{i?c.lineTo(p[0]*width,p[1]*height):c.moveTo(p[0]*width,p[1]*height);});if(points.length===4)c.closePath();c.stroke();points.forEach((p,i)=>{c.beginPath();c.arc(p[0]*width,p[1]*height,5,0,Math.PI*2);c.fill();c.fillText(String(i+1),p[0]*width+8,p[1]*height-8);});}
}
function renderResult(result,width,height) {
  lastResult=result;
  if(sourceType==='live'&&syncView)drawOverlay(result,width,height);
  renderScore(result.score);
  $('gestureProgress').style.width=`${100*result.gesture_progress}%`;
  $('liveLabel').textContent='● '+result.status;
  const messages=result.model_error?[`포즈 모델 오류: ${result.model_error}`]:result.guidance;
  if(!calibration&&sourceType==='live'){ $('stageMessage').hidden=!messages?.length;$('stageMessage').textContent=messages?.[0]||''; }
  const last=result.strokes?.at(-1);
  $('coachResult').textContent=last?`스윙 후보 ${result.strokes.length}개 · ${last.preparation_seen?'사전 팔 준비가 관찰됨':'사전 준비를 충분히 관찰하지 못함'}. 실제 타점·그립 평가는 아직 불가합니다.`:(result.feedback?.[0]||'준비–스윙 흐름을 관찰 중입니다. 라켓과 셔틀의 실제 접촉은 아직 측정하지 않습니다.');
  if(result.pending){const p=result.pending;$('evidenceList').innerHTML=`<b>${p.decision?`${esc(p.decision.winner)}팀 · 근거 강도 ${p.decision.strength}`:'판정 보류'}</b><br>`+(p.votes.length?p.votes.map(v=>`${settings[v.algorithm]?'●':'○ 비활성'} ${esc(v.winner)}팀 ${v.strength.toFixed(2)} · ${esc(v.reason)}`).join('<br>'):'득점 팀을 정할 근거가 없습니다.');}
  if(result.notice)toast(result.notice);
}

$('calibrateButton').onclick=()=>{
  if(!['live','file'].includes(sourceType)){toast('카메라 또는 영상을 먼저 연결하세요.');return;}
  calibration=!calibration;courtPoints=[];$('stage').classList.toggle('calibrating',calibration);updateView();
  if(calibration){video.pause();$('stageMessage').hidden=false;$('stageMessage').textContent='가까운 왼쪽 → 가까운 오른쪽 → 먼 오른쪽 → 먼 왼쪽 순서로 코트 모서리를 눌러주세요.';const w=video.videoWidth||960,h=video.videoHeight||540;drawOverlay(null,w,h);}
  else if(sourceType==='live') video.play().catch(e=>toast(e.message));
};
overlay.onclick=run(async e=>{
  if(!calibration)return;
  const r=overlay.getBoundingClientRect(), scale=Math.min(r.width/overlay.width,r.height/overlay.height);
  const x=(e.clientX-r.left-(r.width-overlay.width*scale)/2)/(overlay.width*scale),y=(e.clientY-r.top-(r.height-overlay.height*scale)/2)/(overlay.height*scale);
  if(x<0||x>1||y<0||y>1)return;
  courtPoints.push([x,y]);drawOverlay(null,overlay.width,overlay.height);
  if(courtPoints.length===4){try{settings=await api(`/api/sessions/${sid}/settings`,{method:'PUT',body:JSON.stringify({...settings,court:courtPoints})});calibration=false;$('stage').classList.remove('calibrating');updateView();if(sourceType==='live')await video.play();toast('코트 좌표를 저장했습니다. 카메라를 움직이면 다시 지정하세요.');}catch(error){courtPoints=[];throw error;}}
});

$('recordButton').onclick=()=>{
  if(recorder?.state==='recording'){recorder.stop();clearTimeout(recordingTimer);return;}
  if(!stream||!window.MediaRecorder){toast('이 브라우저는 원본 녹화를 지원하지 않습니다.');return;}
  const type=['video/mp4','video/webm;codecs=vp8','video/webm'].find(t=>MediaRecorder.isTypeSupported(t));
  chunks=[];recordingBytes=0;recorder=new MediaRecorder(stream,type?{mimeType:type}:{});
  recorder.ondataavailable=e=>{if(e.data.size){chunks.push(e.data);recordingBytes+=e.data.size;}if(recordingBytes>250e6&&recorder.state==='recording'){recorder.stop();toast('메모리 보호를 위해 250 MB에서 녹화를 마칩니다.');}};
  recorder.onstop=()=>{const blob=new Blob(chunks,{type:recorder.mimeType});const url=URL.createObjectURL(blob);download(url,`rally-original.${recorder.mimeType.includes('mp4')?'mp4':'webm'}`);setTimeout(()=>URL.revokeObjectURL(url),60000);chunks=[];$('recordButton').innerHTML='● <span>녹화</span>';toast('휴대폰 원본을 저장했습니다. 영상 불러오기로 PC에 보내 분석하세요.');};
  recorder.start(1000);$('recordButton').innerHTML='■ <span>저장</span>';toast('원본 녹화 시작 · 소리 없이 최대 10분/250 MB.');recordingTimer=setTimeout(()=>{if(recorder.state==='recording')recorder.stop();},600000);
};
function download(url,name){const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();}

['uploadButton','moreUpload'].forEach(id=>$(id).onclick=()=>$('videoFile').click());
$('videoFile').onchange=run(async e=>{
  const file=e.target.files[0];if(!file)return;
  await deploymentReady;
  if(file.size>maxUploadBytes){e.target.value='';throw new Error(`${Math.floor(maxUploadBytes/1024/1024)} MB 이하의 영상을 선택하세요.`);}
  await stopCamera();selectMode('analysis');clearTimeout(jobTimer);activeJob=null;currentClips=[];renderClips();
  $('uploadProgress').hidden=false;$('uploadText').textContent='PC로 영상 업로드 중…';$('progress').removeAttribute('value');
  try{
    const body=new FormData();body.append('file',file);
    const job=await api(`/api/videos?sid=${sid}`,{method:'POST',body});activeJob=job.id;
    sourceType='file';video.controls=true;video.muted=true;updateView();
    $('sourceChip').textContent='PC에 저장한 영상';$('streamLabel').textContent=file.name;
    $('uploadText').textContent='PC 분석 대기 중';pollJob(job.id);
  }catch(error){$('uploadText').textContent=error.message;throw error;}finally{e.target.value='';}
});
async function pollJob(id){
  if(activeJob!==id)return;
  try{
    const j=await api(`/api/videos/${id}`);
    if(activeJob!==id)return;
    $('progress').value=j.progress;
    $('uploadText').textContent=j.status==='queued'?'PC 분석 대기 중':j.status==='preparing'?'PC에서 브라우저용 재생본을 준비하고 있습니다…':j.status==='analyzing'?`PC 분석 중 · ${j.progress}% · ${j.result?.frame_count||0} 프레임 처리`:j.status==='done'?`분석 완료 · ${j.clips.length}개 랠리 후보 · ${j.strokes.length}개 스윙 후보`:`분석 실패 · ${j.error}`;
    if(j.preview_ready&&!video.getAttribute('src'))video.src=`/api/videos/${id}/source`;
    if(j.status==='done'){
      currentClips=j.clips;renderClips();
      $('coachResult').textContent=j.model_error?`모델 오류: ${j.model_error}`:`스윙 후보 ${j.strokes.length}개 · 클리어 실제 타점은 미확인. 자동 구간을 확인하고 시작·끝 시간을 수정하세요.`;
      $('clipsEmpty').querySelector('p').textContent=j.clips.length?'': '자동 랠리 후보를 찾지 못했습니다. 전신·팔 가림과 촬영 구도를 확인하거나 구간을 직접 추가하세요.';
      return;
    }
    if(j.status==='error')return;
    jobTimer=setTimeout(()=>pollJob(id),1500);
  }catch(e){$('uploadText').textContent=`분석 상태 조회 실패 · ${e.message}`;jobTimer=setTimeout(()=>pollJob(id),5000);}
}
function renderClips(){
  $('clipCount').textContent=`${currentClips.length} clips`;$('clipsEmpty').hidden=currentClips.length>0;
  $('clipList').innerHTML=currentClips.map((c,i)=>`<div class="clip-row"><input type="checkbox" data-select="${i}" ${c.selected?'checked':''} aria-label="${i+1}번 구간 선택"><span class="clip-icon">▶</span><div class="clip-meta"><b>RALLY ${String(i+1).padStart(2,'0')}</b><small>${esc(c.label)} · ${(c.end-c.start).toFixed(1)}초</small></div><label>시작<input type="number" data-start="${i}" value="${c.start}" min="0" step=".1"></label><label>끝<input type="number" data-end="${i}" value="${c.end}" min="0" step=".1"></label><button data-preview="${i}" aria-label="${i+1}번 구간 재생">▶</button><button data-delete="${i}" aria-label="${i+1}번 구간 삭제">×</button></div>`).join('');
  elements('[data-select]').forEach(el=>el.onchange=()=>currentClips[el.dataset.select].selected=el.checked);
  elements('[data-start]').forEach(el=>el.onchange=()=>currentClips[el.dataset.start].start=Number(el.value));
  elements('[data-end]').forEach(el=>el.onchange=()=>currentClips[el.dataset.end].end=Number(el.value));
  elements('[data-preview]').forEach(el=>el.onclick=run(async()=>{playlist=[currentClips[el.dataset.preview]];playlistIndex=0;video.currentTime=playlist[0].start;await video.play();}));
  elements('[data-delete]').forEach(el=>el.onclick=()=>{currentClips.splice(Number(el.dataset.delete),1);renderClips();});
}
$('addClip').onclick=()=>{if(!activeJob||!Number.isFinite(video.duration)){toast('영상 파일 분석이 완료된 후 구간을 추가하세요.');return;}const start=Math.min(video.currentTime,Math.max(0,video.duration-1));currentClips.push({start:Math.round(start*10)/10,end:Math.min(video.duration,start+8),selected:true,label:'직접 추가'});renderClips();};
async function saveClips(){if(!activeJob)throw new Error('영상을 먼저 업로드하세요.');currentClips=await api(`/api/videos/${activeJob}/clips`,{method:'PUT',body:JSON.stringify({clips:currentClips})});renderClips();}
$('playClips').onclick=run(async()=>{await saveClips();playlist=currentClips.filter(c=>c.selected);if(!playlist.length)throw new Error('재생할 구간을 선택하세요.');playlistIndex=0;video.currentTime=playlist[0].start;await video.play();toast('선택한 랠리만 이어서 재생합니다.');});
video.addEventListener('timeupdate',()=>{
  if(sourceType!=='file'||playlistIndex<0||!playlist.length)return;
  if(video.currentTime>=playlist[playlistIndex].end-.08){playlistIndex++;if(playlistIndex>=playlist.length){video.pause();playlistIndex=-1;playlist=[];}else video.currentTime=playlist[playlistIndex].start;}
});
$('exportClips').onclick=run(async()=>{
  await saveClips();const id=activeJob;await api(`/api/videos/${id}/export`,{method:'POST'});
  $('exportClips').disabled=true;$('exportClips').textContent='MP4 만드는 중…';
  const poll=async()=>{try{const j=await api(`/api/videos/${id}`);if(j.export_status==='done'){download(`/api/videos/${id}/export`,'rally-highlights.mp4');toast('선택 구간을 MP4로 저장했습니다. 테스트 버전의 하이라이트에는 음성이 없습니다.');}else if(j.export_status==='error')throw new Error(j.export_error);else {setTimeout(poll,1500);return;}}catch(e){toast(e.message);} $('exportClips').disabled=false;$('exportClips').textContent='MP4 내보내기 ↗';};poll();
});

// A second device can open the exact session URL to inspect frames RECEIVED by the PC.
setInterval(async()=>{
  if(!sid||stream||activeJob||monitorBusy||document.hidden||$('loginDialog').open)return;
  monitorBusy=true;
  try{
    const s=await api(`/api/sessions/${sid}`);names=s.names;renderScore(s.score);
    if(s.streaming&&s.age!==null&&s.age<5&&s.result?.frame_count){
      const r=await fetch(`/api/sessions/${sid}/preview.jpg`);if(!r.ok)return;
      if(monitorUrl)URL.revokeObjectURL(monitorUrl);monitorUrl=URL.createObjectURL(await r.blob());
      const image=new Image();image.src=monitorUrl;await image.decode();
      sourceType='monitor';updateView();output.width=image.width;output.height=image.height;output.getContext('2d').drawImage(image,0,0);
      overlay.hidden=true; // This polled snapshot is not frame-aligned with JSON.
      renderResult(s.result,image.width,image.height);$('sourceChip').textContent='PC 수신 모니터';$('frameLabel').textContent=`수신 ${s.result.frame_count}프레임`;$('streamLabel').textContent='다른 기기의 카메라 → 이 PC에서 분석됨';
    }else if(sourceType==='monitor'){$('streamLabel').textContent='전송 중지 · 마지막 수신 화면';}
  }catch{}finally{monitorBusy=false;}
},2000);
boot().catch(e=>{if(!$('loginDialog').open)toast(e.message);});
