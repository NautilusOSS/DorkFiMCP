#!/usr/bin/env node

/**
 * Sync stale positions from a DorkFi staleness audit (sync_user_market_for_price_change).
 *
 * Replaces: sync-positions.js, sync-deposit-only.js, sync-deposit-only-market.js
 *
 * Usage:
 *   node scripts/sync-position.js <audit.json> [options]
 *
 * Modes:
 *   (default)           All stale rows: any user with deposit or borrow in that row
 *   --deposit-only      Only addresses that have no borrows on any market (deposit-only)
 *   --deposit-only      + --chain + --contract-id [--pool-id]  → deposit-only, one market
 *
 * Optional filters (any mode):
 *   --chain + --contract-id [--pool-id]  Limit to one market (network + contract ID)
 *   --symbol <SYM>                        Limit by market symbol (e.g. VOI)
 *
 * Common:
 *   --dry-run | --submit   (default dry-run)
 *   --priority <tiers>     default: critical,high
 *   --concurrency <N>      default: 3
 *   --output <file>        JSON results
 *
 * Environment:
 *   MN   25-word mnemonic (required for --submit)
 */

import "dotenv/config";
import fs from "node:fs";
import algosdk from "algosdk";
import { prepareSyncUserMarket } from "../lib/builders.js";
import { getAlgodClient } from "../lib/client.js";

const NETWORK_TO_CHAIN = {
  "voi-mainnet": "voi",
  "algorand-mainnet": "algorand",
};

const CHAIN_TO_NETWORK = {
  voi: "voi-mainnet",
  algorand: "algorand-mainnet",
};

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    file: null,
    depositOnly: false,
    chain: null,
    contractId: null,
    poolId: null,
    submit: false,
    concurrency: 3,
    priorities: ["critical", "high"],
    symbol: null,
    output: null,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--submit") opts.submit = true;
    else if (args[i] === "--dry-run") opts.submit = false;
    else if (args[i] === "--deposit-only") opts.depositOnly = true;
    else if (args[i] === "--chain" && args[i + 1]) opts.chain = args[++i].toLowerCase();
    else if (args[i] === "--contract-id" && args[i + 1])
      opts.contractId = parseInt(args[++i], 10);
    else if (args[i] === "--pool-id" && args[i + 1])
      opts.poolId = parseInt(args[++i], 10);
    else if (args[i] === "--concurrency" && args[i + 1])
      opts.concurrency = parseInt(args[++i], 10);
    else if (args[i] === "--priority" && args[i + 1])
      opts.priorities = args[++i].split(",").map((s) => s.trim().toLowerCase());
    else if (args[i] === "--symbol" && args[i + 1])
      opts.symbol = args[++i].toUpperCase();
    else if (args[i] === "--output" && args[i + 1]) opts.output = args[++i];
    else if (args[i] === "--help") {
      console.log(`Usage: node scripts/sync-position.js <audit.json> [options]

  <audit.json>           From audit.js --mode staleness --json

Modes:
  (default)              Sync every matching stale row (borrowers + depositors)
  --deposit-only         Only users with no borrows anywhere; still stale on a deposit row

Filters:
  --chain voi|algorand   With --contract-id: limit to that market
  --contract-id <id>     Market contract ID (requires --chain)
  --pool-id <id>         Optional pool ID
  --symbol <SYM>         e.g. VOI, USDC

Actions:
  --submit               Sign and submit (needs MN)
  --dry-run              Default: build only

  --priority <tiers>     default: critical,high
  --concurrency <N>      default: 3
  --output <file>        JSON log

Examples:
  node scripts/sync-position.js audit.json
  node scripts/sync-position.js audit.json --symbol VOI --submit
  node scripts/sync-position.js audit.json --deposit-only --submit
  node scripts/sync-position.js audit.json --deposit-only --chain voi --contract-id 47138068 --submit

Environment:
  MN                     Mnemonic for --submit`);
      process.exit(0);
    } else if (!args[i].startsWith("--")) opts.file = args[i];
  }

  if (!opts.file) {
    console.error("Error: path to audit JSON required. Try --help.");
    process.exit(1);
  }
  if (opts.contractId != null) {
    if (!opts.chain || !CHAIN_TO_NETWORK[opts.chain]) {
      console.error("Error: --chain voi|algorand is required with --contract-id.");
      process.exit(1);
    }
  }

  return opts;
}

function loadAudit(path) {
  const data = JSON.parse(fs.readFileSync(path, "utf-8"));
  if (!Array.isArray(data.candidates)) {
    throw new Error("Invalid audit JSON: missing 'candidates' array");
  }
  return data;
}

/**
 * @param {any[]} candidates
 * @param {{ depositOnly: boolean, priorities: string[], symbol: string | null, chain: string | null, contractId: number | null, poolId: number | null }} opts
 */
function selectTargets(candidates, opts) {
  const prioritySet = new Set(opts.priorities);
  let pool = candidates.filter((c) => prioritySet.has(c.priority));

  if (opts.depositOnly) {
    const borrowers = new Set(
      candidates.filter((c) => c.scaledBorrows > 0).map((c) => c.address),
    );
    pool = pool.filter(
      (c) => c.scaledDeposits > 0 && !borrowers.has(c.address),
    );
  } else {
    pool = pool.filter(
      (c) => c.scaledDeposits > 0 || c.scaledBorrows > 0,
    );
  }

  if (opts.symbol) pool = pool.filter((c) => c.symbol === opts.symbol);

  if (opts.contractId != null) {
    const network = CHAIN_TO_NETWORK[opts.chain];
    pool = pool.filter(
      (c) =>
        c.network === network &&
        c.contractId === opts.contractId &&
        (opts.poolId == null || c.poolId === opts.poolId),
    );
  }

  return pool;
}

function getSender(mnemonic) {
  const { addr } = algosdk.mnemonicToSecretKey(mnemonic);
  return typeof addr === "string" ? addr : algosdk.encodeAddress(addr.publicKey);
}

function signTxnGroup(txnsB64, sk) {
  return txnsB64.map((b64) => {
    const txn = algosdk.decodeUnsignedTransaction(Buffer.from(b64, "base64"));
    return txn.signTxn(sk);
  });
}

async function submitGroup(algod, signedTxns) {
  const combined = signedTxns.map(
    (s) => (s instanceof Uint8Array ? s : new Uint8Array(s)),
  );
  const resp = await algod.sendRawTransaction(combined).do();
  return resp.txid ?? resp.txId;
}

async function processBatch(tasks, concurrency) {
  const results = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    results.push(
      ...(await Promise.allSettled(batch.map((fn) => fn()))),
    );
  }
  return results;
}

async function main() {
  const opts = parseArgs();
  const audit = loadAudit(opts.file);
  const targets = selectTargets(audit.candidates, opts);

  if (targets.length === 0) {
    console.log("No matching stale positions for this filter.");
    process.exit(0);
  }

  const uniqueAddrs = new Set(targets.map((c) => c.address));
  console.error(`Mode: ${opts.depositOnly ? "deposit-only" : "all"}${opts.contractId != null ? ` market contract=${opts.contractId}` : ""}${opts.poolId != null ? ` pool=${opts.poolId}` : ""}${opts.symbol ? ` symbol=${opts.symbol}` : ""}`);
  console.error(`Found ${targets.length} positions, ${uniqueAddrs.size} addresses`);
  if (!opts.depositOnly) {
    const borrowers = targets.filter((c) => c.scaledBorrows > 0);
    const depOnly = targets.filter((c) => c.scaledBorrows === 0);
    console.error(`  With borrow: ${borrowers.length}  Deposit-only rows: ${depOnly.length}`);
  }
  console.error(`Priorities: ${opts.priorities.join(", ")}`);
  console.error(`${opts.submit ? "SUBMIT" : "DRY-RUN"}\n`);

  const mnemonic = process.env.MN;
  let sender;
  let sk;
  if (opts.submit) {
    if (!mnemonic) {
      console.error("MN required for --submit.");
      process.exit(1);
    }
    const account = algosdk.mnemonicToSecretKey(mnemonic);
    sk = account.sk;
    sender =
      typeof account.addr === "string"
        ? account.addr
        : algosdk.encodeAddress(account.addr.publicKey);
  } else if (mnemonic) {
    sender = getSender(mnemonic);
  } else {
    sender = targets[0].address;
  }
  console.error(`Sender: ${sender}\n`);

  const results = { success: [], failed: [], skipped: [] };
  const tasks = targets.map((candidate) => async () => {
    const chain = NETWORK_TO_CHAIN[candidate.network];
    if (!chain) {
      results.skipped.push(candidate);
      console.error(`  [skip] ${candidate.network}`);
      return;
    }
    const type = candidate.scaledBorrows > 0 ? "borrow" : "deposit";
    const label = `${candidate.symbol} ${candidate.address.slice(0, 8)}…${candidate.address.slice(-4)} (${type}, ${candidate.priority})`;

    try {
      const { transactions } = await prepareSyncUserMarket(
        chain,
        candidate.poolId,
        candidate.contractId,
        candidate.address,
        sender,
      );
      if (!opts.submit) {
        console.log(`  [dry-run] ${label} — ${transactions.length} txns`);
        results.success.push({ ...candidate, txnCount: transactions.length });
        return;
      }
      const txId = await submitGroup(
        getAlgodClient(chain),
        signTxnGroup(transactions, sk),
      );
      await algosdk.waitForConfirmation(getAlgodClient(chain), txId, 5);
      console.log(`  [ok] ${label} — ${txId}`);
      results.success.push({ ...candidate, txId });
    } catch (err) {
      console.error(`  [fail] ${label} — ${err.message}`);
      results.failed.push({ ...candidate, error: err.message });
    }
  });

  await processBatch(tasks, opts.concurrency);

  console.error(`\n── Summary ── success ${results.success.length} failed ${results.failed.length} skipped ${results.skipped.length}`);
  if (opts.output) {
    fs.writeFileSync(
      opts.output,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          mode: opts.depositOnly ? "deposit-only" : "all",
          submit: opts.submit,
          priorities: opts.priorities,
          symbol: opts.symbol,
          chain: opts.chain,
          contractId: opts.contractId,
          poolId: opts.poolId,
          ...results,
        },
        null,
        2,
      ) + "\n",
    );
    console.error(`Wrote ${opts.output}`);
  }
  process.exit(results.failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
