import {createMatch,score,addEvent,undoPoint,validMatch,HoldInput} from './core.js';
const $=s=>document.querySelector(s),KEY='rally-scoreboard-v1';
const fresh=()=>({matches:[],current:null,vault:Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join(''),prefs:{sound:false,awake:true,dim:true,remote:true,hold:700,short:0,key:null}});
let state,storageOK=true;try{state=JSON.parse(localStorage.getItem(KEY))||fresh();if(!Array.isArray(state.matches))throw Error();}catch{state=fresh();storageOK=false;}
let syncBusy=false,syncAgain=false,newMode=true,learning=false,idleTimer,toastTimer,wakeLock,logs=[],syncMessage='● 기기에 저장',lastKeyDown=0;
const current=()=>state.matches.find(m=>m.id===state.current);
const elapsed=t=>{const sec=Math.max(0,Math.floor(t/1000));return String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0');};
function persist(){try{localStorage.setItem(KEY,JSON.stringify(state));storageOK=true;}catch{storageOK=false;toast('기기 저장에 실패했습니다. 기록에서 JSON 백업을 해주세요.');}$('#syncStatus').textContent=storageOK?syncMessage:'⚠ 기기 저장 실패';}
function toast(text){$('#toast').textContent=text;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),3000);}
function active(){document.body.classList.remove('idle');clearTimeout(idleTimer);if(state.prefs.dim)idleTimer=setTimeout(()=>{if(!document.querySelector('dialog[open]'))document.body.classList.add('idle');},5000);}
const modalOpen=()=>!!document.querySelector('dialog[open]');
function open(id){hold.reset();active();$(id).showModal();}
function closeDialogs(){document.querySelectorAll('dialog[open]').forEach(d=>d.close());}
function feedback(team){const el=team===0?$('#teamA'):$('#teamB');el.classList.remove('pulse');requestAnimationFrame(()=>el.classList.add('pulse'));setTimeout(()=>el.classList.remove('pulse'),220);if(state.prefs.sound)try{const ac=audio||(audio=new (window.AudioContext||window.webkitAudioContext)());ac.resume();const o=ac.createOscillator(),g=ac.createGain();o.connect(g);g.connect(ac.destination);o.frequency.value=team===0?660:440;g.gain.setValueAtTime(.08,ac.currentTime);g.gain.exponentialRampToValueAtTime(.001,ac.currentTime+.1);o.start();o.stop(ac.currentTime+.12);}catch{}}
let audio;
function changed(){syncMessage='● 기기에 저장 · 동기화 대기';persist();render();scheduleSync();}
let syncTimer;
function scheduleSync(){clearTimeout(syncTimer);syncTimer=setTimeout(sync,500);}
function point(team,source='touch'){
 const m=current();if(!m)return;
 if(m.conflict){toast('기록 충돌을 먼저 해결해주세요. 보관함에서 확인할 수 있어요.');return;}
 if(score(m).gameOver||score(m).finished){toast('종료된 게임입니다. 되돌리기 또는 새 경기를 선택하세요.');return;}
 if(m.events.length>=650){toast('이 경기의 기록 한도에 도달했습니다. 새 경기를 시작하세요.');return;}
 addEvent(m,'point',{team,source});feedback(team);changed();
}
function undo(team){const m=current();if(!m||m.conflict)return;if(undoPoint(m,team)){changed();toast('득점 1개를 취소했습니다.');}else toast('현재 게임에서 취소할 득점이 없습니다.');}
function render(){
 const m=current();if(!m)return;const s=score(m);
 ['A','B'].forEach((v,i)=>{$('#name'+v).textContent=m.settings.names[i];$('#score'+v).textContent=s.points[i];$('#wins'+v).textContent='게임 '+s.wins[i];$('#serve'+v).classList.toggle('inactive',s.server!==i||s.gameOver||s.finished);$('#team'+v).setAttribute('aria-label',m.settings.names[i]+' '+s.points[i]+'점, 누르면 득점');});
 // Flex order preserves team identity for remote mapping.
 $('#teamA').style.order=s.swapped?'2':'0';$('#teamB').style.order=s.swapped?'0':'2';$('.divider').style.order='1';
 $('#gameLabel').textContent='GAME '+String(s.game).padStart(2,'0');
 $('#ruleLabel').textContent=m.settings.target+'점 · '+(m.settings.bestOf===1?'단판':m.settings.bestOf+'게임');
 const notice=$('#gameNotice');notice.replaceChildren();
 if(s.gameOver||s.finished){const t=document.createElement('span');t.textContent=s.finished?'경기 종료 · 기록이 저장되었습니다':'게임 종료';notice.append(t);const b=document.createElement('button');b.textContent=s.finished?'새 경기':'다음 게임';b.onclick=()=>{if(s.finished)settings(true);else{addEvent(m,'next');addEvent(m,'swap');changed();}};notice.append(b);}
 else if(s.points[0]>=m.settings.target-1&&s.points[1]>=m.settings.target-1&&m.settings.deuce){notice.textContent=s.points[0]===s.points[1]?'DEUCE · 듀스':'GAME POINT · 게임 포인트';}
 else if(Math.max(...s.points)>=m.settings.target-1)notice.textContent='GAME POINT · 게임 포인트';
 $('#remoteCaption').textContent=state.prefs.key&&state.prefs.remote?'리모컨 · 짧게 '+m.settings.names[state.prefs.short]+' / 길게 '+m.settings.names[1-state.prefs.short]:'탭 또는 아래로 +1 · 위로 쓸어 취소';
 $('#undo').disabled=!m.events.some(e=>e.type==='point')||!!m.conflict;
 $('#swap').disabled=!!m.conflict;$('#timer').textContent=elapsed((s.finished?(m.events.at(-1)?.at||m.createdAt):Date.now())-m.createdAt);
 if($('#historyDialog').open)renderHistory();if($('#vaultDialog').open)renderVault();
}
function settings(isNew){
 newMode=isNew;const m=current(),f=$('#settingsForm'),s=m?.settings||createMatch().settings;
 f.elements.nameA.value=s.names[0];f.elements.nameB.value=s.names[1];for(const k of ['target','cap','bestOf','first'])f.elements[k].value=s[k];f.elements.deuce.checked=s.deuce;
 const locked=!isNew&&m.events.some(e=>e.type==='point');
 ['target','cap','bestOf','first','deuce'].forEach(k=>f.elements[k].disabled=locked);
 $('#settingsTitle').textContent=isNew?'새 경기':'경기 설정';$('#settingsSubmit').textContent=isNew?'경기 시작':'설정 저장';
 $('#settingsHelp').textContent=locked?'진행 중에는 팀 이름을 바꿀 수 있습니다. 점수 규칙 변경은 새 경기에서 적용하세요.':'목표 점수와 경기 방식을 정하고 바로 시작하세요.';
 $('#endMatch').hidden=isNew||score(m).finished;open('#settingsDialog');
}
$('#settingsForm').onsubmit=e=>{
 e.preventDefault();const f=e.currentTarget,s={names:[f.elements.nameA.value.trim()||'우리 팀',f.elements.nameB.value.trim()||'상대 팀'],target:+f.elements.target.value,cap:+f.elements.cap.value,bestOf:+f.elements.bestOf.value,first:+f.elements.first.value,deuce:f.elements.deuce.checked};
 if(s.cap<s.target){toast('상한 점수는 목표 점수 이상이어야 합니다.');return;}
 if(newMode){const m=createMatch(s);state.matches.unshift(m);state.current=m.id;}else{if(current().conflict){toast('보관함에서 기록 충돌을 먼저 해결하세요.');return;}current().settings=s;current().dirty=true;}
 closeDialogs();changed();requestWake();
};
$('#settingsOpen').onclick=()=>settings(false);$('#newOpen').onclick=()=>settings(true);
$('#undo').onclick=()=>undo();$('#swap').onclick=()=>{if(current().conflict)return;addEvent(current(),'swap');changed();};
$('#endMatch').onclick=()=>{if(confirm('현재 점수로 경기를 종료할까요? 기록은 그대로 보관됩니다.')){addEvent(current(),'finish');closeDialogs();changed();}};
for(const el of document.querySelectorAll('.team')){
 let start=null,multi=false;
 el.addEventListener('pointerdown',e=>{active();requestWake();if(e.pointerType==='mouse'&&e.button!==0)return;if(start){multi=true;return;}multi=false;start={x:e.clientX,y:e.clientY,id:e.pointerId};el.setPointerCapture(e.pointerId);});
 el.addEventListener('pointerup',e=>{if(!start||e.pointerId!==start.id)return;const dx=e.clientX-start.x,dy=e.clientY-start.y;start=null;if(multi)return;const t=+el.dataset.team;if(Math.abs(dy)>=45&&Math.abs(dy)>Math.abs(dx)*1.2){if(dy>0)point(t);else undo(t);}else if(Math.abs(dx)<18&&Math.abs(dy)<18)point(t);});
 el.addEventListener('pointercancel',()=>{start=null;});
 el.addEventListener('click',e=>{e.preventDefault();if(e.detail===0&&!e.pointerType&&!state.prefs.key)point(+el.dataset.team,'keyboard');});
 el.addEventListener('contextmenu',e=>e.preventDefault());
}
document.querySelectorAll('.close').forEach(b=>b.onclick=()=>b.closest('dialog').close());
document.querySelectorAll('dialog').forEach(d=>d.addEventListener('close',()=>{learning=false;$('#learnKey').textContent='리모컨 버튼 등록';hold.reset();active();}));
document.addEventListener('pointerdown',active,{passive:true});
const hold=new HoldInput({threshold:state.prefs.hold,onShort:()=>point(state.prefs.short,'remote-short'),onLong:()=>point(1-state.prefs.short,'remote-long'),onProgress:v=>{$('#holdIndicator').hidden=!v;}});
const keyID=e=>(e.code&&e.code!=='Unidentified')?'code:'+e.code:'key:'+e.key;
function inputLog(e){
 if(!$('#remoteDialog').open)return;
 logs.unshift(e.type+'  key='+e.key+'  code='+e.code+'  repeat='+e.repeat);logs=logs.slice(0,18);$('#keyLog').textContent=logs.join('\n');
 if(e.type==='keydown'&&!e.repeat)lastKeyDown=Date.now();
 if(e.type==='keyup')$('#keyAdvice').textContent='누름→뗌 감지: '+(Date.now()-lastKeyDown)+'ms. 2초 길게 눌렀다면 이 시간도 약 2000ms인지 확인하세요.';
}
document.addEventListener('keydown',e=>{
 inputLog(e);
 if(learning){
  e.preventDefault();e.stopImmediatePropagation();
  if(e.repeat)return;
  if(['Escape','Tab','Meta','Control','Alt','Shift','Unidentified','AudioVolumeUp','AudioVolumeDown','BrowserHome'].includes(e.key)){toast('이 버튼 대신 일반 키로 인식되는 버튼을 눌러주세요.');return;}
  state.prefs.key=keyID(e);persist();learning=false;$('#learnKey').textContent='다시 등록';$('#keyLabel').textContent=state.prefs.key;hold.reset();render();toast('등록했습니다. 창을 닫고 짧게·길게 눌러보세요.');return;
 }
 if(!state.prefs.remote||keyID(e)!==state.prefs.key)return;
 if(modalOpen())return;
 e.preventDefault();e.stopImmediatePropagation();hold.down(e.repeat);requestWake();
},true);
document.addEventListener('keyup',e=>{inputLog(e);if(state.prefs.remote&&keyID(e)===state.prefs.key&&!modalOpen()){e.preventDefault();e.stopImmediatePropagation();hold.up();}},true);
window.addEventListener('blur',()=>hold.reset());
document.addEventListener('visibilitychange',()=>{hold.reset();if(!document.hidden){requestWake();sync();}});
$('#remoteOpen').onclick=()=>{$('#keyLabel').textContent=state.prefs.key||'등록된 버튼 없음';open('#remoteDialog');};
$('#learnKey').onclick=()=>{learning=true;$('#learnKey').textContent='리모컨 버튼을 눌러주세요…';$('#learnKey').blur();};
for(const [id,key] of [['sound','sound'],['keepAwake','awake'],['dimControls','dim'],['remoteEnabled','remote']]){
 $( '#'+id).checked=state.prefs[key];$('#'+id).onchange=e=>{state.prefs[key]=e.target.checked;persist();hold.reset();render();active();if(key==='awake')requestWake();};
}
$('#holdTime').value=state.prefs.hold;$('#holdTime').onchange=e=>{state.prefs.hold=+e.target.value;hold.threshold=state.prefs.hold;persist();hold.reset();};
$('#shortTeam').value=state.prefs.short;$('#shortTeam').onchange=e=>{state.prefs.short=+e.target.value;persist();render();};
async function requestWake(){if(!state.prefs.awake){await wakeLock?.release();wakeLock=null;return;}if(!navigator.wakeLock||document.hidden||wakeLock&&!wakeLock.released)return;try{wakeLock=await navigator.wakeLock.request('screen');}catch{}}
$('#fullScreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();requestWake();}catch{toast('이 브라우저에서는 홈 화면에 추가해 넓게 사용할 수 있습니다.');}};
function renderHistory(){
 const list=$('#matches');list.replaceChildren();
 for(const m of [...state.matches].sort((a,b)=>b.createdAt-a.createdAt)){
  const s=score(m),card=document.createElement('div');card.className='match-card'+(m.id===state.current?' active':'');
  const info=document.createElement('div');info.className='info';const name=document.createElement('b');name.textContent=m.settings.names.join(' / ');const meta=document.createElement('small');meta.textContent=new Date(m.createdAt).toLocaleString('ko-KR')+' · '+(s.finished?'종료':'진행 중')+(m.conflict?' · 충돌':m.dirty?' · 동기화 대기':' · 동기화 완료');info.append(name,meta);
  const result=document.createElement('strong');result.textContent=s.points.join(' : ');
  const b=document.createElement('button');b.textContent=m.id===state.current?'현재 경기':'열기';b.onclick=()=>{hold.reset();state.current=m.id;persist();render();};card.append(info,result,b);list.append(card);
 }
 const m=current(),ol=$('#timeline');ol.replaceChildren();const undone=new Set(m.events.filter(e=>e.type==='undo').map(e=>e.target));
 const rows=[{at:m.createdAt,type:'start'},...m.events];
 for(let i=rows.length-1;i>=0;i--){const e=rows[i],li=document.createElement('li'),t=document.createElement('time'),desc=document.createElement('span');t.textContent=elapsed(e.at-m.createdAt);
 desc.textContent=e.type==='start'?'경기 시작':e.type==='point'?m.settings.names[e.team]+' +1'+(undone.has(e.id)?' · 취소됨':''):e.type==='undo'?m.settings.names[e.team]+' 득점 취소':e.type==='swap'?'코트 좌우 교대':e.type==='next'?'다음 게임 시작':'경기 종료';
 if(undone.has(e.id))desc.className='cancelled';
 li.append(t,desc);ol.append(li);}
}
$('#historyOpen').onclick=()=>{renderHistory();open('#historyDialog');};
function download(data,name){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('#export').onclick=()=>download({version:1,matches:state.matches.map(({conflict,...m})=>m)},'rally-matches-'+new Date().toISOString().slice(0,10)+'.json');
$('#import').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>5000000)throw Error();const data=JSON.parse(await file.text());if(!Array.isArray(data.matches)||data.matches.length>200||!data.matches.every(validMatch))throw Error();for(const raw of data.matches){const m=structuredClone(raw);m.id=crypto.randomUUID();m.rev=0;m.dirty=true;delete m.conflict;state.matches.unshift(m);}changed();toast(data.matches.length+'개 경기를 별도 사본으로 복원했습니다.');}catch{toast('지원하는 경기 백업 파일인지 확인해주세요.');}e.target.value='';};
async function api(path,options={},token=state.vault){const response=await fetch('/api/'+path,{...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},signal:AbortSignal.timeout(12000)});const data=await response.json();return {response,data};}
async function sync(){
 if(syncBusy){syncAgain=true;return;}if(!navigator.onLine){syncMessage='● 오프라인 · 기기에 저장';persist();return;}syncBusy=true;
 try{
  for(const m of state.matches.filter(m=>m.dirty&&!m.conflict)){
   const snapshot=JSON.stringify(m.events),settingsSnapshot=JSON.stringify(m.settings);
   const {response,data}=await api('matches/'+m.id,{method:'PUT',body:JSON.stringify({match:m,revision:m.rev||0})});
   if(response.status===409){m.conflict=data.remote;continue;}
   if(!response.ok)throw Error(data.error||'동기화 실패');
   m.rev=data.rev;m.dirty=snapshot!==JSON.stringify(m.events)||settingsSnapshot!==JSON.stringify(m.settings);persist();
  }
  const {response,data}=await api('matches');if(!response.ok||!Array.isArray(data.matches))throw Error('서버 연결 실패');
  for(const remote of data.matches){if(!validMatch(remote))continue;const i=state.matches.findIndex(m=>m.id===remote.id);if(i<0)state.matches.push({...remote,dirty:false});else if(!state.matches[i].dirty)state.matches[i]={...remote,dirty:false};}
  syncMessage=state.matches.some(m=>m.conflict)?'⚠ 기록 충돌 · 보관함 확인':state.matches.some(m=>m.dirty)?'● 기기에 저장 · 동기화 대기':'● 동기화 완료';persist();render();
 }catch{syncMessage='● 기기에 저장 · 서버 연결 대기';persist();}
 finally{syncBusy=false;if(syncAgain){syncAgain=false;scheduleSync();}if($('#vaultDialog').open)renderVault();}
}
function renderVault(){
 $('#vaultState').textContent=syncMessage+' · '+state.matches.length+'개 경기';
 const box=$('#conflicts');box.replaceChildren();for(const m of state.matches.filter(m=>m.conflict)){
  const p=document.createElement('p');p.textContent=m.settings.names.join(' / ')+': 다른 기기에서도 수정되었습니다. 이 기기의 기록을 사본으로 보관하고 서버 기록을 가져올 수 있습니다.';
  const b=document.createElement('button');b.className='secondary';b.textContent='내 기록을 사본으로 보관하고 해결';
  b.onclick=()=>{const copy=structuredClone(m);copy.id=crypto.randomUUID();copy.rev=0;copy.dirty=true;delete copy.conflict;const remote=m.conflict;state.matches=state.matches.map(x=>x.id===m.id?{...remote,dirty:false}:x);state.matches.unshift(copy);state.current=copy.id;changed();renderVault();};box.append(p,b);
 }
}
$('#vaultOpen').onclick=()=>{closeDialogs();renderVault();open('#vaultDialog');};$('#syncStatus').onclick=()=>{renderVault();open('#vaultDialog');};
$('#copyCode').onclick=async()=>{try{await navigator.clipboard.writeText(state.vault);toast('연결 코드를 복사했습니다. 개인적으로 보관해주세요.');}catch{prompt('이 연결 코드를 복사해 보관하세요.',state.vault);}};
$('#syncNow').onclick=sync;
$('#connectVault').onclick=async()=>{
 const token=$('#connectCode').value.trim().toLowerCase();if(!/^[a-f0-9]{64}$/.test(token)){toast('64자리 연결 코드를 확인해주세요.');return;}
 if(syncBusy){toast('동기화가 끝난 후 다시 연결해주세요.');return;}
 if(token===state.vault){toast('이미 연결된 보관함입니다.');return;}
 await sync();if(state.matches.some(m=>m.dirty)){toast('현재 기록의 동기화를 마친 후 전환해주세요.');return;}
 if(!confirm('다른 보관함으로 전환할까요? 현재 보관함으로 돌아오려면 현재 연결 코드를 보관해야 합니다.'))return;
 try{const {response,data}=await api('matches',{},token);if(!response.ok||!Array.isArray(data.matches))throw Error();if(!data.matches.length){toast('기록이 없는 코드입니다. 기존 기기의 코드를 다시 확인해주세요.');return;}
 state.vault=token;state.matches=data.matches.filter(validMatch).map(m=>({...m,dirty:false}));state.current=state.matches[0]?.id;if(!state.current)throw Error();persist();$('#connectCode').value='';closeDialogs();render();toast('보관함을 연결했습니다.');
 }catch{toast('연결하지 못했습니다. 코드와 네트워크를 확인해주세요.');}
};
window.addEventListener('online',sync);window.addEventListener('offline',()=>{syncMessage='● 오프라인 · 기기에 저장';persist();});
window.addEventListener('storage',e=>{if(e.key===KEY){hold.reset();try{state=JSON.parse(e.newValue)||state;render();}catch{}}});
if(!current()){const m=createMatch();state.matches.unshift(m);state.current=m.id;}
persist();render();active();sync();requestWake();
setInterval(()=>{const m=current();if(m&&!score(m).finished)$('#timer').textContent=elapsed(Date.now()-m.createdAt);},1000);
setInterval(()=>{if(!document.hidden)sync();},15000);
if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
