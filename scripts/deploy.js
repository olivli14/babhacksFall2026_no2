// AI-generated (Claude Code). Deploys MockUSD, Reputation, RecourseEscrow, AgentWallet and funds the wallet.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const { ethers, network } = hre;
  const signers = await ethers.getSigners();
  const owner = signers[0];
  // Locally each role gets its own key. On testnet the deployer plays every role
  // unless separate keys are stored in the keychain (see README).
  const agent = signers[1] || owner;
  const riskSigner = signers[2] || owner;
  const arbiter = signers[3] || owner;

  const usd = await (await ethers.getContractFactory("MockUSD")).deploy();
  await usd.waitForDeployment();
  const rep = await (await ethers.getContractFactory("Reputation")).deploy();
  await rep.waitForDeployment();
  const escrow = await (await ethers.getContractFactory("RecourseEscrow")).deploy(
    await usd.getAddress(), await rep.getAddress(), arbiter.address);
  await escrow.waitForDeployment();
  const threshold = ethers.parseUnits("25", 6);
  const wallet = await (await ethers.getContractFactory("AgentWallet")).deploy(
    await usd.getAddress(), await escrow.getAddress(), await rep.getAddress(),
    agent.address, riskSigner.address, threshold);
  await wallet.waitForDeployment();

  await (await rep.setWriter(await escrow.getAddress(), true)).wait();
  await (await rep.setWriter(await wallet.getAddress(), true)).wait();
  await (await usd.mint(await wallet.getAddress(), ethers.parseUnits("1000", 6))).wait();

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    contracts: {
      MockUSD: await usd.getAddress(),
      Reputation: await rep.getAddress(),
      RecourseEscrow: await escrow.getAddress(),
      AgentWallet: await wallet.getAddress(),
    },
    roles: { owner: owner.address, agent: agent.address, riskSigner: riskSigner.address, arbiter: arbiter.address },
  };
  const suffix = network.name === "localhost" || network.name === "hardhat" ? "local" : network.name;
  const file = path.join(__dirname, "..", "deployments", `${suffix === "local" ? "localhost.local" : suffix}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.log("wrote", file);
}

main().catch((e) => { console.error(e); process.exit(1); });
