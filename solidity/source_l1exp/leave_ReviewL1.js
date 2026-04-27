const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), override: true });

const { ethers } = require("ethers"); // ethers v6

// ABI of the L1 review contract function used in this experiment.
const REVIEW_ABI = [
  "function leave_review_unique(address user_address, address to_address, uint256 nonce, uint8 rating, string text) external",
];

// Read and validate required environment variables.
const getEnv = (k) => {
  const v = process.env[k];
  if (!v || !String(v).trim()) throw new Error(`missing ${k} in .env`);
  return String(v).trim();
};

(async function main() {
  const SEPOLIA_RPC_URL = getEnv("SEPOLIA_RPC_URL");
  const SEPOLIA_PRIVATE_KEY = getEnv("SEPOLIA_PRIVATE_KEY");

  // L1 review contract deployed on Sepolia.
  const REVIEW_CONTRACT_ADDR = "0xFB8Ab17C4544639A2737A1D144776b582dD1ec60";

  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);

  // Create the signer wallet used to submit the L1 transaction.
  const wallet = new ethers.Wallet(
    SEPOLIA_PRIVATE_KEY.startsWith("0x") ? SEPOLIA_PRIVATE_KEY : "0x" + SEPOLIA_PRIVATE_KEY,
    provider
  );

  const contract = new ethers.Contract(REVIEW_CONTRACT_ADDR, REVIEW_ABI, wallet);

  console.log("[chainId]", (await provider.getNetwork()).chainId.toString());
  console.log("[signer ]", wallet.address);
  console.log("[contract]", REVIEW_CONTRACT_ADDR);

  // Generate a review text with the selected length.
  const makeReview = (n) => "a".repeat(n);

  // Review sizes tested on L1.
  const sizes = [1024];

  const rating = 5;
  const toAddress = wallet.address;

  // Application-level nonce passed to the contract.
  let nonce = 1n;

  for (const len of sizes) {
    const text = makeReview(len);

    console.log(`\n→ leave_review_unique len=${len}, nonce=${nonce}`);

    // Submit the L1 review transaction.
    const tx = await contract.leave_review_unique(
      wallet.address,
      toAddress,
      nonce,
      rating,
      text
    );

    console.log("   tx hash:", tx.hash);

    // Wait until the transaction is mined.
    const rc = await tx.wait();

    const gasUsed = rc.gasUsed;

    console.log("   block:", rc.blockNumber);
    console.log("   gasUsed:", gasUsed.toString());

    nonce += 1n;
  }

  console.log("\nDone.");
})().catch((e) => {
  console.error("[error]", e?.message ?? e);
  process.exit(1);
});