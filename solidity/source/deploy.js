const hre = require("hardhat");

async function main() {
  const messaging = process.env.STARKNET_MESSAGING;

  if (!messaging || !/^0x[0-9a-fA-F]{40}$/.test(messaging)) {
    throw new Error("Invalid or missing STARKNET_MESSAGING in .env");
  }

  console.log("Deploying L1RestaurantGateway with L1 messaging contract:", messaging);

  const L1RestaurantGateway = await hre.ethers.getContractFactory("L1RestaurantGateway");

  // Deploy the L1 gateway using the official Starknet messaging contract address.
  const contract = await L1RestaurantGateway.deploy(messaging);

  // Wait until the deployment transaction is confirmed.
  await contract.waitForDeployment();

  const contractAddress = await contract.getAddress();

  console.log("L1RestaurantGateway deployed to:", contractAddress);

  // Read the DiscountToken address from the auto-generated public getter.
  // The token is deployed inside the L1RestaurantGateway constructor.
  const discountTokenAddress = await contract.discountToken();

  console.log("DiscountToken deployed to:", discountTokenAddress);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});