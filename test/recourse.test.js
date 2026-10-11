// AI-generated (Claude Code). Contract tests for the core money paths.
const { expect } = require("chai");
const { ethers } = require("hardhat");

const U = (n) => ethers.parseUnits(String(n), 6);
const id = (s) => ethers.id(s);

async function setup() {
  const [owner, agent, risk, arbiter, merchant, stranger] = await ethers.getSigners();
  const usd = await (await ethers.getContractFactory("MockUSD")).deploy();
  const rep = await (await ethers.getContractFactory("Reputation")).deploy();
  const escrow = await (await ethers.getContractFactory("RecourseEscrow")).deploy(usd, rep, arbiter.address);
  const wallet = await (await ethers.getContractFactory("AgentWallet")).deploy(usd, escrow, rep, agent.address, risk.address, U(25));
  await rep.setWriter(escrow, true);
  await rep.setWriter(wallet, true);
  await usd.mint(wallet, U(1000));
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  await wallet.setMandate(U(50), U(100), 0b11, now + 86400 * 7, ethers.ZeroHash);
  const cosign = async (pid, m, amt, route) =>
    risk.signMessage(ethers.getBytes(await wallet.coSignDigest(pid, m, amt, route)));
  return { owner, agent, risk, arbiter, merchant, stranger, usd, rep, escrow, wallet, cosign };
}

describe("Recourse", () => {
  it("settles a small low-risk payment instantly", async () => {
    const { agent, merchant, usd, wallet, rep } = await setup();
    await wallet.connect(agent).pay(id("p1"), merchant, U(10), 0, 0, 5, 0, "LOW", "0x");
    expect(await usd.balanceOf(merchant)).to.equal(U(10));
    expect((await rep.get(merchant)).settled).to.equal(1);
  });

  it("enforces the mandate caps and categories", async () => {
    const { agent, merchant, wallet } = await setup();
    await expect(wallet.connect(agent).pay(id("a"), merchant, U(60), 0, 0, 5, 0, "", "0x")).to.be.revertedWith("over per-tx cap");
    await expect(wallet.connect(agent).pay(id("b"), merchant, U(5), 4, 0, 5, 0, "", "0x")).to.be.revertedWith("category not allowed");
  });

  it("requires a risk co-signature for escrowed routes", async () => {
    const { agent, merchant, wallet, stranger } = await setup();
    const badSig = await stranger.signMessage(ethers.getBytes(await wallet.coSignDigest(id("c"), merchant.address, U(30), 2)));
    await expect(wallet.connect(agent).pay(id("c"), merchant, U(30), 0, 2, 70, 0, "", badSig)).to.be.revertedWith("bad risk co-signature");
  });

  it("escrows a risky payment and refunds the buyer on a won dispute", async () => {
    const { agent, arbiter, merchant, usd, escrow, wallet, rep, cosign } = await setup();
    const pid = id("p2");
    await wallet.connect(agent).pay(pid, merchant, U(40), 1, 2, 72, 3600, "NEW_WALLET", await cosign(pid, merchant.address, U(40), 2));
    expect(await escrow.totalHeld()).to.equal(U(40));
    await expect(escrow.connect(arbiter).release(pid)).to.be.revertedWith("locked");
    await escrow.connect(arbiter).dispute(pid, 1);
    await escrow.connect(arbiter).resolve(pid, true, "INR: no delivery proof");
    expect(await usd.balanceOf(wallet)).to.equal(U(1000));
    expect((await rep.get(merchant)).disputesLost).to.equal(1);
  });

  it("releases a delivery-escrow payment once delivery is confirmed", async () => {
    const { agent, arbiter, merchant, usd, escrow, wallet, cosign } = await setup();
    const pid = id("p3");
    await wallet.connect(agent).pay(pid, merchant, U(30), 0, 2, 65, 3600, "", await cosign(pid, merchant.address, U(30), 2));
    await escrow.connect(merchant).confirmDelivery(pid, id("tracking:DELIVERED"));
    await escrow.connect(arbiter).release(pid);
    expect(await usd.balanceOf(merchant)).to.equal(U(30));
  });

  it("only lets the arbiter resolve, and only to payer or merchant", async () => {
    const { agent, arbiter, merchant, stranger, escrow, wallet, cosign } = await setup();
    const pid = id("p4");
    await wallet.connect(agent).pay(pid, merchant, U(20), 0, 1, 40, 3600, "", await cosign(pid, merchant.address, U(20), 1));
    await escrow.connect(arbiter).dispute(pid, 1);
    await expect(escrow.connect(stranger).resolve(pid, true, "")).to.be.revertedWith("not arbiter");
  });
});
