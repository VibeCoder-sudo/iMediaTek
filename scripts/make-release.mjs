#!/usr/bin/env node
// Builds version.json for a release from a directory of release files.
//
//   node scripts/make-release.mjs <version> <dir-with-files> [--channel stable] [--notes "text"]
//
// The result is written to <dir>/version.json. Upload every file in <dir>, including version.json,
// as assets of the GitHub release v<version>. The app downloads
// https://github.com/<owner>/<repo>/releases/latest/download/version.json directly.

import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OWNER = 'VibeCoder-sudo';
const REPO = 'iMediaTek';

const ROLES = {
  'rosemary_xnu_skeleton.img': 'Boot image skeleton: DirectBoot + XNU, empty root-image slot (no Apple files)',
  'imediatek-builder.tar.gz': 'Image builder: overlay of our files + scripts that build the root image from your IPSW',
};

function usage(message) {
  if (message) console.error(`error: ${message}\n`);
  console.error('usage: make-release.mjs <version> <dir> [--channel stable] [--notes "text"]');
  process.exit(2);
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const sha = createHash('sha256');
    const md5 = createHash('md5');
    createReadStream(file)
      .on('data', (chunk) => { sha.update(chunk); md5.update(chunk); })
      .on('error', reject)
      .on('end', () => resolve({ sha256: sha.digest('hex'), md5: md5.digest('hex') }));
  });
}

const args = process.argv.slice(2);
const version = args[0];
const dir = args[1];
if (!version || !dir) usage();
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) usage('version must be semver, for example 0.1.0');

const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const template = JSON.parse(readFileSync(new URL('../data/demo-manifest.json', import.meta.url), 'utf8'));
const files = readdirSync(dir).filter((name) => name !== 'version.json' && statSync(join(dir, name)).isFile());
if (files.length === 0) usage(`no files in ${dir}`);

const assets = [];
for (const name of files.sort()) {
  const { sha256, md5 } = await hashFile(join(dir, name));
  assets.push({
    name,
    role: ROLES[name] || '',
    url: `https://github.com/${OWNER}/${REPO}/releases/download/v${version}/${name}`,
    size: statSync(join(dir, name)).size,
    sha256,
    ...(name.endsWith('.img') ? { md5 } : {}),
  });
}

const manifest = {
  schema: 1,
  name: 'iMediaTek PoC',
  version,
  channel: option('--channel', 'stable'),
  released: new Date().toISOString(),
  notes: option('--notes', ''),
  device: template.device,
  target: template.target,
  protected: template.protected,
  profiles: template.profiles,
  ipsw: template.ipsw,
  ...(files.includes('rosemary_xnu_skeleton.img') && files.includes('imediatek-builder.tar.gz') ? { build: template.build } : {}),
  assets,
};

writeFileSync(join(dir, 'version.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${join(dir, 'version.json')} (${assets.length} files)`);
