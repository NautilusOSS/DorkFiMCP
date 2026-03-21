#!/usr/bin/env node
/**
 * DorkFi audits — one CLI, three modes:
 *   --mode account <addr|name.voi>   Single-wallet stale check (+ optional --submit sync)
 *   --mode staleness                 Full network stale scan (--json → artifact for sync-position)
 *   --mode summary <audit.json>     Human summary of staleness JSON (from staleness --json)
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
import { getAllUsers } from "../lib/positions.js";
import { loadAudit, buildSummary, formatSummaryText } from "../lib/auditSummary.js";

const PRICE_SCALE = 1e18;
const CHAINS = ["voi", "algorand"];
const ENVOI_RESOLVER_APP = 797609;
const VOI_ALGOD = "https://mainnet-api.voi.nodely.dev";

function help() {
  console.log(`Usage:
  node scripts/audit.js --mode account <address|name.voi> [--chain voi|algorand] [--submit] [--json] [-o file]
  node scripts/audit.js --mode staleness [--chain voi|algorand] [--json] [--concurrency N] [-o file]
  node scripts/audit.js --mode summary <audit.json> [--top N] [--json]

Aliases: npm run audit:account | audit:staleness | audit:summary`);
}

function parseRoot() {
  const args = process.argv.slice(2);
  let mode = null;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") {
      help();
      process.exit(0);
    }
    if (args[i] === "--mode" && args[i + 1]) {
      mode = args[++i];
      continue;
    }
    rest.push(args[i]);
  }
  if (!mode || !["account", "staleness", "summary"].includes(mode)) {
    console.error("Required: --mode account | staleness | summary");
    help();
    process.exit(1);
  }
  return { mode, rest };
}

function classifyPriority(pctChange, hasBorrows) {
  const abs = Math.abs(pctChange);
  if (abs >= 10) return "critical";
  if (abs >= 3 || hasBorrows) return "high";
  return "low";
}

// ─── mode: account ─────────────────────────────────────────────

async function resolveEnvoiName(name) {
  const label = name.replace(/\.voi$/i, "");
  const b64 = Buffer.from(new TextEncoder().encode(label)).toString("base64");
  const resp = await fetch(
    `${VOI_ALGOD}/v2/applications/${ENVOI_RESOLVER_APP}/box?name=b64:${b64}`,
    { headers: { "X-Algo-API-Token": "" } },
  );
  if (!resp.ok) throw new Error(`Resolve "${name}" — ${resp.status}`);
  const { value } = await resp.json();
  return algosdk.encodeAddress(Buffer.from(value, "base64").subarray(0, 32));
}

function parseAccountArgs(rest) {
  const o = { target: null, chains: [...CHAINS], submit: false, json: false, concurrency: 4, output: null };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--chain" && rest[i + 1]) o.chains = [rest[++i]];
    else if (rest[i] === "--submit") o.submit = true;
    else if (rest[i] === "--dry-run") o.submit = false;
    else if (rest[i] === "--json") o.json = true;
    else if (rest[i] === "--concurrency" && rest[i + 1]) o.concurrency = parseInt(rest[++i], 10);
    else if ((rest[i] === "--output" || rest[i] === "-o") && rest[i + 1]) o.output = rest[++i];
    else if (!rest[i].startsWith("--")) o.target = rest[i];
  }
  if (!o.target) {
    console.error("account mode: need <address|name.voi>");
    process.exit(1);
  }
  return o;
}

async function accFetchMarketPrices(chain) {
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
        const mr = await simulateABICall(chain, poolId, ABI_METHODS.get_market, [m.contractId]);
        const d = decodeMarketResult(mr.returnValue);
        prices.set(m.symbol, {
          price: Number(d.price),
          priceHuman: Number(d.price) / PRICE_SCALE,
          poolId,
          contractId: m.contractId,
          decimals: m.decimals,
        });
      } catch (e) {
        console.error(`  [warn] market ${m.symbol} ${chain}: ${e.message}`);
      }
    }
  }
  return prices;
}

async function accFetchUser(chain, poolId, contractId, address, decimals) {
  try {
    const mr = await simulateABICall(chain, poolId, ABI_METHODS.get_user, [address, contractId]);
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

async function accAuditChain(chain, address) {
  const label = chain === "voi" ? "voi-mainnet" : "algorand-mainnet";
  console.error(`\n[${label}] markets...`);
  const marketPrices = await accFetchMarketPrices(chain);
  const symbols = [...marketPrices.keys()];
  console.error(`[${label}] ${symbols.join(", ")}`);
  const positions = [];
  for (const symbol of symbols) {
    const mp = marketPrices.get(symbol);
    const ud = await accFetchUser(chain, mp.poolId, mp.contractId, address, mp.decimals);
    if (!ud) continue;
    const hasPosition = ud.scaledDeposits > 0 || ud.scaledBorrows > 0;
    const isStale = hasPosition && ud.lastPrice !== mp.price;
    let pctChange = 0;
    if (isStale && ud.lastPrice !== 0) pctChange = ((mp.price - ud.lastPrice) / ud.lastPrice) * 100;
    else if (isStale && mp.price !== 0) pctChange = 100;
    positions.push({
      network: label, symbol, poolId: mp.poolId, contractId: mp.contractId,
      scaledDeposits: ud.scaledDeposits, scaledBorrows: ud.scaledBorrows,
      userLastPrice: ud.lastPriceHuman, currentMarketPrice: mp.priceHuman,
      lastUpdateTime: ud.lastUpdateTime, hasPosition, isStale,
      priceChangePercent: Number(pctChange.toFixed(4)),
      priority: isStale ? classifyPriority(pctChange, ud.scaledBorrows > 0) : null,
    });
  }
  return positions;
}

function accSignGroup(txnsB64, sk) {
  return txnsB64.map((b64) => algosdk.decodeUnsignedTransaction(Buffer.from(b64, "base64")).signTxn(sk));
}

async function accSyncStale(positions, address, submit) {
  const stale = positions.filter((p) => p.isStale);
  if (!stale.length) return [];
  const mnemonic = process.env.MN;
  let sender, sk;
  if (submit) {
    if (!mnemonic) {
      console.error("MN required for --submit");
      process.exit(1);
    }
    const a = algosdk.mnemonicToSecretKey(mnemonic);
    sk = a.sk;
    sender = typeof a.addr === "string" ? a.addr : algosdk.encodeAddress(a.addr.publicKey);
  } else if (mnemonic) {
    const a = algosdk.mnemonicToSecretKey(mnemonic);
    sender = typeof a.addr === "string" ? a.addr : algosdk.encodeAddress(a.addr.publicKey);
  } else sender = address;
  console.error(`Sender ${sender} | ${submit ? "SUBMIT" : "DRY-RUN"}`);
  const NET = { "voi-mainnet": "voi", "algorand-mainnet": "algorand" };
  const results = [];
  for (const pos of stale) {
    const chain = NET[pos.network];
    const label = `${pos.symbol} (${pos.network})`;
    try {
      const { transactions } = await prepareSyncUserMarket(chain, pos.poolId, pos.contractId, address, sender);
      if (!submit) {
        console.error(`  [dry-run] ${label} — ${transactions.length} txns`);
        results.push({ ...pos, status: "dry-run", txnCount: transactions.length });
        continue;
      }
      const algod = getAlgodClient(chain);
      const signed = accSignGroup(transactions, sk).map((s) => new Uint8Array(s));
      const resp = await algod.sendRawTransaction(signed).do();
      const txId = resp.txid ?? resp.txId;
      await algosdk.waitForConfirmation(algod, txId, 5);
      console.error(`  [ok] ${label} ${txId}`);
      results.push({ ...pos, status: "confirmed", txId });
    } catch (e) {
      console.error(`  [fail] ${label} ${e.message}`);
      results.push({ ...pos, status: "failed", error: e.message });
    }
  }
  return results;
}

function accFormatReport(address, positions, syncResults, resolvedFrom) {
  const active = positions.filter((p) => p.hasPosition);
  const stale = positions.filter((p) => p.isStale);
  const inactive = positions.filter((p) => !p.hasPosition);
  const lines = [
    "═══════════════════════════════════════════════════════════════",
    "          DORKFI SINGLE ACCOUNT AUDIT",
    "═══════════════════════════════════════════════════════════════",
    `  Address: ${address}${resolvedFrom ? ` (enVoi: ${resolvedFrom})` : ""}`,
    `  ${new Date().toISOString()} | ${positions.length} markets, ${active.length} active, ${stale.length} stale`,
    "",
  ];
  const fmt = (e) => (e ? new Date(e * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "n/a");
  for (const p of active) {
    const tag = p.isStale ? ` STALE ${p.priceChangePercent}% [${p.priority}]` : "";
    lines.push(`  ${p.symbol} (${p.network}) dep=${p.scaledDeposits.toFixed(2)} bor=${p.scaledBorrows.toFixed(2)}${tag}`);
    lines.push(`    last=${p.userLastPrice.toFixed(6)} mkt=${p.currentMarketPrice.toFixed(6)} upd=${fmt(p.lastUpdateTime)}`);
    lines.push("");
  }
  if (inactive.length) lines.push(`  No position: ${inactive.map((p) => p.symbol).join(", ")}\n`);
  for (const r of syncResults) {
    lines.push(`  sync [${r.status}] ${r.symbol} ${r.txId || r.txnCount || ""}`);
  }
  lines.push("═══════════════════════════════════════════════════════════════");
  return lines.join("\n");
}

async function runAccount(rest) {
  const o = parseAccountArgs(rest);
  let resolvedFrom = null;
  let address = o.target.trim();
  if (!algosdk.isValidAddress(address)) {
    const name = address.toLowerCase().endsWith(".voi") ? address : `${address}.voi`;
    console.error(`Resolving ${name}...`);
    address = await resolveEnvoiName(name);
    console.error(`→ ${address}\n`);
    resolvedFrom = name;
  }
  const all = [];
  for (const chain of o.chains) {
    try {
      all.push(...(await accAuditChain(chain, address)));
    } catch (e) {
      console.error(`[error] ${chain} ${e.message}`);
    }
  }
  const stale = all.filter((p) => p.isStale);
  console.error(`\nStale: ${stale.length}`);
  let syncResults = [];
  if (stale.length && (o.submit || process.env.MN)) syncResults = await accSyncStale(all, address, o.submit);
  else if (stale.length) console.error("Use --submit + MN to sync.");
  let out;
  if (o.json) {
    out = JSON.stringify({
      generatedAt: new Date().toISOString(), address, resolvedFromEnVoi: resolvedFrom || undefined,
      stalePositions: stale.length, positions: all, syncResults,
    }, null, 2);
  } else out = accFormatReport(address, all, syncResults, resolvedFrom);
  if (o.output) fs.writeFileSync(o.output, out + "\n");
  else console.log(out);
  const fail = o.submit && stale.length && syncResults.length && syncResults.every((r) => r.status !== "confirmed");
  process.exit(fail ? 1 : 0);
}

// ─── mode: staleness ───────────────────────────────────────────

function parseStalenessArgs(rest) {
  const o = { chains: [...CHAINS], json: false, concurrency: 6, output: null };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--chain" && rest[i + 1]) o.chains = [rest[++i]];
    else if (rest[i] === "--json") o.json = true;
    else if (rest[i] === "--concurrency" && rest[i + 1]) o.concurrency = parseInt(rest[++i], 10);
    else if ((rest[i] === "--output" || rest[i] === "-o") && rest[i + 1]) o.output = rest[++i];
  }
  return o;
}

async function stFetchMarketPrices(chain) {
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
        const mr = await simulateABICall(chain, poolId, ABI_METHODS.get_market, [m.contractId]);
        const d = decodeMarketResult(mr.returnValue);
        prices.set(m.symbol, { price: Number(d.price), priceHuman: Number(d.price) / PRICE_SCALE, poolId, contractId: m.contractId, decimals: m.decimals });
      } catch {}
    }
  }
  return prices;
}

async function stFetchUser(chain, poolId, contractId, address, decimals) {
  try {
    const mr = await simulateABICall(chain, poolId, ABI_METHODS.get_user, [address, contractId]);
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

async function stRunBatch(tasks, n) {
  const out = [];
  for (let i = 0; i < tasks.length; i += n) {
    out.push(...(await Promise.all(tasks.slice(i, i + n).map((fn) => fn()))));
  }
  return out;
}

async function stAuditChain(chain, concurrency) {
  const label = chain === "voi" ? "voi-mainnet" : "algorand-mainnet";
  console.error(`\n[${label}] …`);
  const marketPrices = await stFetchMarketPrices(chain);
  const symbols = [...marketPrices.keys()];
  const { users } = await getAllUsers(chain);
  const tasks = [];
  for (const address of users.map((u) => u.address)) {
    for (const symbol of symbols) {
      const mp = marketPrices.get(symbol);
      tasks.push(async () => {
        const ud = await stFetchUser(chain, mp.poolId, mp.contractId, address, mp.decimals);
        return { address, symbol, mp, ud };
      });
    }
  }
  console.error(`[${label}] ${tasks.length} pairs, concurrency ${concurrency}`);
  const results = await stRunBatch(tasks, concurrency);
  const candidates = [];
  for (const { address, symbol, mp, ud } of results) {
    if (!ud || (ud.scaledDeposits === 0 && ud.scaledBorrows === 0) || ud.lastPrice === mp.price) continue;
    const priceDelta = mp.price - ud.lastPrice;
    const pctChange = ud.lastPrice !== 0 ? (priceDelta / ud.lastPrice) * 100 : mp.price !== 0 ? 100 : 0;
    candidates.push({
      network: label, address, symbol, poolId: mp.poolId, contractId: mp.contractId,
      userLastPrice: ud.lastPriceHuman, currentMarketPrice: mp.priceHuman,
      scaledDeposits: ud.scaledDeposits, scaledBorrows: ud.scaledBorrows,
      lastUpdateTime: ud.lastUpdateTime, priceDelta: priceDelta / PRICE_SCALE,
      priceChangePercent: Number(pctChange.toFixed(4)),
      priority: classifyPriority(pctChange, ud.scaledBorrows > 0),
      recommendedAction: "sync_user_market_for_price_change",
    });
  }
  console.error(`[${label}] stale ${candidates.length}`);
  return candidates;
}

function stBuildReport(all) {
  const byNet = {};
  for (const c of all) {
    if (!byNet[c.network]) byNet[c.network] = [];
    byNet[c.network].push(c);
  }
  const lines = ["══ DORKFI STALENESS ══", ` ${all.length} stale`, ""];
  for (const [net, arr] of Object.entries(byNet)) {
    arr.sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent));
    lines.push(`── ${net} (${arr.length}) ──`);
    for (const c of arr.slice(0, 50)) {
      lines.push(`  ${c.symbol} ${c.priceChangePercent}% ${c.address.slice(0, 8)}… pool=${c.poolId}`);
    }
    if (arr.length > 50) lines.push(`  … +${arr.length - 50} more`);
    lines.push("");
  }
  return lines.join("\n");
}

async function runStaleness(rest) {
  const o = parseStalenessArgs(rest);
  const all = [];
  for (const chain of o.chains) {
    try {
      all.push(...(await stAuditChain(chain, o.concurrency)));
    } catch (e) {
      console.error(e);
    }
  }
  let out;
  if (o.json) {
    const addressesByPriority = { critical: [], high: [], low: [] };
    for (const tier of ["critical", "high", "low"]) {
      addressesByPriority[tier] = [...new Set(all.filter((c) => c.priority === tier).map((c) => c.address))].sort();
    }
    const borrowers = new Set(all.filter((c) => c.scaledBorrows > 0).map((c) => c.address));
    const depositOnlyByPriority = { critical: [], high: [], low: [] };
    for (const tier of ["critical", "high", "low"]) {
      depositOnlyByPriority[tier] = [...new Set(all.filter((c) => c.priority === tier && c.scaledDeposits > 0 && !borrowers.has(c.address)).map((c) => c.address))].sort();
    }
    out = JSON.stringify({
      generatedAt: new Date().toISOString(), totalStalePositions: all.length,
      addressesByPriority, depositOnlyByPriority, candidates: all,
    }, null, 2);
  } else out = stBuildReport(all);
  if (o.output) fs.writeFileSync(o.output, out + "\n");
  else console.log(out);
  process.exit(all.length > 0 ? 1 : 0);
}

// ─── mode: summary (from summarize-audit.js) ──────────────────

function parseSummaryArgs(rest) {
  const o = { file: null, top: 10, json: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--top" && rest[i + 1]) o.top = parseInt(rest[++i], 10);
    else if (rest[i] === "--json") o.json = true;
    else if (!rest[i].startsWith("--")) o.file = rest[i];
  }
  if (!o.file) {
    console.error("summary mode: need <audit.json>");
    process.exit(1);
  }
  return o;
}

function runSummary(rest) {
  const o = parseSummaryArgs(rest);
  const audit = loadAudit(o.file);
  const summary = buildSummary(audit, o.top);
  if (o.json) {
    console.log(JSON.stringify({
      generatedAt: summary.generatedAt, total: summary.total, uniqueUsers: summary.uniqueUsers,
      priority: summary.priority, networkStats: summary.networkStats, symbolStats: summary.symbolStats,
      topStale: summary.topStale.map((c) => ({ address: c.address, symbol: c.symbol, priceChangePercent: c.priceChangePercent, priority: c.priority })),
    }, null, 2));
  } else console.log(formatSummaryText(summary, o.top, o.file));
}

const { mode, rest } = parseRoot();
if (mode === "account") runAccount(rest).catch((e) => { console.error(e); process.exit(2); });
else if (mode === "staleness") runStaleness(rest).catch((e) => { console.error(e); process.exit(2); });
else runSummary(rest);
