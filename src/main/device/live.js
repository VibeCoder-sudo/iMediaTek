'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const guard = require('./guard');
const { ArchConsole, listPorts, sleep, ANSI } = require('./console');

const session = { console: null, port: null, verified: null };

/** Size, hashes and header check of a boot image on this computer. */
function inspectImage(file) {
  return new Promise((resolve, reject) => {
    let size;
    try { size = fs.statSync(file).size; } catch (error) { return reject(error); }
    const sha = crypto.createHash('sha256');
    const md5 = crypto.createHash('md5');
    let head = Buffer.alloc(0);
    fs.createReadStream(file)
      .on('data', (chunk) => {
        if (head.length < 8) head = Buffer.concat([head, chunk]).subarray(0, 8);
        sha.update(chunk); md5.update(chunk);
      })
      .on('error', reject)
      .on('end', () => resolve({
        path: file, size, sha256: sha.digest('hex'), md5: md5.digest('hex'),
        androidHeader: head.toString('latin1') === guard.ANDROID_MAGIC,
      }));
    return undefined;
  });
}

async function connect(params, log) {
  if (session.console) { await session.console.close(); session.console = null; }
  if (!params.port) throw new Error('choose the console port first');
  if (!params.transport) { // a path from the interface is never trusted: it must be a port the system lists
    const known = await listPorts();
    if (!known.some((p) => p.path === params.port)) throw new Error(`${params.port} is not a serial port on this computer`);
  }
  log(`serial: opening ${params.port}`);
  const arch = new ArchConsole(params.port, params.transport);
  await arch.open();
  await arch.write('\n');
  const uname = await arch.run('uname -a', { timeout: 15000 });
  log(`arch: ${uname}`);
  if (!/Linux/.test(uname)) { await arch.close(); throw new Error('that port does not answer like the Arch rescue system'); }
  const cmdline = await arch.run('cat /proc/cmdline', { timeout: 10000 });
  const slot = (/slot_suffix=(_[ab])/.exec(cmdline) || [])[1] || null;
  log(`arch: running from slot ${slot || 'unknown'}`);
  session.console = arch; session.port = params.port;
  return { ok: true, console: params.port, system: uname, slot };
}

function needConsole() {
  if (!session.console || session.console.closed) throw new Error('not connected: run the Connect step first');
  return session.console;
}

async function readPartnames(arch, log) {
  const found = {};
  for (const [sys, expected] of Object.entries(guard.EXPECTED_PARTNAMES)) {
    const out = await arch.run(guard.partnameCommand(sys), { timeout: 10000 });
    const name = (/PARTNAME=(\S+)/.exec(out) || [])[1] || null;
    found[sys] = name;
    log(`arch: /dev/${sys} is ${name || 'unknown'} (expected ${expected})`);
  }
  return found;
}

function assertPartnames(found) {
  for (const [sys, expected] of Object.entries(guard.EXPECTED_PARTNAMES)) {
    if (found[sys] !== expected) {
      throw new Error(`/dev/${sys} is "${found[sys]}", expected "${expected}". Nothing was written.`);
    }
  }
}

async function inspect(params, log) {
  const arch = needConsole();
  const found = await readPartnames(arch, log);
  assertPartnames(found);
  const sectors = Number((await arch.run(guard.sectorsCommand(guard.TARGET.sys), { timeout: 10000 })).trim());
  const bytes = Number.isFinite(sectors) ? sectors * 512 : null;
  log(`arch: boot_a is ${bytes ? Math.round(bytes / 1048576) : '?'} MB`);
  return { ok: true, bootA: guard.TARGET.dev, protected: [...guard.PROTECTED_DEVICES], codename: 'rosemary', partitions: found, bootABytes: bytes };
}

async function flash(params, log, ctx) {
  const arch = needConsole();
  if (!params.imagePath) throw new Error('no boot image chosen');
  log(`image: reading ${path.basename(params.imagePath)}`);
  const image = await inspectImage(params.imagePath);
  if (!image.androidHeader) throw new Error('that file is not an Android boot image (no ANDROID! header). Nothing was written.');
  guard.assertImageSize(image.size);
  const want = params.expected || {};
  if (want.sha256 && want.sha256 !== image.sha256) throw new Error('the image does not match the SHA-256 from version.json. Nothing was written.');
  if (want.md5 && want.md5 !== image.md5) throw new Error('the image does not match the MD5 from version.json. Nothing was written.');
  log(`image: ${image.size} bytes, md5 ${image.md5}`);

  // Everything is re-read from the phone right before the write.
  const found = await readPartnames(arch, log);
  assertPartnames(found);
  const sectors = Number((await arch.run(guard.sectorsCommand(guard.TARGET.sys), { timeout: 10000 })).trim());
  if (!Number.isFinite(sectors) || sectors * 512 < image.size) throw new Error('the image is larger than boot_a. Nothing was written.');

  if (ctx && ctx.confirmFlash) {
    const yes = await ctx.confirmFlash({ file: path.basename(image.path), size: image.size, md5: image.md5, target: guard.TARGET.dev });
    if (!yes) { log('flash: cancelled before writing'); return { ok: false, canceled: true }; }
  }

  const data = fs.readFileSync(image.path);
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    log(`flash: attempt ${attempt}, writing ${image.size} bytes to ${guard.TARGET.dev} (boot_a)`);
    await arch.drain(150);
    await arch.write(`${guard.flashCommand(image.size)}\n`);
    await sleep(500);
    arch.rx = '';
    await arch.sendRaw(data, (sent, total) => ctx && ctx.progress && ctx.progress({ phase: 'flash', sent, total }));
    const done = await arch.waitFor((rx) => /FLASH_DONE/.test(rx), 120000);
    if (!done) { lastError = new Error('the phone did not confirm the write (no FLASH_DONE)'); continue; }
    await arch.drain(300);
    const answer = await arch.run(guard.readbackCommand(image.size), { timeout: 120000 });
    const got = (/MD5=([0-9a-f]{32})/.exec(answer) || [])[1];
    log(`flash: expected ${image.md5}, boot_a reads back ${got || 'nothing'}`);
    if (got === image.md5) {
      session.verified = { md5: image.md5, size: image.size };
      return { ok: true, md5: image.md5, size: image.size, attempts: attempt };
    }
    lastError = new Error('MD5 of boot_a differs from the image');
  }
  session.verified = null;
  throw new Error(`${lastError.message}. The one-shot boot was NOT armed; the phone still boots Arch.`);
}

async function arm(params, log) {
  const arch = needConsole();
  if (!params.imagePath) throw new Error('no boot image chosen');
  const image = await inspectImage(params.imagePath);
  // Never boot what was not verified: read boot_a back once more and compare.
  const found = await readPartnames(arch, log);
  assertPartnames(found);
  const answer = await arch.run(guard.readbackCommand(image.size), { timeout: 120000 });
  const got = (/MD5=([0-9a-f]{32})/.exec(answer) || [])[1];
  if (got !== image.md5) throw new Error('boot_a does not contain the chosen image. Flash it first. The one-shot boot was NOT armed.');
  log('arch: boot_a verified; arming the one-shot boot of slot A');
  await arch.write(`${guard.ARM_COMMAND}\n`);
  await sleep(1500);
  await arch.close(); session.console = null;
  log('phone: rebooting into slot A');
  return { ok: true };
}

async function waitForPort(portPath, seconds, log) {
  const until = Date.now() + seconds * 1000;
  let announced = false;
  while (Date.now() < until) {
    const ports = await listPorts();
    if (ports.some((p) => p.path === portPath)) return true;
    if (!announced) { log('waiting for the phone to come back into Arch (up to ~5 minutes)…'); announced = true; }
    await sleep(3000);
  }
  return false;
}

async function collect(params, log, ctx) {
  const portPath = params.port || session.port;
  if (!portPath) throw new Error('no console port chosen');
  const wait = params.waitSeconds === undefined ? 420 : params.waitSeconds;
  if (wait > 0 && !(await waitForPort(portPath, wait, log))) throw new Error('the phone did not come back as a serial port in time');
  await sleep(params.settleMs === undefined ? 15000 : params.settleMs); // let Arch finish booting
  const arch = new ArchConsole(portPath, params.transport);
  await arch.open();
  await arch.write('\n');
  const text = (await arch.run(guard.PSTORE_COMMAND, { timeout: 120000 })).replace(ANSI, '');
  await arch.close();
  const dir = ctx && ctx.logDir ? ctx.logDir : path.join(process.cwd(), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `pstore-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  fs.writeFileSync(file, text);
  log(`log: ${text.length} bytes saved to ${file}`);
  return { ok: true, bytes: text.length, path: file, tail: text.split('\n').slice(-12).join('\n') };
}

async function disconnect() {
  if (session.console) await session.console.close();
  session.console = null;
}

module.exports = { listPorts, inspectImage, disconnect, steps: { connect, inspect, flash, arm, collect }, session };
