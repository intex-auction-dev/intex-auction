// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract LocalWCOEN is ERC20 {
    address public immutable operator;

    error OnlyOperator(address caller);
    error NativeTransferFailed();

    constructor(address operator_) ERC20("Local Wrapped COEN", "WCOEN") {
        operator = operator_;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert OnlyOperator(msg.sender);
        _;
    }

    function mint(address to, uint256 amount) external onlyOperator {
        _mint(to, amount);
    }

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
    }

    receive() external payable {}
}
