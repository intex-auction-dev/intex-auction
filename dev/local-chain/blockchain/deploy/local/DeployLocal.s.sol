// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {InteroperableAddress} from "@openzeppelin/contracts/utils/draft-InteroperableAddress.sol";

import {OriginRouter} from "@contracts/origin/OriginRouter.sol";
import {TargetRouter} from "@contracts/target/TargetRouter.sol";
import {IntexAuction} from "@contracts/target/IntexAuction.sol";
import {EscrowAdapter} from "@contracts/target/EscrowAdapter.sol";
import {IntexNFT1155} from "@contracts/shared/IntexNFT1155.sol";
import {IntexNFT1155Bridge} from "@contracts/shared/IntexNFT1155Bridge.sol";
import {MockERC7786Bridge} from "@test-mocks/MockERC7786Bridge.sol";
import {MockTheCompact} from "@test-mocks/MockTheCompact.sol";
import {LocalProtocolController} from "@local-mocks/LocalProtocolController.sol";
import {LocalProtocolControllerV2} from "@local-mocks/LocalProtocolControllerV2.sol";
import {LocalWCOEN} from "@local-mocks/LocalWCOEN.sol";
import {LocalTokenBridge} from "@local-mocks/LocalTokenBridge.sol";

contract DeployLocal is Script {
    uint256 private constant LOCAL_CHAIN_ID = 31337;

    function run() external {
        require(block.chainid == LOCAL_CHAIN_ID, "local chain id required");

        uint256 operatorPrivateKey = vm.envUint("LOCAL_OPERATOR_PRIVATE_KEY");
        address operator = vm.addr(operatorPrivateKey);
        address bidder = vm.envAddress("LOCAL_BIDDER_ADDRESS");
        address backgroundBidder = vm.envAddress("LOCAL_BACKGROUND_BIDDER_ADDRESS");
        address testerWallet = vm.envAddress("LOCAL_TESTER_WALLET_ADDRESS");
        string memory outputPath = vm.envString("LOCAL_DEPLOYMENT_PATH");

        vm.startBroadcast(operatorPrivateKey);

        MockERC7786Bridge bridge = new MockERC7786Bridge();
        bridge.setEnforceGasAttribute(true);
        LocalProtocolControllerV2 controller = new LocalProtocolControllerV2(operator);
        LocalWCOEN wcoen = new LocalWCOEN(operator);
        LocalTokenBridge tokenBridge = new LocalTokenBridge(IERC20(address(wcoen)));
        MockTheCompact compact = new MockTheCompact();
        compact.setResetPeriodSeconds(0);

        IntexNFT1155 nft = _deployNft(operator);
        IntexAuction auction = _deployAuction(operator);
        EscrowAdapter escrow = _deployEscrow(operator);
        OriginRouter origin = _deployOrigin(address(bridge), operator);
        TargetRouter target = _deployTarget(address(bridge), operator, uint32(LOCAL_CHAIN_ID));
        IntexNFT1155Bridge nftBridge = _deployNftBridge(address(nft), address(bridge), operator);

        controller.setOriginRouter(origin);

        // Origin and venue share one chain in the first local harness, but remain separate contracts/profiles.
        origin.setRemoteMessenger(
            uint32(LOCAL_CHAIN_ID), InteroperableAddress.formatEvmV1(LOCAL_CHAIN_ID, address(target))
        );
        target.setRemoteMessenger(
            uint32(LOCAL_CHAIN_ID), InteroperableAddress.formatEvmV1(LOCAL_CHAIN_ID, address(origin))
        );
        origin.wire(address(controller), address(controller));
        origin.addTarget(uint32(LOCAL_CHAIN_ID));

        escrow.wire(address(auction), address(compact), address(wcoen));
        escrow.setProceedsRecipient(address(target));
        auction.wire(address(escrow));
        target.wire(address(auction), address(nft), address(escrow), address(nftBridge));

        origin.setProceedsRoute(address(tokenBridge), address(wcoen));
        target.setProceedsRoute(address(tokenBridge), address(origin));

        auction.grantRole(auction.RELAYER_ROLE(), address(target));
        escrow.grantRole(escrow.RELAYER_ROLE(), address(target));
        nft.grantRole(nft.RELAYER_ROLE(), address(target));
        nftBridge.grantRole(nftBridge.SYSTEM_RELAYER_ROLE(), address(target));
        nft.grantRole(nft.RELAYER_ROLE(), address(nftBridge));
        nft.grantRole(nft.SYSTEM_RELAYER_ROLE(), address(nftBridge));

        wcoen.mint(bidder, 200_000_000 ether);
        wcoen.mint(backgroundBidder, 200_000_000 ether);
        wcoen.mint(testerWallet, 200_000_000 ether);
        (bool funded,) = address(wcoen).call{value: 100 ether}("");
        require(funded, "wcoen backing failed");

        uint64 fixtureTime = uint64(block.timestamp);
        controller.setOracleFixture(
            controller.COEN(), _quoteToken(840), 840, 1_000_000_000_000_000_000, 1_000_000_000_000_000_000, fixtureTime
        );
        controller.setOracleFixture(
            controller.COEN(), _quoteToken(949), 949, 15_000_000_000_000_000_000, 15_000_000_000_000_000_000, fixtureTime
        );
        controller.setOracleFixture(
            controller.COEN(), _quoteToken(978), 978, 920_000_000_000_000_000, 920_000_000_000_000_000, fixtureTime
        );
        controller.setOracleFixture(
            controller.COEN(), _quoteToken(826), 826, 790_000_000_000_000_000, 790_000_000_000_000_000, fixtureTime
        );
        controller.setOracleFixture(
            controller.COEN(), _quoteToken(156), 156, 7_250_000_000_000_000_000, 7_250_000_000_000_000_000, fixtureTime
        );
        controller.setOracleFixture(
            controller.COEN(), _quoteToken(392), 392, 157_000_000_000_000_000_000, 157_000_000_000_000_000_000, fixtureTime
        );
        controller.setOracleFixture(
            controller.COEN(), _quoteToken(344), 344, 7_830_000_000_000_000_000, 7_830_000_000_000_000_000, fixtureTime
        );
        controller.setWorldwideDay(
            uint32(vm.envUint("LOCAL_YESTERDAY_WORLDWIDE_DAY")),
            LocalProtocolController.WorldwideDayRecord({
                status: 2,
                dayType: 1,
                formingStart: fixtureTime - 3_600,
                formingEnd: fixtureTime,
                lookbackEnd: fixtureTime + 3_600,
                offeringEnd: fixtureTime + 7_200,
                scheduledProcessTime: fixtureTime + 10_800,
                previousVwap: 990_000,
                currentVwap: 995_000,
                exists: true
            })
        );

        vm.stopBroadcast();

        string memory root = "deployment";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeUint(root, "deploymentBlock", block.number);
        vm.serializeAddress(root, "operator", operator);
        vm.serializeAddress(root, "bidder", bidder);
        vm.serializeAddress(root, "backgroundBidder", backgroundBidder);
        vm.serializeAddress(root, "testerWallet", testerWallet);
        vm.serializeAddress(root, "bridge", address(bridge));
        vm.serializeAddress(root, "controller", address(controller));
        vm.serializeAddress(root, "wcoen", address(wcoen));
        vm.serializeAddress(root, "tokenBridge", address(tokenBridge));
        vm.serializeAddress(root, "theCompact", address(compact));
        vm.serializeAddress(root, "intexNFT1155", address(nft));
        vm.serializeAddress(root, "legacyIntexAuction", address(auction));
        vm.serializeAddress(root, "intexAuction", address(auction));
        vm.serializeAddress(root, "escrowAdapter", address(escrow));
        vm.serializeAddress(root, "originRouter", address(origin));
        vm.serializeAddress(root, "targetRouter", address(target));
        string memory json = vm.serializeAddress(root, "intexNFT1155Bridge", address(nftBridge));
        vm.writeJson(json, outputPath);
    }

    function _quoteToken(uint16 isoCode) private pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("itx-acn.local.quote", isoCode)))));
    }

    function _deployNft(address admin) private returns (IntexNFT1155) {
        IntexNFT1155 implementation = new IntexNFT1155();
        return IntexNFT1155(
            address(new ERC1967Proxy(address(implementation), abi.encodeCall(IntexNFT1155.initialize, (admin))))
        );
    }

    function _deployAuction(address admin) private returns (IntexAuction) {
        IntexAuction implementation = new IntexAuction();
        return IntexAuction(
            address(new ERC1967Proxy(address(implementation), abi.encodeCall(IntexAuction.initialize, (admin))))
        );
    }

    function _deployEscrow(address admin) private returns (EscrowAdapter) {
        EscrowAdapter implementation = new EscrowAdapter();
        return EscrowAdapter(
            address(new ERC1967Proxy(address(implementation), abi.encodeCall(EscrowAdapter.initialize, (admin))))
        );
    }

    function _deployOrigin(address bridge, address admin) private returns (OriginRouter) {
        OriginRouter implementation = new OriginRouter(bridge);
        return OriginRouter(
            payable(address(
                    new ERC1967Proxy(address(implementation), abi.encodeCall(OriginRouter.initialize, (admin)))
                ))
        );
    }

    function _deployTarget(address bridge, address admin, uint32 originChainId) private returns (TargetRouter) {
        TargetRouter implementation = new TargetRouter(bridge, originChainId);
        return TargetRouter(
            payable(address(
                    new ERC1967Proxy(address(implementation), abi.encodeCall(TargetRouter.initialize, (admin)))
                ))
        );
    }

    function _deployNftBridge(address token, address bridge, address admin) private returns (IntexNFT1155Bridge) {
        IntexNFT1155Bridge implementation = new IntexNFT1155Bridge(token, bridge);
        return IntexNFT1155Bridge(
            payable(address(
                    new ERC1967Proxy(address(implementation), abi.encodeCall(IntexNFT1155Bridge.initialize, (admin)))
                ))
        );
    }
}
