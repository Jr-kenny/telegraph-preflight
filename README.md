# Telegraph Preflight

Token-risk preflight for **Telegraph Hackathon Season II**, Apps & Agents track,
**Mission 01 Exchange** + **Mission 14 Web3 Native & DeFi**. Sepolia testnet only.

One command checks a token before an exchange lists it or an agent buys it:
four paid Telegraph intelligence calls, then a **LIST / REVIEW / REJECT** memo
(Mission 01) and a **HOLD / REVIEW / REJECT** preflight (Mission 14) from the
same evidence, with receipts and total cost shown.

## What it checks

| Call | Intent | What it returns |
|---|---|---|
| Wash trading | `WASH_TRADING_DETECTION_GENERAL` | verdict + wash volume % |
| Security review (audit leg) | `SECURITY_REVIEW_GENERAL` | verdict + vulnerability count + issues |
| Liquidity depth | `LIQUIDITY_DEPTH_VERIFY_GENERAL` | liquidity in USD |
| Sanctions screening | `SANCTIONS_SCREENING_MATCH_GENERAL` | matched / not matched + score |

Optional extras: `--source <file>` adds a `CODE_REVIEW_GENERAL` call on real
contract source; `--handle <x-handle>` adds a `SOCIAL_BOT_DETECTION_GENERAL`
call on the project account. Each extra call is $0.01 testnet USDC.

## Verdict rules (honest by design)

- **REJECT** if sanctions matched, if wash trading is confirmed with a quoted
  wash percentage, or if the security review says Insecure.
- **REVIEW** if any leg is inconclusive, missing, or thin — including a
  security review that says Secure but returns no vulnerability count or
  issues. A thin review is never a clean pass, and a token is never labelled
  LIST or HOLD on the audit leg alone.
- **LIST / HOLD** only if every leg is clean and typed.

## Prerequisites

- Node 20+
- A Sepolia wallet with Sepolia ETH for gas and Sepolia test USDC for the
  paid calls. Test USDC can be minted on Sepolia, or claimed from the
  Anjoman faucet: https://anjoman.ai/dashboard/faucet
- The wallet private key as the `TELEGRAPH_PRIVATE_KEY` environment variable.
  Never put it in a file in this repo, never log it, never commit it.

## Run it

```sh
npm install
TELEGRAPH_PRIVATE_KEY=0x... node preflight.js ethereum 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
  --treasury 0x3E0A40c927a4dA19e6eceCa432adb6ADf36A4046 \
  --pool "WETH/USDC on ethereum"
```

More options:

```sh
node preflight.js ethereum <token-address> \
  --treasury <treasury-wallet-or-project-name> \
  --handle <project-x-handle> \
  --pool "<pair> on <chain>" \
  --source <contract-source.sol> \
  --out ./results
```

Output: a markdown memo printed to stdout, plus
`preflight-<token>.md` and `preflight-<token>.json` in the output directory,
with every `signal_hash`, cost, duration, and receipt check.

## Sample result (USDC on Ethereum, Sepolia testnet, 2026-11-15)

Verified live in the smoke test — 4 paid calls, all HTTP 200, all
`signal_hash` re-verified as `verified: true`, total **$0.04 testnet USDC**:

| Intent | Result | Cost |
|---|---|---|
| Wash trading | inconclusive — no wash % quoted | $0.01 |
| Security review | Secure, but thin: scanned "1 line", no vulnerability count or issues | $0.01 |
| Liquidity depth | $75,138,002.55 | $0.01 |
| Sanctions screening | matched: false, score 0 | $0.01 |

Memo verdict: **REVIEW** (Mission 01) / **REVIEW** (Mission 14) — not a forced
LIST, because the wash leg was inconclusive and the audit leg was thin.
Full receipts: `examples/usdc-preflight.md`.

Signal hashes (verify at `GET https://devnode.telegraphprotocol.com/engine/v1/signal/<hash>`):

- Wash: `0xe9fb33364fe6ec5a479f8ccffed16c6559e8f584dd678ad36933a5dccea21b1a`
- Security: `0xf40ef3eae361472193776e1d4c95b5c89516b5b60534b0970791847c9f6d4175`
- Liquidity: `0x6bb1633c66fbbeef295574cace3ef7ef4de8cf85da863a1341d690bcf53b6b10`
- Sanctions: `0x94564e5a1179a81480e5c74ed7e784068d8a9206f04ef2346ab0e26c6a7a4bb8`

## Cost

$0.01 testnet USDC per paid call. A 4-call run costs **$0.04**. Spend guards
in the code: no single payment over $0.10, no run over $0.10 total. All
payments are EIP-3009 authorisations on Sepolia, settled by the facilitator;
the `payTo` address is read from each 402 challenge, never hardcoded.

## Known limitations

- The audit leg is thin when given only a bare contract address: the
  security-review miner scans the address string, not Solidity code. Pass
  contract source with `--source` for a real code review, and treat a
  missing `vulnerability_count` / `issues` as REVIEW, not as proof of safety.
- Legs are cross-checked: if the wash leg finds no DEX market for the token,
  a liquidity figure for that token is marked REVIEW, not clean — a
  plausible-looking miner number is not trusted blindly. See
  `examples/unknown-token-preflight.md`, where the liquidity miner returned
  $28,000,000 for a token with no market at all.
- A leg that returns no receipt (for example a transient 402 from the
  payment step) costs $0.00, is marked failed, and is not counted in the
  total. The memo counts only calls that returned a receipt.
- `SMART_CONTRACT_AUDIT_GENERAL` has no typed response format on the live
  node, so it is not used. `CRYPTO_TRANSFER_VERIFY_GENERAL` is the same.
- `ONCHAIN_METRIC_VERIFY_GENERAL` accepts only ethereum, polygon and
  arbitrum — Base is not accepted there — and is not part of this tool.
- Testnet results are labelled testnet. A testnet check is not a mainnet
  listing decision.
- The final Anjoman submission form opens later; this repo is the working
  app and its evidence, not the submission itself.

## Links

- Mission 01: https://github.com/telegraphprotocol/bounties/issues/189
- Mission 14: https://github.com/telegraphprotocol/bounties/issues/202
- Bounties repo: https://github.com/telegraphprotocol/bounties
- Rules: https://anjoman.ai/dashboard/hackathon/season-2/rules
- Telegraph docs: https://anjoman.ai/docs/using/engine-ask

## License

MIT
