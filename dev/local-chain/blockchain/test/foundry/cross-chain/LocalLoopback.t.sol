// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {InteroperableAddress} from "@openzeppelin/contracts/utils/draft-InteroperableAddress.sol";

import {OriginRouter} from "@contracts/origin/OriginRouter.sol";
import {IOriginRouter} from "@contracts/origin/interfaces/IOriginRouter.sol";
import {TargetRouter} from "@contracts/target/TargetRouter.sol";
import {IntexAuction} from "@contracts/target/IntexAuction.sol";
import {IIntexAuction} from "@contracts/target/interfaces/IIntexAuction.sol";
import {EscrowAdapter} from "@contracts/target/EscrowAdapter.sol";
import {IEscrowAdapter} from "@contracts/target/interfaces/IEscrowAdapter.sol";
import {IntexNFT1155} from "@contracts/shared/IntexNFT1155.sol";
import {IntexNFT1155Bridge} from "@contracts/shared/IntexNFT1155Bridge.sol";
import {CreateSeriesLib} from "../helpers/CreateSeriesLib.sol";
import {ReferenceCurrencyPriceLib} from "../helpers/ReferenceCurrencyPriceLib.sol";
import {DeployProxy} from "../helpers/DeployProxy.sol";
import {MockERC7786Bridge} from "@test-mocks/MockERC7786Bridge.sol";
import {MockTheCompact} from "@test-mocks/MockTheCompact.sol";
import {LocalProtocolController} from "@local-mocks/LocalProtocolController.sol";
import {LocalWCOEN} from "@local-mocks/LocalWCOEN.sol";
import {LocalTokenBridge} from "@local-mocks/LocalTokenBridge.sol";

contract LocalLoopbackTest is Test {
    uint32 internal constant DAY = 20260714;
    uint128 internal constant PROMIS_LOAD_MINOR = 1000;
    uint16 internal constant ISSUANCE_CCY = 840;
    uint16 internal constant REFERENCE_CCY = 840;

    bytes32 internal constant REVEAL_BID_TYPEHASH = keccak256(
        "RevealBid(uint32 worldwideDay,address bidder,uint16 quantity,uint32 bidRate,uint16 issuanceCurrency,uint16 referenceCurrency)"
    );

    MockERC7786Bridge internal bridge;
    OriginRouter internal origin;
    TargetRouter internal target;
    IntexAuction internal auction;
    EscrowAdapter internal escrow;
    IntexNFT1155 internal intex;
    IntexNFT1155Bridge internal nftBridge;
    LocalProtocolController internal controller;
    LocalWCOEN internal wcoen;
    LocalTokenBridge internal tokenBridge;
    MockTheCompact internal compact;

    uint32 internal local;
    uint256 internal startTs;

    uint256 internal iba1Pk = 0x100;
    uint256 internal iba2Pk = 0x200;
    address internal iba1;
    address internal iba2;

    function setUp() public {
        vm.warp(1_760_000_000);
        startTs = block.timestamp;
        local = uint32(block.chainid);
        iba1 = vm.addr(iba1Pk);
        iba2 = vm.addr(iba2Pk);

        // Loopback delivery uses each message's exact gas attribute, making this a gas-budget regression test.
        bridge = new MockERC7786Bridge();
        bridge.setEnforceGasAttribute(true);

        intex = DeployProxy.intexNFT1155(address(this), address(this));
        auction = DeployProxy.intexAuction(address(this), address(this));
        origin = DeployProxy.originRouter(address(bridge), address(this));
        target = DeployProxy.targetRouter(address(bridge), address(this), local);
        nftBridge = DeployProxy.intexNFT1155Bridge(address(intex), address(bridge), address(this));

        controller = new LocalProtocolController(address(this));
        controller.setOriginRouter(origin);
        wcoen = new LocalWCOEN(address(this));
        tokenBridge = new LocalTokenBridge(IERC20(address(wcoen)));
        vm.deal(address(wcoen), 1e18); // native backing for the unwrap

        escrow = DeployProxy.escrowAdapter(address(this), address(this));
        compact = new MockTheCompact();
        escrow.wire(address(auction), address(compact), address(wcoen));
        escrow.setProceedsRecipient(address(target));
        compact.setResetPeriodSeconds(0);

        origin.setRemoteMessenger(local, InteroperableAddress.formatEvmV1(local, address(target)));
        target.setRemoteMessenger(local, InteroperableAddress.formatEvmV1(local, address(origin)));

        origin.wire(address(controller), address(controller));
        origin.addTarget(local);
        origin.setProceedsRoute(address(tokenBridge), address(wcoen));

        target.wire(address(auction), address(intex), address(escrow));
        target.setProceedsRoute(address(tokenBridge), address(origin));

        auction.wire(address(escrow));
        auction.grantRole(auction.RELAYER_ROLE(), address(target));
        intex.grantRole(intex.RELAYER_ROLE(), address(target));
        escrow.grantRole(escrow.RELAYER_ROLE(), address(target));

        wcoen.mint(iba1, 1e18);
        wcoen.mint(iba2, 1e18);
        vm.prank(iba1);
        wcoen.approve(address(escrow), type(uint256).max);
        vm.prank(iba2);
        wcoen.approve(address(escrow), type(uint256).max);
    }

    function _stageStartParams() internal view returns (IOriginRouter.AuctionStageStartParams memory p) {
        p.worldwideDay = DAY;
        p.commitEnd = uint32(startTs + 100);
        p.revealEnd = uint32(startTs + 200);
        p.issuanceEnd = uint32(startTs + 300);
        p.promisLoadMinor = PROMIS_LOAD_MINOR;
        p.minIntexBidRate = 600_000;
        p.prices = ReferenceCurrencyPriceLib.one(REFERENCE_CCY, 1e4, 100, 200);
        p.minIntexBidQuantity = 1;
        p.dayState = 1;
    }

    function _sig(address bidder, uint16 qty, uint32 rate, uint256 pk) internal view returns (bytes memory) {
        bytes32 structHash =
            keccak256(abi.encode(REVEAL_BID_TYPEHASH, DAY, bidder, qty, rate, ISSUANCE_CCY, REFERENCE_CCY));
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("IntexAuction")),
                keccak256(bytes("1")),
                block.chainid,
                address(auction)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _commitAndReveal(address bidder, uint16 qty, uint32 rate, uint256 pk) internal {
        bytes memory signature = _sig(bidder, qty, rate, pk);
        vm.prank(bidder);
        auction.revealBid(DAY, qty, rate, ISSUANCE_CCY, REFERENCE_CCY, uint64(block.chainid), signature);
    }

    function test_FullWalk_OriginAsTarget() public {
        controller.startAuction(_stageStartParams());
        assertEq(uint8(auction.getAuctionStage(DAY)), uint8(IIntexAuction.AuctionStage.CommittingBids), "not started");
        uint32[] memory snapshot = origin.targetsOf(DAY);
        assertEq(snapshot.length, 1, "snapshot size");
        assertEq(snapshot[0], local, "snapshot chain");

        vm.prank(iba1);
        auction.commitBid(DAY, keccak256(_sig(iba1, 30, 800_000, iba1Pk)));
        vm.prank(iba2);
        auction.commitBid(DAY, keccak256(_sig(iba2, 40, 700_000, iba2Pk)));

        vm.warp(startTs + 101);
        assertEq(uint8(auction.getAuctionStage(DAY)), uint8(IIntexAuction.AuctionStage.RevealingBids), "not revealing");
        _commitAndReveal(iba1, 30, 800_000, iba1Pk);
        _commitAndReveal(iba2, 40, 700_000, iba2Pk);
        assertEq(uint256(escrow.getBidLock(DAY, iba1).lockedAmount), 24_000, "iba1 lock");
        assertEq(uint256(escrow.getBidLock(DAY, iba2).lockedAmount), 28_000, "iba2 lock");

        vm.warp(startTs + 201);
        controller.startClearing(DAY);
        assertEq(controller.bidsCount(), 2, "bids not relayed");
        assertEq(controller.lastDay(), DAY, "relay day");
        assertEq(controller.lastSrcChainId(), local, "relay source chain");
        assertEq(controller.lastGeneration(), 1, "relay generation");
        assertEq(controller.lastTotalBatches(), 1, "relay batches");
        assertEq(controller.doneSrcChainId(), local, "marker source chain");
        assertEq(controller.doneTotalBatches(), 1, "marker batches");
        assertEq(controller.doneTotalBids(), 2, "marker bids");

        controller.postAuctionResult(local, DAY, 50, 700_000, 2);
        IIntexAuction.AuctionResult memory result = auction.getAuctionInfo(DAY).result;
        assertEq(result.issuedUnits, 50, "issued");
        assertEq(result.auctionClearingRate, 700_000, "clearing rate");

        address[] memory bidders = new address[](2);
        bidders[0] = iba1;
        bidders[1] = iba2;
        uint128[] memory refunded = new uint128[](2);
        refunded[0] = 3_000; // lock 24k − paid 30·1000·0.7
        refunded[1] = 14_000; // lock 28k − paid 20·1000·0.7
        uint128[] memory paid = new uint128[](2);
        paid[0] = 21_000;
        paid[1] = 14_000;
        controller.postRefundInstructions(local, DAY, 0, 1, bidders, refunded, paid);

        assertEq(
            uint8(escrow.getBidLock(DAY, iba1).status), uint8(IEscrowAdapter.LockStatus.Finalized), "iba1 not final"
        );
        assertEq(wcoen.balanceOf(iba1), 1e18 - 24_000 + 3_000, "iba1 refund");
        assertEq(wcoen.balanceOf(iba2), 1e18 - 28_000 + 14_000, "iba2 refund");
        assertEq(controller.proceedsCalls(), 1, "proceeds not distributed");
        assertEq(controller.proceedsValue(), 35_000, "proceeds amount");
        assertEq(controller.proceedsSrcChainId(), local, "proceeds source chain");
        assertEq(controller.proceedsDay(), DAY, "proceeds day");
        assertEq(address(origin).balance, 0, "native stranded on origin");

        address[] memory winners = new address[](2);
        winners[0] = iba1;
        winners[1] = iba2;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 30;
        amounts[1] = 20;
        IOriginRouter.IssuanceInstructionsParams[] memory issuance = new IOriginRouter.IssuanceInstructionsParams[](1);
        issuance[0] = IOriginRouter.IssuanceInstructionsParams({
            seriesId: CreateSeriesLib.seriesId(DAY),
            worldwideDay: DAY,
            issuedAt: uint32(block.timestamp),
            issuedUnits: 50,
            promisLoadMinor: PROMIS_LOAD_MINOR,
            entryPriceMinor: 1e13,
            floorPriceMinor: 100,
            callNoticePeriod: 0,
            issuanceCurrency: ISSUANCE_CCY,
            referenceCurrency: REFERENCE_CCY,
            callWindow: 30,
            callThreshold: 21,
            callPriceMinor: 200,
            recipients: winners,
            quantities: amounts
        });
        controller.postIssuanceInstructions(local, issuance);
        uint256 tokenId = intex.issuedTokenId(CreateSeriesLib.seriesId(DAY));
        assertEq(intex.balanceOf(iba1, tokenId), 30, "iba1 mint");
        assertEq(intex.balanceOf(iba2, tokenId), 20, "iba2 mint");

        (uint16 bidsNextBatch,,) = target.bidsRelay(DAY);
        assertEq(bidsNextBatch, 0, "bids relay parked");
        assertEq(target.parkedProceedsCount(), 0, "proceeds route parked");
        assertEq(target.parkedIssuanceCount(), 0, "issuance mint parked");
        assertEq(origin.parkedMessage(0).payload.length, 0, "origin leg parked");
    }
}
