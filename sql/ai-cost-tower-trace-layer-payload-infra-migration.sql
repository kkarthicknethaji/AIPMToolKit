-- AI Cost Control Tower: AI Trace Layer — Payload Capture Infrastructure (D.7 items 1-3)
-- Source: ai-trace-layer-payload-infra-followup-spec-v0.7.md, Sections 2.2, 3.2.
-- Run in Supabase SQL editor. DEV FIRST (pgt-dev), verify the result below,
-- THEN prod (pgt-prod). Per this project's convention: not run by Claude
-- Code, executed manually.
--
-- Closes D.7 items 1-3 only (credential scopes, default-off, app-level
-- toggle). Does NOT unblock payloads:write for any real credential — the
-- purge mechanism (D.7 item 4) is a separate, unbuilt prerequisite, and
-- mt_ai_trace_payloads/POST /v1/trace-payloads (spec Part B.3) are not
-- built by this migration either.
--
-- scope_usage_write/scope_traces_write are reserved, non-enforced this
-- release (see spec §2.2) -- added now so a future enforcement change
-- needs no further migration, defaulted true to preserve every existing
-- credential's current (unscoped) behavior.

-- ═══════════════════════════════════════════════════════════════════
-- STEP 1 — four boolean columns on mt_company_apps
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE mt_company_apps
  ADD COLUMN IF NOT EXISTS scope_usage_write       BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS scope_traces_write      BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS scope_payloads_write    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS payload_capture_enabled BOOLEAN NOT NULL DEFAULT false;

-- ═══════════════════════════════════════════════════════════════════
-- STEP 2 — verify: all four columns exist, NOT NULL, and every existing
-- row was backfilled to the payload-deny state. Expect one row back with
-- total_rows = deny_count (zero non-deny rows) and all four is_not_null
-- flags true.
-- ═══════════════════════════════════════════════════════════════════

SELECT
  count(*) AS total_rows,
  count(*) FILTER (WHERE scope_payloads_write = false AND payload_capture_enabled = false) AS deny_count,
  bool_and(scope_usage_write IS NOT NULL) AS scope_usage_write_not_null,
  bool_and(scope_traces_write IS NOT NULL) AS scope_traces_write_not_null,
  bool_and(scope_payloads_write IS NOT NULL) AS scope_payloads_write_not_null,
  bool_and(payload_capture_enabled IS NOT NULL) AS payload_capture_enabled_not_null
FROM mt_company_apps;

-- ═══════════════════════════════════════════════════════════════════
-- End of migration.
-- ═══════════════════════════════════════════════════════════════════
