import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Render instances are disposable. When live evidence is enabled, recreate the
// named Buy account from a Render secret on each new instance. The account is
// intentionally file-backed inside the instance rather than relying on an OS
// keychain that a container does not provide.
if (process.env.ENABLE_LIVE_UPSTREAMS !== 'true') {
  console.log('Live upstreams disabled; skipping Buy account setup.');
  process.exit(0);
}

const account = process.env.BUY_ACCOUNT || 'yieldguard-oracle';
const importKey = process.env.BUY_IMPORT_KEY;
const dailyCap = process.env.BUY_DAILY_SPEND_CAP_USDC;

if (!/^0x[a-fA-F0-9]{64}$/.test(importKey || '')) {
  throw new Error('ENABLE_LIVE_UPSTREAMS=true requires BUY_IMPORT_KEY as a 0x-prefixed 32-byte Render secret.');
}
if (!/^\d+(?:\.\d{1,6})?$/.test(dailyCap || '') || Number(dailyCap) <= 0) {
  throw new Error('ENABLE_LIVE_UPSTREAMS=true requires a positive BUY_DAILY_SPEND_CAP_USDC value.');
}

const buyBin = fileURLToPath(new URL('../node_modules/@celo/buy/dist/main.js', import.meta.url));
if (!existsSync(buyBin)) throw new Error('The local @celo/buy CLI was not installed.');

const buyHome = process.env.BUY_HOME || join(tmpdir(), 'yieldguard-buy');
const buyEnv = {
  ...process.env,
  BUY_HOME: buyHome,
  BUY_KEYSTORE_BACKEND: 'file',
};

const list = await runBuy(['account', 'list'], buyEnv, { allowFailure: true });
if (!new RegExp(`(^|\\n)\\s*\\*?\\s*${escapeRegExp(account)}\\s`, 'm').test(list.stdout)) {
  await runBuy(['setup', '--name', account, '--import'], buyEnv);
}
await runBuy(['account', 'cap', account, dailyCap], buyEnv);
console.log(`Buy account "${account}" is ready with a ${dailyCap} stablecoin daily cap.`);

function runBuy(args, env, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [buyBin, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0 || allowFailure) {
        resolve({ stdout, stderr, code });
        return;
      }
      reject(new Error(`Buy setup failed: ${stderr || stdout}`));
    });
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
