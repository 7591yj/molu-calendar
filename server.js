import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, lstat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const files = {
  '/': ['index.html', 'text/html'],
  '/index.html': ['index.html', 'text/html'],
  '/styles.css': ['styles.css', 'text/css'],
  '/app.js': ['app.js', 'text/javascript'],
  '/calendar.js': ['calendar.js', 'text/javascript'],
  '/raid-banners.js': ['raid-banners.js', 'text/javascript'],
  '/banner-crop.js': ['banner-crop.js', 'text/javascript'],
  '/momotalk.js': ['momotalk.js', 'text/javascript'],
  '/chat-store.js': ['chat-store.js', 'text/javascript'],
  '/chat-transcript.js': ['chat-transcript.js', 'text/javascript'],
  '/chat-memory.js': ['chat-memory.js', 'text/javascript'],
  '/local-ai.js': ['local-ai.js', 'text/javascript'],
  '/persona.js': ['persona.js', 'text/javascript'],
  '/local-ai-settings.js': ['local-ai-settings.js', 'text/javascript'],
  '/local-ai-session.js': ['local-ai-session.js', 'text/javascript'],
  '/local-ai-worker.bundle.js': ['local-ai-worker.bundle.js', 'text/javascript'],
  '/local-ai-worker.bundle.js.LEGAL.txt': ['local-ai-worker.bundle.js.LEGAL.txt', 'text/plain'],
  '/schema.json': ['schema.json', 'application/json'],
  '/example.json': ['example.json', 'application/json'],
  '/character.bundle.js': ['character.bundle.js', 'text/javascript'],
  '/character.bundle.js.LEGAL.txt': ['character.bundle.js.LEGAL.txt', 'text/plain'],
};
// Exact files from the pinned npm package only; never expose node_modules or arbitrary paths.
for (const variant of ['', '_compat', '_asyncify', '_compat_asyncify']) {
  for (const extension of ['js', 'wasm']) {
    const name = `litertlm_wasm${variant}_internal.${extension}`;
    files[`/vendor/litert-lm/0.17.1/${name}`] = [`node_modules/@litert-lm/core/wasm/${name}`, extension === 'wasm' ? 'application/wasm' : 'text/javascript'];
  }
}
for (const name of ['GawrGura.pmx', 'body.png', 'ex.png', 'face.png', 'hair.png', 'nhair.png', 'weapon.png']) {
  files[`/models/gura/${name}`] = [`GawrGura/${name}`, name.endsWith('.png') ? 'image/png' : 'application/octet-stream'];
}
// 일정의 실제 배너 파일만 제공한다. 테스트용 대체 배너는 사용하지 않는다.
const bannerDir = 'resource/event_banner_img';
const bannerTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
if (existsSync(bannerDir)) {
  for (const name of readdirSync(bannerDir)) {
    const type = bannerTypes[name.slice(name.lastIndexOf('.'))];
    if (type) files[`/resource/event_banner_img/${name}`] = [`${bannerDir}/${name}`, type];
  }
}
for (const name of ['gyeonggi-title-light-subset.woff2', 'gyeonggi-title-medium-subset.woff2', 'gyeonggi-title-bold-subset.woff2']) {
  files[`/resource/fonts/${name}`] = [`resource/fonts/${name}`, 'font/woff2'];
}
const momoDir = 'resource/momotalk';
if (existsSync(momoDir)) {
  for (const name of readdirSync(momoDir).filter(name => /\.(?:webp|png)$/.test(name))) {
    files[`/resource/momotalk/${name}`] = [`resource/momotalk/${name}`, name.endsWith('.png') ? 'image/png' : 'image/webp'];
  }
}
files['/resource/momotalk/students.json'] = ['resource/momotalk/students.json', 'application/json'];
// 블루 아카이브 실제 운영 일정, tools/vendor_events.py가 벤더링한다.
files['/resource/events.json'] = ['resource/events.json', 'application/json'];
// 페르소나 데이터셋. persona.js가 import attributes로 직접 읽는다.
files['/resource/persona/characters.json'] = ['resource/persona/characters.json', 'application/json'];
// MomoTalk app chrome (backdrop, notification sound), vendored by tools/vendor_momotalk.py.
const momoUiDir = 'resource/momotalk/ui';
const momoUiTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.wav': 'audio/wav', '.ogg': 'audio/ogg' };
if (existsSync(momoUiDir)) {
  for (const name of readdirSync(momoUiDir)) {
    const type = momoUiTypes[name.slice(name.lastIndexOf('.'))];
    if (type) files[`/resource/momotalk/ui/${name}`] = [`resource/momotalk/ui/${name}`, type];
  }
}

export function makeServer() {
  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://api.country.is https://huggingface.co https://*.huggingface.co https://*.hf.co https://raw.githubusercontent.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      return response.end('Method not allowed');
    }
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
    catch { response.writeHead(400); return response.end('Bad request'); }
    // 배너는 요청 시 확인한다. 시작 후 추가된 파일도 재시작 없이 제공한다.
    const banner = pathname.match(/^\/resource\/event_banner_img\/([A-Za-z0-9_-]+\.(?:png|jpe?g|webp))$/);
    const entry = banner ? [`${bannerDir}/${banner[1]}`, bannerTypes[banner[1].slice(banner[1].lastIndexOf('.'))]]
      : pathname.startsWith(`/${bannerDir}/`) ? null : Object.hasOwn(files, pathname) ? files[pathname] : null;
    if (!entry) { response.writeHead(404); return response.end('Not found'); }
    try {
      const file = new URL(entry[0], import.meta.url);
      // lstat는 각 디렉터리도 검사한다(끝에 /를 붙이면 심볼릭 링크를 따라간다).
      if (banner && (!(await lstat(new URL('resource', import.meta.url))).isDirectory()
        || !(await lstat(new URL(bannerDir, import.meta.url))).isDirectory()
        || !(await lstat(file)).isFile())) {
        response.writeHead(404);
        return response.end('Not found');
      }
      const body = await readFile(file);
      response.writeHead(200, { 'Content-Type': `${entry[1]}; charset=utf-8`, 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      const missing = banner && ['ENOENT', 'ENOTDIR'].includes(error.code);
      response.writeHead(missing ? 404 : 500);
      response.end(missing ? 'Not found' : 'Unable to read page');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 5173);
  const host = process.env.HOST ?? '127.0.0.1';
  const server = makeServer();
  server.on('error', error => { console.error(`서버 실행 실패: ${error.message}`); process.exitCode = 1; });
  server.listen(port, host, () => console.log(`MOLU calendar → http://${host}:${port}`));
}
