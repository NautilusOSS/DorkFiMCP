#!/usr/bin/env node

/**
 * Send an urgent liquidation-risk notification to a specific address
 * via a 0-amount native payment with the message in the transaction note.
 *
 * Usage:
 *   node scripts/send-liquidation-warning.js --chain <voi|algorand> --address <RECIPIENT>
 *
 * Options:
 *   --chain <voi|algorand>  Target chain (required)
 *   --address <addr>        Recipient wallet address (required)
 *   --dry-run               Build transaction but don't submit (default)
 *   --submit                Actually sign and submit the transaction
 *
 * Environment:
 *   MN     25-word Algorand mnemonic for signing & sender
 */

import "dotenv/config";
import algosdk from "algosdk";
import { getAlgodClient } from "../lib/client.js";

const NOTIFICATION_MESSAGE =
  "DorkFi Urgent Notification: Your account has been identified as having " +
  "high liquidation risk. Please repay part of your loan or add additional " +
  "collateral immediately to improve your position health and reduce the " +
  "risk of liquidation.";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { chain: null, address: null, submit: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--chain" && args[i + 1]) {
      opts.chain = args[++i];
    } else if (args[i] === "--address" && args[i + 1]) {
      opts.address = args[++i];
    } else if (args[i] === "--submit") {
      opts.submit = true;
    } else if (args[i] === "--dry-run") {
      opts.submit = false;
    } else if (args[i] === "--help") {
      console.log(`Usage: node scripts/send-liquidation-warning.js --chain <voi|algorand> --address <RECIPIENT> [options]

  --chain <voi|algorand>  Target chain (required)
  --address <addr>        Recipient wallet address (required)
  --submit                Sign and submit the transaction (default: dry-run)
  --dry-run               Build but don't submit (default)

Environment:
  MN      25-word Algorand mnemonic for signing`);
      process.exit(0);
    }
  }

  if (!opts.chain || !["voi", "algorand"].includes(opts.chain)) {
    console.error("Error: --chain <voi|algorand> is required.");
    process.exit(1);
  }
  if (!opts.address) {
    console.error("Error: --address <recipient> is required.");
    process.exit(1);
  }

  try {
    algosdk.decodeAddress(opts.address);
  } catch {
    console.error(`Error: invalid address "${opts.address}".`);
    process.exit(1);
  }

  return opts;
}

async function main() {
  const opts = parseArgs();

  const mnemonic = process.env.MN;
  if (!mnemonic) {
    console.error("Error: MN env var (25-word mnemonic) is required.");
    process.exit(1);
  }

  const account = algosdk.mnemonicToSecretKey(mnemonic);
  const sender =
    typeof account.addr === "string"
      ? account.addr
      : algosdk.encodeAddress(account.addr.publicKey);

  console.error(`Chain:     ${opts.chain}`);
  console.error(`Sender:    ${sender}`);
  console.error(`Recipient: ${opts.address}`);
  console.error(`Mode:      ${opts.submit ? "SUBMIT" : "DRY-RUN"}`);
  console.error(`Note:      ${NOTIFICATION_MESSAGE.slice(0, 72)}...`);
  console.error("");

  const algod = getAlgodClient(opts.chain);
  const params = await algod.getTransactionParams().do();

  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender,
    receiver: opts.address,
    amount: 0,
    note: new TextEncoder().encode(NOTIFICATION_MESSAGE),
    suggestedParams: params,
  });

  if (!opts.submit) {
    console.error("[dry-run] Transaction built successfully (not submitted).");
    console.log(
      JSON.stringify(
        {
          type: "pay",
          sender,
          receiver: opts.address,
          amount: 0,
          noteLength: NOTIFICATION_MESSAGE.length,
          firstValid: Number(txn.firstValid),
          lastValid: Number(txn.lastValid),
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  const signed = txn.signTxn(account.sk);
  const { txId } = await algod
    .sendRawTransaction(new Uint8Array(signed))
    .do();

  console.error("Waiting for confirmation...");
  await algosdk.waitForConfirmation(algod, txId, 4);

  console.error(`[ok] Notification sent to ${opts.address}`);
  console.log(JSON.stringify({ txId, receiver: opts.address }, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(2);
});
