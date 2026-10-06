---
name: review-agent-invoke-config
description: Gate 2 technical review support — verify a drafted invoke-config.js's (and scriptChecks.js's, if present) factual claims against the real source they cite, line by line, and record findings in REVIEW.md. Use when the user asks to "review <agent>'s invoke-config", "do Gate 2 review for <agent>", or similar.
---

# Review agent invoke-config (Gate 2 support)

Formalizes the verification pass done by hand for `discovery-map`'s
`invoke-config.js`: re-derive every factual claim the file makes about the
real agent's behavior, from the real source, rather than trusting the
file's own comments. Gate 2 asks *does this hand-built request/check
faithfully represent the agent's real runtime behavior* — this skill does
the checking; the Approved/Changes-requested verdict in `REVIEW.md` is
still whoever's doing Gate 2 for this agent to record, same as Gate 1's
verdict is the PM's own call (`review-agent-test-cases` handles that gate).

Covers **both** `invoke-config.js` and, if it exists, `scriptChecks.js` —
both are hand-written, agent-specific code making a fidelity claim (this
distinction only exists because `evaluator.js`'s `script_diff` dispatch was
itself found hardcoded to one agent's rubric keys during Discovery Map's
own Gate 2 review — see that file's header comment — so `scriptChecks.js`
now gets exactly the same scrutiny `invoke-config.js` already did, not a
lighter pass just because it's "just test logic").

## 1. Gather input

| Input | Required? | If not given |
|---|---|---|
| Agent name | **Yes** | Stop and ask. Must have an existing `test-suite/agents/<agent-name>/invoke-config.js` and `REVIEW.md`. |
| — `scriptChecks.js` | N/A | Include it in the review automatically if the file exists — don't ask whether to check it. |

## 2. Extract every checkable claim

Read `invoke-config.js` in full — its header comment and its body. List
every specific, falsifiable claim it makes: a system prompt's exact text,
a model name, a `maxTokens` value, a caller/tier name, a cited file+line
range, a described object shape, a ported function's behavior. Vague
claims ("this is DOM-coupled") aren't checkable the same way — focus on
ones with a concrete cited source.

## 3. Verify each claim against the real source, not the draft's own words

For each cited file+line range, actually read it — don't accept the
draft's paraphrase as ground truth. Confirm, specifically:
- System prompt / request-body text matches byte-for-byte where claimed
  exact, not just "close enough."
- Model/`maxTokens`/caller values match the real call site, and whether a
  claimed "hardcoded, not tier-resolved" (or vice versa) is actually true
  — both can be true simultaneously (hardcoded and happening to equal the
  tier lookup), so check the actual call site's arguments, not just the
  claim's plausibility.
- Any ported/hand-copied function (like a reconciliation helper) matches
  the real function's logic, including its edge cases, not just its happy
  path.
- Object shapes (e.g. a constructed input object) match what the real code
  actually builds, including defaults for optional fields.
- Any global/optional-read pattern (things the draft's `vm`-loading
  approach depends on) is still accurate — re-check for drift if the
  source file has changed since the draft was written.
- **If `scriptChecks.js` exists:** for every function it exports, actually
  run it against one deliberately-passing and one deliberately-failing mock
  `callResult`/`context` derived from that rubric's real test case(s) in
  `test-cases.json` — don't just read the code and judge it plausible. A
  handler that runs without throwing but never actually distinguishes a
  pass from a fail is a worse defect than a missing handler (evaluator.js
  will at least error loudly on a missing one).

## 4. Report findings, don't self-approve

Write results into `test-suite/agents/<agent-name>/REVIEW.md`'s Gate 2
section: check the four existing boxes only as each is actually confirmed,
list what was verified (with file:line citations) and anything that didn't
check out, in the Notes field. State a **recommended** verdict, but leave
the `Reviewer`/`Date`/`Verdict` fields for the actual Gate 2 reviewer to
fill in themselves — unless that person has explicitly told you to record
the approval on their behalf (as happened for `discovery-map`), don't check
the box yourself.

## 5. If a discrepancy is found

Don't just report it — if it's a clear, mechanical fix (a wrong cited line
number, a stale model default), propose the fix and apply it once
confirmed. If it's a real fidelity gap (the draft doesn't actually
represent real behavior), that's a Gate 2 "Changes requested" finding, not
something to paper over to get a passing review.
