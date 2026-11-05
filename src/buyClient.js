import { getTokenBalance, x402 } from '@celo/buy-core';
import { privateKeyToAccount } from 'viem/accounts';

const AGENT402 = 'https://agent402.tools';
const BUY_REQUEST_TIMEOUT_MS = 45_000;
const USDC_DECIMALS = 6;
let dailySpend = { day: '', spentAtomic: 0n };

export const UPSTREAM_COSTS_USD = Object.freeze({
  peg: 0.003,
  yieldContext: 0.002,
  tokenSafety: 0.005,
  contractSource: 0.005,
  solidityScan: 0.01
});

export const FULL_UPSTREAM_BUDGET_USD = Object.values(UPSTREAM_COSTS_USD).reduce((sum, amount) => sum + amount, 0);

export function assertLiveBuyerConfiguration() {
  projectAccount();
  if (decimalToAtomic(process.env.BUY_DAILY_SPEND_CAP_USDC || '0') <= 0n) {
    throw new Error('BUY_DAILY_SPEND_CAP_USDC must be positive before live upstream payments are enabled.');
  }
}

const NETWORK_NAMES = Object.freeze({
  celo: 'celo',
  base: 'base',
  ethereum: 'ethereum',
  polygon: 'polygon',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  bsc: 'bsc',
  gnosis: 'gnosis'
});

/** Uses Buy's x402 client with the server-only signer held in Render Secrets. */
export async function fetchStablecoinPeg(symbol, options = {}) {
  const url = new URL('/api/stablecoin-peg', AGENT402);
  url.searchParams.set('coins', symbol);
  const json = await requestJson(url, { ...options, maxUpstreamUsd: UPSTREAM_COSTS_USD.peg });
  const coin = json.coins?.find(item => item.symbol?.toUpperCase() === symbol.toUpperCase());
  if (!coin || coin.deviationBps == null || coin.price == null || !Number.isFinite(Number(coin.deviationBps)) || !Number.isFinite(Number(coin.price))) {
    throw new Error(`Agent402 did not return a valid peg result for ${symbol}.`);
  }
  return {
    status: coin.status,
    deviationBps: Number(coin.deviationBps),
    price: Number(coin.price),
    maxDeviation24hBps: coin.maxDeviation24hBps != null && Number.isFinite(Number(coin.maxDeviation24hBps)) ? Number(coin.maxDeviation24hBps) : null,
    providerResponse: { peg: json.peg, count: json.count }
  };
}

export async function fetchDefiYieldContext(chain, symbol, options = {}) {
  const chainName = NETWORK_NAMES[chain];
  if (!chainName) throw new Error(`Agent402 yield data does not support ${chain}.`);
  return requestJson(new URL('/api/defi-yields', AGENT402), {
    ...options,
    method: 'POST',
    maxUpstreamUsd: UPSTREAM_COSTS_USD.yieldContext,
    body: { chain: chainName, symbol, stablecoinOnly: true, minTvlUsd: 0, sort: 'tvl', limit: 5 }
  });
}

export async function fetchTokenSafety(chain, address, options = {}) {
  if (!NETWORK_NAMES[chain]) throw new Error(`Agent402 token safety does not support ${chain}.`);
  return requestJson(new URL('/api/token-safety', AGENT402), {
    ...options,
    method: 'POST',
    maxUpstreamUsd: UPSTREAM_COSTS_USD.tokenSafety,
    body: { chain, address }
  });
}

export async function fetchContractSource(chain, address, options = {}) {
  if (!NETWORK_NAMES[chain]) throw new Error(`Agent402 contract source does not support ${chain}.`);
  return requestJson(new URL('/api/contract-source', AGENT402), {
    ...options,
    method: 'POST',
    maxUpstreamUsd: UPSTREAM_COSTS_USD.contractSource,
    body: { address, network: chain }
  });
}

export async function scanSolidity(source, options = {}) {
  return requestJson(new URL('/api/solidity-scan', AGENT402), {
    ...options,
    method: 'POST',
    maxUpstreamUsd: UPSTREAM_COSTS_USD.solidityScan,
    body: { source }
  });
}

async function requestJson(url, {
  method = 'GET',
  body,
  maxUpstreamUsd
} = {}) {
  const account = projectAccount();
  const maxAmount = decimalToAtomic(maxUpstreamUsd);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BUY_REQUEST_TIMEOUT_MS);
  try {
    const response = await x402.payingFetch({
      account,
      network: 'celo',
      preferredToken: 'USDC',
      readBalance: getTokenBalance
    }, url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      maxAmount,
      maxRetries: 1,
      onBeforePayment: requirements => reserveDailySpend(BigInt(requirements.maxAmountRequired))
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Buy upstream call failed (${response.status}): ${text.slice(0, 500)}`);
    try { return JSON.parse(text); }
    catch { throw new Error('Buy upstream did not return JSON.'); }
  } finally {
    clearTimeout(timeout);
  }
}

function projectAccount() {
  const key = process.env.BUY_IMPORT_KEY;
  if (!/^0x[a-fA-F0-9]{64}$/.test(key || '')) {
    throw new Error('Live upstream payments require BUY_IMPORT_KEY as a Render secret.');
  }
  return privateKeyToAccount(key);
}

function reserveDailySpend(amount) {
  const cap = decimalToAtomic(process.env.BUY_DAILY_SPEND_CAP_USDC || '0');
  const day = new Date().toISOString().slice(0, 10);
  if (dailySpend.day !== day) dailySpend = { day, spentAtomic: 0n };
  if (cap <= 0n) throw new Error('BUY_DAILY_SPEND_CAP_USDC must be positive before live upstream payments are enabled.');
  if (dailySpend.spentAtomic + amount > cap) throw new Error('Daily Buy spend cap reached; no upstream payment was sent.');
  // Reserve before the paid request. A network failure after signing is treated
  // conservatively because the authorization may still settle.
  dailySpend.spentAtomic += amount;
}

function decimalToAtomic(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(text)) throw new Error('USDC amount must be a positive decimal with at most 6 places.');
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt((fraction + '0'.repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS));
}
