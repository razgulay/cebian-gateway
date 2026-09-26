// cebian-gateway front proxy — one public port, two backends.
//
// Koyeb's free plan keeps only a single exposed port, so the router cannot get
// its own route. This front process owns port 8000 and splits by exact path.
//
// Why the router keeps ROOT: 9router-go's dashboard is a SPA with hardcoded
// absolute asset paths (`/assets/...`, `/api/...`). Mounting it under a prefix
// makes the browser request `/assets/index-*.js` from the edge, which lands on
// the wrong backend -> 404 -> blank page. So the SPA owns `/`.
//
// Why the gateway does NOT need a prefix: it only ever serves three fixed
// paths — /health, /webhook/telegram (POST), /ws (upgrade). Nothing else, no
// assets. So we route those three exactly and leave the rest to the router.
// That keeps the Telegram webhook URL and the extension's WS URL unchanged.
//
//   /health | /webhook/telegram | /ws  -> gateway :8001
//   everything else                    -> router  :20130 (dashboard, /v1, /api)

import http from 'node:http';

const LISTEN_PORT = Number(process.env.PORT || 8000);
const ROUTER_PORT = Number(process.env.ROUTER_PORT || 20130);
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT || 8001);

// Exact paths the Telegram gateway owns. Keep in sync with server.js.
const GATEWAY_PATHS = new Set(['/health', '/webhook/telegram', '/ws']);

/** Gateway wins on an exact path match; everything else goes to the router. */
function pickBackend(pathname) {
  return GATEWAY_PATHS.has(pathname)
    ? { port: GATEWAY_PORT }
    : { port: ROUTER_PORT };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const { port } = pickBackend(url.pathname);

  const upstream = http.request(
    {
      host: '127.0.0.1',
      port,
      method: req.method,
      path: url.pathname + url.search,
      headers: { ...req.headers, host: `127.0.0.1:${port}` },
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    // A backend may still be booting; report it instead of hanging the socket.
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream unreachable', port, detail: String(err) }));
  });

  req.pipe(upstream);
});

// WebSocket / upgrade tunnelling — /ws belongs to the gateway, so raw splice.
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const { port } = pickBackend(url.pathname);

  const upstream = http.request({
    host: '127.0.0.1',
    port,
    method: req.method,
    path: url.pathname + url.search,
    headers: { ...req.headers, host: `127.0.0.1:${port}` },
  });

  upstream.on('upgrade', (up, upSocket, upHead) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
        Object.entries(up.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n') +
        '\r\n\r\n',
    );
    if (upHead && upHead.length) socket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });

  upstream.on('error', () => socket.destroy());
  upstream.end();
});

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(
    `[proxy] listening on 0.0.0.0:${LISTEN_PORT} | /health,/webhook/telegram,/ws -> gateway :${GATEWAY_PORT} | /* -> router :${ROUTER_PORT}`,
  );
});
