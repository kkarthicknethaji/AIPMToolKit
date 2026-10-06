-- AI Cost Control Tower — fix "column reference is ambiguous" errors
-- (v9.37 period-aggregation migration + one pre-existing Trace Layer RPC)
--
-- Not run by Claude Code — apply manually, dev first, then prod.
--
-- THE BUG: several RETURNS TABLE(...) functions name an output column the
-- same as a real source-table column the function body references
-- unqualified (e.g. mt_ai_cost_summary's `cache_read_tokens` output vs.
-- mt_ai_usage_events.cache_read_tokens, read bare inside the function via
-- the `events` CTE). Postgres's default plpgsql.variable_conflict='error'
-- then refuses to guess whether a bare reference means the OUT parameter
-- or the table/CTE column, and raises "column reference ... is ambiguous"
-- at CALL time (this compiles fine — the error only surfaces once the
-- query plan actually runs), which is what live-app testing surfaced as
-- every widget silently returning empty/zero data.
--
-- THE FIX: add `#variable_conflict use_column` as the function's first
-- declaration — the documented, standard PL/pgSQL resolution for exactly
-- this situation (Postgres docs §43.11.1) — telling the planner to always
-- prefer the table/CTE column over the OUT-parameter variable for any
-- bare reference. No query logic changes; every formula is unchanged
-- character-for-character from the original migration.
--
-- Affects 5 functions from today's mt_ai_cost_summary/mt_ai_cost_grouped/
-- mt_ai_cost_top_calls/mt_ai_cost_opportunities/
-- mt_ai_cost_opportunity_supporting_calls migration, plus one pre-existing
-- function this bug pattern already existed in but was never live-tested
-- until now: mt_ai_trace_detail_list (its `capped_traces` CTE selects a
-- bare `trace_id`, which collides with its own `trace_id uuid` output
-- column — sql/ai-cost-tower-trace-layer-period-boundary-fix.sql).
-- mt_ai_cost_events_list, mt_outcomes_list, and mt_ai_cost_by_agent are
-- NOT affected — every reference in their bodies is already alias-
-- qualified (e.g. `e.request_started_at`, not bare `request_started_at`).
--
-- Every statement below is a plain CREATE OR REPLACE — no signature or
-- RETURNS TABLE shape changes, so this is safe to run even though
-- mt_ai_cost_events_list itself required DROP+CREATE in the original
-- migration for an unrelated reason (that function is untouched here).

-- ═══════════════════════════════════════════════════════════════════
-- 1 — mt_ai_cost_summary
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

NOTIFY pgrst, 'reload schema';

COMMIT;

-- Verify: this is the exact check that surfaced the original bug — should
-- now return 1136, not error and not 1000.
-- SELECT total_calls FROM mt_ai_cost_summary('<company>','<app>','2026-08-01','2026-09-01');

-- ═══════════════════════════════════════════════════════════════════
-- 2 — mt_ai_cost_grouped
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
  sample_tier text, sample_user_role text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
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

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════
-- 3 — mt_ai_cost_top_calls
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

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════
-- 4 — mt_ai_cost_opportunities
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
#variable_conflict use_column
BEGIN
  IF NOT _cost_tower_can_access(p_company_id, p_app_id) THEN
    RAISE EXCEPTION 'Not authorized to read opportunities for company %', p_company_id;
  END IF;

  RETURN QUERY
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
    -- kept in sync by hand; if that constant ever changes, this literal
    -- and its sibling in mt_ai_cost_opportunity_supporting_calls below
    -- must change with it, or the evidence sentence ("smallest N% of
    -- calls...") and the actual segment this query selects will silently
    -- disagree.
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

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════
-- 5 — mt_ai_cost_opportunity_supporting_calls
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

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════
-- 6 — mt_ai_trace_detail_list (pre-existing, unrelated to today's
-- migration — same bug pattern, same fix; see file header)
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.mt_ai_trace_detail_list(
  p_company_id     uuid,
  p_app_id         text,
  p_period_start   timestamp with time zone,
  p_period_end     timestamp with time zone
)
 RETURNS TABLE(
   trace_id           uuid,
   agent_name         text,
   client_trace_id    text,
   trace_started_at   timestamptz,
   trace_completed_at timestamptz,
   outcome_id         uuid,
   span_id            uuid,
   parent_span_id     uuid,
   span_type          text,
   tool_name          text,
   usage_event_id     uuid,
   sequence_order     integer,
   attempt_number     integer,
   span_status        text,
   span_started_at    timestamptz,
   span_duration_ms   integer,
   calculated_cost    numeric,
   request_bytes      integer,
   response_bytes     integer
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  IF NOT _cost_tower_can_manage_governance(p_company_id, p_app_id) THEN
    RAISE EXCEPTION 'Not authorized to read trace detail for company %', p_company_id;
  END IF;

  RETURN QUERY
  WITH period_spans AS (
    SELECT
      s.trace_id, s.span_id, s.parent_span_id, s.span_type, s.tool_name, s.usage_event_id,
      s.sequence_order, s.attempt_number, s.status AS span_status, s.started_at AS span_started_at,
      s.duration_ms AS span_duration_ms
    FROM mt_ai_spans s
    JOIN mt_ai_traces t ON t.trace_id = s.trace_id
    WHERE t.company_id = p_company_id
      AND t.app_id = p_app_id
      AND s.started_at >= p_period_start
      AND s.started_at < p_period_end
  ),
  capped_traces AS (
    SELECT trace_id, MAX(span_started_at) AS most_recent_span_at
    FROM period_spans
    GROUP BY trace_id
    ORDER BY MAX(span_started_at) DESC
    LIMIT 100
  )
  SELECT
    t.trace_id, t.agent_name, t.client_trace_id, t.started_at, t.completed_at, t.outcome_id,
    ps.span_id, ps.parent_span_id, ps.span_type, ps.tool_name, ps.usage_event_id,
    ps.sequence_order, ps.attempt_number, ps.span_status, ps.span_started_at, ps.span_duration_ms,
    CASE WHEN e.id IS NULL OR p.id IS NULL THEN NULL ELSE
        (e.input_tokens::numeric / 1000000) * p.input_price_per_mtok
      + (e.output_tokens::numeric / 1000000) * p.output_price_per_mtok
      + (COALESCE(e.cache_creation_5m_tokens,0)::numeric / 1000000) * p.cache_write_5m_price_per_mtok
      + (COALESCE(e.cache_creation_1h_tokens,0)::numeric / 1000000) * p.cache_write_1h_price_per_mtok
      + (COALESCE(e.cache_read_tokens,0)::numeric / 1000000) * p.cache_read_price_per_mtok
    END,
    e.request_bytes, e.response_bytes
  FROM capped_traces ct
  JOIN period_spans ps ON ps.trace_id = ct.trace_id
  JOIN mt_ai_traces t ON t.trace_id = ct.trace_id
  LEFT JOIN mt_ai_usage_events e ON e.id = ps.usage_event_id
  LEFT JOIN mt_model_pricing p
    ON p.provider = e.provider
   AND p.model_name = COALESCE(e.response_model, e.requested_model)
   AND e.request_started_at >= p.effective_from
   AND (p.effective_to IS NULL OR e.request_started_at < p.effective_to)
  ORDER BY ct.most_recent_span_at DESC, ps.sequence_order ASC;
END;
$function$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════
-- Verification
-- ═══════════════════════════════════════════════════════════════════

-- 1. All 6 still have the same signatures as before this fix (no shape
-- change happened — only #variable_conflict was added).
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p
WHERE p.proname IN ('mt_ai_cost_summary','mt_ai_cost_grouped','mt_ai_cost_top_calls',
                    'mt_ai_cost_opportunities','mt_ai_cost_opportunity_supporting_calls',
                    'mt_ai_trace_detail_list')
ORDER BY p.proname;

-- 2. Functional check — every one of these should now return data (or an
-- empty set), never "column reference ... is ambiguous".
-- SELECT * FROM mt_ai_cost_summary('<company>','<app>','2026-08-01','2026-09-01');
-- SELECT * FROM mt_ai_cost_grouped('<company>','<app>','2026-08-01','2026-09-01','feature');
-- SELECT * FROM mt_ai_cost_top_calls('<company>','<app>','2026-08-01','2026-09-01','duration',10,NULL);
-- SELECT * FROM mt_ai_cost_opportunities('<company>','<app>','2026-08-01','2026-09-01');
-- SELECT * FROM mt_ai_trace_detail_list('<company>','<app>','2026-08-01','2026-09-01');
