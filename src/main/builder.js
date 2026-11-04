'use strict';

/**
 * Builds the boot image on THIS computer from the user's own IPSW and the open parts of a release
 * (skeleton image + builder). The release carries nothing from Apple: the few Apple files the root
 * image needs (dyld, launchd job definitions) are taken out of the IPSW here and never leave the machine.
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function which(candidates, args = ['--version']) {
  for (const cmd of candidates) {
    const r = spawnSync(cmd[0], [...cmd.slice(1), ...args], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return { cmd, version: ((r.stdout || r.stderr).split('\n').find((l) => l.trim()) || '').trim() };
  }
  return null;
}

/** What the build needs on this computer. */
function check() {
  const python = which([['python3'], ['python'], ['py', '-3']]);
  const sevenZip = which([['7zz'], ['7z'], ['7za']], []);
  const tar = which([['tar']]);
  return {
    python: python && { cmd: python.cmd, version: python.version },
    sevenZip: sevenZip && { cmd: sevenZip.cmd[0], version: sevenZip.version },
    tar: !!tar,
    ok: !!(python && sevenZip && tar),
  };
}

function runLines(cmd, args, opts, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const feed = (buf) => {
      tail += buf.toString();
      const lines = tail.split(/\r?\n/);
      tail = lines.pop();
      lines.filter(Boolean).forEach(onLine);
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', reject);
    child.on('close', (code) => { if (tail) onLine(tail); if (code === 0) resolve(); else reject(new Error(`exit code ${code}`)); });
  });
}

/**
 * @param {{releaseDir:string, manifest:object, ipswPath:string, outDir:string}} p
 * @returns {Promise<{path:string}>}
 */
async function build(p, log) {
  const need = check();
  if (!need.ok) {
    const missing = [!need.python && 'Python 3', !need.sevenZip && '7-Zip 23 or newer (7z / 7zz)', !need.tar && 'tar'].filter(Boolean);
    throw new Error(`missing on this computer: ${missing.join(', ')}`);
  }
  const b = p.manifest.build;
  if (!b) throw new Error('this release has no image builder');
  if (!p.ipswPath || !fs.existsSync(p.ipswPath)) throw new Error('the iOS IPSW is not available: finish the Get iOS step first');
  const builder = path.join(p.releaseDir, b.builder);
  const skeleton = path.join(p.releaseDir, b.skeleton);
  for (const f of [builder, skeleton]) if (!fs.existsSync(f)) throw new Error(`${path.basename(f)} is not downloaded: run the Download step first`);

  const parts = path.join(p.outDir, 'parts');
  fs.rmSync(parts, { recursive: true, force: true });
  fs.mkdirSync(parts, { recursive: true });
  log(`build: unpacking ${b.builder}`);
  await runLines('tar', ['-xzf', builder, '-C', parts], {}, log);
  fs.copyFileSync(skeleton, path.join(parts, 'skeleton.img'));

  const out = path.join(p.outDir, 'rosemary_xnu_boot.img');
  fs.rmSync(out, { force: true });
  const [py, ...pyArgs] = need.python.cmd;
  log(`build: ${need.python.version}; ${need.sevenZip.version}`);
  await runLines(py, [...pyArgs, '-I', path.join(parts, 'build_image.py'), '--ipsw', p.ipswPath, '--parts', parts, '--out', out, '--work', path.join(p.outDir, 'work')],
    { cwd: p.outDir }, (line) => log(`build: ${line}`));
  if (!fs.existsSync(out)) throw new Error('the builder finished but wrote no image');
  return { path: out };
}

module.exports = { check, build };
