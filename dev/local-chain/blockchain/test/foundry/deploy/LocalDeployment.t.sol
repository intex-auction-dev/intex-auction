// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {InteroperableAddress} from "@openzeppelin/contracts/utils/draft-InteroperableAddress.sol";

import {OriginRouter} from "@contracts/origin/OriginRouter.sol";
import {TargetRouter} from "@contracts/target/TargetRouter.sol";
import {IntexAuction} from "@contracts/target/IntexAuction.sol";
import {EscrowAdapter} from "@contracts/target/EscrowAdapter.sol";
import {IntexMetadata} from "@contracts/shared/libs/IntexMetadata.sol";
import {IntexNFT1155} from "@contracts/shared/IntexNFT1155.sol";
import {IntexNFT1155Bridge} from "@contracts/shared/IntexNFT1155Bridge.sol";
import {MockERC7786Bridge} from "@test-mocks/MockERC7786Bridge.sol";
import {MockTheCompact} from "@test-mocks/MockTheCompact.sol";
import {IDesis} from "@contracts/origin/interfaces/IDesis.sol";
import {LocalProtocolController} from "@local-mocks/LocalProtocolController.sol";
import {LocalWCOEN} from "@local-mocks/LocalWCOEN.sol";
import {LocalTokenBridge} from "@local-mocks/LocalTokenBridge.sol";

contract LocalDeploymentTest is Test {
    event WorldwideDayCleanedUp(uint32 indexed worldwideDay, uint8 finalStatus);

    function _quote(uint16 isoCode) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("itx-acn.local.quote", isoCode)))));
    }

    function test_LocalControllerAdvertisesDesisAndServesOriginFixtures() public {
        LocalProtocolController controller = new LocalProtocolController(address(this));
        LocalProtocolController.WorldwideDayRecord memory fixture = LocalProtocolController.WorldwideDayRecord({
            status: 2,
            dayType: 1,
            formingStart: 1_000,
            formingEnd: 1_100,
            lookbackEnd: 1_200,
            offeringEnd: 1_300,
            scheduledProcessTime: 1_400,
            previousVwap: 990_000,
            currentVwap: 995_000,
            exists: true
        });
        controller.setWorldwideDay(20260804, fixture);
        controller.setOracleFixture(controller.COEN(), _quote(840), 840, 1_000_000, 995_000, 1_050);

        (uint8 status, uint8 dayType,,,,,,, uint256 currentVwap) = controller.getWorldwideDay(20260804);
        assertEq(status, 2);
        assertEq(dayType, 1);
        assertEq(currentVwap, 995_000);
        assertEq(controller.getDayVwap(controller.COEN(), _quote(840)), 995_000);
        assertEq(controller.getExchangeRate(controller.COEN(), _quote(840)), 1_000_000);
        assertEq(controller.getCurrencyRate(840), 1_000_000);
        assertTrue(controller.supportsInterface(type(IDesis).interfaceId));
    }

    function test_LocalControllerReturnsBoundedNewestFirstOracleHistory() public {
        LocalProtocolController controller = new LocalProtocolController(address(this));
        uint64 latest = uint64(400 days);
        controller.setOracleFixture(
            controller.COEN(), _quote(840), 840, 880_000, 875_000, latest - uint64(366 days)
        );
        controller.setOracleFixture(
            controller.COEN(), _quote(840), 840, 900_000, 895_000, latest - uint64(365 days)
        );
        controller.setOracleFixture(
            controller.COEN(), _quote(840), 840, 1_020_000, 1_015_000, latest - uint64(1 days)
        );
        controller.setOracleFixture(
            controller.COEN(), _quote(840), 840, 1_100_000, 1_095_000, latest
        );

        (uint64[] memory timestamps, uint256[] memory rates, uint256[] memory volumes) =
            controller.getPriceSnapshotHistory(controller.COEN(), _quote(840), 10);
        assertEq(timestamps.length, 3);
        assertEq(timestamps[0], latest);
        assertEq(timestamps[1], latest - uint64(1 days));
        assertEq(timestamps[2], latest - uint64(365 days));
        assertEq(rates[0], 1_100_000);
        assertEq(volumes[0], 1);
        assertEq(controller.getDayVwap(controller.COEN(), _quote(840)), 1_095_000);

        (timestamps,,) = controller.getPriceSnapshotHistory(controller.COEN(), _quote(840), 2);
        assertEq(timestamps.length, 2);
        controller.setOracleFailure(true);
        address coen = controller.COEN();
        address quote = _quote(840);
        vm.expectRevert(LocalProtocolController.OracleUnavailable.selector);
        controller.getPriceSnapshotHistory(coen, quote, 1);
    }

    function test_LocalControllerScopesOracleHistoryByPair() public {
        LocalProtocolController controller = new LocalProtocolController(address(this));
        uint64 now = uint64(block.timestamp);
        controller.setOracleFixture(controller.COEN(), _quote(840), 840, 1_050_000, 1_050_000, now);
        controller.setOracleFixture(controller.COEN(), _quote(949), 949, 15_750_000, 15_750_000, now);

        (uint64[] memory usdTimestamps, uint256[] memory usdRates, ) =
            controller.getPriceSnapshotHistory(controller.COEN(), _quote(840), 10);
        assertEq(usdTimestamps.length, 1);
        assertEq(usdRates[0], 1_050_000);

        (uint64[] memory tryTimestamps, uint256[] memory tryRates, ) =
            controller.getPriceSnapshotHistory(controller.COEN(), _quote(949), 10);
        assertEq(tryTimestamps.length, 1);
        assertEq(tryRates[0], 15_750_000);
        assertTrue(usdTimestamps[0] != tryTimestamps[0] || usdRates[0] != tryRates[0]);
    }

    function test_LocalControllerCleansTerminalWorldwideDayButKeepsDurableEvidence() public {
        LocalProtocolController controller = new LocalProtocolController(address(this));
        LocalProtocolController.WorldwideDayRecord memory fixture = LocalProtocolController.WorldwideDayRecord({
            status: 6,
            dayType: 2,
            formingStart: 1_000,
            formingEnd: 1_100,
            lookbackEnd: 1_200,
            offeringEnd: 1_300,
            scheduledProcessTime: 1_400,
            previousVwap: 990_000,
            currentVwap: 995_000,
            exists: true
        });
        controller.setWorldwideDay(20260804, fixture);

        vm.expectEmit(true, false, false, true, address(controller));
        emit WorldwideDayCleanedUp(20260804, 6);
        controller.cleanWorldwideDay(20260804);

        vm.expectRevert(abi.encodeWithSelector(LocalProtocolController.UnknownWorldwideDay.selector, 20260804));
        controller.getWorldwideDay(20260804);
        assertEq(controller.getActiveWorldwideDays().length, 0);
    }

    function test_LocalLoopbackWiringUsesRealCoreProxies() public {
        uint32 local = uint32(block.chainid);
        address operator = address(this);

        MockERC7786Bridge bridge = new MockERC7786Bridge();
        LocalProtocolController controller = new LocalProtocolController(operator);
        LocalWCOEN wcoen = new LocalWCOEN(operator);
        LocalTokenBridge tokenBridge = new LocalTokenBridge(IERC20(address(wcoen)));
        MockTheCompact compact = new MockTheCompact();

        IntexNFT1155 nft = IntexNFT1155(
            address(new ERC1967Proxy(address(new IntexNFT1155()), abi.encodeCall(IntexNFT1155.initialize, (operator))))
        );
        IntexAuction auction = IntexAuction(
            address(new ERC1967Proxy(address(new IntexAuction()), abi.encodeCall(IntexAuction.initialize, (operator))))
        );
        EscrowAdapter escrow = EscrowAdapter(
            address(
                new ERC1967Proxy(address(new EscrowAdapter()), abi.encodeCall(EscrowAdapter.initialize, (operator)))
            )
        );
        OriginRouter origin = OriginRouter(
            payable(address(
                    new ERC1967Proxy(
                        address(new OriginRouter(address(bridge))), abi.encodeCall(OriginRouter.initialize, (operator))
                    )
                ))
        );
        TargetRouter target = TargetRouter(
            payable(address(
                    new ERC1967Proxy(
                        address(new TargetRouter(address(bridge), local)),
                        abi.encodeCall(TargetRouter.initialize, (operator))
                    )
                ))
        );
        IntexNFT1155Bridge nftBridge = IntexNFT1155Bridge(
            payable(address(
                    new ERC1967Proxy(
                        address(new IntexNFT1155Bridge(address(nft), address(bridge))),
                        abi.encodeCall(IntexNFT1155Bridge.initialize, (operator))
                    )
                ))
        );

        controller.setOriginRouter(origin);
        origin.setRemoteMessenger(local, InteroperableAddress.formatEvmV1(local, address(target)));
        target.setRemoteMessenger(local, InteroperableAddress.formatEvmV1(local, address(origin)));
        origin.wire(address(controller), address(controller));
        origin.addTarget(local);
        escrow.wire(address(auction), address(compact), address(wcoen));
        escrow.setProceedsRecipient(address(target));
        auction.wire(address(escrow));
        target.wire(address(auction), address(nft), address(escrow), address(nftBridge));
        origin.setProceedsRoute(address(tokenBridge), address(wcoen));
        target.setProceedsRoute(address(tokenBridge), address(origin));

        assertEq(address(origin.BRIDGE()), address(bridge));
        assertEq(address(target.BRIDGE()), address(bridge));
        assertEq(target.OUTBE_CHAIN_ID(), local);
        assertEq(address(nftBridge.token()), address(nft));
        assertEq(address(auction.escrowContract()), address(escrow));
        assertEq(escrow.intexAuctionContract(), address(auction));
        assertEq(address(target.auction()), address(auction));
        assertEq(address(target.escrowAdapter()), address(escrow));
        assertTrue(origin.isTarget(local));
        assertTrue(origin.hasRole(origin.DESIS_ROLE(), address(controller)));
        assertTrue(origin.hasRole(origin.INTEX_FACTORY_ROLE(), address(controller)));
    }
}
