// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TipJar} from "../src/TipJar.sol";

/// Runs only on a Robinhood Chain mainnet fork:
///   forge test --fork-url https://robinhood-rpc.publicnode.com --match-contract TipJarForkTest -vv
contract TipJarForkTest is Test {
    address constant DEPLOYER = 0x806a315f23C241692e16fcC563Ff67b4E11BEf73;

    function setUp() public {
        if (block.chainid != 4663) vm.skip(true);
    }

    function test_Fork_DeployAndTip() public {
        assertEq(block.chainid, 4663);
        emit log_named_uint("fork block", block.number);
        emit log_named_uint("deployer balance (wei)", DEPLOYER.balance);

        vm.prank(DEPLOYER);
        TipJar jar = new TipJar(); // deploy gas: see `forge script ... --sender` simulation in README
        emit log_named_uint("runtime code size (bytes)", address(jar).code.length);

        address tipper = makeAddr("forkTipper");
        address payable streamer = payable(makeAddr("forkStreamer"));
        vm.deal(tipper, 1 ether);
        bytes32 id = keccak256(bytes("fork-stream"));

        vm.prank(tipper);
        uint256 g = gasleft();
        jar.tip{value: 0.001 ether}(id, streamer);
        emit log_named_uint("tip execution gas", g - gasleft());

        assertEq(streamer.balance, 0.001 ether);
        assertEq(address(jar).balance, 0);
        assertEq(jar.totalTipped(), 0.001 ether);
        assertEq(jar.receivedFor(id), 0.001 ether);

        vm.prank(tipper);
        vm.expectRevert(TipJar.TipTooSmall.selector);
        jar.tip{value: 0.00001 ether - 1}(id, streamer);

        vm.prank(tipper);
        (bool ok, ) = address(jar).call{value: 0.01 ether}("");
        assertFalse(ok);
    }
}
