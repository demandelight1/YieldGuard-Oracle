import 'dotenv/config';
import { withAttribution, verifyTx } from '@celo/attribution-tags';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celo } from 'viem/chains';

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
const client = createWalletClient({ account, chain: celo, transport }).extend(withAttribution(tag));
const publicClient = createPublicClient({ chain: celo, transport });

// A zero-value self-transfer produces a direct, agent-wallet transaction.
// withAttribution appends the ERC-8021 suffix to the final calldata bytes.
console.log(`Sending tagged Celo transaction from ${account.address} with ${tag}…`);
const hash = await client.sendTransaction({ to: account.address, value: 0n });
console.log(`Submitted: ${hash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
const attribution = await verifyTx({ client: publicClient, hash });

if (!attribution?.codes.includes(tag)) {
  throw new Error(`Transaction confirmed but ${tag} was not decoded from its calldata.`);
}
console.log(`Confirmed in block ${receipt.blockNumber}`);
console.log(`Tag verified: ${attribution.codes.join(', ')}`);
console.log(`CeloScan: https://celoscan.io/tx/${hash}`);
