// SPDX-License-Identifier: MIT
// AI-generated (Claude Code). Risk-tiered escrow with a limited arbiter:
// the arbiter can only refund the original payer or release to the merchant.
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./Reputation.sol";

contract RecourseEscrow {
    using SafeERC20 for IERC20;

    enum Status { None, Held, Disputed, Released, Refunded }

    struct Hold {
        address payer;
        address merchant;
        uint256 amount;
        uint64 releaseAfter;
        bool needsDelivery;
        bool delivered;
        bytes32 deliveryProof;
        uint8 reasonCode;
        Status status;
    }

    IERC20 public immutable token;
    Reputation public immutable reputation;
    address public immutable arbiter;

    mapping(bytes32 => Hold) public holds;
    uint256 public totalHeld;

    event Held(bytes32 indexed id, address indexed payer, address indexed merchant, uint256 amount, uint64 releaseAfter, bool needsDelivery);
    event DeliveryConfirmed(bytes32 indexed id, bytes32 proof);
    event Disputed(bytes32 indexed id, uint8 reasonCode);
    event Released(bytes32 indexed id, address indexed merchant, uint256 amount);
    event Refunded(bytes32 indexed id, address indexed payer, uint256 amount);
    event Resolved(bytes32 indexed id, bool buyerWins, string rationale);

    constructor(IERC20 _token, Reputation _reputation, address _arbiter) {
        token = _token;
        reputation = _reputation;
        arbiter = _arbiter;
    }

    function hold(bytes32 id, address merchant, uint256 amount, uint64 window, bool needsDelivery) external {
        require(holds[id].status == Status.None, "exists");
        require(amount > 0 && merchant != address(0), "bad args");
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint64 releaseAfter = uint64(block.timestamp) + window;
        holds[id] = Hold(msg.sender, merchant, amount, releaseAfter, needsDelivery, false, bytes32(0), 0, Status.Held);
        totalHeld += amount;
        emit Held(id, msg.sender, merchant, amount, releaseAfter, needsDelivery);
    }

    /// Delivery attestation from the merchant or the delivery oracle (arbiter).
    function confirmDelivery(bytes32 id, bytes32 proof) external {
        Hold storage h = holds[id];
        require(h.status == Status.Held || h.status == Status.Disputed, "not open");
        require(msg.sender == h.merchant || msg.sender == arbiter, "not allowed");
        h.delivered = true;
        h.deliveryProof = proof;
        emit DeliveryConfirmed(id, proof);
    }

    function canRelease(bytes32 id) public view returns (bool) {
        Hold storage h = holds[id];
        if (h.status != Status.Held) return false;
        if (h.needsDelivery) return h.delivered;
        return block.timestamp >= h.releaseAfter;
    }

    /// Anyone can release once conditions are met; the payer can release early.
    function release(bytes32 id) external {
        Hold storage h = holds[id];
        require(h.status == Status.Held, "not held");
        require(canRelease(id) || msg.sender == h.payer, "locked");
        _payMerchant(id, h);
        reputation.record(h.merchant, h.payer, id, Reputation.Outcome.Settled);
        reputation.record(h.payer, h.merchant, id, Reputation.Outcome.Settled);
    }

    function dispute(bytes32 id, uint8 reasonCode) external {
        Hold storage h = holds[id];
        require(h.status == Status.Held, "not held");
        require(msg.sender == h.payer || msg.sender == arbiter, "not allowed");
        h.status = Status.Disputed;
        h.reasonCode = reasonCode;
        emit Disputed(id, reasonCode);
    }

    /// Limited arbiter: refund to the original payer, or release to the merchant. Nothing else.
    function resolve(bytes32 id, bool buyerWins, string calldata rationale) external {
        require(msg.sender == arbiter, "not arbiter");
        Hold storage h = holds[id];
        require(h.status == Status.Disputed, "not disputed");
        if (buyerWins) {
            h.status = Status.Refunded;
            totalHeld -= h.amount;
            token.safeTransfer(h.payer, h.amount);
            emit Refunded(id, h.payer, h.amount);
            reputation.record(h.payer, h.merchant, id, Reputation.Outcome.DisputeWon);
            reputation.record(h.merchant, h.payer, id, Reputation.Outcome.DisputeLost);
        } else {
            _payMerchant(id, h);
            reputation.record(h.merchant, h.payer, id, Reputation.Outcome.DisputeWon);
            reputation.record(h.payer, h.merchant, id, Reputation.Outcome.DisputeLost);
        }
        emit Resolved(id, buyerWins, rationale);
    }

    function _payMerchant(bytes32 id, Hold storage h) private {
        h.status = Status.Released;
        totalHeld -= h.amount;
        token.safeTransfer(h.merchant, h.amount);
        emit Released(id, h.merchant, h.amount);
    }
}
