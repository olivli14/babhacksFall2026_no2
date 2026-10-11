// SPDX-License-Identifier: MIT
// AI-generated (Claude Code). Test stablecoin for BSC Testnet demos. Not a real asset.
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSD is ERC20 {
    constructor() ERC20("Mock USD", "mUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// Open faucet: testnet only.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
