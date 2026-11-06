# YieldGuard Oracle

Celo-first, agent-facing DeFi yield-risk API. It consolidates yield, stablecoin-peg, token, contract-source, and Solidity-pattern checks in a single conservative report.

## Run

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

Open `http://localhost:3000`, or call:

```powershell
curl.exe -X POST http://localhost:3000/api/composite/yield-safety-score `
  -H "Content-Type: application/json" `
  -d '{"chain":"celo","poolAddress":"0x0000000000000000000000000000000000000001","tokenAddress":"0x0000000000000000000000000000000000000002","stablecoin":"USDC"}'
```

## Celo identity and economics

- Agent wallet: `0xf171D36B8E89566eD86e162F07289980A5c2970f`
- Attribution tag: `celo_6e7b9c9d8084`
- Buyer price: `$0.07 USDC` over x402 on Celo
- Maximum upstream budget: `$0.05` per uncached report

Reports never use simulated evidence. When live upstreams are disabled, the API returns unknown evidence and no composite risk score. Set `ENABLE_LIVE_UPSTREAMS=true` only when the machine has the named Buy account configured and you intend to make paid upstream calls. The backend uses the encrypted Buy account for the paid Agent402 requests; no private key is copied into the project.

The report calls `stablecoin-peg` ($0.003), `defi-yields` ($0.002), `token-safety` ($0.005), `contract-source` ($0.005), and—when verified source is available—`solidity-scan` ($0.01). Each Buy call has a route-specific maximum, and the total worst-case cap is $0.025 per report, below `UPSTREAM_MAX_USD=0.03`. The current token-risk provider does not cover Celo, so YieldGuard skips that paid request on Celo and reports token-specific risk as unresolved rather than presenting a false safe result. A paid scan requires both the pool contract and its underlying token contract; they are different inputs and are never silently treated as the same address.

The DeFi yield endpoint is a market screener, not an address-level pool lookup. Its results are included as explicitly labeled market context and do not fill the submitted pool's APY or TVL. Consequently, pool-specific yield and liquidity checks remain unresolved, and the app withholds the composite score rather than assigning unrelated market data to the selected pool. Unknown evidence is never marked safe.

## Consumer payment flow

Set `REQUIRE_CONSUMER_PAYMENT=true` in deployment to require a direct Celo USDC payment before a report is released. The browser asks MetaMask to transfer the fixed report price from the consumer's wallet to the YieldGuard wallet. It waits for the wallet RPC to observe confirmation; the server also waits for Celo confirmation before checking the transaction, amount, and recipient. A transaction hash is kept in session storage until verification succeeds, so a pending/indexing delay can be retried without prompting for another transfer. The server returns the same unused authorization if verification is retried and only consumes it once to issue a report. The payment is not consumed if live checks are disabled, the report lacks the token address, or the configured upstream budget is below the full check cap.

Customer payments are intentionally untagged. The hackathon attribution tag is applied only to direct transactions sent by the YieldGuard agent wallet, such as its eligibility transaction and ERC-8004 identity registration.

## Agent-wallet attribution proof

After replacing the private-key placeholder in the deployment/local `.env`, send and verify one direct tagged Celo transaction:

```powershell
cmd /c npm run tag:agent
```

The script sends a zero-value self-transfer from `AGENT_PRIVATE_KEY`, applies `CELO_ATTRIBUTION_TAG` through the official Celo SDK, waits for confirmation, verifies the suffix on-chain, and prints the CeloScan transaction URL. It is intentionally separate from consumer payments and from facilitator-settled x402 calls.

The browser never receives the project wallet key. For a live Render deployment, set `BUY_IMPORT_KEY` only as a Render secret and set `BUY_DAILY_SPEND_CAP_USDC`. The backend uses Buy's x402 client with an in-memory signer sourced only from that secret; it caps every route and reserves its process-level daily budget before a paid request is sent. Keep `ENABLE_LIVE_UPSTREAMS=false` until those values are present. The project wallet independently pays upstream agent services through Buy.

## Token and pool discovery

The scan page (`/dashboard.html`) lets users pick a chain and token instead of typing contract addresses.
`src/discovery/` proxies GeckoTerminal (trending pools, pool search, token pools), CoinGecko per-chain token lists and
each chain's RPC behind `/api/discovery/*`, with caching, rate limiting, timeouts and stale-if-error. After a token is
selected the server finds its pools, drops any the scanner cannot assess (wrong network, no 20-byte pool address such as
Uniswap v4 pool ids, under `POOL_MIN_LIQUIDITY_USD`, not a contract on-chain, or token0/token1 not matching), and the UI
auto-selects a single pool, asks the user to choose when several remain, and blocks Proceed when none do.
Discovery is independent of scanning and payment; `/api/composite/yield-safety-score` is unchanged.
