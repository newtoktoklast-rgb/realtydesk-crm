// In-app update manifest for the Tauri desktop client.
//
// The client's updater plugin calls this endpoint on startup. When a newer
// release is available we return a Tauri updater manifest; otherwise 204.
//
// Configure a new release by setting these env vars on the server:
//   LATEST_CLIENT_VERSION   e.g. "0.2.0"
//   LATEST_CLIENT_URL        direct download URL of the signed installer
//   LATEST_CLIENT_SIGNATURE  minisign signature of that installer
//   LATEST_CLIENT_NOTES      (optional) release notes
//   LATEST_CLIENT_PUB_DATE   (optional) ISO date
const express = require('express');

const router = express.Router();

function cmpVersion(a, b) {
  const pa = String(a || '0').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split('.').map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

router.get('/:target/:arch/:currentVersion', (req, res) => {
  const latestVersion = process.env.LATEST_CLIENT_VERSION;
  const url = process.env.LATEST_CLIENT_URL;
  const signature = process.env.LATEST_CLIENT_SIGNATURE;

  if (!latestVersion || !url || !signature) {
    return res.status(204).end();
  }

  const currentVersion = decodeURIComponent(req.params.currentVersion || '');
  if (cmpVersion(currentVersion, latestVersion) >= 0) {
    return res.status(204).end();
  }

  const target = req.params.target;
  const arch = req.params.arch;
  const platformKey = `${target}-${arch}`;

  res.json({
    version: latestVersion,
    notes: process.env.LATEST_CLIENT_NOTES || '',
    pub_date: process.env.LATEST_CLIENT_PUB_DATE || new Date().toISOString(),
    platforms: {
      [platformKey]: {
        signature,
        url,
      },
    },
  });
});

module.exports = router;
