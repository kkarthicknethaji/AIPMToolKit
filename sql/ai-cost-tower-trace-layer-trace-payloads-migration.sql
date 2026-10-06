-- AI Cost Control Tower: AI Trace Layer — mt_ai_trace_payloads (Part B.3)
-- Fresh design grounded in this repo's own live conventions (mt_ai_traces/
-- mt_ai_spans/traces.js) — the original spec's Part B.3 text was never
-- committed to this repo and wasn't available to re-derive against. Reviewed
-- and approved 2026-09-12, built as v9.33.02 (a missed item from v9.33.01's
-- own scope, not a new feature).
--
-- Run in Supabase SQL editor. DEV FIRST (pgt-dev), verify the result below,
-- THEN prod (pgt-prod). Per this project's convention: not run by Claude
-- Code, executed manually.
--
-- Deliberately excludes the purge mechanism (D.7 item 4) — expires_at is
-- populated at insert time (90-day default) so a future purge job has
-- something to act on immediately once it ships, but nothing in this
-- migration or in POST/GET /v1/trace-payloads ever reads or acts on it yet.
--
-- One row per usage event (1:1, mirrors mt_ai_spans.usage_event_id's own
-- UNIQUE FK) — only an llm_call span/usage event has a request/response to
-- capture. company_id/app_id are stored directly (not just reachable via a
-- join through usage_event_id back to mt_ai_usage_events) so a future
-- dashboard/debugging query can filter "payloads for company X" without a
-- join every time — same convention mt_ai_traces already follows.

-- ═══════════════════════════════════════════════════════════════════
-- STEP 1 — mt_ai_trace_payloads
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS mt_ai_trace_payloads (
  payload_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usage_event_id   UUID NOT NULL UNIQUE REFERENCES mt_ai_usage_events(id) ON DELETE CASCADE,
  company_id       UUID NOT NULL REFERENCES mt_companies(id) ON DELETE CASCADE,
  app_id           TEXT NOT NULL REFERENCES mt_apps(app_id),
  request_payload  JSONB,
  response_payload JSONB,
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT now() + interval '90 days',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Code-review fix: the route enforces "at least one of request_payload/
  -- response_payload" in JS, but nothing backed that invariant at the schema
  -- level — any other writer (a future route, an admin tool, a direct DB
  -- script) could otherwise silently insert a row that captures nothing.
  CONSTRAINT mt_ai_trace_payloads_at_least_one_payload
    CHECK (request_payload IS NOT NULL OR response_payload IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS mt_ai_trace_payloads_company_app_idx
  ON mt_ai_trace_payloads (company_id, app_id, created_at);

ALTER TABLE mt_ai_trace_payloads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE mt_ai_trace_payloads FROM anon, authenticated, PUBLIC;

-- ═══════════════════════════════════════════════════════════════════
-- STEP 2 — verify: table exists with 8 columns, the UNIQUE constraint on
-- usage_event_id, and the company/app index.
-- ═══════════════════════════════════════════════════════════════════

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'mt_ai_trace_payloads'
ORDER BY ordinal_position;

SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'mt_ai_trace_payloads'::regclass;

SELECT indexname FROM pg_indexes WHERE tablename = 'mt_ai_trace_payloads';

-- ═══════════════════════════════════════════════════════════════════
-- End of migration.
-- ═══════════════════════════════════════════════════════════════════
