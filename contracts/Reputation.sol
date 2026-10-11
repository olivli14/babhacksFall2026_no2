// SPDX-License-Identifier: MIT
// AI-generated (Claude Code). Onchain outcome log for buyers and merchants.
pragma solidity ^0.8.24;

contract Reputation {
    enum Outcome { Settled, Refunded, DisputeWon, DisputeLost }

    struct Record {
        uint32 settled;
        uint32 refunded;
        uint32 disputesWon;
        uint32 disputesLost;
    }

    address public owner;
    mapping(address => bool) public writers;
    mapping(address => Record) public records;

    event WriterSet(address indexed writer, bool allowed);
    event OutcomeRecorded(address indexed subject, address indexed counterparty, bytes32 indexed paymentId, Outcome outcome);

    constructor() {
        owner = msg.sender;
    }

    function setWriter(address writer, bool allowed) external {
        require(msg.sender == owner, "not owner");
        writers[writer] = allowed;
        emit WriterSet(writer, allowed);
    }

    function record(address subject, address counterparty, bytes32 paymentId, Outcome outcome) external {
        require(writers[msg.sender], "not writer");
        Record storage r = records[subject];
        if (outcome == Outcome.Settled) r.settled++;
        else if (outcome == Outcome.Refunded) r.refunded++;
        else if (outcome == Outcome.DisputeWon) r.disputesWon++;
        else r.disputesLost++;
        emit OutcomeRecorded(subject, counterparty, paymentId, outcome);
    }

    function get(address subject) external view returns (Record memory) {
        return records[subject];
    }
}
