'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const ipswLib = require('./ipsw');

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function hostAllowed(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && config.ALLOWED_HOSTS.includes(parsed.hostname);
  } catch (error) {
    return false;
  }
}

/** Throws with a readable message when the manifest is not safe to act on. */
function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('version.json is not an object');
  if (manifest.schema !== 1) throw new Error(`unsupported manifest schema: ${manifest.schema}`);
  if (!SEMVER.test(manifest.version || '')) throw new Error('version is not semver');
  if (!manifest.target || manifest.target.slot !== 'boot_a') {
    throw new Error('the manifest must target boot_a');
  }
  const protectedSlots = new Set(manifest.protected || []);
  for (const slot of ['boot_b', 'userdata']) {
    if (!protectedSlots.has(slot)) throw new Error(`${slot} must be listed as protected`);
  }
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    throw new Error('the manifest lists no assets');
  }
  const seen = new Set();
  for (const asset of manifest.assets) {
    if (!SAFE_NAME.test(asset.name || '')) throw new Error(`unsafe asset name: ${asset.name}`);
    if (seen.has(asset.name)) throw new Error(`duplicate asset: ${asset.name}`);
    seen.add(asset.name);
    if (!Number.isInteger(asset.size) || asset.size <= 0) throw new Error(`${asset.name}: bad size`);
    if (!HEX64.test(asset.sha256 || '')) throw new Error(`${asset.name}: sha256 is required`);
    if (asset.md5 !== undefined && !HEX32.test(asset.md5)) throw new Error(`${asset.name}: bad md5`);
    if (!manifest.demo && !hostAllowed(asset.url)) {
      throw new Error(`${asset.name}: url host is not allowed`);
    }
  }
  if (manifest.ipsw !== undefined) ipswLib.validateIpsw(manifest.ipsw);
  if (manifest.build !== undefined) {
    for (const key of ['skeleton', 'builder']) {
      if (!seen.has(manifest.build[key])) throw new Error(`build.${key} must name an asset of this release`);
    }
  }
  return manifest;
}

function readDemoManifest() {
  const file = path.join(__dirname, '..', '..', 'data', 'demo-manifest.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Downloads version.json straight from the latest release. If the release does not exist yet
 * (or there is no network) the bundled demo manifest is returned, flagged `demo: true`.
 */
async function fetchManifest() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.MANIFEST_TIMEOUT_MS);
  try {
    const response = await fetch(config.MANIFEST_URL, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'iMediaTek-flasher' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!hostAllowed(response.url)) throw new Error(`redirected to ${new URL(response.url).hostname}`);
    const remote = await response.json();
    if (remote && remote.demo) throw new Error('a published manifest must not be a demo manifest');
    const manifest = validateManifest(remote);
    return { source: 'remote', url: config.MANIFEST_URL, manifest };
  } catch (error) {
    const manifest = validateManifest(readDemoManifest());
    return { source: 'demo', url: config.MANIFEST_URL, error: String(error.message || error), manifest };
  } finally {
    clearTimeout(timer);
  }
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const sha = crypto.createHash('sha256');
    const md5 = crypto.createHash('md5');
    fs.createReadStream(file)
      .on('data', (chunk) => { sha.update(chunk); md5.update(chunk); })
      .on('error', reject)
      .on('end', () => resolve({ sha256: sha.digest('hex'), md5: md5.digest('hex') }));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function simulateAsset(asset, onProgress) {
  const steps = 20;
  for (let i = 1; i <= steps; i += 1) {
    await sleep(60);
    onProgress({ name: asset.name, phase: 'download', received: Math.round((asset.size * i) / steps), total: asset.size });
  }
  onProgress({ name: asset.name, phase: 'verify', received: asset.size, total: asset.size });
  await sleep(250);
  return { name: asset.name, ok: true, simulated: true, sha256: asset.sha256, md5: asset.md5 || null, path: null };
}

async function downloadAsset(asset, dir, onProgress) {
  const finalPath = path.join(dir, asset.name);
  const partPath = `${finalPath}.part`;

  if (fs.existsSync(finalPath)) {
    onProgress({ name: asset.name, phase: 'verify', received: asset.size, total: asset.size });
    const known = await hashFile(finalPath);
    if (known.sha256 === asset.sha256) {
      return { name: asset.name, ok: true, cached: true, ...known, path: finalPath };
    }
    fs.rmSync(finalPath, { force: true });
  }

  const response = await fetch(asset.url, { redirect: 'follow', headers: { 'user-agent': 'iMediaTek-flasher' } });
  if (!response.ok) throw new Error(`${asset.name}: HTTP ${response.status}`);
  if (!hostAllowed(response.url)) throw new Error(`${asset.name}: redirected to a host that is not allowed`);

  const sha = crypto.createHash('sha256');
  const md5 = crypto.createHash('md5');
  const out = fs.createWriteStream(partPath);
  let received = 0;
  try {
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > asset.size) throw new Error(`${asset.name}: larger than the manifest says`);
      sha.update(chunk);
      md5.update(chunk);
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      onProgress({ name: asset.name, phase: 'download', received, total: asset.size });
    }
    await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
  } catch (error) {
    out.destroy();
    fs.rmSync(partPath, { force: true });
    throw error;
  }

  onProgress({ name: asset.name, phase: 'verify', received, total: asset.size });
  const digest = { sha256: sha.digest('hex'), md5: md5.digest('hex') };
  if (received !== asset.size || digest.sha256 !== asset.sha256 || (asset.md5 && digest.md5 !== asset.md5)) {
    fs.rmSync(partPath, { force: true });
    return { name: asset.name, ok: false, error: 'hash or size mismatch', ...digest, path: null };
  }
  fs.renameSync(partPath, finalPath);
  return { name: asset.name, ok: true, ...digest, path: finalPath };
}

/** Downloads every asset of the manifest, one at a time, into userData/releases/<version>. */
async function downloadRelease(manifest, userData, onProgress) {
  validateManifest(manifest);
  const dir = path.join(userData, 'releases', manifest.version);
  if (!manifest.demo) fs.mkdirSync(dir, { recursive: true });
  const results = [];
  for (const asset of manifest.assets) {
    results.push(manifest.demo ? await simulateAsset(asset, onProgress) : await downloadAsset(asset, dir, onProgress));
  }
  return { dir: manifest.demo ? null : dir, results, ok: results.every((r) => r.ok) };
}

module.exports = { fetchManifest, downloadRelease, validateManifest, hashFile };
