import {
  fetchUserHealthByAddress,
  fetchUserHealthAll,
  fetchMarkets,
} from "./api.js";
import {
  getMarketConfigs,
  findMarket,
  simulateABICall,
  decodeUserResult,
  ABI_METHODS,
} from "./client.js";

const PRICE_SCALE = 1e18;
const BP = 10000;
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

function classifyRisk(hf) {
  if (hf === null || hf === undefined) return "none";
  if (hf <= 1.0) return "liquidatable";
  if (hf <= 1.1) return "critical";
  if (hf <= 1.2) return "high";
  if (hf <= 1.5) return "moderate";
  return "safe";
}

export async function getPosition(chain, address, symbol) {
  const networkId = chain === "voi" ? "voi-mainnet" : "algorand-mainnet";

  const [healthRecords, marketDataList] = await Promise.all([
    fetchUserHealthByAddress(address),
    fetchMarkets(chain),
  ]);

  const index = buildMarketIndex(chain);

  const chainHealth = healthRecords.filter((h) => h.network === networkId);

  const marketDataByKey = new Map();
  for (const md of marketDataList) {
    marketDataByKey.set(`${md.appId}:${md.marketId}`, md);
  }

  const positions = [];
  let totalSupplyUSD = 0;
  let totalBorrowUSD = 0;
  let weightedCollateral = 0;
  let weightedLiquidationThreshold = 0;

  for (const md of marketDataList) {
    const key = `${md.appId}:${md.marketId}`;
    const config = index.get(key);
    if (!config) continue;
    if (symbol && config.symbol.toLowerCase() !== symbol.toLowerCase()) continue;

    const decimals = config.decimals;
    const price = Number(md.price) / PRICE_SCALE;
    const collateralFactor = Number(md.collateralFactor) / BP;
    const liquidationThreshold = Number(md.liquidationThreshold) / BP;

    positions.push({
      symbol: config.symbol,
      name: config.name,
      chain,
      poolId: md.appId,
      contractId: md.marketId,
      nTokenId: Number(md.ntokenId),
      decimals,
      price,
      collateralFactor,
      liquidationThreshold,
    });
  }

  let aggregateHealthFactor = null;
  if (chainHealth.length > 0) {
    let totalCollateral = 0;
    let totalBorrow = 0;
    for (const h of chainHealth) {
      totalCollateral += Number(h.totalCollateralValue);
      totalBorrow += Number(h.totalBorrowValue);
    }
    totalSupplyUSD = totalCollateral / VALUE_SCALE;
    totalBorrowUSD = totalBorrow / VALUE_SCALE;
    if (totalBorrow > 0) {
      aggregateHealthFactor = totalCollateral / totalBorrow;
    }
  }

  return {
    address,
    chain,
    pools: chainHealth.map((h) => ({
      poolId: h.appId,
      healthFactor: h.healthFactor,
      totalCollateralUSD: Number(h.totalCollateralValue) / VALUE_SCALE,
      totalBorrowUSD: Number(h.totalBorrowValue) / VALUE_SCALE,
      riskLevel: classifyRisk(h.healthFactor),
    })),
    positions,
    summary: {
      totalSupplyUSD,
      totalBorrowUSD,
      healthFactor: aggregateHealthFactor,
      riskLevel: classifyRisk(aggregateHealthFactor),
      poolCount: chainHealth.length,
    },
  };
}

export async function getHealthFactor(chain, address) {
  const networkId = chain === "voi" ? "voi-mainnet" : "algorand-mainnet";
  const healthRecords = await fetchUserHealthByAddress(address);
  const chainHealth = healthRecords.filter((h) => h.network === networkId);

  if (chainHealth.length === 0) {
    return {
      address,
      chain,
      healthFactor: null,
      riskLevel: "none",
      totalSupplyUSD: 0,
      totalBorrowUSD: 0,
      pools: [],
    };
  }

  let totalCollateral = 0;
  let totalBorrow = 0;

  const pools = chainHealth.map((h) => {
    totalCollateral += Number(h.totalCollateralValue);
    totalBorrow += Number(h.totalBorrowValue);
    return {
      poolId: h.appId,
      healthFactor: h.healthFactor,
      totalCollateralUSD: Number(h.totalCollateralValue) / VALUE_SCALE,
      totalBorrowUSD: Number(h.totalBorrowValue) / VALUE_SCALE,
      riskLevel: classifyRisk(h.healthFactor),
    };
  });

  const aggregateHealthFactor = totalBorrow > 0 ? totalCollateral / totalBorrow : null;

  return {
    address,
    chain,
    healthFactor: aggregateHealthFactor,
    riskLevel: classifyRisk(aggregateHealthFactor),
    totalSupplyUSD: totalCollateral / VALUE_SCALE,
    totalBorrowUSD: totalBorrow / VALUE_SCALE,
    pools,
  };
}

export async function getUserOnChain(chain, address, symbol) {
  const market = findMarket(chain, symbol);
  if (!market) throw new Error(`Market "${symbol}" not found on ${chain}`);

  const mr = await simulateABICall(
    chain,
    market.poolId,
    ABI_METHODS.get_user,
    [address, market.contractId]
  );
  const d = decodeUserResult(mr.returnValue);
  const decimals = market.decimals;

  return {
    address,
    symbol: market.symbol,
    name: market.name,
    chain,
    poolId: market.poolId,
    contractId: market.contractId,
    decimals,
    scaledDeposits: Number(d.scaledDeposits) / 10 ** decimals,
    scaledBorrows: Number(d.scaledBorrows) / 10 ** decimals,
    depositIndex: d.depositIndex.toString(),
    borrowIndex: d.borrowIndex.toString(),
    lastUpdateTime: Number(d.lastUpdateTime),
    lastPrice: Number(d.lastPrice) / PRICE_SCALE,
    source: "on-chain",
  };
}

export async function getAllUsers(chain) {
  const allHealth = await fetchUserHealthAll(chain);

  const userMap = new Map();
  for (const h of allHealth) {
    const addr = h.userAddress;
    if (!userMap.has(addr)) {
      userMap.set(addr, { totalCollateral: 0, totalBorrow: 0, pools: [] });
    }
    const u = userMap.get(addr);
    const collateral = Number(h.totalCollateralValue);
    const borrow = Number(h.totalBorrowValue);
    u.totalCollateral += collateral;
    u.totalBorrow += borrow;
    u.pools.push({
      poolId: h.appId,
      healthFactor: h.healthFactor,
      totalCollateralUSD: collateral / VALUE_SCALE,
      totalBorrowUSD: borrow / VALUE_SCALE,
      riskLevel: classifyRisk(h.healthFactor),
    });
  }

  const users = [];
  for (const [address, data] of userMap) {
    const healthFactor =
      data.totalBorrow > 0 ? data.totalCollateral / data.totalBorrow : null;
    users.push({
      address,
      healthFactor,
      riskLevel: classifyRisk(healthFactor),
      totalCollateralUSD: data.totalCollateral / VALUE_SCALE,
      totalBorrowUSD: data.totalBorrow / VALUE_SCALE,
      poolCount: data.pools.length,
      pools: data.pools,
    });
  }

  users.sort((a, b) => (a.healthFactor ?? Infinity) - (b.healthFactor ?? Infinity));

  return {
    chain,
    totalUsers: users.length,
    users,
  };
}
