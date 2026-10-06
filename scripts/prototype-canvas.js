// ── PROTOTYPE CANVAS (v8.79) ──
// Owns the Prototype view inside Story Canvas.
// Activated when newScProtoView===true and newScActiveNavFeat is set.
// Reads from protoStore{} (state.js) — variant-aware schema.
// All variant-level fields accessed via pcGetActiveVariant(featId).
// pcReady flag set at end of file — UI guards check this before rendering.

// ── Export in-flight guard ──
var _pcExportInFlight = false;

// ── Last rendered feature ID — used to reset section states on feature change ──
var _pcLastRenderedFeatId = null;

// ── Reset section states when switching features ──
function pcResetSectionStates() {
  _pcSectionStates = { wireframe: true, brief: false, coverage: false, prompt: false };
}

// ── Sync export button state — always feature-guarded ──
function pcSyncExportButton(featId) {
  if (typeof curTab === 'undefined' || curTab !== 'sc') return;
  if (typeof newScProtoView === 'undefined' || !newScProtoView) return;
  if (typeof newScActiveNavFeat === 'undefined' || newScActiveNavFeat !== featId) return;
  const btn = document.getElementById('nsc-proto-export-btn');
  const v = pcGetActiveVariant(featId);
  if (btn) btn.disabled = !(v && v.generated && !v.generating);
}

// ── pcCanRenderFeature — guard for all mid-generation DOM writes ──
function pcCanRenderFeature(featId) {
  if (typeof curTab === 'undefined' || curTab !== 'sc') return false;
  if (typeof newScProtoView === 'undefined' || !newScProtoView) return false;
  if (typeof newScActiveNavFeat === 'undefined' || newScActiveNavFeat !== featId) return false;
  return true;
}

// ── Response normalizers ──
function pcNormalizeWireframeResponse(parsed) {
  if (!parsed || typeof parsed !== 'object') throw new Error('Wireframe response was not a valid object.');
  return {
    screenTitle: String(parsed.screenTitle || '').trim() || 'Prototype',
    wireframeHTML: typeof parsed.wireframeHTML === 'string' ? parsed.wireframeHTML : null,
    wireframeOutline: (parsed.wireframeOutline && typeof parsed.wireframeOutline === 'object') ? {
      layout: String(parsed.wireframeOutline.layout || ''),
      components: Array.isArray(parsed.wireframeOutline.components) ? parsed.wireframeOutline.components.map(String) : []
    } : null
  };
}

function pcNormalizeBriefResponse(parsed) {
  if (!parsed || typeof parsed !== 'object') throw new Error('Brief response was not a valid object.');
  return {
    screenPurpose: parsed.screenPurpose || '',
    keyComponents: Array.isArray(parsed.keyComponents) ? parsed.keyComponents : [],
    interactionNotes: parsed.interactionNotes || '',
    edgeCases: parsed.edgeCases || '',
    storyCoverage: Array.isArray(parsed.storyCoverage) ? parsed.storyCoverage : [],
    externalPrompt: parsed.externalPrompt || ''
  };
}

// ── Outcome-Based Cost report-back (v9.31) — reports whether a
// prototype-wireframe/prototype-brief call actually produced usable output,
// via the existing Yield report-back endpoint (proxy/server.js,
// POST /api/usage-events/units-generated). Fire-and-forget: this is
// cost-accounting metadata, not user-facing state, so a failure here must
// never block or delay the user seeing their prototype. Local copy of the
// base-URL/auth-header pattern already duplicated per-file elsewhere in this
// app (team-management.js's _tmProxyBase()/_tmCall(), cost-tower.js's
// actLoadTeamNames()) rather than a cross-file call into any of them.
async function _pcReportUnitsGenerated(clientCallId, unitsGenerated) {
  try {
    var authToken = '';
    try { if (typeof authGetFreshToken === 'function') authToken = await authGetFreshToken(); } catch (e) {}
    var host = window.location.hostname;
    var isLocal = (host === '' || host === 'localhost' || host === '127.0.0.1');
    var base = isLocal ? 'http://localhost:3001' : ((typeof PROXY_URL !== 'undefined' && PROXY_URL) ? PROXY_URL.replace(/\/api\/anthropic\/?$/, '') : 'https://product-diagnostics-proxy.onrender.com');
    var companyId = (function () { try { return localStorage.getItem(_PGT_ACTIVE_COMPANY_KEY) || ''; } catch (e) { return ''; } })();
    var headers = { 'Content-Type': 'application/json' };
    if (authToken) headers['X-Auth-Token'] = authToken;
    await fetch(base + '/api/usage-events/units-generated', {
      method: 'POST', headers: headers,
      body: JSON.stringify({ client_call_id: clientCallId, units_generated: unitsGenerated, company_id: companyId })
    });
  } catch (e) {
    console.warn('[Prototype] units-generated report-back failed:', e);
  }
}

// ── Style guide cache ──
let _prototypeStyleCache = null;

// Embedded fallback — used when assets/prototype-style-default.md cannot be fetched.
const PROTOTYPE_STYLE_DEFAULT_FALLBACK = `
Use clean, professional B2B SaaS UI patterns throughout.
Prefer simple layout with clear visual hierarchy, accessible labels, and realistic content.
Default to card-based layouts for list/detail views, step indicators for wizard flows,
and split-panel layouts for settings or list-detail screens.
Avoid decorative complexity. Every element must earn its place.
Typography: 13-14px headings (700), 11-12px body (400), 9-10px labels (700 uppercase).
Colours: primary brand #5F1EBE (purple), success #007873 (green), warning #C8870A (amber),
error #A32D2D (red), surface backgrounds #F4F6FA, borders #D0D5E8.
Border radius: 8px cards, 6-7px buttons, 5-6px inputs.
All interactive elements minimum 44x44px touch target.
Error states: never colour alone — always icon plus text.
`.trim();

async function _pcGetStyleGuide(signal) {
  if (_prototypeStyleCache !== null) return _prototypeStyleCache;
  // Check abort before any async work
  if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
  try {
    const res = await fetch('assets/prototype-style-default.md', {
      cache: 'no-store',
      signal: signal || undefined
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const txt = await res.text();
    // Check abort after fetch — do not cache fallback on abort
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    _prototypeStyleCache = (txt && txt.trim()) ? txt.trim() : PROTOTYPE_STYLE_DEFAULT_FALLBACK;
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    console.warn('[PC] Style guide fetch failed:', e.message, '— using fallback');
    _prototypeStyleCache = PROTOTYPE_STYLE_DEFAULT_FALLBACK;
  }
  return _prototypeStyleCache;
}

// ── Core helpers ──

function pcGetActiveVariant(featId) {
  if (typeof protoStore === 'undefined' || !protoStore) return null;
  const entry = protoStore[featId];
  if (!entry || !entry.variants || !entry.activeVariantId) return null;
  return entry.variants[entry.activeVariantId] || null;
}

function pcGetLiveFeature(featId) {
  if (typeof scCanvas === 'undefined' || !scCanvas || !featId) return null;
  return scCanvas.find(function(f) { return f.id === featId; }) || null;
}

function pcIsVisibleNavFeature(featId) {
  const feat = pcGetLiveFeature(featId);
  if (!feat || !feat.stories) return false;
  return feat.stories.some(function(s) { return s._inSC && !s._hiddenFromSC; });
}

// ── pcMarkStale — data-only setter, no re-render ──
function pcMarkStale(featId) {
  if (typeof protoStore === 'undefined' || !protoStore || !featId) return;
  const v = pcGetActiveVariant(featId);
  if (v && v.generated) v.stale = true;
}

// ── pcDeleteProto — revokes blob URLs and removes entry ──
function pcDeleteProto(featId) {
  if (typeof protoStore === 'undefined' || !protoStore || !featId) return;
  const entry = protoStore[featId];
  if (!entry) return;
  // Revoke all variant blob URLs
  if (entry.variants) {
    Object.keys(entry.variants).forEach(function(vid) {
      const v = entry.variants[vid];
      if (v && v.wireframeBlobUrl) {
        try { URL.revokeObjectURL(v.wireframeBlobUrl); } catch (_) {}
      }
    });
  }
  delete protoStore[featId];
}

// ── pcMigrateProtoFeatureId — move semantics with collision guard ──
function pcMigrateProtoFeatureId(oldId, newId) {
  if (!oldId || !newId || oldId === newId) return;
  if (typeof protoStore === 'undefined' || !protoStore || !protoStore[oldId]) return;
  // Collision guard — delete new if it already exists
  if (protoStore[newId]) pcDeleteProto(newId);
  // Move object reference
  protoStore[newId] = protoStore[oldId];
  protoStore[newId].featureId = newId;
  // Mark stale since context changed
  const v = pcGetActiveVariant(newId);
  if (v) v.stale = true;
  delete protoStore[oldId];
}

// ── Screenshot context ──

function pcGetScreenshotContext(featId) {
  if (typeof protoStore === 'undefined' || !protoStore) return null;
  // Own screenshot first
  const own = protoStore[featId];
  if (own && own.screenshotDataUrl) {
    return { dataUrl: own.screenshotDataUrl, inherited: false, fromFeatId: null };
  }
  // Session fallback — find any other feature with a screenshot
  const keys = Object.keys(protoStore);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k === featId) continue;
    const entry = protoStore[k];
    if (entry && entry.screenshotDataUrl) {
      const srcFeat = pcGetLiveFeature(k);
      return {
        dataUrl: entry.screenshotDataUrl,
        inherited: true,
        fromFeatId: k,
        fromFeatName: srcFeat ? srcFeat.name : k
      };
    }
  }
  return null;
}

function pcHandleScreenshotUpload(featId, file) {
  if(typeof canEditSession==='function'&&!canEditSession())return;
  if (!file || !featId) return;
  // Validate type
  const allowed = ['image/png', 'image/jpeg', 'image/webp'];
  if (!allowed.includes(file.type)) {
    if (typeof showToast === 'function') showToast('Screenshot must be PNG, JPG, or WEBP.', 'warn');
    return;
  }
  // Validate size — 1.5MB max
  if (file.size > 1.5 * 1024 * 1024) {
    if (typeof showToast === 'function') showToast('Screenshot must be under 1.5 MB.', 'warn');
    return;
  }
  // Ensure entry exists
  if (!protoStore[featId]) {
    protoStore[featId] = pcMakeEmptyEntry(featId);
  }
  const reader = new FileReader();
  reader.onload = function(e) {
    protoStore[featId].screenshotFile = file;
    protoStore[featId].screenshotDataUrl = e.target.result;
    protoStore[featId].screenshotInherited = false;
    protoStore[featId].inheritedFromFeatId = null;
    // Re-render to show uploaded chip
    if (typeof newScProtoView !== 'undefined' && newScProtoView &&
        typeof newScActiveNavFeat !== 'undefined' && newScActiveNavFeat === featId) {
      pcRenderView(featId);
    }
    // v8.146 fix: confirmed missing entirely. Placed inside this async
    // callback, after the data is actually set — not at the function's
    // own top level, which would fire before the FileReader completes.
    if(typeof _isDemoSession!=='undefined'&&!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
      sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('pc',featId); });
    }
  };
  reader.readAsDataURL(file);
}

// ── Entry schema factory ──
function pcMakeEmptyEntry(featId) {
  return {
    featureId: featId,
    activeVariantId: 'v1',
    screenshotFile: null,
    screenshotDataUrl: null,
    screenshotInherited: false,
    inheritedFromFeatId: null,
    additionalContext: '',
    variants: {
      v1: {
        generated: false,
        stale: false,
        generating: false,
        generatingPhase: null,
        generatedAt: null,
        inputSignature: null,
        wireframeBlobUrl: null,
        wireframeHTML: null,
        designBrief: null,
        coverageData: null,
        externalPrompt: null,
        partial: false,
        partialReason: null,
        nonUI: false
      }
    }
  };
}

// ── Feature signature for stale detection ──
function pcCanonicalStories(feat) {
  if (!feat || !feat.stories) return [];
  return feat.stories
    .filter(function(s) { return s._inSC && !s._hiddenFromSC; })
    .map(function(s) {
      return {
        id: s.id || '',
        title: s.title || '',
        statement: s.statement || '',
        points: s.points || null,
        priority: s.priority || null,
        scenarios: (s.scenarios || []).map(function(sc) {
          if (typeof sc === 'string') return { type: 'text', text: sc };
          return {
            type: 'gherkin',
            name: sc.name || '',
            given: sc.given || '',
            when: sc.when || '',
            then: sc.then || '',
            and: sc.and || ''
          };
        }),
        dependencies: (s.dependencies || []).map(function(d) {
          return { direction: d.direction || '', storyId: d.storyId || '' };
        })
      };
    });
}

function pcFeatureSignature(feat, additionalContext) {
  if (!feat) return '';
  return JSON.stringify({
    feature: {
      id: feat.id || '',
      name: feat.name || '',
      why: feat.why || '',
      cap: feat.cap || '',
      metric: feat.metric || '',
      stage: feat.stage || ''
    },
    additionalContext: additionalContext || '',
    stories: pcCanonicalStories(feat)
  });
}

// ── Read additional context from DOM or protoStore ──
function pcReadAdditionalContext(featId) {
  const el = document.getElementById('pc-ctx-input');
  if (el) return el.value.trim();
  if (protoStore[featId]) return protoStore[featId].additionalContext || '';
  return '';
}

// ── Non-UI feature detection ──
function pcIsNonUIFeature(featId) {
  const feat = pcGetLiveFeature(featId);
  if (!feat || !feat.stories) return false;
  const keywords = ['process','ingest','sync','batch','trigger','pipeline','queue','schema',
    'transform','migrate','index','cache','retry','webhook','event','job','cron','worker',
    'compute','throughput','latency','payload','api endpoint','database','backend'];
  const text = (feat.name + ' ' + (feat.why || '') + ' ' +
    feat.stories.filter(function(s){return s._inSC&&!s._hiddenFromSC;})
      .map(function(s){return (s.title||'')+' '+(s.statement||'');}).join(' ')).toLowerCase();
  const hits = keywords.filter(function(k){return text.includes(k);});
  return hits.length >= 3;
}

// ── Render entry point ──
function pcRenderView(featId) {
  // v9.25 — this is the single render entry point for the whole prototype
  // view; confirmed via tracing its call sites (screenshot upload/removal,
  // generation start/error, live-sync remote updates) that it always
  // rebuilds #pc-refine-bar (and so #pc-ctx-input) unconditionally, one way
  // or another. A guard here doesn't cover EVERY exit path though — see
  // newScSetProtoView()/newScSetNavFeat() in story-canvas-new.js for the
  // "leaving proto view entirely" and "switching to a different feature"
  // cases, neither of which necessarily calls this function on the way out.
  voiceStopActive('abort');
  const scroll = document.getElementById('pc-scroll');
  const refine = document.getElementById('pc-refine-bar');
  if (!scroll || !refine) return;

  const feat = pcGetLiveFeature(featId);
  if (!feat) { scroll.innerHTML = ''; refine.innerHTML = ''; return; }

  // Reset section states when switching to a different feature
  if (_pcLastRenderedFeatId !== featId) {
    pcResetSectionStates();
    _pcLastRenderedFeatId = featId;
  }

  const entry = protoStore[featId];
  const v = entry ? pcGetActiveVariant(featId) : null;

  if (!entry || !v || !v.generated) {
    pcRenderEmpty(featId, scroll, refine);
  } else if (v.generating) {
    pcRenderLoading(featId, scroll, refine);
  } else {
    pcRenderGenerated(featId, scroll, refine, feat, entry, v);
  }
}

// ── Empty state ──
function pcRenderEmpty(featId, scroll, refine) {
  const feat = pcGetLiveFeature(featId);
  if (!feat) return;

  // Gather context context counts
  const storyCount = feat.stories ? feat.stories.filter(function(s){return s._inSC&&!s._hiddenFromSC;}).length : 0;
  const peerCount = (typeof scCanvas!=='undefined'?scCanvas:[])
    .filter(function(f){return f.id!==featId&&f.cap===feat.cap&&f.stories&&f.stories.some(function(s){return s._inSC&&!s._hiddenFromSC;});}).length;
  const capWhy = (function(){
    if(typeof capStore==='undefined')return '';
    for(const mk of Object.keys(capStore)){
      const e=capStore[mk];
      if(e&&e.capabilities){const c=e.capabilities.find(function(c){return c.name===feat.cap;});if(c&&c.why)return c.why;}
    }
    return '';
  })();

  // Screenshot info
  const ss = pcGetScreenshotContext(featId);
  const hasOwnSs = !!(protoStore[featId] && protoStore[featId].screenshotDataUrl);
  const ssChipHtml = hasOwnSs
    ? `<div class="pc-ss-chip"><i class="ti ti-photo" style="font-size:10px;" aria-hidden="true"></i> Screenshot attached ${((typeof canEditSession!=='function')||canEditSession())?`<button onclick="pcRemoveScreenshot('${e(featId)}')" class="pc-ss-remove" title="Remove">&#x2715;</button>`:''}</div>`
    : (ss && ss.inherited
        ? `<div class="pc-ss-chip pc-ss-inherited"><i class="ti ti-photo" style="font-size:10px;" aria-hidden="true"></i> Using screenshot from <em>${e(ss.fromFeatName||ss.fromFeatId)}</em></div>`
        : '');

  const insufficientStories = storyCount < 2;
  const _canEditPcEmpty = (typeof canEditSession!=='function')||canEditSession();

  scroll.innerHTML = `<div class="pc-empty-wrap">
    <div class="pc-empty-icon"><i class="ti ti-layout-board" aria-hidden="true"></i></div>
    <div class="pc-empty-title">Prototype This Feature</div>
    <div class="pc-empty-desc">Generate a wireframe and design brief for <strong>${e(feat.name)}</strong> based on its stories, peer features, and capability context.</div>
    <div class="pc-ctx-pills">
      <span class="pc-ctx-pill pc-ctx-1"><i class="ti ti-list-details" style="font-size:8px;" aria-hidden="true"></i> ${storyCount} ${storyCount===1?'story':'stories'} — primary context</span>
      ${peerCount>0?`<span class="pc-ctx-pill pc-ctx-2"><i class="ti ti-layers-subtract" style="font-size:8px;" aria-hidden="true"></i> ${peerCount} peer ${peerCount===1?'feature':'features'} — secondary</span>`:''}
      ${capWhy?`<span class="pc-ctx-pill pc-ctx-3"><i class="ti ti-hierarchy-2" style="font-size:8px;" aria-hidden="true"></i> ${e(feat.cap||'Capability')} — tertiary</span>`:''}
    </div>
    ${insufficientStories?`<div class="pc-warning-bar"><i class="ti ti-alert-triangle" style="font-size:11px;flex-shrink:0;" aria-hidden="true"></i> At least 2 stories needed to generate a meaningful prototype. Generate more stories in Feature Canvas first.</div>`:''}
    ${_canEditPcEmpty?`<div class="pc-upload-zone" onclick="document.getElementById('pc-ss-input-${e(featId)}').click()">
      <input type="file" id="pc-ss-input-${e(featId)}" accept="image/png,image/jpeg,image/webp" style="display:none;" onchange="pcHandleScreenshotUpload('${e(featId)}',this.files[0])">
      <div class="pc-upload-icon"><i class="ti ti-photo-up" aria-hidden="true"></i></div>
      <div class="pc-upload-title">Upload reference screenshot (optional)</div>
      <div class="pc-upload-hint">Drop 1 screenshot of your existing app so the prototype matches your design language</div>
      <div class="pc-upload-opt">PNG, JPG, or WEBP — max 1.5 MB</div>
    </div>`:''}
    ${ssChipHtml}
    ${_canEditPcEmpty?`<button class="pc-gen-btn pc-gen-btn-empty" onclick="pcGenerate('${e(featId)}',this)" ${insufficientStories?'disabled':''}>
      <i class="ti ti-sparkles" style="font-size:11px;" aria-hidden="true"></i> Generate Prototype
    </button>`:''}
  </div>`;

  // Hide refine bar in empty state — only shown in generated state
  refine.style.display = 'none';
  refine.innerHTML = '';
  scroll.classList.add('pc-scroll-centered');
}

function pcRemoveScreenshot(featId) {
  if(typeof canEditSession==='function'&&!canEditSession())return;
  if (!protoStore[featId]) return;
  protoStore[featId].screenshotFile = null;
  protoStore[featId].screenshotDataUrl = null;
  protoStore[featId].screenshotInherited = false;
  protoStore[featId].inheritedFromFeatId = null;
  pcRenderView(featId);
  // v8.146 fix: confirmed missing entirely.
  if(typeof _isDemoSession!=='undefined'&&!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('pc',featId); });
  }
}

// ── Loading state ──
function pcRenderLoading(featId, scroll, refine) {
  const feat = pcGetLiveFeature(featId);
  const featName = feat ? feat.name : 'feature';
  const ss = pcGetScreenshotContext(featId);
  const v = protoStore[featId] ? pcGetActiveVariant(featId) : null;
  const phase = (v && v.generatingPhase) || 1;

  const steps = [
    { label: 'Reading ' + (feat && feat.stories ? feat.stories.filter(function(s){return s._inSC&&!s._hiddenFromSC;}).length : 0) + ' feature stories', done: true },
    { label: 'Analysing peer features and capability context', done: true },
    ss ? { label: 'Interpreting reference screenshot', done: true } : null,
    { label: 'Composing wireframe layout', done: phase >= 2, active: phase === 1 },
    { label: 'Writing design brief and coverage audit', done: false, active: phase === 2, pending: phase === 1 }
  ].filter(Boolean);

  const stepsHtml = steps.map(function(st) {
    const cls = st.done ? 'pc-step-done' : (st.active ? 'pc-step-active' : 'pc-step-pending');
    const icon = st.done ? '<i class="ti ti-check" style="font-size:8px;" aria-hidden="true"></i>' : '';
    return `<div class="pc-step-row"><div class="pc-step-dot ${cls}">${icon}</div><span class="pc-step-label ${cls}">${e(st.label)}</span></div>`;
  }).join('');

  scroll.innerHTML = `<div class="pc-loading-wrap">
    <div class="pc-loading-spinner"></div>
    <div class="pc-loading-title">Generating prototype for ${e(featName)}</div>
    <div class="pc-loading-time">This usually takes 60 to 90 seconds</div>
    <div class="pc-steps-list">${stepsHtml}</div>
  </div>`;

  scroll.classList.add('pc-scroll-centered');
  refine.style.display = 'none';
  refine.innerHTML = '';
}

// ── Generated state ──
function pcRenderGenerated(featId, scroll, refine, feat, entry, v) {
  const isStale = !!v.stale;
  const isPartial = !!v.partial;
  const hasWireframe = !!(v.wireframeHTML);
  const isNonUI = !!v.nonUI;

  // Remove centering — generated view is top-aligned
  scroll.classList.remove('pc-scroll-centered');
  const _canEditPcGen = (typeof canEditSession!=='function')||canEditSession();

  const staleHtml = isStale
    ? `<div class="pc-stale-banner"><i class="ti ti-alert-triangle" style="font-size:11px;flex-shrink:0;" aria-hidden="true"></i><span>Stories have changed since this prototype was generated.</span>${_canEditPcGen?`<button class="pc-stale-regen" onclick="pcGenerate('${e(featId)}',this)"><i class="ti ti-refresh" style="font-size:10px;" aria-hidden="true"></i> Regenerate</button>`:''}</div>`
    : '';

  const partialHtml = isPartial
    ? `<div class="pc-partial-banner"><i class="ti ti-alert-circle" style="font-size:11px;flex-shrink:0;" aria-hidden="true"></i><span>Wireframe was saved. Design brief did not complete — regenerate to finish.</span>${_canEditPcGen?`<button class="pc-stale-regen" onclick="pcGenerate('${e(featId)}',this)"><i class="ti ti-refresh" style="font-size:10px;" aria-hidden="true"></i> Regenerate</button>`:''}</div>`
    : '';

  // Wireframe section
  const wireframeBody = hasWireframe
    ? `<div class="pc-wf-container" id="pc-wf-${e(featId)}"></div>`
    : isNonUI
      ? `<div class="pc-wf-unavailable">
          <div class="pc-wf-unavail-icon"><i class="ti ti-server-2" aria-hidden="true"></i></div>
          <div class="pc-wf-unavail-title">No UI wireframe</div>
          <div class="pc-wf-unavail-desc">This is a backend or process feature — no screen wireframe was generated. See the design brief for system boundary and data flow context.</div>
        </div>`
      : `<div class="pc-wf-unavailable">
          <div class="pc-wf-unavail-icon"><i class="ti ti-layout-board" aria-hidden="true"></i></div>
          <div class="pc-wf-unavail-title">Wireframe not available</div>
          <div class="pc-wf-unavail-desc">The wireframe is not stored after a session restore. Clicking below will regenerate the full prototype — wireframe, design brief, coverage, and prompt — based on current stories.</div>
          ${_canEditPcGen?`<button class="pc-regen-btn" onclick="pcGenerate('${e(featId)}',this)"><i class="ti ti-refresh" style="font-size:11px;" aria-hidden="true"></i> Regenerate Prototype</button>`:''}
        </div>`;

  // Design brief section
  const briefBody = v.designBrief ? pcBuildBriefHTML(v.designBrief) : '<div class="pc-empty-section">No design brief available.</div>';

  // Story coverage section
  const coverageBadgeGreen = v.coverageData ? v.coverageData.filter(function(r){return r.covered;}).length + ' of ' + v.coverageData.length + ' Covered' : '';
  const coverageGaps = v.coverageData ? v.coverageData.filter(function(r){return !r.covered;}).length : 0;
  const coverageBadgeAmber = coverageGaps > 0 ? coverageGaps + ' Gap' + (coverageGaps>1?'s':'') : '';
  const coverageBody = v.coverageData ? pcBuildCoverageHTML(v.coverageData, featId) : '<div class="pc-empty-section">No coverage data available.</div>';

  // External prompt section
  const promptBody = v.externalPrompt ? pcBuildPromptHTML(v.externalPrompt) : '<div class="pc-empty-section">No external prompt available.</div>';

  scroll.innerHTML = staleHtml + partialHtml + `
    <div class="pc-section" id="pc-sec-wireframe">
      <div class="pc-sec-hdr" onclick="pcToggleSection('wireframe')">
        <div class="pc-sec-hdr-l">
          <div class="pc-sec-icon" style="background:var(--purple-pale);color:var(--purple);"><i class="ti ti-layout-board" aria-hidden="true"></i></div>
          <span class="pc-sec-title">Wireframe</span>
          <span class="pc-sec-meta">${e(feat.name)}</span>
        </div>
        <div class="pc-sec-hdr-r">
          <div class="pc-sec-chevron open" id="pc-chev-wireframe"><i class="ti ti-chevron-down" aria-hidden="true"></i></div>
        </div>
      </div>
      <div class="pc-sec-body open" id="pc-body-wireframe">
        <div class="pc-sec-inner">${wireframeBody}</div>
      </div>
    </div>

    <div class="pc-section" id="pc-sec-brief">
      <div class="pc-sec-hdr" onclick="pcToggleSection('brief')">
        <div class="pc-sec-hdr-l">
          <div class="pc-sec-icon" style="background:var(--blue-pale);color:var(--blue);"><i class="ti ti-file-description" aria-hidden="true"></i></div>
          <span class="pc-sec-title">Design Brief</span>
          <span class="pc-sec-meta">Screen purpose, components, interactions</span>
        </div>
        <div class="pc-sec-hdr-r">
          <div class="pc-sec-chevron" id="pc-chev-brief"><i class="ti ti-chevron-down" aria-hidden="true"></i></div>
        </div>
      </div>
      <div class="pc-sec-body" id="pc-body-brief">
        <div class="pc-sec-inner">${briefBody}</div>
      </div>
    </div>

    <div class="pc-section" id="pc-sec-coverage">
      <div class="pc-sec-hdr" onclick="pcToggleSection('coverage')">
        <div class="pc-sec-hdr-l">
          <div class="pc-sec-icon" style="background:#E1F5EE;color:var(--green);"><i class="ti ti-checklist" aria-hidden="true"></i></div>
          <span class="pc-sec-title">Story Coverage</span>
        </div>
        <div class="pc-sec-hdr-r">
          ${coverageBadgeGreen?`<span class="pc-cov-badge pc-cov-green">${e(coverageBadgeGreen)}</span>`:''}
          ${coverageBadgeAmber?`<span class="pc-cov-badge pc-cov-amber">${e(coverageBadgeAmber)}</span>`:''}
          <div class="pc-sec-chevron" id="pc-chev-coverage"><i class="ti ti-chevron-down" aria-hidden="true"></i></div>
        </div>
      </div>
      <div class="pc-sec-body" id="pc-body-coverage">
        <div class="pc-sec-inner">${coverageBody}</div>
      </div>
    </div>

    <div class="pc-section" id="pc-sec-prompt">
      <div class="pc-sec-hdr" onclick="pcToggleSection('prompt')">
        <div class="pc-sec-hdr-l">
          <div class="pc-sec-icon" style="background:#1a1a2e;color:#c8c8e8;"><i class="ti ti-terminal-2" aria-hidden="true"></i></div>
          <span class="pc-sec-title">Prompt for External Tools</span>
          <span class="pc-sec-meta">Figma AI, v0, Lovable, Bolt</span>
        </div>
        <div class="pc-sec-hdr-r">
          <div class="pc-sec-chevron" id="pc-chev-prompt"><i class="ti ti-chevron-down" aria-hidden="true"></i></div>
        </div>
      </div>
      <div class="pc-sec-body" id="pc-body-prompt">
        <div class="pc-sec-inner">${promptBody}</div>
      </div>
    </div>
  `;

  if(_canEditPcGen){
    refine.style.display = '';
    refine.innerHTML = `<div class="pc-refine-inner">
      <div class="pc-refine-label">Refine Prototype</div>
      <div class="pc-refine-row">
        <textarea class="pc-refine-input" id="pc-ctx-input" placeholder="e.g. Add error state on step node, show estimated time remaining per step..." rows="2">${e(entry.additionalContext||'')}</textarea>
        <div class="pc-refine-btn-group">
          ${(typeof voiceButtonHtml==='function')?voiceButtonHtml({textareaId:'pc-ctx-input',buttonId:'pc-voice-btn',statusId:'pc-voice-status'}):''}
          <button class="pc-regen-btn-sm" onclick="pcGenerate('${e(featId)}',this)"><i class="ti ti-refresh" style="font-size:11px;" aria-hidden="true"></i> Regenerate</button>
        </div>
      </div>
    </div>`;
  } else {
    refine.style.display = 'none';
    refine.innerHTML = '';
  }

  // Inject wireframe into iframe after DOM is set
  if (hasWireframe) {
    requestAnimationFrame(function() {
      pcInjectWireframe(featId, v.wireframeHTML);
    });
  }

  // Update export button state based on actual variant state
  pcSyncExportButton(featId);
}

function pcInjectWireframe(featId, html) {
  const container = document.getElementById('pc-wf-' + featId);
  if (!container) return;
  const entry = protoStore[featId];
  const v = entry ? pcGetActiveVariant(featId) : null;
  // v9.12.06 fix: capture the OLD url and only revoke it after the new
  // iframe has been successfully constructed and appended — previously
  // this revoked before attempting the new Blob/iframe creation, so a
  // mid-attempt failure left v.wireframeBlobUrl pointing at an already-
  // revoked URL. Also now unconditionally clears the old reference even
  // if v is null on this call (a variant that didn't exist yet when first
  // stored), rather than only clearing when v happened to already exist.
  const _oldBlobUrl = v && v.wireframeBlobUrl ? v.wireframeBlobUrl : null;
  try {
    // v9.12.06 fix: sanitize BEFORE constructing the Blob — previously raw
    // AI-generated html went straight into the sandboxed iframe unfiltered,
    // which is what caused the sandbox to block any <script> tag the LLM
    // happened to include (visible to users as a console error on every
    // prototype view). Stripping it here means there's nothing left for
    // the sandbox to block, so the message stops appearing, and the same
    // filtering the capture path already had now also protects the
    // visible, long-lived preview.
    const safeHtml = _pcPreparePreviewHTML(html);
    const blob = new Blob([safeHtml], { type: 'text/html' });
    const blobUrl = URL.createObjectURL(blob);
    const iframe = document.createElement('iframe');
    iframe.className = 'pc-wf-iframe';
    // v9.12.06 fix: tightened from 'allow-same-origin' to a fully empty
    // sandbox value. Confirmed via code search that nothing in this app
    // ever reads iframe.contentDocument/contentWindow on this specific
    // preview iframe (unlike the capture iframe, which needs same-origin
    // for html2canvas) — so there's no functional reason to grant it the
    // real origin. An empty sandbox forces an opaque origin in addition
    // to blocking scripts/forms/navigation, which is strictly more
    // restrictive and removes allow-same-origin as later technical debt
    // (per the HTML spec's own warning that allow-same-origin combined
    // with allow-scripts can let a sandboxed frame remove its own sandbox
    // — not our current config, but a risk if someone "fixes
    // interactivity" here later by adding allow-scripts without
    // reconsidering allow-same-origin too).
    iframe.setAttribute('sandbox', '');
    iframe.setAttribute('title', 'Wireframe preview');
    iframe.src = blobUrl;
    container.innerHTML = '';
    container.appendChild(iframe);
    // Only store/revoke AFTER the new iframe is successfully in the DOM.
    if (v) v.wireframeBlobUrl = blobUrl;
    if (_oldBlobUrl) { try { URL.revokeObjectURL(_oldBlobUrl); } catch (_) {} }
  } catch (err) {
    container.innerHTML = '<div class="pc-empty-section">Wireframe preview unavailable in this environment.</div>';
  }
}

// ── Collapsible section toggle ──
var _pcSectionStates = { wireframe: true, brief: false, coverage: false, prompt: false };

function pcToggleSection(id) {
  _pcSectionStates[id] = !_pcSectionStates[id];
  const body = document.getElementById('pc-body-' + id);
  const chev = document.getElementById('pc-chev-' + id);
  if (body) body.classList.toggle('open', _pcSectionStates[id]);
  if (chev) chev.classList.toggle('open', _pcSectionStates[id]);
}

// ── Design brief HTML builder ──
// Renders screenPurpose and interactionNotes as sentence-split paragraphs.
// Renders edgeCases as a numbered bullet list if AI returned "1. ... 2. ..." format.
function _pcSplitProse(text) {
  if (!text) return '';
  // Split on '. ' between sentences — minimum 20 chars per fragment to avoid splitting abbreviations
  var frags = text.split(/\.\s+/);
  var result = [];
  var current = '';
  frags.forEach(function(frag, i) {
    var piece = frag.trim();
    if (!piece) return;
    // Re-attach period unless last fragment already ends with one
    var withPeriod = (i < frags.length - 1) ? piece + '.' : piece;
    if (current.length > 0 && current.length < 20) {
      // Previous fragment too short — merge with current
      current += ' ' + withPeriod;
    } else {
      if (current) result.push(current);
      current = withPeriod;
    }
  });
  if (current) result.push(current);
  if (result.length <= 1) return '<p class="pc-brief-para">' + e(text) + '</p>';
  return result.map(function(s){ return '<p class="pc-brief-para">' + e(s) + '</p>'; }).join('');
}

// ── Shared list-detection and sentence-splitting helpers ──
// Common abbreviations that contain a period followed by a lowercase letter —
// guarded before sentence-splitting so "(e.g. X, Y)" mid-sentence doesn't get
// severed into a stray fragment at the abbreviation boundary.
function _pcProtectAbbreviations(text) {
  return text
    .replace(/\be\.g\./gi, function(m){ return m[0]==='E' ? 'E§g§' : 'e§g§'; })
    .replace(/\bi\.e\./gi, function(m){ return m[0]==='I' ? 'I§e§' : 'i§e§'; });
}
function _pcRestoreAbbreviations(text) {
  return text.replace(/E§g§/g,'E.g.').replace(/e§g§/g,'e.g.').replace(/I§e§/g,'I.e.').replace(/i§e§/g,'i.e.');
}

// Numbered-list detection — anchored to the START of the text (or after a
// line break) so ordinary prose containing mid-string digit-period-space
// patterns (e.g. a malformed "2. 5 MB") is never misread as a numbered list.
function _pcIsNumberedList(text) {
  return /^\s*\d+\.\s+/.test(text) || /\n\s*\d+\.\s+/.test(text);
}
function _pcSplitNumberedList(text) {
  return text.split(/\n?\s*\d+\.\s+/).filter(function(s){ return s.trim().length > 0; });
}

function _pcBuildEdgeCaseList(text) {
  if (!text) return '';
  if (Array.isArray(text)) {
    return '<ul class="pc-edge-list">' + text.map(function(s){ return '<li class="pc-edge-item">' + e(String(s).trim()) + '</li>'; }).join('') + '</ul>';
  }
  if (_pcIsNumberedList(text)) {
    var items = _pcSplitNumberedList(text);
    if (items.length > 1) {
      return '<ul class="pc-edge-list">' + items.map(function(s){ return '<li class="pc-edge-item">' + e(s.trim()) + '</li>'; }).join('') + '</ul>';
    }
  }
  // Not a numbered list — render as prose paragraphs
  return _pcSplitProse(text);
}

// ── Always-bulleted renderer ──
// Used for the 2x2 brief grid's Interaction Notes and Edge Cases quadrants —
// unlike _pcBuildEdgeCaseList, this never falls back to prose paragraphs.
// First tries the anchored numbered-list pattern (1. ... 2. ...); if absent,
// splits on sentence boundaries instead, so plain prose still renders as bullets.
function _pcForceBulletList(text) {
  if (!text) return '';
  if (Array.isArray(text)) {
    return '<ul class="pc-edge-list">' + text.map(function(s){ return '<li class="pc-edge-item">' + e(String(s).trim()) + '</li>'; }).join('') + '</ul>';
  }
  if (_pcIsNumberedList(text)) {
    var numbered = _pcSplitNumberedList(text);
    if (numbered.length > 1) {
      return '<ul class="pc-edge-list">' + numbered.map(function(s){ return '<li class="pc-edge-item">' + e(s.trim()) + '</li>'; }).join('') + '</ul>';
    }
  }
  // Sentence-split fallback — abbreviations protected before splitting on ". "
  var protectedText = _pcProtectAbbreviations(text);
  var frags = protectedText.split(/\.\s+/);
  var result = [];
  var current = '';
  frags.forEach(function(frag, i) {
    var piece = frag.trim();
    if (!piece) return;
    var withPeriod = (i < frags.length - 1) ? piece + '.' : piece;
    if (current.length > 0 && current.length < 20) {
      current += ' ' + withPeriod;
    } else {
      if (current) result.push(current);
      current = withPeriod;
    }
  });
  if (current) result.push(current);
  if (!result.length) return '';
  return '<ul class="pc-edge-list">' + result.map(function(s){ return '<li class="pc-edge-item">' + e(_pcRestoreAbbreviations(s)) + '</li>'; }).join('') + '</ul>';
}

function pcBuildBriefHTML(brief) {
  if (!brief || typeof brief !== 'object') {
    if (typeof brief === 'string') {
      return '<div class="pc-brief-body">' + e(brief) + '</div>';
    }
    return '';
  }

  const purposeHtml = brief.screenPurpose
    ? `<div class="pc-brief-prose">${_pcSplitProse(brief.screenPurpose)}</div>`
    : '<div class="pc-empty-section">No screen purpose provided.</div>';

  const comps = (brief.keyComponents && brief.keyComponents.length)
    ? (Array.isArray(brief.keyComponents) ? brief.keyComponents.map(String) : [])
    : [];
  const componentsHtml = comps.length
    ? `<div class="pc-brief-tags">${comps.map(function(c){ return '<span class="pc-brief-tag">' + e(c) + '</span>'; }).join('')}</div>`
    : '<div class="pc-empty-section">No key components listed.</div>';

  const interactionHtml = brief.interactionNotes
    ? `<div class="pc-brief-prose">${_pcForceBulletList(brief.interactionNotes)}</div>`
    : '<div class="pc-empty-section">No interaction notes provided.</div>';

  const edgeCaseHtml = brief.edgeCases
    ? `<div class="pc-brief-prose">${_pcForceBulletList(brief.edgeCases)}</div>`
    : '<div class="pc-empty-section">No edge cases listed.</div>';

  return `<div class="pc-brief-grid">
    <div class="pc-brief-quad">
      <div class="pc-brief-sub-title">Screen Purpose</div>
      ${purposeHtml}
    </div>
    <div class="pc-brief-quad">
      <div class="pc-brief-sub-title">Key Components</div>
      ${componentsHtml}
    </div>
    <div class="pc-brief-quad">
      <div class="pc-brief-sub-title">Interaction Notes</div>
      ${interactionHtml}
    </div>
    <div class="pc-brief-quad">
      <div class="pc-brief-sub-title">Edge Cases to Design For</div>
      ${edgeCaseHtml}
    </div>
  </div>`;
}

// ── Story coverage HTML builder ──
function pcBuildCoverageHTML(coverageData, featId) {
  if (!Array.isArray(coverageData) || !coverageData.length) return '<div class="pc-empty-section">No coverage data.</div>';
  const covered = coverageData.filter(function(r){return r.covered;}).length;
  const pct = Math.round((covered / coverageData.length) * 100);
  let h = `<div class="pc-cov-bar-wrap"><div class="pc-cov-bar-fill" style="width:${pct}%;"></div></div>`;
  coverageData.forEach(function(row) {
    const cls = row.covered ? 'pc-cov-covered' : 'pc-cov-gap';
    const icon = row.covered
      ? '<i class="ti ti-check" style="font-size:7px;" aria-hidden="true"></i>'
      : '<i class="ti ti-alert-triangle" style="font-size:7px;" aria-hidden="true"></i>';
    h += `<div class="pc-story-row">
      <div class="pc-story-icon ${cls}">${icon}</div>
      <div class="pc-story-meta">
        <div class="pc-story-id">${e(row.storyId||'')}</div>
        <div class="pc-story-title">${e(row.storyTitle||'')}</div>
        <div class="pc-story-note">${e(row.note||'')}</div>
        ${!row.covered&&featId?`<button class="pc-gap-action" onclick="pcAddGapToContext('${e(featId)}','${e(row.storyTitle||'')}')">Add to Refinement Prompt</button>`:''}
      </div>
    </div>`;
  });
  return h;
}

function pcAddGapToContext(featId, storyTitle) {
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const el = document.getElementById('pc-ctx-input');
  if (el) {
    const existing = el.value.trim();
    const addition = 'Include the "' + storyTitle + '" story in the wireframe.';
    el.value = existing ? existing + ' ' + addition : addition;
    el.focus();
  }
  if (protoStore[featId]) {
    protoStore[featId].additionalContext = document.getElementById('pc-ctx-input') ?
      document.getElementById('pc-ctx-input').value : storyTitle;
  }
  // v8.146 fix: confirmed missing entirely.
  if(typeof _isDemoSession!=='undefined'&&!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('pc',featId); });
  }
}

// ── External prompt HTML builder ──
function pcBuildPromptHTML(promptText) {
  if (!promptText) return '<div class="pc-empty-section">No external prompt available.</div>';
  const safeId = 'pc-ext-prompt-txt';
  return `<div class="pc-brief-body" style="margin-bottom:8px;">Copy this prompt into any prototyping tool to generate a high-fidelity version of this screen.</div>
    <div class="pc-prompt-block">
      <button class="pc-prompt-copy" onclick="pcCopyPrompt('${safeId}',this)"><i class="ti ti-copy" style="font-size:9px;" aria-hidden="true"></i> Copy</button>
      <div class="pc-prompt-text" id="${safeId}">${e(promptText)}</div>
    </div>
    <div class="pc-tools-row">
      <span class="pc-tools-label">Works with:</span>
      <span class="pc-tool-tag">Figma AI</span>
      <span class="pc-tool-tag">v0</span>
      <span class="pc-tool-tag">Lovable</span>
      <span class="pc-tool-tag">Bolt</span>
      <span class="pc-tool-tag">Galileo</span>
    </div>`;
}

function pcCopyPrompt(elId, btn) {
  const el = document.getElementById(elId);
  if (!el) return;
  navigator.clipboard.writeText(el.innerText).then(function() {
    if (btn) {
      btn.innerHTML = '<i class="ti ti-check" style="font-size:9px;"></i> Copied';
      setTimeout(function(){ btn.innerHTML = '<i class="ti ti-copy" style="font-size:9px;"></i> Copy'; }, 2000);
    }
  }).catch(function(){
    if (typeof showToast === 'function') showToast('Copy failed. Please copy manually.', 'warn');
  });
}

// ── Generation — two-call split ──
// Call 1: wireframe + screenTitle + wireframeOutline (skipped for non-UI features)
// Call 2: design brief + story coverage + external prompt
async function pcGenerate(featId, triggerEl) {
  // v9.25 code-review fix — canEditSession() now checked BEFORE stopping
  // voice (was after): a read-only collaborator's click here is a no-op
  // regardless, so it shouldn't also silently kill their dictation with no
  // explanation.
  if(typeof canEditSession==='function'&&!canEditSession())return;
  if (!featId) return;
  // stop-on-send: pcReadAdditionalContext() below reads #pc-ctx-input's
  // live value synchronously, before this function's own loading state
  // (v.generating=true) triggers any re-render, so stopping here first
  // doesn't affect what gets captured.
  voiceStopActive('abort');

  // pcReady guard
  if (!pcReady) {
    if (typeof showToast === 'function') showToast('Prototype tools are still loading. Try again in a moment.', 'info');
    return;
  }

  // AI generation guard
  if (typeof aiGenInFlight !== 'undefined' && aiGenInFlight.active) {
    if (typeof showToast === 'function') showToast('Still working on your last request. Finish or leave before starting another.', 'info');
    return;
  }

  const feat = pcGetLiveFeature(featId);
  if (!feat) return;

  // Minimum story check
  const visibleStories = feat.stories ? feat.stories.filter(function(s){return s._inSC&&!s._hiddenFromSC;}) : [];
  if (visibleStories.length < 2) {
    if (typeof showToast === 'function') showToast('At least 2 stories needed to generate a prototype.', 'warn');
    return;
  }

  // Phase 5 fix (v8.118): immediate visual acknowledgment on click, before
  // the lock check. This function is unusual among the wrapped generation
  // functions in having SIX distinct possible trigger buttons (confirmed
  // via grep — empty-state, stale-banner, partial-banner, two regenerate
  // variants, and a try-again-on-error button), none referenced by a
  // shared ID, so triggerEl (the actual clicked element, passed via `this`
  // at every one of the six call sites) is disabled directly here rather
  // than looking up any one specific ID.
  if(triggerEl&&typeof triggerEl==='object'&&triggerEl.disabled!==undefined){
    triggerEl.disabled=true;
  }

  // Non-UI detection
  const isNonUI = pcIsNonUIFeature(featId);

  // Ensure entry exists
  if (!protoStore[featId]) protoStore[featId] = pcMakeEmptyEntry(featId);
  const entry = protoStore[featId];
  const v = entry.variants[entry.activeVariantId];

  // Read and store submitted context
  const submittedContext = pcReadAdditionalContext(featId);
  entry.additionalContext = submittedContext;

  // Freeze story and feature snapshots before any await — prevents mutation during generation
  const storySnapshot = pcCanonicalStories(feat);
  const sigBefore = pcFeatureSignature(feat, submittedContext);

  // Set loading state early
  v.generating = true;
  v.generatingPhase = isNonUI ? 2 : 1;
  v.partial = false;
  v.partialReason = null;
  v.nonUI = isNonUI;
  pcSyncExportButton(featId);

  // Phase 5 (v8.117): attempt marker, layered ON TOP of the existing
  // pcCanRenderFeature() guard (which already correctly handles the
  // navigation-away case at all 8 DOM-write points below — genuinely
  // pre-existing, not something built this phase). pcCanRenderFeature()
  // checks "is this feature still the active nav feature," which does NOT
  // distinguish an older, slower generateFor(featId) call from a NEWER
  // one on the SAME featId — both would pass that check identically. The
  // marker, stored directly on the variant object (v._genAttemptId, not a
  // DOM attribute — there's no natural DOM element to stamp here the way
  // the other 9 functions had, since this writes into protoStore state
  // that pcRenderView() reads, not a container this function owns
  // directly), closes that specific gap: only the MOST RECENT attempt for
  // this featId is allowed to write its result.
  const _attemptId = 'protogen_' + (Date.now()) + '_' + Math.random().toString(36).slice(2);
  v._genAttemptId = _attemptId;
  function _pcIsCurrentAttempt(){
    const liveV = pcGetActiveVariant(featId);
    return !!(liveV && liveV._genAttemptId === _attemptId);
  }

  // startAiGen fires BEFORE any async work — tab navigation now blocked immediately
  let signal;
  signal = typeof startAiGen === 'function'
    ? startAiGen('Prototype for "' + feat.name + '" is being generated. Leaving now will discard incomplete work.')
    : null;

  // Phase 5: withGenerationLock wraps the ENTIRE two-call sequence and all
  // four partial-success save points below. Unlike every other wrapped
  // function in this app, pcGenerate() deliberately saves BEST-EFFORT
  // partial results on several failure paths (aborted-after-wireframe,
  // brief-failed, post-process-failed-but-recovered) — this is intentional
  // existing behavior, not something to discard-on-any-error like the
  // simpler single-shot generators elsewhere. Each of the four save points
  // below gets its own throwIfLost() checkpoint immediately before it,
  // consistent with every other wrapped function, but none of the
  // AbortError/pcPhase branches themselves are changed to rethrow-and-
  // discard — that would destroy legitimately-recoverable partial work
  // this function is specifically designed to preserve.
  try{
    await withGenerationLock(async (_lock) => {

  // Show loading state
  if (pcCanRenderFeature(featId) && _pcIsCurrentAttempt()) {
    const scroll = document.getElementById('pc-scroll');
    const refine = document.getElementById('pc-refine-bar');
    if (scroll && refine) pcRenderLoading(featId, scroll, refine);
  }

  // Prep context (peer features, cap context, screenshot) — frozen before first await
  const peerFeatures = (typeof scCanvas !== 'undefined' ? scCanvas : [])
    .filter(function(f){return f.id!==featId&&f.cap===feat.cap&&f.stories&&f.stories.some(function(s){return s._inSC&&!s._hiddenFromSC;});})
    .slice(0, 3)
    .map(function(f){return {name:f.name,why:f.why||'',stories:pcCanonicalStories(f).slice(0,3)};});

  let capWhy = '';
  if (typeof capStore !== 'undefined') {
    for (const mk of Object.keys(capStore)) {
      const ce = capStore[mk];
      if (ce && ce.capabilities) {
        const c = ce.capabilities.find(function(c){return c.name===feat.cap;});
        if (c && c.why) { capWhy = c.why; break; }
      }
    }
  }

  const ss = pcGetScreenshotContext(featId);

  let call1Ok = false;
  let parsed1 = null;

  // Outcome-Based Cost report-back ids (v9.31) — one per underlying AI call,
  // not per click. Only briefCallId ever reports a nonzero units_generated;
  // wireframeCallId may only ever report 0, on its own failure. See
  // proxy/server.js's CALLER_ATTRIBUTION_MODE comment for why (double-count
  // risk if this asymmetry is ever "fixed" to be symmetric).
  const wireframeCallId = (typeof crypto!=='undefined'&&crypto.randomUUID) ? crypto.randomUUID() : (Date.now()+'-'+Math.random().toString(36).slice(2));
  const briefCallId = (typeof crypto!=='undefined'&&crypto.randomUUID) ? crypto.randomUUID() : (Date.now()+'-'+Math.random().toString(36).slice(2)+'-b');

  try {
    // Fetch style guide (signal-aware — aborts correctly if user leaves)
    const styleGuide = await _pcGetStyleGuide(signal);

    // ── CALL 1: Wireframe (skipped for non-UI features) ──
    let screenTitle = feat.name;
    let wireframeOutline = null;

    if (!isNonUI) {
      const promptCtx = typeof getFullProductCtx === 'function' ? getFullProductCtx() : { name: 'the product', industry: '' };
      const wfPrompt = buildPrototypeWireframePrompt(promptCtx, feat, storySnapshot, peerFeatures, capWhy, submittedContext, !!(ss), styleGuide);

      let parsed1Raw;
      try {
        const txt1 = await callAPI(wfPrompt.sys, wfPrompt.usr, 4000, signal, 'claude-haiku-4-5', 'prototype-wireframe', undefined, { client_call_id: wireframeCallId });
        const clean1 = txt1.replace(/```json|```/g, '').trim();
        try { parsed1Raw = JSON.parse(clean1); }
        catch(pe1) { throw new Error('Wireframe response could not be parsed. Please try again.'); }
        parsed1 = pcNormalizeWireframeResponse(parsed1Raw);
        call1Ok = true;
      } catch(e1) {
        // Safe to report 0 for a genuine network/timeout/parse failure —
        // that row is either already auto-resolved to 0 server-side (no-op
        // here, WHERE units_generated IS NULL guard) or would otherwise sit
        // at units_generated=null forever. NOT safe for AbortError: the
        // client gave up waiting, but proxy/server.js has no
        // req.on('close')/req.aborted handling on this path, so the
        // upstream call may still complete and insert a real 'success' row
        // after we've already left. Reporting 0 in that case would
        // permanently mislabel a real success as a failure with no way to
        // self-correct — leave it unreported (null) instead.
        if (!(e1 && e1.name === 'AbortError')) _pcReportUnitsGenerated(wireframeCallId, 0);
        e1.pcPhase = 1;
        throw e1;
      }

      // Feature existence check after Call 1
      if (!pcGetLiveFeature(featId)) { v.generating = false; v.generatingPhase = null; return; }

      // Write wireframe state — phase 2 begins
      v.wireframeHTML = parsed1.wireframeHTML;
      screenTitle = parsed1.screenTitle || feat.name;
      wireframeOutline = parsed1.wireframeOutline || null;
      v.generatingPhase = 2;

      // Advance loading UI to phase 2
      if (pcCanRenderFeature(featId) && _pcIsCurrentAttempt()) {
        const scroll = document.getElementById('pc-scroll');
        const refine = document.getElementById('pc-refine-bar');
        if (scroll && refine) pcRenderLoading(featId, scroll, refine);
      }
    }

    // ── CALL 2: Design brief + coverage + external prompt ──
    const promptCtx2 = typeof getFullProductCtx === 'function' ? getFullProductCtx() : { name: 'the product', industry: '' };
    const briefPrompt = buildPrototypeBriefPrompt(promptCtx2, feat, storySnapshot, screenTitle, wireframeOutline, isNonUI);

    let parsed2Raw;
    try {
      const txt2 = await callAPI(briefPrompt.sys, briefPrompt.usr, 3000, signal, null, 'prototype-brief', undefined, { client_call_id: briefCallId });
      const clean2 = txt2.replace(/```json|```/g, '').trim();
      try { parsed2Raw = JSON.parse(clean2); }
      catch(pe2) { throw new Error('Design brief response could not be parsed.'); }
    } catch(e2) {
      // Same AbortError exception as wireframe's catch above — see that
      // comment. A network/timeout/parse failure is safe to report as 0;
      // an aborted client fetch is not, since the proxy may still complete
      // the upstream call and insert a real success row after we've left.
      if (!(e2 && e2.name === 'AbortError')) _pcReportUnitsGenerated(briefCallId, 0);
      e2.pcPhase = 2;
      throw e2;
    }

    // ── POST-PROCESSING: normalize+commit (subphase A) then render+save (subphase B) ──
    // Both API calls have already succeeded at this point. Any failure below
    // is a client-side bug, not a generation failure — tag pcPhase=3 so the
    // catch block below can preserve the wireframe (and brief data, since we
    // have it in memory) via the partial-success path instead of discarding
    // a successful generation behind a hard "Generation Failed" screen.
    // Split into two subphases: a normalize+commit failure means the brief data
    // itself is unusable (safe to discard); a render+save failure means the data
    // is fine but rendering/persistence crashed (still worth showing the partial banner).
    let briefData;
    try {
      briefData = pcNormalizeBriefResponse(parsed2Raw);
    } catch(e3a) {
      _pcReportUnitsGenerated(briefCallId, 0);
      e3a.pcPhase = 3;
      e3a.pcSubphase = 'normalize';
      throw e3a;
    }

    // Outcome-Based Cost: decide + report now, before the feature-existence
    // check below — deliberately, not an oversight. "Created" measures that
    // the model did its job, not that the user still has this feature to
    // look at (confirmed product decision) — so this must fire even if the
    // feature gets deleted, or the commit/render below crashes, a moment
    // later. isNonUI features never attempt a wireframe, so the design
    // brief's own substantive content is the only available signal for them.
    const prototypeCreated = isNonUI
      ? !!(briefData.screenPurpose && briefData.screenPurpose.trim())
      : !!v.wireframeHTML;
    _pcReportUnitsGenerated(briefCallId, prototypeCreated ? 1 : 0);

    // Feature existence check after Call 2
    const featNow = pcGetLiveFeature(featId);
    if (!featNow) { v.generating = false; v.generatingPhase = null; return; }

    // Stale detection — sigBefore vs current live state
    const sigNow = pcFeatureSignature(featNow, submittedContext);

    try {
      // Commit full result
      v.generated = true;
      v.generating = false;
      v.generatingPhase = null;
      v.stale = sigNow !== sigBefore;
      v.generatedAt = Date.now();
      v.inputSignature = sigBefore;
      v.designBrief = {
        screenPurpose: briefData.screenPurpose,
        keyComponents: briefData.keyComponents,
        interactionNotes: briefData.interactionNotes,
        edgeCases: briefData.edgeCases
      };
      v.coverageData = briefData.storyCoverage;
      v.externalPrompt = briefData.externalPrompt;
      v.partial = false;
      v.partialReason = null;
    } catch(e3b) {
      e3b.pcPhase = 3;
      e3b.pcSubphase = 'commit';
      throw e3b;
    }

    try {
      if (v.stale && typeof showToast === 'function') {
        showToast('Prototype generated, but stories changed during generation. Review and regenerate if needed.', 'warn');
      }

      if (pcCanRenderFeature(featId) && _pcIsCurrentAttempt()) pcRenderView(featId);

      // Phase 5: checkpoint before the main success save.
      _lock.throwIfLost();
      if (typeof _isDemoSession !== 'undefined' && !_isDemoSession &&
          typeof sessionStoreSave === 'function' &&
          typeof _activeSessionId !== 'undefined' && _activeSessionId) {
        const _pcOk = await sessionStoreSave(_activeSessionId);
        // Build B: only this path represents a genuinely complete, non-
        // partial generation — the other three save sites in this
        // function are all partial-failure recoveries (v.partial=true)
        // and deliberately do not emit this event, since claiming
        // "prototype generated" for an incomplete result would mislead
        // a collaborator.
        if (_pcOk && typeof _activeSessionIsShared !== 'undefined' && _activeSessionIsShared && typeof _lsEmitContentEvent === 'function') {
          await _lsEmitContentEvent(_activeSessionId, 'pc', 'prototype_generated', featId, null);
        }
      }
    } catch(e3c) {
      e3c.pcPhase = 3;
      e3c.pcSubphase = 'render_or_save';
      // Brief data is already committed to v at this point — preserve it.
      // Recovery below should NOT wipe designBrief/coverageData/externalPrompt
      // for this subphase, since the commit subphase already succeeded.
      throw e3c;
    }

  } catch (err) {
    // AbortError — user clicked "Leave anyway"
    if (err && err.name === 'AbortError') {
      if (call1Ok && parsed1) {
        // Call 1 succeeded before abort — save partial wireframe
        v.generated = true;
        v.generating = false;
        v.generatingPhase = null;
        v.generatedAt = Date.now();
        v.inputSignature = sigBefore;
        v.stale = false;
        v.partial = true;
        v.partialReason = 'aborted_after_wireframe';
        v.designBrief = null;
        v.coverageData = null;
        v.externalPrompt = null;
        // Phase 5: checkpoint before this partial save. Note: an ABORT and
        // a lock-loss are different signals that could theoretically both
        // reach here (an AbortError from the user AND a lost lock from a
        // heartbeat, in either order) — if the lock was lost, skip this
        // save too, same reasoning as the other checkpoints.
        try { _lock.throwIfLost(); } catch(lockLostErr) {
          v.generating = false; v.generatingPhase = null;
          return;
        }
        if (typeof _isDemoSession !== 'undefined' && !_isDemoSession &&
            typeof sessionStoreSave === 'function' &&
            typeof _activeSessionId !== 'undefined' && _activeSessionId) {
          sessionStoreSave(_activeSessionId);
        }
      } else {
        v.generating = false;
        v.generatingPhase = null;
      }
      return;
    }

    // Call 2 failed — wireframe already saved from Call 1 (or non-UI skipped Call 1)
    if (err && err.pcPhase === 2 && call1Ok) {
      v.generated = true;
      v.generating = false;
      v.generatingPhase = null;
      v.generatedAt = Date.now();
      v.inputSignature = sigBefore;
      v.stale = false;
      v.partial = true;
      v.partialReason = 'brief_failed';
      v.designBrief = null;
      v.coverageData = null;
      v.externalPrompt = null;
      if (pcCanRenderFeature(featId) && _pcIsCurrentAttempt()) pcRenderView(featId);
      // Phase 5: checkpoint before this partial save, same reasoning as
      // the abort-after-wireframe branch above.
      try { _lock.throwIfLost(); } catch(lockLostErr) {
        return;
      }
      if (typeof _isDemoSession !== 'undefined' && !_isDemoSession &&
          typeof sessionStoreSave === 'function' &&
          typeof _activeSessionId !== 'undefined' && _activeSessionId) {
        sessionStoreSave(_activeSessionId);
      }
      return;
    }

    // Post-processing failed after Call 2 succeeded — wireframe (if any) and the
    // raw brief response both exist; attempt a defensive partial commit rather
    // than discarding a successful generation.
    if (err && err.pcPhase === 3) {
      // Phase 5: if THIS specific pcPhase=3 error is actually a lock-lost
      // signal from the checkpoint above (not a genuine rendering/save
      // bug), do NOT attempt the recovery save below — that save is
      // exactly what the checkpoint was trying to prevent. Toast already
      // shown by withGenerationLock() itself.
      if (err.message === 'generation_lock_lost') {
        v.generating = false;
        v.generatingPhase = null;
        if (pcCanRenderFeature(featId) && _pcIsCurrentAttempt()) pcRenderView(featId);
        return;
      }
      console.error('[PC] Post-processing failed after successful generation:', err.message, err.stack, 'subphase:', err.pcSubphase);
      let recovered = false;
      try {
        v.generated = true;
        v.generating = false;
        v.generatingPhase = null;
        v.generatedAt = Date.now();
        v.inputSignature = sigBefore;
        v.stale = false;
        v.partial = true;
        v.partialReason = 'post_process_failed';
        // render_or_save failures happen AFTER commit already wrote designBrief/
        // coverageData/externalPrompt into v — don't wipe data that's already good.
        // normalize/commit failures mean that data was never safely written — clear it.
        if (err.pcSubphase !== 'render_or_save') {
          v.designBrief = null;
          v.coverageData = null;
          v.externalPrompt = null;
        }
        if (pcCanRenderFeature(featId) && _pcIsCurrentAttempt()) pcRenderView(featId);
        // Phase 5: checkpoint before this recovery save. Separate from the
        // early-return special-case above — that one catches the lock-lost
        // error THAT TRIGGERED this branch; this catches the lock being
        // lost by a LATER heartbeat tick while recovery itself was running.
        _lock.throwIfLost();
        if (typeof _isDemoSession !== 'undefined' && !_isDemoSession &&
            typeof sessionStoreSave === 'function' &&
            typeof _activeSessionId !== 'undefined' && _activeSessionId) {
          sessionStoreSave(_activeSessionId);
        }
        recovered = true;
      } catch(e4) {
        console.error('[PC] Partial recovery after pcPhase=3 also failed:', e4.message, e4.stack);
        // recovered stays false — falls through to generic error screen below
      }
      if (recovered) return;
    }

    // Call 1 failed or other error — show error screen
    console.error('[PC] Generation failed:', err && err.message, err && err.stack, 'phase:', err && err.pcPhase);
    v.generating = false;
    v.generatingPhase = null;
    v.generated = v.generated || false;
    if (pcCanRenderFeature(featId) && _pcIsCurrentAttempt()) {
      const scroll = document.getElementById('pc-scroll');
      const refine = document.getElementById('pc-refine-bar');
      if (scroll) {
        scroll.classList.add('pc-scroll-centered');
        scroll.innerHTML = `<div class="pc-error-wrap">
          <div class="pc-error-icon"><i class="ti ti-wifi-off" aria-hidden="true"></i></div>
          <div class="pc-error-title">Prototype Generation Failed</div>
          <div class="pc-error-desc">Something went wrong. Your stories and context are safe.</div>
          <button class="pc-regen-btn" onclick="pcGenerate('${e(featId)}',this)"><i class="ti ti-refresh" style="font-size:11px;" aria-hidden="true"></i> Try Again</button>
        </div>`;
      }
      if (refine) { refine.style.display = 'none'; refine.innerHTML = ''; }
    }

  } finally {
    v.generating = false;
    v.generatingPhase = null;
    pcSyncExportButton(featId);
    if (typeof endAiGen === 'function') endAiGen();
  }
    });
  }catch(lockErr){
    // Phase 5 fix (v8.118): REAL BUG, same class as ccGenerateOne()'s —
    // this outer catch fires for a pre-flight lock rejection, and the
    // triggerEl disabled at the top of this function was never being
    // re-enabled here. pcRenderView() (which WOULD naturally replace the
    // view, making the stale reference moot) only runs from inside the
    // inner try, which this rejection never reaches — the original view,
    // including the button the user clicked, is left completely
    // untouched, disabled forever until some unrelated navigation
    // happens to redraw it. Confirmed via live testing, not hypothetical.
    pcSyncExportButton(featId);
    if(triggerEl&&typeof triggerEl==='object'&&triggerEl.disabled!==undefined){
      triggerEl.disabled=false;
    }
  }
}

// ── html2canvas lazy loader ──
var _pcHtml2CanvasPromise = null;
async function _pcLoadHtml2Canvas() {
  if (typeof html2canvas !== 'undefined') return true;
  if (_pcHtml2CanvasPromise) return _pcHtml2CanvasPromise;
  _pcHtml2CanvasPromise = new Promise(function(res) {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
    s.onload = function() { res(true); };
    s.onerror = function() {
      _pcHtml2CanvasPromise = null; // allow retry on failure
      console.warn('[PC] html2canvas CDN load failed');
      res(false);
    };
    document.head.appendChild(s);
  });
  return _pcHtml2CanvasPromise;
}

// ── Shared stripping primitive for AI-generated wireframe HTML ──
// v9.12.06 hardening: this replaces the old _pcSanitizeForCapture, which
// was used for BOTH the hidden capture iframe AND (after this same patch)
// the visible preview iframe, despite the two having different lifetimes,
// visibility, and risk profiles. Per adversarial review, this is
// deliberately named to describe exactly what it does — a blocklist of
// active/executable constructs — and NOT named in a way that implies a
// general "this HTML is now safe" guarantee, which a blocklist of this
// size cannot honestly claim. Two thin, purpose-specific wrappers below
// (_pcPreparePreviewHTML, _pcPrepareCaptureHTML) call this with the same
// policy today; kept separate per-caller so their behavior can diverge
// later without coupling one path's changes to the other's.
//
// Known, accepted limitation (confirmed via adversarial review, not
// fixed here — this is a blocklist, not a full HTML sanitizer like
// DOMPurify): sufficiently obscure payloads (SVG-embedded handlers,
// mutation-XSS-style parser quirks, CSS-based resource requests) may
// still survive. The sandbox attribute on both iframes remains the real
// security boundary; this function is defense-in-depth on top of that,
// not a replacement for it.
function _pcStripActiveWireframeMarkup(html) {
  if (typeof html !== 'string') return '';
  const tpl = document.createElement('template');
  tpl.innerHTML = html;

  // Remove elements capable of executing code, navigating the frame, or
  // altering how relative URLs/targets resolve within it.
  tpl.content.querySelectorAll(
    'script,iframe,object,embed,base,meta[http-equiv="refresh" i],link[rel="import" i]'
  ).forEach(function(n){ n.remove(); });

  tpl.content.querySelectorAll('*').forEach(function(el) {
    Array.from(el.attributes).forEach(function(attr) {
      const name = attr.name.toLowerCase();
      // Strip ASCII control characters (tabs, newlines, etc.) before
      // scheme-matching — browsers ignore these when parsing a URL
      // scheme, so "java\tscript:" still executes as javascript: even
      // though a naive .trim()-only check would miss it.
      const normalized = String(attr.value || '')
        .replace(/[\u0000-\u0020\u007f-\u009f]/g, '')
        .toLowerCase();

      if (name.startsWith('on')) { el.removeAttribute(attr.name); return; }
      // Beaconing attribute — not needed for a visual mockup, no reason
      // to let a wireframe emit tracking requests on click.
      if (name === 'ping') { el.removeAttribute(attr.name); return; }
      if (name === 'href' || name === 'src' || name === 'xlink:href' ||
          name === 'action' || name === 'formaction') {
        if (normalized.startsWith('javascript:') || normalized.startsWith('vbscript:')) {
          el.removeAttribute(attr.name);
        }
      }
    });
  });

  return tpl.innerHTML;
}

// ── Preview policy — used for the long-lived, user-visible iframe ──
function _pcPreparePreviewHTML(html) {
  try {
    return _pcStripActiveWireframeMarkup(html);
  } catch(e) {
    console.warn('[PC] Preview HTML preparation failed, showing nothing rather than unfiltered content:', e.message);
    // v9.12.06 fix: fail CLOSED, not open. The old fallback
    // (html.replace(/<script>.../, '')) shipped a much weaker filter with
    // none of the attribute-level stripping above — confirmed via
    // adversarial review to be a real gap, not an acceptable degradation.
    // An empty string here renders as a blank preview, which is safe;
    // returning partially-filtered attacker-influenced HTML is not.
    return '';
  }
}

// ── Capture policy — used for the short-lived, hidden html2canvas iframe ──
// Currently identical filtering to the preview policy; kept as a separate
// named function (not a shared call site) so this path's behavior can be
// tuned independently later (e.g. if html2canvas needs different
// image/font/CSS allowances) without touching the preview path.
function _pcPrepareCaptureHTML(html) {
  try {
    return _pcStripActiveWireframeMarkup(html);
  } catch(e) {
    console.warn('[PC] Capture HTML preparation failed, aborting capture rather than using unfiltered content:', e.message);
    return '';
  }
}

// ── Capture wireframe HTML as PNG data URL ──
// Uses a sandboxed same-origin iframe so wireframe <style> tags never
// leak into the live document — previously caused white border around app.
async function _pcCaptureWireframeAsPng(wireframeHTML) {
  const safeHTML = _pcPrepareCaptureHTML(wireframeHTML);

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  // v9.12.06 fix: this iframe previously had NO sandbox attribute at all —
  // confirmed via adversarial review to be the more serious of the two
  // gaps found (the visible preview iframe was already sandboxed; this
  // hidden one was not). allow-same-origin is required here (unlike the
  // preview iframe below) because this function reads iframe.contentDocument
  // directly for html2canvas — but scripts remain fully blocked regardless
  // of sanitizer coverage, closing the "one sanitizer bypass = full
  // same-origin code execution" risk the review identified.
  iframe.setAttribute('sandbox', 'allow-same-origin');
  iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:1200px;height:900px;border:0;visibility:hidden;pointer-events:none;';
  document.body.appendChild(iframe);

  try {
    const doc = iframe.contentDocument;
    if (!doc) return null;

    doc.open();
    doc.write('<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;width:1200px;height:900px;overflow:hidden;background:#fff;}*,*::before,*::after{box-sizing:border-box;}</style></head><body><div id="pc-capture-root" style="width:1200px;height:900px;overflow:hidden;background:#fff;">' + safeHTML + '</div></body></html>');
    doc.close();

    // Wait for layout and fonts to settle
    await new Promise(function(r){ setTimeout(r, 200); });
    if (doc.fonts && typeof doc.fonts.ready === 'object') {
      try { await doc.fonts.ready; } catch(_) {}
    }

    const root = doc.getElementById('pc-capture-root');
    if (!root) return null;

    const canvas = await html2canvas(root, {
      allowTaint: false,
      useCORS: true,
      scale: 0.75,
      logging: false,
      backgroundColor: '#ffffff',
      width: 1200,
      height: 900,
      windowWidth: 1200,
      windowHeight: 900,
      scrollX: 0,
      scrollY: 0
    });

    try {
      return canvas.toDataURL('image/png');
    } catch(te) {
      console.warn('[PC] Canvas tainted — cannot export wireframe image:', te.message);
      return null;
    }
  } catch(e) {
    console.warn('[PC] html2canvas failed:', e.message);
    return null;
  } finally {
    try { document.body.removeChild(iframe); } catch(_) {}
  }
}

// ── Export Prototype DOCX ──
async function pcExportPrototype(featId) {
  if (!featId) return;
  // In-flight guard — prevent double export
  if (_pcExportInFlight) {
    if (typeof showToast === 'function') showToast('Export already in progress.', 'info');
    return;
  }
  _pcExportInFlight = true;
  // Disable export button during export
  const expBtnStart = document.getElementById('nsc-proto-export-btn');
  if (expBtnStart) expBtnStart.disabled = true;

  try {
    const feat = pcGetLiveFeature(featId);
    if (!feat) { if (typeof showToast === 'function') showToast('Feature not found.', 'warn'); return; }
    const v = pcGetActiveVariant(featId);
    if (!v || !v.generated) { if (typeof showToast === 'function') showToast('Generate a prototype first.', 'info'); return; }

    if (typeof showToast === 'function') showToast('Preparing DOCX...', 'info');

    // Load docx and html2canvas in parallel
    const [_, h2cLoaded] = await Promise.all([
      (async function() {
        if (typeof docx === 'undefined' || !docx.Document) {
          await new Promise(function(res, rej) {
            const s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/docx@7.8.2/build/index.js';
            s.onload = res;
            s.onerror = function(){ rej(new Error('Could not load docx library.')); };
            document.head.appendChild(s);
          });
        }
      })(),
      v.wireframeHTML ? _pcLoadHtml2Canvas() : Promise.resolve(false)
    ]);

    // Yield to browser before heavy synchronous document build
    await new Promise(function(r){setTimeout(r,0);});

    const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
      HeadingLevel, AlignmentType, BorderStyle, WidthType, ShadingType, VerticalAlign, ImageRun } = docx;

    const NAVY='003087', PURPLE='5F1EBE', GREY='5C5B57', WHITE='FFFFFF';
    const bdr = c => ({ style: BorderStyle.SINGLE, size: 1, color: c||'CCCCCC' });
    const bdrs = c => ({ top:bdr(c),bottom:bdr(c),left:bdr(c),right:bdr(c) });
    const gap = (n=80) => new Paragraph({ spacing:{before:n,after:0}, children:[new TextRun('')] });
    const h2 = t => new Paragraph({ heading:HeadingLevel.HEADING_2, spacing:{before:240,after:60}, children:[new TextRun({text:t,font:'Arial',size:26,bold:true,color:NAVY})] });
    const h3 = t => new Paragraph({ spacing:{before:180,after:40}, children:[new TextRun({text:t,font:'Arial',size:22,bold:true,color:PURPLE})] });
    const body = t => new Paragraph({ spacing:{before:30,after:30}, children:[new TextRun({text:String(t||''),font:'Arial',size:20,color:'2C2C2C'})] });
    const pcBul = t => new Paragraph({ spacing:{before:16,after:16}, numbering:{reference:'pc-bullets',level:0}, children:[new TextRun({text:String(t||''),font:'Arial',size:20,color:'2C2C2C'})] });

    // ── List normalization + bullet section helper ──
    // Used for fields that may arrive as an array, a newline-delimited string,
    // or — the common case — a single unbroken multi-sentence string with no
    // newlines at all. Sentence-splits on '. ' boundaries (same approach as
    // the in-app _pcForceBulletList) so prose still renders as multiple
    // scannable bullets rather than one giant block of text in one bullet.
    const linesOf = value => {
      if (Array.isArray(value)) return value.map(String);
      const text = String(value || '');
      if (/\r?\n/.test(text)) return text.split(/\r?\n/);
      // Genuine numbered list (anchored to start or after a line break) — same
      // detection as _pcIsNumberedList in the in-app renderer.
      if (/^\s*\d+\.\s+/.test(text)) {
        const numbered = text.split(/\n?\s*\d+\.\s+/).filter(function(s){return s.trim().length>0;});
        if (numbered.length > 1) return numbered;
      }
      // No newlines, not numbered — sentence-split with abbreviation protection
      // (e.g./i.e.) and short-fragment merging, same logic as _pcForceBulletList.
      const protectedText = text
        .replace(/\be\.g\./gi, function(m){ return m[0]==='E' ? 'E§g§' : 'e§g§'; })
        .replace(/\bi\.e\./gi, function(m){ return m[0]==='I' ? 'I§e§' : 'i§e§'; });
      const frags = protectedText.split(/\.\s+/);
      const result = [];
      let current = '';
      frags.forEach(function(frag, i){
        const piece = frag.trim();
        if (!piece) return;
        const withPeriod = (i < frags.length - 1) ? piece + '.' : piece;
        if (current.length > 0 && current.length < 20) {
          current += ' ' + withPeriod;
        } else {
          if (current) result.push(current);
          current = withPeriod;
        }
      });
      if (current) result.push(current);
      return result.map(function(s){
        return s.replace(/E§g§/g,'E.g.').replace(/e§g§/g,'e.g.').replace(/I§e§/g,'I.e.').replace(/i§e§/g,'i.e.');
      });
    };
    const pushBullets = (sectionsArr, title, value) => {
      const lines = linesOf(value).map(function(s){return s.trim();}).filter(Boolean);
      if (!lines.length) return;
      sectionsArr.push(h3(title));
      lines.forEach(function(line){ sectionsArr.push(pcBul(line)); });
    };
    // Multi-line prose (e.g. externalPrompt's SCREEN:/LAYOUT:/etc. sections) —
    // one Paragraph per non-empty line, small gap Paragraph for blank lines,
    // since \n inside a single TextRun is not rendered as a line break by Word.
    const pushMultilineBody = (sectionsArr, value) => {
      String(value || '').split(/\r?\n/).forEach(function(line){
        const trimmed = line.trim();
        sectionsArr.push(trimmed ? body(trimmed) : new Paragraph({ spacing:{before:40,after:40}, children:[] }));
      });
    };

    // Story cell: ID in muted colour + title
    const storyCell = function(storyId, storyTitle) {
      return new TableCell({
        borders:bdrs('DDDDDD'),
        width:{size:2000,type:WidthType.DXA},
        margins:{top:80,bottom:80,left:120,right:120},
        verticalAlign:VerticalAlign.TOP,
        children:[new Paragraph({spacing:{before:0,after:0},children:[
          new TextRun({text:(storyId||'')+' ',font:'Arial',size:16,bold:true,color:'888888'}),
          new TextRun({text:(storyTitle||'').substring(0,50),font:'Arial',size:16,color:'2C2C2C'})
        ]})]
      });
    };
    const cell = (t,w,bg,bold,color) => new TableCell({
      borders:bdrs('DDDDDD'),
      shading:bg?{fill:bg,type:ShadingType.CLEAR}:undefined,
      width:w?{size:w,type:WidthType.DXA}:undefined,
      margins:{top:80,bottom:80,left:120,right:120},
      verticalAlign:VerticalAlign.TOP,
      children:[new Paragraph({spacing:{before:0,after:0},children:[new TextRun({text:String(t||''),font:'Arial',size:18,bold:!!bold,color:color||'2C2C2C'})]})]
    });
    const hcell = (t,w) => new TableCell({
      borders:bdrs('DDDDDD'),
      shading:{fill:NAVY,type:ShadingType.CLEAR},
      width:{size:w,type:WidthType.DXA},
      margins:{top:80,bottom:80,left:120,right:120},
      verticalAlign:VerticalAlign.TOP,
      children:[new Paragraph({spacing:{before:0,after:0},children:[new TextRun({text:String(t||''),font:'Arial',size:18,bold:true,color:WHITE})]})]
    });

    const sections = [];

    // Feature context
    sections.push(h2('Feature: ' + feat.name));
    if (feat.cap) sections.push(body('Capability: ' + feat.cap));
    if (feat.metric) sections.push(body('Metric: ' + feat.metric));
    if (feat.why) sections.push(body('Rationale: ' + feat.why));
    sections.push(gap(20));

    // Design brief
    if (v.designBrief) {
      sections.push(h2('Design Brief'));
      if (v.designBrief.screenPurpose) { sections.push(h3('Screen Purpose')); sections.push(body(v.designBrief.screenPurpose)); }
      if (v.designBrief.keyComponents && v.designBrief.keyComponents.length) {
        sections.push(h3('Key Components'));
        sections.push(body(v.designBrief.keyComponents.join(', ')));
      }
      if (v.designBrief.interactionNotes) { pushBullets(sections, 'Interaction Notes', v.designBrief.interactionNotes); }
      if (v.designBrief.edgeCases) { pushBullets(sections, 'Edge Cases to Design For', v.designBrief.edgeCases); }
      sections.push(gap(20));
    }

    // Story coverage table — A4-safe 9000 DXA: Story 2000, Covered 1000, Notes 6000
    if (v.coverageData && v.coverageData.length) {
      sections.push(h2('Story Coverage'));
      const rows = [new TableRow({children:[hcell('Story',2000),hcell('Covered',1000),hcell('Notes',6000)]})];
      v.coverageData.forEach(function(r){
        rows.push(new TableRow({children:[
          storyCell(r.storyId, r.storyTitle),
          cell(r.covered?'Yes':'No',1000,r.covered?'E1F5EE':'FCEBEB',true,r.covered?'007873':'A32D2D'),
          cell(r.note||'',6000)
        ]}));
      });
      sections.push(new Table({width:{size:9000,type:WidthType.DXA},columnWidths:[2000,1000,6000],rows}));
      sections.push(gap(20));
    }

    // External prompt
    if (v.externalPrompt) {
      sections.push(h2('Prompt for External Tools'));
      sections.push(body('Copy the prompt below into Figma AI, v0, Lovable, or Bolt to generate a high-fidelity version of this screen.'));
      sections.push(gap(10));
      pushMultilineBody(sections, v.externalPrompt);
      sections.push(gap(20));
    }

    // Wireframe — try html2canvas capture, fall back to text note
    sections.push(h2('Wireframe'));
    if (v.wireframeHTML) {
      let wireframeImageAdded = false;
      if (h2cLoaded) {
        try {
          const pngDataUrl = await _pcCaptureWireframeAsPng(v.wireframeHTML);
          if (pngDataUrl) {
            const imgPara = new Paragraph({
              spacing:{before:10,after:10},
              children: [new ImageRun({
                data: pngDataUrl,
                transformation: { width: 600, height: 450 }
              })]
            });
            sections.push(imgPara);
            sections.push(gap(10));
            wireframeImageAdded = true;
          }
        } catch(ie) {
          console.warn('[PC] ImageRun failed:', ie.message);
        }
      }
      if (!wireframeImageAdded) {
        sections.push(body('Wireframe is available in-app. Use the external prompt above to recreate it in a design tool.'));
      }
    } else {
      sections.push(body('Wireframe was not generated or was cleared on session restore. Use the external prompt above to recreate it.'));
    }

    const doc = new Document({
      styles:{default:{document:{run:{font:'Arial',size:20}}}},
      numbering:{config:[{reference:'pc-bullets',levels:[{level:0,format:'bullet',text:'\u2022',alignment:AlignmentType.LEFT,style:{paragraph:{indent:{left:720,hanging:360}}}}]}]},
      sections:[{ properties:{}, children: sections }]
    });

    const blob = await Packer.toBlob(doc);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'Prototype_' + (feat.name||'Feature').replace(/[^a-zA-Z0-9]/g,'_') + '.docx';
    document.body.appendChild(a);
    a.click();
    setTimeout(function(){ URL.revokeObjectURL(url); a.remove(); }, 1000);

  } catch (err) {
    console.error('[PC] Export failed:', err);
    if (typeof showToast === 'function') showToast('Export failed: ' + (err.message||'unknown error'), 'warn');
  } finally {
    _pcExportInFlight = false;
    pcSyncExportButton(featId);
  }
}

// ── Boot flag — must be last line ──
var pcReady = true;
