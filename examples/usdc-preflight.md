# Preflight memo — 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 on ethereum

Network: Sepolia testnet (eip155:11155111) — testnet result, not mainnet.
Mission 01 (Exchange) verdict: **REVIEW**
Mission 14 (Web3 Native & DeFi) verdict: **REVIEW**

Total cost: $0.04 testnet USDC (4 paid calls).

Run: 2026-11-15 ~15:48–15:52 UTC. Wallet: 0x3E0A40c927a4dA19e6eceCa432adb6ADf36A4046 (testnet only).
Fixture verified live before use: USDC on Ethereum mainnet — contract code exists, symbol USDC, decimals 6.

## WASH_TRADING_DETECTION_GENERAL

- Leg verdict: REVIEW — Wash-trading check was inconclusive. Not a clean pass.
- Cost: $0.01 — 13,894 ms — signal_hash: 0xe9fb33364fe6ec5a479f8ccffed16c6559e8f584dd678ad36933a5dccea21b1a
- Receipt verified: yes
- Result: {"subject": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "verdict": "inconclusive", "wash_volume_pct": null, "signals": ["24h volume $52.92M is 8.7x the pool's $6.11M liquidity", "1442 buys and 1172 sells in 24h", "High turnover alone can be arbitrage in a concentrated-liquidity pool, so it is not called wash trading"], "summary": "The USDC/USDT on uniswap (ethereum) pool is not clearly organic or washed."}
- Miner: 20260828 — PREFLIGHT Infrastructure Signals

## SECURITY_REVIEW_GENERAL

- Leg verdict: REVIEW — Security review said Secure, but vulnerability_count and issues came back missing — the review was thin (the miner scanned the address string, not contract code). This is not a full audit.
- Cost: $0.01 — 20,254 ms — signal_hash: 0xf40ef3eae361472193776e1d4c95b5c89516b5b60534b0970791847c9f6d4175
- Receipt verified: yes
- Result: {"verdict": "Secure", "vulnerability_count": null, "issues": null, "summary": "Verdict: secure. No injection, eval, shell, deserialization, TLS, path, SSRF, XSS or hardcoded-secret patterns in 1 line scanned."}
- Miner: 731001 — PR Guard Sentinel (code and dependency security review)

## LIQUIDITY_DEPTH_VERIFY_GENERAL

- Leg verdict: CLEAN — Liquidity $75,138,002.55.
- Cost: $0.01 — 9,709 ms — signal_hash: 0x6bb1633c66fbbeef295574cace3ef7ef4de8cf85da863a1341d690bcf53b6b10
- Receipt verified: yes
- Result: {"liquidity_usd": 75138002.55}
- Miner: 20260828 — PREFLIGHT Infrastructure Signals

## SANCTIONS_SCREENING_MATCH_GENERAL

- Leg verdict: CLEAN — No sanctions match (score 0).
- Cost: $0.01 — 13,405 ms — signal_hash: 0x94564e5a1179a81480e5c74ed7e784068d8a9206f04ef2346ab0e26c6a7a4bb8
- Receipt verified: yes
- Result: {"name": "0x3e0a40c927a4da19e6ececa432adb6adf36a4046", "matched": false, "matches": null, "lists": ["US OFAC SDN and non-SDN Consolidated lists (published 2026-11-13)", "UN Security Council Consolidated List (published 2026-11-15)", "EU Consolidated Financial Sanctions List (published 2026-10-23)", "UK Sanctions List (published 2026-11-12)"], "match_score": 0}
- Miner: 731002 — Counterproof Sanctions Screener

## Notes

- Review leg(s): WASH_TRADING_DETECTION_GENERAL, SECURITY_REVIEW_GENERAL.
- Audit leg is thin: SECURITY_REVIEW on a bare address is not a full Solidity audit. Do not list on this leg alone.
- Every call carried an X-TELEGRAPH-RECEIPT header (settlement: onchain). Every signal_hash was re-checked via GET https://devnode.telegraphprotocol.com/engine/v1/signal/<hash> — verification.verified: true for all four.

## How to reproduce

```sh
npm install
TELEGRAPH_PRIVATE_KEY=0x... node preflight.js ethereum 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
  --treasury 0x3E0A40c927a4dA19e6eceCa432adb6ADf36A4046 \
  --pool "WETH/USDC on ethereum"
```

Expected: 4 paid calls, $0.04 total, memo REVIEW / REVIEW. Exact miner verdicts may vary run to run; the verdict logic (inconclusive or thin → REVIEW) is what must hold.
