// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {InteroperableAddress} from "@openzeppelin/contracts/utils/draft-InteroperableAddress.sol";

import {IERC7786TokenReceiver} from "@contracts/origin/interfaces/IERC7786TokenReceiver.sol";

contract LocalTokenBridge {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;

    constructor(IERC20 token_) {
        token = token_;
    }

    function quoteSend(uint32, address, uint256, bytes calldata, uint256) external pure returns (uint256) {
        return 0;
    }

    function sendAndCall(uint32, address to, uint256 amount, bytes calldata extraData, uint256)
        external
        payable
        returns (bytes32)
    {
        token.safeTransferFrom(msg.sender, to, amount);
        IERC7786TokenReceiver(to).onCrosschainTokensReceived(
            uint32(block.chainid), InteroperableAddress.formatEvmV1(block.chainid, msg.sender), amount, extraData
        );
        return bytes32(0);
    }
}
