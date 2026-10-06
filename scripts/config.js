// ── App version — single source of truth ──
// Both index.html and login.html read this on DOMContentLoaded via #hdr-version span.
// Update ONLY this constant on every release — never hardcode version strings in HTML.
const APP_VERSION = 'v9.38.01';

// ── App name — single source of truth for script-generated content ──
// index.html/login.html's <title> and .hdr-title markup are static HTML,
// not script-populated, so they still carry their own literal copy — update
// those by hand alongside this constant if the product is ever renamed again.
const APP_NAME = 'Product Studio';

// ── KPI Tree loader — 3-stage progressive disclosure ──

const LOADER_STAGES_MI = [
  {
    label: 'Researching the Market',
    messages: [
      'Sizing your market — finding the numbers that actually matter…',
      'Identifying who your real competitors are and what they\'re quietly shipping…',
      'Reading the competitive landscape so you don\'t have to…',
      'Checking what the market expects from a product like yours…',
      'Spotting the trends worth accelerating — and the ones already past their peak…',
      'Mapping where your product leads, matches, and lags the market…',
      'Looking for capability gaps your competitors haven\'t closed yet…',
      'Building a market perspective before your KPI tree locks in…',
      'Analysing buyer criteria — what actually drives decisions in your space…',
      'Cross-referencing competitor feature sets against market expectations…',
      'Assessing which trends are ACTIVE, which are PEAKING, and which are noise…',
      'Identifying the strategic moves worth accelerating vs. the ones to monitor…',
      'Synthesising the SWOT from a market lens — not an internal one…',
      'Connecting market signals to the capabilities your KPI tree should reflect…',
      'Almost ready to build your tree — market context locked in…'
    ]
  },
  {
    label: 'Building Your KPI Tree',
    messages: [
      'Selecting the measurement framework your product actually deserves…',
      'Mapping your product\'s value chain from first principles…',
      'Defining stages your team can actually rally around…',
      'Populating L1 metrics — the ones that move the needle, not just the dashboard…',
      'Decomposing into L2 and L3 signals — the ones that tell you why…',
      'Making sure every metric earns its place in the tree…',
      'Aligning metric vocabulary to your industry framework…',
      'Checking that every stage has something worth measuring…',
      'Connecting your North Star to every level of the tree…',
      'Validating the hierarchy — strategy down to diagnostic signal…'
    ]
  },
  {
    label: 'Finalising Results',
    messages: [
      'Naming your metrics with precision — words matter here…',
      'Locking in your North Star — the number everything else serves…',
      'Putting the finishing touches on your measurement model…',
      'Running a final check on stage coverage and metric depth…',
      'Almost there. Worth the wait.'
    ]
  }
];

const LOADER_STAGES_KPI = [
  {
    label: 'Analysing Your Product',
    messages: [
      'Selecting the measurement framework your product actually deserves…',
      'Mapping your product\'s value chain from first principles…',
      'Defining stages your team can actually rally around…',
      'Populating L1 metrics — the ones that move the needle, not just the dashboard…',
      'Decomposing into L2 and L3 signals — the ones that tell you why…',
      'Making sure every metric earns its place in the tree…',
      'Aligning metric vocabulary to your industry framework…',
      'Checking that every stage has something worth measuring…',
      'Connecting your North Star to every level of the tree…',
      'Validating the hierarchy — strategy down to diagnostic signal…'
    ]
  },
  {
    label: 'Building Your KPI Tree',
    messages: [
      'Attributing framework vocabulary to metric names…',
      'Validating metric hierarchy and stage coverage…',
      'Checking diagnostic signal depth at L3 and L4…',
      'Connecting every metric back to the North Star…',
      'Almost there — your KPI tree is taking shape…'
    ]
  },
  {
    label: 'Finalising Results',
    messages: [
      'Finalising your North Star metric…',
      'Building your measurement model summary…',
      'Running a final check on stage and metric coverage…',
      'Almost there. Worth the wait.'
    ]
  }
];

// Capability-driven mode variants — used when fd.approach==='capability-based'.
// No L2-L4 in capability-driven mode, so "decomposing into L2/L3" and
// "diagnostic signal depth at L3/L4" lines are dropped rather than reworded.
const LOADER_STAGES_KPI_CAP = [
  {
    label: 'Analysing Your Product',
    messages: [
      'Selecting the measurement framework your product actually deserves…',
      'Mapping your product\'s value chain from first principles…',
      'Defining stages your team can actually rally around…',
      'Populating L1 capabilities — the functions that actually run this product…',
      'Making sure every capability earns its place in the hierarchy…',
      'Aligning capability vocabulary to your industry framework…',
      'Checking that every stage has something worth building…',
      'Connecting your North Star to the capabilities that drive it…',
      'Validating the hierarchy — strategy down to operational capability…'
    ]
  },
  {
    label: 'Mapping Your Capability Hierarchy',
    messages: [
      'Attributing framework vocabulary to capability names…',
      'Validating capability hierarchy and stage coverage…',
      'Connecting every capability back to the North Star…',
      'Almost there — your capability map is taking shape…'
    ]
  },
  {
    label: 'Finalising Results',
    messages: [
      'Finalising your North Star metric…',
      'Building your value chain model summary…',
      'Running a final check on stage and capability coverage…',
      'Almost there. Worth the wait.'
    ]
  }
];


// ── Auth domain restriction ──
// Client deployment: change this one line to the client's email domain.
// Used by auth.js for sign-up domain validation — never hardcode elsewhere.
const AUTH_DOMAIN = 'hcltech.com';

// DD loader (unchanged)
const DD_STEPS=["Pulling definitions for every metric in the tree...","Finding real benchmarks — not the made-up kind...","Identifying red flags that actually mean something...","Writing definitions a CFO and a dev can both understand..."];
const DD_HEADS=["Building your metrics dictionary...","Sourcing real-world benchmarks...","Writing definitions that don't need a footnote..."];
const DD_SUBS=["This is the document you wished existed at your last job.","Benchmarks verified. Frameworks consulted.","Definitions incoming. Minimal jargon. Mostly."];

// ── v9.14: AI provider / model catalog ──
// v9.14.03: Gemini added — the earlier "GA-vs-Beta documentation
// contradiction" that deferred it (Section 8 of multi-llm-provider-spec-
// DRAFT.md) turned out to be a mis-read, not a real inconsistency, on direct
// re-examination of the exact quoted passages (one describes product
// maturity, the other describes URL versioning scheme — two different
// axes). Resolved, not worked around.
const _spProviders = [
  { value:'anthropic', label:'Anthropic' },
  { value:'openai',    label:'OpenAI' },
  { value:'gemini',    label:'Google Gemini' }
];

// OpenAI model IDs confirmed 2026-07-25 via direct human screenshot of
// developers.openai.com/api/docs/models (not a search/fetch tool result —
// this project has twice caught tool-mediated fabrication on this exact
// question, so a direct human read was required before these could leave
// [VERIFY] status). Pricing confirmed on the same page.
//
// RESIDUAL UNCERTAINTY, not resolved by the above: the GPT-5.6 family
// (Sol/Terra/Luna) has been independently reported by press as limited-
// preview to ~20 organizations, not confirmed GA. The docs page itself shows
// no access-restriction badge — but "documented" is not the same as
// "confirmed callable by this org's account." We have NOT been able to
// confirm via a successful live API call that this org's OpenAI account can
// actually reach these models — blocked on that account's $0 billing
// balance, unresolved as of this writing. If Settings shows these models but
// every call fails with a permission/model_unavailable error, this is why —
// check billing/org access before assuming the model IDs themselves are wrong.
const _spModelsByProvider = {
  anthropic: [
    { value:'optimized',           label:'Optimized (Default)' },
    { value:'claude-haiku-4-5',    label:'claude-haiku-4-5' },
    { value:'claude-sonnet-4-6',   label:'claude-sonnet-4-6' },
    { value:'claude-opus-4-8',     label:'claude-opus-4-8' }
  ],
  openai: [
    { value:'optimized',      label:'Optimized (Default)' },
    { value:'gpt-5.6-luna',   label:'GPT-5.6 Luna (fast, cost-efficient)' },
    { value:'gpt-5.6-terra',  label:'GPT-5.6 Terra (balanced)' },
    { value:'gpt-5.6-sol',    label:'GPT-5.6 Sol (frontier, complex work)' }
  ],
  // Gemini model IDs confirmed via Nethaji's direct raw-documentation paste
  // (ai.google.dev/gemini-api/docs/interactions-overview and
  // /api/interactions-api, "Supported models & agents" table) — not
  // search/fetch-tool output. No premium tier: gemini-3.1-pro-preview is the
  // only Pro-class model and carries "preview" directly in its model ID
  // string, confirmed twice independently (search pass + this direct-doc
  // pass) as not a stable option. Do not add a premium entry here unless a
  // future pass confirms a stable option now exists.
  gemini: [
    { value:'optimized',            label:'Optimized (Default)' },
    { value:'gemini-3.5-flash-lite', label:'Gemini 3.5 Flash-Lite (fast, cost-efficient)' },
    { value:'gemini-3.6-flash',      label:'Gemini 3.6 Flash (balanced)' }
  ]
};

// API key field label/placeholder per provider (settings-page.js's My
// Profile API key card, and settings.js's checkKey()). OpenAI's placeholder
// is a visible [VERIFY] marker, not a guess — matches _PROVIDER_KEY_PATTERNS
// in settings.js (null pattern, soft-accept) until Section 7 confirms it.
const _spKeyMetaByProvider = {
  anthropic: { label:'Anthropic API Key', placeholder:'sk-ant-api03-...' },
  openai:    { label:'OpenAI API Key',    placeholder:'[VERIFY_OPENAI_KEY_PLACEHOLDER]' },
  gemini:    { label:'Gemini API Key',    placeholder:'[VERIFY_GEMINI_KEY_PLACEHOLDER]' } // key-prefix format not part of this pass's confirmed content — soft/non-blocking, see settings.js's _PROVIDER_KEY_PATTERNS
};
function _spKeyMetaForProvider(provider){
  return _spKeyMetaByProvider[provider] || _spKeyMetaByProvider.anthropic;
}
