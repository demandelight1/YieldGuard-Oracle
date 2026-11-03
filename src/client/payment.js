import { createWalletClient, custom, isAddress, parseUnits, publicActions } from 'viem';
import { celo } from 'viem/chains';

const ERC20 = [
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] }
];

export async function connectWallet() {
  if (!window.ethereum) throw new Error('A Celo-compatible wallet extension such as MetaMask is required.');
  const requested = await window.ethereum.request({ method: 'eth_requestAccounts' });
  if (!Array.isArray(requested) || requested.length === 0) throw new Error('No wallet account was approved.');
  await ensureCelo();
  const wallet = createWalletClient({ chain: celo, transport: custom(window.ethereum) }).extend(publicActions);
  const [account] = await wallet.getAddresses();
  if (!account) throw new Error('No wallet account is connected.');
  return { wallet, account };
}

export async function disconnectWallet() {
  if (!window.ethereum) throw new Error('No wallet extension is available to disconnect.');
  try {
    await window.ethereum.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] });
  } catch (error) {
    if (error?.code !== 4200 && error?.code !== -32601) throw error;
  }
  const accounts = await window.ethereum.request({ method: 'eth_accounts' });
  return Array.isArray(accounts) && accounts.length === 0;
}

export async function payForReport(config, onStatus) {
  onStatus('Connecting wallet…');
  const { wallet, account } = await connectWallet();
  const pendingHashKey = `yieldguard.pending-payment.${config.recipient.toLowerCase()}`;
  const pendingHash = sessionStorage.getItem(pendingHashKey);
  if (pendingHash) {
    onStatus('Retrying verification of your previous payment…');
    const verified = await verifyPayment(pendingHash);
    if (verified.ok) {
      sessionStorage.removeItem(pendingHashKey);
      return { ...verified.data, account };
    }
    if (verified.code === 'PAYMENT_PENDING' || verified.code === 'PAYMENT_INDEXING') {
      throw new Error(`${verified.error} Transaction: ${pendingHash}`);
    }
    sessionStorage.removeItem(pendingHashKey);
  }
  const [symbol, decimals, balance] = await Promise.all([
    plainWallet.readContract({ address: config.usdcAddress, abi: ERC20, functionName: 'symbol' }),
    plainWallet.readContract({ address: config.usdcAddress, abi: ERC20, functionName: 'decimals' }),
    plainWallet.readContract({ address: config.usdcAddress, abi: ERC20, functionName: 'balanceOf', args: [account] })
  ]);
  if (symbol !== 'USDC' || decimals !== 6) {
    throw new Error(`The configured Celo payment token is ${symbol} with ${decimals} decimals, not 6-decimal USDC. Stop and check the app token configuration.`);
  }
  const amount = parseUnits(config.priceUsdc, decimals);
  if (balance < amount) {
    throw new Error(`Insufficient Celo USDC balance. Required: ${config.priceUsdc} USDC; available: ${formatUnits(balance, decimals)} USDC.`);
  }
  onStatus(`Confirm ${config.priceUsdc} USDC payment in your wallet…`);
  const hash = await wallet.writeContract({ account, address: config.usdcAddress, abi: ERC20, functionName: 'transfer', args: [config.recipient, amount] });
  sessionStorage.setItem(pendingHashKey, hash);
  onStatus('Payment sent. Waiting for Celo confirmation…');
  try {
    const receipt = await wallet.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 60_000 });
    if (receipt.status !== 'success') {
      sessionStorage.removeItem(pendingHashKey);
      throw new Error('The USDC payment transaction reverted on Celo.');
    }
  } catch (error) {
    if (/reverted on Celo/i.test(error.message)) throw error;
    onStatus('Wallet RPC has not confirmed the transaction yet. Checking Celo verification service…');
  }
  onStatus('Payment confirmed. Verifying recipient and amount…');
  const verified = await verifyPayment(hash);
  if (!verified.ok) throw new Error(`${verified.error}${verified.code === 'PAYMENT_PENDING' || verified.code === 'PAYMENT_INDEXING' ? ` Transaction: ${hash}` : ''}`);
  sessionStorage.removeItem(pendingHashKey);
  return { ...verified.data, account };
}

async function verifyPayment(hash) {
  const response = await fetch('/api/payments/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transactionHash: hash }) });
  const verified = await response.json();
  if (!response.ok) return { ok: false, code: verified.code, error: verified.error || 'Payment could not be verified.' };
  return { ok: true, data: verified };
}

export function validatePoolAddress(value, label = 'pool') {
  const address = String(value || '').trim();
  if (!isAddress(address, { strict: false })) {
    throw new Error(`Enter a valid 0x EVM ${label} contract address (0x followed by 40 hexadecimal characters) before paying.`);
  }
  return address;
}

function formatUnits(value, decimals) {
  const whole = value / 10n ** BigInt(decimals);
  const fraction = (value % 10n ** BigInt(decimals)).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

async function ensureCelo() {
  const chainId = await window.ethereum.request({ method: 'eth_chainId' });
  if (Number.parseInt(chainId, 16) === celo.id) return;
  try {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xa4ec' }] });
  } catch (error) {
    if (error?.code !== 4902) throw new Error('Switch MetaMask to Celo Mainnet before paying.');
    await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0xa4ec', chainName: 'Celo Mainnet', nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 }, rpcUrls: ['https://forno.celo.org'], blockExplorerUrls: ['https://celoscan.io'] }] });
  }
}
