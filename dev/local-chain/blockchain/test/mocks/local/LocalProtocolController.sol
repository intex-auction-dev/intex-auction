// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {IDesis} from "@contracts/origin/interfaces/IDesis.sol";
import {IOriginRouter} from "@contracts/origin/interfaces/IOriginRouter.sol";
import {BridgeMsgCodec} from "@contracts/shared/libs/BridgeMsgCodec.sol";
import {IntexMetadata} from "@contracts/shared/libs/IntexMetadata.sol";

contract LocalProtocolController {
    address public constant COEN = address(0);

    uint8 private constant WWD_COMPLETED = 6;
    uint8 private constant WWD_FAILED = 7;

    struct WorldwideDayRecord {
        uint8 status;
        uint8 dayType;
        uint64 formingStart;
        uint64 formingEnd;
        uint64 lookbackEnd;
        uint64 offeringEnd;
        uint64 scheduledProcessTime;
        uint256 previousVwap;
        uint256 currentVwap;
        bool exists;
    }

    struct SeriesData {
        bytes14 seriesId;
        uint256 promisLoadMinor;
        uint256 entryPriceMinor;
        uint256 floorPriceMinor;
        uint32 issuedIntexCount;
        uint32 callWindow;
        uint32 callThreshold;
        uint256 callPriceMinor;
        uint8 state;
        uint32 issuedAt;
        uint32 calledAt;
        uint32 callNoticePeriod;
        uint16 issuanceCurrency;
        uint16 referenceCurrency;
        uint32 worldwideDay;
        uint256 costAmountMinor;
    }

    struct TerminalReceipt {
        uint8 outcome;
        uint256 valueRouted;
        uint256 carryOverBefore;
        uint256 carryOverAfter;
        uint8 retirementOutcome;
        uint64 blockNumber;
        bool exists;
    }

    struct CapacityForfeitureReceipt {
        uint8 outcome;
        uint32 maxRetainedWorldwideDays;
        uint32 retainedCountBefore;
        uint256 valueRouted;
        uint256 carryOverBefore;
        uint256 carryOverAfter;
        bytes32 sealedCollectionRoot;
        uint32 forfeitedTributeCount;
        uint256 forfeitedTributeNominal;
        uint64 sourceGeneration;
        uint64 retiredGeneration;
        uint8 retirementOutcome;
        uint64 blockNumber;
        bool exists;
    }

    struct OracleSnapshot {
        bytes32 pairKey;
        uint64 timestamp;
        uint256 rate;
        uint256 volume;
    }

    struct OraclePairFixture {
        uint256 rate;
        uint256 vwap;
        uint64 timestamp;
        bool active;
        bool exists;
    }

    struct OracleCurrencyFixture {
        address token;
        uint256 currencyRate;
        bool exists;
    }

    address public immutable operator;
    IOriginRouter public originRouter;

    mapping(uint32 worldwideDay => WorldwideDayRecord record) private _worldwideDays;
    uint32[] private _worldwideDayKeys;

    mapping(uint32 worldwideDay => IDesis.AuctionStage stage) internal _auctionStages;
    mapping(uint32 worldwideDay => uint256 count) private _bidsCountByDay;
    mapping(uint32 worldwideDay => mapping(uint32 chainId => uint256 count)) private _chainBidsCount;
    mapping(uint32 worldwideDay => mapping(uint32 chainId => bool done)) private _chainDone;
    mapping(uint32 worldwideDay => mapping(uint32 chainId => bool skipped)) private _chainSkipped;

    mapping(bytes14 seriesId => SeriesData data) private _series;
    mapping(bytes14 seriesId => bool exists) private _seriesExists;
    bytes14[] private _seriesIds;
    mapping(uint32 worldwideDay => TerminalReceipt receipt) private _terminalReceipts;
    mapping(uint32 worldwideDay => CapacityForfeitureReceipt receipt) private _capacityReceipts;

    bool public oracleFailure;
    OracleSnapshot[] private _oracleSnapshots;
    mapping(bytes32 pairKey => uint64 newestTimestamp) private _oraclePairNewest;
    mapping(bytes32 pairKey => OraclePairFixture fixture) private _oraclePairFixtures;
    bytes32[] private _oraclePairKeys;
    mapping(uint16 isoCode => OracleCurrencyFixture fixture) private _oracleCurrencies;
    uint16[] private _referenceIsoCodes;
    address private _defaultBase;
    address private _defaultQuote;

    uint64 public constant ORACLE_RETENTION_SECONDS = 365 days;

    uint32 public lastDay;
    uint32 public lastSrcChainId;
    uint32 public lastGeneration;
    uint16 public lastTotalBatches;
    address[] public bidders;
    uint16[] public quantities;
    uint32[] public rates;
    uint16[] public currencies;

    uint32 public doneSrcChainId;
    uint16 public doneTotalBatches;
    uint32 public doneTotalBids;

    uint32 public proceedsDay;
    uint32 public proceedsSrcChainId;
    uint256 public proceedsValue;
    uint256 public proceedsCalls;

    error OnlyOperator(address caller);
    error OnlyOriginRouter(address caller);
    error OriginRouterAlreadySet();
    error OriginRouterNotSet();
    error UnknownWorldwideDay(uint32 worldwideDay);
    error WorldwideDayNotTerminal(uint32 worldwideDay, uint8 status);
    error InvalidTimeRange();
    error InvalidGlobalStage(uint8 stage);
    error OracleUnavailable();
    error UnknownOraclePair(address base, address quote);
    error UnknownSeries(bytes14 seriesId);
    error UnknownTerminalReceipt(uint32 worldwideDay);
    error UnknownCapacityReceipt(uint32 worldwideDay);

    event OriginRouterSet(address indexed originRouter);
    event WorldwideDaySet(uint32 indexed worldwideDay, uint8 status, uint8 dayType);
    event WorldwideDayCleanedUp(uint32 indexed worldwideDay, uint8 finalStatus);
    event OracleFixtureSet(address base, address quote, uint16 isoCode, uint256 rate, uint256 vwap);
    event CurrencyRateSet(uint16 indexed isoCode, uint256 rate);
    event OracleFailureSet(bool unavailable);
    event AuctionStarted(uint32 indexed worldwideDay);
    event AuctionClearingStarted(uint32 indexed worldwideDay);
    event AuctionResultPosted(uint32 indexed worldwideDay, uint32 issuedIntexCount, uint64 clearingRate);
    event ProceedsRecorded(uint32 indexed worldwideDay, uint32 indexed srcChainId, uint256 amount);
    event SeriesSet(bytes14 indexed seriesId, uint32 indexed worldwideDay);
    event TerminalReceiptSet(uint32 indexed worldwideDay, uint8 outcome);
    event CapacityForfeitureReceiptSet(uint32 indexed worldwideDay, uint8 outcome);

    event AuctionCreated(uint32 indexed worldwideDay);
    event ChainBidsDone(uint32 indexed worldwideDay, uint32 indexed srcChainId, uint32 bidsCount);
    event ChainSkipped(uint32 indexed worldwideDay, uint32 indexed srcChainId);
    event AuctionCancelledRedDay(uint32 indexed worldwideDay);
    event AuctionCleared(uint32 indexed worldwideDay, uint32 issuedIntexCount, uint32 clearingRate, uint64 totalDemand);
    event AuctionClearedEmpty(uint32 indexed worldwideDay, uint64 totalDemand);
    event UnusedSupplyReported(uint32 indexed worldwideDay, uint256 unusedPromis);

    constructor(address operator_) {
        operator = operator_;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert OnlyOperator(msg.sender);
        _;
    }

    modifier onlyOriginRouter() {
        if (msg.sender != address(originRouter)) revert OnlyOriginRouter(msg.sender);
        _;
    }

    function setOriginRouter(IOriginRouter originRouter_) external onlyOperator {
        if (address(originRouter) != address(0)) revert OriginRouterAlreadySet();
        originRouter = originRouter_;
        emit OriginRouterSet(address(originRouter_));
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IDesis).interfaceId || interfaceId == type(IERC165).interfaceId;
    }


    function processBidsBatch(
        uint32 worldwideDay,
        uint32 srcChainId,
        uint32 relayGeneration,
        uint16,
        uint16 totalBatches,
        address[] calldata bidderAddresses,
        uint256[] calldata packedBids
    ) external onlyOriginRouter {
        require(bidderAddresses.length == packedBids.length, "bid arrays");
        lastDay = worldwideDay;
        lastSrcChainId = srcChainId;
        lastGeneration = relayGeneration;
        lastTotalBatches = totalBatches;
        // Scenario relays use one generation; the embedded Desis suite owns replacement/idempotency logic.
        _bidsCountByDay[worldwideDay] += bidderAddresses.length;
        _chainBidsCount[worldwideDay][srcChainId] += bidderAddresses.length;
        for (uint256 i = 0; i < bidderAddresses.length; i++) {
            (uint16 quantity, uint32 bidRate, , uint16 issuanceCurrency,) = BridgeMsgCodec.unpackBid(packedBids[i]);
            bidders.push(bidderAddresses[i]);
            quantities.push(quantity);
            rates.push(bidRate);
            currencies.push(issuanceCurrency);
        }
    }

    function processBidsDone(uint32 worldwideDay, uint32 srcChainId, uint32, uint16 totalBatches, uint32 totalBids)
        external
        onlyOriginRouter
    {
        doneSrcChainId = srcChainId;
        doneTotalBatches = totalBatches;
        doneTotalBids = totalBids;
        _chainDone[worldwideDay][srcChainId] = true;
        emit ChainBidsDone(worldwideDay, srcChainId, totalBids);
    }

    function getAuctionStage(uint32 worldwideDay) external view returns (IDesis.AuctionStage) {
        return _auctionStages[worldwideDay];
    }

    function getBidsCount(uint32 worldwideDay) external view returns (uint256) {
        return _bidsCountByDay[worldwideDay];
    }

    function getChainBidsCount(uint32 worldwideDay, uint32 srcChainId) external view returns (uint256) {
        return _chainBidsCount[worldwideDay][srcChainId];
    }

    function isChainDone(uint32 worldwideDay, uint32 srcChainId) external view returns (bool) {
        return _chainDone[worldwideDay][srcChainId];
    }

    function isChainSkipped(uint32 worldwideDay, uint32 srcChainId) external view returns (bool) {
        return _chainSkipped[worldwideDay][srcChainId];
    }

    function _setLocalAuctionStage(uint32 worldwideDay, IDesis.AuctionStage next) internal {
        _auctionStages[worldwideDay] = next;
    }

    function setGlobalAuctionStage(uint32 worldwideDay, uint8 stage) external onlyOperator {
        if (stage > uint8(IDesis.AuctionStage.Cancelled)) revert InvalidGlobalStage(stage);
        IDesis.AuctionStage next = IDesis.AuctionStage(stage);
        if (_auctionStages[worldwideDay] == IDesis.AuctionStage.None && next != IDesis.AuctionStage.None) {
            emit AuctionCreated(worldwideDay);
        }
        _auctionStages[worldwideDay] = next;
    }

    function markChainSkipped(uint32 worldwideDay, uint32 srcChainId) external onlyOperator {
        _chainSkipped[worldwideDay][srcChainId] = true;
        emit ChainSkipped(worldwideDay, srcChainId);
    }

    function recordGlobalClearing(
        uint32 worldwideDay,
        uint32 issuedIntexCount,
        uint32 clearingRate,
        uint64 totalDemand,
        uint256 unusedPromis,
        bool reportUnused
    ) external onlyOperator {
        _auctionStages[worldwideDay] = IDesis.AuctionStage.Cleared;
        if (issuedIntexCount == 0) {
            emit AuctionClearedEmpty(worldwideDay, totalDemand);
        } else {
            emit AuctionCleared(worldwideDay, issuedIntexCount, clearingRate, totalDemand);
        }
        if (reportUnused) emit UnusedSupplyReported(worldwideDay, unusedPromis);
    }

    function bidsCount() external view returns (uint256) {
        return bidders.length;
    }


    function distribute(uint32 worldwideDay, uint32 srcChainId) external payable onlyOriginRouter {
        proceedsDay = worldwideDay;
        proceedsSrcChainId = srcChainId;
        proceedsValue = msg.value;
        proceedsCalls++;
        emit ProceedsRecorded(worldwideDay, srcChainId, msg.value);
    }


    function setWorldwideDay(uint32 worldwideDay, WorldwideDayRecord calldata record) external onlyOperator {
        if (!_worldwideDays[worldwideDay].exists) _worldwideDayKeys.push(worldwideDay);
        _worldwideDays[worldwideDay] = WorldwideDayRecord({
            status: record.status,
            dayType: record.dayType,
            formingStart: record.formingStart,
            formingEnd: record.formingEnd,
            lookbackEnd: record.lookbackEnd,
            offeringEnd: record.offeringEnd,
            scheduledProcessTime: record.scheduledProcessTime,
            previousVwap: record.previousVwap,
            currentVwap: record.currentVwap,
            exists: true
        });
        emit WorldwideDaySet(worldwideDay, record.status, record.dayType);
    }

    function cleanWorldwideDay(uint32 worldwideDay) external onlyOperator {
        WorldwideDayRecord memory record = _worldwideDays[worldwideDay];
        if (!record.exists) revert UnknownWorldwideDay(worldwideDay);
        if (record.status != WWD_COMPLETED && record.status != WWD_FAILED) {
            revert WorldwideDayNotTerminal(worldwideDay, record.status);
        }

        delete _worldwideDays[worldwideDay];
        // The local fixture keeps only a handful of WWDs; preserve list order with an O(n) shift.
        for (uint256 i = 0; i < _worldwideDayKeys.length; i++) {
            if (_worldwideDayKeys[i] != worldwideDay) continue;
            for (uint256 j = i + 1; j < _worldwideDayKeys.length; j++) {
                _worldwideDayKeys[j - 1] = _worldwideDayKeys[j];
            }
            _worldwideDayKeys.pop();
            break;
        }
        emit WorldwideDayCleanedUp(worldwideDay, record.status);
    }

    function getWorldwideDay(uint32 worldwideDay)
        external
        view
        returns (
            uint8 status,
            uint8 dayType,
            uint64 formingStart,
            uint64 formingEnd,
            uint64 lookbackEnd,
            uint64 offeringEnd,
            uint64 scheduledProcessTime,
            uint256 previousVwap,
            uint256 currentVwap
        )
    {
        WorldwideDayRecord memory record = _worldwideDays[worldwideDay];
        if (!record.exists) revert UnknownWorldwideDay(worldwideDay);
        return (
            record.status,
            record.dayType,
            record.formingStart,
            record.formingEnd,
            record.lookbackEnd,
            record.offeringEnd,
            record.scheduledProcessTime,
            record.previousVwap,
            record.currentVwap
        );
    }

    function getActiveWorldwideDays() external view returns (uint32[] memory wwds) {
        return _copyWorldwideDays(255, false);
    }

    function getWorldwideDaysByStatus(uint8 status) external view returns (uint32[] memory wwds) {
        return _copyWorldwideDays(status, true);
    }

    function getBootstrapEndTime() external pure returns (uint64) {
        return 0;
    }

    function _copyWorldwideDays(uint8 status, bool filter) private view returns (uint32[] memory result) {
        uint256 count;
        for (uint256 i = 0; i < _worldwideDayKeys.length; i++) {
            if (!filter || _worldwideDays[_worldwideDayKeys[i]].status == status) count++;
        }
        result = new uint32[](count);
        uint256 cursor;
        for (uint256 i = 0; i < _worldwideDayKeys.length; i++) {
            uint32 key = _worldwideDayKeys[i];
            if (!filter || _worldwideDays[key].status == status) result[cursor++] = key;
        }
    }

    function setWorldwideDayTerminalReceipt(uint32 worldwideDay, TerminalReceipt calldata receipt)
        external
        onlyOperator
    {
        _terminalReceipts[worldwideDay] = TerminalReceipt({
            outcome: receipt.outcome,
            valueRouted: receipt.valueRouted,
            carryOverBefore: receipt.carryOverBefore,
            carryOverAfter: receipt.carryOverAfter,
            retirementOutcome: receipt.retirementOutcome,
            blockNumber: receipt.blockNumber,
            exists: true
        });
        emit TerminalReceiptSet(worldwideDay, receipt.outcome);
    }

    function getWorldwideDayTerminalReceipt(uint32 worldwideDay)
        external
        view
        returns (
            uint8 outcome,
            uint256 valueRouted,
            uint256 carryOverBefore,
            uint256 carryOverAfter,
            uint8 retirementOutcome,
            uint64 blockNumber
        )
    {
        TerminalReceipt memory receipt = _terminalReceipts[worldwideDay];
        if (!receipt.exists) revert UnknownTerminalReceipt(worldwideDay);
        return (
            receipt.outcome,
            receipt.valueRouted,
            receipt.carryOverBefore,
            receipt.carryOverAfter,
            receipt.retirementOutcome,
            receipt.blockNumber
        );
    }

    function setCapacityForfeitureReceipt(uint32 worldwideDay, CapacityForfeitureReceipt calldata receipt)
        external
        onlyOperator
    {
        _capacityReceipts[worldwideDay] = CapacityForfeitureReceipt({
            outcome: receipt.outcome,
            maxRetainedWorldwideDays: receipt.maxRetainedWorldwideDays,
            retainedCountBefore: receipt.retainedCountBefore,
            valueRouted: receipt.valueRouted,
            carryOverBefore: receipt.carryOverBefore,
            carryOverAfter: receipt.carryOverAfter,
            sealedCollectionRoot: receipt.sealedCollectionRoot,
            forfeitedTributeCount: receipt.forfeitedTributeCount,
            forfeitedTributeNominal: receipt.forfeitedTributeNominal,
            sourceGeneration: receipt.sourceGeneration,
            retiredGeneration: receipt.retiredGeneration,
            retirementOutcome: receipt.retirementOutcome,
            blockNumber: receipt.blockNumber,
            exists: true
        });
        emit CapacityForfeitureReceiptSet(worldwideDay, receipt.outcome);
    }

    function getCapacityForfeitureReceipt(uint32 worldwideDay)
        external
        view
        returns (
            uint8 outcome,
            uint32 maxRetainedWorldwideDays,
            uint32 retainedCountBefore,
            uint256 valueRouted,
            uint256 carryOverBefore,
            uint256 carryOverAfter,
            bytes32 sealedCollectionRoot,
            uint32 forfeitedTributeCount,
            uint256 forfeitedTributeNominal,
            uint64 sourceGeneration,
            uint64 retiredGeneration,
            uint8 retirementOutcome,
            uint64 blockNumber
        )
    {
        CapacityForfeitureReceipt memory receipt = _capacityReceipts[worldwideDay];
        if (!receipt.exists) revert UnknownCapacityReceipt(worldwideDay);
        return (
            receipt.outcome,
            receipt.maxRetainedWorldwideDays,
            receipt.retainedCountBefore,
            receipt.valueRouted,
            receipt.carryOverBefore,
            receipt.carryOverAfter,
            receipt.sealedCollectionRoot,
            receipt.forfeitedTributeCount,
            receipt.forfeitedTributeNominal,
            receipt.sourceGeneration,
            receipt.retiredGeneration,
            receipt.retirementOutcome,
            receipt.blockNumber
        );
    }


    function setSeries(SeriesData calldata data) external onlyOperator {
        if (!_seriesExists[data.seriesId]) _seriesIds.push(data.seriesId);
        _seriesExists[data.seriesId] = true;
        _series[data.seriesId] = data;
        emit SeriesSet(data.seriesId, data.worldwideDay);
    }

    function seriesData(bytes14 seriesId) external view returns (SeriesData memory) {
        if (!_seriesExists[seriesId]) revert UnknownSeries(seriesId);
        return _series[seriesId];
    }

    function seriesExists(bytes14 seriesId) external view returns (bool) {
        return _seriesExists[seriesId];
    }

    function totalSeries() external view returns (uint64) {
        return uint64(_seriesIds.length);
    }

    function seriesAt(uint64 index) external view returns (bytes14) {
        return _seriesIds[index];
    }


    function setOracleFixture(
        address base,
        address quote,
        uint16 isoCode,
        uint256 rate,
        uint256 vwap,
        uint64 timestamp
    ) external onlyOperator {
        require(base != quote, "oracle pair");
        bytes32 key = _pairKey(base, quote);
        if (!_oraclePairFixtures[key].exists) _oraclePairKeys.push(key);
        _oraclePairFixtures[key] = OraclePairFixture({rate: rate, vwap: vwap, timestamp: timestamp, active: true, exists: true});
        _defaultBase = base;
        _defaultQuote = quote;
        _upsertOracleSnapshot(key, timestamp, rate);
        if (isoCode != 0) {
            _registerCurrency(isoCode, quote, rate);
        }
        emit OracleFixtureSet(base, quote, isoCode, rate, vwap);
    }

    function setOraclePairRate(address base, address quote, uint256 rate, uint64 timestamp) external onlyOperator {
        bytes32 key = _pairKey(base, quote);
        if (!_oraclePairFixtures[key].exists) revert UnknownOraclePair(base, quote);
        _oraclePairFixtures[key].rate = rate;
        _oraclePairFixtures[key].timestamp = timestamp;
        _upsertOracleSnapshot(key, timestamp, rate);
    }

    function setOraclePairActive(address base, address quote, bool active) external onlyOperator {
        bytes32 key = _pairKey(base, quote);
        if (!_oraclePairFixtures[key].exists) revert UnknownOraclePair(base, quote);
        _oraclePairFixtures[key].active = active;
    }

    function setOracleFailure(bool unavailable) external onlyOperator {
        oracleFailure = unavailable;
        emit OracleFailureSet(unavailable);
    }

    function _registerCurrency(uint16 isoCode, address token, uint256 rate) private {
        require(isoCode != 0 && token != address(0), "currency");
        if (!_oracleCurrencies[isoCode].exists) _referenceIsoCodes.push(isoCode);
        _oracleCurrencies[isoCode] = OracleCurrencyFixture({token: token, currencyRate: rate, exists: true});
    }

    function setCurrencyRate(uint16 isoCode, uint256 rate) external onlyOperator {
        if (!_oracleCurrencies[isoCode].exists) revert UnknownCurrency(isoCode);
        _oracleCurrencies[isoCode].currencyRate = rate;
        emit CurrencyRateSet(isoCode, rate);
    }

    error UnknownCurrency(uint16 isoCode);

    function getExchangeRate(address base, address quote) public view returns (uint256 rate) {
        _requireOracleAvailable();
        bytes32 key = _pairKey(base, quote);
        OraclePairFixture memory fixture = _oraclePairFixtures[key];
        if (!fixture.exists || !fixture.active) revert UnknownOraclePair(base, quote);
        rate = fixture.rate;
        // Oracle pair keys are canonical: base < quote and reverse reads use the reciprocal.
        if (base > quote) {
            if (rate == 0) revert UnknownOraclePair(base, quote);
            rate = 1e36 / rate;
        }
    }

    function getCoenExchangeRateFor(uint16 isoCode) external view returns (uint256 rate) {
        address token = _currencyToken(isoCode);
        return getExchangeRate(COEN, token);
    }

    function getCurrencyRate(uint16 isoCode) external view returns (uint256 rate) {
        _requireOracleAvailable();
        OracleCurrencyFixture memory fixture = _oracleCurrencies[isoCode];
        if (!fixture.exists) revert UnknownCurrency(isoCode);
        rate = fixture.currencyRate;
    }

    function getReferenceCurrencies() external view returns (uint16[] memory isoCodes) {
        _requireOracleAvailable();
        isoCodes = _referenceIsoCodes;
    }

    function getExchangeRateData(address base, address quote)
        external
        view
        returns (uint256 rate, uint64 lastBlock, uint64 lastTimestamp)
    {
        _requireOracleAvailable();
        bytes32 key = _pairKey(base, quote);
        OraclePairFixture memory fixture = _oraclePairFixtures[key];
        if (!fixture.exists || !fixture.active) revert UnknownOraclePair(base, quote);
        rate = base > quote && fixture.rate != 0 ? 1e36 / fixture.rate : fixture.rate;
        lastBlock = uint64(block.number);
        lastTimestamp = fixture.timestamp;
    }

    function getDayVwap(address base, address quote) external view returns (uint256 vwap) {
        _requireOracleAvailable();
        return _pairVwap(base, quote);
    }

    function getUtcDayVwap(address base, address quote, uint32) external view returns (uint256 vwap) {
        _requireOracleAvailable();
        return _pairVwap(base, quote);
    }

    function getVwap(address base, address quote, uint64) external view returns (uint256 vwap) {
        _requireOracleAvailable();
        return _pairVwap(base, quote);
    }

    function getVwapForTimeRange(address base, address quote, uint64 startTime, uint64 endTime)
        external
        view
        returns (uint256 vwap)
    {
        _requireOracleAvailable();
        if (endTime <= startTime) revert InvalidTimeRange();
        return _pairVwap(base, quote);
    }

    function getPriceSnapshotHistory(address base, address quote, uint32 count)
        external
        view
        returns (uint64[] memory timestamps, uint256[] memory rates_, uint256[] memory volumes)
    {
        _requireOracleAvailable();
        bytes32 key = _pairKey(base, quote);
        if (!_oraclePairFixtures[key].exists) revert UnknownOraclePair(base, quote);
        uint256 total = _oracleSnapshots.length;
        uint256 matched = 0;
        for (uint256 i = total; i > 0 && matched < count; i--) {
            if (_oracleSnapshots[i - 1].pairKey == key) matched++;
        }
        timestamps = new uint64[](matched);
        rates_ = new uint256[](matched);
        volumes = new uint256[](matched);
        uint256 out = 0;
        for (uint256 i = total; i > 0 && out < count; i--) {
            OracleSnapshot memory snapshot = _oracleSnapshots[i - 1];
            if (snapshot.pairKey != key) continue;
            timestamps[out] = snapshot.timestamp;
            rates_[out] = snapshot.rate;
            volumes[out] = snapshot.volume;
            out++;
        }
    }

    function getWorldwideDayVwap(uint64 startTime, uint64 endTime)
        external
        view
        returns (address[] memory bases, address[] memory quotes, uint256[] memory vwaps, uint64[] memory lookbackSeconds)
    {
        _requireOracleAvailable();
        if (endTime <= startTime) revert InvalidTimeRange();
        bases = new address[](1);
        quotes = new address[](1);
        vwaps = new uint256[](1);
        lookbackSeconds = new uint64[](1);
        bases[0] = _defaultBase;
        quotes[0] = _defaultQuote;
        vwaps[0] = _pairVwap(_defaultBase, _defaultQuote);
        lookbackSeconds[0] = endTime - startTime;
    }

    function getWorldwideDayVwapSnapshot(uint32 worldwideDay)
        external
        view
        returns (
            uint64 startTime,
            uint64 endTime,
            address[] memory bases,
            address[] memory quotes,
            uint256[] memory vwaps,
            uint64[] memory lookbackSeconds
        )
    {
        _requireOracleAvailable();
        WorldwideDayRecord memory record = _worldwideDays[worldwideDay];
        if (!record.exists) revert UnknownWorldwideDay(worldwideDay);
        bases = new address[](1);
        quotes = new address[](1);
        vwaps = new uint256[](1);
        lookbackSeconds = new uint64[](1);
        bases[0] = _defaultBase;
        quotes[0] = _defaultQuote;
        vwaps[0] = record.currentVwap;
        lookbackSeconds[0] = record.lookbackEnd - record.formingStart;
        return (record.formingStart, record.lookbackEnd, bases, quotes, vwaps, lookbackSeconds);
    }

    function _pairVwap(address base, address quote) private view returns (uint256) {
        OraclePairFixture memory fixture = _oraclePairFixtures[_pairKey(base, quote)];
        if (!fixture.exists || !fixture.active) revert UnknownOraclePair(base, quote);
        return fixture.vwap;
    }

    function _currencyToken(uint16 isoCode) private view returns (address) {
        OracleCurrencyFixture memory fixture = _oracleCurrencies[isoCode];
        if (!fixture.exists) revert UnknownCurrency(isoCode);
        return fixture.token;
    }

    function _upsertOracleSnapshot(bytes32 pairKey, uint64 timestamp, uint256 rate) private {
        uint256 length = _oracleSnapshots.length;
        uint256 index = length;
        for (uint256 i = 0; i < length; i++) {
            OracleSnapshot storage snapshot = _oracleSnapshots[i];
            if (snapshot.pairKey == pairKey && snapshot.timestamp == timestamp) {
                snapshot.rate = rate;
                snapshot.volume = 1;
                _updateOraclePairNewest(pairKey, timestamp);
                _pruneOracleHistory();
                return;
            }
            if (snapshot.timestamp > timestamp) {
                index = i;
                break;
            }
        }

        _oracleSnapshots.push();
        // Fixture history is tiny; use an O(n) insertion instead of a local circular-buffer implementation.
        for (uint256 i = length; i > index; i--) {
            _oracleSnapshots[i] = _oracleSnapshots[i - 1];
        }
        _oracleSnapshots[index] = OracleSnapshot({pairKey: pairKey, timestamp: timestamp, rate: rate, volume: 1});
        _updateOraclePairNewest(pairKey, timestamp);
        _pruneOracleHistory();
    }

    function _updateOraclePairNewest(bytes32 pairKey, uint64 timestamp) private {
        if (timestamp > _oraclePairNewest[pairKey]) _oraclePairNewest[pairKey] = timestamp;
    }

    function _pruneOracleHistory() private {
        uint256 length = _oracleSnapshots.length;
        if (length < 2) return;
        uint256 writeIndex = 0;
        for (uint256 i = 0; i < length; i++) {
            OracleSnapshot memory snapshot = _oracleSnapshots[i];
            if (_oraclePairNewest[snapshot.pairKey] - snapshot.timestamp <= ORACLE_RETENTION_SECONDS) {
                if (writeIndex != i) _oracleSnapshots[writeIndex] = snapshot;
                writeIndex++;
            }
        }
        for (uint256 i = writeIndex; i < length; i++) {
            _oracleSnapshots.pop();
        }
    }

    function _pairKey(address base, address quote) private pure returns (bytes32) {
        (address lo, address hi) = base < quote ? (base, quote) : (quote, base);
        return keccak256(abi.encode(lo, hi));
    }

    function _requireOracleAvailable() private view {
        if (oracleFailure) revert OracleUnavailable();
    }


    function startAuction(IOriginRouter.AuctionStageStartParams calldata params) external onlyOperator {
        if (address(originRouter) == address(0)) revert OriginRouterNotSet();
        originRouter.sendAuctionStageStart(params);
        if (params.dayState == 2) {
            _auctionStages[params.worldwideDay] = IDesis.AuctionStage.Cancelled;
            emit AuctionCancelledRedDay(params.worldwideDay);
        } else {
            _auctionStages[params.worldwideDay] = IDesis.AuctionStage.Started;
            emit AuctionCreated(params.worldwideDay);
        }
        emit AuctionStarted(params.worldwideDay);
    }

    function startClearing(uint32 worldwideDay) external onlyOperator {
        originRouter.sendAuctionStageClearing(worldwideDay);
        _auctionStages[worldwideDay] = IDesis.AuctionStage.Clearing;
        emit AuctionClearingStarted(worldwideDay);
    }

    function postAuctionResult(
        uint32 dstChainId,
        uint32 worldwideDay,
        uint32 issuedIntexCount,
        uint64 auctionClearingRate,
        uint32 wonBidsCount
    ) external onlyOperator {
        originRouter.sendAuctionResult(dstChainId, worldwideDay, issuedIntexCount, auctionClearingRate, wonBidsCount);
        emit AuctionResultPosted(worldwideDay, issuedIntexCount, auctionClearingRate);
    }

    function postRefundInstructions(
        uint32 dstChainId,
        uint32 worldwideDay,
        uint16 chunkIndex,
        uint16 totalChunks,
        address[] calldata bidderAddresses,
        uint128[] calldata refundedAmounts,
        uint128[] calldata paidAmounts
    ) external onlyOperator {
        originRouter.sendRefundInstructions(
            dstChainId, worldwideDay, chunkIndex, totalChunks, bidderAddresses, refundedAmounts, paidAmounts
        );
    }

    function postIssuanceInstructions(
        uint32 dstChainId,
        IOriginRouter.IssuanceInstructionsParams[] calldata series
    ) external onlyOperator {
        originRouter.sendIssuanceInstructions(dstChainId, series);
    }

    function markQualified(bytes14 seriesId, uint32 worldwideDay) external onlyOperator {
        originRouter.sendMarkQualified(seriesId, worldwideDay);
    }

    function markCalled(bytes14 seriesId, uint32 worldwideDay) external onlyOperator {
        originRouter.sendMarkCalled(seriesId, worldwideDay);
    }
}
