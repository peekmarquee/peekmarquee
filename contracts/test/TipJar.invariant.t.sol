// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {TipJar} from "../src/TipJar.sol";
import {RevertingStreamer, ReentrantStreamer} from "./TipJar.t.sol";

/// Drives TipJar with valid and invalid calls; sums amounts from emitted Tipped logs.
contract Handler is Test {
    TipJar public immutable jar;
    address[] public streamers;
    bytes32[4] public ids = [keccak256("a"), keccak256("b"), keccak256("c"), keccak256("d")];

    uint256 public evSum;
    uint256 public evCount;
    mapping(address => uint256) public evBy;
    mapping(bytes32 => uint256) public evFor;

    constructor(TipJar _jar) {
        jar = _jar;
        for (uint256 i; i < 4; i++) streamers.push(makeAddr(string(abi.encode("streamer", i))));
        streamers.push(address(new RevertingStreamer()));
        streamers.push(address(new ReentrantStreamer(_jar, payable(streamers[0]), ids[3])));
    }

    function streamerCount() external view returns (uint256) { return streamers.length; }

    function _collect(Vm.Log[] memory logs) internal {
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(jar) || logs[i].topics[0] != TipJar.Tipped.selector) continue;
            uint256 amt = abi.decode(logs[i].data, (uint256));
            evSum += amt;
            evCount += 1;
            evBy[address(uint160(uint256(logs[i].topics[3])))] += amt;
            evFor[logs[i].topics[1]] += amt;
        }
    }

    function tip(uint256 amount, uint256 idSeed, uint256 who, uint256 fromSeed) external {
        amount = bound(amount, 0, 100 ether); // includes zero / below-min values
        address from = address(uint160(bound(fromSeed, 1, 8)) + 0x1000);
        vm.deal(from, amount);
        vm.recordLogs();
        vm.prank(from);
        // Foundry also records logs of reverted calls, so only count logs of a successful tip.
        try jar.tip{value: amount}(ids[idSeed % 4], payable(streamers[who % streamers.length])) {
            _collect(vm.getRecordedLogs());
        } catch {
            vm.getRecordedLogs(); // drain
        }
    }

    function badStreamer(uint256 amount, bool zero) external {
        amount = bound(amount, 0, 10 ether);
        vm.deal(address(this), amount);
        try jar.tip{value: amount}(ids[0], payable(zero ? address(0) : address(jar))) {} catch {}
    }

    function directSend(uint256 amount, bytes calldata data) external {
        amount = bound(amount, 0, 10 ether);
        vm.deal(address(this), amount);
        (bool ok, ) = address(jar).call{value: amount}(data);
        // only a real tip() selector may succeed; anything else must revert
        if (ok && (data.length < 4 || bytes4(data[:4]) != TipJar.tip.selector)) revert("direct deposit accepted");
    }
}

contract TipJarInvariantTest is Test {
    TipJar jar;
    Handler h;

    function setUp() public {
        jar = new TipJar();
        h = new Handler(jar);
        targetContract(address(h));
    }

    function invariant_JarHoldsNoEth() public view {
        assertEq(address(jar).balance, 0);
    }

    function invariant_TotalsEqualEventSums() public view {
        assertEq(jar.totalTipped(), h.evSum());
        assertEq(jar.tipCount(), h.evCount());
        for (uint256 i; i < 4; i++) assertEq(jar.receivedFor(h.ids(i)), h.evFor(h.ids(i)));
        uint256 n = h.streamerCount();
        for (uint256 i; i < n; i++) assertEq(jar.receivedBy(h.streamers(i)), h.evBy(h.streamers(i)));
    }
}
