-- Agent Test Execution Framework — add a `recommendation` column to
-- mt_ai_quality_scores. Run in Supabase SQL editor. DEV FIRST (pgt-dev),
-- verify the step below, THEN prod. Per this project's convention: not run
-- by Claude Code, executed manually.
--
-- One human-readable, actionable next-step string per scored row, so a
-- reviewer has a single column to check across every FAILING case
-- regardless of which evaluator produced the failure:
--   - LLM-judge rubrics (G, H, A3, B, S, N, L, T, X, O): the judge model
--     itself generates this, in the same call that produces the score —
--     a suggested starting point for investigation, not a verified fix.
--   - script-diff rubrics (F, A1, A2, P1): the evaluator deterministically
--     turns its own violation finding into one readable sentence — no
--     model call, same data it already computed.
-- NULL when the case passes.

ALTER TABLE mt_ai_quality_scores ADD COLUMN IF NOT EXISTS recommendation TEXT;

-- Verify: expect the new column listed.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'mt_ai_quality_scores'
ORDER BY ordinal_position;
