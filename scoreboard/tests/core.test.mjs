import test from 'node:test';import assert from 'node:assert/strict';import {createMatch,addEvent,score,undoPoint,HoldInput,validMatch} from '../public/core.js';import worker,{ScoreVault} from '../worker.js';
function p(m,t,n=1){for(let i=0;i<n;i++)addEvent(m,'point',{team:t});}
test('21-point deuce, cap and undo restore server and result',()=>{const m=createMatch();p(m,0,20);p(m,1,20);assert.equal(score(m).gameOver,false);p(m,0);assert.equal(score(m).gameOver,false);p(m,0);assert.equal(score(m).finished,true);undoPoint(m);assert.deepEqual(score(m).points,[21,20]);assert.equal(score(m).finished,false);undoPoint(m,0);assert.deepEqual(score(m).points,[20,20]);assert.equal(score(m).server,1);
 const c=createMatch();for(let i=0;i<29;i++){p(c,0);p(c,1);}p(c,0);assert.deepEqual(score(c).points,[30,29]);assert.equal(score(c).finished,true);});
test('best of three, side swap and current-game undo boundary',()=>{const m=createMatch({target:3,cap:5,bestOf:3});p(m,0,3);addEvent(m,'next');addEvent(m,'swap');assert.equal(undoPoint(m),false);p(m,1,3);addEvent(m,'next');p(m,0,3);const s=score(m);assert.deepEqual(s.wins,[2,1]);assert.equal(s.finished,true);assert.equal(s.swapped,true);assert.equal(s.games.length,2);});
test('tap reduction removes specified team point, retaining audit log',()=>{const m=createMatch();p(m,0);p(m,1);p(m,0);assert.equal(undoPoint(m,1),true);assert.deepEqual(score(m).points,[2,0]);assert.equal(m.events.length,4);assert.equal(undoPoint(m,1),false);});
test('remote single, double, held repeats, tap-then-hold and cancellation',async()=>{
 const actions=[],wait=ms=>new Promise(r=>setTimeout(r,ms));
 const h=new HoldInput({threshold:25,doubleWindow:20,onShort:()=>actions.push('our'),onDouble:()=>actions.push('opponent'),onLong:()=>actions.push('undo')});
 h.down();h.up();assert.deepEqual(actions,[]);await wait(35);assert.deepEqual(actions,['our']);
 h.down();h.up();h.down();h.up();await wait(35);assert.deepEqual(actions,['our','opponent']);
 h.down();h.down(true);h.down(false);await wait(40);h.down(true);h.up();await wait(35);assert.deepEqual(actions,['our','opponent','undo']);
 h.down();h.up();h.down();await wait(40);h.up();await wait(35);assert.deepEqual(actions,['our','opponent','undo','undo']);
 h.down();h.up();h.reset();await wait(35);h.down();h.reset();h.up();await wait(40);assert.equal(actions.length,4);
 h.down(true);h.up();await wait(35);assert.equal(actions.length,4);
 h.down();h.up();await wait(35);h.down();h.up();await wait(35);assert.deepEqual(actions.slice(-2),['our','our']);
});
test('validation handles malformed input',()=>{assert.ok(validMatch(createMatch()));assert.ok(!validMatch({}));assert.ok(!validMatch({...createMatch(),events:[null]}));});
class Storage{constructor(){this.map=new Map();}async list(){return this.map;}async get(k){return this.map.get(k);}async put(k,v){this.map.set(k,structuredClone(v));}async transaction(fn){return fn(this);}}
test('cloud roundtrip, idempotent retry and stale revision conflict',async()=>{const vault=new ScoreVault({storage:new Storage()}),m=createMatch();p(m,0);const put=async(m,revision)=>vault.fetch(new Request('https://example.com/api/matches/'+m.id,{method:'PUT',body:JSON.stringify({match:m,revision})}));assert.equal((await put(m,0)).status,200);assert.equal((await put(m,0)).status,200);p(m,1);assert.equal((await put(m,0)).status,409);assert.equal((await put(m,1)).status,200);const out=await(await vault.fetch(new Request('https://example.com/api/matches'))).json();assert.equal(out.matches[0].rev,2);assert.deepEqual(score(out.matches[0]).points,[1,1]);});
test('API requires vault credential and denies foreign origin',async()=>{assert.equal((await worker.fetch(new Request('https://example.com/api/matches'),{})).status,401);assert.equal((await worker.fetch(new Request('https://example.com/api/matches',{headers:{Origin:'https://other.example'}}),{})).status,403);});
