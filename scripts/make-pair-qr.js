#!/usr/bin/env node
/**
 * DSH mobile — one-shot pairing QR
 *
 *   node make-pair-qr.js [--port 3080] [--out <dir>] [--name pair-qr.png]
 *
 * Does three things:
 *   1. POST http://127.0.0.1:<port>/api/pair/issue for a one-time pairing link
 *      (valid for 10 minutes by default)
 *   2. writes the link to <out>/pair-url.txt
 *   3. renders <out>/<name> as a 720px PNG QR code
 *
 * The issue call goes over loopback and needs no cookie and no login. It only
 * works when the remote-web-ui plugin has a base URL to build the link from —
 * either `publicBaseUrl` (tunnel) or a live LAN base. Without one the endpoint
 * answers 409 lan-required.
 *
 * Requires the `qrcode` package. It is resolved from, in order:
 *   $DSH_QRCODE_MODULE, ./node_modules/qrcode, <DSH_HOME>/profiles/*<slash>node_modules/qrcode
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

function candidates() {
  const out = [];
  if (process.env.DSH_QRCODE_MODULE) out.push(process.env.DSH_QRCODE_MODULE);
  out.push(path.join(__dirname, 'node_modules', 'qrcode'));
  const home = process.env.DSH_HOME || path.join(require('os').homedir(), '.dsh');
  const profiles = path.join(home, 'profiles');
  try {
    for (const name of fs.readdirSync(profiles)) {
      out.push(path.join(profiles, name, 'node_modules', 'qrcode'));
    }
  } catch {
    /* no profiles dir */
  }
  return out;
}

function loadQrcode() {
  const tried = [];
  for (const p of candidates()) {
    try {
      return { mod: require(p), from: p };
    } catch (e) {
      tried.push(`${p} (${e.code || e.message})`);
    }
  }
  throw new Error(
    'qrcode module not found. Install it (npm i qrcode) next to this script, ' +
      'or point DSH_QRCODE_MODULE at an existing install.\nTried:\n  ' +
      tried.join('\n  '),
  );
}

function argOf(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

function issueToken(port) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/pair/issue',
        method: 'POST',
        headers: {
          host: `127.0.0.1:${port}`,
          'content-type': 'application/json',
          'content-length': 2,
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`issue failed: HTTP ${res.statusCode} ${body.slice(0, 300)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`issue returned non-json: ${body.slice(0, 300)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('issue timeout')));
    req.write('{}');
    req.end();
  });
}

(async () => {
  const port = Number(argOf('--port', process.env.DSH_PORT || 3080));
  const outDir = path.resolve(argOf('--out', process.env.DSH_CWD || process.cwd()));
  const name = argOf('--name', 'pair-qr.png');

  const data = await issueToken(port);
  if (!data || !data.ok || !data.url) {
    throw new Error(`issue rejected: ${JSON.stringify(data).slice(0, 300)}`);
  }

  const url = data.url;
  const expires = data.expiresAt ? new Date(data.expiresAt).toISOString() : 'unknown';

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'pair-url.txt'), url + '\n', 'utf8');

  const { mod: QR, from } = loadQrcode();
  const target = path.join(outDir, name);

  // qrcode ships both a promise API and a callback API depending on version
  if (typeof QR.toFile === 'function' && QR.toFile.length >= 3) {
    await QR.toFile(target, url, {
      errorCorrectionLevel: 'M',
      width: 720,
      margin: 2,
      color: { dark: '#111111', light: '#ffffff' },
    });
  } else {
    await new Promise((resolve, reject) => {
      QR.toFile(
        target,
        url,
        { errorCorrectionLevel: 'M', width: 720, margin: 2, color: { dark: '#111111', light: '#ffffff' } },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }

  const size = fs.statSync(target).size;
  console.log(`PAIR_URL ${url}`);
  console.log(`EXPIRES  ${expires}`);
  console.log(`QR_FILE  ${target}`);
  console.log(`QR_BYTES ${size}`);
  console.log(`QRCODE   ${from}`);
})().catch((e) => {
  console.error('FAILED ' + e.message);
  process.exit(1);
});
