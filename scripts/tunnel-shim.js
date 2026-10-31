// 隧道前置 shim（v2，已修路径归一化绕过 / Host 校验 / 体积上限 / 超时）
//   cloudflared --url http://127.0.0.1:56998  ->  本 shim  ->  DSH 127.0.0.1:55129
//
// 为什么要它：@linxin666/dsh-remote-web-ui 的 trustedHosts 是 schema 里**非 volatile**
// 的字段，且 mountOnce 不会重跑 applyImpl，所以换 trycloudflare 域名后即使改了
// cordis.patch.yml，内存里的 trustedHosts 仍旧是旧域名 -> /api/pair/status 403。
// 不重启 DSH 的唯一办法：让到达 DSH 的请求长得"像回环请求"。
//
// 做法：
//  1) Host 头改写成 127.0.0.1:55129 —— isLoopbackClient() 要求 hostname 是回环且
//     socket.remoteAddress 也是回环（本 shim 就在 127.0.0.1 上，两条都满足）。
//  2) 删掉 Origin / Referer —— isTrustedApiRequest 在有 Origin 时会拿它和 Host 比，
//     Host 已被改写，不删就会失配；删掉后 `origin === undefined` 直接放行。
//  3) 响应里的 Location 若指向 http://127.0.0.1:... 或 http://localhost:...，
//     改写成 https://<公网域名>，否则手机跳转会 ERR_CONNECTION_REFUSED。
//  4) 同时把 cookie 里的 Secure 保留（走 https），并补 x-forwarded-*。
//
// v2 修复（v1 的洞）：
//  A. **路径归一化绕过**：v1 用 `url.split('?')[0].replace(/\/+$/,'')` 精确比较黑名单，
//     POST /api/pair/./issue 或 /api/pair/x/../issue 归一化后就是 /api/pair/issue，
//     但字符串不同 -> 绕过 403 -> DSH 侧 loopbackFence 认为请求来自本机 -> 凭空签发
//     配对令牌 -> 再用该令牌 POST /api/pair/accept 自助登记设备 -> 拿到 dsh_pair cookie
//     -> 任意人裸公网入站。实测 v1 可 200 拿到 token 并换到 deviceId。
//     v2 改成：先完整归一化（百分号解码 -> 折叠斜杠 -> 解 . / .. -> 转小写 -> 去尾斜杠），
//     再对归一化结果做**前缀**匹配，且返回 403 时不再区分大小写。
//  B. **Host 未校验**：任何人都能直连 127.0.0.1:56998 冒充隧道流量。v2 要求
//     Host 必须等于 public-host.txt 里的域名（或本机回环），否则 421。
//  C. **无体积上限 / 无超时**：v2 加 64 MiB 请求体上限 + 上游 30s 首包超时 + 5min 空闲断流。
//  D. **public-host.txt 每请求同步重读**：v2 按 mtime 缓存。
//  E. 加访问日志（原来一片空白，出问题无从查起）。
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};

const LISTEN_PORT = Number(argOf('listen-port', 56998));
const TARGET_PORT = Number(argOf('target-port', 55129));
const TARGET_HOST = argOf('target-host', '127.0.0.1');
const FORWARD_HOST = argOf('forward-host', `127.0.0.1:${TARGET_PORT}`);
const HOST_FILE = argOf('host-file', path.join(__dirname, 'public-host.txt'));
const FALLBACK_PUBLIC = argOf('public-host', '');
const MAX_BODY_BYTES = Number(argOf('max-body-bytes', 64 * 1024 * 1024));
const UPSTREAM_HEADER_TIMEOUT = Number(argOf('upstream-header-timeout-ms', 30000));
const IDLE_TIMEOUT = Number(argOf('idle-timeout-ms', 300000));
const STRICT_HOST = argOf('strict-host', '1') !== '0';
const VERBOSE = argOf('verbose', '0') === '1';

// ---- 公网域名（按 mtime 缓存，避免每请求同步读盘）----
let hostCache = { text: '', mtime: -1 };
const readPublic = () => {
  try {
    const st = fs.statSync(HOST_FILE);
    if (st.mtimeMs !== hostCache.mtime) {
      const t = fs.readFileSync(HOST_FILE, 'utf8').trim();
      hostCache = { text: t, mtime: st.mtimeMs };
    }
    if (hostCache.text) return hostCache.text;
  } catch {}
  return FALLBACK_PUBLIC;
};

// ---- 路径归一化：百分号解码 + 折叠斜杠 + 解 . / .. + 小写 + 去尾斜杠 ----
const safeDecode = (s) => {
  let out = s;
  // 最多解三层，防 %252e 这类双重编码
  for (let i = 0; i < 3; i += 1) {
    let next;
    try {
      next = decodeURIComponent(out);
    } catch {
      // 非法编码：用逐段 decodeURIComponent 容错，仍失败就原样返回
      try {
        next = out.replace(/%([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      } catch {
        return out;
      }
    }
    if (next === out) break;
    out = next;
  }
  return out;
};

const normalizePath = (rawUrl) => {
  let p = String(rawUrl || '/').split('?')[0].split('#')[0];
  p = safeDecode(p);
  p = p.replace(/\\/g, '/'); // 反斜杠在部分解析器里等同路径分隔
  // 折叠重复斜杠
  p = p.replace(/\/{2,}/g, '/');
  // 解 . 与 ..
  const segs = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      segs.pop();
      continue;
    }
    segs.push(seg);
  }
  let norm = '/' + segs.join('/');
  norm = norm.toLowerCase();
  // 去掉每段的空白（%20 / %09 / 裸空格），防止 "issue%20" 这类变体
  norm = norm.split('/').map((s) => s.replace(/[\s\u00a0]+/g, '')).join('/');
  norm = norm.replace(/\/+$/, '');
  return norm === '' ? '/' : norm;
};

// 本机专属端点前缀（归一化后做前缀匹配，大小写不敏感）
const LOOPBACK_ONLY_PREFIXES = [
  '/api/pair/issue',
  '/api/pair/stop',
  '/api/pair/revoke',
  '/api/pair/lan-bind',
];

const isLoopbackOnly = (req) => {
  const p = normalizePath(req.url);
  return LOOPBACK_ONLY_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix + '/'));
};

// ---- Host 校验：只放行隧道域名与本机回环 ----
const hostAllowed = (hostHeader, publicHost) => {
  if (!STRICT_HOST) return true;
  const h = String(hostHeader || '').toLowerCase().split(':')[0];
  if (!h) return false;
  if (h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1') return true;
  const pub = String(publicHost || '').toLowerCase();
  return pub !== '' && h === pub;
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

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (msg) => console.log(`[shim] ${stamp()} ${msg}`);

const deny = (res, status, code, note) => {
  const body = JSON.stringify({ ok: false, code });
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
  if (note) log(`DENY ${status} ${note}`);
};

const server = http.createServer((req, res) => {
  const publicHost = readPublic();

  if (!hostAllowed(req.headers.host, publicHost)) {
    deny(res, 421, 'bad-host', `host=${req.headers.host} path=${req.url}`);
    return;
  }
  if (isLoopbackOnly(req)) {
    deny(res, 403, 'forbidden', `loopback-only path=${req.url}`);
    return;
  }

  let declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    deny(res, 413, 'too-large', `content-length=${declared}`);
    return;
  }

  let received = 0;
  let killed = false;
  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_BODY_BYTES && !killed) {
      killed = true;
      deny(res, 413, 'too-large', `streamed>${MAX_BODY_BYTES}`);
      req.destroy();
    }
  });

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
    if (VERBOSE) log(`${req.method} ${req.url} -> ${ur.statusCode}`);
  });

  up.setTimeout(UPSTREAM_HEADER_TIMEOUT, () => {
    log(`upstream timeout ${req.method} ${req.url}`);
    up.destroy(new Error('upstream timeout'));
  });
  up.on('error', (e) => {
    log(`upstream error ${req.method} ${req.url}: ${e.message}`);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`shim upstream error: ${e.message}`);
  });

  res.setTimeout(IDLE_TIMEOUT, () => {
    try { res.destroy(); } catch {}
  });

  req.pipe(up);
});

// websocket / SSE 升级
server.on('upgrade', (req, socket, head) => {
  const publicHost = readPublic();
  if (!hostAllowed(req.headers.host, publicHost) || isLoopbackOnly(req)) {
    log(`DENY upgrade host=${req.headers.host} path=${req.url}`);
    try { socket.destroy(); } catch {}
    return;
  }
  const up = net.connect(TARGET_PORT, TARGET_HOST, () => {
    up.setTimeout(0);
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
    if (VERBOSE) log(`UPGRADE ${req.url}`);
  });
  const die = () => {
    try { socket.destroy(); } catch {}
    try { up.destroy(); } catch {}
  };
  up.setTimeout(IDLE_TIMEOUT, die);
  socket.setTimeout(IDLE_TIMEOUT, die);
  up.on('error', die);
  socket.on('error', die);
  up.on('close', die);
  socket.on('close', die);
});

server.on('error', (e) => {
  log(`listen failed: ${e.message}`);
  process.exit(1);
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  const pub = readPublic();
  log(`http://127.0.0.1:${LISTEN_PORT} -> http://${TARGET_HOST}:${TARGET_PORT} (Host=${FORWARD_HOST}, public=${pub || '(none)'}, strict-host=${STRICT_HOST}, max-body=${MAX_BODY_BYTES})`);
});
