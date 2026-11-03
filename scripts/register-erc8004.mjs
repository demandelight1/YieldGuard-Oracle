import 'dotenv/config';
import { withAttribution, verifyTx } from '@celo/attribution-tags';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celo } from 'viem/chains';

const IDENTITY_REGISTRY = process.env.ERC8004_IDENTITY_REGISTRY
  || '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const key = process.env.AGENT_PRIVATE_KEY;
const tag = process.env.CELO_ATTRIBUTION_TAG;
const rpcUrl = process.env.CELO_RPC_URL || 'https://forno.celo.org';

if (!/^0x[a-fA-F0-9]{64}$/.test(key || '')) {
  throw new Error('AGENT_PRIVATE_KEY must be a real 0x-prefixed 32-byte private key in .env.');
}
if (!/^celo_[a-z0-9_]{1,27}$/.test(tag || '')) {
  throw new Error('CELO_ATTRIBUTION_TAG must be a valid assigned Celo code.');
}

const account = privateKeyToAccount(key);
const transport = http(rpcUrl);
const publicClient = createPublicClient({ chain: celo, transport });
const walletClient = createWalletClient({ account, chain: celo, transport })
  .extend(withAttribution(tag));

// Verify that the known CREATE2 registry is actually deployed on the configured chain
// before requesting an irreversible mainnet registration transaction.
const bytecode = await publicClient.getBytecode({ address: IDENTITY_REGISTRY });
if (!bytecode || bytecode === '0x') {
  throw new Error(`No ERC-8004 Identity Registry code found at ${IDENTITY_REGISTRY} on Celo.`);
}

const agentMetadata = {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: 'YieldGuard Oracle',
  description: 'Celo-first DeFi yield-risk intelligence oracle for autonomous yield aggregators.',
  x402Support: true,
  active: true,
};
const agentUri = `data:application/json;utf8,${encodeURIComponent(JSON.stringify(agentMetadata))}`;

const identityRegistryAbi = [{
  type: 'function',
  name: 'register',
  stateMutability: 'nonpayable',
  inputs: [{ name: 'agentURI', type: 'string' }],
  outputs: [{ name: 'agentId', type: 'uint256' }],
}];

console.log(`Registering YieldGuard Oracle from ${account.address} on the Celo ERC-8004 Identity Registry...`);
const hash = await walletClient.writeContract({
  address: IDENTITY_REGISTRY,
  abi: identityRegistryAbi,
  functionName: 'register',
  args: [agentUri],
});

console.log(`Submitted: ${hash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
if (receipt.status !== 'success') {
  throw new Error(`ERC-8004 registration reverted: ${hash}`);
}

const attribution = await verifyTx({ client: publicClient, hash });
if (!attribution?.codes.includes(tag)) {
  throw new Error(`Registration confirmed but ${tag} was not decoded from its calldata.`);
}

console.log(`Identity registered in block ${receipt.blockNumber}`);
console.log(`Tag verified: ${attribution.codes.join(', ')}`);
console.log(`CeloScan: https://celoscan.io/tx/${hash}`);
