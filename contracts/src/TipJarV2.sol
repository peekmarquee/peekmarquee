// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20Balance {
    function balanceOf(address account) external view returns (uint256);
}

/// @title TipJar v2 (PEEKMARQUEE)
/// @notice ETH tips are forwarded to the streamer inside the same call; token tips move straight from
///         tipper to streamer via transferFrom. Holds no ETH and no tokens. No owner, no upgrade.
contract TipJarV2 {
    uint256 public constant MIN_TIP = 0.00001 ether;

    uint256 public totalTipped;                     // wei, gross
    uint256 public tipCount;
    mapping(address => uint256) public receivedBy;  // streamer => wei
    mapping(bytes32 => uint256) public receivedFor; // streamId => wei
    mapping(address => uint256) public tokenTotal;  // token => units actually received by streamers
    uint256 public tokenTipCount;
    uint256 private _locked;                        // 1 while a tip is forwarding (no re-entry)

    event Tipped(bytes32 indexed streamId, address indexed from, address indexed streamer, uint256 amount);
    event TippedToken(bytes32 indexed streamId, address indexed from, address indexed streamer, address token, uint256 amount);

    error TipTooSmall();
    error BadStreamer();
    error BadToken();
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

    /// @notice Moves `amount` of `token` from msg.sender straight to `streamer` (needs a prior approve to this jar).
    /// @dev Records what the streamer actually received (fee-on-transfer safe). Accepts tokens that return nothing.
    function tipToken(bytes32 streamId, address streamer, address token, uint256 amount) external {
        if (_locked == 1) revert Reentrant();
        if (amount == 0) revert TipTooSmall();
        if (streamer == address(0) || streamer == address(this)) revert BadStreamer();
        if (token.code.length == 0) revert BadToken();
        _locked = 1;
        uint256 before = IERC20Balance(token).balanceOf(streamer);
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSelector(0x23b872dd, msg.sender, streamer, amount)); // transferFrom
        if (!ok || (ret.length != 0 && (ret.length < 32 || abi.decode(ret, (uint256)) != 1))) revert TransferFailed();
        uint256 received = IERC20Balance(token).balanceOf(streamer);
        _locked = 0;
        if (received <= before) revert TransferFailed();
        received -= before;
        tokenTotal[token] += received;
        tokenTipCount += 1;
        emit TippedToken(streamId, msg.sender, streamer, token, received);
    }

    receive() external payable { revert NoDirectDeposits(); }
    fallback() external payable { revert NoDirectDeposits(); }
}
