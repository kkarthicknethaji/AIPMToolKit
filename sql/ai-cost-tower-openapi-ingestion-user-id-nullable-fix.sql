-- AI Cost Control Tower: OpenAPI Ingestion Layer — user_id nullable fix
-- Bug found via real testing: POST /v1/usage-events fails with
--   null value in column "user_id" of relation "mt_ai_usage_events"
--   violates not-null constraint
-- when a caller omits user_id, even though the spec (Section 6) and
-- proxy/routes/v1/usageEvents.js both document/treat it as optional
-- ("Plain UUID, no FK, use your own internal identifier").
--
-- Root cause: this column has been NOT NULL since long before this
-- ingestion layer existed, because every prior caller of this table went
-- through Product Studio's own authenticated flow, which always has a
-- real req.user.id. This /v1 API is the first legitimate case where no
-- user_id exists at all -- the schema was never updated to match.
--
-- Run in Supabase SQL editor. DEV FIRST (pgt-dev), verify, THEN prod.
-- Per this project's convention: not run by Claude Code, executed manually.
-- Safe for existing data: every current row already has a real user_id;
-- relaxing the constraint doesn't change any existing row.

ALTER TABLE mt_ai_usage_events ALTER COLUMN user_id DROP NOT NULL;

-- Verify: expect user_id in the row list, is_nullable = 'YES'.
SELECT column_name, is_nullable
FROM information_schema.columns
WHERE table_name = 'mt_ai_usage_events' AND column_name = 'user_id';
