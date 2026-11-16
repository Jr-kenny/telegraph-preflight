# OneShot execution record — 0x52a7ed336eec9580bb9cc87e5bb8d5a35b844029 on ethereum

Network: Sepolia testnet (eip155:11155111) — testnet result, not mainnet.
Mission 01 (Exchange) verdict: **REJECT**
Mission 14 (Web3 Native & DeFi) verdict: **REJECT**

Total cost: $0.04 testnet USDC (4 of 5 paid calls returned a receipt).

## WASH_TRADING_DETECTION_GENERAL
- Leg verdict: REVIEW — Wash-trading check was inconclusive. Not a clean pass.
- Cost: $0.01 — 21262 ms — signal_hash: 0x351e48eaadd207181f5f2c9187f7a7002af902427631398851ceaf0af8daf845
- Receipt verified: yes
- Result: {"subject":"0x52a7ed336eec9580bb9cc87e5bb8d5a35b844029","verdict":"inconclusive","wash_volume_pct":null,"signals":null,"summary":"No DEX market found for 0x52a7ed336eec9580bb9cc87e5bb8d5a35b844029."}

## SECURITY_REVIEW_GENERAL
- Leg verdict: REVIEW — Security review said Secure, but vulnerability_count and issues came back missing — the review was thin (the miner scanned the address string, not contract code). This is not a full audit.
- Cost: $0.01 — 19470 ms — signal_hash: 0xedaba21ca7eee59042a21b1d490dedae6826e11f707225b413941cb6c8f257ae
- Receipt verified: yes
- Result: {"verdict":"Secure","vulnerability_count":null,"issues":null,"summary":"Verdict: secure. No injection, eval, shell, deserialization, TLS, path, SSRF, XSS or hardcoded-secret patterns in 1 line scanned."}

## LIQUIDITY_DEPTH_VERIFY_GENERAL
- Leg verdict: REVIEW — Liquidity figure $1,182,265,866.03 conflicts with the wash leg, which found no DEX market for this token — the figure is not trusted.
- Cost: $0.01 — 26576 ms — signal_hash: 0xbce96eae0c3aacf2238d368fe2be76474978e31ac20697a219f05c60edefe71a
- Receipt verified: yes
- Result: {"liquidity_usd":1182265866.03}
- DexScreener cross-check: conflicting-no-market
- Consistency flag: conflicts with wash leg (no DEX market found)

## SANCTIONS_SCREENING_MATCH_GENERAL
- Leg verdict: CLEAN — No sanctions match (score 0).
- Cost: $0.01 — 18182 ms — signal_hash: 0xad510640ba6fd8177990fedf6049a0579bce8518dee70f8c9379df304b55ca53
- Receipt verified: yes
- Result: {"name":"0x3e0a40c927a4da19e6ececa432adb6adf36a4046","matched":false,"matches":null,"lists":["US OFAC SDN and non-SDN Consolidated lists (published 2026-11-13)","UN Security Council Consolidated List (published 2026-11-15)","EU Consolidated Financial Sanctions List (published 2026-10-23)","UK Sanctions List (published 2026-11-12)"],"match_score":0}

## HONEYPOT_SELL_SIMULATION
- Leg verdict: REJECT — Sell simulation failed (execution reverted: "revert: HP: BUY_FAILED") — the token could not be proven sellable.
- Source: honeypot.is (free check, no Telegraph payment)
- Receipt verified: not checked
- Result: isHoneypot=?, sellTax=?%, buyTax=?%, simulationSuccess=false, error: execution reverted: "revert: HP: BUY_FAILED"

## Notes
- Rejecting leg(s): HONEYPOT_SELL_SIMULATION.
- Review leg(s): WASH_TRADING_DETECTION_GENERAL, SECURITY_REVIEW_GENERAL, LIQUIDITY_DEPTH_VERIFY_GENERAL.
- Audit leg is thin: SECURITY_REVIEW on a bare address is not a full Solidity audit. Do not list on this leg alone.

## Execution integrity — OneShot
- Execution record hash (SHA-256): 0x37a2c018e0e2a27cb9f887f42509afffac7f166a6e9172903c07cae6e6d744ed
- Run sequence: #5
- Anchor tx (Sepolia): 0x8f0ab3d37892cf6d1abf42e09503ff50ec2e1a79014dac5221a00b46cb392d98
- Anchor: https://sepolia.etherscan.io/tx/0x8f0ab3d37892cf6d1abf42e09503ff50ec2e1a79014dac5221a00b46cb392d98 (gas used: 14048, block 12148753)
- Verify it yourself: node verify.js results/preflight-0x52a7ed336eec9580bb9cc87e5bb8d5a35b844029.json

Run at: 2026-11-16T17:18:21.255Z — wallet: 0x3E0A40c927a4dA19e6eceCa432adb6ADf36A4046 (testnet only).