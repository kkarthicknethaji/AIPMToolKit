-- ═══════════════════════════════════════════════════════════════════
-- AI Cost Control Tower — period-summary aggregation migration
-- ═══════════════════════════════════════════════════════════════════
--
-- Problem: mt_ai_cost_events_list() returns one row per usage event, with
-- no ORDER BY/LIMIT. PostgREST silently truncates any result set over its
-- row cap (confirmed on dev: a single month's true row count was 1,136,
-- UI showed 1,000). Because there's no ORDER BY, the specific 1,000 rows
-- returned are not deterministic across different period windows — so
-- every KPI computed client-side by summing/grouping the fetched rows
-- (Overview, Cost Breakdown, AI Governance, Outcome-Based Cost) can
-- silently undercount, and can even show LOWER totals for a wider period
-- than a narrower one already showed.
--
-- Fix: replace "fetch raw rows, sum client-side" with server-side
-- aggregation — every new function below returns one row per GROUP
-- (bounded by category cardinality: features, models, providers, outcome
-- types — never by event volume), so none of them can be truncated
-- regardless of how much call volume exists. Only Request Explorer's flat
-- table (Cost Breakdown → Trust & Audit) still needs individual rows —
-- Part F gives it real ORDER BY + LIMIT/OFFSET pagination instead of an
-- unbounded fetch.
--
-- Every calculated_cost expression below is copied character-for-character
-- from mt_ai_cost_events_list's live formula (sql/ai-cost-tower-trace-
-- layer-payload-read-rpc.sql) — no repricing logic is introduced.
--
-- Run as ONE paste per section (each section is its own transaction).
-- Verification queries follow each section.

-- ═══════════════════════════════════════════════════════════════════
-- A — _act_feature_of(caller) — SQL mirror of cost-tower.js's
-- actFeatureOf(). Needed because Type 1's opportunity engine (Part E)
-- must pool ALL of a feature's calls (across every caller prefix that
-- maps to it) before taking a percentile segment — percentile selection
-- is not associative across sub-groups, so grouping by raw `caller` and
-- merging afterward (the pattern every other RPC below uses) does not
-- work here. This is a deliberate, documented duplication of the JS
-- mapping — the same tension already exists between this file's
-- CROSS_PRODUCT_CALLERS and api.js's CALLER_TIERS. If a new caller
-- prefix is ever added to actFeatureOf() in scripts/cost-tower.js, this
-- function must be updated in the same change, or Type 1/2's
-- opportunity engine will silently misclassify that caller as
-- 'Unknown / Other'.
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public._act_feature_of(p_caller text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT CASE
    WHEN p_caller IS NULL OR p_caller = 'unknown' THEN 'Unknown / Other'
    WHEN p_caller = 'fc-gen-stories' THEN 'Story Canvas'
    WHEN p_caller = 'sc-add-feat-hyp-gen' THEN 'Feature Canvas'
    WHEN p_caller = 'md-dd-batch' THEN 'Capability Canvas'
    WHEN p_caller = 'diagnostic-leak' THEN 'Discovery Map'
    WHEN p_caller = 'guided-launch' THEN 'Guided Launch'
    WHEN p_caller = 'requirement-agent' THEN 'Requirement Agent'
    WHEN p_caller = 'outcome-pulse-suggest' THEN 'Outcome Pulse'
    WHEN p_caller IN ('ai-recommendations', 'doc-summary') THEN 'Shared / Cross-canvas'
    WHEN p_caller LIKE 'dm-%' THEN 'Discovery Map'
    WHEN p_caller LIKE 'mi-%' THEN 'Market Intelligence'
    WHEN p_caller LIKE 'cc-%' THEN 'Capability Canvas'
    WHEN p_caller LIKE 'fc-%' THEN 'Feature Canvas'
    WHEN p_caller LIKE 'sc-%' THEN 'Story Canvas'
    WHEN p_caller LIKE 'pi-%' THEN 'PI Canvas'
    WHEN p_caller LIKE 'arp-%' THEN 'Adoption Readiness'
    WHEN p_caller LIKE 'prototype-%' THEN 'Prototype Canvas'
    ELSE 'Unknown / Other'
  END;
$function$;

REVOKE EXECUTE ON FUNCTION public._act_feature_of(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._act_feature_of(text) TO authenticated;

COMMIT;

-- Verify: spot-check a few known caller values map exactly like
-- actFeatureOf() does in scripts/cost-tower.js.
-- SELECT _act_feature_of('requirement-agent'), _act_feature_of('fc-gen-stories'),
--        _act_feature_of('ai-recommendations'), _act_feature_of('nonexistent-caller');
-- expect: 'Requirement Agent', 'Story Canvas', 'Shared / Cross-canvas', 'Unknown / Other'

-- ═══════════════════════════════════════════════════════════════════
-- B — mt_ai_cost_summary — one row of scalar totals for a period.
-- Replaces: Overview's At-a-Glance KPIs + Needs Attention evidence table,
-- Cache Usage, Data Quality's 4 KPI tiles, AI Governance's "Spend This
-- Month (MTD)"/"Total spent overall"/Budget Bar (actMain/
-- actLifetimeSpendTotal), Outcome-Based Cost's TOTAL_AI_SPEND_PERIOD.
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.mt_ai_cost_summary(
  p_company_id uuid, p_app_id text,
  p_period_start timestamp with time zone, p_period_end timestamp with time zone
)
RETURNS TABLE(
  total_cost numeric, total_calls bigint,
  total_input_tokens bigint, total_output_tokens bigint,
  priced_calls bigint, unpriced_calls bigint,
  failed_calls bigint, failed_cost numeric,
  balanced_frontier_calls bigint,
  cache_eligible_input bigint, cache_read_tokens bigint, cache_savings numeric,
  null_token_calls bigint, model_variance_calls bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
-- RETURNS TABLE's output columns include cache_read_tokens, which also
-- names a real mt_ai_usage_events column referenced (unqualified, via the
-- `events` CTE) inside this function — Postgres's default
-- plpgsql.variable_conflict='error' then rejects every bare reference to
-- it as ambiguous (is it the OUT parameter or the CTE column?). This
-- directive resolves the ambiguity in favor of the column, matching
-- ordinary SQL semantics, without requiring every reference in the body
-- to be alias-qualified.
#variable_conflict use_column
BEGIN
  IF NOT _cost_tower_can_access(p_company_id, p_app_id) THEN
    RAISE EXCEPTION 'Not authorized to read cost summary for company %', p_company_id;
  END IF;

  RETURN QUERY
  WITH events AS (
    SELECT
      e.input_tokens, e.output_tokens, e.cache_read_tokens, e.status, e.provider,
      e.response_model, e.requested_model,
      p.id AS pricing_id, p.tier, p.input_price_per_mtok, p.cache_read_price_per_mtok,
      CASE WHEN p.id IS NULL THEN NULL ELSE
          (e.input_tokens::numeric / 1000000) * p.input_price_per_mtok
        + (e.output_tokens::numeric / 1000000) * p.output_price_per_mtok
        + (COALESCE(e.cache_creation_5m_tokens,0)::numeric / 1000000) * p.cache_write_5m_price_per_mtok
        + (COALESCE(e.cache_creation_1h_tokens,0)::numeric / 1000000) * p.cache_write_1h_price_per_mtok
        + (COALESCE(e.cache_read_tokens,0)::numeric / 1000000) * p.cache_read_price_per_mtok
      END AS calc_cost
    FROM mt_ai_usage_events e
    LEFT JOIN mt_model_pricing p
      ON p.provider = e.provider
     AND p.model_name = COALESCE(e.response_model, e.requested_model)
     AND e.request_started_at >= p.effective_from
     AND (p.effective_to IS NULL OR e.request_started_at < p.effective_to)
    WHERE e.company_id = p_company_id
      AND e.app_id = p_app_id
      AND e.request_started_at >= p_period_start
      AND e.request_started_at < p_period_end
  )
  SELECT
    COALESCE(SUM(calc_cost), 0),
    COUNT(*),
    COALESCE(SUM(input_tokens), 0),
    COALESCE(SUM(output_tokens), 0),
    COUNT(*) FILTER (WHERE pricing_id IS NOT NULL),
    COUNT(*) FILTER (WHERE pricing_id IS NULL),
    COUNT(*) FILTER (WHERE status IN ('error','timeout')),
    COALESCE(SUM(calc_cost) FILTER (WHERE status IN ('error','timeout')), 0),
    COUNT(*) FILTER (WHERE tier IN ('balanced','frontier')),
    COALESCE(SUM(CASE WHEN provider = 'anthropic' THEN COALESCE(input_tokens,0) + COALESCE(cache_read_tokens,0) ELSE COALESCE(input_tokens,0) END), 0),
    COALESCE(SUM(cache_read_tokens), 0),
    COALESCE(SUM(
      CASE WHEN COALESCE(cache_read_tokens,0) > 0 AND pricing_id IS NOT NULL
             AND input_price_per_mtok IS NOT NULL AND cache_read_price_per_mtok IS NOT NULL
        THEN (cache_read_tokens / 1000000.0) * (input_price_per_mtok - cache_read_price_per_mtok)
        ELSE 0 END
    ), 0),
    COUNT(*) FILTER (WHERE input_tokens IS NULL OR output_tokens IS NULL),
    COUNT(*) FILTER (WHERE response_model IS NOT NULL AND requested_model IS NOT NULL AND response_model <> requested_model)
  FROM events;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.mt_ai_cost_summary(uuid, text, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mt_ai_cost_summary(uuid, text, timestamptz, timestamptz)
  TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- Verify: total_cost/total_calls should equal what a manual SUM/COUNT over
-- mt_ai_usage_events gives for the SAME window used in the earlier dev
-- check (Aug 2026, true count 1,136) — this is the number that must now
-- match, where the UI previously showed a capped 1,000.
-- SELECT * FROM mt_ai_cost_summary('<company>', '<app>', '2026-08-01', '2026-09-01');

-- ═══════════════════════════════════════════════════════════════════
-- C — mt_ai_cost_grouped — one row per distinct value of a server-side
-- grouping dimension. p_group_by is a fixed allowlist; row count is
-- bounded by category cardinality, never by event count.
--
-- 'feature'/'product': grouped by (caller, product_id) — the finer grain
-- both need, since neither the feature label nor the unassigned/cross-
-- product bucket is derivable from either column alone. The client folds
-- this small result through its EXISTING actFeatureOf()/
-- actIsCrossProductCaller() JS logic exactly as today (no business-rule
-- duplication here — unlike Part A, summing across sub-groups IS
-- associative, so client-side folding after aggregation is safe).
-- 'outcome_type': joins to mt_outcomes via outcome_id, replicating
-- buildOutcomeTypes()'s exact membership rule (cost-tower-outcomes.js:
-- 141-152) — a cost row counts toward an outcome type ONLY if its outcome
-- both exists and itself STARTED within [p_period_start, p_period_end).
-- This mirrors today's behavior exactly, including its known quirk (a
-- cost event dated inside the period but tied to an outcome that started
-- in an earlier period is excluded from every period's outcome-type
-- total) — that quirk is NOT fixed by this migration; it is a separate,
-- already-existing behavior this port deliberately preserves rather than
-- silently changes.
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.mt_ai_cost_grouped(
  p_company_id uuid, p_app_id text,
  p_period_start timestamp with time zone, p_period_end timestamp with time zone,
  p_group_by text
)
RETURNS TABLE(
  group_key1 text, group_key2 text,
  calls bigint, cost numeric,
  failed_calls bigint, failed_cost numeric,
  input_tokens bigint, output_tokens bigint,
  units_generated_sum numeric, units_resolved_count bigint,
  first_seen timestamp with time zone, last_seen timestamp with time zone,
  -- Representative (not authoritative-per-row) tier/role for display only —
  -- 'model' mode's tier badge and 'user' mode's role column previously read
  -- an arbitrary row's value (g.rows[0]/g.rows.find(...)) from a client-side
  -- group; MAX() here is an equally-arbitrary-but-deterministic substitute
  -- for the same display-only purpose, not a claim that every row in the
  -- group shares one true value.
  sample_tier text, sample_user_role text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
-- RETURNS TABLE's input_tokens/output_tokens output columns collide with
-- the same-named mt_ai_usage_events columns referenced (unqualified, via
-- the `events` CTE) throughout the SELECT/GROUP BY below — see
-- mt_ai_cost_summary's identical comment above.
#variable_conflict use_column
BEGIN
  IF NOT _cost_tower_can_access(p_company_id, p_app_id) THEN
    RAISE EXCEPTION 'Not authorized to read cost breakdown for company %', p_company_id;
  END IF;
  IF p_group_by NOT IN ('feature','product','model','user','prompt_version','selection_rule','tier','user_role','unpriced_drill','outcome_type','failure_phase','variance_cause') THEN
    RAISE EXCEPTION 'Invalid group_by: %', p_group_by;
  END IF;

  RETURN QUERY
  WITH events AS (
    SELECT
      e.caller, e.product_id, e.user_id, e.prompt_version, e.selection_rule,
      e.user_role_at_call, e.status, e.input_tokens, e.output_tokens,
      e.units_generated, e.provider, e.requested_model, e.response_model,
      e.request_started_at, e.failure_phase, e.error_type,
      p.tier,
      CASE WHEN p.id IS NULL THEN NULL ELSE
          (e.input_tokens::numeric / 1000000) * p.input_price_per_mtok
        + (e.output_tokens::numeric / 1000000) * p.output_price_per_mtok
        + (COALESCE(e.cache_creation_5m_tokens,0)::numeric / 1000000) * p.cache_write_5m_price_per_mtok
        + (COALESCE(e.cache_creation_1h_tokens,0)::numeric / 1000000) * p.cache_write_1h_price_per_mtok
        + (COALESCE(e.cache_read_tokens,0)::numeric / 1000000) * p.cache_read_price_per_mtok
      END AS calc_cost,
      o.outcome_type_id,
      -- Completed and abandoned are mutually exclusive by construction
      -- (is_abandoned only ever applies to a still-in_progress outcome,
      -- per mt_outcomes_list's own SQL) — mirrors buildOutcomeTypes()'s
      -- completedIds/abandonedIds split exactly.
      CASE
        WHEN o.outcome_id IS NULL THEN NULL
        WHEN o.status = 'completed' THEN 'completed'
        WHEN o.is_abandoned THEN 'abandoned'
        ELSE 'other'
      END AS completion_bucket
    FROM mt_ai_usage_events e
    LEFT JOIN mt_model_pricing p
      ON p.provider = e.provider
     AND p.model_name = COALESCE(e.response_model, e.requested_model)
     AND e.request_started_at >= p.effective_from
     AND (p.effective_to IS NULL OR e.request_started_at < p.effective_to)
    LEFT JOIN LATERAL (
      SELECT mo.outcome_id, mo.outcome_type_id, mo.status,
        (mo.status = 'in_progress'
          AND ot.abandonment_window_hrs IS NOT NULL
          AND now() - mo.last_activity_at > (ot.abandonment_window_hrs || ' hours')::interval
        ) AS is_abandoned
      FROM mt_outcomes mo
      JOIN mt_outcome_types ot ON ot.app_id = mo.app_id AND ot.outcome_type_id = mo.outcome_type_id
      WHERE mo.outcome_id = e.outcome_id
        AND mo.company_id = e.company_id
        AND mo.app_id = e.app_id
        AND mo.started_at >= p_period_start
        AND mo.started_at < p_period_end
    ) o ON true
    WHERE e.company_id = p_company_id
      AND e.app_id = p_app_id
      AND e.request_started_at >= p_period_start
      AND e.request_started_at < p_period_end
  )
  SELECT
    CASE p_group_by
      WHEN 'feature' THEN caller
      WHEN 'product' THEN caller
      WHEN 'model' THEN COALESCE(response_model, requested_model)
      WHEN 'user' THEN user_id::text
      WHEN 'prompt_version' THEN caller
      WHEN 'selection_rule' THEN selection_rule
      WHEN 'tier' THEN tier
      WHEN 'user_role' THEN user_role_at_call
      WHEN 'unpriced_drill' THEN COALESCE(provider, '?')
      WHEN 'outcome_type' THEN outcome_type_id
      WHEN 'failure_phase' THEN COALESCE(failure_phase, 'unspecified')
      WHEN 'variance_cause' THEN COALESCE(error_type, failure_phase, 'mixed')
    END::text AS group_key1,
    CASE p_group_by
      WHEN 'feature' THEN product_id::text
      WHEN 'product' THEN product_id::text
      WHEN 'prompt_version' THEN prompt_version
      WHEN 'unpriced_drill' THEN COALESCE(requested_model,'?') || ' → ' || COALESCE(response_model,'—')
      WHEN 'outcome_type' THEN completion_bucket
      ELSE NULL
    END::text AS group_key2,
    COUNT(*)::bigint,
    COALESCE(SUM(calc_cost), 0)::numeric,
    COUNT(*) FILTER (WHERE status IN ('error','timeout'))::bigint,
    COALESCE(SUM(calc_cost) FILTER (WHERE status IN ('error','timeout')), 0)::numeric,
    COALESCE(SUM(input_tokens), 0)::bigint,
    COALESCE(SUM(output_tokens), 0)::bigint,
    COALESCE(SUM(units_generated), 0)::numeric,
    COUNT(*) FILTER (WHERE units_generated IS NOT NULL)::bigint,
    MIN(request_started_at),
    MAX(request_started_at),
    MAX(tier)::text,
    MAX(user_role_at_call)::text
  FROM events
  WHERE (p_group_by <> 'unpriced_drill' OR calc_cost IS NULL)
    AND (p_group_by <> 'outcome_type' OR outcome_type_id IS NOT NULL)
    AND (p_group_by <> 'failure_phase' OR status IN ('error','timeout'))
    AND (p_group_by <> 'variance_cause' OR (response_model IS NOT NULL AND requested_model IS NOT NULL AND response_model <> requested_model))
  GROUP BY 1, 2;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.mt_ai_cost_grouped(uuid, text, timestamptz, timestamptz, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mt_ai_cost_grouped(uuid, text, timestamptz, timestamptz, text)
  TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- Verify: sum of 'feature' mode's cost across all rows should equal
-- mt_ai_cost_summary's total_cost for the same window.
-- SELECT sum(cost) FROM mt_ai_cost_grouped('<company>','<app>','2026-08-01','2026-09-01','feature');
-- SELECT total_cost FROM mt_ai_cost_summary('<company>','<app>','2026-08-01','2026-09-01');
-- expect: equal (within rounding).

-- ═══════════════════════════════════════════════════════════════════
-- D — mt_ai_cost_top_calls — top-N by duration/size/cost, optionally
-- per-partition (outcome_type or caller). Replaces Longest/Largest's "By
-- Call" mode (a genuine correctness fix — today's version can silently
-- miss the actual longest/largest call if it falls outside the truncated
-- sample) and Outcome-Based Cost's per-type/per-caller "sample calls".
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.mt_ai_cost_top_calls(
  p_company_id uuid, p_app_id text,
  p_period_start timestamp with time zone, p_period_end timestamp with time zone,
  p_order_by text, p_limit int,
  p_partition_by text DEFAULT NULL
)
RETURNS TABLE(
  partition_key text,
  request_started_at timestamp with time zone, caller text,
  response_model text, requested_model text,
  duration_ms integer, request_bytes integer, response_bytes integer,
  status text, calculated_cost numeric, tier text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
-- RETURNS TABLE's request_started_at output column collides with the
-- same-named mt_ai_usage_events column referenced (unqualified, via the
-- `events`/`ranked` CTEs) throughout — see mt_ai_cost_summary's identical
-- comment above.
#variable_conflict use_column
BEGIN
  IF NOT _cost_tower_can_access(p_company_id, p_app_id) THEN
    RAISE EXCEPTION 'Not authorized to read top calls for company %', p_company_id;
  END IF;
  IF p_order_by NOT IN ('duration','size','cost') THEN
    RAISE EXCEPTION 'Invalid order_by: %', p_order_by;
  END IF;
  IF p_partition_by IS NOT NULL AND p_partition_by NOT IN ('outcome_type','caller') THEN
    RAISE EXCEPTION 'Invalid partition_by: %', p_partition_by;
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 100';
  END IF;

  RETURN QUERY
  WITH events AS (
    SELECT
      e.request_started_at, e.caller, e.response_model, e.requested_model,
      e.duration_ms, e.request_bytes, e.response_bytes, e.status, p.tier,
      CASE WHEN p.id IS NULL THEN NULL ELSE
          (e.input_tokens::numeric / 1000000) * p.input_price_per_mtok
        + (e.output_tokens::numeric / 1000000) * p.output_price_per_mtok
        + (COALESCE(e.cache_creation_5m_tokens,0)::numeric / 1000000) * p.cache_write_5m_price_per_mtok
        + (COALESCE(e.cache_creation_1h_tokens,0)::numeric / 1000000) * p.cache_write_1h_price_per_mtok
        + (COALESCE(e.cache_read_tokens,0)::numeric / 1000000) * p.cache_read_price_per_mtok
      END AS calc_cost,
      o.outcome_type_id
    FROM mt_ai_usage_events e
    LEFT JOIN mt_model_pricing p
      ON p.provider = e.provider
     AND p.model_name = COALESCE(e.response_model, e.requested_model)
     AND e.request_started_at >= p.effective_from
     AND (p.effective_to IS NULL OR e.request_started_at < p.effective_to)
    -- Code-review fix: bound o.started_at to the period, matching
    -- mt_ai_cost_grouped('outcome_type')'s membership rule exactly —
    -- without this, a call whose outcome started in an earlier period
    -- could surface here as a "sample call" for an outcome type whose
    -- displayed Total/Completed/Sunk Cost (from mt_ai_cost_grouped)
    -- deliberately excludes that same call, an inconsistent example.
    LEFT JOIN mt_outcomes o
      ON o.outcome_id = e.outcome_id AND o.company_id = e.company_id AND o.app_id = e.app_id
     AND o.started_at >= p_period_start AND o.started_at < p_period_end
    WHERE e.company_id = p_company_id
      AND e.app_id = p_app_id
      AND e.request_started_at >= p_period_start
      AND e.request_started_at < p_period_end
  ),
  ranked AS (
    SELECT ev.*,
      CASE p_partition_by
        WHEN 'outcome_type' THEN ev.outcome_type_id
        WHEN 'caller' THEN ev.caller
        ELSE '__all__'
      END AS pkey,
      ROW_NUMBER() OVER (
        PARTITION BY (CASE p_partition_by WHEN 'outcome_type' THEN ev.outcome_type_id WHEN 'caller' THEN ev.caller ELSE '__all__' END)
        ORDER BY (
          CASE p_order_by
            WHEN 'duration' THEN ev.duration_ms
            WHEN 'size' THEN COALESCE(ev.request_bytes,0) + COALESCE(ev.response_bytes,0)
            WHEN 'cost' THEN ev.calc_cost
          END
        ) DESC NULLS LAST
      ) AS rn
    FROM events ev
    WHERE p_partition_by IS DISTINCT FROM 'outcome_type' OR ev.outcome_type_id IS NOT NULL
  )
  SELECT pkey, request_started_at, caller, response_model, requested_model,
    duration_ms, request_bytes, response_bytes, status, calc_cost, tier
  FROM ranked
  WHERE rn <= p_limit
  ORDER BY pkey, rn;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.mt_ai_cost_top_calls(uuid, text, timestamptz, timestamptz, text, int, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mt_ai_cost_top_calls(uuid, text, timestamptz, timestamptz, text, int, text)
  TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- Verify: flat top-10 by duration should be a strict superset check —
-- every row it returns should also appear near the top of a manual
-- ORDER BY duration_ms DESC LIMIT 10 over mt_ai_usage_events for the same
-- window.
-- SELECT * FROM mt_ai_cost_top_calls('<company>','<app>','2026-08-01','2026-09-01','duration',10,NULL);

-- ═══════════════════════════════════════════════════════════════════
-- E — mt_ai_cost_opportunities — ports actComputeType1()/actComputeType2()
-- (scripts/cost-tower.js). Type 3 (unassigned attribution) is NOT
-- included here — it's already available for free from
-- mt_ai_cost_grouped('feature')'s null-product_id/non-cross-product
-- bucket, computed client-side exactly as actComputeType3() does today.
--
-- Behavior change from today (per explicit approval): Type 1's candidate-
-- tier per-token rate now comes directly from mt_model_pricing's
-- currently-effective row(s) for (provider, candidate tier), averaged if
-- more than one model qualifies — NOT from other same-period rows that
-- happened to be priced at that tier (the old empirical workaround, kept
-- only because this app previously had no direct catalog query). This is
-- more robust (works even when the period has zero rows at the candidate
-- tier) but can shift the displayed savings number vs. what today's build
-- shows for the same period.
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.mt_ai_cost_opportunities(
  p_company_id uuid, p_app_id text,
  p_period_start timestamp with time zone, p_period_end timestamp with time zone
)
RETURNS TABLE(
  opp_type int, feature text, savings numeric, segment_count bigint,
  current_tier text, candidate_tier text, outlier_factor numeric,
  baseline_version text, current_version text,
  baseline_avg_cost numeric, current_avg_cost numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
-- RETURNS TABLE's output columns (feature, savings, segment_count,
-- current_tier, candidate_tier, outlier_factor, baseline_version,
-- current_version, baseline_avg_cost, current_avg_cost) are also the exact
-- column names most of the CTEs below produce and reference unqualified —
-- see mt_ai_cost_summary's identical comment above.
#variable_conflict use_column
BEGIN
  IF NOT _cost_tower_can_access(p_company_id, p_app_id) THEN
    RAISE EXCEPTION 'Not authorized to read opportunities for company %', p_company_id;
  END IF;

  RETURN QUERY
  -- ── Type 1: intake routing ──
  -- Pool every row by feature (_act_feature_of, Part A), order each
  -- feature's rows by request_bytes ascending, take the smallest 40%
  -- (OPPORTUNITY_SMALL_SEGMENT_PCT), keep only priced rows in that
  -- segment, find the segment's most common tier, and — if a cheaper
  -- tier exists — project what the segment would have cost at that
  -- tier's current catalog rate.
  WITH base AS (
    SELECT e.*, _act_feature_of(e.caller) AS feature, p.id AS pricing_id,
      p.tier,
      CASE WHEN p.id IS NULL THEN NULL ELSE
          (e.input_tokens::numeric / 1000000) * p.input_price_per_mtok
        + (e.output_tokens::numeric / 1000000) * p.output_price_per_mtok
        + (COALESCE(e.cache_creation_5m_tokens,0)::numeric / 1000000) * p.cache_write_5m_price_per_mtok
        + (COALESCE(e.cache_creation_1h_tokens,0)::numeric / 1000000) * p.cache_write_1h_price_per_mtok
        + (COALESCE(e.cache_read_tokens,0)::numeric / 1000000) * p.cache_read_price_per_mtok
      END AS calc_cost
    FROM mt_ai_usage_events e
    LEFT JOIN mt_model_pricing p
      ON p.provider = e.provider
     AND p.model_name = COALESCE(e.response_model, e.requested_model)
     AND e.request_started_at >= p.effective_from
     AND (p.effective_to IS NULL OR e.request_started_at < p.effective_to)
    WHERE e.company_id = p_company_id AND e.app_id = p_app_id
      AND e.request_started_at >= p_period_start AND e.request_started_at < p_period_end
  ),
  feature_counts AS (
    SELECT feature, COUNT(*) AS n FROM base GROUP BY feature
  ),
  segment AS (
    SELECT b.*, ROW_NUMBER() OVER (PARTITION BY b.feature ORDER BY COALESCE(b.request_bytes,0) ASC) AS rn,
      fc.n
    FROM base b JOIN feature_counts fc ON fc.feature = b.feature
  ),
  segment_priced AS (
    -- 0.4 mirrors scripts/cost-tower.js's OPPORTUNITY_SMALL_SEGMENT_PCT —
    -- kept in sync by hand (same JS/SQL duplication _act_feature_of above
    -- already accepts); if that constant ever changes, this literal and
    -- its sibling in mt_ai_cost_opportunity_supporting_calls below must
    -- change with it, or the evidence sentence ("smallest N% of calls...")
    -- and the actual segment this query selects will silently disagree.
    SELECT * FROM segment
    WHERE rn <= GREATEST(1, ROUND(n * 0.4)) AND pricing_id IS NOT NULL
  ),
  tier_mode AS (
    SELECT feature, tier, COUNT(*) AS cnt,
      ROW_NUMBER() OVER (PARTITION BY feature ORDER BY COUNT(*) DESC, tier ASC) AS tier_rank
    FROM segment_priced
    GROUP BY feature, tier
  ),
  current_tier_by_feature AS (
    SELECT feature, tier AS current_tier FROM tier_mode WHERE tier_rank = 1
  ),
  candidate AS (
    SELECT ctf.feature, ctf.current_tier,
      CASE ctf.current_tier WHEN 'balanced' THEN 'economical' WHEN 'frontier' THEN 'balanced' ELSE NULL END AS candidate_tier
    FROM current_tier_by_feature ctf
  ),
  -- Provider is taken from the segment's own smallest-request_bytes
  -- priced row per feature, matching segment[0].provider in
  -- actComputeType1().
  feature_provider AS (
    SELECT DISTINCT ON (feature) feature, provider
    FROM segment_priced
    ORDER BY feature, rn ASC
  ),
  candidate_rate AS (
    SELECT c.feature, c.current_tier, c.candidate_tier,
      AVG(cp.input_price_per_mtok) AS cand_in_price,
      AVG(cp.output_price_per_mtok) AS cand_out_price
    FROM candidate c
    JOIN feature_provider fp ON fp.feature = c.feature
    JOIN mt_model_pricing cp
      ON cp.provider = fp.provider
     AND cp.tier = c.candidate_tier
     AND now() >= cp.effective_from
     AND (cp.effective_to IS NULL OR now() < cp.effective_to)
    WHERE c.candidate_tier IS NOT NULL
    GROUP BY c.feature, c.current_tier, c.candidate_tier
  ),
  type1_per_feature AS (
    SELECT
      sp.feature, cr.current_tier, cr.candidate_tier,
      COUNT(*) AS segment_count,
      SUM(sp.calc_cost) AS current_cost,
      SUM((sp.input_tokens::numeric/1000000)*cr.cand_in_price + (sp.output_tokens::numeric/1000000)*cr.cand_out_price) AS projected_cost
    FROM segment_priced sp
    JOIN candidate_rate cr ON cr.feature = sp.feature
    GROUP BY sp.feature, cr.current_tier, cr.candidate_tier
  ),
  type1_best AS (
    SELECT feature, current_tier, candidate_tier, segment_count,
      GREATEST(0, current_cost - projected_cost) AS savings,
      CASE WHEN projected_cost > 0 THEN (current_cost / segment_count) / (projected_cost / segment_count) ELSE NULL END AS outlier_factor
    FROM type1_per_feature
    WHERE current_cost - projected_cost > 0
    ORDER BY savings DESC
    LIMIT 1
  ),
  -- ── Type 2: prompt-version regression ──
  version_stats AS (
    SELECT feature, prompt_version,
      MIN(request_started_at) AS first_seen,
      COUNT(*) AS rows_count,
      AVG(calc_cost) FILTER (WHERE pricing_id IS NOT NULL) AS avg_cost
    FROM base
    WHERE prompt_version IS NOT NULL
    GROUP BY feature, prompt_version
  ),
  version_ordered AS (
    SELECT vs.*,
      ROW_NUMBER() OVER (PARTITION BY feature ORDER BY first_seen DESC) AS rn_desc
    FROM version_stats vs
  ),
  version_pair AS (
    SELECT cur.feature, cur.prompt_version AS current_version, cur.rows_count AS current_rows_count,
      cur.avg_cost AS current_avg_cost, base_v.prompt_version AS baseline_version, base_v.avg_cost AS baseline_avg_cost
    FROM version_ordered cur
    JOIN version_ordered base_v ON base_v.feature = cur.feature AND base_v.rn_desc = 2
    WHERE cur.rn_desc = 1
  ),
  type2_best AS (
    SELECT feature, current_version, baseline_version, current_avg_cost, baseline_avg_cost,
      current_rows_count AS segment_count,
      (current_avg_cost - baseline_avg_cost) * current_rows_count AS savings,
      CASE WHEN baseline_avg_cost > 0 THEN current_avg_cost / baseline_avg_cost ELSE NULL END AS outlier_factor
    FROM version_pair
    WHERE current_avg_cost IS NOT NULL AND baseline_avg_cost IS NOT NULL AND current_avg_cost > baseline_avg_cost
    ORDER BY savings DESC
    LIMIT 1
  )
  SELECT 1::int, feature::text, savings::numeric, segment_count::bigint, current_tier::text, candidate_tier::text, outlier_factor::numeric, NULL::text, NULL::text, NULL::numeric, NULL::numeric FROM type1_best
  UNION ALL
  SELECT 2::int, feature::text, savings::numeric, segment_count::bigint, NULL::text, NULL::text, outlier_factor::numeric, baseline_version::text, current_version::text, baseline_avg_cost::numeric, current_avg_cost::numeric FROM type2_best;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.mt_ai_cost_opportunities(uuid, text, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mt_ai_cost_opportunities(uuid, text, timestamptz, timestamptz)
  TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- Verify: run for a period known to have a Type 1 candidate today and
-- compare feature/segment_count against the current build's console
-- output — the savings NUMBER is expected to differ (catalog-rate
-- change, approved), but the WINNING feature and segment_count should
-- match unless the underlying data itself changed.
-- SELECT * FROM mt_ai_cost_opportunities('<company>','<app>','2026-08-01','2026-09-01');

-- ═══════════════════════════════════════════════════════════════════
-- E-2 — mt_ai_cost_opportunity_supporting_calls — lazy, on-demand detail
-- for Type 1's "View Supporting Calls" modal (actOpenOppModal). Re-runs
-- the same segment selection as Part E, scoped to one feature, returning
-- up to p_limit rows ordered by request_bytes ascending (matching
-- segment.slice(0, 5) in actComputeType1()). Called only when the modal
-- opens, not as part of the main opportunities fetch.
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.mt_ai_cost_opportunity_supporting_calls(
  p_company_id uuid, p_app_id text,
  p_period_start timestamp with time zone, p_period_end timestamp with time zone,
  p_feature text, p_limit int DEFAULT 5
)
RETURNS TABLE(
  request_started_at timestamp with time zone, request_bytes integer,
  duration_ms integer, tier text, calculated_cost numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
-- RETURNS TABLE's output columns (request_started_at, request_bytes,
-- duration_ms, tier) collide with the same-named mt_ai_usage_events/
-- mt_model_pricing columns referenced (unqualified, via the `base`/
-- `ranked`/`segment` CTEs) in the final SELECT — see mt_ai_cost_summary's
-- identical comment above.
#variable_conflict use_column
BEGIN
  IF NOT _cost_tower_can_access(p_company_id, p_app_id) THEN
    RAISE EXCEPTION 'Not authorized to read opportunity detail for company %', p_company_id;
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT e.request_started_at, e.request_bytes, e.duration_ms, p.tier, p.id AS pricing_id,
      CASE WHEN p.id IS NULL THEN NULL ELSE
          (e.input_tokens::numeric / 1000000) * p.input_price_per_mtok
        + (e.output_tokens::numeric / 1000000) * p.output_price_per_mtok
        + (COALESCE(e.cache_creation_5m_tokens,0)::numeric / 1000000) * p.cache_write_5m_price_per_mtok
        + (COALESCE(e.cache_creation_1h_tokens,0)::numeric / 1000000) * p.cache_write_1h_price_per_mtok
        + (COALESCE(e.cache_read_tokens,0)::numeric / 1000000) * p.cache_read_price_per_mtok
      END AS calc_cost
    FROM mt_ai_usage_events e
    LEFT JOIN mt_model_pricing p
      ON p.provider = e.provider
     AND p.model_name = COALESCE(e.response_model, e.requested_model)
     AND e.request_started_at >= p.effective_from
     AND (p.effective_to IS NULL OR e.request_started_at < p.effective_to)
    WHERE e.company_id = p_company_id AND e.app_id = p_app_id
      AND e.request_started_at >= p_period_start AND e.request_started_at < p_period_end
      AND _act_feature_of(e.caller) = p_feature
  ),
  ranked AS (
    SELECT b.*, ROW_NUMBER() OVER (ORDER BY COALESCE(b.request_bytes,0) ASC) AS rn,
      COUNT(*) OVER () AS n
    FROM base b
  ),
  segment AS (
    -- 0.4 must match mt_ai_cost_opportunities' own segment_priced CTE and
    -- scripts/cost-tower.js's OPPORTUNITY_SMALL_SEGMENT_PCT — this modal's
    -- "up to 5 example calls" must come from the SAME segment the winning
    -- opportunity's savings figure was computed from, not a differently-
    -- sized one.
    SELECT * FROM ranked WHERE rn <= GREATEST(1, ROUND(n * 0.4)) AND pricing_id IS NOT NULL
  )
  SELECT request_started_at, request_bytes, duration_ms, tier, calc_cost
  FROM segment
  ORDER BY COALESCE(request_bytes,0) ASC
  LIMIT p_limit;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.mt_ai_cost_opportunity_supporting_calls(uuid, text, timestamptz, timestamptz, text, int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mt_ai_cost_opportunity_supporting_calls(uuid, text, timestamptz, timestamptz, text, int)
  TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════
-- F — mt_ai_cost_events_list — add explicit ORDER BY + pagination.
-- This ADDS total_row_count to RETURNS TABLE — a return-shape change,
-- which CREATE OR REPLACE cannot apply to an existing function (Postgres
-- rejects it: "cannot change return type of existing function"). Requires
-- DROP + CREATE, same as every prior return-shape change to this same
-- function (sql/ai-cost-tower-trace-layer-payload-read-rpc.sql's own
-- Part D did the same for the same reason). Bare DROP FUNCTION, not IF
-- EXISTS — if this signature doesn't match what's actually live, this
-- must fail loudly rather than silently no-op while everything downstream
-- checks the wrong thing. Request Explorer's flat table is the only
-- remaining caller that needs individual rows — it now gets deterministic,
-- most-recent-first paging instead of an unbounded fetch that silently
-- stopped wherever PostgREST's cap happened to land.
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

DROP FUNCTION public.mt_ai_cost_events_list(uuid, text, timestamptz, timestamptz);

CREATE FUNCTION public.mt_ai_cost_events_list(
  p_company_id uuid, p_app_id text,
  p_period_start timestamp with time zone, p_period_end timestamp with time zone,
  p_limit int DEFAULT 1000, p_offset int DEFAULT 0
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
   units_generated integer, usage_event_id uuid, trace_id uuid,
   total_row_count bigint
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_can_view_payloads boolean;
BEGIN
  IF NOT _cost_tower_can_access(p_company_id, p_app_id) THEN
    RAISE EXCEPTION 'Not authorized to read cost events for company %', p_company_id;
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 1000';
  END IF;

  v_can_view_payloads := _cost_tower_can_manage_governance(p_company_id, p_app_id);

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
    e.outcome_id, e.units_generated,
    CASE WHEN v_can_view_payloads THEN e.id ELSE NULL END AS usage_event_id,
    CASE WHEN v_can_view_payloads THEN e.trace_id ELSE NULL END AS trace_id,
    COUNT(*) OVER () AS total_row_count
  FROM mt_ai_usage_events e
  LEFT JOIN mt_model_pricing p
    ON p.provider = e.provider
   AND p.model_name = COALESCE(e.response_model, e.requested_model)
   AND e.request_started_at >= p.effective_from
   AND (p.effective_to IS NULL OR e.request_started_at < p.effective_to)
  WHERE e.company_id = p_company_id
    AND e.app_id = p_app_id
    AND e.request_started_at >= p_period_start
    AND e.request_started_at < p_period_end
  ORDER BY e.request_started_at DESC
  LIMIT p_limit OFFSET p_offset;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.mt_ai_cost_events_list(uuid, text, timestamptz, timestamptz, int, int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mt_ai_cost_events_list(uuid, text, timestamptz, timestamptz, int, int)
  TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- Verify: total_row_count on every returned row should equal 1,136 for
-- the Aug 2026 dev window used earlier in this investigation, regardless
-- of p_limit/p_offset — it's a window-function count over the full
-- filtered set, not the page size.
-- SELECT total_row_count, count(*) FROM mt_ai_cost_events_list('<company>','<app>','2026-08-01','2026-09-01',50,0) GROUP BY 1;

-- ═══════════════════════════════════════════════════════════════════
-- G — mt_outcomes_list — add explicit ORDER BY. Return shape unchanged,
-- safe CREATE OR REPLACE. Dev's current volume is 1 row for the checked
-- window, so this table is not actively hitting any cap today — this is
-- hardening, not a fix for an observed bug: if it's ever capped, the
-- truncation now drops the OLDEST rows deterministically, never an
-- arbitrary subset.
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

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
    AND o.started_at < p_period_end
  ORDER BY o.started_at DESC;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.mt_outcomes_list(uuid, text, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mt_outcomes_list(uuid, text, timestamptz, timestamptz)
  TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════
-- H — post-migration verification (run after every section above has
-- committed)
-- ═══════════════════════════════════════════════════════════════════

-- 1. Every new/changed function exists with the expected signature.
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p
WHERE p.proname IN ('_act_feature_of','mt_ai_cost_summary','mt_ai_cost_grouped',
                    'mt_ai_cost_top_calls','mt_ai_cost_opportunities',
                    'mt_ai_cost_opportunity_supporting_calls',
                    'mt_ai_cost_events_list','mt_outcomes_list')
ORDER BY p.proname;

-- 2. Grants — authenticated can execute, anon cannot, for every new function.
SELECT p.proname,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute
FROM pg_proc p
WHERE p.proname IN ('_act_feature_of','mt_ai_cost_summary','mt_ai_cost_grouped',
                    'mt_ai_cost_top_calls','mt_ai_cost_opportunities',
                    'mt_ai_cost_opportunity_supporting_calls',
                    'mt_ai_cost_events_list','mt_outcomes_list');
-- expect: authenticated=true, anon=false for every row.

-- 3. Owner-can-actually-read-the-tables-it-queries check.
WITH fn AS (
  SELECT p.oid::regprocedure::text AS function_signature, p.proowner::regrole::text AS owner_name
  FROM pg_proc p
  WHERE p.proname IN ('mt_ai_cost_summary','mt_ai_cost_grouped','mt_ai_cost_top_calls',
                      'mt_ai_cost_opportunities','mt_ai_cost_opportunity_supporting_calls',
                      'mt_ai_cost_events_list','mt_outcomes_list')
)
SELECT function_signature, owner_name,
  has_table_privilege(owner_name, 'public.mt_ai_usage_events', 'SELECT') AS can_select_usage_events,
  has_table_privilege(owner_name, 'public.mt_model_pricing', 'SELECT') AS can_select_model_pricing,
  has_table_privilege(owner_name, 'public.mt_outcomes', 'SELECT') AS can_select_outcomes,
  has_table_privilege(owner_name, 'public.mt_outcome_types', 'SELECT') AS can_select_outcome_types
FROM fn;

-- 4. Cross-check mt_ai_cost_summary's total_cost against the OLD
-- mt_ai_cost_events_list (now paginated) summed across every page — the
-- two must agree exactly, since the summary RPC's formula is a verbatim
-- copy of the row-level formula.
-- (Run client-side or via a scripted loop — not a single SQL statement,
-- since it requires paging through all of mt_ai_cost_events_list.)
