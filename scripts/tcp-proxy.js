#!/usr/bin/env node
/**
 * DSH mobile - TCP forwarder
 *
 * Why this exists: the DSH webserver refuses to bind a wildcard address
 * (0.0.0.0). The desktop host therefore listens on 127.0.0.1 only, and a phone
 * on the LAN can never reach it.
 *
 * This is a plain user-space byte forwarder: it listens on one concrete local
 * interface and pipes bytes to the loopback listener, WITHOUT touching any HTTP
 * header. That matters: @linxin666/dsh-remote-web-ui's trust fence compares the
 * Host header against trustedHosts, so the Host must arrive unmodified.
 *
 * Usage:
 *   node scripts/tcp-proxy.js --listen 192.168.1.10 --port 56875 --target 127.0.0.1:55129
 *
 *   --listen              local address to bind (default 127.0.0.1; use your real
 *                         LAN or Tailscale address - NOT 0.0.0.0 unless you accept
 *                         the exposure)
 *   --port                port to listen on                    (default 56875)
 *   --target              host:port to forward to              (default 127.0.0.1:55129)
 *   --max-connections     concurrent connection cap            (default 256)
 *   --connect-timeout-ms  upstream connect timeout             (default 10000)
 *   --idle-timeout-ms     per-socket idle timeout, 0 = off     (default 300000)
 *   --health-port         loopback-only HTTP health port, 0 = off (default 56876)
 *   --verbose             1 = log every connection
 *
 * Health endpoint (loopback only - never exposed on the LAN interface):
 *   GET http://127.0.0.1:<health-port>/health
 *   {"ok":true,"listen":"192.168.1.10:56875","target":"127.0.0.1:55129",
 *    "live":1,"peak":3,"admitted":12,"rejected":0,"bytesUp":1234,"bytesDown":5678,
 *    "uptimeSecs":3600,"maxConnections":256}
 */
const net = require('node:net');
const http = require('node:http');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const listenHost = arg('listen', '127.0.0.1');
const listenPort = Number(arg('port', '56875'));
const target = arg('target', '127.0.0.1:55129');
const maxConnections = Number(arg('max-connections', '256'));
const connectTimeoutMs = Number(arg('connect-timeout-ms', '10000'));
const idleTimeoutMs = Number(arg('idle-timeout-ms', '300000'));
const healthPort = Number(arg('health-port', '56876'));
const verbose = arg('verbose', '0') === '1';

const sep = target.lastIndexOf(':');
if (sep < 1) {
  console.error(`[proxy] --target must be host:port, got "${target}"`);
  process.exit(1);
}
const targetHost = target.slice(0, sep);
const targetPort = Number(target.slice(sep + 1));
if (!Number.isFinite(targetPort) || targetPort <= 0) {
  console.error(`[proxy] --target port is not a number: "${target}"`);
  process.exit(1);
}

const startedAt = Date.now();
const stats = { live: 0, peak: 0, admitted: 0, rejected: 0, bytesUp: 0, bytesDown: 0 };

const log = (msg) => console.log(`[proxy] ${new Date().toISOString().slice(11, 19)} ${msg}`);

const server = net.createServer((client) => {
  if (stats.live >= maxConnections) {
    stats.rejected += 1;
    log(`reject live=${stats.live} >= max=${maxConnections}`);
    client.destroy();
    return;
  }

  stats.live += 1;
  stats.admitted += 1;
  if (stats.live > stats.peak) stats.peak = stats.live;

  const peer = `${client.remoteAddress}:${client.remotePort}`;
  if (verbose) log(`open  ${peer} (live=${stats.live})`);

  const upstream = net.connect({ host: targetHost, port: targetPort });
  let closed = false;

  const teardown = (reason) => {
    if (closed) return;
    closed = true;
    client.destroy();
    upstream.destroy();
    if (verbose) log(`close ${peer} ${reason} (live=${stats.live})`);
  };

  upstream.setTimeout(connectTimeoutMs, () => teardown('connect-timeout'));
  upstream.once('connect', () => {
    upstream.setTimeout(idleTimeoutMs > 0 ? idleTimeoutMs : 0);
  });

  client.on('error', () => teardown('client-error'));
  client.on('timeout', () => teardown('client-idle'));
  upstream.on('error', () => teardown('upstream-error'));
  upstream.on('timeout', () => teardown('upstream-idle'));

  client.on('close', () => {
    if (stats.live > 0) stats.live -= 1;
    upstream.end();
    if (!closed) {
      closed = true;
      if (verbose) log(`close ${peer} client-closed (live=${stats.live})`);
    }
  });
  upstream.on('close', () => {
    client.end();
  });

  client.on('data', (chunk) => {
    stats.bytesUp += chunk.length;
  });
  upstream.on('data', (chunk) => {
    stats.bytesDown += chunk.length;
  });

  client.pipe(upstream);
  upstream.pipe(client);
  client.setNoDelay(true);
  upstream.setNoDelay(true);
});

server.on('error', (error) => {
  console.error(`[proxy] listen failed: ${error.message}`);
  process.exit(1);
});

server.listen(listenPort, listenHost, () => {
  log(`http://${listenHost}:${listenPort}  ->  http://${targetHost}:${targetPort}`);
  log(`max-connections=${maxConnections} idle=${idleTimeoutMs}ms health-port=${healthPort || 'off'}`);

  if (healthPort > 0) {
    const health = http.createServer((req, res) => {
      const path = String(req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
      if (path !== '/health' && path !== '/') {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end('{"ok":false,"code":"not-found"}');
        return;
      }
      const body = JSON.stringify({
        ok: true,
        listen: `${listenHost}:${listenPort}`,
        target: `${targetHost}:${targetPort}`,
        live: stats.live,
        peak: stats.peak,
        admitted: stats.admitted,
        rejected: stats.rejected,
        bytesUp: stats.bytesUp,
        bytesDown: stats.bytesDown,
        uptimeSecs: Math.floor((Date.now() - startedAt) / 1000),
        maxConnections,
      });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      res.end(body);
    });
    health.on('error', (error) => log(`health listen failed (ignored): ${error.message}`));
    // loopback only on purpose: the LAN side must never see this
    health.listen(healthPort, '127.0.0.1', () => {
      log(`health http://127.0.0.1:${healthPort}/health`);
    });
  }
});

const shutdown = () => {
  log(
    `shutting down (live=${stats.live} admitted=${stats.admitted} rejected=${stats.rejected} up=${stats.bytesUp}B down=${stats.bytesDown}B)`,
  );
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
