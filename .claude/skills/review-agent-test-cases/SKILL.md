---
name: review-agent-test-cases
description: Gate 1 product-review support — check a drafted <Agent>-Test-Cases.md/<Agent>-Rubrics.md for citation accuracy, rubric-code collisions, and threshold reasoning, surfacing exactly the decisions that need the PM's own product judgment rather than deciding them. Use when the user asks to "review <agent>'s test cases", "do Gate 1 review for <agent>", or wants help deciding on a drafted test suite.
---

# Review agent test cases (Gate 1 support)

Gate 1 asks *does each test case reflect a real behavior worth checking,
and is each threshold right for the risk involved* — a product judgment
call the PM makes, not something this skill can make on their behalf (that
was the whole reason `Phase1-Generator-Addendum.md` split Gate 1 from Gate
2 in the first place: conflating a technical check with a product
decision risks the product decision getting silently waved through). This
skill does the diligence a PM shouldn't have to do by hand — citation
checking, collision detection, surfacing exactly which cases carry a real
open policy question — and hands back a clear recommendation, never an
auto-approval.

## 1. Gather input

| Input | Required? | If not given |
|---|---|---|
| Agent name | **Yes** | Stop and ask. Must have an existing `test-suite/agents/<agent-name>/{<Agent>-Test-Cases.md, <Agent>-Rubrics.md, REVIEW.md}`. |

## 2. Verify every "Rule source" citation against real code

For each test case's cited file+line range, read it and confirm the prompt
text/rule actually says what the test case claims — don't accept the
draft's paraphrase. Flag any citation that's wrong, stale, or reads the
source more strictly/loosely than it actually is.

## 3. Check for rubric-code collisions across every other onboarded agent

Read every other agent's `*-Rubrics.md` (not just the newest one). A
rubric letter reused with a genuinely different meaning than an existing
agent's is a real collision worth catching before it reaches
`rubrics.js` — this already happened once in a generator dry run (a "B"
meaning "Behavioral consistency" colliding with Requirement Agent's "B"
meaning "Bias/fairness").

## 4. Surface exactly which cases need an explicit PM policy call

Some findings are mechanical (a citation is right or wrong). Others are
genuinely a product judgment — e.g. whether a prompt's lack of an honesty/
uncertainty disclaimer is an accepted design tradeoff or a real gap worth
flagging upstream to whoever owns the prompt. **Present these as a clear
decision with a recommendation and the reasoning behind it, not as an
already-settled fact** — the PM's actual call is what Gate 1 exists for.
For each such case, separate two things that are easy to conflate: (a)
should *this test harness* score the case as a real pass/fail, and (b) is
the underlying prompt/product behavior itself worth changing (which, if
so, is a follow-up for whoever owns that source file, out of this
harness's own scope — same posture as Requirement Agent's RA-P02 finding).

## 5. Report findings, don't self-approve

Write findings into `test-suite/agents/<agent-name>/REVIEW.md`'s Gate 1
section — check the mechanical boxes only as confirmed, and put the
citation-accuracy and collision-check results, plus every policy-call
item from step 4, in the Notes field. State a recommended verdict, but
leave `Reviewer`/`Date`/`Verdict` for the PM to fill in themselves — never
check that box on their behalf, even if every finding looks clean, unless
they've explicitly told you to record their approval for them.
