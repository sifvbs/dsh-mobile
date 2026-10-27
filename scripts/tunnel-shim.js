#!/usr/bin/env node
/**
 * DSH mobile — tunnel shim
 *
 * Sits between cloudflared and the DSH loopback listener.
 *
 *   cloudflared --url http://127.0.0.1:56998
 *        |
 *     this shim (rewrites headers)
 *        |
 *   DSH  127.0.0.1:56874
 *
 * Why a shim is needed
 * --------------------
 * @linxin666/dsh-remote-web-ui keeps `trustedHosts` in a config field that is
 * NOT marked volatile, and its `apply` is wrapped in `mountOnce`, so changing
 * cordis.patch.yml does not re-run applyImpl on an already-mounted plugin. The
 * in-memory trustedHosts therefore keeps the old hostname, and every fresh
 * quick-tunnel domain gets 403 from `/api/pair/status`.
 *
 * Rather than restarting DSH on every tunnel change, this shim makes the
 * incoming request look like a loopback request:
 *
 *   1. rewrite Host to 127.0.0.1:<target-port> — `isLoopbackClient()` requires
 *      both a loopback Host hostname and a loopback socket.remoteAddress, and
 *      this shim connects from 127.0.0.1, so both hold.
 *   2. drop Origin / Referer — `isTrustedApiRequest` compares Origin against
 *      Host when Origin is present; Host has just been rewritten, so keeping
 *      Origin would make them disagree. Absent Origin passes.
 *   3. rewrite loopback `Location` headers to the public https origin, otherwise
 *      the phone follows a redirect to http://127.0.0.1 and fails.
 *
 * Security note
 * -------------
 * Because everything now looks like loopback, the plugin's `loopbackFence`-
 * protected control endpoints would be reachable through the tunnel:
 *
 *   POST /api/pair/issue    mint a pairing token
 *   POST /api/pair/stop     stop the current pairing
 *   POST /api/pair/revoke   revoke any device
 *
 * Those are hard-blocked below (403) and must be called from the local machine.
 *
 * Usage:
 *   node tunnel-shim.js --listen-port 56998 --target-port 56874 \
 *                       --host-file ./public-host.txt
 *
 *   --listen-port   port to listen on                     (default 56998)
 *   --target-port   DSH port to forward to                (default 56874)
 *   --target-host   DSH host                              (default 127.0.0.1)
 *   --forward-host  value written into the Host header    (default 127.0.0.1:<target-port>)
 *   --host-file     file holding the current public host  (default ./public-host.txt)
 *   --public-host   fallback public host if the file is missing
 */
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};

const LISTEN_PORT = Number(argOf('listen-port', 56998));
const TARGET_PORT = Number(argOf('target-port', 56874));
const TARGET_HOST = argOf('target-host', '127.0.0.1');
const FORWARD_HOST = argOf('forward-host', `127.0.0.1:${TARGET_PORT}`);
const HOST_FILE = argOf('host-file', path.join(__dirname, 'public-host.txt'));
const FALLBACK_PUBLIC = argOf('public-host', '');

// re-read on every request so a new tunnel domain does not need a restart
const readPublic = () => {
  try {
    const t = fs.readFileSync(HOST_FILE, 'utf8').trim();
    if (t) return t;
  } catch {
    /* fall through */
  }
  return FALLBACK_PUBLIC;
};

const LOOPBACK_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?/i;

const rewriteHeaders = (headers, publicHost) => {
  const out = { ...headers };
  for (const k of Object.keys(out)) {
    const lower = k.toLowerCase();
    if (lower === 'origin' || lower === 'referer') delete out[k];
  }
  out.host = FORWARD_HOST;
  out['x-forwarded-proto'] = 'https';
  if (publicHost) out['x-forwarded-host'] = publicHost;
  if (!out['x-forwarded-for']) out['x-forwarded-for'] = '127.0.0.1';
  return out;
};

const fixLocation = (loc, publicHost) => {
  if (typeof loc !== 'string' || !publicHost) return loc;
  return loc.replace(LOOPBACK_RE, `https://${publicHost}`);
};

const LOOPBACK_ONLY = new Set(['/api/pair/issue', '/api/pair/stop', '/api/pair/revoke']);
const isLoopbackOnly = (req) => {
  const p = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/';
  return LOOPBACK_ONLY.has(p);
};

const server = http.createServer((req, res) => {
  if (isLoopbackOnly(req)) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
    res.end('{"ok":false,"code":"forbidden"}');
    return;
  }
  const publicHost = readPublic();
  const opts = {
    host: TARGET_HOST,
    port: TARGET_PORT,
    method: req.method,
    path: req.url,
    headers: rewriteHeaders(req.headers, publicHost),
  };
  const up = http.request(opts, (ur) => {
    const hdrs = { ...ur.headers };
    if (hdrs.location) {
      hdrs.location = Array.isArray(hdrs.location)
        ? hdrs.location.map((l) => fixLocation(l, publicHost))
        : fixLocation(hdrs.location, publicHost);
    }
    res.writeHead(ur.statusCode || 502, hdrs);
    ur.pipe(res);
  });
  up.on('error', (e) => {
    console.log(`[shim] upstream error: ${e.message}`);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`shim upstream error: ${e.message}`);
  });
  req.pipe(up);
});

// websocket / SSE upgrades
server.on('upgrade', (req, socket, head) => {
  const publicHost = readPublic();
  const up = net.connect(TARGET_PORT, TARGET_HOST, () => {
    const headers = rewriteHeaders(req.headers, publicHost);
    headers.connection = 'Upgrade';
    headers.upgrade = req.headers.upgrade || 'websocket';
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined) continue;
      raw += `${k}: ${v}\r\n`;
    }
    raw += '\r\n';
    up.write(raw);
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  const die = () => {
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
    try {
      up.destroy();
    } catch {
      /* ignore */
    }
  };
  up.on('error', die);
  socket.on('error', die);
});

server.on('error', (e) => {
  console.log(`[shim] listen failed: ${e.message}`);
  process.exit(1);
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(
    `[shim] http://127.0.0.1:${LISTEN_PORT} -> http://${TARGET_HOST}:${TARGET_PORT} ` +
      `(Host=${FORWARD_HOST}, public=${readPublic() || '(none)'})`,
  );
});
