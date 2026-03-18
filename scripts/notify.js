#!/usr/bin/env node

/**
 * DorkFi user notifications via 0-amount native pay + note.
 *
 *   --mode send-one   One address (urgent liquidation-risk note)
 *   --mode broadcast Every DorkFi user on chain (general reminder note)
 *   --mode plan       Print notify send-one commands for at-risk users (no send)
 *
 * Usage:
 *   node scripts/notify.js --mode send-one --chain voi --address <ADDR> [--submit]
 *   node scripts/notify.js --mode broadcast --chain voi [--submit] [--concurrency N] [--delay ms] [--max N]
 *   node scripts/notify.js --mode plan --chain voi [--risk levels] [--threshold HF] [--json] [--output file]
 *
 * Environment: MN (25-word) required for send-one and broadcast (including dry-run for realistic sender).
 */

import "dotenv/config";
import fs from "node:fs";
import algosdk from "algosdk";
import { getAlgodClient } from "../lib/client.js";
import { getAllUsers } from "../lib/positions.js";
import { runBatches } from "../lib/script-utils.js";

const MSG_URGENT =
  "DorkFi Urgent Notification: Your account has been identified as having " +
  "high liquidation risk. Please repay part of your loan or add additional " +
  "collateral immediately to improve your position health and reduce the " +
  "risk of liquidation.";

const MSG_BROADCAST =
  "DorkFi Notification: Review your positions over the next 3 to 4 days. " +
  "Consider reducing borrows, depositing additional collateral, or repaying " +
  "loans to maintain healthy collateralization and reduce liquidation risk. " +
  "Responsible position management helps keep markets stable.";

const RISK_LEVELS = ["liquidatable", "critical", "high", "moderate"];

function printHelp() {
  console.log(`Usage: node scripts/notify.js --mode <send-one|broadcast|plan> --chain <voi|algorand> [options]

--mode send-one
  --address <addr>     Recipient (required)
  --submit             Broadcast tx (default dry-run; still needs MN for build)

--mode broadcast
  --submit             Send to all users (default dry-run)
  --concurrency <N>    default 3
  --delay <ms>         Between batches, default 500
  --max <N>            Cap recipients (safety; excludes sender first)
  --output <file>      JSON results

--mode plan
  No MN required. Print commands for at-risk users.
  --risk <a,b,c>       default: liquidatable,critical,high,moderate
  --threshold <HF>     Max health factor (overrides --risk)
  --submit             Generated lines include --submit
  --exclude <addrs>    Comma-separated
  --json               JSON report
  --output <file>

Legacy npm: send:liquidation-warning (= send-one), broadcast:notification, generate:notification-commands (= plan)

Environment: MN required for send-one and broadcast`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const o = {
    mode: null,
    chain: null,
    address: null,
    submit: false,
    concurrency: 3,
    delay: 500,
    max: null,
    output: null,
    riskLevels: [...RISK_LEVELS],
    threshold: null,
    json: false,
    exclude: new Set(),
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
    if (a === "--mode" && args[i + 1]) o.mode = args[++i];
    else if (a === "--chain" && args[i + 1]) o.chain = args[++i];
    else if (a === "--address" && args[i + 1]) o.address = args[++i];
    else if (a === "--submit") o.submit = true;
    else if (a === "--dry-run") o.submit = false;
    else if (a === "--concurrency" && args[i + 1]) o.concurrency = parseInt(args[++i], 10);
    else if (a === "--delay" && args[i + 1]) o.delay = parseInt(args[++i], 10);
    else if (a === "--max" && args[i + 1]) o.max = parseInt(args[++i], 10);
    else if (a === "--output" && args[i + 1]) o.output = args[++i];
    else if (a === "--risk" && args[i + 1])
      o.riskLevels = args[++i].split(",").map((s) => s.trim().toLowerCase());
    else if (a === "--threshold" && args[i + 1]) o.threshold = parseFloat(args[++i]);
    else if (a === "--json") o.json = true;
    else if (a === "--exclude" && args[i + 1])
      for (const x of args[++i].split(",")) o.exclude.add(x.trim());
  }
  if (!o.mode || !["send-one", "broadcast", "plan"].includes(o.mode)) {
    console.error("Error: --mode send-one | broadcast | plan");
    printHelp();
    process.exit(1);
  }
  if (!o.chain || !["voi", "algorand"].includes(o.chain)) {
    console.error("Error: --chain voi | algorand");
    process.exit(1);
  }
  return o;
}

function requireMnemonic() {
  const m = process.env.MN;
  if (!m) {
    console.error("MN env var required.");
    process.exit(1);
  }
  return algosdk.mnemonicToSecretKey(m);
}

async function sendOne(opts) {
  if (!opts.address) {
    console.error("--address required for send-one");
    process.exit(1);
  }
  try {
    algosdk.decodeAddress(opts.address);
  } catch {
    console.error("Invalid --address");
    process.exit(1);
  }
  const account = requireMnemonic();
  const sk = account.sk;
  const sender =
    typeof account.addr === "string"
      ? account.addr
      : algosdk.encodeAddress(account.addr.publicKey);

  console.error(`Mode: send-one | ${opts.chain}`);
  console.error(`Sender: ${sender} | Recipient: ${opts.address}`);
  console.error(`${opts.submit ? "SUBMIT" : "DRY-RUN"}\n`);

  const algod = getAlgodClient(opts.chain);
  const params = await algod.getTransactionParams().do();
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender,
    receiver: opts.address,
    amount: 0,
    note: new TextEncoder().encode(MSG_URGENT),
    suggestedParams: params,
  });

  if (!opts.submit) {
    console.error("[dry-run] Built (not submitted).");
    console.log(
      JSON.stringify(
        {
          mode: "send-one",
          sender,
          receiver: opts.address,
          noteChars: MSG_URGENT.length,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }
  const signed = txn.signTxn(sk);
  const { txId } = await algod.sendRawTransaction(new Uint8Array(signed)).do();
  await algosdk.waitForConfirmation(algod, txId, 4);
  console.error(`[ok] txId ${txId}`);
  console.log(JSON.stringify({ txId, receiver: opts.address }, null, 2));
  process.exit(0);
}

async function broadcast(opts) {
  const account = requireMnemonic();
  const sk = account.sk;
  const sender =
    typeof account.addr === "string"
      ? account.addr
      : algosdk.encodeAddress(account.addr.publicKey);

  console.error(`Mode: broadcast | ${opts.chain}`);
  console.error(`Sender: ${sender} | ${opts.submit ? "SUBMIT" : "DRY-RUN"}\n`);

  const { users } = await getAllUsers(opts.chain);
  let recipients = [...new Set(users.map((u) => u.address))].filter((a) => a !== sender);
  if (opts.max != null && opts.max > 0) recipients = recipients.slice(0, opts.max);

  console.error(`Recipients: ${recipients.length}\n`);
  if (recipients.length === 0) process.exit(0);

  const algod = getAlgodClient(opts.chain);
  const results = { success: [], failed: [] };

  const tasks = recipients.map((address) => async () => {
    const short = `${address.slice(0, 8)}…${address.slice(-4)}`;
    try {
      const params = await algod.getTransactionParams().do();
      const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender,
        receiver: address,
        amount: 0,
        note: new TextEncoder().encode(MSG_BROADCAST),
        suggestedParams: params,
      });
      if (!opts.submit) {
        console.log(`  [dry-run] ${short}`);
        results.success.push({ address, status: "dry-run" });
        return;
      }
      const signed = txn.signTxn(sk);
      const { txId } = await algod.sendRawTransaction(new Uint8Array(signed)).do();
      await algosdk.waitForConfirmation(algod, txId, 4);
      console.log(`  [ok] ${short} ${txId}`);
      results.success.push({ address, txId });
    } catch (e) {
      console.error(`  [fail] ${short} ${e.message}`);
      results.failed.push({ address, error: e.message });
    }
  });

  await runBatches(tasks, opts.concurrency, opts.delay);

  console.error(`\nDone: ok ${results.success.length} fail ${results.failed.length}`);
  if (opts.output) {
    fs.writeFileSync(
      opts.output,
      JSON.stringify(
        {
          mode: "broadcast",
          chain: opts.chain,
          submit: opts.submit,
          ...results,
        },
        null,
        2,
      ) + "\n",
    );
  }
  process.exit(results.failed.length ? 1 : 0);
}

function planMatch(u, o) {
  if (u.healthFactor === null) return false;
  if (o.exclude.has(u.address)) return false;
  if (o.threshold != null) return u.healthFactor <= o.threshold;
  return o.riskLevels.includes(u.riskLevel);
}

async function plan(opts) {
  const { users } = await getAllUsers(opts.chain);
  const atRisk = users.filter((u) => planMatch(u, opts));
  console.error(`At-risk: ${atRisk.length} / ${users.length}\n`);
  if (atRisk.length === 0) process.exit(0);

  const submitFlag = opts.submit ? " --submit" : "";
  const cmd = (addr) =>
    `node scripts/notify.js --mode send-one --chain ${opts.chain} --address ${addr}${submitFlag}`;

  if (opts.json) {
    const report = {
      timestamp: new Date().toISOString(),
      chain: opts.chain,
      accounts: atRisk.map((u) => ({
        address: u.address,
        healthFactor: u.healthFactor,
        riskLevel: u.riskLevel,
        command: cmd(u.address),
      })),
    };
    const out = JSON.stringify(report, null, 2);
    if (opts.output) fs.writeFileSync(opts.output, out + "\n");
    else console.log(out);
    process.exit(0);
  }

  const grouped = {
    liquidatable: atRisk.filter((u) => u.riskLevel === "liquidatable"),
    critical: atRisk.filter((u) => u.riskLevel === "critical"),
    high: atRisk.filter((u) => u.riskLevel === "high"),
    moderate: atRisk.filter((u) => u.riskLevel === "moderate"),
  };
  const lines = [
    "#!/usr/bin/env bash",
    `# notify plan — ${opts.chain} — ${new Date().toISOString()}`,
    "",
  ];
  for (const [level, label] of [
    ["liquidatable", "LIQUIDATABLE"],
    ["critical", "CRITICAL"],
    ["high", "HIGH"],
    ["moderate", "MODERATE"],
  ]) {
    const acc = grouped[level];
    if (!acc.length) continue;
    lines.push(`# ── ${label} (${acc.length}) ──`);
    for (const u of acc) {
      lines.push(`# HF ${u.healthFactor?.toFixed(4)}`);
      lines.push(cmd(u.address));
      lines.push("");
    }
  }
  const out = lines.join("\n");
  if (opts.output) fs.writeFileSync(opts.output, out + "\n");
  else console.log(out);
  process.exit(0);
}

async function main() {
  const opts = parseArgs();
  if (opts.mode === "send-one") await sendOne(opts);
  else if (opts.mode === "broadcast") await broadcast(opts);
  else await plan(opts);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
