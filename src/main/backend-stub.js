'use strict';

/**
 * Placeholder for the real device backend. This build is the front end only: every step is a
 * DRY RUN that prints what the real backend will do and writes nothing anywhere. The shape of
 * `run(step, params, log)` is the contract the real implementation (serial console to the
 * Arch rescue system, see docs/FLASHING.md) will keep.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const BOOT_A = '/dev/sdc36';
const PROTECTED = ['/dev/sdc56', '/dev/sdc61'];

const handlers = {
  async connect(params, log) {
    log('serial: opening /dev/cu.usbmodemnyam00011');
    await sleep(500);
    log('arch: uname -a');
    await sleep(400);
    log('Linux rosemary 4.19.325-Orion aarch64 (simulated)');
    return { ok: true, console: '/dev/cu.usbmodemnyam00011', system: 'Arch Linux ARM (slot B)' };
  },

  async inspect(params, log) {
    log('arch: cat /sys/class/block/sdc36/uevent');
    await sleep(500);
    log('PARTNAME=boot_a  (simulated)');
    log('arch: cat /sys/class/block/sdc56/uevent');
    await sleep(300);
    log('PARTNAME=boot_b  (simulated, PROTECTED)');
    log('arch: cat /sys/class/block/sdc61/uevent');
    await sleep(300);
    log('PARTNAME=userdata  (simulated, PROTECTED)');
    return { ok: true, bootA: BOOT_A, protected: PROTECTED, codename: 'rosemary' };
  },

  async flash(params, log) {
    log(`dry run: would stream ${params.image} to ${BOOT_A} (boot_a)`);
    await sleep(600);
    log('dry run: would compare MD5 of the partition with the image');
    await sleep(500);
    log('dry run: nothing was written');
    return { ok: true, dryRun: true };
  },

  async arm(params, log) {
    log('arch: /usr/local/bin/slot_mgr.py a 1 0   (one-shot boot of slot A, simulated)');
    await sleep(600);
    log('arch: reboot -f   (simulated)');
    return { ok: true, dryRun: true };
  },

  async collect(params, log) {
    log('arch: mount -t pstore pstore /sys/fs/pstore');
    await sleep(400);
    log('arch: cat /sys/fs/pstore/console-ramoops-0   (simulated: 0 bytes)');
    return { ok: true, dryRun: true, bytes: 0 };
  },
};

async function run(step, params, log) {
  const handler = handlers[step];
  if (!handler) throw new Error(`unknown step: ${step}`);
  log(`[dry run] ${step}`);
  return handler(params || {}, log);
}

module.exports = { run };
