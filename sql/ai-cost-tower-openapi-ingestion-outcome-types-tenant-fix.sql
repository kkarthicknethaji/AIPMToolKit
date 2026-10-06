-- AI Cost Control Tower: OpenAPI Ingestion Layer — code-review fix
-- Finding: mt_outcome_types has no company_id column; POST/GET
-- /v1/outcome-types scope by app_id alone, so two companies granted the
-- same app_id could collide on registration and read each other's
-- taxonomy via GET.
-- Run in Supabase SQL editor. DEV FIRST (pgt-dev), verify, THEN prod.
-- Per this project's convention: not run by Claude Code, executed manually.
--
-- Deliberately additive only — does NOT touch mt_outcome_types' existing
-- (app_id, outcome_type_id) primary key or the mt_outcomes_app_outcome_type_fkey
-- FK from mt_outcomes. That PK is what Product Studio's own 11-row global
-- catalog already relies on in production (every company's mt_outcomes rows
-- reference it via app_id='product-studio' alone, with no company scoping
-- on the type itself, by original design). Restructuring that PK to fully
-- enforce per-company uniqueness would require changing the mt_outcomes FK
-- to a composite (company_id, app_id, outcome_type_id) match, which breaks
-- every existing row's reference to the global catalog (company_id would
-- need to be NULL there to mean "global", and a composite FK match against
-- a NULL column never succeeds) — real production risk, out of scope for
-- this fix. This migration instead closes the READ leak (the more severe
-- half of the finding: one company seeing another's registrations) and lets
-- the application layer (proxy/routes/v1/outcomeTypes.js) give an honest
-- "taken by someone else" conflict message instead of a silent collision.
-- The underlying limitation — two companies cannot both register the exact
-- same outcome_type_id string under one shared app_id — remains a real
-- constraint of the current schema; closing it fully needs the FK
-- restructuring above, deliberately not attempted here.

ALTER TABLE mt_outcome_types ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES mt_companies(id);
-- NULL means "global reference data" — every pre-existing row (Product
-- Studio's 11-row catalog) keeps this NULL and is completely untouched.
-- New rows created via POST /v1/outcome-types always set this to the
-- credential-resolved company_id.

-- Verify: expect every existing row to show company_id IS NULL (confirms
-- this migration didn't touch pre-existing data).
SELECT app_id, outcome_type_id, company_id FROM mt_outcome_types;
