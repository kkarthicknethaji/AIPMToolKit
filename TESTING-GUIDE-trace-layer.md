# Testing Guide — AI Trace Layer

This walks you through verifying the new trace/span layer, in plain steps. Same format as `TESTING-GUIDE-openapi-ingestion.md` — copy-paste commands, no coding required.

There are two parts:
- **Part A** — the visible, click-in-the-browser part (Requirement Agent actually tracing its own calls).
- **Part B** — the `/v1` API surface (`traces`, `tool-spans`, the `client_trace_id` addition to `usage-events`), tested with `curl`.

Do these against `pgt-dev` only. Your local proxy needs to already be running (`node server.js` in `proxy/`, or however you normally start it), pointed at `pgt-dev`.

---

## Part A — Requirement Agent traces its own calls

1. Open Product Studio locally, open (or start) a Requirement Agent conversation.
2. Send a message, wait for the reply. Send a second message.
3. Upload a small document (any short `.txt`/`.docx` works) and let it index.
4. In the Supabase SQL editor for `pgt-dev`, run:
   ```sql
   SELECT trace_id, agent_name, session_id, product_id, outcome_id, started_at, completed_at
   FROM mt_ai_traces
   ORDER BY started_at DESC
   LIMIT 5;
   ```
   **Expected:** one row for your conversation, `agent_name = 'requirement-agent'`, `session_id`/`product_id` populated (not null) if your session had a real product attached.
5. Copy that row's `trace_id`, then run:
   ```sql
   SELECT sequence_order, span_type, status, usage_event_id
   FROM mt_ai_spans
   WHERE trace_id = 'PASTE-TRACE-ID-HERE'
   ORDER BY sequence_order;
   ```
   **Expected:** 3 rows (opening turn, your message, the doc-gist call), all `span_type = 'llm_call'`, `sequence_order` 1/2/3 in the order they actually happened, each with a real `usage_event_id`.
6. Refresh the page and send a third message in the **same** conversation.
   **Expected:** a 4th span appears with `sequence_order = 4` under the **same** `trace_id` as before — confirms `client_trace_id` survived the refresh (it's stored on the conversation object, persisted the normal way).

If step 4 shows no rows at all, or step 5 shows spans scattered across multiple different `trace_id`s for what should be one conversation, stop and tell me what you saw — don't try to debug it yourself.

---

## Part B — Test the `/v1` API directly

### B1. Get a test credential

If you still have a live `ct_...` key from the OpenAPI ingestion testing guide (`test-app-review`), reuse it — skip to B2. Otherwise, in the `pgt-dev` SQL editor:

```sql
SELECT id, name FROM mt_companies;
-- copy your company's id
```
```sql
INSERT INTO mt_apps (app_id, name, supports_enforcement)
VALUES ('test-app-review', 'Test App (code review verification)', false)
ON CONFLICT (app_id) DO NOTHING;
```
```sql
SELECT admin_rotate_company_app_credential('PASTE-YOUR-COMPANY-ID-HERE', 'test-app-review');
```
Copy the `ct_...` value — shown only once.

### B2. Run these, in order

Replace `YOUR_API_KEY` and adjust the host if your local proxy isn't on `3001`. Each one's expected result is right below it.

**1. Create a trace explicitly**
```bash
curl -s -X POST http://localhost:3001/v1/traces \
  -H "Authorization: Bearer YOUR_API_KEY" -H "Content-Type: application/json" \
  -d '{"agent_name":"test-agent","client_trace_id":"test-trace-001","session_id":"11111111-1111-1111-1111-111111111111"}'
```
Expected: `{"trace_id":"...","deduplicated":false}`. Save the `trace_id`.

**2. Replay the same `client_trace_id` with the SAME fields — should be a silent no-op**
```bash
curl -s -X POST http://localhost:3001/v1/traces \
  -H "Authorization: Bearer YOUR_API_KEY" -H "Content-Type: application/json" \
  -d '{"agent_name":"test-agent","client_trace_id":"test-trace-001","session_id":"11111111-1111-1111-1111-111111111111"}'
```
Expected: same `trace_id` as test 1, `"deduplicated":true`.

**3. Replay the same `client_trace_id` with a DIFFERENT `agent_name` — should be rejected**
```bash
curl -s -X POST http://localhost:3001/v1/traces \
  -H "Authorization: Bearer YOUR_API_KEY" -H "Content-Type: application/json" \
  -d '{"agent_name":"a-different-agent","client_trace_id":"test-trace-001"}'
```
Expected: HTTP 409, `"type":"conflict"` — this is the identity-conflict check working correctly, not a bug.

**4. Record a usage event under that trace (implicit continuation via the same `client_trace_id`)**
```bash
curl -s -X POST http://localhost:3001/v1/usage-events \
  -H "Authorization: Bearer YOUR_API_KEY" -H "Content-Type: application/json" \
  -d '{"client_call_id":"22222222-2222-2222-2222-222222222222","user_role_at_call":"engineer","caller":"test-caller","requested_model":"claude-x","status":"success","request_started_at":"2026-09-10T10:00:00Z","client_trace_id":"test-trace-001","agent_name":"test-agent"}'
```
Expected: `{"id":"...","deduplicated":false}`.

**5. Read the trace back — `product_id`/`outcome_id` should show up if you set them; spans should show your usage event**
```bash
curl -s http://localhost:3001/v1/traces/PASTE-TRACE-ID-HERE -H "Authorization: Bearer YOUR_API_KEY"
curl -s http://localhost:3001/v1/traces/PASTE-TRACE-ID-HERE/spans -H "Authorization: Bearer YOUR_API_KEY"
```
Expected: the second call shows one span, `span_type: "llm_call"`, with a nested `mt_ai_usage_events` object showing `requested_model: "claude-x"`.

**6. Record a tool-call span on the same trace**
```bash
curl -s -X POST http://localhost:3001/v1/tool-spans \
  -H "Authorization: Bearer YOUR_API_KEY" -H "Content-Type: application/json" \
  -d '{"agent_name":"test-agent","client_trace_id":"test-trace-001","tool_name":"test-tool","status":"success"}'
```
Expected: `{"span_id":"...","trace_id":"..."}` — same `trace_id` as before. Re-run test 5's spans call — should now show 2 spans, `sequence_order` 1 and 2, the second one `span_type: "tool_call"` with `mt_ai_usage_events: null`.

**7. Send an invalid `status` to `/v1/tool-spans` — should get a clean 400, not a confusing 409**
```bash
curl -s -X POST http://localhost:3001/v1/tool-spans \
  -H "Authorization: Bearer YOUR_API_KEY" -H "Content-Type: application/json" \
  -d '{"agent_name":"test-agent","client_trace_id":"test-trace-001","tool_name":"test-tool","status":"pending"}'
```
Expected: HTTP 400, `"status must be one of: success, error, timeout"`. (This is exactly the bug found and fixed during spec review — worth specifically confirming it stayed fixed.)

**8. Complete the trace**
```bash
curl -s -X PATCH http://localhost:3001/v1/traces/PASTE-TRACE-ID-HERE -H "Authorization: Bearer YOUR_API_KEY"
```
Expected: `{"trace_id":"...","completed_at":"..."}`.

**9. Confirm `GET /v1/usage-events` now includes `trace_id`**
```bash
curl -s "http://localhost:3001/v1/usage-events?start=2026-09-01T00:00:00Z&end=2026-09-30T00:00:00Z" -H "Authorization: Bearer YOUR_API_KEY"
```
Expected: your test event from test 4 appears with `"trace_id"` set to the trace's id, not missing from the response shape.

If any test shows something other than its expected result, stop — copy the test number and the exact response you got and send it back rather than trying to fix it yourself.

---

## Cleaning up afterward

Same as the ingestion layer's own guide — this is isolated test data, safe to leave or clean up:
```sql
DELETE FROM mt_ai_usage_events WHERE client_call_id = '22222222-2222-2222-2222-222222222222';
DELETE FROM mt_ai_traces WHERE client_trace_id = 'test-trace-001';
```
(The trace's cascade delete will take its spans with it.)
