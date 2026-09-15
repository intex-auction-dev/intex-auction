// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

contract GoldenRevealDigest is Test {
    bytes32 internal constant _TYPE_HASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 internal constant REVEAL_BID_TYPEHASH = keccak256(
        "RevealBid(uint32 worldwideDay,address bidder,uint16 quantity,uint32 bidRate,uint16 issuanceCurrency,uint16 referenceCurrency)"
    );

    function test_goldenRevealDigest() public {
        vm.chainId(56);
        bytes32 domainSeparator = keccak256(
            abi.encode(
                _TYPE_HASH,
                keccak256(bytes("IntexAuction")),
                keccak256(bytes("1")),
                uint256(56),
                address(0x000000000000000000000000000000000000cafE)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                REVEAL_BID_TYPEHASH,
                uint32(20260108),
                address(0x000000000000000000000000000000000000ABcD),
                uint16(5),
                uint32(1_100),
                uint16(949),
                uint16(840)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked(bytes1(0x19), bytes1(0x01), domainSeparator, structHash));
        assertEq(digest, 0xa64fee35708ed37432c1f65e0304f42c5825a0962079c9801ee04eb082eadec3);
    }
}
