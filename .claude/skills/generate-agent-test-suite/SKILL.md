---
name: generate-agent-test-suite
description: Draft a new agent's Agent Test Execution Framework test suite (<Agent>-Test-Cases.md, <Agent>-Rubrics.md, invoke-config.js, README.md, REVIEW.md) from its real source code, and smoke-test the draft. Use when the user asks to "run the generator", "onboard <agent> to the test framework", "generate/draft test cases for <agent>", or similar. Full rules: test-suite/framework/generator/GENERATOR-PROMPT.md.
---

# Generate agent test suite

Thin invocation wrapper around `test-suite/framework/generator/
GENERATOR-PROMPT.md` (Phase 1 of the Agent Test Execution Framework's test
suite generator — see `RA-Test-Execution-Spec.md` Section 12 for the
design decisions behind it). Read that file for the full rules before
drafting anything; this skill only exists so invoking it is as simple as
"run this generator using `<source files>`" — everything else is
`GENERATOR-PROMPT.md`'s job to resolve, not something to ask the caller.

## 1. Gather inputs

| Input | Required? | If not given |
|---|---|---|
| Agent's real source code | **Yes** | Stop and ask for it. This generator does not run on a description alone — see `GENERATOR-PROMPT.md`'s "The only required input". |
| PRD / feature description | No | Proceed source-only; confidence labeling reflects this automatically (see below) — do not ask whether one exists. |
| Explicit agent name | No | Derive a kebab-case name from the source itself (product-facing display name, dominant function-name prefix, comments). Only ask if the source gives no usable name at all. |

**Source code is the one truly required input.** Everything else is
resolved automatically per `GENERATOR-PROMPT.md`'s "Resolving inputs
automatically" section — do not turn this into a multi-question intake.

## 2. Read the source

Read every file given. Note, specifically: the real request/response
shape and endpoint the agent calls through, whether its core logic is
headlessly callable or coupled to something a Node script can't reach (DOM,
browser storage, a framework runtime), the exact JSON/field-name contract
it actually speaks (not an assumption from a similar agent), and any
literal formatting rules, forbidden placeholders, or validation the source
enforces — these are exactly the kind of thing a generator run against
Requirement Agent's own source surfaced that a hand-written approximation
had missed (field name `body` vs `content`, a capped `clarifyingQuestions`
shape, literal bullet-prefix rules) — read for these, don't assume the new
agent's contract resembles another agent's.

## 3. Draft the five files

Into `test-suite/agents/<agent-name>/` — never into another agent's
existing folder. Follow `GENERATOR-PROMPT.md`'s "What the generator
produces" and "Confidence labeling" sections exactly, including the
rubric-code collision check (read every other agent's `*-Rubrics.md` table
first) before assigning a new rubric letter, and copying
`generator/REVIEW-CHECKLIST.md` to this folder as `REVIEW.md` yourself —
that copy is part of drafting, not a step to leave for the caller.

## 4. Run the smoke test yourself

```
node test-suite/framework/generator/smoke-test.js --agent <agent-name>
```

Do this before declaring the draft done — don't hand it back as a
follow-up step. If required env vars are missing, **resolve what you can
before asking the caller for anything** — see `GENERATOR-PROMPT.md`'s
"Resolve missing credentials before giving up" for the three-way split:

- `SUPABASE_URL` is already auto-resolved from `scripts/env.js` — nothing
  to do.
- A missing `<AGENT>_TEST_AUTH_TOKEN`/`<AGENT>_TEST_COMPANY_ID`: open the
  app yourself with the browser tool (`preview_start` with the
  `static-site`/`proxy-dev` launch configs), check for an active session,
  and read the token/company id via the page's own JS if one exists. If no
  session is active, ask the caller to sign in in the pane (never type
  credentials yourself), then continue once they confirm.
- A missing `SUPABASE_SERVICE_ROLE_KEY`: nothing to automate — this repo
  has no local copy of it anywhere. Ask the caller for it directly, named
  specifically, rather than treating it like the other two.

If it fails for a fixable reason after that, fix and rerun once; if it
still fails, report the failure plainly rather than claiming the draft is
ready.

## 5. Report back

State plainly: what was written and where (all five files, including
`REVIEW.md`), the agent name used (and why, if derived rather than given),
the confidence level applied and why, and the smoke-test result. Close by
pointing at the drafted `REVIEW.md` for the next step — Gate 1 (PM) and
Gate 2 (engineer) review, both independently required, per
`GENERATOR-PROMPT.md`. This skill never runs `run-tests.js` and never
marks either gate as passed — that's still a human call.
