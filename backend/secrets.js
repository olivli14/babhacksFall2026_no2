// AI-generated (Claude Code). Reads secrets from the macOS keychain (never from source or .env).
// Store one with:  security add-generic-password -a "$USER" -s recourse-deployer-key -w '<value>'
const { execFileSync } = require("child_process");

const cache = {};
function getSecret(service) {
  if (service in cache) return cache[service];
  let value = null;
  if (process.platform === "darwin") {
    try {
      value = execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
        stdio: ["ignore", "pipe", "ignore"],
      }).toString().trim() || null;
    } catch (_) { value = null; }
  }
  cache[service] = value;
  return value;
}

module.exports = { getSecret };
