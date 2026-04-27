const hre = require("hardhat");

// Deploy the L1 review contract using Hardhat.
async function main() {
  const [deployer] = await hre.ethers.getSigners();

  console.log("Deployer:", deployer.address);

  // Check the deployer balance before deployment.
  const bal = await deployer.provider.getBalance(deployer.address);
  console.log("Balance (wei):", bal.toString());

  // Load and deploy the L1Review contract.
  const Factory = await hre.ethers.getContractFactory("L1Review");
  const contract = await Factory.deploy();

  // Wait until the deployment transaction is confirmed.
  await contract.waitForDeployment();

  const addr = await contract.getAddress();

  console.log("L1Review deployed at:", addr);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});