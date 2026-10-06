// ── Anthropic Proxy — Netlify Serverless Function v6.0 (v8.113) ──
// Primary proxy path for all hosted deployments (dev + prod).
// Receives same-origin requests from /api/anthropic (netlify.toml rewrite).
// Same-origin → no CORS preflight → works on corporate networks.
//
// v8.113: replaces presence-only auth ("some non-empty X-Auth-Token exists")
// with real JWT verification (JWKS, ES256/RS256, issuer + audience checked)
// plus a company-membership check via the same is_active_company_member()
// RPC server.js's equivalent middleware calls — single canonical source of
// truth so the two separate codebases/runtimes can't drift on what "active
// member" means. This was a genuine, confirmed gap: this function is the
// actual hosted production path (per the netlify.toml rewrite below it),
// and previously accepted any non-empty string as authentication.
//
// Module-level clients (jwksClient, supabaseAdmin) are created once per cold
// start and reused across warm invocations — Netlify Functions persist
// module state between invocations on the same warm instance, same as AWS
// Lambda. This is a best-effort optimization, not a guarantee: a cold start
// always pays the full JWKS fetch cost regardless.

const jwt = require('jsonwebtoken');
const jwksRsa = require('jwks-rsa');
const { createClient } = require('@supabase/supabase-js');
// v9.14: shares the same adapter module server.js uses, rather than hand-
// duplicating request-building/response-parsing logic. Required from
// './providerAdapters', NOT '../../proxy/providerAdapters' — a live
// deploy confirmed Netlify's Function bundler does not trace a relative
// require crossing the netlify/functions/ directory boundary ("Cannot
// find module '../../proxy/providerAdapters'"), so netlify.toml's build
// command copies the canonical proxy/providerAdapters.js in here at
// build time (gitignored copy, not a hand-maintained duplicate) before
// this require ever resolves. This function itself stays Anthropic-only
// and unrelated to appSettings.provider — it's the separate, always-
// Anthropic path for Home's AI Recommendations (see scripts/api.js's
// comment on why that call bypasses callAPI()), not the multi-provider
// /api/anthropic path server.js now handles.
const { getAdapter } = require('./providerAdapters');
const anthropicAdapter = getAdapter('anthropic');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const SUPABASE_ISSUER = SUPABASE_URL ? (SUPABASE_URL + '/auth/v1') : '';

// 2s JWKS timeout, not the 5s used in the Express proxy — fail closed fast
// rather than eating into the Anthropic call's tight 60s function budget.
const jwksClient = SUPABASE_URL ? jwksRsa({
  jwksUri: SUPABASE_URL + '/auth/v1/.well-known/jwks.json',
  cache: true,
  cacheMaxAge: 10 * 60 * 1000,
  rateLimit: true,
  jwksRequestsPerMinute: 10,
  requestHeaders: { 'Accept': 'application/json' },
  timeout: 2000
}) : null;

const supabaseAdmin = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

function getHeader(headers, name) {
  const lower = name.toLowerCase();
  for (const key in headers || {}) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return '';
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Auth-Token',
  'Content-Type': 'application/json'
};

const ALLOWED_MODELS = new Set(['claude-sonnet-4-6','claude-haiku-4-5']);
const MAX_OUTPUT_TOKENS = 600;

function json(statusCode, body) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

function extractBearerToken(authHeader) {
  const h = (authHeader || '').trim();
  if (!h) return { key: '', malformed: false };
  const bearerMatch = /^Bearer(?:\s+(.+))?$/i.exec(h);
  if (!bearerMatch) return { key: '', malformed: true };
  const k = (bearerMatch[1] || '').trim();
  if (k === 'undefined' || k === 'null') return { key: '', malformed: false };
  return { key: k, malformed: false };
}

function looksLikeAnthropicKey(key) {
  return /^sk-(ant-)?[A-Za-z0-9._~+=/-]{20,}$/.test(key);
}

// Promise wrapper around jwt.verify's callback-based JWKS flow.
function verifyJwt(token) {
  return new Promise((resolve, reject) => {
    if (!jwksClient) return reject(new Error('Auth not configured — SUPABASE_URL missing'));
    jwt.verify(token, function(header, callback) {
      jwksClient.getSigningKey(header.kid, function(err, key) {
        if (err) return callback(err);
        callback(null, key.getPublicKey());
      });
    }, {
      algorithms: ['ES256', 'RS256'],
      issuer: SUPABASE_ISSUER || undefined,
      audience: 'authenticated'
    }, function(err, decoded) {
      if (err) return reject(err);
      resolve(decoded);
    });
  });
}

exports.handler = async function(event) {

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: { message: 'Method not allowed' } });
  }

  // ── Auth: real JWT verification (v8.113 — was presence-only) ──
  const jwtToken = getHeader(event.headers, 'x-auth-token');
  if (!jwtToken) {
    return json(200, { error: { type: 'auth_error', message: 'Not authenticated. Please sign in and try again.' } });
  }
  if (!jwksClient || !supabaseAdmin) {
    console.error('[AI] proxy not configured — SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing');
    return json(200, { error: { type: 'auth_error', message: 'Auth not configured on proxy. Contact your administrator.' } });
  }

  let userId;
  try {
    const decoded = await verifyJwt(jwtToken);
    userId = decoded.sub;
  } catch (err) {
    console.warn('[AI] JWT verification failed:', err.message);
    return json(200, { error: { type: 'auth_error', message: 'Session expired or invalid. Please sign in again.' } });
  }

  // ── Parse body ──
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch(e) {
    return json(200, { error: { type: 'invalid_request', message: 'Invalid request body.' } });
  }

  // ── Company-membership check (v8.113) — previously missing entirely ──
  const companyId = body.company_id;
  if (!companyId) {
    return json(200, { error: { type: 'invalid_request', message: 'company_id is required.' } });
  }
  try {
    const { data: isMember, error: rpcErr } = await supabaseAdmin.rpc('is_active_company_member', {
      p_user_id: userId, p_company_id: companyId
    });
    if (rpcErr) {
      console.error('[AI] membership check failed:', rpcErr.message);
      return json(200, { error: { type: 'proxy_error', message: 'Could not verify company access. Please try again.' } });
    }
    if (!isMember) {
      console.warn('[AI] membership denied:', userId, '->', companyId);
      return json(200, { error: { type: 'forbidden_error', message: "You don't have active access to this company." } });
    }
  } catch (err) {
    console.error('[AI] membership check exception:', err.message);
    return json(200, { error: { type: 'proxy_error', message: 'Could not verify company access. Please try again.' } });
  }

  // ── API key — BYOK from Authorization header, fallback to org key env var ──
  const ORG_API_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
  const parsedAuth = extractBearerToken(getHeader(event.headers, 'authorization'));

  if (parsedAuth.malformed) {
    return json(200, { error: { message: 'Invalid Authorization header.' } });
  }

  const byokKey = parsedAuth.key;
  const apiKey = byokKey || ORG_API_KEY;

  if (!apiKey) {
    return json(200, { error: { message: 'No API key available. Add a personal API key in Settings or contact your admin.' } });
  }

  if (byokKey && !looksLikeAnthropicKey(byokKey)) {
    return json(200, { error: { message: 'Invalid API key format.' } });
  }

  // ── Model allowlist + max_tokens clamp ──
  if (!ALLOWED_MODELS.has(body.model)) {
    return json(200, { error: { message: 'Unsupported model for AI Recommendations.' } });
  }
  body.max_tokens = Math.min(MAX_OUTPUT_TOKENS, Math.max(1, Number(body.max_tokens) || MAX_OUTPUT_TOKENS));

  // ── AbortController timeout — 48s, reduced from the original 55s (v8.113) ──
  // to account for the JWKS fetch + Supabase membership query now happening
  // before this point on a cold instance, while staying within Netlify's
  // hard 60s synchronous function limit with a real safety margin.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 48000);

  try {
    // v9.14: request built via the shared anthropicAdapter rather than a
    // second hand-written copy of the Messages API request shape — the
    // response is still returned RAW (Anthropic's own {content:[{text}]}
    // shape) below, unchanged from before, since home.js's AI Recommendations
    // caller (the only consumer of this function) expects that exact shape
    // and is out of scope for this feature to touch.
    const upstreamReq = anthropicAdapter.buildUpstreamRequest({
      model:      body.model,
      max_tokens: body.max_tokens,
      system:     body.system,
      messages:   body.messages
    }, apiKey);
    const response = await fetch(upstreamReq.url, {
      method: upstreamReq.method,
      headers: upstreamReq.headers,
      body: JSON.stringify(upstreamReq.body),
      signal: controller.signal
    });

    const rawText = await response.text();

    let data;
    try {
      data = JSON.parse(rawText);
    } catch(e) {
      const msg = response.status === 403
        ? 'Your organisation API key is blocked from direct API access. Contact your Anthropic org admin to enable API access.'
        : response.status === 529 || response.status === 503
        ? 'Anthropic API is temporarily overloaded. Please wait a moment and try again.'
        : 'Anthropic returned an unexpected response (HTTP ' + response.status + '). Please try again.';
      return json(200, { error: { message: msg } });
    }

    return json(200, data);

  } catch(err) {
    const msg = err.name === 'AbortError'
      ? 'Request timed out. Please try again.'
      : 'Proxy error: ' + err.message;
    return json(200, { error: { message: msg } });
  } finally {
    clearTimeout(timeout);
  }
};
