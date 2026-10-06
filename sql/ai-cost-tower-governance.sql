-- ═══════════════════════════════════════════════════════════════════
-- AI Cost Control Tower: v1.1 manual governance enforcement
-- Run in Supabase SQL editor. DEV FIRST (pgt-dev), verify, then prod.
-- Per AI_EDITING_RULES.md: NOT run by Claude Code. Write to disk only:
-- Nethaji runs this against Supabase on his own timeline.
-- Idempotent (ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE FUNCTION):
-- safe to re-run.
--
-- Purpose: makes v1's two disabled "Restrict to Economical Tier"/"Stop
-- AI Usage" Budget Configuration options live. Auto-revert to "Notify
-- Only" at the start of the next monthly period needs an anchor to
-- measure "has a month passed" against — mt_ai_budgets has no column
-- recording when action_on_breach was last set, so one nullable column
-- is added here. mt_ai_budget_upsert() is replaced to stamp it on every
-- save.
--
-- Second file for this same change: sql/ai-cost-tower-prod-migration.sql
-- is updated in place with the identical column/function change, since
-- that consolidated file has not been run against prod yet — this file
-- is the dev-incremental delta only, matching the two-track pattern
-- already used for this feature area (ai-cost-tower-build-b-addendum.sql,
-- ai-cost-tower-cache-cost-fix.sql).
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE mt_ai_budgets
  ADD COLUMN IF NOT EXISTS action_on_breach_set_at TIMESTAMPTZ;

-- Every pre-existing row today has action_on_breach = 'notify' (the
-- dropdown was hardcoded to it until this ships), so this migration
-- should not create any row with a non-'notify' value and a NULL
-- timestamp in practice. The proxy-side read logic (proxy/server.js's
-- _checkGovernanceState()) still defends against that combination
-- explicitly rather than assuming it can't happen — a NULL timestamp
-- paired with a non-'notify' value is treated as already-expired, not
-- as "never expires." Silently enforcing a restriction forever because
-- its clock was missing is a worse failure than silently not enforcing
-- one.

-- mt_ai_budget_upsert() replaced to stamp action_on_breach_set_at = now()
-- on every save. Every save of this form is a deliberate admin action on
-- the governance state, so every save gets a fresh timestamp — there is
-- no "the dropdown didn't actually change" special case to carve out
-- here; re-selecting the same value and saving again is itself a
-- legitimate admin action worth restamping (e.g. "yes, still restricted,
-- I'm confirming that on the 28th").
CREATE OR REPLACE FUNCTION mt_ai_budget_upsert(
  p_company_id             UUID,
  p_amount                 NUMERIC,
  p_currency               TEXT,
  p_warn_threshold_pct     NUMERIC,
  p_escalate_threshold_pct NUMERIC,
  p_enforcement_mode       TEXT,
  p_action_on_breach       TEXT
)
RETURNS mt_ai_budgets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller UUID := current_app_user();
  v_row    mt_ai_budgets;
BEGIN
  IF NOT _cost_tower_is_admin(p_company_id) THEN
    RAISE EXCEPTION 'Not authorized to configure budgets for company %', p_company_id;
  END IF;

  UPDATE mt_ai_budgets
  SET amount = p_amount,
      currency = p_currency,
      warn_threshold_pct = p_warn_threshold_pct,
      escalate_threshold_pct = p_escalate_threshold_pct,
      enforcement_mode = p_enforcement_mode,
      action_on_breach = p_action_on_breach,
      action_on_breach_set_at = now()
  WHERE company_id = p_company_id AND scope_type = 'overall' AND is_active
  RETURNING * INTO v_row;

  IF v_row IS NULL THEN
    INSERT INTO mt_ai_budgets (
      company_id, scope_type, amount, currency,
      warn_threshold_pct, escalate_threshold_pct,
      enforcement_mode, action_on_breach, action_on_breach_set_at, created_by
    ) VALUES (
      p_company_id, 'overall', p_amount, p_currency,
      p_warn_threshold_pct, p_escalate_threshold_pct,
      p_enforcement_mode, p_action_on_breach, now(), v_caller
    )
    RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION mt_ai_budget_upsert(UUID, NUMERIC, TEXT, NUMERIC, NUMERIC, TEXT, TEXT) TO authenticated;

-- ─── Verification ────────────────────────────────────────────────────
-- 1. Column exists:
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'mt_ai_budgets' AND column_name = 'action_on_breach_set_at';
--
-- 2. Saving a budget via mt_ai_budget_upsert stamps action_on_breach_set_at:
-- SELECT action_on_breach, action_on_breach_set_at FROM mt_ai_budgets
-- WHERE company_id = '<test company>' AND is_active;
