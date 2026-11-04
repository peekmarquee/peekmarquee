// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {TipJarV2} from "../src/TipJarV2.sol";
import {
    V2RevertingStreamer, V2ReentrantStreamer, MockERC20, NoReturnToken, FalseToken, FeeToken, BlacklistToken
} from "./TipJarV2.t.sol";

/// Drives TipJarV2 with valid/invalid ETH and token tips; sums amounts from emitted logs.
contract HandlerV2 is Test {
    TipJarV2 public immutable jar;
    address[] public streamers;
    address[] public tokens;
    bytes32[4] public ids = [keccak256("a"), keccak256("b"), keccak256("c"), keccak256("d")];

    uint256 public evSum;
    uint256 public evCount;
    mapping(address => uint256) public evBy;
    mapping(bytes32 => uint256) public evFor;
    uint256 public tokEvCount;
    mapping(address => uint256) public tokEvSum;

    constructor(TipJarV2 _jar) {
        jar = _jar;
        for (uint256 i; i < 4; i++) streamers.push(makeAddr(string(abi.encode("streamer", i))));
        streamers.push(address(new V2RevertingStreamer()));
        streamers.push(address(new V2ReentrantStreamer(_jar, payable(streamers[0]), ids[3])));
        tokens.push(address(new MockERC20()));
        tokens.push(address(new NoReturnToken()));
        tokens.push(address(new FalseToken()));
        tokens.push(address(new FeeToken()));
        BlacklistToken bl = new BlacklistToken();
        bl.block_(streamers[1]);
        tokens.push(address(bl));
    }

    function streamerCount() external view returns (uint256) { return streamers.length; }
    function tokenCount() external view returns (uint256) { return tokens.length; }

    function _collect(Vm.Log[] memory logs) internal {
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(jar)) continue;
            if (logs[i].topics[0] == TipJarV2.Tipped.selector) {
                uint256 amt = abi.decode(logs[i].data, (uint256));
                evSum += amt;
                evCount += 1;
                evBy[address(uint160(uint256(logs[i].topics[3])))] += amt;
                evFor[logs[i].topics[1]] += amt;
            } else if (logs[i].topics[0] == TipJarV2.TippedToken.selector) {
                (address t, uint256 amt) = abi.decode(logs[i].data, (address, uint256));
                tokEvSum[t] += amt;
                tokEvCount += 1;
            }
        }
    }

    function _from(uint256 seed) internal pure returns (address) {
        return address(uint160(bound(seed, 1, 8)) + 0x1000);
    }

    function tip(uint256 amount, uint256 idSeed, uint256 who, uint256 fromSeed) external {
        amount = bound(amount, 0, 100 ether); // includes zero / below-min values
        address from = _from(fromSeed);
        vm.deal(from, amount);
        vm.recordLogs();
        vm.prank(from);
        // Foundry also records logs of reverted calls, so only count logs of a successful tip.
        try jar.tip{value: amount}(ids[idSeed % 4], payable(streamers[who % streamers.length])) {
            _collect(vm.getRecordedLogs());
        } catch {
            vm.getRecordedLogs();
        }
    }

    function tipToken(uint256 amount, uint256 idSeed, uint256 who, uint256 fromSeed, uint256 tokSeed, uint256 approveExtra)
        external
    {
        amount = bound(amount, 0, 1e30);
        address from = _from(fromSeed);
        MockERC20 t = MockERC20(tokens[tokSeed % tokens.length]);
        t.mint(from, amount);
        vm.prank(from);
        // exact approve (as the web does); every 4th call approves one unit short -> must revert
        t.approve(address(jar), approveExtra % 4 == 0 && amount > 0 ? amount - 1 : amount);
        address to = who % 7 == 6 ? address(jar) : (who % 7 == 5 ? from : streamers[who % streamers.length]);
        vm.recordLogs();
        vm.prank(from);
        try jar.tipToken(ids[idSeed % 4], to, address(t), amount) {
            _collect(vm.getRecordedLogs());
        } catch {
            vm.getRecordedLogs();
        }
    }

    function directSend(uint256 amount, bytes calldata data) external {
        amount = bound(amount, 0, 10 ether);
        vm.deal(address(this), amount);
        (bool ok, ) = address(jar).call{value: amount}(data);
        if (!ok) return;
        // only tip() (with value) or tipToken() (zero value) may succeed; anything else must revert
        bytes4 sel = data.length < 4 ? bytes4(0) : bytes4(data[:4]);
        if (sel != TipJarV2.tip.selector && !(sel == TipJarV2.tipToken.selector && amount == 0)) {
            revert("direct deposit accepted");
        }
    }
}

contract TipJarV2InvariantTest is Test {
    TipJarV2 jar;
    HandlerV2 h;

    function setUp() public {
        jar = new TipJarV2();
        h = new HandlerV2(jar);
        targetContract(address(h));
    }

    function invariant_JarHoldsNoEth() public view {
        assertEq(address(jar).balance, 0);
    }

    function invariant_JarHoldsNoTokens() public view {
        uint256 n = h.tokenCount();
        for (uint256 i; i < n; i++) assertEq(MockERC20(h.tokens(i)).balanceOf(address(jar)), 0);
    }

    function invariant_EthTotalsEqualEventSums() public view {
        assertEq(jar.totalTipped(), h.evSum());
        assertEq(jar.tipCount(), h.evCount());
        for (uint256 i; i < 4; i++) assertEq(jar.receivedFor(h.ids(i)), h.evFor(h.ids(i)));
        uint256 n = h.streamerCount();
        for (uint256 i; i < n; i++) assertEq(jar.receivedBy(h.streamers(i)), h.evBy(h.streamers(i)));
    }

    function invariant_TokenTotalsEqualEventSums() public view {
        assertEq(jar.tokenTipCount(), h.tokEvCount());
        uint256 n = h.tokenCount();
        for (uint256 i; i < n; i++) assertEq(jar.tokenTotal(h.tokens(i)), h.tokEvSum(h.tokens(i)));
        assertEq(jar.tokenTotal(h.tokens(2)), 0); // false-returning token never counts
    }

    /// sanity: the campaign actually produced successful ETH and token tips
    function afterInvariant() public {
        emit log_named_uint("successful ETH tips", jar.tipCount());
        emit log_named_uint("successful token tips", jar.tokenTipCount());
    }
}
