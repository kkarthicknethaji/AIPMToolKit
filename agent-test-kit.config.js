// agent-test-kit config — every field is optional; omit a field to use the
// zero-config default (see docs/ARCHITECTURE.md "Pluggable seams" in the
// agent-test-kit package).
const path = require('path');
const { adapters } = require('@karthicknethaji-hcl/agent-test-kit');

// TODO: switch to `npx -y @karthicknethaji-hcl/agent-test-kit-supabase-mcp-server@0.1.0`
// once that package is actually published to npm (as of 2026-09-25 it is
// not — `npm view` 404s). Until then this points directly at the reference
// server's source inside a local agent-test-kit checkout, which only works
// on a machine with that repo checked out as a sibling folder — not
// portable to CI or another machine.
const SUPABASE_MCP_SERVER_ENTRY = path.join(__dirname, '..', 'agent-test-kit', 'mcp-servers', 'supabase-mcp-server', 'index.js');

// ── Custom traceResolver: real mt_ai_traces lookup, falling back to the raw
// clientTraceId if no match is found (rather than null, unlike the old
// framework's own resolveTraceId() — this repo's own choice for this
// package, so `trace_id` in agent_test_kit_quality_scores is always
// populated with SOMETHING usable even before a trace row exists).
// mt_ai_traces itself is unrelated to which results table rows land in —
// it's this repo's own AI Trace Layer, unchanged by any of the below.
// SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are the same env vars
// proxy/server.js and the old test-suite/framework/run-tests.js already
// use — no new secret names.
function createMtAiTracesResolver() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('[agent-test-kit.config] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — trace_id will fall back to clientTraceId for every row.');
    return adapters.createIdentityTraceResolver();
  }
  const { createClient } = require('@supabase/supabase-js');
  const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  return {
    async resolve(clientTraceId, agentName) {
      if (!clientTraceId) return null;
      const { data, error } = await client
        .from('mt_ai_traces')
        .select('trace_id')
        .eq('client_trace_id', clientTraceId)
        .eq('agent_name', agentName)
        .maybeSingle();
      if (error) {
        console.warn('[agent-test-kit.config] mt_ai_traces lookup failed for ' + clientTraceId + ': ' + error.message + ' — falling back to clientTraceId.');
        return clientTraceId;
      }
      return (data && data.trace_id) || clientTraceId;
    }
  };
}

// Runs perfectly well without these env vars set (Markdown report only,
// same graceful-degradation posture the old test-suite/framework/
// run-tests.js's own makeSupabaseAdmin() had) — set SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY to also persist into agent_test_kit_quality_scores
// (agent-test-kit's own fixed table, run
// mcp-servers/supabase-mcp-server/sql/agent-test-kit-quality-scores-
// migration.sql yourself once first — see that package's docs/ARCHITECTURE.md
// for why this table's schema isn't configurable).
// This is a DIFFERENT table from the old framework's own mt_ai_quality_scores
// (still used by Requirement Agent/Discovery Map) — not a migration, a
// deliberate split between the old and new framework's own storage.
//
// agent-test-kit 0.3.0 replaced createSupabaseSink (removed) with
// createMcpSink against a reference MCP server — see this package's
// CHANGELOG.md "Breaking" entry for 0.10 for the migration this function
// went through.
const AGENTS_DIR = path.join(__dirname, 'test-suite', 'agents');

function createResultsSink(agentName) {
  const sinks = [adapters.createMarkdownSink({ resultsDir: path.join(AGENTS_DIR, agentName, 'results'), agentName })];
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    sinks.push(adapters.createMcpSink({
      command: 'node',
      args: [SUPABASE_MCP_SERVER_ENTRY],
      env: {
        SUPABASE_URL: process.env.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY
      }
    }));
  } else {
    console.warn('[agent-test-kit.config] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — results will only be written to the Markdown report, not persisted to agent_test_kit_quality_scores.');
  }
  return sinks.length === 1 ? sinks[0] : adapters.createMultiSink(sinks);
}

module.exports = {
  agentsDir: 'test-suite/agents',
  createResultsSink,
  createTraceResolver: createMtAiTracesResolver
};
