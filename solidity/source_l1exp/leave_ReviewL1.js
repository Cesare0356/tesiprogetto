// scripts/leaveReview.js
// usage: node scripts/leaveReview.js

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), override: true });

const { ethers } = require("ethers"); // v6

const REVIEW_ABI = [
    "function leave_review_unique(address user_address, address to_address, uint256 nonce, uint8 rating, string text) external",
];

const getEnv = (k) => {
  const v = process.env[k];
  if (!v || !String(v).trim()) throw new Error(`manca ${k} nel .env`);
  return String(v).trim();
};

(async function main() {
  const SEPOLIA_RPC_URL      = getEnv("SEPOLIA_RPC_URL");
  const SEPOLIA_PRIVATE_KEY  = getEnv("SEPOLIA_PRIVATE_KEY");
  const REVIEW_CONTRACT_ADDR = "0xFB8Ab17C4544639A2737A1D144776b582dD1ec60";

  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
  const wallet   = new ethers.Wallet(
    SEPOLIA_PRIVATE_KEY.startsWith("0x") ? SEPOLIA_PRIVATE_KEY : "0x" + SEPOLIA_PRIVATE_KEY,
    provider
  );

  const contract = new ethers.Contract(REVIEW_CONTRACT_ADDR, REVIEW_ABI, wallet);

  console.log("[chainId]", (await provider.getNetwork()).chainId.toString());
  console.log("[signer ]", wallet.address);
  console.log("[contract]", REVIEW_CONTRACT_ADDR);

  const makeReview = (n) => "a".repeat(n);
  const sizes = [1024];
  const rating = 5;
  const toAddress = wallet.address;

  let nonce = 1n;

  for (const len of sizes) {
    const text = makeReview(len);
    console.log(`\n→ leave_review_unique len=${len}, nonce=${nonce}`);

    const tx = await contract.leave_review_unique(
      wallet.address,
      toAddress,
      nonce,
      rating,
      text
    );
    console.log("   tx hash:", tx.hash);

    const rc = await tx.wait();

    const gasUsed  = rc.gasUsed;             
    console.log("   block:", rc.blockNumber);
    console.log("   gasUsed:", gasUsed.toString());

    nonce += 1n;
  }

  console.log("\nDone.");
})().catch((e) => {
  console.error("[errore]", e?.message ?? e);
  process.exit(1);
});