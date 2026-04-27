// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./starknet/IStarknetMessaging.sol";

/* ---------- Discount token -------------------------------------------------- */

contract DiscountToken is ERC20, Ownable {
    constructor() ERC20("Discount", "DSC") Ownable(msg.sender) {}

    // Mint discount tokens. Only the owner can mint.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    // Burn discount tokens from a given account.
    function burnFrom(address account, uint256 amount) public {
        _burn(account, amount);
    }
}

/* ---------- L1 <-> L2 gateway ----------------------------------------------- */

contract ContractMsg {
    IStarknetMessaging public immutable _snMessaging;
    DiscountToken public immutable discountToken;

    constructor(address starknetMessaging_) {
        // Store the Starknet messaging contract used for L1 -> L2 and L2 -> L1 communication.
        _snMessaging = IStarknetMessaging(starknetMessaging_);

        // Deploy the discount token owned by this gateway contract.
        discountToken = new DiscountToken();
    }

    function sendPaymentAuthorizationToL2(
        uint256 contractAddress,
        uint256 selector,
        uint256[] memory payload
    )
        external
        payable
    {   
        // If the user owns one discount token, apply a 50% discount
        // and burn the token after use.
        if (
            discountToken.balanceOf(address(uint160(payload[0]))) == 1 ether
        ) {
            payload[1] = payload[1] / 2;
            discountToken.burnFrom(address(uint160(payload[0])), 1 ether);
        }
        
        // Build the L2 payload: user address and payment value.
        uint256[] memory result = new uint256[](2);
        result[0] = payload[0];
        result[1] = payload[1];

        // Send the payment authorization message from L1 to L2.
        _snMessaging.sendMessageToL2{value: msg.value}(
            contractAddress,
            selector,
            result
        );
    }
    
    function consumeReviewResultFromL2(
        uint256 fromAddress,
        uint256[] calldata payload
    ) external {
        // Consume the message sent by the L2 review contract.
        _snMessaging.consumeMessageFromL2(
            fromAddress,
            payload
        );

        if (payload.length != 2) {
            revert("Invalid Payload");
        }

        // If L2 confirms a valid review, mint one discount token to the user.
        if (payload[1] == 1) {
            discountToken.mint(address(uint160(payload[0])), 1 ether);
        }
    }
}