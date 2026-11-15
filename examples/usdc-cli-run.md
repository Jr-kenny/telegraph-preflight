# Preflight memo — 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 on ethereum

Network: Sepolia testnet (eip155:11155111) — testnet result, not mainnet.
Mission 01 (Exchange) verdict: **REVIEW**
Mission 14 (Web3 Native & DeFi) verdict: **REVIEW**

Total cost: $0.04 testnet USDC (4 paid calls).

## WASH_TRADING_DETECTION_GENERAL
- Leg verdict: REVIEW — Wash-trading check was inconclusive. Not a clean pass.
- Cost: $0.01 — 22416 ms — signal_hash: 0x977305a9d4fda0865aa5335c1c89fc5f6b6eaecc2e6eb3072c6e96129826b054
- Receipt verified: yes
- Result: {"subject":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","verdict":"inconclusive","wash_volume_pct":null,"signals":["24h volume $217.07M is 41.0x the pool's $5.29M liquidity","941 buys and 819 sells in 24h","High turnover alone can be arbitrage in a concentrated-liquidity pool, so it is not called wash trading"],"summary":"The USDC/USDT on metric (ethereum) pool is not clearly organic or washed."}

## SECURITY_REVIEW_GENERAL
- Leg verdict: REVIEW — Security review said Secure, but vulnerability_count and issues came back missing — the review was thin (the miner scanned the address string, not contract code). This is not a full audit.
- Cost: $0.01 — 19801 ms — signal_hash: 0x57d921efd51a1a8239a84023de524ca053656fa4d6d4ddb76ffcc228530ac2bd
- Receipt verified: yes
- Result: {"verdict":"Secure","vulnerability_count":null,"issues":null,"summary":"Verdict: secure. No injection, eval, shell, deserialization, TLS, path, SSRF, XSS or hardcoded-secret patterns in 1 line scanned."}

## LIQUIDITY_DEPTH_VERIFY_GENERAL
- Leg verdict: CLEAN — Liquidity $75,202,419.46.
- Cost: $0.01 — 10490 ms — signal_hash: 0xc2e85e8a1e90645914ad981cab1fcf71edc9b5248fd398bbcbb6d7ec31276942
- Receipt verified: yes
- Result: {"liquidity_usd":75202419.46}

## SANCTIONS_SCREENING_MATCH_GENERAL
- Leg verdict: CLEAN — No sanctions match (score 0).
- Cost: $0.01 — 23360 ms — signal_hash: 0xa7dc7438d3f8c4c43cfa48fab893d5a4050e2322adec8f92829bf188271ee590
- Receipt verified: yes
- Result: {"name":"0x3e0a40c927a4da19e6ececa432adb6adf36a4046","matched":false,"matches":null,"lists":["US OFAC SDN and non-SDN Consolidated lists (published 2026-11-13)","UN Security Council Consolidated List (published 2026-11-15)","EU Consolidated Financial Sanctions List (published 2026-10-23)","UK Sanctions List (published 2026-11-12)"],"match_score":0}

## Notes
- Review leg(s): WASH_TRADING_DETECTION_GENERAL, SECURITY_REVIEW_GENERAL.
- Audit leg is thin: SECURITY_REVIEW on a bare address is not a full Solidity audit. Do not list on this leg alone.

Run at: 2026-11-15T15:57:32.941Z — wallet: 0x3E0A40c927a4dA19e6eceCa432adb6ADf36A4046 (testnet only).