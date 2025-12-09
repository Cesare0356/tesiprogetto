// scripts/batch_send.js
// usage: node scripts/batch_send.js

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), override: true });
const { ethers } = require("ethers"); // v6

// ABI minimale del contratto L1
const CONTRACTMSG_ABI = [
  "function sendMessage(uint256 contractAddress,uint256 selector,uint256[] calldata payload) external payable"
];

// ===================== Config =====================
const BATCH_SIZES        = [16, 32, 64, 128, 256, 512];
const CHUNK_SIZE         = 64;            // divide batch grandi in pezzi più piccoli
const CONCURRENCY        = 4;             // una tx alla volta (reale)
const TX_INTERVAL_MS     = 1000;          // 1 tx al secondo
const CONFIRM_TIMEOUT_MS = 180_000;       // timeout attesa conferma
const VALUE_WEI          = 10_000n;       // value simbolico

const RETRIES_ON_SEND    = 3;
const RETRIES_ON_TIMEOUT = 1;
const BUMP_RATIO_SEND    = 1.20;
const BUMP_RATIO_TIMEOUT = 1.35;
// ===================================================

// --------------------- Utilità ---------------------
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitWithTimeout(provider, txHash, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const rc = await provider.getTransactionReceipt(txHash);
      if (rc) return rc;
    } catch (_) {}
    await sleep(4000);
  }
  return null;
}

const isUnderpriced = (msg) =>
  /replacement fee too low|max fee per gas less than block base fee|underpriced|fee too low|transaction underpriced/i.test(msg || "");

async function getDynamicFees(provider, tipGwei = "5") {
  const feeData = await provider.getFeeData();
  const latest  = await provider.getBlock("latest");
  const base    = latest?.baseFeePerGas ?? feeData.maxFeePerGas ?? feeData.gasPrice ?? ethers.parseUnits("5", "gwei");
  const tip     = feeData.maxPriorityFeePerGas ?? ethers.parseUnits(tipGwei, "gwei");
  const maxFee  = base * 2n + tip;
  return { maxPriorityFeePerGas: tip, maxFeePerGas: maxFee };
}

function bumpFees(fees, ratio) {
  const r = BigInt(Math.ceil(ratio * 100));
  const bump = (x) => (x * r) / 100n;
  const newPriority = bump(fees.maxPriorityFeePerGas);
  let   newMax      = bump(fees.maxFeePerGas);
  if (newMax <= newPriority) newMax = newPriority + 1n;
  return { maxPriorityFeePerGas: newPriority, maxFeePerGas: newMax };
}
// ---------------------------------------------------

(async function main() {
  const SEPOLIA_RPC_URL     = getEnv("SEPOLIA_RPC_URL");
  const SEPOLIA_PRIVATE_KEY = getEnv("SEPOLIA_PRIVATE_KEY");
  const CONTRACTMSG_ADDRESS = normHex(getEnv("CONTRACTMSG_ADDRESS"));
  const L2_CONTRACT_ADDRESS = normHex(getEnv("L2_CONTRACT_ADDRESS"));
  const STARKNET_SELECTOR   = normHex(getEnv("STARKNET_SELECTOR"));

  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
  const pk = SEPOLIA_PRIVATE_KEY.startsWith("0x") ? SEPOLIA_PRIVATE_KEY : "0x" + SEPOLIA_PRIVATE_KEY;
  const signer = new ethers.Wallet(pk, provider);
  const contract = new ethers.Contract(CONTRACTMSG_ADDRESS, CONTRACTMSG_ABI, signer);

  console.log("[sender]", signer.address);
  console.log("[balance start wei]", (await provider.getBalance(signer.address)).toString());

  for (const total of BATCH_SIZES) {
    console.log(`\n=== Batch totale ${total} ===`);
    const t0 = Date.now();

    const startNonce = await provider.getTransactionCount(signer.address, "pending");
    let baseFees = await getDynamicFees(provider, "5");
    console.log(`[fees] tip=${ethers.formatUnits(baseFees.maxPriorityFeePerGas,"gwei")} gwei  max=${ethers.formatUnits(baseFees.maxFeePerGas,"gwei")} gwei`);

    const lines = [];
    lines.push(`Batch size: ${total}`);
    lines.push(`Timestamp: ${new Date().toISOString()}`);
    lines.push(`Sender: ${signer.address}`);
    lines.push(`Contract L1: ${CONTRACTMSG_ADDRESS}`);
    lines.push(`L2 target: ${L2_CONTRACT_ADDRESS}`);
    lines.push(`Selector: ${STARKNET_SELECTOR}`);
    lines.push(`Value per tx (wei): ${VALUE_WEI}`);
    lines.push("");
    lines.push("tx_hash, status, block_L1");

    const allResults = [];
    const chunks = Math.ceil(total / CHUNK_SIZE);

    for (let c = 0; c < chunks; c++) {
      const chunkSize = Math.min(CHUNK_SIZE, total - c * CHUNK_SIZE);
      console.log(`\n--- Sotto-batch ${c+1}/${chunks} (size=${chunkSize}) ---`);
      baseFees = await getDynamicFees(provider, "5");

      let next = 0;
      let inFlight = 0;
      const workers = [];

      async function sendWithRetries(idxGlobal, nonce, payload) {
        let fees = { ...baseFees };
        for (let attempt = 0; attempt <= RETRIES_ON_SEND; attempt++) {
          try {
            const tx = await contract.sendMessage(
              BigInt(L2_CONTRACT_ADDRESS),
              BigInt(STARKNET_SELECTOR),
              payload,
              {
                value: VALUE_WEI,
                nonce,
                maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
                maxFeePerGas: fees.maxFeePerGas,
                type: 2,
              }
            );
            console.log(`  [sent #${idxGlobal} try=${attempt}] ${tx.hash}`);
            return { tx, fees };
          } catch (e) {
            const msg = e?.shortMessage ?? e?.message ?? String(e);
            if (isUnderpriced(msg) && attempt < RETRIES_ON_SEND) {
              fees = bumpFees(fees, BUMP_RATIO_SEND);
              console.warn(`    ↻ underpriced → bump & retry`);
              continue;
            }
            throw e;
          }
        }
      }

      async function sendOne(idxInChunk) {
        const idxGlobal = c * CHUNK_SIZE + idxInChunk;
        const nonce     = startNonce + idxGlobal;
        const payload   = [ BigInt(normHex(signer.address)), BigInt(1000 + idxGlobal) ];

        try {
          const { tx, fees } = await sendWithRetries(idxGlobal, nonce, payload);
          let rc = await waitWithTimeout(provider, tx.hash, CONFIRM_TIMEOUT_MS);

          if (!rc && RETRIES_ON_TIMEOUT > 0) {
            const rep = await sendWithRetries(idxGlobal, nonce, payload);
            rc = await waitWithTimeout(provider, rep.tx.hash, CONFIRM_TIMEOUT_MS);
          }

          if (!rc) {
            allResults.push({ txHash: tx.hash, status: "TIMEOUT", block: "" });
            return;
          }

          const ok = rc.status === 1 || rc.status === 1n;
          allResults.push({ txHash: tx.hash, status: ok ? "SUCCESS" : "FAILED", block: rc.blockNumber });
        } catch (e) {
          console.warn(`  [error #${idxGlobal}] ${e?.shortMessage ?? e?.message ?? e}`);
          allResults.push({ txHash: "", status: "ERROR", block: "" });
        }
      }

      async function runQueue() {
        while (next < chunkSize || inFlight > 0) {
          while (inFlight < CONCURRENCY && next < chunkSize) {
            inFlight++;
            const p = sendOne(next).finally(() => { inFlight--; });
            workers.push(p);
            next++;
            await sleep(TX_INTERVAL_MS); // invio ritmato
          }
          await sleep(200);
        }
        await Promise.allSettled(workers);
      }

      await runQueue();
      console.log(`--- Sotto-batch ${c+1} completato ---`);
    }

    const ok = allResults.filter(r => r.status === "SUCCESS");
    const blocks = ok.map(r => Number(r.block)).filter(Number.isFinite);
    const unique = Array.from(new Set(blocks)).sort((a,b)=>a-b);
    const span = blocks.length ? (Math.max(...blocks) - Math.min(...blocks) + 1) : 0;

    for (const r of allResults) {
      lines.push(`${r.txHash}, ${r.status}, ${r.block ?? ""}`);
    }

    lines.push("");
    lines.push("--- Analisi L1 ---");
    lines.push(`Confermate: ${ok.length}/${total}`);
    lines.push(`Blocchi unici: ${unique.length}, Intervallo: ${span}`);
    for (const b of unique) {
      const count = blocks.filter(x => x === b).length;
      lines.push(`  Blocco ${b}: ${count} tx`);
    }
    lines.push(`Durata batch (s): ${((Date.now()-t0)/1000).toFixed(1)}`);

    const filename = path.resolve(__dirname, `../batch_logs/batch_${total}.txt`);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, lines.join("\n"));
    console.log(`→ Log salvato in: ${filename}`);
  }

  console.log("[balance end wei]", (await provider.getBalance(signer.address)).toString());
})().catch((e) => {
  console.error("[fatal]", e?.message ?? e);
  process.exit(1);
});