// @ts-check
const MAX_REQUEST = 90 * 1024 * 1024;

/** @param {string} detail @param {number} status */
function failure(detail, status) {
  return Response.json({detail}, {status, headers: {'Cache-Control': 'no-store'}});
}

/** @type {ExportedHandler<Env>} */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/ws/')) {
      return env.ASSETS.fetch(request);
    }
    if (url.pathname === '/api/deployment') {
      return Response.json({max_upload_bytes: MAX_REQUEST - 1024 * 1024, hosting: 'cloudflare'},
        {headers: {'Cache-Control': 'no-store'}});
    }
    const origin = request.headers.get('Origin');
    const socket = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
    if ((origin && origin !== url.origin) || (socket && !origin)) {
      return failure('다른 사이트에서의 연결 요청은 허용하지 않습니다.', 403);
    }
    if (Number(request.headers.get('Content-Length') || 0) > MAX_REQUEST) {
      return failure('외부 연결에서는 89 MB 이하의 영상을 선택하세요.', 413);
    }
    let backend;
    try {
      backend = new URL(env.BACKEND_URL);
      if (backend.protocol !== 'https:' || backend.username || backend.password || backend.pathname !== '/') throw new Error();
    } catch {
      return failure('PC 연결 주소가 아직 설정되지 않았습니다.', 503);
    }
    // Keep the destination fixed; never accept a target host from user input.
    backend.pathname = url.pathname;
    backend.search = url.search;
    const headers = new Headers(request.headers);
    headers.set('Host', backend.host);
    if (origin) headers.set('Origin', backend.origin);
    headers.delete('Forwarded');
    headers.delete('X-Forwarded-Host');
    headers.delete('X-Forwarded-For');
    headers.set('X-Forwarded-Proto', 'https');
    try {
      const response = await fetch(new Request(backend, {
        method: request.method, headers, body: request.body, redirect: 'manual',
      }));
      // Return upgraded responses untouched so Cloudflare relays the WebSocket.
      if (response.status === 101) return response;
      if (response.status >= 500) {
        await response.body?.cancel();
        return failure('PC 분석 서버에 연결할 수 없습니다. PC와 Tunnel 실행 상태를 확인하세요.', 503);
      }
      const result = new Response(response.body, response);
      result.headers.set('Cache-Control', 'no-store');
      const cookie = result.headers.get('Set-Cookie');
      if (cookie && !/;\s*secure(?:;|$)/i.test(cookie)) result.headers.set('Set-Cookie', `${cookie}; Secure`);
      return result;
    } catch {
      return failure('PC 분석 서버 연결이 끊겼습니다. 잠시 후 다시 시도하세요.', 503);
    }
  },
};
