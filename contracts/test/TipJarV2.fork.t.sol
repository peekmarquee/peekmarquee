// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TipJarV2} from "../src/TipJarV2.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// Runs only on a Robinhood Chain mainnet fork:
///   forge test --fork-url https://robinhood-rpc.publicnode.com --match-contract TipJarV2ForkTest -vv
contract TipJarV2ForkTest is Test {
    address constant DEPLOYER = 0x806a315f23C241692e16fcC563Ff67b4E11BEf73;
    IERC20 constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);

    TipJarV2 jar;
    address tipper = makeAddr("forkTipper");
    address streamer = makeAddr("forkStreamer");
    bytes32 id = keccak256(bytes("fork-stream"));

    function setUp() public {
        if (block.chainid != 4663) vm.skip(true);
        vm.prank(DEPLOYER);
        jar = new TipJarV2();
    }

    function test_Fork_EthTip() public {
        emit log_named_uint("fork block", block.number);
        emit log_named_uint("runtime code size (bytes)", address(jar).code.length);
        vm.deal(tipper, 1 ether);
        vm.prank(tipper);
        uint256 g = gasleft();
        jar.tip{value: 0.001 ether}(id, payable(streamer));
        emit log_named_uint("tip execution gas", g - gasleft());
        assertEq(streamer.balance, 0.001 ether);
        assertEq(address(jar).balance, 0);
        assertEq(jar.receivedFor(id), 0.001 ether);
        vm.prank(tipper);
        (bool ok, ) = address(jar).call{value: 0.01 ether}("");
        assertFalse(ok);
    }

    function test_Fork_UsdgTip() public {
        assertEq(USDG.decimals(), 6);
        deal(address(USDG), tipper, 100e6); // stdstorage finds the balance slot behind the proxy
        assertEq(USDG.balanceOf(tipper), 100e6);

        // web flow: exact approve, then tipToken
        vm.startPrank(tipper);
        assertTrue(USDG.approve(address(jar), 5e6));
        uint256 g = gasleft();
        jar.tipToken(id, streamer, address(USDG), 5e6);
        emit log_named_uint("tipToken(USDG) execution gas, new holder", g - gasleft());
        vm.stopPrank();

        assertEq(USDG.balanceOf(streamer), 5e6);
        assertEq(USDG.balanceOf(tipper), 95e6);
        assertEq(USDG.balanceOf(address(jar)), 0);
        assertEq(USDG.allowance(tipper, address(jar)), 0);
        assertEq(jar.tokenTotal(address(USDG)), 5e6);
        assertEq(jar.tokenTipCount(), 1);

        // allowance used up -> second tip fails, nothing counted
        vm.prank(tipper);
        vm.expectRevert(TipJarV2.TransferFailed.selector);
        jar.tipToken(id, streamer, address(USDG), 1e6);
        assertEq(jar.tokenTipCount(), 1);

        // repeat tip gas
        vm.startPrank(tipper);
        USDG.approve(address(jar), 1e6);
        g = gasleft();
        jar.tipToken(id, streamer, address(USDG), 1e6);
        emit log_named_uint("tipToken(USDG) execution gas, repeat", g - gasleft());
        vm.stopPrank();
        assertEq(jar.tokenTotal(address(USDG)), 6e6);
    }

    function test_Fork_UsdgInsufficientBalanceReverts() public {
        vm.startPrank(tipper);
        USDG.approve(address(jar), 1e6);
        vm.expectRevert(TipJarV2.TransferFailed.selector);
        jar.tipToken(id, streamer, address(USDG), 1e6); // tipper holds 0 USDG
        vm.stopPrank();
    }
}
