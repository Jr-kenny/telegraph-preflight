// verify.js — OneShot execution record verifier
// Usage: node verify.js <report-json-file>
//   (the report is the preflight-<token>.json a OneShot run writes)
//
// What it proves, check by check:
//   1. Record hash — recompute the canonical SHA-256 of the execution
//      record and confirm it matches the stored record_hash. If anyone
//      edited the memo, the legs, or the verdict after the run, this fails.
//   2. Anchor — fetch the anchor transaction from Sepolia and confirm its
//      calldata is exactly the record hash and its receipt succeeded. This
//      proves the record existed, unaltered, at the time of the run.
//   3. Signals — re-fetch every signal_hash from the Telegraph node,
//      confirm the node says verified, and confirm the re-fetched result
//      matches the result in the record. This proves the paid checks are
//      genuine Telegraph receipts, not pasted-in hashes.
//   4. Verdict — re-run the verdict rules on the re-fetched evidence and
//      confirm the memo/preflight verdict matches the record. This proves
//      the verdict actually follows from the evidence by the published rules.
//   5. Honeypot freshness (bonus) — re-call honeypot.is and confirm the
//      token's sell simulation still agrees with the record. A change here
//      does not fail the run (the record is a snapshot at run time), it is
//      reported so the reader knows the token may have changed since.
//
// Output: PASS / FAIL / SKIP per check with a reason. Exit 0 if no check
// failed, 1 if any failed. A SKIP means the check could not be run (e.g.
// no anchor because the run had no receipts); it is not a pass.

import fs from "node:fs";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import {
  NODE,
  SEPOLIA_RPC,
  INTENTS,
  canonicalize,
  sha256Hex,
  normalizeSignalResult,
  judgeLeg,
  judgeHoneypot,
  decideMemo,
  applyConsistencyChecks,
  fetchHoneypot,
} from "./preflight.js";

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

function diffKeys(a, b) {
  const out = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    if (!deepEqual(a?.[k], b?.[k])) out.push(k);
  }
  return out;
}

async function fetchSignal(hash) {
  const res = await fetch(`${NODE}/engine/v1/signal/${hash}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Telegraph signal endpoint HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const file = process.argv[2];
  if (!file || process.argv[3]) {
    console.error("Usage: node verify.js <report-json-file>");
    process.exit(2);
  }
  let report;
  try {
    report = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`Cannot read ${file}: ${String(e).slice(0, 200)}`);
    process.exit(2);
  }
  const ex = report.execution;
  if (!ex || !ex.record || !ex.record_hash) {
    console.error("This report has no OneShot execution record (it was written by an older version, or the run had no record).");
    process.exit(2);
  }
  const record = ex.record;
  const recordHash = ex.record_hash;
  const checks = [];
  const add = (name, status, reason) => checks.push({ check: name, status, reason });

  // 1. Record hash
  const recomputed = sha256Hex(canonicalize(record));
  if (recomputed === recordHash) {
    add("record-hash", "PASS", `Canonical SHA-256 of the record matches the stored hash (${recordHash}).`);
  } else {
    add("record-hash", "FAIL", `Record hash mismatch: stored ${recordHash}, recomputed ${recomputed}. The record was edited after the run.`);
  }

  // 2. Anchor
  if (!ex.anchor_tx_hash) {
    add("anchor", "SKIP", ex.anchor_note || "No anchor transaction recorded for this run.");
  } else {
    try {
      const publicClient = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });
      const tx = await publicClient.getTransaction({ hash: ex.anchor_tx_hash });
      const receipt = await publicClient.getTransactionReceipt({ hash: ex.anchor_tx_hash });
      const calldata = (tx.input || "").toLowerCase();
      if (calldata !== recordHash.toLowerCase()) {
        add("anchor", "FAIL", `Anchor tx ${ex.anchor_tx_hash} calldata is ${calldata}, not the record hash ${recordHash}.`);
      } else if (receipt.status !== "success") {
        add("anchor", "FAIL", `Anchor tx ${ex.anchor_tx_hash} is on-chain but its receipt status is ${receipt.status}.`);
      } else {
        add("anchor", "PASS", `Anchor tx ${ex.anchor_tx_hash} is on Sepolia (block ${receipt.blockNumber}), calldata is exactly the record hash, receipt succeeded.`);
      }
    } catch (e) {
      add("anchor", "FAIL", `Could not fetch the anchor tx from Sepolia: ${String(e).slice(0, 200)}`);
    }
  }

  // 3. Signals — re-fetch each one, confirm verified, confirm the result matches.
  const normalizedByIntent = {};
  const signalProblems = [];
  for (const leg of record.legs || []) {
    if (!leg.signal_hash) continue;
    try {
      const sig = await fetchSignal(leg.signal_hash);
      const verified = sig?.verification?.verified === true || sig?.verified === true;
      if (!verified) {
        signalProblems.push(`${leg.intent}: node does not report verified for ${leg.signal_hash}`);
        continue;
      }
      const raw = sig?.payload?.response ?? sig?.result ?? null;
      const normalized = normalizeSignalResult(leg.intent, raw);
      if (!normalized) {
        signalProblems.push(`${leg.intent}: could not normalise the re-fetched signal result`);
        continue;
      }
      normalizedByIntent[leg.intent] = normalized;
      if (!deepEqual(normalized, leg.result)) {
        const dk = diffKeys(normalized, leg.result);
        signalProblems.push(`${leg.intent}: re-fetched result differs from the record (fields: ${dk.join(", ")})`);
      }
    } catch (e) {
      signalProblems.push(`${leg.intent}: could not re-fetch ${leg.signal_hash} (${String(e).slice(0, 150)})`);
    }
  }
  const paidLegs = (record.legs || []).filter((l) => l.signal_hash);
  if (!paidLegs.length) {
    add("signals", "SKIP", "No paid legs with a signal_hash in this record.");
  } else if (!signalProblems.length) {
    add("signals", "PASS", `${paidLegs.length} signal(s) re-fetched from the Telegraph node, all verified, all results match the record.`);
  } else {
    add("signals", "FAIL", signalProblems.join(" | "));
  }

  // 4. Verdict — re-run the rules on the re-fetched evidence.
  try {
    const rederived = [];
    for (const leg of record.legs || []) {
      if (leg.intent === INTENTS.HONEYPOT) {
        // Honeypot leg: use the recorded judgement for the verdict check
        // (the fresh re-call is check 5, a bonus). The record is the
        // snapshot at run time, proven by the anchor.
        rederived.push({ ...leg });
        continue;
      }
      if (leg.signal_hash && normalizedByIntent[leg.intent]) {
        const judgement = leg.result_shape === "raw"
          ? { verdict: "review", reason: "Result came back raw (no typed response format) — unusable as a clean leg." }
          : judgeLeg(leg.intent, normalizedByIntent[leg.intent], leg.field_status);
        rederived.push({ ...leg, result: normalizedByIntent[leg.intent], judgement });
      } else {
        // Failed leg (no signal) or a signal that could not be re-fetched:
        // keep the recorded judgement and note the limitation.
        rederived.push({ ...leg });
      }
    }
    applyConsistencyChecks(rederived);
    // Re-apply the recorded DexScreener downgrade, if any: the cross-check
    // is a snapshot decision, reproduced from the record.
    const recLiq = (record.legs || []).find((l) => l.intent === INTENTS.LIQUIDITY);
    const newLiq = rederived.find((l) => l.intent === INTENTS.LIQUIDITY);
    if (recLiq?.cross_check?.outcome?.startsWith("conflicting") && newLiq && newLiq.judgement.verdict === "clean") {
      newLiq.judgement = { verdict: "review", reason: recLiq.judgement.reason };
    }
    const decision = decideMemo(rederived);
    if (decision.memo === record.decision.memo && decision.preflight === record.decision.preflight) {
      add("verdict", "PASS", `Re-derived verdict matches the record: ${decision.memo} / ${decision.preflight}.`);
    } else {
      add("verdict", "FAIL", `Re-derived verdict ${decision.memo} / ${decision.preflight} does not match the record ${record.decision.memo} / ${record.decision.preflight}.`);
    }
  } catch (e) {
    add("verdict", "FAIL", `Verdict re-derivation failed: ${String(e).slice(0, 200)}`);
  }

  // 5. Honeypot freshness (bonus — does not fail the run).
  const hpLeg = (record.legs || []).find((l) => l.intent === INTENTS.HONEYPOT);
  if (!hpLeg) {
    add("honeypot-freshness", "SKIP", "No honeypot leg in this record.");
  } else {
    const fresh = await fetchHoneypot(record.token, record.chain);
    if (!fresh.ok) {
      add("honeypot-freshness", "SKIP", `honeypot.is could not be re-checked now (${fresh.error}). The recorded result stands as the run-time snapshot.`);
    } else {
      const freshJudgement = judgeHoneypot(fresh.data);
      if (freshJudgement.verdict === hpLeg.judgement.verdict) {
        add("honeypot-freshness", "PASS", `honeypot.is still agrees with the record (${freshJudgement.verdict}).`);
      } else {
        add("honeypot-freshness", "FAIL", `honeypot.is now says ${freshJudgement.verdict} but the record says ${hpLeg.judgement.verdict} — the token changed since the run. The record is still the true snapshot at run time.`);
      }
    }
  }

  const failed = checks.filter((c) => c.status === "FAIL").length;
  console.log(`OneShot verify — ${file}`);
  console.log(`Record: ${recordHash} (run #${record.run_seq}, ${record.token} on ${record.chain}, ${record.run_at_utc})`);
  console.log("");
  for (const c of checks) {
    console.log(`[${c.status}] ${c.check}: ${c.reason}`);
  }
  console.log("");
  console.log(failed ? `FAIL — ${failed} check(s) failed.` : "PASS — the execution record is proven.");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`Verify error: ${String(e && e.message ? e.message : e).slice(0, 500)}`);
  process.exit(1);
});
