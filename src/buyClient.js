import { spawn } from 'node:child_process';

const AGENT402 = 'https://agent402.tools';
const BUY_REQUEST_TIMEOUT_MS = 45_000;

export const UPSTREAM_COSTS_USD = Object.freeze({
  peg: 0.003,
  yieldContext: 0.002,
  tokenSafety: 0.005,
  contractSource: 0.005,
  solidityScan: 0.01
});

export const FULL_UPSTREAM_BUDGET_USD = Object.values(UPSTREAM_COSTS_USD).reduce((sum, amount) => sum + amount, 0);

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

/**
 * Uses Buy's encrypted local account rather than reading a private key. Each
 * request is capped at the route's quoted price; report-level budgeting is
 * enforced by the caller.
 */
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
  buyAccount = 'yieldguard-oracle',
  buyCommand,
  method = 'GET',
  body,
  maxUpstreamUsd
} = {}) {
  const command = buyCommand || (process.platform === 'win32' ? 'buy.cmd' : 'buy');
  const args = [
    '--account', buyAccount, '--no-json', 'curl',
    '--max-amount', maxUpstreamUsd.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
  ];
  if (body !== undefined) args.push('--data-file', '-');
  args.push('-sS');
  if (body !== undefined) args.push('-X', method, '-H', 'Content-Type: application/json');
  args.push(url.toString());
  const output = await run(command, args, body === undefined ? undefined : JSON.stringify(body));
  return extractJson(output);
}

function run(command, args, stdinData) {
  return new Promise((resolve, reject) => {
    // .cmd files need cmd.exe on Windows. Request bodies go over stdin so
    // untrusted provider source can never become part of a shell command line.
    const child = process.platform === 'win32'
      ? spawn(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', `""${command}" ${args.map(quoteWindowsArgument).join(' ')}"`],
        { windowsHide: true, env: process.env, windowsVerbatimArguments: true, stdio: ['pipe', 'pipe', 'pipe'] }
      )
      : spawn(command, args, { windowsHide: true, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, BUY_REQUEST_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE') {
        clearTimeout(timeout);
        reject(error);
      }
    });
    child.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`Buy upstream call timed out after ${BUY_REQUEST_TIMEOUT_MS / 1000} seconds.`));
        return;
      }
      if (code === 0) resolve(stdout);
      else reject(new Error(`Buy upstream call failed (${code}): ${stderr || stdout}`));
    });
    child.stdin.end(stdinData);
  });
}

function quoteWindowsArgument(value) {
  const text = String(value);
  if (/^[a-zA-Z0-9_./:=?-]+$/.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/g, '$1$1')}"`;
}

function extractJson(value) {
  const first = value.indexOf('{');
  const last = value.lastIndexOf('}');
  if (first < 0 || last < first) throw new Error('Buy did not return a JSON upstream response.');
  return JSON.parse(value.slice(first, last + 1));
}
