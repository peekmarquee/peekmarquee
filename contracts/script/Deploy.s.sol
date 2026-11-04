// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TipJar} from "../src/TipJar.sol";

/// Deploys TipJar. No constructor args, no env, no files read.
/// The signer comes only from CLI flags (e.g. --keystore ... --password-file ...); see README.md.
contract Deploy is Script {
    function run() external returns (TipJar jar) {
        require(block.chainid == 4663 || block.chainid == 46630 || block.chainid == 31337, "unexpected chain");
        vm.startBroadcast();
        jar = new TipJar();
        vm.stopBroadcast();
        console2.log("chainId", block.chainid);
        console2.log("TipJar", address(jar));
        // deployBlock: take it from the broadcast receipt (block.number on this chain is not the L2 block).
    }
}
