// scripts/deploy.js (CommonJS)
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();

  console.log("Deployer:", deployer.address);
  const bal = await deployer.provider.getBalance(deployer.address);
  console.log("Balance (wei):", bal.toString());

  const Factory = await hre.ethers.getContractFactory("L1Review");
  const contract = await Factory.deploy(); 
  await contract.waitForDeployment();

  const addr = await contract.getAddress();
  console.log("L1Review deployed at:", addr);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});