import { createPublicClient, http, parseAbi } from 'viem';
import { getNetwork } from './networks.js';

const ERC20 = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
const PAIR = parseAbi(['function token0() view returns (address)', 'function token1() view returns (address)']);

/** On-chain checks against each chain's RPC. Override per chain with RPC_URL_<CHAIN>; Celo also honours CELO_RPC_URL. */
export function createRpc(env = process.env) {
  const clients = new Map();
  const client = networkId => {
    if (!clients.has(networkId)) {
      const { chain } = getNetwork(networkId);
      const url = env[`RPC_URL_${networkId.toUpperCase()}`] || (networkId === 'celo' && env.CELO_RPC_URL) || chain.rpcUrls.default.http[0];
      clients.set(networkId, createPublicClient({ chain, transport: http(url, { timeout: 8000, retryCount: 1, batch: true }), batch: { multicall: true } }));
    }
    return clients.get(networkId);
  };
  const attempt = async fn => { try { return await fn(); } catch { return null; } };

  return {
    /** True when the address has contract code on the chain. Throws if the RPC cannot be reached. */
    async isContract(networkId, address) {
      const code = await client(networkId).getCode({ address });
      return Boolean(code && code !== '0x');
    },
    async readErc20(networkId, address) {
      const c = client(networkId);
      const [name, symbol, decimals] = await Promise.all(['name', 'symbol', 'decimals'].map(functionName => attempt(() => c.readContract({ address, abi: ERC20, functionName }))));
      return { name, symbol, decimals: Number.isInteger(decimals) ? decimals : null };
    },
    /** token0/token1 for Uniswap-style pools; null when the pool does not expose them (Curve, Balancer, ...). */
    async readPairTokens(networkId, pool) {
      const c = client(networkId);
      const [token0, token1] = await Promise.all(['token0', 'token1'].map(functionName => attempt(() => c.readContract({ address: pool, abi: PAIR, functionName }))));
      return token0 && token1 ? { token0, token1 } : null;
    }
  };
}
