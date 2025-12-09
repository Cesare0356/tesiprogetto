// scripts/send.js
// usage: node scripts/send.js

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), override: true });

const { ethers } = require("ethers"); // v6
const { RpcProvider } = require("starknet");

// ABI minimale di ContractMsg (L1)
const CONTRACTMSG_ABI = [
  "function sendMessage(uint256 contractAddress,uint256 selector,uint256[] calldata payload) external payable"
];

// ---- utils ----
const normHex = (x) => {
  let s = String(x ?? "0x0").trim().toLowerCase();
  if (!s.startsWith("0x")) s = "0x" + s;
  s = "0x" + s.slice(2).replace(/^0+/, "");
  return s === "0x" ? "0x0" : s;
};

const getEnv = (k) => {
  const v = process.env[k];
  if (!v || !String(v).trim()) throw new Error(`manca ${k} nel .env`);
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
  // ---- ENV obbligatori ----
  const SEPOLIA_RPC_URL     = getEnv("SEPOLIA_RPC_URL");      // RPC EVM Sepolia
  const SEPOLIA_PRIVATE_KEY = getEnv("SEPOLIA_PRIVATE_KEY");  // pk EVM
  const CONTRACTMSG_ADDRESS = normHex(getEnv("CONTRACTMSG_ADDRESS")); // L1 contract
  const L2_CONTRACT_ADDRESS = normHex(getEnv("L2_CONTRACT_ADDRESS")); // Cairo (felt)
  const STARKNET_SELECTOR   = normHex(getEnv("STARKNET_SELECTOR"));   // entry point selector (felt)
  const STARKNET_RPC_URL    = getEnv("STARKNET_RPC_URL");     // Starknet Sepolia RPC

  // ---- Checks utili ----
  console.log("[check] .env path:", path.resolve(__dirname, "../.env"));
  console.log("[check] SEPOLIA_RPC_URL:", SEPOLIA_RPC_URL.slice(0, 60), "…");
  console.log("[check] STARKNET_RPC_URL:", STARKNET_RPC_URL.slice(0, 60), "…");
  console.log("[check] CONTRACTMSG_ADDRESS (L1):", CONTRACTMSG_ADDRESS);
  console.log("[check] L2_CONTRACT_ADDRESS:", L2_CONTRACT_ADDRESS);
  console.log("[check] STARKNET_SELECTOR:", STARKNET_SELECTOR);

  if (!isFelt(L2_CONTRACT_ADDRESS)) throw new Error(`L2_CONTRACT_ADDRESS non è un felt valido: ${L2_CONTRACT_ADDRESS}`);
  if (!isFelt(STARKNET_SELECTOR))   throw new Error(`STARKNET_SELECTOR non è un felt valido: ${STARKNET_SELECTOR}`);

  // ---- L1 provider/signer ----
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
  const pk = SEPOLIA_PRIVATE_KEY.startsWith("0x") ? SEPOLIA_PRIVATE_KEY : "0x" + SEPOLIA_PRIVATE_KEY;
  const signer = new ethers.Wallet(pk, provider);

  // ---- Contratto L1 ----
  const contract = new ethers.Contract(CONTRACTMSG_ADDRESS, CONTRACTMSG_ABI, signer);

  // ---- Payload: [EVM address -> felt, value demo] ----
  // L'address EVM (20B) entra nel felt senza problemi
  const payload = [ BigInt(normHex(signer.address)), 42n ];
  const payloadHex = payload.map(x => "0x" + x.toString(16));

  // ---- Stima fee L2 (obbligatoria su Sepolia/mainnet) ----
  const l2 = new RpcProvider({ nodeUrl: STARKNET_RPC_URL });

  // NB: su RPC v0.8 il parametro blockId può essere "latest"
  const feeEst = await l2.estimateMessageFee({
    from_address: CONTRACTMSG_ADDRESS,   // L1 contract address (hex)
    to_address:   L2_CONTRACT_ADDRESS,   // L2 target (felt)
    entry_point_selector: STARKNET_SELECTOR, // selector (felt)
    payload: payloadHex,                 // array di hex
  }, "latest");

  const overall_fee = BigInt(feeEst.overall_fee ?? feeEst.suggestedMaxFee ?? 0n);
  if (overall_fee === 0n) throw new Error("overall_fee == 0: la stima L2 ha fallito (controlla RPC/indirizzi/selector).");

  // buffer 20%
  const deposit = overall_fee + (overall_fee / 5n);

  console.log("overall_fee L2:", overall_fee.toString(), feeEst.unit ?? "WEI");
  console.log("deposit (buffer):", deposit.toString());

  // ---- Invio L1 -> L2 con value (deposito) ----
  const tx = await contract.sendMessage(
    BigInt(L2_CONTRACT_ADDRESS),
    BigInt(STARKNET_SELECTOR),
    payload,
    { value: deposit }
  );

  console.log("tx L1 hash:", tx.hash);
  const rc = await tx.wait();
  console.log("L1 gasUsed:", rc.gasUsed.toString());
  console.log("deposit inviato (wei):", deposit.toString());
})().catch((e) => {
  console.error("[errore]", e?.message ?? e);
  process.exit(1);
});