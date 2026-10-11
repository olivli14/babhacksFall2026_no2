// SPDX-License-Identifier: MIT
// AI-generated (Claude Code). Agent wallet that enforces the human's spending mandate onchain
// and requires a risk-engine co-signature above a threshold or for escrowed routes.
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "./RecourseEscrow.sol";
import "./Reputation.sol";

contract AgentWallet {
    using SafeERC20 for IERC20;

    uint8 public constant ROUTE_INSTANT = 0;
    uint8 public constant ROUTE_TIMED_ESCROW = 1;
    uint8 public constant ROUTE_DELIVERY_ESCROW = 2;

    struct Mandate {
        uint256 perTxCap;
        uint256 dailyCap;
        uint256 categoryMask; // bit i set => category i allowed
        uint64 expiry;
        bytes32 mandateHash;  // hash of the human-readable mandate (from voice)
    }

    IERC20 public immutable token;
    RecourseEscrow public immutable escrow;
    Reputation public immutable reputation;
    address public immutable owner;   // the human
    address public agent;             // the AI agent's key
    address public riskSigner;        // risk engine co-signer
    uint256 public coSignThreshold;

    Mandate public mandate;
    uint256 public currentDay;
    uint256 public spentToday;
    mapping(bytes32 => bool) public usedPaymentIds;

    event MandateSet(uint256 perTxCap, uint256 dailyCap, uint256 categoryMask, uint64 expiry, bytes32 mandateHash);
    event PaymentRouted(bytes32 indexed id, address indexed merchant, uint256 amount, uint8 category, uint8 route, uint16 riskScore, string reasons);
    event PaymentBlocked(bytes32 indexed id, address indexed merchant, uint256 amount, uint16 riskScore, string reasons);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier onlyAgent() { require(msg.sender == agent, "not agent"); _; }

    constructor(IERC20 _token, RecourseEscrow _escrow, Reputation _rep, address _agent, address _riskSigner, uint256 _coSignThreshold) {
        token = _token;
        escrow = _escrow;
        reputation = _rep;
        owner = msg.sender;
        agent = _agent;
        riskSigner = _riskSigner;
        coSignThreshold = _coSignThreshold;
    }

    function setMandate(uint256 perTxCap, uint256 dailyCap, uint256 categoryMask, uint64 expiry, bytes32 mandateHash) external onlyOwner {
        mandate = Mandate(perTxCap, dailyCap, categoryMask, expiry, mandateHash);
        emit MandateSet(perTxCap, dailyCap, categoryMask, expiry, mandateHash);
    }

    function setKeys(address _agent, address _riskSigner, uint256 _threshold) external onlyOwner {
        agent = _agent;
        riskSigner = _riskSigner;
        coSignThreshold = _threshold;
    }

    function coSignDigest(bytes32 id, address merchant, uint256 amount, uint8 route) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), id, merchant, amount, route));
    }

    function pay(
        bytes32 id,
        address merchant,
        uint256 amount,
        uint8 category,
        uint8 route,
        uint16 riskScore,
        uint64 escrowWindow,
        string calldata reasons,
        bytes calldata riskSig
    ) external onlyAgent {
        require(!usedPaymentIds[id], "duplicate payment");
        usedPaymentIds[id] = true;

        Mandate memory m = mandate;
        require(block.timestamp < m.expiry, "mandate expired");
        require(amount <= m.perTxCap, "over per-tx cap");
        require(category < 256 && (m.categoryMask >> category) & 1 == 1, "category not allowed");

        uint256 day = block.timestamp / 1 days;
        if (day != currentDay) {
            currentDay = day;
            spentToday = 0;
        }
        require(spentToday + amount <= m.dailyCap, "over daily cap");
        spentToday += amount;

        if (amount >= coSignThreshold || route != ROUTE_INSTANT) {
            bytes32 digest = MessageHashUtils.toEthSignedMessageHash(coSignDigest(id, merchant, amount, route));
            require(ECDSA.recover(digest, riskSig) == riskSigner, "bad risk co-signature");
        }

        if (route == ROUTE_INSTANT) {
            token.safeTransfer(merchant, amount);
            reputation.record(merchant, address(this), id, Reputation.Outcome.Settled);
            reputation.record(address(this), merchant, id, Reputation.Outcome.Settled);
        } else {
            require(route <= ROUTE_DELIVERY_ESCROW, "bad route");
            token.forceApprove(address(escrow), amount);
            escrow.hold(id, merchant, amount, escrowWindow, route == ROUTE_DELIVERY_ESCROW);
        }
        emit PaymentRouted(id, merchant, amount, category, route, riskScore, reasons);
    }

    /// Audit trail for payments the risk engine refused before they reached the chain's money paths.
    function logBlocked(bytes32 id, address merchant, uint256 amount, uint16 riskScore, string calldata reasons) external onlyAgent {
        require(!usedPaymentIds[id], "duplicate payment");
        usedPaymentIds[id] = true;
        emit PaymentBlocked(id, merchant, amount, riskScore, reasons);
    }

    function disputePayment(bytes32 id, uint8 reasonCode) external {
        require(msg.sender == owner || msg.sender == agent, "not allowed");
        escrow.dispute(id, reasonCode);
    }

    function balance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }
}
