// cebian-gateway front proxy — one public port, two backends.
//
// Koyeb's free plan only keeps a single exposed port on the service, so the
// router cannot get its own route. This front process owns port 8000 (the port
// Koyeb already exposes) and splits traffic:
//
//   /router/*  -> 127.0.0.1:20130  (9router-go, prefix stripped)
//   /*         -> 127.0.0.1:8001   (cebian-gateway, Telegram relay + /ws)
//
// The gateway is moved to 8001 so this proxy can own 8000. The prefix strip
// matters: 9router-go serves /v1/... and /health at its root, not under
// /router, so `/router/v1/models` must arrive as `/v1/models`.
//
// WebSocket upgrades (the gateway's /ws) are tunnelled too, since the same
// socket has to work for both plain HTTP and upgrade requests.

import http from 'node:http';

const LISTEN_PORT = Number(process.env.PORT || 8000);
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT || 8001);
const ROUTER_PORT = Number(process.env.ROUTER_PORT || 20130);
const ROUTER_PREFIX = '/router';

/** Pick the backend for a request path. Router wins on an exact prefix match
 *  on a path boundary, so `/routerfoo` still goes to the gateway. */
function pickBackend(pathname) {
  if (pathname === ROUTER_PREFIX || pathname.startsWith(ROUTER_PREFIX + '/')) {
    return { port: ROUTER_PORT, strip: ROUTER_PREFIX };
  }
  return { port: GATEWAY_PORT, strip: '' };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const { port, strip } = pickBackend(url.pathname);

  // Rewrite only the path; keep the query string untouched.
  const targetPath = strip ? url.pathname.slice(strip.length) || '/' : url.pathname;

  const headers = { ...req.headers, host: `127.0.0.1:${port}` };
  if (strip) headers['x-forwarded-prefix'] = strip;

  const upstream = http.request(
    { host: '127.0.0.1', port, method: req.method, path: targetPath + url.search, headers },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    // The router may still be booting; report it instead of hanging the socket.
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream unreachable', port, detail: String(err) }));
  });

  req.pipe(upstream);
});

// WebSocket / upgrade tunnelling — same backend choice, raw socket splice.
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const { port, strip } = pickBackend(url.pathname);
  const targetPath = strip ? url.pathname.slice(strip.length) || '/' : url.pathname;

  const upstream = http.request({
    host: '127.0.0.1',
    port,
    method: req.method,
    path: targetPath + url.search,
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
    `[proxy] listening on 0.0.0.0:${LISTEN_PORT} | ${ROUTER_PREFIX}/* -> :${ROUTER_PORT} | /* -> :${GATEWAY_PORT}`,
  );
});
