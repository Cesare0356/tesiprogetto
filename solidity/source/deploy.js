// scripts/deploy.js
const hre = require("hardhat");

async function main() {
  const messaging = process.env.STARKNET_MESSAGING;
  if (!messaging || !/^0x[0-9a-fA-F]{40}$/.test(messaging)) {
    throw new Error("STARKNET_MESSAGING non valido o assente nel .env");
  }

  console.log("Deploy di ContractMsg con messaging L1:", messaging);

  const ContractMsg = await hre.ethers.getContractFactory("ContractMsg");
  const contract = await ContractMsg.deploy(messaging);
  await contract.waitForDeployment();

  const contractAddress = await contract.getAddress();
  console.log("ContractMsg deployed to:", contractAddress);

  //Legge l’indirizzo del DiscountToken (getter auto-generato dal public)
  const discountTokenAddress = await contract.discountToken();
  console.log("DiscountToken deployed to:", discountTokenAddress);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});