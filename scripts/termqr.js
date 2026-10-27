#!/usr/bin/env node
/**
 * DSH mobile — print a pairing link as a terminal QR code.
 *
 *   node termqr.js "https://example.trycloudflare.com/pair-accept?pair=..."
 *   node termqr.js --file pair-url-lan.txt
 *
 * Requires the `qrcode-terminal` package (npm i qrcode-terminal), or point
 * DSH_QRTERM_MODULE at an existing install.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function candidates() {
  const out = [];
  if (process.env.DSH_QRTERM_MODULE) out.push(process.env.DSH_QRTERM_MODULE);
  out.push(path.join(__dirname, 'node_modules', 'qrcode-terminal'));
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  try {
    for (const name of fs.readdirSync(path.join(home, 'profiles'))) {
      out.push(path.join(home, 'profiles', name, 'node_modules', 'qrcode-terminal'));
    }
  } catch {
    /* no profiles dir */
  }
  return out;
}

function loadQrTerm() {
  const tried = [];
  for (const p of candidates()) {
    try {
      return require(p);
    } catch (e) {
      tried.push(`${p} (${e.code || e.message})`);
    }
  }
  throw new Error(
    'qrcode-terminal not found. Install it (npm i qrcode-terminal) or set DSH_QRTERM_MODULE.\nTried:\n  ' +
      tried.join('\n  '),
  );
}

const args = process.argv.slice(2);
let url;
if (args[0] === '--file') {
  url = fs.readFileSync(args[1], 'utf8').trim();
} else {
  url = args[0];
}
if (!url) {
  console.error('usage: node termqr.js <url>');
  console.error('       node termqr.js --file pair-url-lan.txt');
  process.exit(1);
}

loadQrTerm().generate(url, { small: true });
console.log(url);
