#!/usr/bin/env node

/**
 * Sync deposit-only addresses for a specific market from a DorkFi staleness audit.
 *
 * Like sync-deposit-only.js, but scoped to a single market identified by
 * --contract-id and/or --pool-id.
 *
 * Usage:
 *   node scripts/sync-deposit-only-market.js <audit.json> --chain <chain> --contract-id <id> [options]
 *
 * Options:
 *   --chain <chain>     Chain: voi or algorand (required)
 *   --contract-id <id>  Filter to this contract ID (required)
 *   --pool-id <id>      Filter to this pool ID (optional, narrows further)
 *   --dry-run           Build transactions but don't submit (default)
 *   --submit            Actually sign and submit transactions
 *   --concurrency <N>   Max parallel operations (default: 3)
 *   --priority <tiers>  Comma-separated priorities (default: critical,high)
 *   --output <file>     Write JSON results to file
 *
 * Environment:
 *   MN     25-word Algorand mnemonic for signing & sender
 */

import "dotenv/config";
import fs from "node:fs";
import algosdk from "algosdk";
import { prepareSyncUserMarket } from "../lib/builders.js";
import { getAlgodClient } from "../lib/client.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    file: null,
    chain: null,
    contractId: null,
    poolId: null,
    submit: false,
    concurrency: 3,
    priorities: ["critical", "high"],
    output: null,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--submit") {
      opts.submit = true;
    } else if (args[i] === "--dry-run") {
      opts.submit = false;
    } else if (args[i] === "--chain" && args[i + 1]) {
      opts.chain = args[++i].toLowerCase();
    } else if (args[i] === "--contract-id" && args[i + 1]) {
      opts.contractId = parseInt(args[++i], 10);
    } else if (args[i] === "--pool-id" && args[i + 1]) {
      opts.poolId = parseInt(args[++i], 10);
    } else if (args[i] === "--concurrency" && args[i + 1]) {
      opts.concurrency = parseInt(args[++i], 10);
    } else if (args[i] === "--priority" && args[i + 1]) {
      opts.priorities = args[++i].split(",").map((s) => s.trim().toLowerCase());
    } else if (args[i] === "--output" && args[i + 1]) {
      opts.output = args[++i];
    } else if (args[i] === "--help") {
      console.log(`Usage: node scripts/sync-deposit-only-market.js <audit.json> --chain <chain> --contract-id <id> [options]

  <audit.json>           Path to audit JSON from audit-staleness.js --json
  --chain <chain>        Chain: voi or algorand (required)
  --contract-id <id>     Filter to this contract ID (required)
  --pool-id <id>         Filter to this pool ID (optional)
  --submit               Sign and submit transactions (default: dry-run)
  --dry-run              Build but don't submit (default)
  --concurrency <N>      Max parallel builds (default: 3)
  --priority <tiers>     Comma-separated priorities (default: critical,high)
  --output <file>        Write JSON results to file

Environment:
  MN      25-word Algorand mnemonic for signing`);
      process.exit(0);
    } else if (!args[i].startsWith("--")) {
      opts.file = args[i];
    }
  }

  if (!opts.file) {
    console.error("Error: Please provide the path to an audit JSON file.");
    console.error("Run with --help for usage.");
    process.exit(1);
  }

  if (!opts.chain || !["voi", "algorand"].includes(opts.chain)) {
    console.error("Error: --chain is required (voi or algorand).");
    console.error("Run with --help for usage.");
    process.exit(1);
  }

  if (opts.contractId == null) {
    console.error("Error: --contract-id is required.");
    console.error("Run with --help for usage.");
    process.exit(1);
  }

  return opts;
}

function loadAudit(path) {
  const raw = fs.readFileSync(path, "utf-8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data.candidates)) {
    throw new Error("Invalid audit JSON: missing 'candidates' array");
  }
  return data;
}

const CHAIN_TO_NETWORK = {
  voi: "voi-mainnet",
  algorand: "algorand-mainnet",
};

function findDepositOnlyCandidates(candidates, priorities, chain, contractId, poolId) {
  const network = CHAIN_TO_NETWORK[chain];
  const prioritySet = new Set(priorities);

  return candidates.filter(
    (c) =>
      prioritySet.has(c.priority) &&
      c.scaledDeposits > 0 &&
      c.network === network &&
      c.contractId === contractId &&
      (poolId == null || c.poolId === poolId),
  );
}

function getSender(mnemonic) {
  const { addr } = algosdk.mnemonicToSecretKey(mnemonic);
  return typeof addr === "string" ? addr : algosdk.encodeAddress(addr.publicKey);
}

function signTxnGroup(txnsB64, sk) {
  return txnsB64.map((b64) => {
    const bytes = Buffer.from(b64, "base64");
    const txn = algosdk.decodeUnsignedTransaction(bytes);
    const signed = txn.signTxn(sk);
    return signed;
  });
}

async function submitGroup(algod, signedTxns) {
  const combined = signedTxns.map((s) =>
    s instanceof Uint8Array ? s : new Uint8Array(s),
  );
  const resp = await algod.sendRawTransaction(combined).do();
  return resp.txid ?? resp.txId;
}

async function waitForConfirmation(algod, txId, rounds = 5) {
  const result = await algosdk.waitForConfirmation(algod, txId, rounds);
  return result;
}

async function processBatch(tasks, concurrency) {
  const results = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map((fn) => fn()));
    results.push(...batchResults);
  }
  return results;
}

async function main() {
  const opts = parseArgs();
  const audit = loadAudit(opts.file);
  const targets = findDepositOnlyCandidates(
    audit.candidates,
    opts.priorities,
    opts.chain,
    opts.contractId,
    opts.poolId,
  );

  if (targets.length === 0) {
    console.log(
      `No deposit-only positions found for contract ${opts.contractId}` +
        (opts.poolId != null ? ` in pool ${opts.poolId}` : "") +
        ` at priorities [${opts.priorities.join(", ")}].`,
    );
    process.exit(0);
  }

  const uniqueAddrs = new Set(targets.map((c) => c.address));
  const symbolSet = new Set(targets.map((c) => c.symbol));
  console.error(`Chain: ${opts.chain}`);
  console.error(`Market: contract=${opts.contractId}` + (opts.poolId != null ? ` pool=${opts.poolId}` : "") + ` symbol=${[...symbolSet].join(",")}`);
  console.error(`Found ${targets.length} deposit-only positions across ${uniqueAddrs.size} addresses`);
  console.error(`Priorities: ${opts.priorities.join(", ")}`);
  console.error(`Mode: ${opts.submit ? "SUBMIT" : "DRY-RUN"}\n`);

  let sender;
  let sk;
  const mnemonic = process.env.MN;

  if (opts.submit) {
    if (!mnemonic) {
      console.error("Error: MN env var required for --submit mode.");
      process.exit(1);
    }
    const account = algosdk.mnemonicToSecretKey(mnemonic);
    sk = account.sk;
    sender = typeof account.addr === "string"
      ? account.addr
      : algosdk.encodeAddress(account.addr.publicKey);
    console.error(`Sender: ${sender}\n`);
  } else if (mnemonic) {
    sender = getSender(mnemonic);
    console.error(`Sender: ${sender}\n`);
  } else {
    sender = targets[0].address;
    console.error(`Sender: ${sender} (from first candidate; set MN for real sender)\n`);
  }

  const results = { success: [], failed: [], skipped: [] };

  const tasks = targets.map((candidate) => async () => {
    const label = `${candidate.symbol} ${candidate.address.slice(0, 8)}...${candidate.address.slice(-4)} (${candidate.priority}, ${candidate.priceChangePercent}%)`;

    try {
      const { transactions, details } = await prepareSyncUserMarket(
        opts.chain,
        candidate.symbol,
        candidate.address,
        sender,
      );

      if (!opts.submit) {
        console.log(`  [dry-run] ${label} — ${transactions.length} txns built`);
        results.success.push({ ...candidate, txnCount: transactions.length });
        return;
      }

      const signed = signTxnGroup(transactions, sk);
      const algod = getAlgodClient(opts.chain);
      const txId = await submitGroup(algod, signed);
      await waitForConfirmation(algod, txId);

      console.log(`  [ok] ${label} — txId: ${txId}`);
      results.success.push({ ...candidate, txId });
    } catch (err) {
      console.error(`  [fail] ${label} — ${err.message}`);
      results.failed.push({ ...candidate, error: err.message });
    }
  });

  await processBatch(tasks, opts.concurrency);

  console.error(`\n── Summary ──────────────────────────────────`);
  console.error(`  Contract: ${opts.contractId}`);
  if (opts.poolId != null) console.error(`  Pool:     ${opts.poolId}`);
  console.error(`  Success:  ${results.success.length}`);
  console.error(`  Failed:   ${results.failed.length}`);
  console.error(`  Skipped:  ${results.skipped.length}`);

  if (results.failed.length > 0) {
    console.error(`\nFailed positions:`);
    for (const f of results.failed) {
      console.error(`  ${f.symbol} ${f.address} — ${f.error}`);
    }
  }

  if (opts.output) {
    const output = {
      timestamp: new Date().toISOString(),
      mode: opts.submit ? "submit" : "dry-run",
      chain: opts.chain,
      contractId: opts.contractId,
      poolId: opts.poolId,
      priorities: opts.priorities,
      ...results,
    };
    fs.writeFileSync(opts.output, JSON.stringify(output, null, 2) + "\n");
    console.error(`\nResults written to ${opts.output}`);
  }

  process.exit(results.failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(2);
});
