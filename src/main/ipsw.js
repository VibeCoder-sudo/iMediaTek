'use strict';

/**
 * The iOS IPSW is downloaded straight from Apple's CDN to the user's machine. iMediaTek never
 * hosts or redistributes it. The download resumes (HTTP Range) and is accepted only when the
 * SHA-256 from the manifest matches.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APPLE_HOSTS = ['updates.cdn-apple.com', 'appldnld.apple.com'];
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._,-]{0,127}\.ipsw$/;
const HEX64 = /^[0-9a-f]{64}$/;
const PROGRESS_EVERY_MS = 150;

// Tests may add a local host (IMEDIATEK_TEST_HOSTS=127.0.0.1); production only trusts Apple.
function testHosts() {
  return (process.env.IMEDIATEK_TEST_HOSTS || '').split(',').filter(Boolean);
}

function urlAllowed(url) {
  try {
    const parsed = new URL(url);
    const tests = testHosts();
    const https = parsed.protocol === 'https:';
    const plainOk = tests.length > 0 && parsed.protocol === 'http:';
    return (https || plainOk) && APPLE_HOSTS.concat(tests).includes(parsed.hostname);
  } catch (error) {
    return false;
  }
}

function validateIpsw(ipsw) {
  if (!ipsw || typeof ipsw !== 'object') throw new Error('ipsw is missing');
  if (!FILE_NAME.test(ipsw.file || '')) throw new Error('ipsw.file is not a safe .ipsw name');
  if (!Number.isInteger(ipsw.size) || ipsw.size <= 0) throw new Error('ipsw.size is invalid');
  if (!HEX64.test(ipsw.sha256 || '')) throw new Error('ipsw.sha256 is required');
  if (!urlAllowed(ipsw.url)) throw new Error('ipsw.url must be https on Apple\'s CDN');
  return ipsw;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freeBytes(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stats = fs.statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch (error) {
    return null;
  }
}

/** What is already on disk: a verified file, a partial download, or nothing. */
function status(ipsw, dir) {
  validateIpsw(ipsw);
  const final = path.join(dir, ipsw.file);
  const part = `${final}.part`;
  const result = { ready: false, path: final, partial: 0, free: freeBytes(dir) };
  if (fs.existsSync(final) && fs.statSync(final).size === ipsw.size) result.ready = true;
  else if (fs.existsSync(part)) result.partial = Math.min(fs.statSync(part).size, ipsw.size);
  return result;
}

function hashFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const total = fs.statSync(file).size;
    const sha = crypto.createHash('sha256');
    let read = 0;
    let last = 0;
    fs.createReadStream(file, { highWaterMark: 1 << 20 })
      .on('data', (chunk) => {
        sha.update(chunk);
        read += chunk.length;
        const now = Date.now();
        if (onProgress && now - last >= PROGRESS_EVERY_MS) {
          last = now;
          onProgress({ phase: 'verify', received: read, total });
        }
      })
      .on('error', reject)
      .on('end', () => resolve(sha.digest('hex')));
  });
}

/** Checks a file the user already has (any location) against the manifest. */
async function verifyFile(file, ipsw, onProgress) {
  validateIpsw(ipsw);
  const size = fs.statSync(file).size;
  if (size !== ipsw.size) {
    return { ok: false, path: file, error: `size is ${size} bytes, expected ${ipsw.size}` };
  }
  const sha256 = await hashFile(file, onProgress);
  if (sha256 !== ipsw.sha256) {
    return { ok: false, path: file, error: 'SHA-256 does not match the expected firmware' };
  }
  return { ok: true, path: file, sha256 };
}

/**
 * Downloads (or resumes) the IPSW into `dir`. Aborting the signal pauses: the .part file stays
 * and the next call continues from its size.
 */
async function download(ipsw, dir, onProgress, signal) {
  validateIpsw(ipsw);
  fs.mkdirSync(dir, { recursive: true });
  const final = path.join(dir, ipsw.file);
  const part = `${final}.part`;

  if (fs.existsSync(final) && fs.statSync(final).size === ipsw.size) {
    return { ok: true, path: final, cached: true };
  }

  let start = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (start > ipsw.size) { fs.rmSync(part, { force: true }); start = 0; }

  const headers = { 'user-agent': 'iMediaTek-flasher' };
  if (start > 0) headers.range = `bytes=${start}-`;

  let response;
  try {
    response = await fetch(ipsw.url, { headers, redirect: 'follow', signal });
  } catch (error) {
    if (signal && signal.aborted) return { ok: false, paused: true, received: start };
    throw error;
  }
  if (!urlAllowed(response.url)) throw new Error('the download was redirected away from Apple\'s CDN');
  if (start > 0 && response.status !== 206) start = 0; // the server ignored Range: start over
  else if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const out = fs.createWriteStream(part, { flags: start > 0 ? 'a' : 'w' });
  let received = start;
  let lastSent = 0;
  const window = [];
  try {
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > ipsw.size) throw new Error('the server sent more than the manifest says');
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      const now = Date.now();
      window.push([now, received]);
      while (window.length > 1 && now - window[0][0] > 4000) window.shift();
      if (onProgress && now - lastSent >= PROGRESS_EVERY_MS) {
        lastSent = now;
        const [t0, r0] = window[0];
        const speed = now > t0 ? ((received - r0) * 1000) / (now - t0) : 0;
        onProgress({
          phase: 'download', received, total: ipsw.size, speed,
          eta: speed > 0 ? (ipsw.size - received) / speed : null,
        });
      }
    }
    await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
  } catch (error) {
    await new Promise((resolve) => out.end(resolve));
    if (signal && signal.aborted) return { ok: false, paused: true, received };
    throw error;
  }

  if (received !== ipsw.size) return { ok: false, error: 'the download ended early', received };

  const sha256 = await hashFile(part, onProgress);
  if (sha256 !== ipsw.sha256) {
    fs.rmSync(part, { force: true });
    return { ok: false, error: 'SHA-256 mismatch: the partial file was deleted', received };
  }
  fs.renameSync(part, final);
  return { ok: true, path: final, sha256 };
}

module.exports = { validateIpsw, status, download, verifyFile, hashFile, urlAllowed, sleep };
