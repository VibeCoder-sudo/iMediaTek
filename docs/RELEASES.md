# Release format

A release is a GitHub release tagged `v<version>` that contains the payload files **and** a `version.json`. The installer never calls the GitHub API: it downloads files by URL.

## `version.json`

```json
{
  "schema": 1,
  "name": "iMediaTek PoC",
  "version": "0.1.0",
  "channel": "stable",
  "released": "2026-11-04T00:00:00Z",
  "notes": "Short release notes.",
  "device": { "codename": "rosemary", "model": "POCO M5s", "soc": "MediaTek Helio G95 (MT6785)", "gpu": "Mali-G76 MC4" },
  "target": { "slot": "boot_a", "partition": "/dev/sdc36" },
  "protected": ["boot_b", "userdata"],
  "profiles": [
    { "id": "stable", "title": "Stable", "subtitle": "CPU rendering", "image": "rosemary_xnu_boot.img", "bootArgs": "..." }
  ],
  "ipsw": {
    "device": "iPhone10,3 / iPhone10,6",
    "version": "16.5",
    "build": "20F66",
    "file": "iPhone10,3,iPhone10,6_16.5_20F66_Restore.ipsw",
    "url": "https://updates.cdn-apple.com/.../iPhone10,3,iPhone10,6_16.5_20F66_Restore.ipsw",
    "size": 6165698198,
    "sha256": "<64 hex characters>",
    "source": "Apple CDN (updates.cdn-apple.com)"
  },
  "assets": [
    {
      "name": "rosemary_xnu_boot.img",
      "role": "Boot image for boot_a",
      "url": "https://github.com/VibeCoder-sudo/iMediaTek/releases/download/v0.1.0/rosemary_xnu_boot.img",
      "size": 28409344,
      "sha256": "<64 hex characters>",
      "md5": "<32 hex characters, boot image only>"
    }
  ]
}
```

### Rules the installer enforces

- `schema` is `1`; `version` is semver.
- `target.slot` is `boot_a`; `protected` lists `boot_b` and `userdata`. A manifest that does not is rejected.
- Asset names match `[A-Za-z0-9][A-Za-z0-9._-]*` (no paths).
- Every asset has an integer `size` and a `sha256`. `md5` is optional (the boot image carries it because the on-phone flasher compares MD5).
- Asset URLs are `https` and end up on `github.com`, `objects.githubusercontent.com` or `release-assets.githubusercontent.com` after redirects.
- The optional `ipsw` block points at Apple, never at this repository: `url` must be https on `updates.cdn-apple.com` or `appldnld.apple.com` (also after redirects), `file` is a safe `.ipsw` name, `size` and `sha256` are required. The IPSW is downloaded by the app directly from Apple, resumed with HTTP Range, and accepted only when the SHA-256 matches; a mismatch deletes the partial file.
- A published manifest must not contain `"demo": true`.
- While downloading, bytes are counted and hashed; a file larger than `size`, or with a different hash, is deleted and reported as a mismatch.

## Publishing a release

1. Put the payload in a directory, for example `release-files/`:
   `rosemary_xnu_skeleton.img` and `imediatek-builder.tar.gz` (made by `release/make_parts.py` in the main source tree; no Apple files). The manifest then gets a `build` block naming both assets; the app builds `rosemary_xnu_boot.img` locally from them and the user's IPSW.
2. Generate the manifest (sizes and hashes are computed for you):
   ```bash
   node scripts/make-release.mjs 0.1.0 release-files --channel stable --notes "First preview"
   ```
3. Create the release and upload **every file, including `version.json`**:
   ```bash
   gh release create v0.1.0 release-files/* --title "iMediaTek 0.1.0" --notes "First preview"
   ```
4. The installer picks it up through
   `https://github.com/VibeCoder-sudo/iMediaTek/releases/latest/download/version.json`.

Pre-releases are not returned by `releases/latest`; publish a normal release for the feed.

## Planned

- A detached signature (`version.json.minisig`) checked against a key bundled in the app, so a hash list cannot be swapped by whoever controls the release page.
- Delta downloads for the boot image.
