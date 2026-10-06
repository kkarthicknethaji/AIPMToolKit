-- ═══════════════════════════════════════════════════════════════════
-- AI Cost Control Tower: v1 data model
-- Run in Supabase SQL editor. DEV FIRST (pgt-dev), verify, then prod.
-- Per AI_EDITING_RULES.md: NOT run by Claude Code. Write to disk only:
-- Nethaji runs this against Supabase on his own timeline.
-- Idempotent throughout (CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT
-- EXISTS, CREATE OR REPLACE FUNCTION): safe to re-run.
--
-- Source: ai-cost-control-tower-v1-technical-spec.md, Section 8.5,
-- as reviewed and corrected during build (provider/error_type columns
-- added to mt_ai_cost_events_list per Section 8.0 / Section 11 item 19).
-- ═══════════════════════════════════════════════════════════════════

-- ─── mt_ai_budgets ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mt_ai_budgets (
  budget_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             UUID NOT NULL REFERENCES mt_companies(id) ON DELETE CASCADE,
  scope_type             TEXT NOT NULL DEFAULT 'overall' CHECK (scope_type IN ('overall')),
  -- scope_type is deliberately a single-value enum for v1 (Section 8.1):
  -- widen the CHECK when product/caller/model_tier/user_role scoping is
  -- actually built, not before.
  scope_id               UUID,
  period_type            TEXT NOT NULL DEFAULT 'monthly' CHECK (period_type IN ('monthly')),
  amount                 NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency               TEXT NOT NULL DEFAULT 'USD' CHECK (length(currency) = 3),
  warn_threshold_pct     NUMERIC(5,2) NOT NULL DEFAULT 80 CHECK (warn_threshold_pct > 0 AND warn_threshold_pct < 100),
  escalate_threshold_pct NUMERIC(5,2) NOT NULL DEFAULT 90 CHECK (escalate_threshold_pct > warn_threshold_pct AND escalate_threshold_pct <= 100),
  enforcement_mode       TEXT NOT NULL DEFAULT 'monitor' CHECK (enforcement_mode IN ('monitor','enforce')),
  action_on_breach       TEXT NOT NULL DEFAULT 'notify' CHECK (action_on_breach IN ('notify','restrict_tier','stop')),
  is_active              BOOLEAN NOT NULL DEFAULT true,
  created_by             UUID NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one active overall budget per company at a time: the
-- Budget Configuration form edits this one row, it does not accumulate a
-- new row per edit (Section 6.6).
CREATE UNIQUE INDEX IF NOT EXISTS mt_ai_budgets_one_active_overall_idx
  ON mt_ai_budgets (company_id, scope_type)
  WHERE is_active AND scope_type = 'overall';

ALTER TABLE mt_ai_budgets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE mt_ai_budgets FROM anon, authenticated;

-- ─── mt_ai_alerts ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mt_ai_alerts (
  alert_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id      UUID NOT NULL REFERENCES mt_ai_budgets(budget_id) ON DELETE CASCADE,
  threshold_type TEXT NOT NULL CHECK (threshold_type IN ('warn','escalate')),
  threshold_pct  NUMERIC(5,2) NOT NULL,
  current_spend  NUMERIC(12,2) NOT NULL,
  period_start   DATE NOT NULL,
  period_end     DATE NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_by UUID,
  acknowledged_at TIMESTAMPTZ,
  resolved_at     TIMESTAMPTZ,
  CONSTRAINT mt_ai_alerts_ack_consistency CHECK (
    (status = 'open' AND acknowledged_by IS NULL AND acknowledged_at IS NULL) OR
    (status IN ('acknowledged','resolved') AND acknowledged_by IS NOT NULL AND acknowledged_at IS NOT NULL)
  ),
  -- One alert per threshold per period: the dedupe rule from Section 6.6,
  -- enforced here, not left to application-layer discipline alone.
  UNIQUE (budget_id, threshold_type, period_start)
);

CREATE INDEX IF NOT EXISTS mt_ai_alerts_budget_idx ON mt_ai_alerts (budget_id);

ALTER TABLE mt_ai_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE mt_ai_alerts FROM anon, authenticated;

-- ─── mt_model_pricing: tier addition (existing table, additive only) ──

ALTER TABLE mt_model_pricing
  ADD COLUMN IF NOT EXISTS tier TEXT CHECK (tier IN ('economical','balanced','frontier'));

ALTER TABLE mt_model_pricing
  ADD COLUMN IF NOT EXISTS tier_sort_order INTEGER;

-- No RLS change here: mt_model_pricing keeps whatever access policy it
-- already has. This migration only adds two nullable columns.

-- Populate tier per model, using the confirmed CALLER_TIERS mapping
-- (lightweight -> economical, general -> balanced, premium -> frontier,
-- Section 7). Verify each model_name below against the live model list
-- before running, this is a template drafted against this spec's own
-- research, not a live schema dump taken at migration time.
-- UPDATE mt_model_pricing SET tier = 'economical', tier_sort_order = 1 WHERE model_name = '<lightweight-tier model>';
-- UPDATE mt_model_pricing SET tier = 'balanced',   tier_sort_order = 2 WHERE model_name = '<general-tier model>';
-- UPDATE mt_model_pricing SET tier = 'frontier',   tier_sort_order = 3 WHERE model_name = '<premium-tier model>';

-- ─── Pre-flight: confirm current access on the two pre-existing tables ─
-- Section 8.0 / Section 11 item 19: mt_ai_usage_events and mt_model_pricing
-- are written only by the service-role client today and have no confirmed
-- read grant for `authenticated`. Run this BEFORE the function below and
-- read the result, don't assume the answer:
--
-- SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
-- WHERE table_name IN ('mt_ai_usage_events','mt_model_pricing') AND grantee IN ('anon','authenticated');
--
-- If that returns any rows granting `authenticated` direct SELECT today,
-- decide explicitly whether to REVOKE them once the RPC below exists (so
-- there is exactly one, auditable read path), rather than leaving both a
-- direct grant and an RPC as two ways to read the same data.

-- ─── Internal authorization helper (not directly callable) ────────────

CREATE OR REPLACE FUNCTION _cost_tower_is_admin(p_company_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM mt_users_companies uc
    WHERE uc.company_id = p_company_id
      AND uc.user_id = current_app_user()
      AND uc.is_active
      AND uc.role = 'admin'
  );
$$;

REVOKE EXECUTE ON FUNCTION _cost_tower_is_admin(UUID) FROM PUBLIC, anon, authenticated;

-- ─── Read: usage events joined to pricing, for client-side aggregation ─
-- Section 8.0. Returns raw priced rows for a period; every grouping and
-- aggregate in the spec (Sections 4-6) is computed client-side in
-- scripts/cost-tower.js from this function's result, not in SQL.

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
  input_price_per_mtok  NUMERIC,
  output_price_per_mtok NUMERIC,
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
    p.tier, p.input_price_per_mtok, p.output_price_per_mtok,
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

-- ─── Budget: read and upsert ────────────────────────────────────────

CREATE OR REPLACE FUNCTION mt_ai_budget_get_active(p_company_id UUID)
RETURNS mt_ai_budgets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row mt_ai_budgets;
BEGIN
  IF NOT _cost_tower_is_admin(p_company_id) THEN
    RAISE EXCEPTION 'Not authorized to view budgets for company %', p_company_id;
  END IF;

  SELECT * INTO v_row FROM mt_ai_budgets
  WHERE company_id = p_company_id AND scope_type = 'overall' AND is_active
  LIMIT 1;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION mt_ai_budget_get_active(UUID) TO authenticated;

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
      action_on_breach = p_action_on_breach
  WHERE company_id = p_company_id AND scope_type = 'overall' AND is_active
  RETURNING * INTO v_row;

  IF v_row IS NULL THEN
    INSERT INTO mt_ai_budgets (
      company_id, scope_type, amount, currency,
      warn_threshold_pct, escalate_threshold_pct,
      enforcement_mode, action_on_breach, created_by
    ) VALUES (
      p_company_id, 'overall', p_amount, p_currency,
      p_warn_threshold_pct, p_escalate_threshold_pct,
      p_enforcement_mode, p_action_on_breach, v_caller
    )
    RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION mt_ai_budget_upsert(UUID, NUMERIC, TEXT, NUMERIC, NUMERIC, TEXT, TEXT) TO authenticated;

-- ─── Alerts: list and acknowledge ────────────────────────────────────
-- Alert INSERT (threshold-crossing detection, Section 6.6) is performed by
-- the opportunistic check piggybacked onto _insertAiUsageEvent() in
-- proxy/server.js, which already runs under the service role and bypasses
-- RLS, not by a user-callable RPC. Nothing below creates alerts, only
-- reads and acknowledges them.

CREATE OR REPLACE FUNCTION mt_ai_alerts_list(p_company_id UUID)
RETURNS SETOF mt_ai_alerts
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT a.* FROM mt_ai_alerts a
  JOIN mt_ai_budgets b ON b.budget_id = a.budget_id
  WHERE b.company_id = p_company_id
    AND _cost_tower_is_admin(p_company_id)
  ORDER BY a.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION mt_ai_alerts_list(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION mt_ai_alert_acknowledge(p_alert_id UUID)
RETURNS mt_ai_alerts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller  UUID := current_app_user();
  v_company UUID;
  v_row     mt_ai_alerts;
BEGIN
  SELECT b.company_id INTO v_company
  FROM mt_ai_alerts a JOIN mt_ai_budgets b ON b.budget_id = a.budget_id
  WHERE a.alert_id = p_alert_id;

  IF v_company IS NULL OR NOT _cost_tower_is_admin(v_company) THEN
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
$$;

GRANT EXECUTE ON FUNCTION mt_ai_alert_acknowledge(UUID) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════
-- Post-flight validation (run manually after applying, not by app code)
-- ═══════════════════════════════════════════════════════════════════

-- 1. Both tables exist with RLS enabled and no direct grants to anon/authenticated:
-- SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('mt_ai_budgets','mt_ai_alerts');
-- SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
-- WHERE table_name IN ('mt_ai_budgets','mt_ai_alerts') AND grantee IN ('anon','authenticated');
-- (expect zero rows from the second query: REVOKE ALL should mean exactly that)

-- 2. tier / tier_sort_order columns exist on mt_model_pricing:
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'mt_model_pricing' AND column_name IN ('tier','tier_sort_order');

-- 3. A direct SELECT against either new table fails for a normal authenticated
--    session (confirms REVOKE actually blocks direct access, not just RLS):
-- SELECT * FROM mt_ai_budgets LIMIT 1;  -- expect a permission error

-- 4. mt_ai_budget_upsert as an admin succeeds; the same call as a non-admin
--    (readonly or member role) raises the authorization exception.

-- 5. Calling mt_ai_budget_upsert twice for the same company updates the same
--    row rather than creating a second one (confirms the "one active overall
--    budget" behavior, not just the partial unique index catching a duplicate):
-- SELECT count(*) FROM mt_ai_budgets WHERE company_id = '<test company>' AND is_active;
-- -- expect exactly 1, both before and after a second upsert call

-- 6. The alert dedupe constraint actually rejects a second alert for the same
--    (budget_id, threshold_type, period_start) if inserted directly as service role:
-- INSERT INTO mt_ai_alerts (budget_id, threshold_type, threshold_pct, current_spend, period_start, period_end)
-- VALUES ('<test budget>', 'warn', 80, 1000, '2026-08-01', '2026-08-31');
-- -- run the identical statement a second time: expect a unique-violation error

-- 7. mt_ai_cost_events_list returns rows for an admin, joined correctly to
--    pricing (spot-check calculated_cost against a manual calculation for
--    one known row), and raises the authorization exception for a non-admin.

-- 8. Whatever the pre-flight check above found about existing grants on
--    mt_ai_usage_events / mt_model_pricing, confirm the resolved state matches
--    what was actually decided (either grants were left alone with a stated
--    reason, or revoked in favor of the RPC being the sole read path):
-- SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
-- WHERE table_name IN ('mt_ai_usage_events','mt_model_pricing') AND grantee IN ('anon','authenticated');
