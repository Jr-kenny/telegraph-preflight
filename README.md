# OneShot

Token-risk preflight for **Telegraph Hackathon Season II**, Apps & Agents track,
**Mission 01 Exchange** + **Mission 14 Web3 Native & DeFi**. Sepolia testnet only.

One command checks a token before an exchange lists it or an agent buys it:
four paid Telegraph intelligence calls, then a **LIST / REVIEW / REJECT** memo
(Mission 01) and a **HOLD / REVIEW / REJECT** preflight (Mission 14) from the
same evidence, with receipts and total cost shown.

Telegraph proves the checks were bought. OneShot proves the verdict is
honest: every run is written into a single execution record, hashed, and
anchored on Sepolia, so anyone can re-check it with `node verify.js`.
The idea is the whole product, not a feature — see
[docs/index.html](docs/index.html) for two real runs and how the proof works.

## What it checks

| Call | Intent | What it returns |
|---|---|---|
| Wash trading | `WASH_TRADING_DETECTION_GENERAL` | verdict + wash volume % |
| Security review (audit leg) | `SECURITY_REVIEW_GENERAL` | verdict + vulnerability count + issues |
| Liquidity depth | `LIQUIDITY_DEPTH_VERIFY_GENERAL` | liquidity in USD |
| Sanctions screening | `SANCTIONS_SCREENING_MATCH_GENERAL` | matched / not matched + score |
| Honeypot sell simulation | `HONEYPOT_SELL_SIMULATION` | sell simulation + sell tax (honeypot.is, free) |

Optional extras: `--source <file>` adds a `CODE_REVIEW_GENERAL` call on real
contract source; `--handle <x-handle>` adds a `SOCIAL_BOT_DETECTION_GENERAL`
call on the project account. Each extra call is $0.01 testnet USDC.

Two free cross-checks run after the paid legs:

- **Honeypot sell simulation** (honeypot.is, no key, no payment). If the
  sell simulation fails, or sell tax is 99% or more, or the token is a
  honeypot, the leg rejects — and a rejecting leg rejects the whole run.
  No Telegraph intent flags a 100% sell-tax honeypot, so this closes that
  gap. If honeypot.is is unreachable, the leg is REVIEW, never faked clean.
- **DexScreener liquidity cross-check** (free, no key). Telegraph's
  liquidity figure is compared against DexScreener's. If DexScreener shows
  no pairs or $0 while Telegraph shows a number, or the two disagree by
  more than 10x, the liquidity leg is downgraded to REVIEW as conflicting
  (the exact pool is confirmed on DexScreener before downgrading, so a
  real pool is not wrongly flagged). A cross-check can only downgrade
  clean to review, never upgrade.

## Verdict rules (honest by design)

- **REJECT** if sanctions matched, if wash trading is confirmed with a quoted
  wash percentage, if the security review says Insecure, or if the honeypot
  sell simulation fails / sell tax is 99% or more.
- **REVIEW** if any leg is inconclusive, missing, or thin — including a
  security review that says Secure but returns no vulnerability count or
  issues. A thin review is never a clean pass, and a token is never labelled
  LIST or HOLD on the audit leg alone.
- **LIST / HOLD** only if every leg is clean and typed.

## Execution integrity — how a run is proven

After the legs, the tool builds one canonical execution record (JSON): tool
version, chain, token, treasury, run sequence number, each leg's signal hash
and result, the derived verdict, total cost in testnet USDC, run timestamp
(UTC), and wallet address. The record is canonicalized (sorted keys,
deterministic JSON) and SHA-256 hashed. The hash is anchored on Sepolia with
a 0-value transaction from the same wallet to itself, carrying the 32-byte
hash as calldata. The anchor transaction hash, gas used, and block are
recorded in the report and the memo.

Runs are numbered in order — the counter lives in
`<out>/run-sequence.json` — so no run can be silently re-rolled. No anchor
is made if the run produced zero receipts (nothing to prove).

Verify any record with:

```sh
node verify.js results/preflight-<token>.json
```

The verifier (a) recomputes the canonical hash and checks it matches the
stored hash, (b) fetches the anchor transaction from Sepolia and checks its
calldata is exactly the record hash and the receipt succeeded, (c) re-fetches
each `signal_hash` from the Telegraph node and checks the result matches the
record, (d) re-runs the verdict rules on the re-fetched evidence and
confirms the verdict matches, and (e) re-checks the honeypot result against
honeypot.is. It prints PASS/FAIL per check and exits 0 only if every check
passes.

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
  --treasury 0x5598196977FB3b9D7E86Ca2495d9e3622A77F38C \
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
with every `signal_hash`, cost, duration, and receipt check. The memo shows
the execution record hash, the anchor transaction (with a Sepolia Etherscan
link), and the exact verify command.

## Live demo — run it yourself

The demo page ([docs/index.html](docs/index.html)) has a **Try it live**
section: enter any token address and chain, and it runs a real preflight
against the demo API — four paid Telegraph checks, the honeypot sell
simulation, the DexScreener cross-check — then shows the verdict, every
leg, the execution record hash, the Sepolia anchor transaction, and the
`verify.js` output. The two verified runs below stay on the page as the
record; the live section is for running your own.

The page talks to the demo API. The API base is one const at the top of
the page's script (`API_BASE`): it uses `http://localhost:3000` when the
page is served locally, and the Render service URL when it is served from
GitHub Pages. Change that one line when the Render URL is final.

Run the server locally:

```sh
npm install
TELEGRAPH_PRIVATE_KEY=0x... npm start   # serves the page + API on :3000
```

API endpoints:

- `POST /api/run` — `{ chain, token }`. Validates first (bad input → 400,
  $0 spent). With `Accept: text/event-stream` it streams live progress
  events (one per leg as it runs) and ends with a `result` event. With a
  plain JSON request it waits for the run and returns the same result
  directly. The result is the **full preflight report JSON** — with
  `execution.record`, `execution.record_hash`,
  `execution.anchor_tx_hash`, `decision.memo` / `decision.preflight`, and
  the `legs` (each with its signal hash, cost, and verdict) — plus a
  `verify` object `{ passed, output }` from `verify.js`. A few convenience
  aliases are also included at the top level (`runId`, `runSeq`,
  `recordHash`, `anchorTx`, `anchorBlock`, `totalCostUsd`, `runAt`). The
  page uses the stream; curl can use either.
- `GET /api/runs/:id` — one run (status, live progress lines, full result
  when done). Used if the stream drops.
- `GET /api/runs` — past runs, newest first (run number, token, chain,
  verdicts, record hash, anchor tx).
- `GET /api/health` — `{ ok: true }`.

Rate limits (in-memory): 1 run per visitor per 5 minutes, 20 runs total
per day, and one run at a time. A limited request gets 429 with a plain
message. The key is read only from `TELEGRAPH_PRIVATE_KEY` in the
environment — never from a file, never logged, never returned.

The demo runs with the dedicated **OneShot hackathon wallet**
(`0x5598196977FB3b9D7E86Ca2495d9e3622A77F38C`, Sepolia testnet only). A
hackathon gets its own wallet — this one is separate from the routine
farming wallet, which is never used for the demo. Runs #1–#7 anchored
from the farming wallet (already on-chain, cannot change); every demo run
from run #8 on anchors from the hackathon wallet. The key is set as the
`TELEGRAPH_PRIVATE_KEY` environment variable only, never in the repo and
never in a file.

Deploy:

- **API (Render):** `render.yaml` is a Blueprint for a free Node web
  service (`npm install`, `npm start`, health check `/api/health`). In the
  Render dashboard, connect the repo, create the Blueprint, then set
  `TELEGRAPH_PRIVATE_KEY` as an environment variable in the dashboard.
  The key is not in `render.yaml` and must never be committed.
- **Page (GitHub Pages):** repo Settings → Pages → Source: Deploy from a
  branch, branch `main`, folder `/docs`. The page then calls the Render
  API at the URL in `API_BASE`.

## Demo — two real runs

See [docs/index.html](docs/index.html). Both runs are on Sepolia testnet,
2026-11-16, $0.04 testnet USDC each, and both verify with `node verify.js`
(all 5 checks PASS). Both verdicts are REJECT — nothing was listed.

### Run #4 — USDC on Ethereum (REJECT / REJECT)

The wash-trading miner flagged the token: the USDC/USDT pool on the
"metric" DEX showed 81% wash volume ($148.76M of volume against $5.66M of
liquidity, buys and sells almost equal at 750 vs 828). Liquidity
($76,761,151.71) checked out against DexScreener (confirmed-by-pair: the
exact pool holds $76,845,014.35). Security review was thin, sanctions clean,
honeypot clean — but one rejecting leg rejects the run.

- Record hash: `0x9c22a405f542afc49d338d1ebb27dfb69a1b7bfa0fd2c639288d3bd0d367141b`
- Anchor tx: `0x37f969d37c9719a23c098c5bc78a7af287348a6c95cd46058241506302d36f15` (gas 14048, block 12148744)
- Verify: `node verify.js results/preflight-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.json` — PASS

### Run #5 — HNP (HoneyPot) on Ethereum (REJECT / REJECT)

The honeypot leg caught what no Telegraph intent flags: the sell simulation
fails ("revert: HP: BUY_FAILED") — the token cannot be proven sellable.
The liquidity miner returned $1,182,265,866.03 for a token the wash leg says
has no DEX market at all; both the consistency check and the DexScreener
cross-check flagged it, and the leg was downgraded to REVIEW.

- Record hash: `0x37a2c018e0e2a27cb9f887f42509afffac7f166a6e9172903c07cae6e6d744ed`
- Anchor tx: `0x8f0ab3d37892cf6d1abf42e09503ff50ec2e1a79014dac5221a00b46cb392d98` (gas 14048, block 12148753)
- Verify: `node verify.js results/preflight-0x52a7ed336eec9580bb9cc87e5bb8d5a35b844029.json` — PASS

## Cost

$0.01 testnet USDC per paid call. A 4-call run costs **$0.04**. Spend guards
in the code: no single payment over $0.10, no run over $0.10 total. All
payments are EIP-3009 authorisations on Sepolia, settled by the facilitator;
the `payTo` address is read from each 402 challenge, never hardcoded. The
anchor transaction costs Sepolia ETH gas (testnet, free) and does not count
toward the USDC spend cap.

## Known limitations

- The audit leg is thin when given only a bare contract address: the
  security-review miner scans the address string, not Solidity code. Pass
  contract source with `--source` for a real code review, and treat a
  missing `vulnerability_count` / `issues` as REVIEW, not as proof of safety.
- Legs are cross-checked: if the wash leg finds no DEX market for the token,
  a liquidity figure for that token is marked REVIEW, not clean — a
  plausible-looking miner number is not trusted blindly. See run #5 (HNP),
  where the liquidity miner returned $1,182,265,866.03 for a token with no
  market at all.
- The ask call's shaped result is sometimes lossy (fields come back null)
  while the signal — the receipt — carries the full miner response. The tool
  now records the signal's payload (canonicalized through the same
  normalization the ask layer uses) as the leg result, so the record holds
  the evidence that can be re-fetched and verified, not a lossy copy of it.
  The leg's `result_source` field says whether the result came from the
  signal or fell back to the ask response.
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
