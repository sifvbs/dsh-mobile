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
  const port = Number(argOf('--cdp-port', 9333));
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

  // the SPA needs a few seconds to mount after the shell loads
  await sleep(9000);

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    return r && r.result ? r.result.value : undefined;
  };

  const finalUrl = await evalJs('location.href');
  const slots = await evalJs(
    'document.querySelectorAll("[data-dsh-slot], [data-slot]").length',
  );
  const owns = await evalJs('!!(window.__DSH_TRANSPORT__ && window.__DSH_TRANSPORT__.ownsHost)');
  const bodyText = await evalJs('document.body ? document.body.innerText.slice(0, 200) : ""');

  const wsUrl = requests.find((u) => u.includes('/remote/api/remote.mux')) || '(none)';

  console.log('URL    ', finalUrl);
  console.log('SLOTS  ', slots);
  console.log('OWNS   ', owns);
  console.log('WS     ', wsUrl);
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
