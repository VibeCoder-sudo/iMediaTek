'use strict';

const { SerialPort } = require('serialport');

const ANSI = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b\[[0-9;?]*[a-zA-Z]/g;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Serial ports that could be the phone's Arch console (a USB CDC serial device). */
async function listPorts() {
  const all = await SerialPort.list();
  return all
    .filter((p) => !/\/dev\/tty\./.test(p.path)) // macOS lists every port twice; cu.* is the right one
    .map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer || '',
      vendorId: p.vendorId || '',
      productId: p.productId || '',
      likely: /usbmodem|ttyACM/.test(p.path) || (process.platform === 'win32' && !!p.vendorId),
    }))
    .sort((a, b) => Number(b.likely) - Number(a.likely));
}

/**
 * A shell on the phone's Arch system through the serial console. The host side is a raw port
 * (the serial library does not apply line editing), so the stream is binary safe.
 */
class ArchConsole {
  /** `transport` is for tests only: an object shaped like a SerialPort (open/write/drain/close, 'data'/'close'). */
  constructor(portPath, transport) {
    this.path = portPath;
    this.transport = transport || null;
    this.port = null;
    this.rx = '';
    this.waiters = new Set();
    this.closed = false;
  }

  open() {
    return new Promise((resolve, reject) => {
      this.port = this.transport || new SerialPort({ path: this.path, baudRate: 115200, autoOpen: false });
      this.port.on('data', (chunk) => {
        this.rx += chunk.toString('latin1');
        if (this.rx.length > 8 * 1024 * 1024) this.rx = this.rx.slice(-4 * 1024 * 1024);
        for (const wake of [...this.waiters]) wake();
      });
      this.port.on('close', () => { this.closed = true; for (const wake of [...this.waiters]) wake(); });
      this.port.on('error', () => { /* surfaced through the pending operation */ });
      // A freshly opened tty can drop the first bytes while the driver settles its line state.
      this.port.open((error) => (error ? reject(error) : setTimeout(resolve, 250)));
    });
  }

  write(data) {
    return new Promise((resolve, reject) => {
      if (this.closed || !this.port) return reject(new Error('the console is closed'));
      // The callback fires once the bytes are in the device's queue, which is the back pressure
      // a long raw transfer needs; draining after every chunk would stall.
      this.port.write(data, (error) => (error ? reject(error) : resolve()));
      return undefined;
    });
  }

  /** Waits (at most `limit` ms) until everything written has left the host. */
  flush(limit = 8000) {
    return new Promise((resolve) => {
      if (!this.port || this.closed) return resolve();
      const timer = setTimeout(resolve, limit);
      this.port.drain(() => { clearTimeout(timer); resolve(); });
      return undefined;
    });
  }

  /** Waits until `test(rx)` is truthy, the port closes, or the timeout passes. */
  waitFor(test, timeout) {
    return new Promise((resolve) => {
      let timer = null;
      const check = () => {
        const value = test(this.rx);
        if (value || this.closed) { cleanup(); resolve(value || null); }
      };
      const cleanup = () => { clearTimeout(timer); this.waiters.delete(check); };
      timer = setTimeout(() => { cleanup(); resolve(null); }, timeout);
      this.waiters.add(check);
      check();
    });
  }

  /** Throws away whatever is pending and waits for the line to go quiet. */
  async drain(quiet = 250) {
    let seen = -1;
    while (seen !== this.rx.length) { seen = this.rx.length; await sleep(quiet); }
    this.rx = '';
  }

  /** Runs one shell command and returns its output (echo and terminal escapes removed). */
  async run(command, { timeout = 20000 } = {}) {
    // Only read-only commands go through run(), so asking once more after a silence is safe.
    const mark = `END_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const done = new RegExp(`(?:^|[\\r\\n])${mark}\\r?\\n`);
    const first = Math.min(timeout, 4000);
    let found = null;
    for (let attempt = 0; attempt < 2 && !found; attempt += 1) {
      await this.drain(150);
      await this.write(`${command}; echo ${mark}\n`);
      found = await this.waitFor((rx) => done.exec(rx), attempt === 0 ? first : Math.max(1000, timeout - first));
    }
    if (!found) throw new Error(`no answer to "${command.slice(0, 60)}" within ${Math.round(timeout / 1000)} s`);
    let out = this.rx.slice(0, found.index).replace(ANSI, '');
    this.rx = this.rx.slice(found.index + found[0].length);
    out = out.split(/\r?\n/).filter((line) => !line.includes(`echo ${mark}`)).join('\n').trim(); // drop the terminal's echo of the command
    return out;
  }

  /** Streams raw bytes with back pressure; reports how many have been sent. */
  async sendRaw(buffer, onProgress, chunk = 4096) {
    for (let offset = 0; offset < buffer.length; offset += chunk) {
      await this.write(buffer.subarray(offset, offset + chunk));
      if (onProgress && (offset / chunk) % 16 === 0) onProgress(Math.min(offset + chunk, buffer.length), buffer.length);
    }
    await this.flush();
    if (onProgress) onProgress(buffer.length, buffer.length);
  }

  close() {
    return new Promise((resolve) => {
      if (!this.port || this.closed) return resolve();
      this.port.close(() => resolve());
      return undefined;
    });
  }
}

module.exports = { ArchConsole, listPorts, sleep, ANSI };
