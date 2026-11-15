# Preflight memo — 0x000000000000000000000000000000000000dEaD on ethereum

Network: Sepolia testnet (eip155:11155111) — testnet result, not mainnet.
Mission 01 (Exchange) verdict: **REVIEW**
Mission 14 (Web3 Native & DeFi) verdict: **REVIEW**

Total cost: $0.04 testnet USDC (4 of 4 calls returned a receipt).

## WASH_TRADING_DETECTION_GENERAL
- Leg verdict: REVIEW — Wash-trading check was inconclusive. Not a clean pass.
- Cost: $0.01 — 14247 ms — signal_hash: 0xa8894112e7a70a8bfa7282409a0ad73eaee9c6cefea70656a7365ce11e4db9eb
- Receipt verified: yes
- Result: {"subject":"0x000000000000000000000000000000000000dEaD","verdict":"inconclusive","wash_volume_pct":null,"signals":null,"summary":"No DEX market found for 0x000000000000000000000000000000000000dEaD."}

## SECURITY_REVIEW_GENERAL
- Leg verdict: REVIEW — Security review said Secure, but vulnerability_count and issues came back missing — the review was thin (the miner scanned the address string, not contract code). This is not a full audit.
- Cost: $0.01 — 11610 ms — signal_hash: 0x3d0c38991854f88b8b56989744db5a147cc11483a666b2e8f6d241ac7db86c6e
- Receipt verified: yes
- Result: {"verdict":"Secure","vulnerability_count":null,"issues":null,"summary":"Verdict: secure. No injection, eval, shell, deserialization, TLS, path, SSRF, XSS or hardcoded-secret patterns in 1 line scanned."}

## LIQUIDITY_DEPTH_VERIFY_GENERAL
- Leg verdict: REVIEW — Liquidity figure $28,000,000 conflicts with the wash leg, which found no DEX market for this token — the figure is not trusted.
- Cost: $0.01 — 34249 ms — signal_hash: 0xd5777bb703c368a531056ff1125e1b7ee6080595223621a9b87b74d9ab066f3c
- Receipt verified: yes
- Result: {"liquidity_usd":28000000}

## SANCTIONS_SCREENING_MATCH_GENERAL
- Leg verdict: CLEAN — No sanctions match (score 0).
- Cost: $0.01 — 18594 ms — signal_hash: 0xdc03188131664994ef415b517ec2f6a0bf68dfd2a04140fb33708fcc8761283c
- Receipt verified: yes
- Result: {"name":"0x3e0a40c927a4da19e6ececa432adb6adf36a4046","matched":false,"matches":null,"lists":["US OFAC SDN and non-SDN Consolidated lists (published 2026-11-13)","UN Security Council Consolidated List (published 2026-11-15)","EU Consolidated Financial Sanctions List (published 2026-10-23)","UK Sanctions List (published 2026-11-12)"],"match_score":0}

## Notes
- Review leg(s): WASH_TRADING_DETECTION_GENERAL, SECURITY_REVIEW_GENERAL, LIQUIDITY_DEPTH_VERIFY_GENERAL.
- Audit leg is thin: SECURITY_REVIEW on a bare address is not a full Solidity audit. Do not list on this leg alone.

Run at: 2026-11-15T16:01:31.866Z — wallet: 0x3E0A40c927a4dA19e6eceCa432adb6ADf36A4046 (testnet only).