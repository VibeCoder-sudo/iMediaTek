'use strict';

/**
 * The safety rules of the project, in one place and in code.
 *
 *  - The ONLY partition a test boot writes is boot_a (/dev/sdc36).
 *  - boot_b (/dev/sdc56) and userdata (/dev/sdc61) hold the Arch rescue system: never written.
 *  - super (/dev/sdc60) holds the iOS volume: read only here.
 *
 * Every command that touches a block device is built by the functions below from fixed
 * templates. Nothing else in the app composes a shell command with a device in it.
 */

const TARGET = Object.freeze({ name: 'boot_a', sys: 'sdc36', dev: '/dev/sdc36' });

const EXPECTED_PARTNAMES = Object.freeze({
  sdc36: 'boot_a',
  sdc56: 'boot_b',
  sdc61: 'userdata',
  sdc60: 'super',
});

const PROTECTED_DEVICES = Object.freeze(['/dev/sdc56', '/dev/sdc61', '/dev/sdc60']);

const GADGET_TTY = '/dev/ttyGS0';
const SLOT_MGR = '/usr/local/bin/slot_mgr.py';
const MIN_IMAGE = 4 * 1024 * 1024;
const MAX_IMAGE = 256 * 1024 * 1024;
const ANDROID_MAGIC = 'ANDROID!';

function assertImageSize(size) {
  if (!Number.isSafeInteger(size) || size < MIN_IMAGE || size > MAX_IMAGE) {
    throw new Error(`image size ${size} is outside ${MIN_IMAGE}..${MAX_IMAGE} bytes`);
  }
  return size;
}

/** Name of a partition as Linux reports it, e.g. PARTNAME=boot_a. */
const partnameCommand = (sys) => {
  if (!Object.prototype.hasOwnProperty.call(EXPECTED_PARTNAMES, sys)) throw new Error(`unknown partition ${sys}`);
  return `grep PARTNAME /sys/class/block/${sys}/uevent`;
};

const sectorsCommand = (sys) => {
  if (!Object.prototype.hasOwnProperty.call(EXPECTED_PARTNAMES, sys)) throw new Error(`unknown partition ${sys}`);
  return `cat /sys/class/block/${sys}/size`;
};

/** The one write: exactly `size` raw bytes from the console into boot_a. */
function flashCommand(size) {
  assertImageSize(size);
  return `stty -F ${GADGET_TTY} raw -echo; head -c ${size} > ${TARGET.dev}; sync; stty -F ${GADGET_TTY} sane; echo FLASH_DONE`;
}

/** Reads boot_a back and hashes it. Read only. */
function readbackCommand(size) {
  assertImageSize(size);
  return `echo MD5=$(head -c ${size} ${TARGET.dev} | md5sum)`;
}

const ARM_COMMAND = `${SLOT_MGR} a 1 0 && reboot -f`;
const PSTORE_COMMAND = 'mountpoint -q /sys/fs/pstore || mount -t pstore pstore /sys/fs/pstore; cat /sys/fs/pstore/console-ramoops-0';

module.exports = {
  TARGET, EXPECTED_PARTNAMES, PROTECTED_DEVICES, GADGET_TTY, SLOT_MGR, ANDROID_MAGIC,
  assertImageSize, partnameCommand, sectorsCommand, flashCommand, readbackCommand, ARM_COMMAND, PSTORE_COMMAND,
};
