export const defaults={names:['우리 팀','상대 팀'],target:21,cap:30,deuce:true,bestOf:1,first:0};
export function createMatch(settings={}) { return {id:crypto.randomUUID(),createdAt:Date.now(),settings:{...defaults,...settings},events:[],rev:0,dirty:true}; }
export function activePoints(match) {const undone=new Set(match.events.filter(e=>e.type==='undo').map(e=>e.target));return match.events.filter(e=>e.type==='point'&&!undone.has(e.id));}
export function score(match) {
 const undone=new Set(match.events.filter(e=>e.type==='undo').map(e=>e.target));
 let points=[0,0],wins=[0,0],games=[],server=match.settings.first,gameOver=false,finished=false,swapped=false;
 const target=match.settings.target,cap=match.settings.cap;
 for(const e of match.events){
  if(e.type==='swap'){swapped=!swapped;continue;}
  if(e.type==='next'&&gameOver&&!finished){games.push([...points]);points=[0,0];gameOver=false;continue;}
  if(e.type==='point'&&!undone.has(e.id)&&!gameOver&&!finished){
   points[e.team]++;server=e.team;
   if(points[e.team]>=target&&(!match.settings.deuce||points[e.team]-points[1-e.team]>=2||points[e.team]>=cap)){
    gameOver=true;wins[e.team]++;finished=wins[e.team]>=Math.ceil(match.settings.bestOf/2);
   }
  }
  if(e.type==='finish')finished=true;
 }
 return {points,wins,games,server,gameOver,finished,swapped,game:games.length+1};
}
export function addEvent(match,type,data={}) {const e={id:crypto.randomUUID(),type,at:Date.now(),...data};match.events.push(e);match.dirty=true;return e;}
export function undoPoint(match,team) {
 // Only current game's points can be corrected; opening a next game is a deliberate boundary.
 const boundary=match.events.findLastIndex(e=>e.type==='next');
 const undone=new Set(match.events.filter(e=>e.type==='undo').map(e=>e.target));
 const e=match.events.slice(boundary+1).findLast(e=>e.type==='point'&&!undone.has(e.id)&&(team===undefined||e.team===team));
 if(!e)return false; addEvent(match,'undo',{target:e.id,team:e.team});return true;
}
export class HoldInput {
 constructor({threshold=700,onShort,onLong,onProgress=()=>{}}){Object.assign(this,{threshold,onShort,onLong,onProgress});this.reset();}
 down(repeat=false){if(this.pressed||repeat)return;this.pressed=true;this.long=false;this.started=Date.now();this.onProgress(true);this.timer=setTimeout(()=>{if(this.pressed){this.long=true;this.onLong();this.onProgress(false);}},this.threshold);}
 up(){if(!this.pressed)return;clearTimeout(this.timer);const short=!this.long;this.pressed=false;this.onProgress(false);if(short)this.onShort();}
 reset(){clearTimeout(this.timer);this.pressed=false;this.long=false;this.onProgress?.(false);}
}
export function validMatch(m){
 return m&&typeof m.id==='string'&&/^[a-f0-9-]{36}$/.test(m.id)&&Number.isFinite(m.createdAt)&&
 m.settings&&Array.isArray(m.settings.names)&&m.settings.names.length===2&&m.settings.names.every(n=>typeof n==='string'&&n.length<=30)&&
 Number.isInteger(m.settings.target)&&m.settings.target>=1&&m.settings.target<=99&&Number.isInteger(m.settings.cap)&&m.settings.cap>=m.settings.target&&m.settings.cap<=199&&
 [1,3,5].includes(m.settings.bestOf)&&[0,1].includes(m.settings.first)&&typeof m.settings.deuce==='boolean'&&
 Array.isArray(m.events)&&m.events.length<=3000&&m.events.every(e=>e && typeof e.id==='string'&&e.id.length<=60&&Number.isFinite(e.at)&&
 ['point','undo','swap','next','finish'].includes(e.type)&&(!(e.type==='point')||[0,1].includes(e.team))&&(!(e.type==='undo')||typeof e.target==='string'));
}
