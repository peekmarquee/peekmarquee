// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {TipJar} from "../src/TipJar.sol";

/// Recipient whose receive() always reverts.
contract RevertingStreamer {
    receive() external payable { revert("no"); }
}

/// Recipient that re-enters tip() once, forwarding what it just received to `next`.
contract ReentrantStreamer {
    TipJar public immutable jar;
    address payable public immutable next;
    bytes32 public immutable id2;
    bool internal entered;

    constructor(TipJar _jar, address payable _next, bytes32 _id2) { jar = _jar; next = _next; id2 = _id2; }

    receive() external payable {
        if (entered) return;
        entered = true;
        jar.tip{value: msg.value}(id2, next);
    }
}

/// Recipient that tries to bounce the ETH back into the jar via a plain send (must fail).
contract BouncingStreamer {
    receive() external payable {
        (bool ok, ) = payable(msg.sender).call{value: msg.value}("");
        require(ok, "bounce failed"); // jar refuses -> this reverts -> TransferFailed
    }
}

contract TipJarTest is Test {
    TipJar jar;
    address tipper = makeAddr("tipper");
    address payable alice = payable(makeAddr("alice"));
    address payable bob = payable(makeAddr("bob"));
    bytes32 constant S1 = keccak256(bytes("s1abc"));
    bytes32 constant S2 = keccak256(bytes("s2xyz"));
    uint256 MIN;

    event Tipped(bytes32 indexed streamId, address indexed from, address indexed streamer, uint256 amount);

    function setUp() public {
        jar = new TipJar();
        MIN = jar.MIN_TIP();
        vm.deal(tipper, 1_000 ether);
    }

    function test_MinTipConstant() public view {
        assertEq(MIN, 0.00001 ether);
    }

    function test_ForwardsFullAmount() public {
        uint256 before = alice.balance;
        vm.prank(tipper);
        jar.tip{value: 0.001 ether}(S1, alice);
        assertEq(alice.balance - before, 0.001 ether);
        assertEq(address(jar).balance, 0);
        assertEq(tipper.balance, 1_000 ether - 0.001 ether);
    }

    function test_EmitsTipped() public {
        vm.expectEmit(true, true, true, true, address(jar));
        emit Tipped(S1, tipper, alice, 0.005 ether);
        vm.prank(tipper);
        jar.tip{value: 0.005 ether}(S1, alice);
    }

    function test_ExactMinTipSucceeds() public {
        vm.prank(tipper);
        jar.tip{value: MIN}(S1, alice);
        assertEq(alice.balance, MIN);
        assertEq(jar.tipCount(), 1);
    }

    function test_RevertWhen_BelowMin() public {
        vm.prank(tipper);
        vm.expectRevert(TipJar.TipTooSmall.selector);
        jar.tip{value: MIN - 1}(S1, alice);
    }

    function test_RevertWhen_ZeroValue() public {
        vm.prank(tipper);
        vm.expectRevert(TipJar.TipTooSmall.selector);
        jar.tip(S1, alice);
    }

    function test_RevertWhen_StreamerZero() public {
        vm.prank(tipper);
        vm.expectRevert(TipJar.BadStreamer.selector);
        jar.tip{value: MIN}(S1, payable(address(0)));
    }

    function test_RevertWhen_StreamerIsJar() public {
        vm.prank(tipper);
        vm.expectRevert(TipJar.BadStreamer.selector);
        jar.tip{value: MIN}(S1, payable(address(jar)));
    }

    function test_RevertWhen_StreamerReverts() public {
        RevertingStreamer r = new RevertingStreamer();
        vm.prank(tipper);
        vm.expectRevert(TipJar.TransferFailed.selector);
        jar.tip{value: 0.01 ether}(S1, payable(address(r)));
        assertEq(address(jar).balance, 0);
        assertEq(jar.totalTipped(), 0);
        assertEq(jar.tipCount(), 0);
        assertEq(jar.receivedFor(S1), 0);
        assertEq(tipper.balance, 1_000 ether);
    }

    function test_RevertWhen_StreamerBouncesIntoJar() public {
        BouncingStreamer b = new BouncingStreamer();
        vm.prank(tipper);
        vm.expectRevert(TipJar.TransferFailed.selector);
        jar.tip{value: 0.01 ether}(S1, payable(address(b)));
        assertEq(address(jar).balance, 0);
    }

    function test_ReentrantStreamer() public {
        // Re-entering tip() from the streamer's receive() hits the lock, so the streamer's
        // receive reverts and the whole tip reverts with TransferFailed. Nothing is counted.
        ReentrantStreamer r = new ReentrantStreamer(jar, bob, S2);
        vm.prank(tipper);
        vm.expectRevert(TipJar.TransferFailed.selector);
        jar.tip{value: 0.002 ether}(S1, payable(address(r)));
        assertEq(address(jar).balance, 0);
        assertEq(jar.tipCount(), 0);
        assertEq(jar.totalTipped(), 0);
        assertEq(jar.receivedFor(S1), 0);
    }

    function test_SequentialTipsStillWorkAfterLock() public {
        vm.startPrank(tipper);
        jar.tip{value: 0.001 ether}(S1, alice);
        jar.tip{value: 0.001 ether}(S1, alice);
        vm.stopPrank();
        assertEq(jar.tipCount(), 2);
        assertEq(alice.balance, 0.002 ether);
    }

    function test_RevertWhen_PlainSend() public {
        vm.prank(tipper);
        (bool ok, bytes memory ret) = address(jar).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(bytes4(ret), TipJar.NoDirectDeposits.selector);
        assertEq(address(jar).balance, 0);
    }

    function test_RevertWhen_Fallback() public {
        vm.prank(tipper);
        (bool ok, bytes memory ret) = address(jar).call{value: 1 ether}(hex"deadbeef");
        assertFalse(ok);
        assertEq(bytes4(ret), TipJar.NoDirectDeposits.selector);
        (ok, ret) = address(jar).call(hex"deadbeef"); // zero-value unknown selector also reverts
        assertFalse(ok);
        assertEq(bytes4(ret), TipJar.NoDirectDeposits.selector);
    }

    function test_CountersAccumulate() public {
        vm.startPrank(tipper);
        jar.tip{value: 0.001 ether}(S1, alice);
        jar.tip{value: 0.002 ether}(S1, bob);
        jar.tip{value: 0.003 ether}(S2, alice);
        vm.stopPrank();
        assertEq(jar.tipCount(), 3);
        assertEq(jar.totalTipped(), 0.006 ether);
        assertEq(jar.receivedBy(alice), 0.004 ether);
        assertEq(jar.receivedBy(bob), 0.002 ether);
        assertEq(jar.receivedFor(S1), 0.003 ether);
        assertEq(jar.receivedFor(S2), 0.003 ether);
        assertEq(address(jar).balance, 0);
    }

    function test_SelfTipAllowed() public {
        vm.prank(alice);
        vm.deal(alice, 1 ether);
        jar.tip{value: 0.001 ether}(S1, alice);
        assertEq(alice.balance, 1 ether);
        assertEq(jar.receivedBy(alice), 0.001 ether); // gross, unfiltered (documented)
    }

    function test_TipGas() public {
        vm.prank(tipper);
        uint256 g = gasleft();
        jar.tip{value: 0.001 ether}(S1, alice); // first-ever tip, streamer account is new
        uint256 used = g - gasleft();
        emit log_named_uint("tip gas: first tip, new streamer account (excl. 21k base)", used);
        assertLt(used, 200_000);
        vm.prank(tipper);
        g = gasleft();
        jar.tip{value: 0.001 ether}(S1, alice); // repeat tip, same stream + streamer
        used = g - gasleft();
        emit log_named_uint("tip gas: repeat tip, same stream/streamer (excl. 21k base)", used);
        assertLt(used, 90_000);
    }

    function testFuzz_Tip(uint256 amount, bytes32 id, address streamer) public {
        amount = bound(amount, MIN, 100 ether);
        vm.assume(streamer != address(0) && streamer != address(jar));
        vm.assume(streamer.code.length == 0 && uint160(streamer) > 0x10000); // EOA, no precompile
        vm.assume(streamer != tipper && streamer != address(vm) && streamer != address(this));
        uint256 before = streamer.balance;
        vm.recordLogs();
        vm.prank(tipper);
        jar.tip{value: amount}(id, payable(streamer));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], TipJar.Tipped.selector);
        assertEq(logs[0].topics[1], id);
        assertEq(abi.decode(logs[0].data, (uint256)), amount);
        assertEq(streamer.balance - before, amount);
        assertEq(address(jar).balance, 0);
        assertEq(jar.totalTipped(), amount);
        assertEq(jar.receivedFor(id), amount);
        assertEq(jar.receivedBy(streamer), amount);
    }

    function testFuzz_BelowMinReverts(uint256 amount) public {
        amount = bound(amount, 0, MIN - 1);
        vm.prank(tipper);
        vm.expectRevert(TipJar.TipTooSmall.selector);
        jar.tip{value: amount}(S1, alice);
    }
}
