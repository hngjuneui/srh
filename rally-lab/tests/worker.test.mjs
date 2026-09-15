import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../cloudflare/worker.js';

const env = {BACKEND_URL:'https://pc.example.com', ASSETS:{fetch:async()=>new Response('app')}};
test('static assets do not require a running PC', async()=>{
  assert.equal(await (await worker.fetch(new Request('https://app.example.com/'), env)).text(),'app');
});
test('deployment advertises the public upload limit', async()=>{
  const response=await worker.fetch(new Request('https://app.example.com/api/deployment'),env);
  assert.equal((await response.json()).max_upload_bytes,89*1024*1024);
});
test('reject foreign origins and websocket without origin', async()=>{
  for(const headers of [{Origin:'https://evil.example.com'},{Upgrade:'websocket'}]) {
    const response=await worker.fetch(new Request('https://app.example.com/ws/test',{headers}),env);
    assert.equal(response.status,403);
  }
});
test('reject oversized uploads before contacting PC', async()=>{
  const response=await worker.fetch(new Request('https://app.example.com/api/videos',{headers:{'Content-Length':String(100*1024*1024)}}),env);
  assert.equal(response.status,413);
});
test('missing or insecure PC origin fails closed', async()=>{
  for(const BACKEND_URL of ['', 'http://pc.example.com', 'https://pc.example.com/path']){
    assert.equal((await worker.fetch(new Request('https://app.example.com/api/health'),{...env,BACKEND_URL})).status,503);
  }
});
test('proxy preserves cookies/ranges, fixes origin, disables caching and streams', async(t)=>{
  t.mock.method(globalThis,'fetch',async request=>{
    assert.equal(request.url,'https://pc.example.com/api/videos/test?download=1');
    assert.equal(request.headers.get('Origin'),'https://pc.example.com');
    assert.equal(request.headers.get('Cookie'),'rally_auth=test');
    assert.equal(request.headers.get('Range'),'bytes=0-99');
    assert.equal(request.headers.get('X-Forwarded-For'),null);
    return new Response('video',{status:206,headers:{'Set-Cookie':'rally_auth=test; HttpOnly; SameSite=Strict'}});
  });
  const response=await worker.fetch(new Request('https://app.example.com/api/videos/test?download=1',{
    headers:{Origin:'https://app.example.com',Cookie:'rally_auth=test',Range:'bytes=0-99','X-Forwarded-For':'spoofed'},
  }),env);
  assert.equal(response.status,206);
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.match(response.headers.get('Set-Cookie'),/; Secure$/);
  assert.equal(await response.text(),'video');
});
test('offline PC returns actionable error, not internal origin details', async(t)=>{
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('private network error');});
  const response=await worker.fetch(new Request('https://app.example.com/api/health'),env);
  assert.equal(response.status,503);
  assert.doesNotMatch(await response.text(),/private network/);
});
