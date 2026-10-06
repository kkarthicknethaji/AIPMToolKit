-- ═══════════════════════════════════════════════════════════════════
-- AI Cost Control Tower -- Multi-App Platform Extraction
-- Combined migration script, assembled from the confirmed build list.
-- Run this as ONE script, top to bottom, in the order given -- every
-- section depends on the one before it. Do not reorder.
--
-- Sources folded in:
--   - Data model additions (spec §3)
--   - Signup flow change (spec §5, create_company_with_admin)
--   - RPC corrections (rpc-corrections-final.sql, spec §4)
--   - team_set_access_safe (spec §6a.3)
--   - mt_company_apps_list (spec §7.1's resolved read-path gap)
--   - mt_users_companies.access column (spec §3.8)
--
-- NOT included here (out of scope, tracked separately):
--   - mt_ai_cost_events_list's cache_read_price_per_mtok discrepancy
--     (§4's "unresolved discrepancy" note) -- reproduced character-for-
--     character unchanged in this script, not fixed.
-- ═══════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────
-- SECTION 1: mt_apps registry
-- ───────────────────────────────────────────────────────────────────

CREATE TABLE mt_apps (
  app_id                TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  supports_enforcement  BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO mt_apps (app_id, name, supports_enforcement)
VALUES ('product-studio', 'Product Studio', true);

-- Supabase's linter flags missing RLS at table-creation time; closed the
-- same way mt_company_apps is locked down below (RPC-only access, no
-- direct client read/write).
ALTER TABLE mt_apps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE mt_apps FROM anon, authenticated;


-- ───────────────────────────────────────────────────────────────────
-- SECTION 2: mt_company_apps grant table
-- ───────────────────────────────────────────────────────────────────

CREATE TABLE mt_company_apps (
  company_id                  UUID NOT NULL REFERENCES mt_companies(id),
  app_id                       TEXT NOT NULL REFERENCES mt_apps(app_id),
  is_active                    BOOLEAN NOT NULL DEFAULT true,
  granted_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by                   UUID REFERENCES auth.users(id),
  -- Phase 2 (batch ingestion) -- reserved now, NOT wired up in this phase.
  credential_hash              TEXT,
  credential_created_at        TIMESTAMPTZ,
  credential_last_used_at      TIMESTAMPTZ,
  PRIMARY KEY (company_id, app_id)
);

ALTER TABLE mt_company_apps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE mt_company_apps FROM anon, authenticated;

-- Retroactive backfill: every existing company gets the product-studio grant.
-- Without this, every live tenant loses Cost Tower access the moment this ships.
INSERT INTO mt_company_apps (company_id, app_id, is_active, granted_at)
SELECT id, 'product-studio', true, created_at
FROM mt_companies
ON CONFLICT (company_id, app_id) DO NOTHING;


-- ───────────────────────────────────────────────────────────────────
-- SECTION 3: mt_ai_usage_events.app_id
-- ───────────────────────────────────────────────────────────────────

ALTER TABLE mt_ai_usage_events ADD COLUMN app_id TEXT REFERENCES mt_apps(app_id);
UPDATE mt_ai_usage_events SET app_id = 'product-studio' WHERE app_id IS NULL;
ALTER TABLE mt_ai_usage_events ALTER COLUMN app_id SET NOT NULL;


-- ───────────────────────────────────────────────────────────────────
-- SECTION 4: mt_outcomes.app_id (must complete before Section 5/6)
-- ───────────────────────────────────────────────────────────────────

ALTER TABLE mt_outcomes ADD COLUMN app_id TEXT;
UPDATE mt_outcomes SET app_id = 'product-studio' WHERE app_id IS NULL;
ALTER TABLE mt_outcomes ALTER COLUMN app_id SET NOT NULL;


-- ───────────────────────────────────────────────────────────────────
-- SECTION 5: mt_outcome_types.app_id + its own FK to mt_apps
-- (safe on its own -- no PK/FK touched yet)
-- ───────────────────────────────────────────────────────────────────

ALTER TABLE mt_outcome_types ADD COLUMN app_id TEXT;
UPDATE mt_outcome_types SET app_id = 'product-studio' WHERE app_id IS NULL;
ALTER TABLE mt_outcome_types ALTER COLUMN app_id SET NOT NULL;
ALTER TABLE mt_outcome_types ADD CONSTRAINT mt_outcome_types_app_id_fkey
  FOREIGN KEY (app_id) REFERENCES mt_apps(app_id);


-- ───────────────────────────────────────────────────────────────────
-- SECTION 6: PK/FK swap -- ORDER-LOCKED, confirmed by failed dry-run.
-- (1) drop the FK depending on the old PK FIRST
-- (2) only then swap the PK to composite
-- (3) only then add the new composite FK back
-- ───────────────────────────────────────────────────────────────────

ALTER TABLE mt_outcomes DROP CONSTRAINT mt_outcomes_outcome_type_id_fkey;

ALTER TABLE mt_outcome_types DROP CONSTRAINT mt_outcome_types_pkey;
ALTER TABLE mt_outcome_types ADD PRIMARY KEY (app_id, outcome_type_id);

ALTER TABLE mt_outcomes ADD CONSTRAINT mt_outcomes_app_outcome_type_fkey
  FOREIGN KEY (app_id, outcome_type_id) REFERENCES mt_outcome_types(app_id, outcome_type_id);


-- ───────────────────────────────────────────────────────────────────
-- SECTION 7: mt_ai_budgets.app_id, new unique index before dropping
-- the old one, then drop the unused scope_type/scope_id columns.
-- ───────────────────────────────────────────────────────────────────

ALTER TABLE mt_ai_budgets ADD COLUMN app_id TEXT;
UPDATE mt_ai_budgets SET app_id = 'product-studio' WHERE app_id IS NULL;
ALTER TABLE mt_ai_budgets ALTER COLUMN app_id SET NOT NULL;
ALTER TABLE mt_ai_budgets ADD CONSTRAINT mt_ai_budgets_app_id_fkey
  FOREIGN KEY (app_id) REFERENCES mt_apps(app_id);

CREATE UNIQUE INDEX mt_ai_budgets_one_active_per_app_idx
  ON mt_ai_budgets (app_id, company_id) WHERE is_active;
DROP INDEX mt_ai_budgets_one_active_overall_idx;

ALTER TABLE mt_ai_budgets DROP COLUMN scope_type;
ALTER TABLE mt_ai_budgets DROP COLUMN scope_id;


-- ───────────────────────────────────────────────────────────────────
-- SECTION 8: mt_users_companies.access
-- ───────────────────────────────────────────────────────────────────

ALTER TABLE mt_users_companies ADD COLUMN access TEXT NOT NULL DEFAULT 'full_suite'
  CHECK (access IN ('full_suite','control_tower'));


-- ═══════════════════════════════════════════════════════════════════
-- SECTION 9: RPC layer. Every statement below is CREATE OR REPLACE
-- against a body pulled fresh via pg_get_functiondef, per §4's sourcing
-- requirement -- not drafted from sql/. Order within this section:
-- _cost_tower_can_access FIRST, then its 7 dependent callers, then the
-- 2 RPCs that don't call it, then the DROP of the old one-argument
-- overload LAST (only once every real caller is confirmed switched --
-- caller-search query returned exactly 7, all accounted for below).
-- ═══════════════════════════════════════════════════════════════════

-- 9.1 -- _cost_tower_can_access(uuid, text). Renamed from
-- _cost_tower_is_admin -- Cost Tower is now open to every active member
-- regardless of role, not admins only (post-build product decision), so
-- a name asserting "is_admin" would be actively misleading about what
-- this check actually gates going forward. The role='admin' clause is
-- dropped entirely; membership + an active app grant is now sufficient.
-- The old uuid-only overload stays callable until explicitly dropped at
-- the end of this section -- Postgres treats differing argument lists as
-- distinct functions, so this alone does not retire the weaker check.
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

-- Fix: the predecessor _cost_tower_is_admin(uuid) was explicitly revoked
-- from PUBLIC/anon/authenticated as an internal, not-directly-callable
-- helper (sql/ai-cost-tower.sql). Postgres grants EXECUTE to PUBLIC by
-- default for a newly created function -- carrying the REVOKE forward
-- explicitly here, matching every other internal helper in this codebase.
REVOKE EXECUTE ON FUNCTION public._cost_tower_can_access(uuid, text) FROM PUBLIC, anon, authenticated;

-- Role-based screen gate (AI Governance): AI Governance (Budget
-- Configuration, Alerts, Opportunity Matrix) is admin+power-user only --
-- read-only members can see Overview/Cost Breakdown/Outcome-Based Cost
-- (gated by _cost_tower_can_access above, no role check) but not this.
-- A separate helper rather than adding a role check to _cost_tower_can_access
-- itself, since that one is deliberately shared by every other Cost Tower
-- RPC and must stay open to every role. Composes _cost_tower_can_access
-- (membership + app-grant check) rather than duplicating its body, so that
-- boilerplate has exactly one definition to maintain regardless of how many
-- screen-level role gates Cost Tower ends up with.
--
-- THE CANONICAL LIST -- keep this comment and the CHANGELOG entry in sync,
-- this is the only place the full set is written down:
--   Gated by this function (4): mt_ai_alerts_list, mt_ai_budget_upsert,
--     mt_ai_alert_acknowledge, mt_ai_alert_dismiss.
--   Deliberately NOT gated, stays on _cost_tower_can_access (any role):
--     mt_ai_budget_get_active (Overview's own "% of budget used" stat reads
--     the active budget for every role, independent of this screen gate),
--     mt_ai_cost_events_list, mt_outcomes_list, mt_outcome_types_list,
--     mt_outcome_get_or_create_active, mt_company_apps_list.
-- A new governance-adjacent RPC needs an explicit decision, not a copy of
-- whichever neighbor happens to be nearest in this file.
--
-- Allow-list (role IN (...)), not a readonly exclusion -- fails toward
-- denying access on a NULL/unexpected role, consistent with this codebase's
-- documented fail-restrictive convention (see scripts/main.js's currentUserRole
-- comment), rather than an exclusion-style check that only denies the one
-- named value.
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

-- 9.2 -- mt_ai_alerts_list
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

-- 9.3 -- mt_ai_budget_get_active (scope_type reference removed, replaced with app_id)
CREATE OR REPLACE FUNCTION public.mt_ai_budget_get_active(p_company_id uuid, p_app_id text)
 RETURNS mt_ai_budgets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row mt_ai_budgets;
BEGIN
  -- Deliberately _cost_tower_can_access, not _cost_tower_can_manage_governance:
  -- Overview reads the active budget amount for every role (its own "% of
  -- budget used" stat), independent of the AI Governance screen. Only
  -- mt_ai_budget_upsert (actually configuring it) is governance-gated.
  IF NOT _cost_tower_can_access(p_company_id, p_app_id) THEN
    RAISE EXCEPTION 'Not authorized to view budgets for company %', p_company_id;
  END IF;

  SELECT * INTO v_row FROM mt_ai_budgets
  WHERE company_id = p_company_id AND app_id = p_app_id AND is_active
  LIMIT 1;

  RETURN v_row;
END;
$function$;

-- 9.4 -- mt_ai_budget_upsert (scope_type removal + §3.6/§6a action_on_breach guard)
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

-- 9.5 -- mt_ai_cost_events_list (calculated_cost expression left character-
-- for-character untouched -- see the unresolved discrepancy note at the
-- top of this file; only app_id parameter/filter are new here)
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

-- 9.6 -- mt_outcomes_list (app_id filter + composite join to mt_outcome_types)
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

-- 9.7 -- mt_ai_alert_acknowledge (no new external parameter -- internal
-- fix only: existing join to mt_ai_budgets now also pulls app_id)
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

-- 9.8 -- mt_ai_alert_dismiss (identical fix and reasoning to 9.7)
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

-- 9.9 -- mt_outcome_get_or_create_active (app_id added to INSERT -- the
-- live body's insert had no app_id at all and would otherwise violate
-- the new NOT NULL constraint outright). No admin check -- write/tracking
-- path, matching the existing convention on this function.
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

-- 9.10 -- mt_outcome_types_list (app_id filter only, deliberately no
-- admin/grant check -- catalog metadata, live body has none today)
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

-- 9.11 -- retire the old, weaker overload. Confirmed safe: the caller-
-- search query returned exactly 7 functions, all 7 updated above (9.2,
-- 9.3, 9.4, 9.5, 9.6, 9.7, 9.8). Must run LAST in this section.
DROP FUNCTION public._cost_tower_is_admin(uuid);

-- 9.12 -- Fix: a CREATE OR REPLACE FUNCTION with a different parameter list
-- creates a new overload alongside the old one, it does not replace it --
-- unlike _cost_tower_is_admin above, none of the pre-multi-app signatures
-- below were ever explicitly dropped. Two of them (mt_ai_budget_get_active,
-- mt_ai_budget_upsert) reference mt_ai_budgets.scope_type, dropped in
-- Section 7 -- calling either post-migration would raise "column does not
-- exist" instead of a clean "function does not exist". Confirmed safe:
-- every current call site in scripts/cost-tower.js and
-- scripts/cost-tower-outcomes.js already passes p_app_id, so nothing in
-- this codebase calls any of these old signatures.
DROP FUNCTION public.mt_ai_alerts_list(uuid);
DROP FUNCTION public.mt_ai_budget_get_active(uuid);
DROP FUNCTION public.mt_ai_budget_upsert(uuid, numeric, text, numeric, numeric, text, text);
DROP FUNCTION public.mt_ai_cost_events_list(uuid, timestamp with time zone, timestamp with time zone);
DROP FUNCTION public.mt_outcomes_list(uuid, timestamp with time zone, timestamp with time zone);
DROP FUNCTION public.mt_outcome_types_list();


-- ═══════════════════════════════════════════════════════════════════
-- SECTION 10: Signup flow -- create_company_with_admin gains the
-- mt_company_apps grant insert, in the same transaction as the company
-- and membership rows it already creates (spec §5).
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.create_company_with_admin(p_name text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company_id uuid;
  v_user_id uuid := current_app_user();
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  if nullif(trim(p_name), '') is null then
    raise exception 'Company name is required';
  end if;

  insert into mt_companies (name, created_by)
  values (trim(p_name), v_user_id)
  returning id into v_company_id;

  insert into mt_users_companies (user_id, company_id, role, is_active)
  values (v_user_id, v_company_id, 'admin', true);

  -- Multi-app platform extension: every new company automatically gets
  -- Product Studio, in the same transaction as the two inserts above, so
  -- there is never a moment where a company exists with zero apps --
  -- including the one the person just signed up through.
  insert into mt_company_apps (company_id, app_id, is_active, granted_at)
  values (v_company_id, 'product-studio', true, now());

  return v_company_id;
end;
$function$;


-- ═══════════════════════════════════════════════════════════════════
-- SECTION 11: team_set_access_safe (spec §6a.3). Deliberately does NOT
-- replicate team_set_role_safe's admin-count guard -- §6a.4's confirmed
-- Option A means there is no "last full-suite admin" invariant to
-- protect. Self-change blocking lives in the proxy route, not here,
-- mirroring team_set_role_safe's real body (which has no self-check
-- either).
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.team_set_access_safe(p_company_id uuid, p_target_user uuid, p_new_access text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare target_access text;
begin
  select access into target_access from mt_users_companies
    where user_id = p_target_user and company_id = p_company_id
    for update;

  if target_access is null then
    return false;
  end if;

  update mt_users_companies set access = p_new_access
    where user_id = p_target_user and company_id = p_company_id;
  return true;
end; $function$;


-- ═══════════════════════════════════════════════════════════════════
-- SECTION 12: mt_company_apps_list (spec §7.1's resolved read-path gap).
-- Replaces a mirrored direct client query, which would need a permissive
-- RLS policy on mt_company_apps -- rejected because that table carries
-- the reserved credential_* columns for Phase 2, and a policy scoped to
-- "your own company's rows" would expose them to any authenticated
-- member the moment a client call selects more than the minimum. This
-- RPC returns exactly app_id/name/is_active by construction, never the
-- credential_* columns.
--
-- Authorization note (inference, not explicitly spec'd): scoped to
-- "caller is an active member of p_company_id" -- any role, not just
-- admin -- to match hdrOpenSwitchCompany()'s equivalent scope today
-- (any active member can see the Switch Company list, not only admins).
-- Filters to is_active grants only, since only currently-granted apps
-- should appear as switchable options.
--
-- granted_at + ORDER BY added here (not in the version already applied
-- to pgt-dev): §7.2's "fall back to the oldest/first app granted" default
-- has no deterministic source without this -- the dev-side correction to
-- bring the already-applied function in line with this is called out
-- separately, since CREATE OR REPLACE cannot change a function's return
-- column list; it needs a DROP first there.
-- ═══════════════════════════════════════════════════════════════════

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
-- End of migration.
-- ═══════════════════════════════════════════════════════════════════
