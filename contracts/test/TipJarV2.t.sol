// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {TipJarV2} from "../src/TipJarV2.sol";

/// Recipient whose receive() always reverts.
contract V2RevertingStreamer {
    receive() external payable { revert("no"); }
}

/// Recipient that re-enters tip() once, forwarding what it just received to `next`.
contract V2ReentrantStreamer {
    TipJarV2 public immutable jar;
    address payable public immutable next;
    bytes32 public immutable id2;
    bool internal entered;

    constructor(TipJarV2 _jar, address payable _next, bytes32 _id2) { jar = _jar; next = _next; id2 = _id2; }

    receive() external payable {
        if (entered) return;
        entered = true;
        jar.tip{value: msg.value}(id2, next);
    }
}

/// Recipient that tries to bounce the ETH back into the jar via a plain send (must fail).
contract V2BouncingStreamer {
    receive() external payable {
        (bool ok, ) = payable(msg.sender).call{value: msg.value}("");
        require(ok, "bounce failed"); // jar refuses -> this reverts -> TransferFailed
    }
}

contract TipJarV2EthTest is Test {
    TipJarV2 jar;
    address tipper = makeAddr("tipper");
    address payable alice = payable(makeAddr("alice"));
    address payable bob = payable(makeAddr("bob"));
    bytes32 constant S1 = keccak256(bytes("s1abc"));
    bytes32 constant S2 = keccak256(bytes("s2xyz"));
    uint256 MIN;

    event Tipped(bytes32 indexed streamId, address indexed from, address indexed streamer, uint256 amount);

    function setUp() public {
        jar = new TipJarV2();
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
        vm.expectRevert(TipJarV2.TipTooSmall.selector);
        jar.tip{value: MIN - 1}(S1, alice);
    }

    function test_RevertWhen_ZeroValue() public {
        vm.prank(tipper);
        vm.expectRevert(TipJarV2.TipTooSmall.selector);
        jar.tip(S1, alice);
    }

    function test_RevertWhen_StreamerZero() public {
        vm.prank(tipper);
        vm.expectRevert(TipJarV2.BadStreamer.selector);
        jar.tip{value: MIN}(S1, payable(address(0)));
    }

    function test_RevertWhen_StreamerIsJar() public {
        vm.prank(tipper);
        vm.expectRevert(TipJarV2.BadStreamer.selector);
        jar.tip{value: MIN}(S1, payable(address(jar)));
    }

    function test_RevertWhen_StreamerReverts() public {
        V2RevertingStreamer r = new V2RevertingStreamer();
        vm.prank(tipper);
        vm.expectRevert(TipJarV2.TransferFailed.selector);
        jar.tip{value: 0.01 ether}(S1, payable(address(r)));
        assertEq(address(jar).balance, 0);
        assertEq(jar.totalTipped(), 0);
        assertEq(jar.tipCount(), 0);
        assertEq(jar.receivedFor(S1), 0);
        assertEq(tipper.balance, 1_000 ether);
    }

    function test_RevertWhen_StreamerBouncesIntoJar() public {
        V2BouncingStreamer b = new V2BouncingStreamer();
        vm.prank(tipper);
        vm.expectRevert(TipJarV2.TransferFailed.selector);
        jar.tip{value: 0.01 ether}(S1, payable(address(b)));
        assertEq(address(jar).balance, 0);
    }

    function test_V2ReentrantStreamer() public {
        // Re-entering tip() from the streamer's receive() hits the lock, so the streamer's
        // receive reverts and the whole tip reverts with TransferFailed. Nothing is counted.
        V2ReentrantStreamer r = new V2ReentrantStreamer(jar, bob, S2);
        vm.prank(tipper);
        vm.expectRevert(TipJarV2.TransferFailed.selector);
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
        assertEq(bytes4(ret), TipJarV2.NoDirectDeposits.selector);
        assertEq(address(jar).balance, 0);
    }

    function test_RevertWhen_Fallback() public {
        vm.prank(tipper);
        (bool ok, bytes memory ret) = address(jar).call{value: 1 ether}(hex"deadbeef");
        assertFalse(ok);
        assertEq(bytes4(ret), TipJarV2.NoDirectDeposits.selector);
        (ok, ret) = address(jar).call(hex"deadbeef"); // zero-value unknown selector also reverts
        assertFalse(ok);
        assertEq(bytes4(ret), TipJarV2.NoDirectDeposits.selector);
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
        assertEq(logs[0].topics[0], TipJarV2.Tipped.selector);
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
        vm.expectRevert(TipJarV2.TipTooSmall.selector);
        jar.tip{value: amount}(S1, alice);
    }
}

/// ---------------------------------------------------------------- token mocks

/// Minimal standard ERC-20 (returns bool). Subclasses tweak `_move` / return value.
contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function approve(address s, uint256 amt) external returns (bool) { allowance[msg.sender][s] = amt; return true; }
    function transfer(address to, uint256 amt) external returns (bool) { _move(msg.sender, to, amt); return true; }

    function transferFrom(address from, address to, uint256 amt) external virtual returns (bool) {
        _spend(from, amt);
        _move(from, to, amt);
        return true;
    }

    function _spend(address from, uint256 amt) internal {
        uint256 a = allowance[from][msg.sender];
        require(a >= amt, "allowance");
        allowance[from][msg.sender] = a - amt;
    }

    function _move(address from, address to, uint256 amt) internal virtual {
        require(balanceOf[from] >= amt, "balance");
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
    }
}

/// USDT-style: transferFrom returns nothing.
contract NoReturnToken is MockERC20 {
    function transferFrom(address from, address to, uint256 amt) external override returns (bool) {
        _spend(from, amt);
        _move(from, to, amt);
        assembly { return(0, 0) }
    }
}

/// Returns false and moves nothing.
contract FalseToken is MockERC20 {
    function transferFrom(address, address, uint256) external pure override returns (bool) { return false; }
}

/// Returns true but moves nothing.
contract LyingToken is MockERC20 {
    function transferFrom(address, address, uint256) external pure override returns (bool) { return true; }
}

/// Burns 1% of every transfer.
contract FeeToken is MockERC20 {
    function _move(address from, address to, uint256 amt) internal override {
        require(balanceOf[from] >= amt, "balance");
        uint256 fee = amt / 100;
        balanceOf[from] -= amt;
        balanceOf[to] += amt - fee;
    }
}

/// Reverts transfers to blacklisted addresses.
contract BlacklistToken is MockERC20 {
    mapping(address => bool) public blocked;
    function block_(address a) external { blocked[a] = true; }
    function _move(address from, address to, uint256 amt) internal override {
        require(!blocked[to] && !blocked[from], "blacklisted");
        super._move(from, to, amt);
    }
}

/// Calls back into the jar from inside transferFrom (ERC-777-style hook).
/// mode 1: re-enter tipToken, bubble revert · mode 2: re-enter tip{value}, bubble revert
/// mode 3: re-enter tipToken, swallow revert and record the selector, then finish the transfer.
contract ReentrantToken is MockERC20 {
    TipJarV2 public jar;
    uint8 public mode;
    bytes4 public caught;
    constructor(TipJarV2 j) { jar = j; }
    function setMode(uint8 m) external { mode = m; }
    receive() external payable {}

    function transferFrom(address from, address to, uint256 amt) external override returns (bool) {
        if (mode == 1) jar.tipToken(bytes32(0), to, address(this), 1);
        if (mode == 2) jar.tip{value: 0.001 ether}(bytes32(0), payable(to));
        if (mode == 3) {
            try jar.tipToken(bytes32(0), to, address(this), 1) {} catch (bytes memory r) { caught = bytes4(r); }
        }
        _spend(from, amt);
        _move(from, to, amt);
        return true;
    }
}

/// ---------------------------------------------------------------- token tests

contract TipJarV2TokenTest is Test {
    TipJarV2 jar;
    MockERC20 tok;
    address tipper = makeAddr("tipper");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    bytes32 constant S1 = keccak256(bytes("s1abc"));
    bytes32 constant S2 = keccak256(bytes("s2xyz"));

    event TippedToken(bytes32 indexed streamId, address indexed from, address indexed streamer, address token, uint256 amount);

    function setUp() public {
        jar = new TipJarV2();
        tok = new MockERC20();
        tok.mint(tipper, 1_000e6);
        vm.prank(tipper);
        tok.approve(address(jar), type(uint256).max);
    }

    function _fund(MockERC20 t, uint256 amt) internal {
        t.mint(tipper, amt);
        vm.prank(tipper);
        t.approve(address(jar), amt);
    }

    function _noState() internal view {
        assertEq(jar.tokenTipCount(), 0);
        assertEq(jar.tipCount(), 0);
        assertEq(jar.totalTipped(), 0);
    }

    function test_Token_HappyPath() public {
        vm.expectEmit(true, true, true, true, address(jar));
        emit TippedToken(S1, tipper, alice, address(tok), 5e6);
        vm.prank(tipper);
        jar.tipToken(S1, alice, address(tok), 5e6);
        assertEq(tok.balanceOf(alice), 5e6);
        assertEq(tok.balanceOf(tipper), 995e6);
        assertEq(tok.balanceOf(address(jar)), 0);
        assertEq(jar.tokenTotal(address(tok)), 5e6);
        assertEq(jar.tokenTipCount(), 1);
        // ETH counters untouched by token tips
        assertEq(jar.totalTipped(), 0);
        assertEq(jar.tipCount(), 0);
        assertEq(jar.receivedBy(alice), 0);
        assertEq(jar.receivedFor(S1), 0);
        assertEq(address(jar).balance, 0);
    }

    function test_Token_CountersAccumulate() public {
        MockERC20 t2 = new MockERC20();
        _fund(t2, 7);
        vm.startPrank(tipper);
        jar.tipToken(S1, alice, address(tok), 1e6);
        jar.tipToken(S2, bob, address(tok), 2e6);
        jar.tipToken(S1, bob, address(t2), 7);
        vm.stopPrank();
        assertEq(jar.tokenTotal(address(tok)), 3e6);
        assertEq(jar.tokenTotal(address(t2)), 7);
        assertEq(jar.tokenTipCount(), 3);
        assertEq(tok.balanceOf(address(jar)), 0);
        assertEq(t2.balanceOf(address(jar)), 0);
    }

    function test_Token_ExactApproveThenSecondTipFails() public {
        MockERC20 t = new MockERC20();
        _fund(t, 10e6); // exact approve, as the web does
        vm.startPrank(tipper);
        jar.tipToken(S1, alice, address(t), 10e6);
        t.mint(tipper, 1e6);
        vm.expectRevert(TipJarV2.TransferFailed.selector);
        jar.tipToken(S1, alice, address(t), 1e6);
        vm.stopPrank();
        assertEq(jar.tokenTipCount(), 1);
    }

    function test_Token_NoReturnValue() public {
        NoReturnToken t = new NoReturnToken();
        _fund(t, 3e6);
        vm.expectEmit(true, true, true, true, address(jar));
        emit TippedToken(S1, tipper, alice, address(t), 3e6);
        vm.prank(tipper);
        jar.tipToken(S1, alice, address(t), 3e6);
        assertEq(t.balanceOf(alice), 3e6);
        assertEq(jar.tokenTotal(address(t)), 3e6);
        assertEq(t.balanceOf(address(jar)), 0);
    }

    function test_Token_NoReturnValue_FailsWithoutAllowance() public {
        NoReturnToken t = new NoReturnToken();
        t.mint(tipper, 3e6); // no approve
        vm.prank(tipper);
        vm.expectRevert(TipJarV2.TransferFailed.selector);
        jar.tipToken(S1, alice, address(t), 3e6);
        _noState();
    }

    function test_RevertWhen_TokenReturnsFalse() public {
        FalseToken t = new FalseToken();
        _fund(t, 3e6);
        vm.prank(tipper);
        vm.expectRevert(TipJarV2.TransferFailed.selector);
        jar.tipToken(S1, alice, address(t), 3e6);
        _noState();
        assertEq(jar.tokenTotal(address(t)), 0);
    }

    function test_RevertWhen_TokenLiesAndMovesNothing() public {
        LyingToken t = new LyingToken();
        _fund(t, 3e6);
        vm.prank(tipper);
        vm.expectRevert(TipJarV2.TransferFailed.selector);
        jar.tipToken(S1, alice, address(t), 3e6);
        _noState();
    }

    function test_Token_FeeOnTransferRecordsReceived() public {
        FeeToken t = new FeeToken();
        _fund(t, 100e6);
        vm.expectEmit(true, true, true, true, address(jar));
        emit TippedToken(S1, tipper, alice, address(t), 99e6);
        vm.prank(tipper);
        jar.tipToken(S1, alice, address(t), 100e6);
        assertEq(t.balanceOf(alice), 99e6);
        assertEq(jar.tokenTotal(address(t)), 99e6);
        assertEq(t.balanceOf(address(jar)), 0);
    }

    function test_RevertWhen_StreamerBlacklisted() public {
        BlacklistToken t = new BlacklistToken();
        _fund(t, 3e6);
        t.block_(alice);
        vm.prank(tipper);
        vm.expectRevert(TipJarV2.TransferFailed.selector);
        jar.tipToken(S1, alice, address(t), 3e6);
        _noState();
        assertEq(t.balanceOf(tipper), 3e6);
    }

    function test_RevertWhen_InsufficientBalance() public {
        vm.prank(tipper);
        vm.expectRevert(TipJarV2.TransferFailed.selector);
        jar.tipToken(S1, alice, address(tok), 1_001e6);
        _noState();
    }

    function test_RevertWhen_TokenZeroAmount() public {
        vm.prank(tipper);
        vm.expectRevert(TipJarV2.TipTooSmall.selector);
        jar.tipToken(S1, alice, address(tok), 0);
    }

    function test_RevertWhen_TokenStreamerZero() public {
        vm.prank(tipper);
        vm.expectRevert(TipJarV2.BadStreamer.selector);
        jar.tipToken(S1, address(0), address(tok), 1e6);
    }

    function test_RevertWhen_TokenStreamerIsJar() public {
        vm.prank(tipper);
        vm.expectRevert(TipJarV2.BadStreamer.selector);
        jar.tipToken(S1, address(jar), address(tok), 1e6);
        assertEq(tok.balanceOf(address(jar)), 0);
    }

    function test_RevertWhen_TokenHasNoCode() public {
        vm.prank(tipper);
        vm.expectRevert(TipJarV2.BadToken.selector);
        jar.tipToken(S1, alice, makeAddr("eoaToken"), 1e6);
        vm.prank(tipper);
        vm.expectRevert(TipJarV2.BadToken.selector);
        jar.tipToken(S1, alice, address(0), 1e6);
    }

    function test_RevertWhen_TokenWithoutBalanceOf() public {
        // a contract that is not a token (the jar itself): balanceOf hits fallback -> revert
        vm.prank(tipper);
        vm.expectRevert(TipJarV2.NoDirectDeposits.selector);
        jar.tipToken(S1, alice, address(jar), 1e6);
        _noState();
    }

    function test_Token_ReentrantTipTokenBlocked() public {
        ReentrantToken t = new ReentrantToken(jar);
        _fund(t, 3e6);
        t.setMode(1);
        vm.prank(tipper);
        vm.expectRevert(TipJarV2.TransferFailed.selector); // inner Reentrant -> token reverts -> !ok
        jar.tipToken(S1, alice, address(t), 3e6);
        _noState();
    }

    function test_Token_ReentrantEthTipBlocked() public {
        ReentrantToken t = new ReentrantToken(jar);
        vm.deal(address(t), 1 ether);
        _fund(t, 3e6);
        t.setMode(2);
        vm.prank(tipper);
        vm.expectRevert(TipJarV2.TransferFailed.selector);
        jar.tipToken(S1, alice, address(t), 3e6);
        _noState();
        assertEq(address(jar).balance, 0);
    }

    function test_Token_ReentrantCaughtStillCountsOnce() public {
        ReentrantToken t = new ReentrantToken(jar);
        _fund(t, 3e6);
        t.setMode(3);
        vm.prank(tipper);
        jar.tipToken(S1, alice, address(t), 3e6);
        assertEq(t.caught(), TipJarV2.Reentrant.selector);
        assertEq(jar.tokenTipCount(), 1);
        assertEq(jar.tokenTotal(address(t)), 3e6);
        // lock released afterwards
        _fund(tok, 1);
        vm.prank(tipper);
        jar.tipToken(S1, alice, address(tok), 1);
        assertEq(jar.tokenTipCount(), 2);
    }

    function test_Token_TipTokenWithEthReverts() public {
        // tipToken is non-payable: sending ETH along must fail
        vm.deal(tipper, 1 ether);
        vm.prank(tipper);
        (bool ok, ) = address(jar).call{value: 1 ether}(
            abi.encodeCall(TipJarV2.tipToken, (S1, alice, address(tok), 1e6))
        );
        assertFalse(ok);
        assertEq(address(jar).balance, 0);
    }

    function test_RevertWhen_TokenSelfTip() public {
        // tipper == streamer: streamer balance does not grow -> nothing received -> revert.
        // (Unlike ETH tip(), a token self-tip cannot inflate tokenTotal.)
        vm.prank(tipper);
        vm.expectRevert(TipJarV2.TransferFailed.selector);
        jar.tipToken(S1, tipper, address(tok), 1e6);
        assertEq(jar.tokenTotal(address(tok)), 0);
    }

    function test_TokenTipGas() public {
        vm.prank(tipper);
        uint256 g = gasleft();
        jar.tipToken(S1, alice, address(tok), 1e6);
        emit log_named_uint("tipToken gas: first token tip, new holder (excl. 21k base)", g - gasleft());
        vm.prank(tipper);
        g = gasleft();
        jar.tipToken(S1, alice, address(tok), 1e6);
        uint256 used = g - gasleft();
        emit log_named_uint("tipToken gas: repeat token tip (excl. 21k base)", used);
        assertLt(used, 90_000);
    }

    function testFuzz_TipToken(uint256 amount, bytes32 id, address streamer) public {
        amount = bound(amount, 1, 1_000e6);
        vm.assume(streamer != address(0) && streamer != address(jar) && streamer != tipper);
        vm.recordLogs();
        vm.prank(tipper);
        jar.tipToken(id, streamer, address(tok), amount);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], TipJarV2.TippedToken.selector);
        assertEq(logs[0].topics[1], id);
        (address t, uint256 a) = abi.decode(logs[0].data, (address, uint256));
        assertEq(t, address(tok));
        assertEq(a, amount);
        assertEq(tok.balanceOf(streamer), amount);
        assertEq(tok.balanceOf(address(jar)), 0);
        assertEq(jar.tokenTotal(address(tok)), amount);
    }

    function testFuzz_FeeToken(uint256 amount) public {
        amount = bound(amount, 100, 1e30);
        FeeToken t = new FeeToken();
        _fund(t, amount);
        vm.prank(tipper);
        jar.tipToken(S1, alice, address(t), amount);
        assertEq(jar.tokenTotal(address(t)), amount - amount / 100);
        assertEq(t.balanceOf(alice), jar.tokenTotal(address(t)));
    }
}
