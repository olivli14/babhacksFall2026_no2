// AI-generated (Claude Code). One command for the local demo: Hardhat node + deploy + backend.
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const root = path.join(__dirname, "..");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

const node = spawn(npx, ["hardhat", "node"], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
let started = false;
node.stdout.on("data", (d) => {
  if (started || !/Started HTTP/.test(String(d))) return;
  started = true;
  const dep = spawnSync(npx, ["hardhat", "run", "scripts/deploy.js", "--network", "localhost"], { cwd: root, stdio: "inherit" });
  if (dep.status !== 0) { node.kill(); process.exit(1); }
  const srv = spawn(process.execPath, ["backend/server.js"], { cwd: root, stdio: "inherit", env: { ...process.env, RECOURSE_NETWORK: "localhost" } });
  srv.on("exit", () => node.kill());
});
const stop = () => { node.kill(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
