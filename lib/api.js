const BASE_URL = "https://dorkfi-api.nautilus.sh";

const NETWORK_MAP = {
  voi: "voi-mainnet",
  algorand: "algorand-mainnet",
};

function networkId(chain) {
  const id = NETWORK_MAP[chain];
  if (!id) throw new Error(`Unsupported chain: ${chain}`);
  return id;
}

async function get(path) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${res.status}: ${url}`);
  const json = await res.json();
  if (!json.success) throw new Error(`API error: ${url}`);
  return json;
}

export async function fetchMarkets(chain) {
  const json = await get(`/market-data/${networkId(chain)}`);
  return json.data || [];
}

export async function fetchMarket(chain, appId, marketId) {
  const json = await get(`/market-data/${networkId(chain)}/${appId}/${marketId}`);
  return json.data;
}

export async function fetchMarketList(chain) {
  const json = await get(`/markets/${networkId(chain)}`);
  return json.data || [];
}

export async function fetchUserHealthAll(chain) {
  const json = await get(`/user-health/${networkId(chain)}`);
  return json.data || [];
}

export async function fetchUserHealthByAddress(address) {
  const json = await get(`/user-health/user/${address}`);
  return json.data || [];
}

export async function fetchUserData(address) {
  const json = await get(`/user-data/user/${address}`);
  return json.data || [];
}

export async function fetchUserDataForMarket(address, chain, appId, marketId) {
  const json = await get(`/user-data/user/${address}/${networkId(chain)}/${appId}/${marketId}`);
  return json.data;
}

export async function fetchGlobalUserData(address) {
  const json = await get(`/global-user-data/user/${address}`);
  return json.data || [];
}

export async function fetchTVL(chain) {
  if (chain) {
    const json = await get(`/analytics/tvl/${networkId(chain)}`);
    return json.data;
  }
  const json = await get("/analytics/tvl");
  return json.data;
}

export async function fetchActivity(chain, appId, address) {
  const json = await get(`/activity/${networkId(chain)}/${appId}/${address}`);
  return json.data || [];
}

export async function fetchActivitySummary(chain, appId, address) {
  const json = await get(`/activity/${networkId(chain)}/${appId}/${address}/summary`);
  return json.data;
}

export async function fetchMarketHolders(chain, appId, marketId) {
  const json = await get(`/markets/${networkId(chain)}/${appId}/${marketId}/holders`);
  return json.data || [];
}
