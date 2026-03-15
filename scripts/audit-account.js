#!/usr/bin/env node

/**
 * Audit a single account across all DorkFi lending markets.
 *
 * Fetches the user's on-chain position in every market on the specified
 * chain(s), compares their lastPrice against the current oracle price,
 * and reports stale positions.  With --submit, builds, signs, and submits
 * sync_user_market_for_price_change transactions for every stale market.
 *
 * Usage:
 *   node scripts/audit-account.js <address> [options]
 *
 * Options:
 *   --chain <voi|algorand>   Scan a single chain (default: both)
 *   --submit                 Sign and submit sync transactions
 *   --dry-run                Build txns but don't submit (default)
 *   --json                   Output raw JSON
 *   --concurrency <N>        Max parallel operations (default: 4)
 *   --output, -o <path>      Write output to file
 *
 * Environment:
 *   MN   25-word Algorand mnemonic for signing (required for --submit)
 */

import "dotenv/config";
import fs from "node:fs";
import algosdk from "algosdk";
import {
  getMarketConfigs,
  simulateABICall,
  decodeMarketResult,
  decodeUserResult,
  ABI_METHODS,
  getAlgodClient,
} from "../lib/client.js";
import { prepareSyncUserMarket } from "../lib/builders.js";

const PRICE_SCALE = 1e18;
const CHAINS = ["voi", "algorand"];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    address: null,
    chains: CHAINS,
    submit: false,
    json: false,
    concurrency: 4,
    output: null,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--chain" && args[i + 1]) {
      opts.chains = [args[++i]];
    } else if (args[i] === "--submit") {
      opts.submit = true;
    } else if (args[i] === "--dry-run") {
      opts.submit = false;
    } else if (args[i] === "--json") {
      opts.json = true;
    } else if (args[i] === "--concurrency" && args[i + 1]) {
      opts.concurrency = parseInt(args[++i], 10);
    } else if ((args[i] === "--output" || args[i] === "-o") && args[i + 1]) {
      opts.output = args[++i];
    } else if (args[i] === "--help") {
      console.log(`Usage: node scripts/audit-account.js <address> [options]

  <address>                Algorand/Voi wallet address to audit
  --chain <voi|algorand>   Scan a single chain (default: both)
  --submit                 Sign and submit sync transactions
  --dry-run                Build txns but don't submit (default)
  --json                   Output raw JSON
  --concurrency <N>        Max parallel operations (default: 4)
  --output, -o <path>      Write output to file

Environment:
  MN   25-word Algorand mnemonic for signing (required for --submit)`);
      process.exit(0);
    } else if (!args[i].startsWith("--")) {
      opts.address = args[i];
    }
  }

  if (!opts.address) {
    console.error("Error: Please provide an account address to audit.");
    console.error("Run with --help for usage.");
    process.exit(1);
  }

  return opts;
}

async function fetchMarketPrices(chain) {
  const configs = getMarketConfigs(chain);
  const poolMarkets = new Map();
  for (const c of configs) {
    if (!poolMarkets.has(c.poolId)) poolMarkets.set(c.poolId, []);
    poolMarkets.get(c.poolId).push(c);
  }

  const prices = new Map();
  for (const [poolId, markets] of poolMarkets) {
    for (const m of markets) {
      try {
        const mr = await simulateABICall(
          chain, poolId, ABI_METHODS.get_market, [m.contractId],
        );
        const d = decodeMarketResult(mr.returnValue);
        prices.set(m.symbol, {
          price: Number(d.price),
          priceHuman: Number(d.price) / PRICE_SCALE,
          poolId,
          contractId: m.contractId,
          decimals: m.decimals,
          totalScaledDeposits: Number(d.totalScaledDeposits) / 10 ** m.decimals,
          totalScaledBorrows: Number(d.totalScaledBorrows) / 10 ** m.decimals,
        });
      } catch (err) {
        console.error(`  [warn] Failed to fetch market ${m.symbol} on ${chain}: ${err.message}`);
      }
    }
  }
  return prices;
}

async function fetchUserMarket(chain, poolId, contractId, address, decimals) {
  try {
    const mr = await simulateABICall(
      chain, poolId, ABI_METHODS.get_user, [address, contractId],
    );
    const d = decodeUserResult(mr.returnValue);
    return {
      scaledDeposits: Number(d.scaledDeposits) / 10 ** decimals,
      scaledBorrows: Number(d.scaledBorrows) / 10 ** decimals,
      lastPrice: Number(d.lastPrice),
      lastPriceHuman: Number(d.lastPrice) / PRICE_SCALE,
      lastUpdateTime: Number(d.lastUpdateTime),
      depositIndex: d.depositIndex.toString(),
      borrowIndex: d.borrowIndex.toString(),
    };
  } catch (err) {
    console.error(`  [warn] Failed to fetch user market ${contractId} on ${chain}: ${err.message}`);
    return null;
  }
}

function classifyPriority(pctChange, hasBorrows) {
  const abs = Math.abs(pctChange);
  if (abs >= 10) return "critical";
  if (abs >= 3 || hasBorrows) return "high";
  return "low";
}

function formatTimestamp(epoch) {
  if (!epoch) return "n/a";
  const d = new Date(epoch * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

async function auditChain(chain, address) {
  const label = chain === "voi" ? "voi-mainnet" : "algorand-mainnet";
  console.error(`\n[${label}] Fetching market prices...`);
  const marketPrices = await fetchMarketPrices(chain);
  const symbols = [...marketPrices.keys()];
  console.error(`[${label}] Markets: ${symbols.join(", ")}`);

  console.error(`[${label}] Querying user positions...`);
  const positions = [];

  for (const symbol of symbols) {
    const mp = marketPrices.get(symbol);
    const ud = await fetchUserMarket(chain, mp.poolId, mp.contractId, address, mp.decimals);

    if (!ud) continue;

    const hasPosition = ud.scaledDeposits > 0 || ud.scaledBorrows > 0;
    const isStale = hasPosition && ud.lastPrice !== mp.price;

    let pctChange = 0;
    if (isStale && ud.lastPrice !== 0) {
      pctChange = ((mp.price - ud.lastPrice) / ud.lastPrice) * 100;
    } else if (isStale && mp.price !== 0) {
      pctChange = 100;
    }

    positions.push({
      network: label,
      symbol,
      poolId: mp.poolId,
      contractId: mp.contractId,
      scaledDeposits: ud.scaledDeposits,
      scaledBorrows: ud.scaledBorrows,
      userLastPrice: ud.lastPriceHuman,
      currentMarketPrice: mp.priceHuman,
      lastUpdateTime: ud.lastUpdateTime,
      hasPosition,
      isStale,
      priceChangePercent: Number(pctChange.toFixed(4)),
      priority: isStale ? classifyPriority(pctChange, ud.scaledBorrows > 0) : null,
    });
  }

  return positions;
}

function signTxnGroup(txnsB64, sk) {
  return txnsB64.map((b64) => {
    const bytes = Buffer.from(b64, "base64");
    const txn = algosdk.decodeUnsignedTransaction(bytes);
    return txn.signTxn(sk);
  });
}

async function submitGroup(algod, signedTxns) {
  const combined = signedTxns.map((s) =>
    s instanceof Uint8Array ? s : new Uint8Array(s),
  );
  const { txId } = await algod.sendRawTransaction(combined).do();
  return txId;
}

async function syncStalePositions(positions, address, opts) {
  const stale = positions.filter((p) => p.isStale);
  if (stale.length === 0) return [];

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
  } else if (mnemonic) {
    sender = (() => {
      const { addr } = algosdk.mnemonicToSecretKey(mnemonic);
      return typeof addr === "string" ? addr : algosdk.encodeAddress(addr.publicKey);
    })();
  } else {
    sender = address;
  }

  console.error(`\nSender: ${sender}`);
  console.error(`Mode: ${opts.submit ? "SUBMIT" : "DRY-RUN"}`);

  const NETWORK_TO_CHAIN = { "voi-mainnet": "voi", "algorand-mainnet": "algorand" };
  const results = [];

  for (const pos of stale) {
    const chain = NETWORK_TO_CHAIN[pos.network];
    const label = `${pos.symbol} (${pos.network}, ${pos.priceChangePercent > 0 ? "+" : ""}${pos.priceChangePercent}%)`;

    try {
      const { transactions } = await prepareSyncUserMarket(chain, pos.symbol, address, sender);

      if (!opts.submit) {
        console.error(`  [dry-run] ${label} — ${transactions.length} txns built`);
        results.push({ ...pos, status: "dry-run", txnCount: transactions.length });
        continue;
      }

      const signed = signTxnGroup(transactions, sk);
      const algod = getAlgodClient(chain);
      const txId = await submitGroup(algod, signed);
      await algosdk.waitForConfirmation(algod, txId, 5);

      console.error(`  [ok] ${label} — txId: ${txId}`);
      results.push({ ...pos, status: "confirmed", txId });
    } catch (err) {
      console.error(`  [fail] ${label} — ${err.message}`);
      results.push({ ...pos, status: "failed", error: err.message });
    }
  }

  return results;
}

function buildReport(address, positions, syncResults) {
  const now = new Date().toISOString();
  const active = positions.filter((p) => p.hasPosition);
  const stale = positions.filter((p) => p.isStale);
  const inactive = positions.filter((p) => !p.hasPosition);

  const lines = [];
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("          DORKFI SINGLE ACCOUNT AUDIT");
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push(`  Address:    ${address}`);
  lines.push(`  Generated:  ${now}`);
  lines.push(`  Markets:    ${positions.length} queried, ${active.length} active, ${stale.length} stale`);
  lines.push("");

  if (active.length > 0) {
    lines.push("─── Active Positions ───────────────────────────────────────");
    for (const p of active) {
      const staleTag = p.isStale ? ` ** STALE ${p.priceChangePercent > 0 ? "↑" : "↓"} ${Math.abs(p.priceChangePercent).toFixed(2)}% [${p.priority.toUpperCase()}] **` : "";
      const borrowTag = p.scaledBorrows > 0 ? "  [BORROWER]" : "";
      lines.push(`  ${p.symbol.padEnd(8)} (${p.network})`);
      lines.push(`    deposits=${p.scaledDeposits.toFixed(2)}  borrows=${p.scaledBorrows.toFixed(2)}${borrowTag}`);
      lines.push(`    lastPrice=${p.userLastPrice.toFixed(6)}  marketPrice=${p.currentMarketPrice.toFixed(6)}${staleTag}`);
      lines.push(`    updated=${formatTimestamp(p.lastUpdateTime)}  pool=${p.poolId}  contract=${p.contractId}`);
      lines.push("");
    }
  }

  if (inactive.length > 0) {
    lines.push("─── No Position ────────────────────────────────────────────");
    lines.push(`  ${inactive.map((p) => `${p.symbol} (${p.network})`).join(", ")}`);
    lines.push("");
  }

  if (syncResults.length > 0) {
    lines.push("─── Sync Results ───────────────────────────────────────────");
    for (const r of syncResults) {
      const icon = r.status === "confirmed" ? "ok" : r.status === "dry-run" ? "dry-run" : "fail";
      const extra = r.txId ? ` txId=${r.txId}` : r.txnCount ? ` ${r.txnCount} txns` : "";
      const errMsg = r.error ? ` — ${r.error}` : "";
      lines.push(`  [${icon}] ${r.symbol} (${r.network})${extra}${errMsg}`);
    }
    lines.push("");
  }

  lines.push("═══════════════════════════════════════════════════════════════");
  return lines.join("\n");
}

async function main() {
  const opts = parseArgs();
  const allPositions = [];

  for (const chain of opts.chains) {
    try {
      const positions = await auditChain(chain, opts.address);
      allPositions.push(...positions);
    } catch (err) {
      console.error(`[error] Failed to audit ${chain}: ${err.message}`);
    }
  }

  const active = allPositions.filter((p) => p.hasPosition);
  const stale = allPositions.filter((p) => p.isStale);

  console.error(`\nTotal: ${allPositions.length} markets, ${active.length} active, ${stale.length} stale`);

  let syncResults = [];
  if (stale.length > 0 && (opts.submit || process.env.MN)) {
    syncResults = await syncStalePositions(allPositions, opts.address, opts);
  } else if (stale.length > 0) {
    console.error("Stale positions found. Use --submit (with MN env) to sync them.");
  }

  let output;
  if (opts.json) {
    output = JSON.stringify({
      generatedAt: new Date().toISOString(),
      address: opts.address,
      totalMarkets: allPositions.length,
      activePositions: active.length,
      stalePositions: stale.length,
      positions: allPositions,
      syncResults,
    }, null, 2);
  } else {
    output = buildReport(opts.address, allPositions, syncResults);
  }

  if (opts.output) {
    fs.writeFileSync(opts.output, output + "\n", "utf-8");
    console.error(`Report written to ${opts.output}`);
  } else {
    console.log(output);
  }

  process.exit(stale.length > 0 && syncResults.every((r) => r.status !== "confirmed") ? 1 : 0);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(2);
});
