// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {LocalProtocolController} from "@local-mocks/LocalProtocolController.sol";
import {LocalProtocolControllerV2} from "@local-mocks/LocalProtocolControllerV2.sol";

contract LocalProtocolControllerV2Test is Test {
    bytes14 private constant SERIES_ID = bytes14("20260803-USD-U");

    function test_ServesCanonicalIntexSeriesReads() public {
        LocalProtocolControllerV2 controller = new LocalProtocolControllerV2(address(this));
        controller.setSeries(
            LocalProtocolController.SeriesData({
                seriesId: SERIES_ID,
                promisLoadMinor: 1_000,
                entryPriceMinor: 100,
                floorPriceMinor: 108,
                issuedUnits: 50,
                callWindow: 30,
                callThreshold: 21,
                callPriceMinor: 228,
                state: 1,
                issuedAt: 1_700_000_000,
                calledAt: 0,
                callNoticePeriod: 7 days,
                issuanceCurrency: 840,
                referenceCurrency: 840,
                worldwideDay: 20260803,
                settledUnits: 12,
                exercisedUnits: 3,
                gemFactoryUnits: 5
            })
        );

        assertTrue(controller.seriesExists(SERIES_ID));
        assertEq(controller.totalSeries(), 1);
        assertEq(controller.seriesAt(0), SERIES_ID);

        LocalProtocolController.SeriesData memory data = controller.seriesData(SERIES_ID);
        assertEq(data.promisLoadMinor, 1_000);
        assertEq(data.issuedUnits, 50);
        assertEq(data.callPriceMinor, 228);
        assertEq(data.settledUnits, 12);
        assertEq(data.exercisedUnits, 3);
        assertEq(data.gemFactoryUnits, 5);
        assertEq(data.worldwideDay, 20260803);
    }

    function test_ServesMetadosisTerminalReceiptReads() public {
        LocalProtocolControllerV2 controller = new LocalProtocolControllerV2(address(this));
        controller.setWorldwideDayTerminalReceipt(
            20260803,
            LocalProtocolController.TerminalReceipt({
                outcome: 2,
                valueRouted: 1_000,
                carryOverBefore: 200,
                carryOverAfter: 50,
                retirementOutcome: 1,
                blockNumber: 123,
                exists: true
            })
        );

        (
            uint8 outcome,
            uint256 valueRouted,
            uint256 carryOverBefore,
            uint256 carryOverAfter,
            uint8 retirementOutcome,
            uint64 blockNumber
        ) = controller.getWorldwideDayTerminalReceipt(20260803);

        assertEq(outcome, 2);
        assertEq(valueRouted, 1_000);
        assertEq(carryOverBefore, 200);
        assertEq(carryOverAfter, 50);
        assertEq(retirementOutcome, 1);
        assertEq(blockNumber, 123);
    }

    function test_ServesScenarioAuctionEvidence() public {
        uint32 worldwideDay = 20260804;
        uint32 chainId = 31337;
        LocalProtocolControllerV2 controller = new LocalProtocolControllerV2(address(this));

        controller.setGlobalAuctionStage(worldwideDay, 2);
        assertEq(uint8(controller.getAuctionStage(worldwideDay)), 2);

        controller.markChainSkipped(worldwideDay, chainId);
        assertTrue(controller.isChainSkipped(worldwideDay, chainId));

        controller.recordGlobalClearing(worldwideDay, 2, 800_000, 5, 3_007, true);
        assertEq(uint8(controller.getAuctionStage(worldwideDay)), 5);
    }
}
