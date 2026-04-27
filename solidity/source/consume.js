const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), override: true });

const { ethers } = require("ethers"); // ethers v6
const { RpcProvider } = require("starknet");

// Minimal ABI of the L1 contract that exposes consumeMessageValue.
const ABI = [
  "function consumeReviewResultFromL2(uint256 fromAddress, uint256[] calldata payload) external"
];

// ---- Utils ----
const normHex = (x) => {
  let s = String(x ?? "0x0").trim().toLowerCase();

  if (!s.startsWith("0x")) s = "0x" + s;

  s = "0x" + s.slice(2).replace(/^0+/, "");

  return s === "0x" ? "0x0" : s;
};

// Read a required environment variable and fail if it is missing.
const getEnv = (k) => {
  const v = process.env[k];

  if (!v || !String(v).trim()) {
    throw new Error(`missing ${k} in .env`);
  }

  return String(v).trim();
};

// Starknet felts must fit within 251 bits.
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

// Convert the Starknet message payload into uint256 values for the L1 contract call.
const toUint256Array = (arr) =>
  arr.map((x) => {
    const n = BigInt(normHex(x));

    if (n < 0n) {
      throw new Error(`negative value in payload: ${x}`);
    }

    return n;
  });

(async () => {
  // ---- CLI arguments ----
  // The script receives the Starknet L2 transaction hash that emitted the L2 -> L1 message.
  const L2_TX_HASH = process.argv[2];

  if (!L2_TX_HASH) {
    throw new Error("usage: node scripts/consume_from_l2_tx.js <L2_TX_HASH_STARKNET>");
  }

  if (!isFelt(L2_TX_HASH)) {
    throw new Error(
      "L2_TX_HASH must be a Starknet transaction hash, meaning a felt <= 251 bits, not a 256-bit EVM hash."
    );
  }

  // ---- Environment variables ----
  const SEPOLIA_RPC_URL = getEnv("SEPOLIA_RPC_URL");             // EVM L1 Sepolia RPC
  const SEPOLIA_PRIVATE_KEY = getEnv("SEPOLIA_PRIVATE_KEY");     // EVM private key
  const CONTRACTMSG_ADDRESS = normHex(getEnv("CONTRACTMSG_ADDRESS")); // L1 contract that consumes the message
  const STARKNET_RPC_URL = getEnv("STARKNET_RPC_URL");           // Starknet Sepolia RPC
  const L2_CONTRACT_ADDRESS = normHex(getEnv("L2_CONTRACT_ADDRESS")); // Cairo contract that sent the message

  // Optional variables used only for logging or diagnostics.
  // They are not required to consume the L2 -> L1 message.
  const STARKNET_MESSAGING = process.env.STARKNET_MESSAGING
    ? normHex(process.env.STARKNET_MESSAGING)
    : null;

  const STARKNET_SELECTOR = process.env.STARKNET_SELECTOR
    ? normHex(process.env.STARKNET_SELECTOR)
    : null;

  console.log("[check] STARKNET_RPC_URL:", STARKNET_RPC_URL.slice(0, 60), "…");
  console.log("[check] L2_TX_HASH:", L2_TX_HASH);
  console.log("[check] CONTRACTMSG_ADDRESS (L1):", CONTRACTMSG_ADDRESS);
  console.log("[check] L2_CONTRACT_ADDRESS:", L2_CONTRACT_ADDRESS);

  if (!isFelt(L2_CONTRACT_ADDRESS)) {
    throw new Error(`L2_CONTRACT_ADDRESS is not a valid felt: ${L2_CONTRACT_ADDRESS}`);
  }

  // ---- L2: read the transaction receipt and extract the L2 -> L1 message ----
  const l2 = new RpcProvider({ nodeUrl: STARKNET_RPC_URL });
  const receiptL2 = await l2.getTransactionReceipt(L2_TX_HASH);

  // Different Starknet SDK or RPC versions may expose the field with different names.
  const messages = receiptL2.messages_sent ?? receiptL2.messagesSent ?? [];

  if (!Array.isArray(messages)) {
    throw new Error("L2 receipt does not contain a valid 'messages_sent' field.");
  }

  // Select the message whose destination is the L1 gateway contract.
  const target = CONTRACTMSG_ADDRESS;

  const msgToL1 = messages.find((m) => {
    const toAddr = normHex(m.to_address ?? m.toAddress);
    return toAddr === target;
  });

  if (!msgToL1) {
    const tos = messages.map((m) => normHex(m.to_address ?? m.toAddress));

    throw new Error(
      `no message to CONTRACTMSG_ADDRESS found in the L2 receipt. ` +
        `found destinations: [${tos.join(", ")}], expected: ${target}`
    );
  }

  // Extract the payload that will be passed to the L1 consume function.
  const rawPayload = msgToL1.payload ?? msgToL1.payload_data ?? [];

  if (!Array.isArray(rawPayload) || rawPayload.length === 0) {
    throw new Error("L2 -> L1 message payload is empty or invalid.");
  }

  // Optional consistency check: the message should come from the expected L2 contract.
  const fromL2InReceipt = normHex(msgToL1.from_address ?? msgToL1.fromAddress ?? "0x0");

  if (fromL2InReceipt !== "0x0" && fromL2InReceipt !== L2_CONTRACT_ADDRESS) {
    console.warn(
      `[warn] receipt from_address is ${fromL2InReceipt}, but expected L2_CONTRACT_ADDRESS ${L2_CONTRACT_ADDRESS}`
    );
  }

  const payload = toUint256Array(rawPayload);

  // ---- L1: prepare provider, signer, and contract instance ----
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);

  const pk = SEPOLIA_PRIVATE_KEY.startsWith("0x")
    ? SEPOLIA_PRIVATE_KEY
    : "0x" + SEPOLIA_PRIVATE_KEY;

  const signer = new ethers.Wallet(pk, provider);
  const l1 = new ethers.Contract(CONTRACTMSG_ADDRESS, ABI, signer);

  // ---- Consume the L2 -> L1 message on Ethereum Sepolia ----
  // The L1 contract internally calls StarknetMessaging.consumeMessageFromL2.
  const fromL2Felt = BigInt(L2_CONTRACT_ADDRESS);
  const tx = await l1.consumeReviewResultFromL2(fromL2Felt, payload);

  console.log("L1 tx sent:", tx.hash);

  const rc = await tx.wait();

  console.log("L1 tx mined in block:", rc.blockNumber);

  // ---- L1 gas and fee information ----
  const gasUsedL1 = rc.gasUsed;
  const gasPrice = rc.effectiveGasPrice ?? (await provider.getFeeData()).gasPrice;
  const feeL1 = gasUsedL1 * gasPrice;

  console.log("L1 gasUsed:", gasUsedL1.toString());
  console.log("L1 fee (wei):", feeL1.toString());

  // ---- Additional L2 execution information ----
  const l2Gas =
    receiptL2.execution_resources?.gas_consumed ??
    receiptL2.actual_fee?.amount ??
    "n/a";

  console.log("L2 gasUsed:", String(l2Gas));
})().catch((e) => {
  console.error("[error]", e?.message ?? e);
  process.exit(1);
});