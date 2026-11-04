'use strict';

const OWNER = 'VibeCoder-sudo';
const REPO = 'iMediaTek';

module.exports = {
  OWNER,
  REPO,
  REPO_URL: `https://github.com/${OWNER}/${REPO}`,
  // Direct download of the manifest from the latest release. This is a plain file URL, NOT the
  // REST API, so it does not count against the API rate limit.
  MANIFEST_URL: `https://github.com/${OWNER}/${REPO}/releases/latest/download/version.json`,
  // Asset URLs in a manifest must be https and end up on one of these hosts (after redirects).
  ALLOWED_HOSTS: [
    'github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
  ],
  MANIFEST_TIMEOUT_MS: 10000,
};
