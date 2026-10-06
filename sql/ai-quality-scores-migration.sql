-- Agent Test Execution Framework — mt_ai_quality_scores migration
-- Source: RA-Test-Execution-Spec.md v0.4, Section 5.
-- Run in Supabase SQL editor. DEV FIRST (pgt-dev), verify the step below,
-- THEN prod (pgt-prod). Per this project's convention: not run by Claude
-- Code, executed manually.
--
-- One row per (test_id, trace_id, metric) scored by test-suite/framework/
-- evaluator.js. agent_name is a plain column value, not a schema branch —
-- this table is shared across every agent onboarded to the framework
-- (test-suite/agents/<agent-name>/), not just Requirement Agent.

-- ═══════════════════════════════════════════════════════════════════
-- STEP 1 — mt_ai_quality_scores: one row per rubric scored per test run
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS mt_ai_quality_scores (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id         TEXT NOT NULL,              -- e.g. 'RA-G01'
  trace_id        UUID REFERENCES mt_ai_traces(trace_id) ON DELETE SET NULL,
  agent_name      TEXT NOT NULL,              -- 'requirement-agent' today
  category        TEXT NOT NULL,              -- 'groundedness','hallucination', etc.
  metric          TEXT NOT NULL,              -- e.g. 'faithfulness_score'
  score           NUMERIC,                    -- nullable — binary checks may use pass only
  pass            BOOLEAN NOT NULL,
  evaluator       TEXT NOT NULL,              -- 'script-diff' | 'llm-judge-claude' | 'ragas-faithfulness'
  run_id          UUID NOT NULL,              -- groups all scores from one runner invocation
  notes           JSONB,                      -- unsupported claims, violation details, etc.
  evaluated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quality_scores_run ON mt_ai_quality_scores(run_id);
CREATE INDEX IF NOT EXISTS idx_quality_scores_test ON mt_ai_quality_scores(test_id, evaluated_at);
CREATE INDEX IF NOT EXISTS idx_quality_scores_agent ON mt_ai_quality_scores(agent_name, evaluated_at);

-- Same posture as mt_ai_traces (sql/ai-cost-tower-trace-layer-migration.sql):
-- this table is written by the test harness's own service-role client
-- (test-suite/framework/run-tests.js), never by an authenticated end-user
-- session, and read by a future Quality Governance dashboard (not part of
-- this build) through its own service-side query. No anon/authenticated
-- access is needed.
ALTER TABLE mt_ai_quality_scores ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE mt_ai_quality_scores FROM anon, authenticated, PUBLIC;

-- Verify: expect one row describing mt_ai_quality_scores with 11 columns.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'mt_ai_quality_scores'
ORDER BY ordinal_position;
