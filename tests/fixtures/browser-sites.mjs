import { createServer } from 'node:http';

// Separate loopback hostnames exercise real browser navigation without app logins.
export async function startFixtureSites() {
  const server = createServer((request, response) => {
    const { port } = server.address();
    const base = `http://app.localhost:${port}`;
    const outside = `http://outside.localhost:${port}`;
    const auth = `http://auth.localhost:${port}`;
    const url = new URL(request.url, `http://${request.headers.host}`);
    response.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/needs-auth') {
      response.writeHead(302, { Location: `${auth}/login` });
      response.end();
      return;
    }
    if (url.pathname === '/redirect-home') {
      response.writeHead(302, { Location: `${base}/app/redirected` });
      response.end();
      return;
    }
    const escaped = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Essentials fixture</title></head>
<body>
  <h1>${escaped(url.hostname + url.pathname)}</h1>
  <p>Local browser verification fixture. No external requests or authentication.</p>
  <a id="same-domain" href="${base}/app/detail?id=7#thread">Open in-app detail</a>
  <a id="outside-domain" href="${outside}/outside">Leave app</a>
  <a id="new-link" href="${outside}/child" target="_blank">Open a new working tab</a>
  <a id="login" href="${base}/needs-auth">Sign in</a>
  <a id="return-home" href="${base}/app/returned">Return to app</a>
  <button id="spa" onclick="history.pushState({}, '', '/app/spa?item=42#detail')">Navigate SPA</button>
  <button id="hash" onclick="location.hash = 'thread-99'">Navigate hash</button>
  <label>Unsaved note <input id="note"></label>
</body></html>`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    app: `http://app.localhost:${port}`,
    outside: `http://outside.localhost:${port}`,
    auth: `http://auth.localhost:${port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
