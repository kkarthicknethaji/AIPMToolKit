-- AI Cost Control Tower v2: Outcome-Based Cost — product_id backfill fix
-- Run in Supabase SQL editor. This has been applied to pgt-dev already via
-- Claude Code's proposed fix (verified against live data: outcome_id
-- f09d4864-... self-healed on next reuse). Run in prod when v2 is promoted
-- there — or skip prod entirely if promoting from the master migration file
-- (ai-cost-tower-outcomes-v2-migration.sql), which already has this fix
-- baked into mt_outcome_get_or_create_active from the start.
--
-- Root cause: requirement-agent.js's _raUsageExtraFields() hardcoded
-- session_type:'ChatCanvas' (the same sentinel value guided-launch.js
-- legitimately uses), causing the proxy to skip its real mt_sessions
-- product_id lookup on every Requirement Agent call. Fixed in
-- requirement-agent.js separately. This addendum fixes the downstream
-- consequence: any mt_outcomes row already created with a NULL product_id
-- while that bug was live would never self-correct, because the reuse
-- branch below never re-examined p_product_id once a row existed.
--
-- Safe to re-run (CREATE OR REPLACE). COALESCE only fills a NULL gap, never
-- overwrites a real value.

CREATE OR REPLACE FUNCTION mt_outcome_get_or_create_active(
  p_company_id       UUID,
  p_session_id       UUID,
  p_outcome_type_id  TEXT,
  p_product_id       UUID,
  p_user_id          UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_outcome_id UUID;
  v_window_hrs INTEGER;
BEGIN
  SELECT abandonment_window_hrs INTO v_window_hrs
  FROM mt_outcome_types WHERE outcome_type_id = p_outcome_type_id;

  -- Reuse only if in_progress AND still within its abandonment window —
  -- Section 2.5's "decided, not left open" rule: a stale instance is never
  -- silently resumed, a fresh one starts instead.
  SELECT o.outcome_id INTO v_outcome_id
  FROM mt_outcomes o
  WHERE o.session_id = p_session_id
    AND o.outcome_type_id = p_outcome_type_id
    AND o.status = 'in_progress'
    AND now() - o.last_activity_at <= (v_window_hrs || ' hours')::interval
  ORDER BY o.started_at DESC
  LIMIT 1;

  IF v_outcome_id IS NOT NULL THEN
    -- Opportunistic backfill, matching this project's own established
    -- pattern (_checkBudgetAlertsOpportunistic() in server.js — piggyback a
    -- correction onto an existing write path rather than invent a sweep
    -- job, since this app has no cron infrastructure). Generically protects
    -- all five Journey types sharing this function, not just the one
    -- caller that surfaced the gap.
    UPDATE mt_outcomes
    SET last_activity_at = now(),
        product_id = COALESCE(product_id, p_product_id)
    WHERE outcome_id = v_outcome_id;
    RETURN v_outcome_id;
  END IF;

  INSERT INTO mt_outcomes (outcome_type_id, company_id, product_id, session_id, user_id)
  VALUES (p_outcome_type_id, p_company_id, p_product_id, p_session_id, p_user_id)
  RETURNING outcome_id INTO v_outcome_id;

  RETURN v_outcome_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION mt_outcome_get_or_create_active(UUID, UUID, TEXT, UUID, UUID) FROM PUBLIC, anon, authenticated;
