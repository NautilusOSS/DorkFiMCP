import algosdk from "algosdk";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const contractsData = require("../data/contracts.json");

const CHAINS = contractsData;

const ABI_METHODS = {
  // --- Lending pool read methods ---
  get_market: new algosdk.ABIMethod({
    name: "get_market",
    args: [{ type: "uint64", name: "market_id" }],
    returns: {
      type: "(bool,uint256,uint256,uint64,uint64,uint64,uint64,uint64,uint64,uint256,uint256,uint256,uint256,uint64,uint256,uint256,uint64,uint64)",
    },
  }),
  get_user: new algosdk.ABIMethod({
    name: "get_user",
    args: [
      { type: "address", name: "user" },
      { type: "uint64", name: "market_id" },
    ],
    returns: { type: "(uint256,uint256,uint256,uint256,uint64,uint256)" },
  }),
  get_global_user: new algosdk.ABIMethod({
    name: "get_global_user",
    args: [{ type: "address", name: "user" }],
    returns: { type: "(uint256,uint256,uint64)" },
  }),
  get_global_user_collateral: new algosdk.ABIMethod({
    name: "get_global_user_collateral",
    args: [{ type: "address", name: "user" }],
    returns: { type: "uint256" },
  }),
  get_global_user_health: new algosdk.ABIMethod({
    name: "get_global_user_health",
    args: [
      { type: "address", name: "user" },
      { type: "uint64", name: "market_id" },
    ],
    returns: { type: "uint256" },
  }),

  // --- Lending pool write methods ---
  deposit: new algosdk.ABIMethod({
    name: "deposit",
    args: [
      { type: "uint64", name: "market_id" },
      { type: "uint256", name: "amount" },
    ],
    returns: { type: "uint256" },
  }),
  withdraw: new algosdk.ABIMethod({
    name: "withdraw",
    args: [
      { type: "uint64", name: "market_id" },
      { type: "uint256", name: "amount" },
    ],
    returns: { type: "uint256" },
  }),
  borrow: new algosdk.ABIMethod({
    name: "borrow",
    args: [
      { type: "uint64", name: "market_id" },
      { type: "uint256", name: "amount" },
    ],
    returns: { type: "uint256" },
  }),
  repay: new algosdk.ABIMethod({
    name: "repay",
    args: [
      { type: "uint64", name: "market_id" },
      { type: "uint256", name: "amount" },
    ],
    returns: { type: "uint256" },
  }),
  repay_all: new algosdk.ABIMethod({
    name: "repay_all",
    args: [{ type: "uint64", name: "market_id" }],
    returns: { type: "uint256" },
  }),
  repay_on_behalf: new algosdk.ABIMethod({
    name: "repay_on_behalf",
    args: [
      { type: "uint64", name: "market_id" },
      { type: "uint256", name: "amount" },
      { type: "address", name: "borrower" },
    ],
    returns: { type: "uint256" },
  }),
  get_user_borrow_amount: new algosdk.ABIMethod({
    name: "get_user_borrow_amount",
    args: [
      { type: "address", name: "user" },
      { type: "uint64", name: "market_id" },
    ],
    returns: { type: "uint256" },
  }),
  liquidate_cross_market: new algosdk.ABIMethod({
    name: "liquidate_cross_market",
    args: [
      { type: "uint64", name: "collateral_market" },
      { type: "uint64", name: "debt_market" },
      { type: "address", name: "borrower" },
      { type: "uint256", name: "amount" },
      { type: "uint256", name: "min_collateral" },
    ],
    returns: { type: "uint256" },
  }),

  // --- ARC-200 token methods ---
  arc200_balanceOf: new algosdk.ABIMethod({
    name: "arc200_balanceOf",
    args: [{ type: "address", name: "owner" }],
    returns: { type: "uint256" },
  }),
  arc200_approve: new algosdk.ABIMethod({
    name: "arc200_approve",
    args: [
      { type: "address", name: "spender" },
      { type: "uint256", name: "value" },
    ],
    returns: { type: "bool" },
  }),
  arc200_transfer: new algosdk.ABIMethod({
    name: "arc200_transfer",
    args: [
      { type: "address", name: "to" },
      { type: "uint256", name: "value" },
    ],
    returns: { type: "bool" },
  }),
};

export function getChainConfig(chain) {
  const config = CHAINS[chain];
  if (!config) throw new Error(`Unsupported chain: ${chain}. Use "voi" or "algorand".`);
  return config;
}

export function getAlgodClient(chain) {
  const config = getChainConfig(chain);
  return new algosdk.Algodv2(config.algodToken || "", config.algodUrl, config.algodPort);
}

export function getIndexerClient(chain) {
  const config = getChainConfig(chain);
  return new algosdk.Indexer("", config.indexerUrl, 443);
}

export function getMarketConfigs(chain) {
  return getChainConfig(chain).markets;
}

export function findMarket(chain, symbol) {
  const markets = getMarketConfigs(chain);
  return markets.find((m) => m.symbol.toLowerCase() === symbol.toLowerCase());
}

export function getPoolIds(chain) {
  const config = getChainConfig(chain);
  if (config.pools) return config.pools;
  const markets = getMarketConfigs(chain);
  return [...new Set(markets.map((m) => m.poolId))];
}

export function findMarketByContract(chain, poolId, contractId) {
  const markets = getMarketConfigs(chain);
  return markets.find(
    (m) => m.poolId === poolId && m.contractId === contractId
  );
}

function emptySignSigner(txnGroup, indexesToSign) {
  return Promise.resolve(
    indexesToSign.map((i) => {
      const txnObj = algosdk.decodeObj(algosdk.encodeUnsignedTransaction(txnGroup[i]));
      return new Uint8Array(algosdk.encodeObj({ txn: txnObj }));
    })
  );
}

export async function simulateABICall(chain, appId, method, args) {
  const algod = getAlgodClient(chain);
  const params = await algod.getTransactionParams().do();
  const sender = algosdk.getApplicationAddress(appId);

  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: appId,
    method: method,
    methodArgs: args,
    sender: sender,
    suggestedParams: params,
    signer: emptySignSigner,
  });

  const simRequest = new algosdk.modelsv2.SimulateRequest({
    txnGroups: [],
    allowEmptySignatures: true,
    allowUnnamedResources: true,
  });

  const response = await atc.simulate(algod, simRequest);
  const mr = response.methodResults[0];
  if (mr.decodeError) throw mr.decodeError;
  return mr;
}

/**
 * Decode the get_market return tuple.
 * ABI: (bool, uint256, uint256, uint64, uint64, uint64, uint64, uint64, uint64,
 *        uint256, uint256, uint256, uint256, uint64, uint256, uint256, uint64, uint64)
 */
export function decodeMarketResult(returnValue) {
  const v = returnValue;
  return {
    paused: v[0],
    maxTotalDeposits: BigInt(v[1]),
    maxTotalBorrows: BigInt(v[2]),
    liquidationBonus: BigInt(v[3]),
    collateralFactor: BigInt(v[4]),
    liquidationThreshold: BigInt(v[5]),
    reserveFactor: BigInt(v[6]),
    borrowRate: BigInt(v[7]),
    slope: BigInt(v[8]),
    totalScaledDeposits: BigInt(v[9]),
    totalScaledBorrows: BigInt(v[10]),
    depositIndex: BigInt(v[11]),
    borrowIndex: BigInt(v[12]),
    lastUpdateTime: BigInt(v[13]),
    reserves: BigInt(v[14]),
    price: BigInt(v[15]),
    ntokenId: BigInt(v[16]),
    closeFactor: BigInt(v[17]),
  };
}

/**
 * Decode the get_user return tuple.
 * ABI: (uint256, uint256, uint256, uint256, uint64, uint256)
 * Fields: scaled_deposits, scaled_borrows, deposit_index, borrow_index, last_update_time, last_price
 */
export function decodeUserResult(returnValue) {
  const v = returnValue;
  return {
    scaledDeposits: BigInt(v[0]),
    scaledBorrows: BigInt(v[1]),
    depositIndex: BigInt(v[2]),
    borrowIndex: BigInt(v[3]),
    lastUpdateTime: BigInt(v[4]),
    lastPrice: BigInt(v[5]),
  };
}

export { ABI_METHODS, algosdk };
