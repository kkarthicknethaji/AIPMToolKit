-- ═══════════════════════════════════════════════════════════════════
-- DEV-ONLY CORRECTION -- run this on pgt-dev only, NOT prod.
-- Prod has never run the multi-app migration yet, so its tracked copy
-- (sql/ai-cost-tower-multi-app-migration.sql) already has this rename
-- baked in and needs no separate correction.
--
-- Dev already ran an earlier version of that migration, which created
-- _cost_tower_is_admin(uuid, text) -- an admin-only authorization check.
-- Cost Tower is now open to every active member regardless of role, so
-- that function has been renamed to _cost_tower_can_access and its
-- role='admin' requirement dropped. This script:
--   1. Creates the new, renamed, widened function (with its own REVOKE,
--      matching every other internal helper in this codebase).
--   2. Points all 7 dependent RPCs at it (CREATE OR REPLACE, idempotent).
--   3. Drops the now-unused old admin-only function, plus 6 further-stale
--      pre-multi-app signatures the original dev migration never dropped
--      (CREATE OR REPLACE with a new parameter list creates a new overload,
--      it doesn't retire the old one).
--   4. Corrects mt_company_apps_list to the version prod's tracked
--      migration file now has (deterministic ordering + supports_
--      enforcement), which the original dev migration shipped without.
--
-- No CREATE TABLE / ALTER TABLE anywhere in this file -- safe to run as
-- one script even though every table this touches already exists on dev.
-- ═══════════════════════════════════════════════════════════════════

-- 1 -- the renamed, widened authorization check
CREATE OR REPLACE FUNCTION public._cost_tower_can_access(p_company_id uuid, p_app_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM mt_users_companies uc
    WHERE uc.company_id = p_company_id
      AND uc.user_id = current_app_user()
      AND uc.is_active
  )
  AND EXISTS (
    SELECT 1 FROM mt_company_apps ca
    WHERE ca.company_id = p_company_id
      AND ca.app_id = p_app_id
      AND ca.is_active
  );
$function$;

-- Fix: this internal helper must not be directly callable, matching its
-- predecessor's REVOKE (sql/ai-cost-tower.sql). Postgres grants EXECUTE to
-- PUBLIC by default for a new function -- this closes that on dev too.
REVOKE EXECUTE ON FUNCTION public._cost_tower_can_access(uuid, text) FROM PUBLIC, anon, authenticated;

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
    AND _cost_tower_can_access(p_company_id, p_app_id)
    AND a.status != 'dismissed'
    AND a.period_start >= (date_trunc('month', now() AT TIME ZONE 'UTC') - INTERVAL '1 month')::date
  ORDER BY a.created_at DESC;
$function$;

-- 3 -- mt_ai_budget_get_active
CREATE OR REPLACE FUNCTION public.mt_ai_budget_get_active(p_company_id uuid, p_app_id text)
 RETURNS mt_ai_budgets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row mt_ai_budgets;
BEGIN
  IF NOT _cost_tower_can_access(p_company_id, p_app_id) THEN
    RAISE EXCEPTION 'Not authorized to view budgets for company %', p_company_id;
  END IF;

  SELECT * INTO v_row FROM mt_ai_budgets
  WHERE company_id = p_company_id AND app_id = p_app_id AND is_active
  LIMIT 1;

  RETURN v_row;
END;
$function$;

-- 4 -- mt_ai_budget_upsert
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
  IF NOT _cost_tower_can_access(p_company_id, p_app_id) THEN
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

-- 5 -- mt_ai_cost_events_list
CREATE OR REPLACE FUNCTION public.mt_ai_cost_events_list(
  p_company_id uuid, p_app_id text,
  p_period_start timestamp with time zone, p_period_end timestamp with time zone
)
 RETURNS TABLE(
   request_started_at timestamp with time zone, product_id uuid, user_id uuid,
   user_role_at_call text, caller text, prompt_version text, provider text,
   requested_model text, response_model text, selection_rule text,
   input_tokens integer, output_tokens integer, cache_creation_5m_tokens integer,
   cache_creation_1h_tokens integer, cache_read_tokens integer, status text,
   error_type text, failure_phase text, duration_ms integer, request_bytes integer,
   response_bytes integer, tier text, input_price_per_mtok numeric,
   output_price_per_mtok numeric, calculated_cost numeric, outcome_id uuid,
   units_generated integer
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT _cost_tower_can_access(p_company_id, p_app_id) THEN
    RAISE EXCEPTION 'Not authorized to read cost events for company %', p_company_id;
  END IF;

  RETURN QUERY
  SELECT
    e.request_started_at, e.product_id, e.user_id, e.user_role_at_call,
    e.caller, e.prompt_version, e.provider, e.requested_model, e.response_model,
    e.selection_rule, e.input_tokens, e.output_tokens,
    e.cache_creation_5m_tokens, e.cache_creation_1h_tokens, e.cache_read_tokens,
    e.status, e.error_type, e.failure_phase, e.duration_ms, e.request_bytes, e.response_bytes,
    p.tier, p.input_price_per_mtok, p.output_price_per_mtok,
    CASE WHEN p.id IS NULL THEN NULL ELSE
        (e.input_tokens::numeric / 1000000) * p.input_price_per_mtok
      + (e.output_tokens::numeric / 1000000) * p.output_price_per_mtok
      + (COALESCE(e.cache_creation_5m_tokens,0)::numeric / 1000000) * p.cache_write_5m_price_per_mtok
      + (COALESCE(e.cache_creation_1h_tokens,0)::numeric / 1000000) * p.cache_write_1h_price_per_mtok
      + (COALESCE(e.cache_read_tokens,0)::numeric / 1000000) * p.cache_read_price_per_mtok
    END AS calculated_cost,
    e.outcome_id, e.units_generated
  FROM mt_ai_usage_events e
  LEFT JOIN mt_model_pricing p
    ON p.provider = e.provider
   AND p.model_name = COALESCE(e.response_model, e.requested_model)
   AND e.request_started_at >= p.effective_from
   AND (p.effective_to IS NULL OR e.request_started_at < p.effective_to)
  WHERE e.company_id = p_company_id
    AND e.app_id = p_app_id
    AND e.request_started_at >= p_period_start
    AND e.request_started_at < p_period_end;
END;
$function$;

-- 6 -- mt_outcomes_list
CREATE OR REPLACE FUNCTION public.mt_outcomes_list(
  p_company_id uuid, p_app_id text,
  p_period_start timestamp with time zone, p_period_end timestamp with time zone
)
 RETURNS TABLE(
   outcome_id uuid, outcome_type_id text, product_id uuid, session_id uuid,
   status text, started_at timestamp with time zone, completed_at timestamp with time zone,
   last_activity_at timestamp with time zone, is_abandoned boolean
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT _cost_tower_can_access(p_company_id, p_app_id) THEN
    RAISE EXCEPTION 'Not authorized to read outcomes for company %', p_company_id;
  END IF;

  RETURN QUERY
  SELECT
    o.outcome_id, o.outcome_type_id, o.product_id, o.session_id,
    o.status, o.started_at, o.completed_at, o.last_activity_at,
    (o.status = 'in_progress'
      AND ot.abandonment_window_hrs IS NOT NULL
      AND now() - o.last_activity_at > (ot.abandonment_window_hrs || ' hours')::interval
    ) AS is_abandoned
  FROM mt_outcomes o
  JOIN mt_outcome_types ot ON ot.app_id = o.app_id AND ot.outcome_type_id = o.outcome_type_id
  WHERE o.company_id = p_company_id
    AND o.app_id = p_app_id
    AND o.started_at >= p_period_start
    AND o.started_at < p_period_end;
END;
$function$;

-- 7 -- mt_ai_alert_acknowledge
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

  IF v_company IS NULL OR NOT _cost_tower_can_access(v_company, v_app_id) THEN
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

-- 8 -- mt_ai_alert_dismiss
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

  IF v_company IS NULL OR NOT _cost_tower_can_access(v_company, v_app_id) THEN
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

-- 9 -- mt_outcome_get_or_create_active
CREATE OR REPLACE FUNCTION public.mt_outcome_get_or_create_active(
  p_company_id uuid, p_app_id text, p_session_id uuid,
  p_outcome_type_id text, p_product_id uuid, p_user_id uuid
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_outcome_id UUID;
  v_window_hrs INTEGER;
BEGIN
  SELECT abandonment_window_hrs INTO v_window_hrs
  FROM mt_outcome_types WHERE app_id = p_app_id AND outcome_type_id = p_outcome_type_id;

  SELECT o.outcome_id INTO v_outcome_id
  FROM mt_outcomes o
  WHERE o.session_id = p_session_id
    AND o.app_id = p_app_id
    AND o.outcome_type_id = p_outcome_type_id
    AND o.status = 'in_progress'
    AND now() - o.last_activity_at <= (v_window_hrs || ' hours')::interval
  ORDER BY o.started_at DESC
  LIMIT 1;

  IF v_outcome_id IS NOT NULL THEN
    UPDATE mt_outcomes
    SET last_activity_at = now(),
        product_id = COALESCE(product_id, p_product_id)
    WHERE outcome_id = v_outcome_id;
    RETURN v_outcome_id;
  END IF;

  INSERT INTO mt_outcomes (outcome_type_id, app_id, company_id, product_id, session_id, user_id)
  VALUES (p_outcome_type_id, p_app_id, p_company_id, p_product_id, p_session_id, p_user_id)
  RETURNING outcome_id INTO v_outcome_id;

  RETURN v_outcome_id;
END;
$function$;

-- 10 -- mt_outcome_types_list
CREATE OR REPLACE FUNCTION public.mt_outcome_types_list(p_app_id text)
 RETURNS TABLE(
   outcome_type_id text, name text, canvas text, description text,
   costing_method text, unit_label text, abandonment_window_hrs integer
 )
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT outcome_type_id, name, canvas, description, costing_method, unit_label, abandonment_window_hrs
  FROM mt_outcome_types
  WHERE app_id = p_app_id;
$function$;

-- 11 -- retire the old admin-only function LAST, only once all 7 real
-- dependents above have been switched to _cost_tower_can_access.
DROP FUNCTION IF EXISTS public._cost_tower_is_admin(uuid, text);

-- 12 -- Fix: dev's original multi-app migration had the same gap as the
-- tracked prod file did until this fix -- a CREATE OR REPLACE FUNCTION with
-- a different parameter list creates a new overload, it never drops the
-- old pre-multi-app signature. Dev has been carrying these unused since
-- that migration ran. Confirmed safe the same way as prod: every current
-- call site already passes p_app_id, nothing calls these old signatures.
DROP FUNCTION IF EXISTS public.mt_ai_alerts_list(uuid);
DROP FUNCTION IF EXISTS public.mt_ai_budget_get_active(uuid);
DROP FUNCTION IF EXISTS public.mt_ai_budget_upsert(uuid, numeric, text, numeric, numeric, text, text);
DROP FUNCTION IF EXISTS public.mt_ai_cost_events_list(uuid, timestamp with time zone, timestamp with time zone);
DROP FUNCTION IF EXISTS public.mt_outcomes_list(uuid, timestamp with time zone, timestamp with time zone);
DROP FUNCTION IF EXISTS public.mt_outcome_types_list();

-- 13 -- Fix: dev's original mt_company_apps_list shipped as a 3-column
-- return (app_id, name, is_active) with no ordering. Prod's tracked
-- migration file was corrected mid-build to also return granted_at
-- (ordered ASC -- the deterministic "oldest granted" default app-switch
-- fallback in scripts/cost-tower.js's actResolveActiveApp() depends on
-- this) and supports_enforcement (the Budget Configuration enforcement-
-- lock in cost-tower.js reads this field). That correction was never
-- carried into this file, leaving dev's default-app selection
-- non-deterministic once a company has 2+ apps. DROP is required here,
-- not CREATE OR REPLACE -- Postgres cannot change a function's return
-- column list in place.
DROP FUNCTION IF EXISTS public.mt_company_apps_list(uuid);

CREATE OR REPLACE FUNCTION public.mt_company_apps_list(p_company_id uuid)
 RETURNS TABLE(app_id text, name text, is_active boolean, granted_at timestamptz, supports_enforcement boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM mt_users_companies uc
    WHERE uc.company_id = p_company_id
      AND uc.user_id = current_app_user()
      AND uc.is_active
  ) THEN
    RAISE EXCEPTION 'Not a member of company %', p_company_id;
  END IF;

  RETURN QUERY
  SELECT ca.app_id, a.name, ca.is_active, ca.granted_at, a.supports_enforcement
  FROM mt_company_apps ca
  JOIN mt_apps a ON a.app_id = ca.app_id
  WHERE ca.company_id = p_company_id
    AND ca.is_active
  ORDER BY ca.granted_at ASC;
END;
$function$;

-- ═══════════════════════════════════════════════════════════════════
-- End of dev correction.
-- ═══════════════════════════════════════════════════════════════════
