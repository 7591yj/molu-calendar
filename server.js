import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const files = {
  '/': ['index.html', 'text/html'],
  '/index.html': ['index.html', 'text/html'],
  '/styles.css': ['styles.css', 'text/css'],
  '/app.js': ['app.js', 'text/javascript'],
  '/calendar.js': ['calendar.js', 'text/javascript'],
  '/schema.json': ['schema.json', 'application/json'],
  '/example.json': ['example.json', 'application/json'],
  '/character.bundle.js': ['character.bundle.js', 'text/javascript'],
  '/character.bundle.js.LEGAL.txt': ['character.bundle.js.LEGAL.txt', 'text/plain'],
};
for (const name of ['GawrGura.pmx', 'body.png', 'ex.png', 'face.png', 'hair.png', 'nhair.png', 'weapon.png']) {
  files[`/models/gura/${name}`] = [`GawrGura/${name}`, name.endsWith('.png') ? 'image/png' : 'application/octet-stream'];
}
for (const name of ['images.jpg', 'i1mages.jpg', '1231123.jpg']) {
  files[`/resource/event_banner_img/${name}`] = [`resource/event_banner_img/${name}`, 'image/jpeg'];
}

export function makeServer() {
  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      return response.end('Method not allowed');
    }
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
    catch { response.writeHead(400); return response.end('Bad request'); }
    const entry = Object.hasOwn(files, pathname) ? files[pathname] : null;
    if (!entry) { response.writeHead(404); return response.end('Not found'); }
    try {
      const body = await readFile(new URL(entry[0], import.meta.url));
      response.writeHead(200, { 'Content-Type': `${entry[1]}; charset=utf-8`, 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      response.writeHead(500);
      response.end('Unable to read page');
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
