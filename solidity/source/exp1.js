const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), override: true });

const { ethers } = require("ethers"); // ethers v6

// Minimal ABI of the L1 gateway contract.
// Only the function used in this batch experiment is needed.
const CONTRACTMSG_ABI = [
  "function sendPaymentAuthorizationToL2(uint256 contractAddress,uint256 selector,uint256[] calldata payload) external payable"
];

// ===================== Config =====================
// Batch sizes used to test the behavior of the L1 gateway under increasing load.
const BATCH_SIZES = [16, 32, 64, 128, 256, 512];

// Large batches are split into smaller chunks to avoid submitting too many
// transactions to the RPC endpoint at the same time.
const CHUNK_SIZE = 64;

// Maximum number of transactions submitted in parallel.
const CONCURRENCY = 4;

// Delay between submissions, useful to avoid RPC throttling.
const TX_INTERVAL_MS = 1000;

// Maximum time to wait for a transaction receipt before marking it as timed out.
const CONFIRM_TIMEOUT_MS = 180_000;

// Symbolic ETH value sent with each L1 -> L2 message.
const VALUE_WEI = 10_000n;

// Retry configuration used when a transaction is rejected because the fee is too low.
const RETRIES_ON_SEND = 3;
const RETRIES_ON_TIMEOUT = 1;
const BUMP_RATIO_SEND = 1.20;
const BUMP_RATIO_TIMEOUT = 1.35;
// ===================================================

// --------------------- Utils ---------------------
// Normalize an input value into a lowercase hexadecimal string.
const normHex = (x) => {
  let s = String(x ?? "0x0").trim().toLowerCase();
  if (!s.startsWith("0x")) s = "0x" + s;
  s = "0x" + s.slice(2).replace(/^0+/, "");
  return s === "0x" ? "0x0" : s;
};

// Read a required environment variable and fail early if it is missing.
const getEnv = (k) => {
  const v = process.env[k];
  if (!v || !String(v).trim()) throw new Error(`missing ${k} in .env`);
  return String(v).trim();
};

// Simple async delay helper.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for a transaction receipt until the timeout expires.
// If the receipt is not found in time, the function returns null.
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

// Detect common fee-related errors that can be solved by resubmitting
// the transaction with higher EIP-1559 fees.
const isUnderpriced = (msg) =>
  /replacement fee too low|max fee per gas less than block base fee|underpriced|fee too low|transaction underpriced/i.test(msg || "");

// Compute dynamic EIP-1559 fees from the latest block and provider data.
async function getDynamicFees(provider, tipGwei = "5") {
  const feeData = await provider.getFeeData();
  const latest = await provider.getBlock("latest");

  const base =
    latest?.baseFeePerGas ??
    feeData.maxFeePerGas ??
    feeData.gasPrice ??
    ethers.parseUnits("5", "gwei");

  const tip = feeData.maxPriorityFeePerGas ?? ethers.parseUnits(tipGwei, "gwei");
  const maxFee = base * 2n + tip;

  return {
    maxPriorityFeePerGas: tip,
    maxFeePerGas: maxFee,
  };
}

// Increase the current fee parameters by a fixed ratio.
// This is used when the previous transaction attempt was underpriced.
function bumpFees(fees, ratio) {
  const r = BigInt(Math.ceil(ratio * 100));
  const bump = (x) => (x * r) / 100n;

  const newPriority = bump(fees.maxPriorityFeePerGas);
  let newMax = bump(fees.maxFeePerGas);

  if (newMax <= newPriority) newMax = newPriority + 1n;

  return {
    maxPriorityFeePerGas: newPriority,
    maxFeePerGas: newMax,
  };
}
// ---------------------------------------------------

(async function main() {
  // Load the required L1 and L2 configuration from the environment.
  const SEPOLIA_RPC_URL = getEnv("SEPOLIA_RPC_URL");
  const SEPOLIA_PRIVATE_KEY = getEnv("SEPOLIA_PRIVATE_KEY");
  const CONTRACTMSG_ADDRESS = normHex(getEnv("CONTRACTMSG_ADDRESS"));
  const L2_CONTRACT_ADDRESS = normHex(getEnv("L2_CONTRACT_ADDRESS"));
  const STARKNET_SELECTOR = normHex(getEnv("STARKNET_SELECTOR"));

  // Create the Sepolia provider, signer, and contract instance.
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
  const pk = SEPOLIA_PRIVATE_KEY.startsWith("0x")
    ? SEPOLIA_PRIVATE_KEY
    : "0x" + SEPOLIA_PRIVATE_KEY;

  const signer = new ethers.Wallet(pk, provider);
  const contract = new ethers.Contract(CONTRACTMSG_ADDRESS, CONTRACTMSG_ABI, signer);

  console.log("[sender]", signer.address);
  console.log("[balance start wei]", (await provider.getBalance(signer.address)).toString());

  for (const total of BATCH_SIZES) {
    console.log(`\n=== Total batch ${total} ===`);

    const t0 = Date.now();

    // Use the pending nonce as the starting point and manually assign
    // one nonce to each transaction in the batch.
    const startNonce = await provider.getTransactionCount(signer.address, "pending");

    // Fetch the initial dynamic fees for this batch.
    let baseFees = await getDynamicFees(provider, "5");

    console.log(
      `[fees] tip=${ethers.formatUnits(baseFees.maxPriorityFeePerGas, "gwei")} gwei  max=${ethers.formatUnits(baseFees.maxFeePerGas, "gwei")} gwei`
    );

    // Prepare the output log for this batch.
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

      console.log(`\n--- Sub-batch ${c + 1}/${chunks} (size=${chunkSize}) ---`);

      // Refresh the base fees before each sub-batch, since Sepolia gas
      // conditions may change while the experiment is running.
      baseFees = await getDynamicFees(provider, "5");

      let next = 0;
      let inFlight = 0;
      const workers = [];

      // Send one transaction with retry support.
      // If the transaction is rejected as underpriced, the fee is bumped
      // and the same transaction is attempted again.
      async function sendWithRetries(idxGlobal, nonce, payload) {
        let fees = { ...baseFees };

        for (let attempt = 0; attempt <= RETRIES_ON_SEND; attempt++) {
          try {
            const tx = await contract.sendPaymentAuthorizationToL2(
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
              console.warn("    -> underpriced, bumping fees and retrying");
              continue;
            }

            throw e;
          }
        }
      }

      // Build and submit a single L1 -> L2 message transaction.
      // The payload contains the sender address and a synthetic value
      // used to make each transaction distinct.
      async function sendOne(idxInChunk) {
        const idxGlobal = c * CHUNK_SIZE + idxInChunk;
        const nonce = startNonce + idxGlobal;
        const payload = [BigInt(normHex(signer.address)), BigInt(1000 + idxGlobal)];

        try {
          const { tx } = await sendWithRetries(idxGlobal, nonce, payload);

          let rc = await waitWithTimeout(provider, tx.hash, CONFIRM_TIMEOUT_MS);

          // If the transaction was sent but no receipt arrives in time,
          // try one replacement attempt with the same nonce.
          if (!rc && RETRIES_ON_TIMEOUT > 0) {
            const rep = await sendWithRetries(idxGlobal, nonce, payload);
            rc = await waitWithTimeout(provider, rep.tx.hash, CONFIRM_TIMEOUT_MS);
          }

          if (!rc) {
            allResults.push({ txHash: tx.hash, status: "TIMEOUT", block: "" });
            return;
          }

          const ok = rc.status === 1 || rc.status === 1n;

          allResults.push({
            txHash: tx.hash,
            status: ok ? "SUCCESS" : "FAILED",
            block: rc.blockNumber,
          });
        } catch (e) {
          console.warn(`  [error #${idxGlobal}] ${e?.shortMessage ?? e?.message ?? e}`);
          allResults.push({ txHash: "", status: "ERROR", block: "" });
        }
      }

      // Queue runner with bounded concurrency.
      // It keeps at most CONCURRENCY transactions active and spaces out
      // submissions by TX_INTERVAL_MS.
      async function runQueue() {
        while (next < chunkSize || inFlight > 0) {
          while (inFlight < CONCURRENCY && next < chunkSize) {
            inFlight++;

            const p = sendOne(next).finally(() => {
              inFlight--;
            });

            workers.push(p);
            next++;

            await sleep(TX_INTERVAL_MS);
          }

          await sleep(200);
        }

        await Promise.allSettled(workers);
      }

      await runQueue();

      console.log(`--- Sub-batch ${c + 1} completed ---`);
    }

    // Analyze how many transactions succeeded and how they were distributed
    // across L1 blocks.
    const ok = allResults.filter((r) => r.status === "SUCCESS");
    const blocks = ok.map((r) => Number(r.block)).filter(Number.isFinite);
    const unique = Array.from(new Set(blocks)).sort((a, b) => a - b);
    const span = blocks.length ? Math.max(...blocks) - Math.min(...blocks) + 1 : 0;

    for (const r of allResults) {
      lines.push(`${r.txHash}, ${r.status}, ${r.block ?? ""}`);
    }

    lines.push("");
    lines.push("--- L1 analysis ---");
    lines.push(`Confirmed: ${ok.length}/${total}`);
    lines.push(`Unique blocks: ${unique.length}, Span: ${span}`);

    for (const b of unique) {
      const count = blocks.filter((x) => x === b).length;
      lines.push(`  Block ${b}: ${count} tx`);
    }

    lines.push(`Batch duration (s): ${((Date.now() - t0) / 1000).toFixed(1)}`);

    // Save the batch log to disk for later analysis.
    const filename = path.resolve(__dirname, `../batch_logs/batch_${total}.txt`);

    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, lines.join("\n"));

    console.log(`-> Log saved in: ${filename}`);
  }

  console.log("[balance end wei]", (await provider.getBalance(signer.address)).toString());
})().catch((e) => {
  console.error("[fatal]", e?.message ?? e);
  process.exit(1);
});