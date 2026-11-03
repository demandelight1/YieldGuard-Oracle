import { createPublicClient, http } from 'viem';
import { celo } from 'viem/chains';

const TRANSFER_SELECTOR = '0xa9059cbb';

export class PaymentError extends Error {
  constructor(message, code = 'PAYMENT_NOT_VERIFIED') { super(message); this.code = code; }
}

export function createPaymentVerifier(config, dependencies = {}) {
  const client = dependencies.client || createPublicClient({ chain: celo, transport: http(config.rpcUrl) });
  const used = new Map();

  return {
    async verify({ hash }) {
      if (!/^0x[a-fA-F0-9]{64}$/.test(hash || '')) throw new PaymentError('transactionHash must be a 0x-prefixed transaction hash.', 'INVALID_TRANSACTION_HASH');
      const key = hash.toLowerCase();
      const existing = used.get(key);
      if (existing && existing.expiresAt > Date.now()) {
        if (existing.consumed) throw new PaymentError('This payment was already used for a report.', 'PAYMENT_ALREADY_USED');
        return verifiedPaymentResponse(existing);
      }
      if (existing) used.delete(key);
      let receipt;
      try {
        receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 180_000, pollingInterval: 2_000 });
      } catch (error) {
        if (isReceiptTimeout(error)) {
          throw new PaymentError('Payment is still pending on Celo. Wait for confirmation, then retry verification with the same transaction.', 'PAYMENT_PENDING');
        }
        throw error;
      }
      if (receipt.status !== 'success') throw new PaymentError('The transaction did not succeed on Celo.', 'PAYMENT_FAILED');
      let tx;
      try {
        tx = await client.getTransaction({ hash });
      } catch (error) {
        if (isTransactionNotFound(error)) {
          throw new PaymentError('Celo confirmed the payment, but the RPC has not indexed its transaction yet. Retry verification shortly; do not submit another payment.', 'PAYMENT_INDEXING');
        }
        throw error;
      }
      if (tx.to?.toLowerCase() !== config.usdcAddress.toLowerCase()) throw new PaymentError('Payment must be a Celo USDC transfer.', 'WRONG_TOKEN');
      const transfer = parseTransfer(tx.input);
      if (!transfer || transfer.to.toLowerCase() !== config.recipient.toLowerCase()) throw new PaymentError('USDC transfer recipient is not the YieldGuard wallet.', 'WRONG_RECIPIENT');
      if (transfer.value < config.minimumAtomic) throw new PaymentError('USDC payment is below the report price.', 'INSUFFICIENT_PAYMENT');
      const paymentId = crypto.randomUUID();
      const record = { paymentId, expiresAt: Date.now() + 15 * 60_000, hash, paidAtomic: transfer.value.toString(), consumed: false };
      used.set(key, record);
      return verifiedPaymentResponse(record);
    },
    consume(paymentId) {
      for (const [hash, record] of used) {
        if (record.expiresAt < Date.now()) { used.delete(hash); continue; }
        if (record.paymentId !== paymentId) continue;
        if (record.consumed) throw new PaymentError('This payment was already used for a report.', 'PAYMENT_ALREADY_USED');
        record.consumed = true;
        return record;
      }
      throw new PaymentError('A verified, unused payment is required before creating a live report.', 'PAYMENT_REQUIRED');
    }
  };
}

function verifiedPaymentResponse(record) {
  return {
    paymentId: record.paymentId,
    transactionHash: record.hash,
    paidAtomic: record.paidAtomic,
    expiresAt: new Date(record.expiresAt).toISOString()
  };
}

function isReceiptTimeout(error) {
  return error?.name === 'WaitForTransactionReceiptTimeoutError'
    || /timed out while waiting for transaction|timeout waiting for transaction/i.test(error?.message || '');
}

function isTransactionNotFound(error) {
  return error?.name === 'TransactionNotFoundError'
    || /could not be found|transaction not found/i.test(error?.message || '');
}

function parseTransfer(input) {
  if (!input?.toLowerCase().startsWith(TRANSFER_SELECTOR) || input.length < 138) return null;
  const to = `0x${input.slice(34, 74)}`;
  const value = BigInt(`0x${input.slice(74, 138)}`);
  return { to, value };
}
