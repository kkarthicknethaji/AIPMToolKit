-- ═══════════════════════════════════════════════════════════════════
-- DEV-ONLY CORRECTION -- run this on pgt-dev only, NOT prod.
-- Prod has never run the multi-app migration yet, so its tracked copy
-- (sql/ai-cost-tower-multi-app-migration.sql) already has this feature
-- baked in and needs no separate correction.
--
-- New feature: AI Governance (Budget Configuration, Alerts, Opportunity
-- Matrix) is now admin+power-user only -- read-only members can still see
-- Overview/Cost Breakdown/Outcome-Based Cost (unaffected, no role check
-- there) but not AI Governance. This script:
--   1. Creates _cost_tower_can_manage_governance(company_id, app_id) --
--      composes _cost_tower_can_access (membership + app-grant check) plus
--      an explicit role IN ('admin', 'member') allow-list.
--   2. Points the 4 governance-specific RPCs at it (CREATE OR REPLACE,
--      idempotent): mt_ai_alerts_list, mt_ai_budget_upsert,
--      mt_ai_alert_acknowledge, mt_ai_alert_dismiss.
--      For the full canonical list of which RPCs use this helper vs.
--      _cost_tower_can_access, and why, see the comment above this same
--      function in sql/ai-cost-tower-multi-app-migration.sql -- not
--      repeated here to avoid the two drifting out of sync.
--
-- No CREATE TABLE / ALTER TABLE anywhere in this file -- safe to run as
-- one script even though every table this touches already exists on dev.
-- All statements below are safe to re-run (CREATE OR REPLACE is
-- idempotent; there is no DROP FUNCTION in this file at all).
-- ═══════════════════════════════════════════════════════════════════

-- 1 -- the new governance-only authorization check
CREATE OR REPLACE FUNCTION public._cost_tower_can_manage_governance(p_company_id uuid, p_app_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT _cost_tower_can_access(p_company_id, p_app_id)
  AND EXISTS (
    SELECT 1 FROM mt_users_companies uc
    WHERE uc.company_id = p_company_id
      AND uc.user_id = current_app_user()
      AND uc.is_active
      AND uc.role IN ('admin', 'member')
  );
$function$;

REVOKE EXECUTE ON FUNCTION public._cost_tower_can_manage_governance(uuid, text) FROM PUBLIC, anon, authenticated;

-- 2 -- mt_ai_alerts_list
CREATE OR REPLACE FUNCTION public.mt_ai_alerts_list(p_company_id uuid, p_app_id text)
 RETURNS SETOF mt_ai_alerts
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT a.* FROM mt_ai_alerts a
  JOIN mt_ai_budgets b ON b.budget_id = a.budget_id
  WHERE b.company_id = p_company_id
    AND b.app_id = p_app_id
    AND _cost_tower_can_manage_governance(p_company_id, p_app_id)
    AND a.status != 'dismissed'
    AND a.period_start >= (date_trunc('month', now() AT TIME ZONE 'UTC') - INTERVAL '1 month')::date
  ORDER BY a.created_at DESC;
$function$;

-- 3 -- mt_ai_budget_upsert
-- (mt_ai_budget_get_active is deliberately untouched -- see header comment.
-- It stays exactly as already deployed on dev, no CREATE OR REPLACE needed.)
CREATE OR REPLACE FUNCTION public.mt_ai_budget_upsert(
  p_company_id uuid, p_app_id text, p_amount numeric, p_currency text,
  p_warn_threshold_pct numeric, p_escalate_threshold_pct numeric,
  p_enforcement_mode text, p_action_on_breach text
)
 RETURNS mt_ai_budgets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_caller UUID := current_app_user();
  v_row    mt_ai_budgets;
BEGIN
  IF NOT _cost_tower_can_manage_governance(p_company_id, p_app_id) THEN
    RAISE EXCEPTION 'Not authorized to configure budgets for company %', p_company_id;
  END IF;

  IF NOT (SELECT supports_enforcement FROM mt_apps WHERE app_id = p_app_id)
     AND p_action_on_breach <> 'notify' THEN
    RAISE EXCEPTION 'action_on_breach must be notify for apps without enforcement support';
  END IF;

  UPDATE mt_ai_budgets
  SET amount = p_amount,
      currency = p_currency,
      warn_threshold_pct = p_warn_threshold_pct,
      escalate_threshold_pct = p_escalate_threshold_pct,
      enforcement_mode = p_enforcement_mode,
      action_on_breach = p_action_on_breach,
      action_on_breach_set_at = now()
  WHERE company_id = p_company_id AND app_id = p_app_id AND is_active
  RETURNING * INTO v_row;

  IF v_row IS NULL THEN
    INSERT INTO mt_ai_budgets (
      company_id, app_id, amount, currency,
      warn_threshold_pct, escalate_threshold_pct,
      enforcement_mode, action_on_breach, action_on_breach_set_at, created_by
    ) VALUES (
      p_company_id, p_app_id, p_amount, p_currency,
      p_warn_threshold_pct, p_escalate_threshold_pct,
      p_enforcement_mode, p_action_on_breach, now(), v_caller
    )
    RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END;
$function$;

-- 4 -- mt_ai_alert_acknowledge
CREATE OR REPLACE FUNCTION public.mt_ai_alert_acknowledge(p_alert_id uuid)
 RETURNS mt_ai_alerts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_caller  UUID := current_app_user();
  v_company UUID;
  v_app_id  TEXT;
  v_row     mt_ai_alerts;
BEGIN
  SELECT b.company_id, b.app_id INTO v_company, v_app_id
  FROM mt_ai_alerts a JOIN mt_ai_budgets b ON b.budget_id = a.budget_id
  WHERE a.alert_id = p_alert_id;

  IF v_company IS NULL OR NOT _cost_tower_can_manage_governance(v_company, v_app_id) THEN
    RAISE EXCEPTION 'Not authorized to acknowledge alert %', p_alert_id;
  END IF;

  UPDATE mt_ai_alerts
  SET status = 'acknowledged', acknowledged_by = v_caller, acknowledged_at = now()
  WHERE alert_id = p_alert_id AND status = 'open'
  RETURNING * INTO v_row;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'Alert % not found or already acknowledged', p_alert_id;
  END IF;

  RETURN v_row;
END;
$function$;

-- 5 -- mt_ai_alert_dismiss
CREATE OR REPLACE FUNCTION public.mt_ai_alert_dismiss(p_alert_id uuid)
 RETURNS mt_ai_alerts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_caller  UUID := current_app_user();
  v_company UUID;
  v_app_id  TEXT;
  v_row     mt_ai_alerts;
BEGIN
  SELECT b.company_id, b.app_id INTO v_company, v_app_id
  FROM mt_ai_alerts a JOIN mt_ai_budgets b ON b.budget_id = a.budget_id
  WHERE a.alert_id = p_alert_id;

  IF v_company IS NULL OR NOT _cost_tower_can_manage_governance(v_company, v_app_id) THEN
    RAISE EXCEPTION 'Not authorized to dismiss alert %', p_alert_id;
  END IF;

  UPDATE mt_ai_alerts
  SET status = 'dismissed', dismissed_by = v_caller, dismissed_at = now()
  WHERE alert_id = p_alert_id AND status != 'dismissed'
  RETURNING * INTO v_row;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'Alert % not found or already dismissed', p_alert_id;
  END IF;

  RETURN v_row;
END;
$function$;

-- ═══════════════════════════════════════════════════════════════════
-- End of dev correction.
-- ═══════════════════════════════════════════════════════════════════
