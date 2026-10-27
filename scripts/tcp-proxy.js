#!/usr/bin/env node
/**
 * DSH mobile — TCP forwarder
 *
 * Why this exists: the DSH webserver refuses to bind a wildcard address
 * (0.0.0.0) — `Config` in @deepseek-ai/dsh-host-webserver rejects it outright
 * with "binding every interface would expose remote code execution to the
 * network". The desktop host therefore listens on 127.0.0.1 only, and a phone
 * on the LAN can never reach it.
 *
 * This is a plain user-space byte forwarder: it listens on one concrete local
 * interface and pipes bytes to the loopback listener, WITHOUT touching any HTTP
 * header. That matters: @linxin666/dsh-remote-web-ui's trust fence compares the
 * Host header against trustedHosts, so the Host must arrive unmodified.
 *
 * Usage:
 *   node tcp-proxy.js --listen 192.168.1.10 --port 56875 --target 127.0.0.1:3080
 *
 *   --listen   local address to bind (default 127.0.0.1; use your real LAN or
 *              Tailscale address — NOT 0.0.0.0 unless you accept the exposure)
 *   --port     port to listen on                     (default 56875)
 *   --target   host:port to forward to               (default 127.0.0.1:3080)
 */
const net = require('node:net');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const listenHost = arg('listen', '127.0.0.1');
const listenPort = Number(arg('port', '56875'));
const target = arg('target', '127.0.0.1:3080');
const sep = target.lastIndexOf(':');
if (sep < 1) {
  console.error(`[proxy] --target must be host:port, got "${target}"`);
  process.exit(1);
}
const targetHost = target.slice(0, sep);
const targetPort = Number(target.slice(sep + 1));

let live = 0;
const server = net.createServer((client) => {
  live += 1;
  const upstream = net.connect({ host: targetHost, port: targetPort });
  const kill = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on('error', kill);
  upstream.on('error', kill);
  client.on('close', () => {
    upstream.end();
    live -= 1;
  });
  upstream.on('close', () => client.end());
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
  console.log(`[proxy] http://${listenHost}:${listenPort}  ->  http://${targetHost}:${targetPort}`);
  console.log('[proxy] keep this process running; Ctrl+C drops the phone side');
});
