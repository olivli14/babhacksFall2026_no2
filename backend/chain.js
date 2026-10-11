// AI-generated (Claude Code). Thin ethers v6 adapter over the deployed Recourse contracts.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { getSecret } = require("./secrets");

const NETWORK = process.env.RECOURSE_NETWORK || "localhost";
const ROOT = path.join(__dirname, "..");
const U = (n) => ethers.parseUnits(Number(n).toFixed(6), 6);
const fromU = (v) => Number(ethers.formatUnits(v, 6));

const CONFIG = {
  localhost: { rpc: "http://127.0.0.1:8545", file: "localhost.local.json", explorer: null },
  bscTestnet: { rpc: process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.bnbchain.org:8545", file: "bscTestnet.json", explorer: "https://testnet.bscscan.com" },
}[NETWORK];
if (!CONFIG) throw new Error(`Unknown RECOURSE_NETWORK ${NETWORK}`);

function abi(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "artifacts/contracts", `${name}.sol`, `${name}.json`))).abi;
}

function loadKeys(provider) {
  if (NETWORK === "localhost") {
    // Hardhat's public default dev mnemonic. Local chain only; these keys hold nothing real.
    const phrase = "test test test test test test test test test test test junk";
    const k = (i) => ethers.HDNodeWallet.fromPhrase(phrase, undefined, `m/44'/60'/0'/0/${i}`).connect(provider);
    return { owner: k(0), agent: k(1), risk: k(2), arbiter: k(3) };
  }
  const deployer = getSecret("recourse-deployer-key");
  if (!deployer) throw new Error("Missing keychain item recourse-deployer-key (see README)");
  // Roles without their own key fall back to the deployer; Chain.send serializes writes so nonces don't collide.
  const k = (svc) => new ethers.Wallet(getSecret(svc) || deployer, provider);
  return { owner: k("recourse-deployer-key"), agent: k("recourse-agent-key"), risk: k("recourse-risk-key"), arbiter: k("recourse-arbiter-key") };
}

class Chain {
  constructor() {
    const file = path.join(ROOT, "deployments", CONFIG.file);
    if (!fs.existsSync(file)) throw new Error(`No deployment at ${file}. Run the deploy script first.`);
    this.deployment = JSON.parse(fs.readFileSync(file));
    this.provider = new ethers.JsonRpcProvider(CONFIG.rpc, undefined, { cacheTimeout: -1 });
    this.keys = loadKeys(this.provider);
    const c = this.deployment.contracts;
    this.usd = new ethers.Contract(c.MockUSD, abi("MockUSD"), this.provider);
    this.rep = new ethers.Contract(c.Reputation, abi("Reputation"), this.provider);
    this.escrow = new ethers.Contract(c.RecourseEscrow, abi("RecourseEscrow"), this.provider);
    this.wallet = new ethers.Contract(c.AgentWallet, abi("AgentWallet"), this.provider);
    this.queue = Promise.resolve();
    this.network = NETWORK;
  }

  // Serialize writes: on testnet several roles can share one key.
  send(fn) {
    const run = this.queue.then(async () => {
      const tx = await fn();
      const rcpt = await tx.wait();
      return { hash: rcpt.hash, url: this.txUrl(rcpt.hash) };
    });
    this.queue = run.catch(() => {});
    return run;
  }

  txUrl(hash) { return CONFIG.explorer ? `${CONFIG.explorer}/tx/${hash}` : null; }
  addrUrl(a) { return CONFIG.explorer ? `${CONFIG.explorer}/address/${a}` : null; }

  setMandate(m, categoryMask, mandateHash) {
    return this.send(() => this.wallet.connect(this.keys.owner).setMandate(U(m.perTxCap), U(m.dailyCap), categoryMask, m.expiry, mandateHash));
  }

  async pay({ pid, merchant, amount, category, route, score, window, reasons }) {
    const digest = await this.wallet.coSignDigest(pid, merchant, U(amount), route);
    const sig = await this.keys.risk.signMessage(ethers.getBytes(digest));
    return this.send(() => this.wallet.connect(this.keys.agent).pay(pid, merchant, U(amount), category, route, score, window, reasons, sig));
  }

  logBlocked({ pid, merchant, amount, score, reasons }) {
    return this.send(() => this.wallet.connect(this.keys.agent).logBlocked(pid, merchant, U(amount), score, reasons));
  }

  dispute(pid, code) { return this.send(() => this.escrow.connect(this.keys.arbiter).dispute(pid, code)); }
  resolve(pid, buyerWins, rationale) { return this.send(() => this.escrow.connect(this.keys.arbiter).resolve(pid, buyerWins, rationale)); }
  confirmDelivery(pid, proof) { return this.send(() => this.escrow.connect(this.keys.arbiter).confirmDelivery(pid, proof)); }
  release(pid) { return this.send(() => this.escrow.connect(this.keys.arbiter).release(pid)); }

  async fastForward(seconds) {
    if (NETWORK !== "localhost") throw new Error("Time travel only works on the local chain");
    await this.provider.send("evm_increaseTime", [seconds]);
    await this.provider.send("evm_mine", []);
  }

  async repOf(a) {
    const r = await this.rep.get(a);
    return { settled: Number(r.settled), refunded: Number(r.refunded), disputesWon: Number(r.disputesWon), disputesLost: Number(r.disputesLost) };
  }

  async balanceOf(a) { return fromU(await this.usd.balanceOf(a)); }

  async snapshot(merchantAddrs) {
    const walletAddr = this.deployment.contracts.AgentWallet;
    const [walletBal, held, spentToday, buyerRep] = await Promise.all([
      this.balanceOf(walletAddr), this.escrow.totalHeld().then(fromU), this.wallet.spentToday().then(fromU), this.repOf(walletAddr),
    ]);
    const merchants = {};
    await Promise.all(Object.entries(merchantAddrs).map(async ([id, a]) => {
      merchants[id] = { balance: await this.balanceOf(a), rep: await this.repOf(a) };
    }));
    return { walletBal, held, spentToday, buyerRep, merchants };
  }
}

module.exports = { Chain, U, fromU };
