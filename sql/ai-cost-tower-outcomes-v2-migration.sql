-- AI Cost Control Tower v2: Outcome-Based Cost migration
-- Extracted from ai-cost-control-tower-v2-outcome-technical-spec.md, Section 6 only
-- Run in Supabase SQL editor. DEV FIRST (pgt-dev), verify, then prod.
-- Per AI_EDITING_RULES.md: not run by Claude Code, executed manually.

-- ═══════════════════════════════════════════════════════════════════
-- AI Cost Control Tower v2: Outcome-Based Cost — data model
-- Run in Supabase SQL editor. DEV FIRST (pgt-dev), verify, then prod.
-- Per AI_EDITING_RULES.md: NOT run by Claude Code. Write to disk only.
-- Idempotent throughout: safe to re-run.
--
-- Source: ai-cost-control-tower-v2-outcome-taxonomy.md (design decisions)
-- and ai-cost-control-tower-v2-outcome-technical-spec.md (this build).
-- ═══════════════════════════════════════════════════════════════════

-- ─── mt_outcome_types: the eleven-row catalog, static reference data ──

CREATE TABLE IF NOT EXISTS mt_outcome_types (
  outcome_type_id        TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  canvas                  TEXT NOT NULL,
  description             TEXT NOT NULL,
  costing_method          TEXT NOT NULL CHECK (costing_method IN ('session_sum','yield_ratio')),
  -- Release Plan is session_sum at this table's level (its direct-cost
  -- component populates mt_outcomes); the lineage_rollup component is
  -- computed client-side (Section 3.5), never stored as its own type.
  unit_label              TEXT NOT NULL,
  abandonment_window_hrs  INTEGER CHECK (abandonment_window_hrs IS NULL OR abandonment_window_hrs > 0)
  -- NULL for yield_ratio types: no lifecycle, no abandonment window.
);

-- Reference data is small, fixed, and not company-scoped — no RLS needed,
-- same treatment mt_model_pricing already gets (Section 8.0 note in
-- ai-cost-tower.sql: "no RLS change... this migration only adds nullable
-- columns"). This table is genuinely global, not a per-tenant one.
GRANT SELECT ON TABLE mt_outcome_types TO authenticated;

INSERT INTO mt_outcome_types (outcome_type_id, name, canvas, description, costing_method, unit_label, abandonment_window_hrs) VALUES
  ('discovery_map',               'Discovery Map',              'discovery-map',                                   'The KPI tree generated for a product.',                                    'session_sum', 'Discovery Map',    6),
  ('requirement_brief',           'Requirement Agent Brief',    'requirement-agent',                               'A finalized Requirement Agent conversation.',                              'session_sum', 'Requirement Brief', 96),
  ('market_intelligence_report',  'Market Intelligence Report', 'market-intelligence',                             'A market intelligence report for a product.',                              'session_sum', 'MI Report',        12),
  ('adoption_readiness_report',   'Adoption Readiness Plan',    'readiness-canvas',                                'A launch-readiness plan.',                                                 'session_sum', 'Readiness Plan',   96),
  ('release_plan',                'Release Plan',               'pi-canvas',                                       'A PI/Release Canvas plan (direct authoring cost only; upstream rollup is computed client-side, not stored here).', 'session_sum', 'Release Plan', 168),
  ('capability',                  'Capability',                 'capability-canvas',                              'A capability generated in Capability Canvas.',                             'yield_ratio', 'Capability',       NULL),
  ('feature',                     'Feature',                    'feature-canvas',                                 'A feature generated in Feature Canvas.',                                   'yield_ratio', 'Feature',          NULL),
  ('story',                       'Story',                      'story-canvas',                                   'A story generated in Story Canvas.',                                       'yield_ratio', 'Story',            NULL),
  ('kpi_dictionary_entry',        'KPI Dictionary Entry',       'discovery-map + capability-canvas',              'A generated definition for one KPI.',                                      'yield_ratio', 'Dictionary Entry', NULL),
  ('ai_recommendation',           'AI Recommendation',          'home',                                            'A home-screen AI recommendation.',                                         'yield_ratio', 'Recommendation',   NULL),
  ('experiment',                  'Experiment',                 'discovery-map (diagnostics) + outcome-pulse',    'An experiment generated from diagnostics or Outcome Pulse.',              'yield_ratio', 'Experiment',       NULL)
ON CONFLICT (outcome_type_id) DO NOTHING;
-- DO NOTHING, not DO UPDATE: re-running this migration should not silently
-- overwrite an abandonment_window_hrs value that's since been tuned from
-- its starting default based on real usage data.

-- ─── mt_outcomes: one row per Journey-type attempt ─────────────────────

CREATE TABLE IF NOT EXISTS mt_outcomes (
  outcome_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outcome_type_id  TEXT NOT NULL REFERENCES mt_outcome_types(outcome_type_id),
  -- RESTRICT (the default) is intentional here, not an oversight: this is
  -- an 11-row fixed catalog that should never be deleted while instances
  -- reference it, a different situation from the known mt_companies /
  -- mt_products created_by ON DELETE NO ACTION issue — that FK problem is
  -- about deleting a frequently-deleted entity (a user), this one is about
  -- protecting a catalog that should essentially never be deleted at all.
  company_id       UUID NOT NULL REFERENCES mt_companies(id) ON DELETE CASCADE,
  product_id       UUID,
  session_id       UUID NOT NULL,
  user_id          UUID,
  status           TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed')),
  -- 'abandoned' is deliberately NOT a stored value — Section 2.5: this
  -- codebase has no cron infrastructure, so abandonment is a derived
  -- read-time label (status='in_progress' AND stale), never a written
  -- state transition. Two real states, one derived one.
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mt_outcomes_completed_consistency CHECK (
    (status = 'in_progress' AND completed_at IS NULL) OR
    (status = 'completed' AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS mt_outcomes_company_period_idx
  ON mt_outcomes (company_id, started_at);
CREATE INDEX IF NOT EXISTS mt_outcomes_session_type_idx
  ON mt_outcomes (session_id, outcome_type_id, status);
-- Supports _getOrCreateActiveOutcome's lookup: "the most recent instance
-- of this type in this session" — the actual hot-path query at every AI call.

ALTER TABLE mt_outcomes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE mt_outcomes FROM anon, authenticated;
-- Same pattern as mt_ai_budgets / mt_ai_alerts: no direct client access at
-- all, every read and write goes through a SECURITY DEFINER function.

-- ─── mt_ai_usage_events: two additive columns ──────────────────────────

ALTER TABLE mt_ai_usage_events
  ADD COLUMN IF NOT EXISTS outcome_id UUID REFERENCES mt_outcomes(outcome_id) ON DELETE SET NULL;
  -- SET NULL, not the default NO ACTION / RESTRICT: deliberately avoiding
  -- the same class of problem already on file as tech debt for
  -- mt_companies.created_by / mt_products.created_by (NO ACTION blocking
  -- deletes). An outcome row should be safely deletable without taking
  -- down every usage event that ever pointed to it.

ALTER TABLE mt_ai_usage_events
  ADD COLUMN IF NOT EXISTS units_generated INTEGER CHECK (units_generated IS NULL OR units_generated >= 0);

-- Confirm nothing else in the schema depends on this function's exact
-- signature before dropping it — a build-time check, not assumed here:
-- SELECT * FROM pg_depend WHERE refobjid = 'mt_ai_cost_events_list'::regproc;

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
  input_price_per_mtok  NUMERIC,
  output_price_per_mtok NUMERIC,
  calculated_cost      NUMERIC,
  outcome_id           UUID,     -- new
  units_generated      INTEGER   -- new
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
    END AS calculated_cost,
    e.outcome_id, e.units_generated
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

-- Re-grant — this is not optional, see the warning above.
GRANT EXECUTE ON FUNCTION mt_ai_cost_events_list(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

-- ─── mt_outcomes_list: raw Journey-outcome rows, abandonment derived ───

CREATE OR REPLACE FUNCTION mt_outcomes_list(
  p_company_id   UUID,
  p_period_start TIMESTAMPTZ,
  p_period_end   TIMESTAMPTZ
)
RETURNS TABLE (
  outcome_id       UUID,
  outcome_type_id  TEXT,
  product_id       UUID,
  session_id       UUID,
  status           TEXT,
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ,
  is_abandoned     BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT _cost_tower_is_admin(p_company_id) THEN
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
  JOIN mt_outcome_types ot ON ot.outcome_type_id = o.outcome_type_id
  WHERE o.company_id = p_company_id
    AND o.started_at >= p_period_start
    AND o.started_at < p_period_end;
END;
$$;

GRANT EXECUTE ON FUNCTION mt_outcomes_list(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

-- ─── mt_outcome_types_list: the eleven-row catalog ─────────────────────

CREATE OR REPLACE FUNCTION mt_outcome_types_list()
RETURNS TABLE (
  outcome_type_id       TEXT,
  name                   TEXT,
  canvas                 TEXT,
  description            TEXT,
  costing_method         TEXT,
  unit_label             TEXT,
  abandonment_window_hrs INTEGER
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT outcome_type_id, name, canvas, description, costing_method, unit_label, abandonment_window_hrs
  FROM mt_outcome_types;
$$;
-- No SECURITY DEFINER, no _cost_tower_is_admin() check: this is global
-- reference data, not tenant data, same treatment as mt_model_pricing.

GRANT EXECUTE ON FUNCTION mt_outcome_types_list() TO authenticated;

-- ─── Write path: create-or-reuse and touch-activity, called from the proxy ─
-- SECURITY CORRECTION (post-adversarial-review): these three functions were
-- originally specified with GRANT EXECUTE ... TO authenticated, the same as
-- the read RPCs. That was wrong. These are proxy-only, service-role-only
-- functions — a browser client has no business calling
-- mt_outcome_get_or_create_active directly with an arbitrary company_id,
-- and nothing inside the function itself was stopping one from doing so.
-- Fixed to the exact lockdown pattern _cost_tower_is_admin() itself
-- already uses: REVOKE from PUBLIC/anon/authenticated, no GRANT to
-- authenticated at all. The proxy's supabaseAdmin client uses the
-- service_role key, which is not subject to these revokes.

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

  -- Reuse branch: fixed post-Phase-3 live testing, not the original design.
  -- The original version only touched last_activity_at here, which meant a
  -- product_id resolved as NULL on a row's *first* creation (e.g. the
  -- requirement-agent session_type mislabeling found and fixed during Phase
  -- 3) stayed NULL forever, since reuse never looked at p_product_id again.
  -- COALESCE only fills a gap, never overwrites a real value — this also
  -- generically protects all five Journey types sharing this function, not
  -- just the one caller that surfaced the gap.
  IF v_outcome_id IS NOT NULL THEN
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

-- ─── Write path: attachable_support resolution ─────────────────────────
-- This is "_getMostRecentOutcomeAnyStatus" from Section 2.2's pseudocode,
-- named there but never actually written as a real function — a genuine
-- gap an external review caught. Written now: finds the most recent
-- instance of ANY session_sum type in this session (active or completed,
-- per the post-completion attachment rule in Section 2.4), for callers
-- like doc-summary that attach to whatever Journey outcome is current,
-- not to one specific type.

CREATE OR REPLACE FUNCTION mt_outcome_attach_support(
  p_session_id UUID
)
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT o.outcome_id
  FROM mt_outcomes o
  WHERE o.session_id = p_session_id
  ORDER BY o.started_at DESC
  LIMIT 1;
  -- No status filter and no window check by design: an attachable_support
  -- call inherits whatever session_sum outcome most recently existed in
  -- this session, in_progress or already completed, per the post-
  -- completion attachment rule. If none exists at all, this returns NULL
  -- and the caller resolves to general_usage_only instead (Section 2.4),
  -- not an error.
$$;

REVOKE EXECUTE ON FUNCTION mt_outcome_attach_support(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION mt_outcome_mark_completed(p_outcome_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE mt_outcomes
  SET status = 'completed', completed_at = now(), last_activity_at = now()
  WHERE outcome_id = p_outcome_id AND status = 'in_progress';
$$;

REVOKE EXECUTE ON FUNCTION mt_outcome_mark_completed(UUID) FROM PUBLIC, anon, authenticated;

