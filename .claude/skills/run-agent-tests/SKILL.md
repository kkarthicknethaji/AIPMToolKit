---
name: run-agent-tests
description: Run an onboarded agent's test suite (node run-tests.js --agent <name>) from within Claude Code, resolving credentials automatically wherever possible instead of requiring the user to open a terminal. Use when the user asks to "run <agent>'s tests", "test <agent>", or similar.
---

# Run agent tests

Runs `test-suite/framework/run-tests.js` for a named, already-compiled
agent (`test-cases.json`/`rubrics.js` must already exist — see the
`compile-agent-test-suite` skill if they don't) — entirely through your
own tool calls, never by telling the caller to open a terminal or
PowerShell themselves. That friction is exactly what this skill exists to
remove.

## 1. Gather input

| Input | Required? | If not given |
|---|---|---|
| Agent name | **Yes** | Stop and ask. Must have `test-cases.json`/`rubrics.js` already in `test-suite/agents/<agent-name>/` — if not, say so and point at `compile-agent-test-suite` instead of proceeding. |
| `--only <ids>` / `--all` | No | Default: no flags — runs every `v1Scope: true` case, same as `run-tests.js`'s own default. |

## 2. Resolve credentials yourself — same three-way split as the generator

Read the agent's own `README.md` for its exact env var names
(`<AGENT>_TEST_AUTH_TOKEN`, `<AGENT>_TEST_COMPANY_ID`, etc.). For each
required var missing from the environment:

- `SUPABASE_URL`: already auto-resolved from `scripts/env.js` by
  `run-tests.js` itself (`readAppEnvJs.js`) — nothing to do.
- `<AGENT>_TEST_AUTH_TOKEN` / `<AGENT>_TEST_COMPANY_ID`: use the browser
  tool. Start the local app (`preview_start` with `static-site`/
  `proxy-dev`), check for an active session, and read the token/company id
  via the page's own JS (`authGetFreshToken()`,
  `localStorage.getItem('pgt_active_company_id')`) if one exists. If no
  session is active, ask the caller to sign in in the pane — never type
  credentials yourself — then continue once they confirm.
- `SUPABASE_SERVICE_ROLE_KEY` (optional for `run-tests.js` — without it,
  results print to console only and aren't persisted to
  `mt_ai_quality_scores`): ask the caller directly if they want results
  persisted; otherwise proceed without it and say so plainly in the report
  rather than silently dropping persistence.
- The proxy itself must actually be running and configured with real
  credentials to get genuine model responses (`ANTHROPIC_API_KEY` plus the
  two Supabase vars above, server-side) — check `preview_logs` after
  starting it; if it reports `Auth: JWT verification DISABLED` or a
  missing API key, that call will fail downstream regardless of the
  harness's own credentials. Surface that clearly rather than letting a
  confusing auth error look like a harness bug.

## 3. Run it yourself

```
cd test-suite/framework
node run-tests.js --agent <agent-name> [--only <ids>] [--all]
```

Never hand this command to the caller to run themselves — that defeats the
point of this skill.

## 4. Report back

**Always list every test id with its own PASS/FAIL/ERROR**, not just the
category summary — `run-tests.js`'s console output already prints one line
per test id as it runs (`[DM-F02] running... PASS`); include that full list
in the report, not just the aggregate counts. This is what lets the caller
cross-reference a specific row in `mt_ai_quality_scores` (keyed by
`test_id`) against what the run actually did, rather than a category count
they can't map back to individual rows.

Alongside that per-id list: the `run_id` if results were persisted (so the
caller can query `mt_ai_quality_scores` by it), any `ERROR` rows with their
message, and — for any failing case — its `recommendation`, if the console
output included one, rather than making the caller go query the database
themselves for something already in the console output.
