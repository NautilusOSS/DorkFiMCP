#!/usr/bin/env node

/**
 * Full audit of DorkFi user-market staleness.
 *
 * For every user with an active position (scaledDeposits > 0 OR scaledBorrows > 0),
 * compares their on-chain lastPrice against the current market oracle price.
 * Produces a structured report of all stale positions grouped by network and priority.
 *
 * Usage:
 *   node scripts/audit-staleness.js [--chain voi|algorand] [--json] [--concurrency N] [--output path]
 */

import fs from "node:fs";
import {
  getMarketConfigs,
  simulateABICall,
  decodeMarketResult,
  decodeUserResult,
  ABI_METHODS,
} from "../lib/client.js";
import { getAllUsers } from "../lib/positions.js";

const PRICE_SCALE = 1e18;
const CHAINS = ["voi", "algorand"];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { chains: CHAINS, json: false, concurrency: 6, output: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--chain" && args[i + 1]) {
      opts.chains = [args[++i]];
    } else if (args[i] === "--json") {
      opts.json = true;
    } else if (args[i] === "--concurrency" && args[i + 1]) {
      opts.concurrency = parseInt(args[++i], 10);
    } else if ((args[i] === "--output" || args[i] === "-o") && args[i + 1]) {
      opts.output = args[++i];
    } else if (args[i] === "--help") {
      console.log(`Usage: node scripts/audit-staleness.js [options]
  --chain <voi|algorand>   Scan a single chain (default: both)
  --json                   Output raw JSON instead of formatted report
  --concurrency <N>        Max parallel on-chain queries (default: 6)
  --output, -o <path>      Write output to file instead of stdout`);
      process.exit(0);
    }
  }
  return opts;
}

function classifyPriority(pctChange, hasBorrows) {
  const abs = Math.abs(pctChange);
  if (abs >= 10) return "critical";
  if (abs >= 3 || hasBorrows) return "high";
  return "low";
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
    };
  } catch {
    return null;
  }
}

async function runBatch(tasks, concurrency) {
  const results = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map((fn) => fn()));
    results.push(...batchResults);
  }
  return results;
}

async function auditChain(chain, concurrency) {
  const label = chain === "voi" ? "voi-mainnet" : "algorand-mainnet";
  console.error(`\n[${label}] Fetching market prices...`);
  const marketPrices = await fetchMarketPrices(chain);
  const symbols = [...marketPrices.keys()];
  console.error(`[${label}] Markets: ${symbols.join(", ")}`);

  console.error(`[${label}] Fetching all users...`);
  const { users } = await getAllUsers(chain);
  console.error(`[${label}] Users: ${users.length}`);

  const addresses = users.map((u) => u.address);
  const candidates = [];
  let queriesRun = 0;
  let skipped = 0;

  const tasks = [];
  for (const address of addresses) {
    for (const symbol of symbols) {
      const mp = marketPrices.get(symbol);
      tasks.push(async () => {
        const ud = await fetchUserMarket(
          chain, mp.poolId, mp.contractId, address, mp.decimals,
        );
        return { address, symbol, mp, ud };
      });
    }
  }

  console.error(`[${label}] Querying ${tasks.length} user-market pairs (concurrency=${concurrency})...`);

  const results = await runBatch(tasks, concurrency);

  for (const { address, symbol, mp, ud } of results) {
    queriesRun++;
    if (!ud) { skipped++; continue; }
    if (ud.scaledDeposits === 0 && ud.scaledBorrows === 0) { skipped++; continue; }
    if (ud.lastPrice === mp.price) continue;

    const priceDelta = mp.price - ud.lastPrice;
    const pctChange = ud.lastPrice !== 0
      ? (priceDelta / ud.lastPrice) * 100
      : (mp.price !== 0 ? 100 : 0);

    candidates.push({
      network: label,
      address,
      symbol,
      poolId: mp.poolId,
      contractId: mp.contractId,
      userLastPrice: ud.lastPriceHuman,
      currentMarketPrice: mp.priceHuman,
      scaledDeposits: ud.scaledDeposits,
      scaledBorrows: ud.scaledBorrows,
      lastUpdateTime: ud.lastUpdateTime,
      priceDelta: priceDelta / PRICE_SCALE,
      priceChangePercent: Number(pctChange.toFixed(4)),
      priority: classifyPriority(pctChange, ud.scaledBorrows > 0),
      recommendedAction: "sync_user_market_for_price_change",
    });
  }

  console.error(`[${label}] Done. Queries: ${queriesRun}, Skipped: ${skipped}, Stale: ${candidates.length}`);
  return candidates;
}

function buildReport(allCandidates) {
  const now = new Date().toISOString();

  const byNetwork = {};
  for (const c of allCandidates) {
    if (!byNetwork[c.network]) byNetwork[c.network] = [];
    byNetwork[c.network].push(c);
  }

  const lines = [];
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("        DORKFI USER-MARKET STALENESS AUDIT REPORT");
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push(`  Generated: ${now}`);
  lines.push(`  Total stale positions: ${allCandidates.length}`);
  lines.push("");

  for (const [network, candidates] of Object.entries(byNetwork)) {
    candidates.sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent));

    const critical = candidates.filter((c) => c.priority === "critical");
    const high = candidates.filter((c) => c.priority === "high");
    const low = candidates.filter((c) => c.priority === "low");

    lines.push(`─── ${network} ───────────────────────────────────────────────`);
    lines.push(`  Stale positions: ${candidates.length}  (critical: ${critical.length}, high: ${high.length}, low: ${low.length})`);
    lines.push("");

    for (const tier of [
      { label: "CRITICAL", items: critical },
      { label: "HIGH", items: high },
      { label: "LOW", items: low },
    ]) {
      if (tier.items.length === 0) continue;
      lines.push(`  [${tier.label}]`);
      for (const c of tier.items) {
        const arrow = c.priceChangePercent >= 0 ? "↑" : "↓";
        const borrowTag = c.scaledBorrows > 0 ? " [BORROWER]" : "";
        lines.push(
          `    ${c.symbol.padEnd(8)} ${arrow} ${Math.abs(c.priceChangePercent).toFixed(2)}%` +
          `  last=${c.userLastPrice.toFixed(6)}  now=${c.currentMarketPrice.toFixed(6)}` +
          `  deposits=${c.scaledDeposits.toFixed(2)}  borrows=${c.scaledBorrows.toFixed(2)}` +
          `${borrowTag}`,
        );
        lines.push(`             addr=${c.address}`);
        lines.push(`             pool=${c.poolId}  contract=${c.contractId}`);
      }
      lines.push("");
    }
  }

  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("  recommendedAction: sync_user_market_for_price_change");
  lines.push("═══════════════════════════════════════════════════════════════");

  return lines.join("\n");
}

async function main() {
  const opts = parseArgs();
  const allCandidates = [];

  for (const chain of opts.chains) {
    try {
      const candidates = await auditChain(chain, opts.concurrency);
      allCandidates.push(...candidates);
    } catch (err) {
      console.error(`[error] Failed to audit ${chain}: ${err.message}`);
    }
  }

  let output;
  if (opts.json) {
    const addressesByPriority = { critical: [], high: [], low: [] };
    for (const tier of ["critical", "high", "low"]) {
      const addrs = new Set(
        allCandidates.filter((c) => c.priority === tier).map((c) => c.address),
      );
      addressesByPriority[tier] = [...addrs].sort();
    }

    const borrowerAddresses = new Set(
      allCandidates.filter((c) => c.scaledBorrows > 0).map((c) => c.address),
    );
    const depositOnlyByPriority = { critical: [], high: [], low: [] };
    for (const tier of ["critical", "high", "low"]) {
      const addrs = new Set(
        allCandidates
          .filter((c) => c.priority === tier && c.scaledDeposits > 0 && !borrowerAddresses.has(c.address))
          .map((c) => c.address),
      );
      depositOnlyByPriority[tier] = [...addrs].sort();
    }

    output = JSON.stringify({
      generatedAt: new Date().toISOString(),
      totalStalePositions: allCandidates.length,
      addressesByPriority,
      depositOnlyByPriority,
      candidates: allCandidates,
    }, null, 2);
  } else {
    output = buildReport(allCandidates);
  }

  if (opts.output) {
    fs.writeFileSync(opts.output, output + "\n", "utf-8");
    console.error(`Report written to ${opts.output}`);
  } else {
    console.log(output);
  }

  process.exit(allCandidates.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(2);
});
