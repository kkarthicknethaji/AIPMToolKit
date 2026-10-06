-- ═══════════════════════════════════════════════════════════════════
-- AI Cost Control Tower: selection_rule_valid constraint fix
-- Run in Supabase SQL editor. Both dev (pgt-dev) and prod — the v1.1
-- governance migration is already applied to both.
-- Per AI_EDITING_RULES.md: NOT run by Claude Code. Write to disk only:
-- Nethaji runs this against Supabase on his own timeline.
--
-- Purpose: found via live testing of v1.1 manual governance enforcement.
-- mt_ai_usage_events.selection_rule has a CHECK constraint
-- (selection_rule_valid) that predates this feature and was never updated
-- to allow the new 'governance_restricted' value proxy/server.js now
-- writes when an admin's Restrict-to-Economical-Tier action substitutes a
-- call's model. Every governance-restricted call currently fails its
-- mt_ai_usage_events insert with:
--   new row for relation "mt_ai_usage_events" violates check
--   constraint "selection_rule_valid"
-- The AI call itself still succeeds (_insertAiUsageEvent() never throws
-- outward), but the call is silently missing from spend totals and
-- Selection Economics until this constraint is widened.
--
-- Confirmed via direct introspection against the live database
-- (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname =
-- 'selection_rule_valid') rather than assumed — the existing 5 values
-- below are the verified current list, not a guess. This migration adds
-- exactly one new value; nothing else changes.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE mt_ai_usage_events
  DROP CONSTRAINT IF EXISTS selection_rule_valid;

ALTER TABLE mt_ai_usage_events
  ADD CONSTRAINT selection_rule_valid
  CHECK (selection_rule = ANY (ARRAY[
    'optimized_caller_default'::text,
    'optimized_fallback_default'::text,
    'user_selected_model'::text,
    'batch_threshold_override'::text,
    'explicit_override_unclassified'::text,
    'governance_restricted'::text
  ]));

-- ─── Verification ────────────────────────────────────────────────────
-- 1. Confirm the constraint now includes the new value:
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'selection_rule_valid';
--
-- 2. Re-trigger a governed AI call (Restrict to Economical Tier still
--    active) and confirm the insert no longer fails in the proxy logs,
--    then confirm the row exists:
-- SELECT selection_rule, requested_model, response_model, request_started_at
-- FROM mt_ai_usage_events
-- WHERE company_id = '<your company id>' AND selection_rule = 'governance_restricted'
-- ORDER BY request_started_at DESC LIMIT 5;
