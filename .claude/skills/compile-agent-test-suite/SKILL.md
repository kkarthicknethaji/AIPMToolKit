---
name: compile-agent-test-suite
description: Compile an approved agent's <Agent>-Test-Cases.md/<Agent>-Rubrics.md into the machine-readable test-cases.json/rubrics.js run-tests.js actually loads, after confirming both Gate 1 and Gate 2 passed in REVIEW.md. Use when the user asks to "compile <agent>'s test suite", "transcribe <agent>'s test cases", or says both gates are approved and wants to move to running tests.
---

# Compile agent test suite

Turns an approved draft (`test-suite/agents/<agent-name>/`, produced by the
`generate-agent-test-suite` skill) into the two files `run-tests.js` actually
loads: `test-cases.json` and `rubrics.js` — the "source" `.md` docs compiled
into the "executable" config the runner reads. This is the "hand-transcribe"
step `GENERATOR-PROMPT.md`'s workflow names — automated here, but never
skipping the gate check that makes it safe to automate. Not the last step in
the process — `run-agent-tests` (which you'll come back to repeatedly) is.

## 1. Gather input

| Input | Required? | If not given |
|---|---|---|
| Agent name | **Yes** | Stop and ask. Must match an existing `test-suite/agents/<agent-name>/` folder. |

## 2. Refuse if either gate isn't approved — this is the one hard gate

Read `test-suite/agents/<agent-name>/REVIEW.md`. Both the Gate 1 and Gate 2
`Verdict:` lines must show `[x] Approved`. If either is unchecked or marked
"Changes requested", **stop and say exactly which gate is still pending** —
do not compile partially-approved content, and do not ask the caller to
override this. This check exists specifically so compiling can be
automated without also automating past the two-gate discipline
`GENERATOR-PROMPT.md` and `Phase1-Generator-Addendum.md` require.

## 3. Compile `<Agent>-Test-Cases.md` → `test-cases.json`

One entry per test case, in the shape `requirement-agent/test-cases.json`
already establishes: `testId`, `category`, `rubric`, `v1Scope`,
`executionMode`, `setup`/`probe` (or `conversationA`/`conversationB` for
`dual-conversation` mode), `judgeContext`, `expectedBehaviorNote`,
`failureModeNote`, plus any case-specific fields the source `.md` names
(`fixtureDependency`, `deferredReason`, etc.).

**The one detail that actually requires judgment, not just copying text:**
`probe`/`setup` steps are passed to `invoke.sendMessage(state, action)`
*unmodified* — their shape must match **this agent's own** `action`
contract (read `invoke-config.js` to confirm it, don't assume it looks like
RA's `{content, attachedDocument}`). For Discovery Map, that means
`{mode: 'tree'|'tree-manual'|'dd'|'leak', ...}`, built from whatever
concrete setup each test case's prose describes.

Wrap the array in the same top-level shape RA's file uses: `agentName`,
`schemaVersion`, `sourceDoc`, `totalCases`, `v1ActiveCount`, `note`.

## 4. Compile `<Agent>-Rubrics.md` → `rubrics.js`

`module.exports` keyed by rubric letter, each `{metric, scale,
evaluatorType, threshold, judgePromptTemplate}` for `llm_judge`/
`toxicity_scan` rubrics (write the judge prompt as a `{{placeholder}}`
template filled from `judgeContext/output`, same convention as RA's), or
just `{metric, scale, evaluatorType: 'script_diff', threshold}` for
deterministic ones — `evaluator.js`'s script-diff dispatch is generic
(dispatches to whatever a `scriptChecks.js` exports), no framework code
changes for a new agent's deterministic rubric, but **that agent still
needs its own `scriptChecks.js`** with a real function per `script_diff`
key. If it's missing or incomplete, don't silently compile around the gap
— check for it explicitly (step 4a below).

## 4a. Check for a required `scriptChecks.js` before declaring compiled

If any rubric compiled in step 4 has `evaluatorType: 'script_diff'`,
confirm `test-suite/agents/<agent-name>/scriptChecks.js` exists and exports
a function for every such rubric key — `run(node -e "console.log(Object.keys(require('./scriptChecks.js')))")`
and diff against the rubric letters that need one. If it's missing
entirely, or missing a key, **say so plainly as a real blocker, not a minor
note** — this exact gap (a fully-specified `script_diff` rubric with no
matching handler, compiled and reported as done anyway) already happened
once for Discovery Map and required a separate framework fix
(`evaluator.js`'s dispatch was also hardcoded to one agent's keys — see
that file's header comment). Writing the actual handler functions is real
work belonging to Gate 2 review (`review-agent-invoke-config` now covers
`scriptChecks.js` too), not something to wave through here.

## 5. Sanity-check before declaring done

```
node -e "const t=require('./test-cases.json'); console.log(t.testCases.length, 'cases loaded')"
node -c rubrics.js
node -c scriptChecks.js
```

All that apply must succeed. If any fails, fix and recheck — don't report
"compiled" on a file that doesn't even parse.

## 6. Report back

State what was written (`test-cases.json`'s case count, `rubrics.js`'s
rubric letters), and that the natural next step is running them — point at
the `run-agent-tests` skill rather than telling the caller to open a
terminal themselves.
