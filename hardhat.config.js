// AI-generated (Claude Code). Hardhat config for Recourse.
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
const { getSecret } = require("./backend/secrets");

const networks = {};
const bscKey = getSecret("recourse-deployer-key");
if (bscKey) {
  networks.bscTestnet = {
    url: process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
    chainId: 97,
    accounts: [bscKey],
  };
}

module.exports = {
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true } },
  networks,
};
