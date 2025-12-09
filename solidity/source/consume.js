// scripts/consume_from_l2_tx.js
// usage: node scripts/consume_from_l2_tx.js <L2_TX_HASH_STARKNET>
// nota: assicurati che <L2_TX_HASH_STARKNET> sia l'hash della transazione Starknet (felt ≤ 251 bit)

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), override: true });

const { ethers } = require("ethers"); // v6
const { RpcProvider } = require("starknet");

// ---- ABI minimale del tuo contract L1 che espone consumeMessageValue ----
const ABI = [
  "function consumeMessageValue(uint256 fromAddress, uint256[] calldata payload) external"
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

const toUint256Array = (arr) => arr.map((x) => {
  const n = BigInt(normHex(x));
  if (n < 0n) throw new Error(`valore negativo nel payload: ${x}`);
  return n;
});

(async () => {
  // ---- args ----
  const L2_TX_HASH = process.argv[2];
  if (!L2_TX_HASH) {
    throw new Error("uso: node scripts/consume_from_l2_tx.js <L2_TX_HASH_STARKNET>");
  }
  if (!isFelt(L2_TX_HASH)) {
    throw new Error("L2_TX_HASH deve essere un tx hash Starknet (felt ≤ 251 bit), non un hash EVM da 256 bit.");
  }

  // ---- env ----
  const SEPOLIA_RPC_URL     = getEnv("SEPOLIA_RPC_URL");      // EVM L1 Sepolia RPC
  const SEPOLIA_PRIVATE_KEY = getEnv("SEPOLIA_PRIVATE_KEY");  // chiave EVM
  const CONTRACTMSG_ADDRESS = normHex(getEnv("CONTRACTMSG_ADDRESS")); // contratto L1 che consuma
  const STARKNET_RPC_URL    = getEnv("STARKNET_RPC_URL");     // Starknet Sepolia RPC
  const L2_CONTRACT_ADDRESS = normHex(getEnv("L2_CONTRACT_ADDRESS")); // contratto Cairo mittente

  // opzionali: solo logging/diagnostica, non necessari per consumare
  const STARKNET_MESSAGING  = process.env.STARKNET_MESSAGING ? normHex(process.env.STARKNET_MESSAGING) : null;
  const STARKNET_SELECTOR   = process.env.STARKNET_SELECTOR ? normHex(process.env.STARKNET_SELECTOR) : null;

  console.log("[check] STARKNET_RPC_URL:", STARKNET_RPC_URL.slice(0, 60), "…");
  console.log("[check] L2_TX_HASH:", L2_TX_HASH);
  console.log("[check] CONTRACTMSG_ADDRESS (L1):", CONTRACTMSG_ADDRESS);
  console.log("[check] L2_CONTRACT_ADDRESS:", L2_CONTRACT_ADDRESS);

  if (!isFelt(L2_CONTRACT_ADDRESS)) {
    throw new Error(`L2_CONTRACT_ADDRESS non è un felt valido: ${L2_CONTRACT_ADDRESS}`);
  }

  // ---- L2: receipt e messaggio verso L1 ----
  const l2 = new RpcProvider({ nodeUrl: STARKNET_RPC_URL });
  const receiptL2 = await l2.getTransactionReceipt(L2_TX_HASH);

  // compatibilità campi (diverse versioni/SDK)
  const messages = receiptL2.messages_sent ?? receiptL2.messagesSent ?? [];
  if (!Array.isArray(messages)) {
    throw new Error("receipt L2 non contiene 'messages_sent' validi.");
  }

  // filtra il messaggio destinato al tuo contratto L1
  const target = CONTRACTMSG_ADDRESS;
  const msgToL1 = messages.find((m) => {
    const toAddr = normHex(m.to_address ?? m.toAddress);
    return toAddr === target;
  });

  if (!msgToL1) {
    const tos = messages.map((m) => normHex(m.to_address ?? m.toAddress));
    throw new Error(
      `nessun messaggio verso CONTRACTMSG_ADDRESS nella receipt L2. ` +
      `destinatari trovati: [${tos.join(", ")}], cercavo: ${target}`
    );
  }

  // estrai payload
  const rawPayload = (msgToL1.payload ?? msgToL1.payload_data ?? []);
  if (!Array.isArray(rawPayload) || rawPayload.length === 0) {
    throw new Error("payload del messaggio L2→L1 vuoto o non valido.");
  }

  // se vuoi, puoi anche verificare eventuale 'from_address'
  const fromL2InReceipt = normHex(msgToL1.from_address ?? msgToL1.fromAddress ?? "0x0");
  if (fromL2InReceipt !== "0x0" && fromL2InReceipt !== L2_CONTRACT_ADDRESS) {
    console.warn(`[warn] from_address nella receipt è ${fromL2InReceipt} diverso da L2_CONTRACT_ADDRESS ${L2_CONTRACT_ADDRESS}`);
  }

  // payload come array di uint256
  const payload = toUint256Array(rawPayload);

  // ---- L1: prepara provider/signer/contract ----
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
  const pk = SEPOLIA_PRIVATE_KEY.startsWith("0x") ? SEPOLIA_PRIVATE_KEY : "0x" + SEPOLIA_PRIVATE_KEY;
  const signer = new ethers.Wallet(pk, provider);
  const l1 = new ethers.Contract(CONTRACTMSG_ADDRESS, ABI, signer);

  // ---- call: consumeMessageValue(fromAddress, payload) ----
  const fromL2Felt = BigInt(L2_CONTRACT_ADDRESS);
  const tx = await l1.consumeMessageValue(fromL2Felt, payload);
  console.log("tx L1 inviata:", tx.hash);

  const rc = await tx.wait();
  console.log("tx L1 mined al block:", rc.blockNumber);

  // ---- costi/gas ----
  const gasUsedL1 = rc.gasUsed;
  const gasPrice  = rc.effectiveGasPrice ?? (await provider.getFeeData()).gasPrice;
  const feeL1     = gasUsedL1 * gasPrice;

  console.log("L1 gasUsed:", gasUsedL1.toString());
  console.log("L1 fee (wei):", feeL1.toString());

  // ---- info L2 aggiuntive ----
  const l2Gas = receiptL2.execution_resources?.gas_consumed ?? receiptL2.actual_fee?.amount ?? "n/d";
  console.log("L2 gasUsed:", String(l2Gas));
})().catch((e) => {
  console.error("[errore]", e?.message ?? e);
  process.exit(1);
});