-- ═══════════════════════════════════════════════════════════════════
-- AI Cost Control Tower: Build B Part 1 addendum
-- Run in Supabase SQL editor, AFTER sql/ai-cost-tower.sql. DEV FIRST
-- (pgt-dev), verify, then prod. Per AI_EDITING_RULES.md: NOT run by
-- Claude Code. Write to disk only: Nethaji runs this on his own timeline.
--
-- Purpose: mt_ai_cost_events_list() is missing cache_read_price_per_mtok,
-- needed for Section 5.5's "Estimated Cache Savings" formula
-- (SUM(cache_read_tokens) × (input_price_per_mtok − cache_read_price_per_mtok)).
-- input_price_per_mtok / output_price_per_mtok are already returned by the
-- live function (added during the v1 build, ahead of the spec text) —
-- verified directly against sql/ai-cost-tower.sql before drafting this,
-- not assumed from the spec. Only cache_read_price_per_mtok is actually new.
-- ═══════════════════════════════════════════════════════════════════

-- CREATE OR REPLACE FUNCTION cannot change a function's RETURNS TABLE
-- signature — PostgreSQL rejects that with "cannot change return type of
-- existing function." Adding a column to RETURNS TABLE is exactly that kind
-- of change, so the function must be dropped and recreated, not replaced.
-- Safe here: GRANT EXECUTE is reissued immediately below in the same
-- transaction as the CREATE, and no other object references this
-- function's return type directly.
DROP FUNCTION IF EXISTS mt_ai_cost_events_list(UUID, TIMESTAMPTZ, TIMESTAMPTZ);

CREATE FUNCTION mt_ai_cost_events_list(
  p_company_id   UUID,
  p_period_start TIMESTAMPTZ,
  p_period_end   TIMESTAMPTZ
)
RETURNS TABLE (
  request_started_at TIMESTAMPTZ,
  product_id          UUID,
  user_id              UUID,
  user_role_at_call    TEXT,
  caller               TEXT,
  prompt_version       TEXT,
  provider             TEXT,
  requested_model      TEXT,
  response_model       TEXT,
  selection_rule       TEXT,
  input_tokens         INTEGER,
  output_tokens        INTEGER,
  cache_creation_5m_tokens INTEGER,
  cache_creation_1h_tokens INTEGER,
  cache_read_tokens    INTEGER,
  status               TEXT,
  error_type           TEXT,
  failure_phase        TEXT,
  duration_ms          INTEGER,
  request_bytes        INTEGER,
  response_bytes       INTEGER,
  tier                 TEXT,
  input_price_per_mtok      NUMERIC,
  output_price_per_mtok     NUMERIC,
  cache_read_price_per_mtok NUMERIC,
  calculated_cost      NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT _cost_tower_is_admin(p_company_id) THEN
    RAISE EXCEPTION 'Not authorized to read cost events for company %', p_company_id;
  END IF;

  RETURN QUERY
  SELECT
    e.request_started_at, e.product_id, e.user_id, e.user_role_at_call,
    e.caller, e.prompt_version, e.provider, e.requested_model, e.response_model,
    e.selection_rule, e.input_tokens, e.output_tokens,
    e.cache_creation_5m_tokens, e.cache_creation_1h_tokens, e.cache_read_tokens,
    e.status, e.error_type, e.failure_phase, e.duration_ms, e.request_bytes, e.response_bytes,
    p.tier, p.input_price_per_mtok, p.output_price_per_mtok, p.cache_read_price_per_mtok,
    CASE WHEN p.id IS NULL THEN NULL ELSE
        (e.input_tokens::numeric / 1000000) * p.input_price_per_mtok
      + (e.output_tokens::numeric / 1000000) * p.output_price_per_mtok
      + (COALESCE(e.cache_creation_5m_tokens,0)::numeric / 1000000) * p.cache_write_5m_price_per_mtok
      + (COALESCE(e.cache_creation_1h_tokens,0)::numeric / 1000000) * p.cache_write_1h_price_per_mtok
      + (COALESCE(e.cache_read_tokens,0)::numeric / 1000000) * p.cache_read_price_per_mtok
    END AS calculated_cost
  FROM mt_ai_usage_events e
  LEFT JOIN mt_model_pricing p
    ON p.provider = e.provider
   AND p.model_name = COALESCE(e.response_model, e.requested_model)
   AND e.request_started_at >= p.effective_from
   AND (p.effective_to IS NULL OR e.request_started_at < p.effective_to)
  WHERE e.company_id = p_company_id
    AND e.request_started_at >= p_period_start
    AND e.request_started_at < p_period_end;
END;
$$;

GRANT EXECUTE ON FUNCTION mt_ai_cost_events_list(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

-- ─── Post-flight validation ────────────────────────────────────────
-- 1. Confirm the new column is actually present and populated for a priced row:
-- SELECT cache_read_price_per_mtok FROM mt_ai_cost_events_list('<company>', now() - interval '30 days', now()) LIMIT 5;
--
-- 2. Confirm DROP+CREATE preserved the authorization behavior (a non-admin
--    call still raises, same as before this addendum):
-- (call as a non-admin session — expect the existing "Not authorized" exception)
