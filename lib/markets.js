import { fetchMarkets } from "./api.js";
import {
  getMarketConfigs,
  findMarket,
  simulateABICall,
  decodeMarketResult,
  ABI_METHODS,
} from "./client.js";

const BP = 10000;
const PRICE_SCALE = 1e18;
const VALUE_SCALE = 1e12;

function buildMarketIndex(chain) {
  const configs = getMarketConfigs(chain);
  const index = new Map();
  for (const c of configs) {
    const key = `${c.poolId}:${c.contractId}`;
    index.set(key, c);
  }
  return index;
}

function formatMarket(apiData, config) {
  const deposits = BigInt(apiData.totalScaledDeposits);
  const borrows = BigInt(apiData.totalScaledBorrows);
  const depositsBn = Number(deposits);
  const borrowsBn = Number(borrows);
  const utilization = depositsBn > 0 ? borrowsBn / depositsBn : 0;

  const borrowRate = Number(apiData.borrowRate) / BP;
  const slope = Number(apiData.slope) / BP;
  const reserveFactor = Number(apiData.reserveFactor) / BP;
  const currentBorrowRate = borrowRate + utilization * slope;
  const supplyRate = utilization * currentBorrowRate * (1 - reserveFactor);

  const decimals = config?.decimals ?? 6;

  return {
    symbol: config?.symbol ?? `ID:${apiData.marketId}`,
    name: config?.name ?? "Unknown",
    chain: null,
    poolId: apiData.appId,
    contractId: apiData.marketId,
    nTokenId: Number(apiData.ntokenId),
    decimals,
    tokenStandard: config?.tokenStandard ?? "unknown",
    paused: apiData.paused,
    price: Number(apiData.price) / PRICE_SCALE,
    collateralFactor: Number(apiData.collateralFactor) / BP,
    liquidationThreshold: Number(apiData.liquidationThreshold) / BP,
    liquidationBonus: Number(apiData.liquidationBonus) / BP,
    reserveFactor,
    closeFactor: Number(apiData.closeFactor) / BP,
    baseBorrowRate: borrowRate,
    slope: slope,
    currentBorrowRate,
    supplyRate,
    utilization,
    totalDeposits: Number(deposits) / 10 ** decimals,
    totalBorrows: Number(borrows) / 10 ** decimals,
    maxTotalDeposits: Number(BigInt(apiData.maxTotalDeposits)) / 10 ** decimals,
    maxTotalBorrows: Number(BigInt(apiData.maxTotalBorrows)) / 10 ** decimals,
    reserves: Number(BigInt(apiData.reserves)) / 10 ** decimals,
    depositIndex: apiData.depositIndex,
    borrowIndex: apiData.borrowIndex,
    lastUpdateTime: Number(apiData.lastUpdateTime),
  };
}

export async function getMarkets(chain, symbol) {
  if (symbol) {
    const config = findMarket(chain, symbol);
    if (!config) throw new Error(`Market "${symbol}" not found on ${chain}`);
  }

  const apiData = await fetchMarkets(chain);
  const index = buildMarketIndex(chain);

  const results = [];
  for (const md of apiData) {
    const key = `${md.appId}:${md.marketId}`;
    const config = index.get(key);
    const market = formatMarket(md, config);
    market.chain = chain;

    if (symbol) {
      if (config && config.symbol.toLowerCase() === symbol.toLowerCase()) {
        results.push(market);
      }
    } else {
      results.push(market);
    }
  }

  if (symbol && results.length === 0) {
    throw new Error(`Market "${symbol}" not found in API data for ${chain}`);
  }

  return results;
}

export async function getMarketOnChain(chain, symbol) {
  const market = findMarket(chain, symbol);
  if (!market) throw new Error(`Market "${symbol}" not found on ${chain}`);

  const mr = await simulateABICall(
    chain,
    market.poolId,
    ABI_METHODS.get_market,
    [market.contractId]
  );
  const d = decodeMarketResult(mr.returnValue);
  const decimals = market.decimals;

  return {
    symbol: market.symbol,
    name: market.name,
    chain,
    poolId: market.poolId,
    contractId: market.contractId,
    nTokenId: Number(d.ntokenId),
    decimals,
    tokenStandard: market.tokenStandard,
    paused: d.paused,
    price: Number(d.price) / PRICE_SCALE,
    collateralFactor: Number(d.collateralFactor) / BP,
    liquidationThreshold: Number(d.liquidationThreshold) / BP,
    liquidationBonus: Number(d.liquidationBonus) / BP,
    reserveFactor: Number(d.reserveFactor) / BP,
    closeFactor: Number(d.closeFactor) / BP,
    borrowRate: Number(d.borrowRate) / BP,
    slope: Number(d.slope) / BP,
    totalDeposits: Number(d.totalScaledDeposits) / 10 ** decimals,
    totalBorrows: Number(d.totalScaledBorrows) / 10 ** decimals,
    maxTotalDeposits: Number(d.maxTotalDeposits) / 10 ** decimals,
    maxTotalBorrows: Number(d.maxTotalBorrows) / 10 ** decimals,
    reserves: Number(d.reserves) / 10 ** decimals,
    depositIndex: d.depositIndex.toString(),
    borrowIndex: d.borrowIndex.toString(),
    lastUpdateTime: Number(d.lastUpdateTime),
    source: "on-chain",
  };
}
