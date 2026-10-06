-- ═══════════════════════════════════════════════════════════════════
-- AI Cost Control Tower: cache-token cost double-counting fix
-- Run in Supabase SQL editor, AFTER sql/ai-cost-tower-build-b-addendum.sql.
-- DEV FIRST (pgt-dev), verify, then prod. Per AI_EDITING_RULES.md: NOT run
-- by Claude Code. Write to disk only: Nethaji runs this on his own timeline.
--
-- Purpose: found by /code-review of Build B Part 1. calculated_cost's
-- formula bills e.input_tokens at full input_price_per_mtok AND
-- e.cache_read_tokens at cache_read_price_per_mtok as two independent
-- additive buckets. That's correct for Anthropic, whose input_tokens
-- field genuinely EXCLUDES cache reads (they're a separate billing
-- bucket). It double-bills for OpenAI and Gemini, whose input_tokens /
-- total_input_tokens fields already INCLUDE their cached-token subset
-- (OpenAI's input_tokens_details.cached_tokens, Gemini's
-- total_cached_tokens are breakdowns of the total, not additions to it,
-- per proxy/providerAdapters.js's own adapter comments and both
-- providers' documented caching/billing model). Once cache_read_tokens
-- is non-zero for a non-Anthropic call, the old formula charges the
-- cached portion once at full price (inside input_tokens) and again at
-- the cache-read rate — this fix subtracts the cached amount from
-- input_tokens before pricing it, for non-Anthropic providers only.
--
-- This is a CREATE OR REPLACE, not a DROP+CREATE: only the function body
-- changes here, not RETURNS TABLE's column list, so the "cannot change
-- return type" restriction from the prior addendum does not apply.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION mt_ai_cost_events_list(
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
        -- Anthropic's input_tokens excludes cache reads (bill it in full);
        -- OpenAI/Gemini's input_tokens already includes them (bill only the
        -- non-cached remainder at full price, GREATEST(...,0) guards against
        -- a cache_read_tokens > input_tokens data anomaly going negative).
        (GREATEST(
           CASE WHEN e.provider = 'anthropic'
                THEN e.input_tokens
                ELSE e.input_tokens - COALESCE(e.cache_read_tokens, 0)
           END, 0)::numeric / 1000000) * p.input_price_per_mtok
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
-- 1. For an Anthropic row with no cache activity, confirm calculated_cost
--    is UNCHANGED from before this fix (this fix must not alter Anthropic's
--    existing correct behavior):
-- SELECT calculated_cost FROM mt_ai_cost_events_list('<company>', '<period_start>', '<period_end>')
-- WHERE provider = 'anthropic' LIMIT 5;
--
-- 2. Once an OpenAI or Gemini call has cache_read_tokens > 0, confirm
--    calculated_cost dropped versus what it showed before this fix
--    (it was previously overstated by exactly cache_read_tokens/1e6 *
--    input_price_per_mtok for that row):
-- SELECT provider, input_tokens, cache_read_tokens, input_price_per_mtok, calculated_cost
-- FROM mt_ai_cost_events_list('<company>', '<period_start>', '<period_end>')
-- WHERE provider IN ('openai','gemini') AND cache_read_tokens > 0 LIMIT 5;
