import { arbitrum, base, bsc, celo, gnosis, mainnet, optimism, polygon } from 'viem/chains';
import { DiscoveryError } from './errors.js';

// One entry per chain the scanner accepts (see CHAINS in yieldguard.js; a test keeps them in sync).
// `geckoNetwork` is the GeckoTerminal network id; `coingeckoPlatform` is the CoinGecko asset platform id;
// `dexscreenerChain` is the DexScreener chain id (null where DexScreener has no coverage, e.g. Gnosis).
export const NETWORKS = [
  { id: 'celo', label: 'Celo', geckoNetwork: 'celo', coingeckoPlatform: 'celo', dexscreenerChain: 'celo', chain: celo },
  { id: 'base', label: 'Base', geckoNetwork: 'base', coingeckoPlatform: 'base', dexscreenerChain: 'base', chain: base },
  { id: 'ethereum', label: 'Ethereum', geckoNetwork: 'eth', coingeckoPlatform: 'ethereum', dexscreenerChain: 'ethereum', chain: mainnet },
  { id: 'polygon', label: 'Polygon', geckoNetwork: 'polygon_pos', coingeckoPlatform: 'polygon-pos', dexscreenerChain: 'polygon', chain: polygon },
  { id: 'arbitrum', label: 'Arbitrum', geckoNetwork: 'arbitrum', coingeckoPlatform: 'arbitrum-one', dexscreenerChain: 'arbitrum', chain: arbitrum },
  { id: 'optimism', label: 'Optimism', geckoNetwork: 'optimism', coingeckoPlatform: 'optimistic-ethereum', dexscreenerChain: 'optimism', chain: optimism },
  { id: 'bsc', label: 'BNB Chain', geckoNetwork: 'bsc', coingeckoPlatform: 'binance-smart-chain', dexscreenerChain: 'bsc', chain: bsc },
  { id: 'gnosis', label: 'Gnosis', geckoNetwork: 'xdai', coingeckoPlatform: 'xdai', dexscreenerChain: null, chain: gnosis }
];

export const DEFAULT_CHAIN = 'celo';

export function getNetwork(id) {
  const network = NETWORKS.find(item => item.id === String(id || '').toLowerCase());
  if (!network) {
    throw new DiscoveryError(`Unsupported chain. Use: ${NETWORKS.map(item => item.id).join(', ')}.`, { status: 400, code: 'UNSUPPORTED_CHAIN' });
  }
  return network;
}

export function publicNetworks() {
  return NETWORKS.map(({ id, label, chain }) => ({ id, label, chainId: chain.id, default: id === DEFAULT_CHAIN }));
}
