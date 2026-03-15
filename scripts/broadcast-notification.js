#!/usr/bin/env node

/**
 * Broadcast a notification to all DorkFi users on a chain via transaction notes.
 *
 * Sends a 0-amount native payment (VOI or ALGO) to every unique user address
 * with the notification message encoded in the transaction note field.
 *
 * Usage:
 *   node scripts/broadcast-notification.js --chain <voi|algorand> [options]
 *
 * Options:
 *   --chain <voi|algorand>  Target chain (required)
 *   --dry-run               Build transactions but don't submit (default)
 *   --submit                Actually sign and submit transactions
 *   --concurrency <N>       Max parallel submissions (default: 3)
 *   --output <file>         Write JSON results to file
 *   --delay <ms>            Delay between batches in ms (default: 500)
 *
 * Environment:
 *   MN     25-word Algorand mnemonic for signing & sender
 */

import "dotenv/config";
import fs from "node:fs";
import algosdk from "algosdk";
import { getAlgodClient } from "../lib/client.js";
import { getAllUsers } from "../lib/positions.js";

const NOTIFICATION_MESSAGE =
  "DorkFi Notification: Review your positions over the next 3 to 4 days. " +
  "Consider reducing borrows, depositing additional collateral, or repaying " +
  "loans to maintain healthy collateralization and reduce liquidation risk. " +
  "Responsible position management helps keep markets stable.";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    chain: null,
    submit: false,
    concurrency: 3,
    output: null,
    delay: 500,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--chain" && args[i + 1]) {
      opts.chain = args[++i];
    } else if (args[i] === "--submit") {
      opts.submit = true;
    } else if (args[i] === "--dry-run") {
      opts.submit = false;
    } else if (args[i] === "--concurrency" && args[i + 1]) {
      opts.concurrency = parseInt(args[++i], 10);
    } else if (args[i] === "--output" && args[i + 1]) {
      opts.output = args[++i];
    } else if (args[i] === "--delay" && args[i + 1]) {
      opts.delay = parseInt(args[++i], 10);
    } else if (args[i] === "--help") {
      console.log(`Usage: node scripts/broadcast-notification.js --chain <voi|algorand> [options]

  --chain <voi|algorand>  Target chain (required)
  --submit                Sign and submit transactions (default: dry-run)
  --dry-run               Build but don't submit (default)
  --concurrency <N>       Max parallel submissions (default: 3)
  --delay <ms>            Delay between batches in ms (default: 500)
  --output <file>         Write JSON results to file

Environment:
  MN      25-word Algorand mnemonic for signing`);
      process.exit(0);
    }
  }

  if (!opts.chain || !["voi", "algorand"].includes(opts.chain)) {
    console.error("Error: --chain <voi|algorand> is required.");
    console.error("Run with --help for usage.");
    process.exit(1);
  }

  return opts;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildPaymentTxn(algod, sender, receiver, note) {
  const params = await algod.getTransactionParams().do();
  return algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender,
    receiver,
    amount: 0,
    note: new TextEncoder().encode(note),
    suggestedParams: params,
  });
}

async function processBatch(tasks, concurrency, delayMs) {
  const results = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map((fn) => fn()));
    results.push(...batchResults);
    if (i + concurrency < tasks.length && delayMs > 0) {
      await sleep(delayMs);
    }
  }
  return results;
}

async function main() {
  const opts = parseArgs();

  const mnemonic = process.env.MN;
  if (!mnemonic) {
    console.error("Error: MN env var (25-word mnemonic) is required.");
    process.exit(1);
  }

  const account = algosdk.mnemonicToSecretKey(mnemonic);
  const sk = account.sk;
  const sender =
    typeof account.addr === "string"
      ? account.addr
      : algosdk.encodeAddress(account.addr.publicKey);

  console.error(`Chain:  ${opts.chain}`);
  console.error(`Sender: ${sender}`);
  console.error(`Mode:   ${opts.submit ? "SUBMIT" : "DRY-RUN"}`);
  console.error(`Note:   ${NOTIFICATION_MESSAGE.slice(0, 60)}...`);
  console.error("");

  console.error("Fetching all users...");
  const { users } = await getAllUsers(opts.chain);
  const addresses = [...new Set(users.map((u) => u.address))];

  // skip sending to self
  const recipients = addresses.filter((a) => a !== sender);
  console.error(`Total users: ${users.length}`);
  console.error(`Recipients:  ${recipients.length} (excluding sender)\n`);

  if (recipients.length === 0) {
    console.error("No recipients found.");
    process.exit(0);
  }

  const algod = getAlgodClient(opts.chain);
  const results = { success: [], failed: [], skipped: [] };

  const tasks = recipients.map((address) => async () => {
    const short = `${address.slice(0, 8)}...${address.slice(-4)}`;
    try {
      const txn = await buildPaymentTxn(
        algod,
        sender,
        address,
        NOTIFICATION_MESSAGE,
      );

      if (!opts.submit) {
        console.log(`  [dry-run] → ${short}`);
        results.success.push({ address, status: "dry-run" });
        return;
      }

      const signed = txn.signTxn(sk);
      const { txId } = await algod
        .sendRawTransaction(new Uint8Array(signed))
        .do();
      await algosdk.waitForConfirmation(algod, txId, 4);

      console.log(`  [ok] → ${short}  txId: ${txId}`);
      results.success.push({ address, txId });
    } catch (err) {
      console.error(`  [fail] → ${short}  ${err.message}`);
      results.failed.push({ address, error: err.message });
    }
  });

  await processBatch(tasks, opts.concurrency, opts.delay);

  console.error(`\n── Summary ──────────────────────────────────`);
  console.error(`  Recipients: ${recipients.length}`);
  console.error(`  Success:    ${results.success.length}`);
  console.error(`  Failed:     ${results.failed.length}`);

  if (results.failed.length > 0) {
    console.error(`\nFailed addresses:`);
    for (const f of results.failed) {
      console.error(`  ${f.address} — ${f.error}`);
    }
  }

  if (opts.output) {
    const output = {
      timestamp: new Date().toISOString(),
      chain: opts.chain,
      sender,
      mode: opts.submit ? "submit" : "dry-run",
      message: NOTIFICATION_MESSAGE,
      recipientCount: recipients.length,
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
