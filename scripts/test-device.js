#!/usr/bin/env node
'use strict';

// Tests the live device backend against a fake Arch console on a pty. No phone is involved.
//   node scripts/test-device.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const live = require('../src/main/device/live');
const guard = require('../src/main/device/guard');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = () => {};

function startFake(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imediatek-fake-'));
  const child = spawn('python3', ['-u', path.join(__dirname, 'fake-arch.py')], { env: { ...process.env, FAKE_DEV_DIR: dir, FAKE_TCP: '1', ...env } });
  child.stderr.on('data', (d) => process.stderr.write(d));
  return new Promise((resolve) => {
    child.stdout.once('data', (d) => {
      const tcp = Number(d.toString().trim().split(':')[1]);
      const socket = net.connect(tcp, '127.0.0.1');
      // shaped like a SerialPort, so the backend runs unchanged
      const transport = {
        on: (event, fn) => socket.on(event, fn),
        open: (cb) => (socket.connecting ? socket.once('connect', () => cb(null)) : cb(null)),
        write: (data, cb) => socket.write(data, cb),
        drain: (cb) => cb(null),
        close: (cb) => { socket.end(); cb(); },
      };
      resolve({ child, dir, port: 'fake', transport });
    });
  });
}

const events = (fake) => (fs.existsSync(path.join(fake.dir, 'events.log')) ? fs.readFileSync(path.join(fake.dir, 'events.log'), 'utf8').trim().split('\n').filter(Boolean) : []);

function makeImage(dir, { android = true, size = 5 * 1024 * 1024 } = {}) {
  const data = crypto.randomBytes(size);
  if (android) data.write('ANDROID!', 0, 'latin1');
  const file = path.join(dir, 'boot.img');
  fs.writeFileSync(file, data);
  return { file, data, md5: crypto.createHash('md5').update(data).digest('hex') };
}

async function session(env, body) {
  const fake = await startFake(env);
  try { await body(fake); } finally { await live.disconnect(); fake.child.kill(); await sleep(100); }
}

async function main() {
  // static: no command template mentions a protected device
  for (const cmd of [guard.flashCommand(5 * 1024 * 1024), guard.readbackCommand(5 * 1024 * 1024), guard.ARM_COMMAND, guard.PSTORE_COMMAND]) {
    for (const dev of guard.PROTECTED_DEVICES) assert.ok(!cmd.includes(dev), `${cmd} mentions ${dev}`);
  }
  assert.throws(() => guard.flashCommand(10), /outside/);
  assert.throws(() => guard.partnameCommand('sda1'), /unknown/);

  // 1. the whole happy path
  await session({}, async (fake) => {
    const image = makeImage(fake.dir);
    const c = await live.steps.connect({ port: fake.port, transport: fake.transport }, log);
    assert.strictEqual(c.slot, '_b');
    const i = await live.steps.inspect({}, log);
    assert.strictEqual(i.partitions.sdc36, 'boot_a');
    let progressed = 0;
    const f = await live.steps.flash({ imagePath: image.file, expected: { md5: image.md5 } }, log, {
      confirmFlash: async (d) => { assert.strictEqual(d.target, '/dev/sdc36'); return true; },
      progress: () => { progressed += 1; },
    });
    assert.strictEqual(f.ok, true); assert.ok(progressed > 3, 'progress is reported');
    assert.ok(fs.readFileSync(path.join(fake.dir, 'sdc36')).equals(image.data), 'boot_a holds the image');
    await live.steps.arm({ imagePath: image.file }, log);
    await sleep(300);
    const ev = events(fake);
    assert.deepStrictEqual(ev.filter((e) => e.startsWith('WRITE')), [`WRITE sdc36 ${image.data.length}`]);
    assert.ok(ev.includes('ARMED'));
    assert.ok(!ev.some((e) => e.startsWith('VIOLATION') || e.startsWith('UNKNOWN')), `unexpected events: ${ev}`);
    for (const other of ['sdc56', 'sdc61', 'sdc60']) assert.ok(!fs.existsSync(path.join(fake.dir, other)), `${other} untouched`);
  });

  // 2. collecting the log after the phone is back
  await session({}, async (fake) => {
    const r = await live.steps.collect({ port: fake.port, transport: fake.transport, waitSeconds: 0, settleMs: 0 }, log, { logDir: fake.dir });
    assert.ok(r.bytes > 20 && /init: done/.test(fs.readFileSync(r.path, 'utf8')));
  });

  // 3. refusals: nothing is written and the one-shot boot is never armed
  await session({ FAKE_BAD_PARTS: '1' }, async (fake) => {
    const image = makeImage(fake.dir);
    await live.steps.connect({ port: fake.port, transport: fake.transport }, log);
    await assert.rejects(live.steps.inspect({}, log), /boot_x/);
    await assert.rejects(live.steps.flash({ imagePath: image.file }, log, { confirmFlash: async () => true }), /boot_x/);
    assert.deepStrictEqual(events(fake), []);
  });
  await session({}, async (fake) => {
    await live.steps.connect({ port: fake.port, transport: fake.transport }, log);
    const notBoot = makeImage(fake.dir, { android: false });
    await assert.rejects(live.steps.flash({ imagePath: notBoot.file }, log, { confirmFlash: async () => true }), /Android boot image/);
    const good = makeImage(fake.dir);
    await assert.rejects(live.steps.flash({ imagePath: good.file, expected: { sha256: '0'.repeat(64) } }, log, { confirmFlash: async () => true }), /SHA-256/);
    const cancelled = await live.steps.flash({ imagePath: good.file }, log, { confirmFlash: async () => false });
    assert.strictEqual(cancelled.canceled, true);
    const big = makeImage(fake.dir, { size: 20 * 1024 * 1024 });
    await assert.rejects(live.steps.flash({ imagePath: big.file }, log, { confirmFlash: async () => true }), /larger than boot_a/);
    await assert.rejects(live.steps.arm({ imagePath: good.file }, log), /does not contain/);
    assert.deepStrictEqual(events(fake), [], 'nothing was written or armed');
  });
  await session({ FAKE_CORRUPT: '1' }, async (fake) => {
    const image = makeImage(fake.dir);
    await live.steps.connect({ port: fake.port, transport: fake.transport }, log);
    await assert.rejects(live.steps.flash({ imagePath: image.file }, log, { confirmFlash: async () => true }), /NOT armed/);
    const ev = events(fake);
    assert.strictEqual(ev.filter((e) => e.startsWith('WRITE')).length, 3, 'three attempts, all to boot_a');
    assert.ok(ev.every((e) => e.startsWith('WRITE sdc36')), 'only boot_a');
    await assert.rejects(live.steps.arm({ imagePath: image.file }, log), /does not contain/);
    assert.ok(!events(fake).includes('ARMED'));
  });

  console.log('device backend: all checks passed');
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
