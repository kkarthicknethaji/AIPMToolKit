-- AI Cost Control Tower — mt_ai_cost_top_calls: bound the outcome_type
-- partition to the reporting period (v9.37.01 code-review finding)
--
-- Not run by Claude Code — apply manually, dev first, then prod.
--
-- Standalone (not the full migration file) on purpose: the full
-- ai-cost-tower-period-aggregation-migration.sql is no longer safe to
-- replay wholesale once it's already been applied once — its Part F does
-- a bare DROP FUNCTION on mt_ai_cost_events_list's OLD 4-argument
-- signature, which no longer exists after the first successful run
-- (that run already replaced it with the 6-argument p_limit/p_offset
-- version) — replaying the whole file now fails with "function ...
-- does not exist" at that DROP. This file re-applies only the one
-- function this fix actually touches.
--
-- THE BUG: mt_ai_cost_top_calls's outcome_type partition joined
-- mt_outcomes with no bound on the outcome's own started_at, unlike its
-- sibling mt_ai_cost_grouped('outcome_type'), which requires
-- mo.started_at >= p_period_start AND mo.started_at < p_period_end. A
-- call tied to an outcome that started in an earlier period could
-- surface here as an Outcome-Based Cost "sample call" for a type whose
-- displayed Total/Completed/Sunk Cost (from mt_ai_cost_grouped) correctly
-- excludes that same call — a visible reconciliation mismatch on screen.
--
-- THE FIX: add the identical period bound to this function's own
-- mt_outcomes join. Plain CREATE OR REPLACE — signature and RETURNS
-- TABLE shape are both unchanged, only the join condition changes.

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
-- `events`/`ranked` CTEs) throughout — kept from the prior fix pass.
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
    -- THE FIX: bound o.started_at to the period, matching
    -- mt_ai_cost_grouped('outcome_type')'s membership rule exactly.
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

-- ═══════════════════════════════════════════════════════════════════
-- Verification
-- ═══════════════════════════════════════════════════════════════════

-- 1. Signature unchanged.
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p WHERE p.proname = 'mt_ai_cost_top_calls';

-- 2. Functional check — for an outcome_type with known cross-boundary
-- activity, sample calls should now only include calls whose outcome
-- started inside the given period.
-- SELECT * FROM mt_ai_cost_top_calls('<company>','<app>','2026-08-01','2026-09-01','cost',3,'outcome_type');
