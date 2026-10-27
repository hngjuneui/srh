import { validMatch } from './public/core.js';
const headers={'Cache-Control':'no-store','Content-Type':'application/json','X-Content-Type-Options':'nosniff'};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers});
export class ScoreVault{
 constructor(ctx){this.ctx=ctx;}
 async fetch(request){
  const url=new URL(request.url);
  if(request.method==='GET'){
   const rows=await this.ctx.storage.list({prefix:'match:'});
   return json({matches:[...rows.values()].sort((a,b)=>b.createdAt-a.createdAt)});
  }
  if(request.method!=='PUT')return json({error:'Method not allowed'},405);
  let payload;try{const body=await request.text();if(body.length>100000)return json({error:'기록 용량 초과'},413);payload=JSON.parse(body);}catch{return json({error:'잘못된 요청'},400);}
  const {match,revision}=payload;
  if(!validMatch(match)||!Number.isInteger(revision)||revision<0||url.pathname!=='/api/matches/'+match.id)return json({error:'기록 형식 오류'},400);
  return this.ctx.storage.transaction(async txn=>{
   const key='match:'+match.id,old=await txn.get(key);
   // Retry after a lost response is safe.
   const clean={id:match.id,createdAt:match.createdAt,settings:match.settings,events:match.events};
   if(old&&JSON.stringify({...old,rev:undefined})===JSON.stringify(clean))return json({rev:old.rev});
   if((old?.rev||0)!==revision)return json({error:'다른 기기의 변경이 있습니다.',remote:old},409);
   const saved={...clean,rev:revision+1};await txn.put(key,saved);return json({rev:saved.rev});
  });
 }
}
export default {async fetch(request,env){
 const url=new URL(request.url);
 if(url.pathname==='/api/health')return json({ok:true,service:'rally-scoreboard',version:1});
 if(url.pathname.startsWith('/api/')){
  if(!/^\/api\/matches(?:\/[a-f0-9-]{36})?$/.test(url.pathname))return json({error:'Not found'},404);
  if(request.headers.get('Origin')&&request.headers.get('Origin')!==url.origin)return json({error:'Origin denied'},403);
  const token=(request.headers.get('Authorization')||'').replace(/^Bearer /,'');
  if(!/^[a-f0-9]{64}$/.test(token))return json({error:'보관함 연결 코드를 확인하세요.'},401);
  if(Number(request.headers.get('Content-Length'))>100000)return json({error:'요청 용량 초과'},413);
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
  const name=Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('');
  return env.VAULTS.get(env.VAULTS.idFromName(name)).fetch(request);
 }
 const res=await env.ASSETS.fetch(request);
 const out=new Response(res.body,res);
 out.headers.set('X-Content-Type-Options','nosniff');
 out.headers.set('Referrer-Policy','no-referrer');
 out.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
 return out;
}};
