const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), override: true });

const { ethers } = require("ethers"); // ethers v6
const { RpcProvider } = require("starknet");

// Minimal ABI of the L1 restaurant gateway contract.
const CONTRACTMSG_ABI = [
  "function sendPaymentAuthorizationToL2(uint256 contractAddress,uint256 selector,uint256[] calldata payload) external payable"
];

// ---- Utils ----
const normHex = (x) => {
  let s = String(x ?? "0x0").trim().toLowerCase();
  if (!s.startsWith("0x")) s = "0x" + s;
  s = "0x" + s.slice(2).replace(/^0+/, "");
  return s === "0x" ? "0x0" : s;
};

const getEnv = (k) => {
  const v = process.env[k];
  if (!v || !String(v).trim()) throw new Error(`missing ${k} in .env`);
  return String(v).trim();
};

const MAX_FELT = (1n << 251n) - 1n;

const isFelt = (hex) => {
  try {
    if (!/^0x[0-9a-fA-F]+$/.test(hex)) return false;
    const v = BigInt(hex);
    return v >= 0n && v <= MAX_FELT;
  } catch {
    return false;
  }
};

(async function main() {
  // ---- Required environment variables ----
  const SEPOLIA_RPC_URL = getEnv("SEPOLIA_RPC_URL");              // EVM Sepolia RPC
  const SEPOLIA_PRIVATE_KEY = getEnv("SEPOLIA_PRIVATE_KEY");      // EVM private key
  const CONTRACTMSG_ADDRESS = normHex(getEnv("CONTRACTMSG_ADDRESS")); // L1 gateway contract
  const L2_CONTRACT_ADDRESS = normHex(getEnv("L2_CONTRACT_ADDRESS")); // Cairo contract address as felt
  const STARKNET_SELECTOR = normHex(getEnv("STARKNET_SELECTOR"));     // L2 entry point selector as felt
  const STARKNET_RPC_URL = getEnv("STARKNET_RPC_URL");            // Starknet Sepolia RPC

  // ---- Useful checks ----
  console.log("[check] .env path:", path.resolve(__dirname, "../.env"));
  console.log("[check] SEPOLIA_RPC_URL:", SEPOLIA_RPC_URL.slice(0, 60), "…");
  console.log("[check] STARKNET_RPC_URL:", STARKNET_RPC_URL.slice(0, 60), "…");
  console.log("[check] CONTRACTMSG_ADDRESS (L1):", CONTRACTMSG_ADDRESS);
  console.log("[check] L2_CONTRACT_ADDRESS:", L2_CONTRACT_ADDRESS);
  console.log("[check] STARKNET_SELECTOR:", STARKNET_SELECTOR);

  if (!isFelt(L2_CONTRACT_ADDRESS)) {
    throw new Error(`L2_CONTRACT_ADDRESS is not a valid felt: ${L2_CONTRACT_ADDRESS}`);
  }

  if (!isFelt(STARKNET_SELECTOR)) {
    throw new Error(`STARKNET_SELECTOR is not a valid felt: ${STARKNET_SELECTOR}`);
  }

  // ---- L1 provider and signer ----
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
  const pk = SEPOLIA_PRIVATE_KEY.startsWith("0x")
    ? SEPOLIA_PRIVATE_KEY
    : "0x" + SEPOLIA_PRIVATE_KEY;

  const signer = new ethers.Wallet(pk, provider);

  // ---- L1 gateway contract ----
  const contract = new ethers.Contract(CONTRACTMSG_ADDRESS, CONTRACTMSG_ABI, signer);

  // ---- Payload: [EVM address converted to felt, demo value] ----
  // The EVM address is 20 bytes, so it fits safely inside a felt.
  const payload = [BigInt(normHex(signer.address)), 42n];
  const payloadHex = payload.map((x) => "0x" + x.toString(16));

  // ---- Estimate the L2 message fee ----
  // This is required on Sepolia and mainnet before sending an L1 -> L2 message.
  const l2 = new RpcProvider({ nodeUrl: STARKNET_RPC_URL });

  // On RPC v0.8, the blockId parameter can be "latest".
  const feeEst = await l2.estimateMessageFee(
    {
      from_address: CONTRACTMSG_ADDRESS,        // L1 contract address
      to_address: L2_CONTRACT_ADDRESS,          // L2 target contract address
      entry_point_selector: STARKNET_SELECTOR,  // L2 entry point selector
      payload: payloadHex,                      // Payload encoded as hex values
    },
    "latest"
  );

  const overall_fee = BigInt(feeEst.overall_fee ?? feeEst.suggestedMaxFee ?? 0n);

  if (overall_fee === 0n) {
    throw new Error(
      "overall_fee == 0: L2 fee estimation failed. Check RPC, addresses, and selector."
    );
  }

  // Add a 20% buffer over the estimated L2 message fee.
  const deposit = overall_fee + overall_fee / 5n;

  console.log("L2 overall_fee:", overall_fee.toString(), feeEst.unit ?? "WEI");
  console.log("deposit with buffer:", deposit.toString());

  // ---- Send the L1 -> L2 message with the required deposit ----
  const tx = await contract.sendPaymentAuthorizationToL2(
    BigInt(L2_CONTRACT_ADDRESS),
    BigInt(STARKNET_SELECTOR),
    payload,
    { value: deposit }
  );

  console.log("L1 tx hash:", tx.hash);

  const rc = await tx.wait();

  console.log("L1 gasUsed:", rc.gasUsed.toString());
  console.log("deposit sent (wei):", deposit.toString());
})().catch((e) => {
  console.error("[error]", e?.message ?? e);
  process.exit(1);
});