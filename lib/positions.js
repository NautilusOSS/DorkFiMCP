import {
  fetchUserHealthByAddress,
  fetchUserHealthAll,
  fetchMarkets,
} from "./api.js";
import {
  getMarketConfigs,
  getPoolIds,
  simulateABICall,
  decodeUserResult,
  ABI_METHODS,
  resolveMarket,
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

/**
 * @param {{ poolId?: number, marketId?: number } | null} filter — if set, only that market row
 */
export async function getPosition(chain, address, filter) {
  const networkId = chain === "voi" ? "voi-mainnet" : "algorand-mainnet";

  if (filter && (filter.poolId != null) !== (filter.marketId != null)) {
    throw new Error("get_position filter requires both poolId and marketId");
  }
  if (filter?.poolId != null) {
    resolveMarket(chain, filter.poolId, filter.marketId);
  }

  const [healthRecords, marketDataList] = await Promise.all([
    fetchUserHealthByAddress(address),
    fetchMarkets(chain),
  ]);

  const index = buildMarketIndex(chain);

  const chainHealth = healthRecords.filter((h) => h.network === networkId);

  const positions = [];

  for (const md of marketDataList) {
    const key = `${md.appId}:${md.marketId}`;
    const config = index.get(key);
    if (!config) continue;
    if (filter?.poolId != null) {
      if (md.appId !== filter.poolId || md.marketId !== filter.marketId) continue;
    }

    const decimals = config.decimals;
    const price = Number(md.price) / PRICE_SCALE;
    const collateralFactor = Number(md.collateralFactor) / BP;
    const liquidationThreshold = Number(md.liquidationThreshold) / BP;

    positions.push({
      symbol: config.symbol,
      name: config.name,
      chain,
      poolId: md.appId,
      marketId: md.marketId,
      contractId: md.marketId,
      nTokenId: Number(md.ntokenId),
      decimals,
      price,
      collateralFactor,
      liquidationThreshold,
    });
  }

  let totalSupplyUSD = 0;
  let totalBorrowUSD = 0;
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
    /** Health factor and liquidation are per-pool; see pools[].healthFactor. */
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
      /** Aggregate across pools (informational only); liquidation is per-pool. */
      aggregateHealthFactor,
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
      pools: [],
      aggregateHealthFactor: null,
      riskLevel: "none",
      totalSupplyUSD: 0,
      totalBorrowUSD: 0,
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
    /** Health factor and liquidation are per-pool; see `pools[]`. Root aggregate is informational only. */
    pools,
    aggregateHealthFactor,
    riskLevel: classifyRisk(aggregateHealthFactor),
    totalSupplyUSD: totalCollateral / VALUE_SCALE,
    totalBorrowUSD: totalBorrow / VALUE_SCALE,
  };
}

export async function getUserOnChain(chain, address, poolId, marketId) {
  const market = resolveMarket(chain, poolId, marketId);

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
    marketId: market.contractId,
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

export async function getGlobalUserOnChain(chain, address) {
  const poolIds = getPoolIds(chain);

  const pools = [];

  for (const poolId of poolIds) {
    const mr = await simulateABICall(
      chain,
      poolId,
      ABI_METHODS.get_global_user,
      [address]
    );
    const v = mr.returnValue;
    const collateral = BigInt(v[0]);
    const borrow = BigInt(v[1]);
    const lastUpdateTime = Number(v[2]);
    const healthFactor =
      borrow > 0n
        ? Number((collateral * 10000n) / borrow) / 10000
        : null;

    pools.push({
      poolId,
      totalCollateralValue: collateral.toString(),
      totalBorrowValue: borrow.toString(),
      healthFactor,
      riskLevel: classifyRisk(healthFactor),
      lastUpdateTime,
    });
  }

  return {
    address,
    chain,
    pools,
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
    const aggregateHealthFactor =
      data.totalBorrow > 0 ? data.totalCollateral / data.totalBorrow : null;
    users.push({
      address,
      /** Per-pool health (liquidation is per-pool). */
      pools: data.pools,
      aggregateHealthFactor,
      riskLevel: classifyRisk(aggregateHealthFactor),
      totalCollateralUSD: data.totalCollateral / VALUE_SCALE,
      totalBorrowUSD: data.totalBorrow / VALUE_SCALE,
      poolCount: data.pools.length,
    });
  }

  users.sort(
    (a, b) => (a.aggregateHealthFactor ?? Infinity) - (b.aggregateHealthFactor ?? Infinity)
  );

  return {
    chain,
    totalUsers: users.length,
    users,
  };
}
