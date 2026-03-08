import { fetchUserHealthAll } from "./api.js";

const VALUE_SCALE = 1e12;

function classifyRisk(hf) {
  if (hf === null || hf === undefined) return "none";
  if (hf <= 1.0) return "liquidatable";
  if (hf <= 1.1) return "critical";
  if (hf <= 1.2) return "high";
  if (hf <= 1.5) return "moderate";
  return "safe";
}

export async function getLiquidationCandidates(chain, options = {}) {
  const threshold = options.threshold || 1.1;
  const limit = options.limit || 50;
  const addresses = options.addresses || [];

  const allHealth = await fetchUserHealthAll(chain);

  let filtered = allHealth;
  if (addresses.length > 0) {
    const addrSet = new Set(addresses.map((a) => a.toUpperCase()));
    filtered = allHealth.filter((h) => addrSet.has(h.userAddress.toUpperCase()));
  }

  const candidates = [];
  for (const h of filtered) {
    if (h.healthFactor === null || h.healthFactor === undefined) continue;
    if (h.healthFactor > threshold) continue;
    candidates.push({
      address: h.userAddress,
      poolId: h.appId,
      healthFactor: h.healthFactor,
      totalCollateralUSD: Number(h.totalCollateralValue) / VALUE_SCALE,
      totalBorrowUSD: Number(h.totalBorrowValue) / VALUE_SCALE,
      riskLevel: classifyRisk(h.healthFactor),
      lastUpdated: h.lastUpdated,
    });
  }

  candidates.sort((a, b) => a.healthFactor - b.healthFactor);

  return {
    chain,
    threshold,
    totalUsersScanned: allHealth.length,
    candidateCount: candidates.length,
    candidates: candidates.slice(0, limit),
  };
}
