// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title TipJar (PEEKMARQUEE)
/// @notice Forwards every tip to the streamer inside the same call. Holds no ETH. No owner, no upgrade.
contract TipJar {
    uint256 public constant MIN_TIP = 0.00001 ether;

    uint256 public totalTipped;                     // wei, gross
    uint256 public tipCount;
    mapping(address => uint256) public receivedBy;  // streamer => wei
    mapping(bytes32 => uint256) public receivedFor; // streamId => wei
    uint256 private _locked;                        // 1 while a tip is forwarding (no re-entry)

    event Tipped(bytes32 indexed streamId, address indexed from, address indexed streamer, uint256 amount);

    error TipTooSmall();
    error BadStreamer();
    error TransferFailed();
    error NoDirectDeposits();
    error Reentrant();

    /// @param streamId keccak256(bytes(id)) of the public stream id
    /// @param streamer wallet that receives 100% of msg.value in this same call
    function tip(bytes32 streamId, address payable streamer) external payable {
        if (_locked == 1) revert Reentrant();
        if (msg.value < MIN_TIP) revert TipTooSmall();
        if (streamer == address(0) || streamer == address(this)) revert BadStreamer();
        totalTipped += msg.value;
        tipCount += 1;
        receivedBy[streamer] += msg.value;
        receivedFor[streamId] += msg.value;
        emit Tipped(streamId, msg.sender, streamer, msg.value);
        _locked = 1;
        (bool ok, ) = streamer.call{value: msg.value}("");
        _locked = 0;
        if (!ok) revert TransferFailed();
    }

    receive() external payable { revert NoDirectDeposits(); }
    fallback() external payable { revert NoDirectDeposits(); }
}
