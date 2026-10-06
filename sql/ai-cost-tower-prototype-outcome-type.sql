-- AI Control Tower — Prototype as a 12th outcome type (yield_ratio).
-- Attributes Prototype Canvas's wireframe+brief calls (prototype-wireframe,
-- prototype-brief) as their own Outcome-Based Cost card. See
-- proxy/server.js's CALLER_ATTRIBUTION_MODE for the caller-mapping half of
-- this change. NOT run by Claude — Nethaji applies to Supabase manually,
-- dev then prod.

INSERT INTO mt_outcome_types (outcome_type_id, name, canvas, description, costing_method, unit_label, abandonment_window_hrs) VALUES
  ('prototype', 'Prototype', 'prototype-canvas', 'A prototype (wireframe + design brief) generated in Prototype Canvas.', 'yield_ratio', 'Prototype', NULL)
ON CONFLICT (outcome_type_id) DO NOTHING;
-- DO NOTHING, not DO UPDATE — matches the existing eleven-row seed's own
-- convention (sql/ai-cost-tower-outcomes-v2-migration.sql): re-running this
-- migration should not silently overwrite anything since tuned from its
-- starting default.
