-- AI Cost Control Tower: OpenAPI Ingestion Layer — Phase 1 schema migrations
-- Source: ai-cost-tower-openapi-ingestion-spec.md v0.11, Sections 4.1, 4.2, 4.3, 4.5.
-- Run in Supabase SQL editor. DEV FIRST (pgt-dev), verify every step below,
-- THEN prod (pgt-prod). Per this project's convention: not run by Claude
-- Code, executed manually. Phase 2 (credential functions, Section 4.4) is a
-- separate file — this migration is schema-only.
--
-- Run each numbered step individually and confirm its expected result
-- before moving to the next. Do not run this whole file as one batch.

-- ═══════════════════════════════════════════════════════════════════
-- 4.1 Enum widening
-- ═══════════════════════════════════════════════════════════════════

-- STEP 1 — confirm current constraint contents before touching anything.
-- Expected: settings_mode_valid on ('optimized','fixed_model');
-- selection_rule_valid on the six values below, WITHOUT 'external' yet.
-- If either differs from that, STOP and reconcile before continuing —
-- do not run steps 2-5 against a constraint whose current contents you
-- haven't confirmed (see finding #19 / ai-cost-tower-selection-rule-fix.sql).
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'mt_ai_usage_events'::regclass
  AND conname IN ('settings_mode_valid', 'selection_rule_valid');

-- STEP 2 — widen settings_mode_valid.
ALTER TABLE mt_ai_usage_events DROP CONSTRAINT settings_mode_valid;
ALTER TABLE mt_ai_usage_events ADD CONSTRAINT settings_mode_valid
  CHECK (settings_mode = ANY (ARRAY['optimized','fixed_model','external']));

-- STEP 3 — widen selection_rule_valid.
ALTER TABLE mt_ai_usage_events DROP CONSTRAINT selection_rule_valid;
ALTER TABLE mt_ai_usage_events ADD CONSTRAINT selection_rule_valid
  CHECK (selection_rule = ANY (ARRAY[
    'optimized_caller_default','optimized_fallback_default','user_selected_model',
    'batch_threshold_override','explicit_override_unclassified','governance_restricted',
    'external'
  ]));

-- ═══════════════════════════════════════════════════════════════════
-- 4.2 Drop the redundant simple FK on product_id
-- ═══════════════════════════════════════════════════════════════════

-- STEP 4 — confirm both FKs exist before dropping either.
-- Expected: mt_ai_usage_events_product_id_fkey (the simple one, being
-- dropped next) AND the composite (product_id, company_id) ->
-- mt_products(id, company_id) (staying). If the composite FK is missing,
-- STOP — dropping the simple FK would leave product_id unconstrained.
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'mt_ai_usage_events'::regclass AND contype = 'f';

-- STEP 5 — drop the redundant simple FK. Composite FK remains untouched.
ALTER TABLE mt_ai_usage_events DROP CONSTRAINT mt_ai_usage_events_product_id_fkey;

-- ═══════════════════════════════════════════════════════════════════
-- 4.3 Idempotency constraint on mt_ai_usage_events
-- ═══════════════════════════════════════════════════════════════════
-- Root-cause of the 3 known dev duplicate pairs accepted as risk per
-- Section 9 item 1 (v0.11) — most likely network-layer request
-- duplication, not a code defect. This migration relabels the losing
-- row's client_call_id rather than deleting it, so no historical spend
-- record is destroyed either way.
--
-- WHERE client_call_id IS NOT NULL in the CTE below is load-bearing, not
-- optional (finding #18): client_call_id is nullable with real NULLs in
-- prod predating this feature, and PARTITION BY groups all NULLs into one
-- bucket, unlike a UNIQUE constraint's NULL-distinctness. Omitting this
-- clause would silently relabel every historical NULL row.

-- STEP 6 — dedup: for any (company_id, app_id, client_call_id) group with
-- more than one non-NULL row, keep the earliest (by created_at, then id)
-- and relabel every later row's client_call_id to a fresh random UUID.
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY company_id, app_id, client_call_id ORDER BY created_at ASC, id ASC
  ) AS rn
  FROM mt_ai_usage_events
  WHERE client_call_id IS NOT NULL
)
UPDATE mt_ai_usage_events e
SET client_call_id = gen_random_uuid()
FROM ranked r
WHERE e.id = r.id AND r.rn > 1;

-- STEP 7 — verify the dedup worked before adding the constraint.
-- Expected: zero rows. If this returns any rows, STOP — do not run step 8
-- against data that still has real duplicates; re-check step 6 first.
SELECT company_id, app_id, client_call_id, count(*)
FROM mt_ai_usage_events
GROUP BY company_id, app_id, client_call_id
HAVING count(*) > 1;

-- STEP 8 — add the UNIQUE constraint now that step 7 confirmed zero rows.
ALTER TABLE mt_ai_usage_events
  ADD CONSTRAINT mt_ai_usage_events_company_app_call_unique
  UNIQUE (company_id, app_id, client_call_id);

-- ═══════════════════════════════════════════════════════════════════
-- 4.5 Outcome creation idempotency (client_outcome_id)
-- ═══════════════════════════════════════════════════════════════════
-- No NULL-grouping risk here (unlike step 6's dedup) — this is a fresh
-- UNIQUE constraint on a brand-new column with no existing rows to
-- collide, not a PARTITION BY operating over pre-existing data.

-- STEP 9 (11a) — add the nullable column. NULL for every existing row
-- created through the internal mt_outcome_get_or_create_active path;
-- required only at the /v1 API layer for rows created via POST /v1/outcomes.
ALTER TABLE mt_outcomes ADD COLUMN client_outcome_id uuid;

-- STEP 10 (11b) — add the UNIQUE constraint backing POST /v1/outcomes'
-- ON CONFLICT (company_id, app_id, client_outcome_id) DO NOTHING pattern.
ALTER TABLE mt_outcomes
  ADD CONSTRAINT mt_outcomes_company_app_client_outcome_unique
  UNIQUE (company_id, app_id, client_outcome_id);

-- STEP 11 — final sanity check for this migration as a whole: confirm all
-- four new/changed constraints are present before calling Phase 1 done.
SELECT conname, conrelid::regclass AS table_name, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conname IN (
  'settings_mode_valid',
  'selection_rule_valid',
  'mt_ai_usage_events_company_app_call_unique',
  'mt_outcomes_company_app_client_outcome_unique'
);
