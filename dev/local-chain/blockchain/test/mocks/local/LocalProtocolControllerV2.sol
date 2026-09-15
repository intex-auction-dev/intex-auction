// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {LocalProtocolController} from "./LocalProtocolController.sol";

contract LocalProtocolControllerV2 is LocalProtocolController {
    constructor(address operator_) LocalProtocolController(operator_) {}
}
