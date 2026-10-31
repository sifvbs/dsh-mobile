#!/usr/bin/env node
/**
 * DSH mobile — end-to-end check with a real browser (headless Chrome + CDP).
 *
 *   node verify.js --host <public-host-or-lan-ip:port> --pair <token>
 *   node verify.js --url "https://xxx.trycloudflare.com/pair-accept?pair=..."
 *
 * What it proves: the acceptance page redirects, the app shell loads, the SPA
 * actually mounts, and the /remote WebSocket channel connects. A curl-only check
 * cannot see the last two.
 *
 * Prints:
 *   URL    final URL after redirects
 *   SLOTS  number of mounted conversation slots (0 means the SPA never booted)
 *   OWNS   window.__DSH_TRANSPORT__.ownsHost (host grant was delivered)
 *   WS     the /remote/api/remote.mux WebSocket URL that opened
 *   REQ/RESP  request counts
 *
 * Requires a Chrome/Edge binary and the `ws` package (npm i ws), or set
 * CHROME_PATH / DSH_WS_MODULE.
 *
 * Options:
 *   --url <pair-accept-url>  or  --host <host[:port]> --pair <token>
 *   --cdp-port <n>    (default: an ephemeral free port, picked automatically)
 *   --wait-ms <n>     overall budget for the three boot signals (default 20000)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

function argOf(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('Chrome/Edge not found — set CHROME_PATH');
}

function loadWs() {
  const tries = [process.env.DSH_WS_MODULE, 'ws', path.join(__dirname, 'node_modules', 'ws')].filter(Boolean);
  for (const t of tries) {
    try {
      return require(t);
    } catch {
      /* next */
    }
  }
  throw new Error('ws package not found — npm i ws, or set DSH_WS_MODULE');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Pick a free TCP port for CDP. The old default (9333) collided with any other
 * Chrome/Edge already debugging, and a hardcoded port also breaks when two
 * verify runs overlap. --cdp-port still wins when supplied explicitly.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = require('net').createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Poll fn until it returns truthy or the budget runs out. */
async function waitFor(fn, { timeoutMs, intervalMs, label }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label || 'waitFor'} timed out after ${timeoutMs}ms`);
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(b));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

(async () => {
  let target = argOf('--url', '');
  if (!target) {
    const host = argOf('--host', '');
    const pair = argOf('--pair', '');
    if (!host || !pair) throw new Error('need --url, or both --host and --pair');
    const scheme = /:\d+$/.test(host) && !/^https/.test(host) ? 'http' : 'https';
    target = `${scheme}://${host}/pair-accept?pair=${pair}`;
  }

  const chrome = findChrome();
  const explicitPort = argOf('--cdp-port', '');
  const port = explicitPort ? Number(explicitPort) : await freePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-'));

  const proc = spawn(
    chrome,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );

  const cleanup = () => {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };
  process.on('exit', cleanup);

  let version;
  for (let i = 0; i < 40; i++) {
    try {
      version = await httpJson(`http://127.0.0.1:${port}/json/version`);
      break;
    } catch {
      await sleep(250);
    }
  }
  if (!version) throw new Error(`Chrome did not expose CDP on ${port}`);
  console.log('CDP    ', port, '(', version.Browser || 'unknown', ')');

  const targets = await httpJson(`http://127.0.0.1:${port}/json/list`);
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');

  const WebSocket = loadWs();
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  const requests = [];
  const responses = [];
  const failures = [];

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === 'Network.requestWillBeSent') {
      requests.push(msg.params.request.url);
    } else if (msg.method === 'Network.responseReceived') {
      responses.push({ status: msg.params.response.status, url: msg.params.response.url });
    } else if (msg.method === 'Network.loadingFailed') {
      failures.push({ error: msg.params.errorText, blocked: msg.params.blockedReason });
    }
  });

  await new Promise((resolve) => ws.on('open', resolve));
  for (const d of ['Page', 'Runtime', 'Network']) await send(`${d}.enable`);
  await send('Page.navigate', { url: target });

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    return r && r.result ? r.result.value : undefined;
  };

  const slotsExpr = 'document.querySelectorAll("[data-dsh-slot], [data-slot]").length';
  const ownsExpr = '!!(window.__DSH_TRANSPORT__ && window.__DSH_TRANSPORT__.ownsHost)';
  const muxHit = () => requests.find((u) => u.includes('/remote/api/remote.mux'));

  // Wait for the three real signals instead of sleeping a fixed 9s. Each one can
  // arrive well before or after that mark depending on machine load and whether
  // the page came from cache, so polling with a budget is both faster and safer.
  // --wait-ms is the overall budget (default 20000).
  const waitMs = Number(argOf('--wait-ms', '20000'));
  const t0 = Date.now();

  let slots = 0;
  try {
    await waitFor(
      async () => {
        slots = Number(await evalJs(slotsExpr)) || 0;
        return slots > 5;
      },
      { timeoutMs: waitMs, intervalMs: 400, label: 'slots' },
    );
  } catch {
    /* leave slots at whatever we last saw */
  }

  let owns = false;
  try {
    await waitFor(
      async () => {
        owns = (await evalJs(ownsExpr)) === true;
        return owns;
      },
      { timeoutMs: Math.max(2000, waitMs - (Date.now() - t0)), intervalMs: 400, label: 'owns' },
    );
  } catch {
    /* leave owns false */
  }

  try {
    await waitFor(async () => muxHit(), {
      timeoutMs: Math.max(2000, waitMs - (Date.now() - t0)),
      intervalMs: 400,
      label: 'mux',
    });
  } catch {
    /* wsUrl stays (none) */
  }

  const waitedMs = Date.now() - t0;

  const finalUrl = await evalJs('location.href');
  const bodyText = await evalJs('document.body ? document.body.innerText.slice(0, 200) : ""');

  const wsUrl = muxHit() || '(none)';

  console.log('URL    ', finalUrl);
  console.log('SLOTS  ', slots);
  console.log('OWNS   ', owns);
  console.log('WS     ', wsUrl);
  console.log('WAIT   ', waitedMs + 'ms');
  console.log('REQ    ', requests.length, ' RESP', responses.length);
  if (failures.length) {
    console.log('FAILED ', failures.length);
    for (const f of failures.slice(0, 5)) console.log('        ', f.error, f.blocked || '');
  }
  console.log('TEXT   ', String(bodyText).replace(/\s+/g, ' ').slice(0, 160));

  const ok = Number(slots) > 5 && owns === true && wsUrl !== '(none)';
  console.log(ok ? 'RESULT  BOOTED OK' : 'RESULT  NOT BOOTED');

  ws.close();
  cleanup();
  process.exit(ok ? 0 : 2);
})().catch((e) => {
  console.error('FAILED ' + e.message);
  process.exit(1);
});
