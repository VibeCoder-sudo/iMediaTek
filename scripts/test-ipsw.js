#!/usr/bin/env node
'use strict';

// Plain Node test for the IPSW downloader: a local server stands in for Apple's CDN.
//   node scripts/test-ipsw.js
process.env.IMEDIATEK_TEST_HOSTS = '127.0.0.1';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const ipsw = require('../src/main/ipsw');

const payload = crypto.randomBytes(3 * 1024 * 1024 + 123);
const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
let ignoreRange = false;
let served = 0;

const server = http.createServer((req, res) => {
  const range = /bytes=(\d+)-/.exec(req.headers.range || '');
  const from = range && !ignoreRange ? Number(range[1]) : 0;
  res.statusCode = range && !ignoreRange ? 206 : 200;
  res.setHeader('content-length', payload.length - from);
  const body = payload.subarray(from);
  // Dribble the body out so the test can pause in the middle.
  let offset = 0;
  const tick = () => {
    if (offset >= body.length) return res.end();
    const piece = body.subarray(offset, offset + 256 * 1024);
    offset += piece.length;
    served += piece.length;
    res.write(piece, () => setTimeout(tick, 15));
  };
  tick();
});

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/fw.ipsw`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imediatek-ipsw-'));
  const info = { file: 'fw.ipsw', url, size: payload.length, sha256 };

  // 1. a manifest pointing anywhere but Apple's CDN is refused
  assert.throws(() => ipsw.validateIpsw({ ...info, url: 'https://example.com/fw.ipsw' }), /Apple/);
  assert.throws(() => ipsw.validateIpsw({ ...info, file: '../fw.ipsw' }), /safe/);
  assert.throws(() => ipsw.validateIpsw({ ...info, sha256: 'abc' }), /sha256/);

  // 2. pause in the middle, then resume from the partial file
  const controller = new AbortController();
  let paused = false;
  const first = await ipsw.download(info, dir, (p) => {
    if (!paused && p.phase === 'download' && p.received > payload.length / 3) { paused = true; controller.abort(); }
  }, controller.signal);
  assert.strictEqual(first.paused, true, 'the first run should pause');
  const partial = ipsw.status(info, dir);
  assert.ok(partial.partial > 0 && partial.partial < payload.length, 'a partial file stays');
  const before = served;
  const second = await ipsw.download(info, dir, null, new AbortController().signal);
  assert.strictEqual(second.ok, true, 'the resumed run should finish');
  assert.ok(served - before < payload.length, 'resume must not re-send the whole file');
  assert.strictEqual(ipsw.status(info, dir).ready, true);
  assert.strictEqual(fs.readFileSync(second.path).equals(payload), true, 'content is identical');

  // 3. a server that ignores Range still produces a correct file
  fs.rmSync(second.path);
  fs.writeFileSync(`${second.path}.part`, payload.subarray(0, 1000));
  ignoreRange = true;
  const third = await ipsw.download(info, dir, null, new AbortController().signal);
  assert.strictEqual(third.ok, true);
  assert.strictEqual(fs.readFileSync(third.path).equals(payload), true);

  // 4. a wrong hash deletes the partial file and reports it
  fs.rmSync(third.path);
  const bad = await ipsw.download({ ...info, sha256: '0'.repeat(64) }, dir, null, new AbortController().signal);
  assert.strictEqual(bad.ok, false);
  assert.ok(!fs.existsSync(`${third.path}.part`), 'the bad partial is deleted');

  // 5. verifying a file the user already has
  const own = path.join(dir, 'mine.ipsw');
  fs.writeFileSync(own, payload);
  assert.strictEqual((await ipsw.verifyFile(own, info)).ok, true);
  fs.writeFileSync(own, payload.subarray(0, 100));
  assert.strictEqual((await ipsw.verifyFile(own, info)).ok, false);

  fs.rmSync(dir, { recursive: true, force: true });
  server.close();
  console.log('ipsw downloader: all checks passed');
}

main().catch((error) => { console.error(error); server.close(); process.exit(1); });
