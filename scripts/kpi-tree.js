// Stage colour palette — 8 colours, assigned by index position
// Used by renderMM() and referenced by feature-canvas.js and export-docx.js
const STAGE_PALETTE=['#0F5FDC','#5F1EBE','#007873','#C8870A','#A32D2D','#0e7490','#6D3B9E','#2E6B5E'];

function getStagePaletteHex(idx){
  // Returns hex without # for use in DOCX exports
  return STAGE_PALETTE[idx%STAGE_PALETTE.length].replace('#','');
}

async function generate(extra){
  const key=getKey();
  // Read product context from sessionContext (set at Launch Session)
  const _sc=typeof sessionContext!=='undefined'?sessionContext:null;
  const _p=_sc&&_sc.productProfile?_sc.productProfile:{};
  const name=_p.productName||'';
  const desc=_p.productDesc||'';
  if(!name||!desc){showToast('Product name and description are required. Check your product profile in Settings.','warn');return;}

  // v8.133 fix (item 3): courtesy pre-check, before any confirm dialog —
  // confirmed live that a lock conflict used to only surface AFTER the
  // confirm(s) were already shown and dismissed, by which point (item 4)
  // local data had already been wiped. This is advisory only; the real,
  // authoritative lock check below is unchanged.
  if(typeof _lsPeekIfLocked==='function' && typeof _activeSessionId!=='undefined' && _activeSessionId){
    const _peek=await _lsPeekIfLocked(_activeSessionId);
    if(_peek.locked){
      showToast(_peek.holderName+' is already generating on this session. Try again in a moment.','warn');
      return;
    }
  }

  // Only warn about data reset on fresh generate — not on Refine (extra is truthy)
  const hasDownstream=gData&&(diagnosticSessions.length>0||(productLeakAnalysis&&productLeakAnalysis.length>0)||scCanvas.length>0||ddGenerated);
  if(hasDownstream&&!extra){
    showConfirm(
      'This will clear all existing diagnostic data, experiments, and Story Canvas features. This cannot be undone.',
      'Regenerate Discovery Map?',
      ()=>generateConfirmed(extra),
      'Yes, regenerate',
      'danger'
    );
    return;
  }
  generateConfirmed(extra);
}

// Phase 5 (v8.117): stamps a tiny, invisible marker CHILD inside the
// shared #ls loader element with this attempt's ID. Must be a child, not
// an attribute on #ls itself — getIfCurrentAttempt() uses
// container.querySelector(), which per DOM spec only searches
// DESCENDANTS, never the calling element itself. An earlier version of
// this helper set the attribute directly on #ls, which would have made
// every check silently return null (always "stale") — caught only by
// tracing querySelector's actual matching semantics before relying on it,
// not by any syntax check. #ls is a static element already in index.html;
// showLoad() only updates its #load-steps/#load-headline children, never
// replaces #ls wholesale, so this marker child persists safely alongside
// showLoad()'s own updates without interfering with them.
function _kpiStampLoaderMarker(attempt){
  const ls=document.getElementById('ls');
  if(!ls) return;
  let marker=ls.querySelector('[data-gen-attempt]');
  if(marker) marker.remove();
  const span=document.createElement('span');
  span.setAttribute('data-gen-attempt',attempt.id);
  span.style.display='none';
  ls.appendChild(span);
}

async function generateConfirmed(extra){
  if(aiGenInFlight.active){showToast("Still working on your last request. Hang tight, this won't take long.",'info');return;}
  const key=getKey();
  // Build fd from sessionContext — set at Launch Session click
  const _sc=typeof sessionContext!=='undefined'?sessionContext:null;
  const _p=_sc&&_sc.productProfile?_sc.productProfile:{};
  const _cp=_sc&&_sc.companyProfile?_sc.companyProfile:{};
  const name=_p.productName||'';
  const desc=_p.productDesc||'';
  if(!name||!desc){showToast('Product name and description are required. Check your product profile in Settings.','warn');return;}

  // v8.133 fix (item 4): the full destructive reset that used to sit here —
  // wiping capStore/scCanvas/miData/diagnosticSessions and hiding the FC/
  // SC/PI tabs — has been MOVED to run only after the lock is confirmed
  // acquired, below. Confirmed live: a lock conflict used to leave this
  // reset having already run, wiping a viewer's local session state and
  // hiding tabs before the "someone else is generating" toast ever
  // appeared — the exact same shape of bug already found and fixed once in
  // piGenerate() (v8.118), never carried over here until now. Only the
  // button disable (immediate UX feedback, non-destructive) stays here.

  const btn=document.getElementById('gen-btn');
  if(btn)btn.disabled=true;
  if(settingsOpen)toggleSettings();

  // Phase 5 (v8.117): attempt marker, added for consistency with the other
  // 9 wrapped functions even though the actual risk here is narrower than
  // most of them — #ls/#er are singleton, app-wide overlay elements (not
  // per-view containers swapped out by navigation), and aiGenInFlight's
  // existing top-of-function guard already prevents a genuinely
  // overlapping second generateConfirmed() call. The one real scenario
  // this still protects against: a stale, slow-to-fail call's hideLoad()/
  // error-write reaching a #ls that a NEWER generateConfirmed() call has
  // since re-claimed for its own generation.
  const _attempt=newGenAttempt();

  // Phase 5: withGenerationLock wraps the ENTIRE remaining workflow — the
  // optional MI-suggest sub-step, the main KPI-tree generation, parsing,
  // applying to gData/productContext/capStore, and the final
  // sessionStoreSave() — as ONE lock acquisition for what is, from the
  // user's perspective, one action ("Generate Discovery Map"), even though
  // it may internally make two separate callAPI() calls. Splitting this
  // into two separate lock acquisitions (one per callAPI call) would
  // release the lock between the MI sub-step and the main generation,
  // reopening exactly the collision window this lock exists to close.
  try{
    await withGenerationLock(async (_lock) => {

  // v8.133 fix (item 4): the destructive reset — now confirmed to only run
  // once the lock is genuinely held, matching piGenerate()'s own fixed
  // pattern exactly. If the lock check above had failed instead, execution
  // would never reach this line at all, and the user's existing downstream
  // data/tabs would never have been touched.
  diagnosticSessions=[];
  activeDiagnosticId=null;
  productLeakAnalysis=[];
  diagEvidenceDrawerMetricId=null;
  leakDetailExperiment=null;
  leakSelectedIds=new Set();
  if(typeof laSentIds!=='undefined')laSentIds=new Map();
  leakFilters={priority:'',linkedMetric:'',experimentType:'',selectedOnly:false};
  scCanvas=[];
  scSelectedIds=new Set();
  scPanelFeatureId=null;
  scCapNavFilter=null;
  capStore={};capStoreInvalidated=true;capActiveMetricKey=null;capActiveCapIdx=null;capActiveSubCapIdx=null;
  ddGenerated=false;
  productContext=null;
  miData=null;miGenerated=false;miProductMode='market';miCapabilities=[];
  // v8.140 fix: confirmed via live debug output that piPlan was never
  // cleared here at all — the tab correctly hid (tabPi.classList.remove
  // ('revealed') below), but the underlying data silently survived and
  // got saved as-is, meaning a receiving viewer's cross-user apply was
  // faithfully copying a piPlan that should never have still existed.
  // piInputs/piScVersion/piStoryPool reset to their declared defaults
  // (state.js) since they hold generation-attempt-specific derived data
  // (parsedCaps/parsedFeatures, a staleness hash tied to scCanvas) that
  // goes stale the moment capStore/scCanvas are wiped. v9.20: release
  // plans (and their per-plan squads) are cleared the same way piPlan
  // used to be - the shared backlog tray is plan-agnostic data tied to
  // Story Canvas, not to this generation attempt, so it's left alone.
  piPlans=[];
  _piActivePlanId=null;
  piInputs={type:'caps-only',piGoal:'',constraints:'',parsedCaps:[],parsedFeatures:[],carryForwardItems:[],overlapResolutions:{}};
  piScVersion=null;
  piDdPanelOpen=false;
  piDdPanelMetricKey=null;
  piStoryPool={};
  // v9.27 fix: piReadinessPlans (Adoption Readiness) was missing from this
  // reset — same gap already fixed once in home.js's New Session reset (see
  // its own comment there) but never carried over to this regenerate path,
  // so the tab stayed revealed with fully intact stale data after regen.
  piReadinessPlans=[];
  const dvTabEl=document.getElementById('tab-dv');
  const laTabEl=document.getElementById('tab-la');
  const miTabEl=document.getElementById('tab-mi');
  if(dvTabEl)dvTabEl.style.display='none';
  if(laTabEl)laTabEl.style.display='none';
  if(miTabEl)miTabEl.style.display='none';
  // Hide downstream tabs on full regen — data cleared, re-revealed as PM progresses (v8.37)
  const fcTabEl=document.getElementById('tab-fc');
  const scTabEl=document.getElementById('tab-sc');
  const piTabEl=document.getElementById('tab-pi');
  if(fcTabEl)fcTabEl.style.display='none';
  if(scTabEl)scTabEl.classList.remove('revealed');
  if(piTabEl)piTabEl.classList.remove('revealed');
  // v9.27 fix: tab-cc (Capability Canvas) and tab-arp (Adoption Readiness)
  // were missing from this hide list — capStore was correctly wiped above,
  // but the tab itself stayed reachable and showing an empty/reset canvas;
  // tab-arp had both the data AND the tab left stale (see piReadinessPlans
  // reset above). tab-cc is revealed via style.display (session-store.js),
  // tab-arp via classList (readiness-canvas.js's rcRevealTab) — un-reveal
  // each the same way its own reveal function does.
  const ccTabEl=document.getElementById('tab-cc');
  const arpTabEl=document.getElementById('tab-arp');
  if(ccTabEl)ccTabEl.style.display='none';
  if(arpTabEl)arpTabEl.classList.remove('revealed');
  // v9.27 fix: tab-ra (Requirement Agent) was also missing — raConversations
  // stamp intakeBriefId onto Capability Canvas capabilities (see
  // ra_FinalizeSequence in requirement-agent.js), so once capStore is wiped
  // above, any existing brief's capability linkage is already orphaned;
  // reuse raResetState() rather than duplicating its cleanup here. tab-op
  // (Outcome Pulse) is deliberately NOT touched — opUnlocked is a
  // documented one-way, whole-session flag (state.js) that only resets on
  // an actual new session, not a same-session regenerate.
  // Product decision, post-v9.27 review: raResetState() is now the
  // DESTRUCTIVE reset, reachable only from THIS flow (Regenerate Discovery
  // Map is a genuine, permanent reset) — home.js's New Session flow calls
  // the non-destructive raClearInMemoryState() instead, since leaving a
  // session via New Session is a pause, not a delete, and must not remove
  // that session's documents. The two flows no longer call the same
  // function; only this one does the destructive cleanup.
  // v9.27 code-review follow-up: also wipe #ra-tab's innerHTML the same way
  // home.js's homeClearSession() does immediately before its own RA reset
  // call — this reset path should honor that same ordering even though
  // today's UI gating makes it unreachable while Requirement Agent is the
  // active tab.
  const raTabContentEl=document.getElementById('ra-tab');
  if(raTabContentEl){raTabContentEl.innerHTML='';raTabContentEl.classList.remove('on');}
  // v14 (RA-Persistent-Doc-RAG-Spec-v14) — generateConfirmed() is already
  // async, so awaiting here needs no further propagation: raResetState()
  // now cleans up this session's RA documents before wiping raConversations,
  // and everything in this function after this line already runs after it
  // resolves by virtue of the await, exactly as before this change. Passed
  // explicitly (this function never nulls _activeSessionId before this
  // point, unlike home.js's homeClearSession()) rather than relying on
  // raResetState()'s global fallback, matching the "capture session
  // identity" convention consistently at every call site.
  if(typeof raResetState==='function')await raResetState(typeof _activeSessionId!=='undefined'?_activeSessionId:null);
  const raTabEl=document.getElementById('tab-ra');
  if(raTabEl)raTabEl.classList.remove('revealed');
  const analyzeBar=document.getElementById('dv-analyze-bar');
  if(analyzeBar)analyzeBar.remove();
  const dvLeft=document.getElementById('dv-left');
  const dvTree=document.getElementById('dv-tree-area');
  const laTab=document.getElementById('la-tab');
  if(dvLeft)dvLeft.innerHTML='';
  if(dvTree)dvTree.innerHTML='';
  if(laTab)laTab.innerHTML='';
  fcRenderCanvas();
  if(typeof newScRender==='function')newScRender();
  if(typeof newScUpdateTabBadge==='function')newScUpdateTabBadge();
  // v9.27 fix: 'cc', 'pi', 'arp', and 'ra' were missing here too — a PM
  // sitting on Capability Canvas, Release Canvas, Adoption Readiness, or
  // Requirement Agent when they regenerated stayed on a tab that had just
  // been hidden out from under them, same class of bug as the tab-hide gap
  // above. 'op' is deliberately excluded — Outcome Pulse is never hidden by
  // this reset (see tab-op note above), so there's nothing to bounce out of.
  if(curTab==='dv'||curTab==='la'||curTab==='fc'||curTab==='sc'||curTab==='cc'||curTab==='pi'||curTab==='arp'||curTab==='ra')switchTab('mm');

  // Industry fallback: product profile -> company profile -> empty (ST-14)
  const industry=_p.industry||_cp.companyIndustry||'';

  // Build context object from sessionContext
  const fd={
    name,
    url:_p.refLink||_cp.companyUrl||'',
    description:desc,
    industry,
    productType:_p.productType||'B2C Product',
    kpis:_p.kpis||'',
    problem:_p.problem||'',
    icp:_p.icp||'',
    // Session additional context takes highest priority; falls back to profile context
    additionalContext:(_sc&&_sc.additionalContext)||_p.additionalContext||'',
    customValueChain:(_sc&&_sc.customValueChain)||'',
    approach:(_sc&&_sc.approach)||'outcome-based',
    companyStrategy:_cp.companyStrategy||'',
    companyContext:_cp.companyContext||'',
    docContext:''
  };
  // Shared across this call's dm-tier and (if Market Intelligence runs)
  // mi-tier buildDocContext calls below, so a doc pool that's truncated in
  // both tiers still only shows the disclosure once for this generation.
  var _docToastShown={shown:false};
  var _dmDocRes=(typeof buildDocContext==='function')?buildDocContext('dm'):{text:'',truncated:false};
  fd.docContext=_dmDocRes.text;
  _fireDocTruncatedToast(_dmDocRes.truncated,_docToastShown);

  // Check if MI is enabled for this session
  const runMIFirst=!!((_sc&&_sc.marketIntelligence)&&featMI);

  if(runMIFirst){
    // Show alert modal — await user choice
    const choice = await new Promise(resolve=>{
      const alertDiv=document.createElement('div');
      alertDiv.className='mi-alert-overlay';
      alertDiv.id='mi-kpi-alert';
      alertDiv.innerHTML=`<div class="mi-alert-modal">
        <div class="mi-alert-icon"><i class="ti ti-alert-triangle"></i></div>
        <div class="mi-alert-title">Market Intelligence is enabled.</div>
        <div class="mi-alert-body">This will take 3–5 minutes — we'll research the market, analyse competitors, and use those findings to build your Discovery Map. Worth the wait.</div>
        <div class="mi-alert-note">Research is AI-generated from training data. Verify statistics independently before client use.</div>
        <div class="mi-alert-btns">
          <button class="mi-alert-secondary" id="mi-alert-skip">Generate without Market Intelligence</button>
          <button class="mi-alert-primary" id="mi-alert-continue">Continue</button>
        </div>
      </div>`;
      document.body.appendChild(alertDiv);
      document.getElementById('mi-alert-continue').onclick=()=>{alertDiv.remove();resolve('with-mi');};
      document.getElementById('mi-alert-skip').onclick=()=>{alertDiv.remove();resolve('skip-mi');};
    });

    if(choice==='with-mi'){
      // Stage 1: Market Research
      showLoad(LOADER_STAGES_MI);
      _kpiStampLoaderMarker(_attempt);
      const _miSignal=startAiGen(`Your Market Intelligence research for ${fd.name||'this product'} is being put together. Leaving now discards it, you'll need to regenerate from scratch.`);
      try{
        const sys=(typeof SYS_MI!=='undefined'?SYS_MI:'');
        const _miCtx=Object.assign({},fd);
        var _miDocRes1=(typeof buildDocContext==='function')?buildDocContext('mi',fd.name):{text:'',truncated:false};
        _miCtx.docContext=_miDocRes1.text;
        _fireDocTruncatedToast(_miDocRes1.truncated,_docToastShown);
        const usr=buildMarketIntelPrompt(_miCtx, null);
        const miTxt=await callAPI(sys, usr, 8000, _miSignal, 'claude-haiku-4-5', 'mi-suggest');
        const miClean=miTxt.replace(/```json|```/g,'').trim();
        let miParsed;
        try{miParsed=JSON.parse(miClean);}
        catch(e){
          const s=miClean.indexOf('{');const l=miClean.lastIndexOf('}');
          if(s>=0&&l>s)try{miParsed=JSON.parse(miClean.substring(s,l+1));}catch(e2){}
        }
        if(miParsed&&miParsed.capabilities){
          miData=miParsed;miGenerated=true;
          miProductMode=miParsed.productMode||'market';
          miCapabilities=miParsed.capabilities||[];
          const miTabEl=document.getElementById('tab-mi');
          if(miTabEl)miTabEl.style.display='';
        }
      }catch(miErr){
        if(miErr.name==='AbortError'){
          endAiGen();
          // Phase 5: rethrow rather than return — a silent return here
          // made withGenerationLock() (added below, wrapping this whole
          // function) treat an aborted MI sub-step as a normal successful
          // completion of the ENTIRE generateConfirmed() workflow, since
          // this catch is nested inside the function-level try/catch that
          // will itself become the lock's fn(). See pi-planning.js for the
          // full rationale on this pattern.
          throw miErr;
        }
        showToast('Market Intelligence could not be generated. Continuing with Discovery Map. You can run it manually from the MI tab.','warn');
      }
      // Advance to Stage 2: KPI Tree Analysis
      if(window._loaderAdvanceStage) window._loaderAdvanceStage();
    } else {
      // Skip MI — normal KPI loader (mode-aware: capability vs. metric copy)
      showLoad(fd.approach==='capability-based'?LOADER_STAGES_KPI_CAP:LOADER_STAGES_KPI);
      _kpiStampLoaderMarker(_attempt);
    }
  } else {
    showLoad(fd.approach==='capability-based'?LOADER_STAGES_KPI_CAP:LOADER_STAGES_KPI);
    _kpiStampLoaderMarker(_attempt);
  }

  const _isManual=fd.approach==='capability-based'&&_sc&&_sc.generationMode==='manual'&&Array.isArray(_sc.manualList)&&_sc.manualList.length>0;

  const _whatCooking=fd.approach==='capability-based'
    ?`Your capability hierarchy for ${fd.name||'this product'} is being mapped out. Leaving now discards it, you'll need to regenerate from scratch.`
    :`Your Discovery Map (KPI tree) for ${fd.name||'this product'} is being mapped out. Leaving now discards it, you'll need to regenerate from scratch.`;
  const _signal=startAiGen(_whatCooking);
  try{
    const txt=await callAPI(
      'You are a senior enterprise product consultant. Respond ONLY with valid JSON. No markdown, no backticks, no preamble. Never use em dashes (—) in your output; use a hyphen (-) or rewrite the phrase.',
      _isManual
        ?buildTreePromptManual(fd,_sc.manualList,!!_sc.allowAISuggestions)
        :buildTreePrompt(fd,extra),
      20000,
      _signal,
      null,
      'dm-generate'
    );
    // Advance to final stage while we parse and render
    if(window._loaderAdvanceStage) window._loaderAdvanceStage();
    const parsed=parseJSON(txt);
    if(!parsed)throw new Error('Response could not be parsed. Please try again.');
    if(_isManual)_mmReconcileManualCaps(parsed,_sc.manualList,!!_sc.allowAISuggestions);
    // Outcome Verification Loop (A3): snapshot the CURRENT (about to be
    // overwritten) NSM tracking fields before gData is reassigned below —
    // see the full explanation at the reassignment site just after this.
    const _prevNsmTracking=(typeof gData!=='undefined'&&gData&&gData.nsm)
      ?{baseline:gData.nsm.baseline,target:gData.nsm.target,actual:gData.nsm.actual,updatedAt:gData.nsm.updatedAt}
      :null;
    gData=parsed;
    // Outcome Verification Loop (A3): gData=parsed above is a full
    // reassignment on EVERY generation/refinement — the AI's response only
    // ever contains nsm.metric/definition, so a fresh assignment would
    // silently wipe out any previously-entered baseline/target/actual/
    // updatedAt every single time the tree is regenerated or refined.
    // Preserve them across this reassignment, same pattern already used
    // just below for kpiDepth/marketIntelligenceEnabled. _prevNsmTracking
    // must be captured BEFORE gData=parsed runs (it reads the PRIOR
    // gData, which the line above just overwrote) — captured here, right
    // after the reassignment, from a local snapshot taken before it. If
    // this is the product's first-ever generation, _prevNsmTracking is
    // simply absent and the new fields default to null, which is correct.
    if(gData.nsm){
      gData.nsm.baseline=(_prevNsmTracking&&_prevNsmTracking.baseline!==undefined)?_prevNsmTracking.baseline:null;
      gData.nsm.target=(_prevNsmTracking&&_prevNsmTracking.target!==undefined)?_prevNsmTracking.target:null;
      gData.nsm.actual=(_prevNsmTracking&&_prevNsmTracking.actual!==undefined)?_prevNsmTracking.actual:null;
      gData.nsm.updatedAt=(_prevNsmTracking&&_prevNsmTracking.updatedAt!==undefined)?_prevNsmTracking.updatedAt:null;
    }
    gData.approach=fd.approach;
    // Store the depth used for this generation — refinements must use the same depth
    // to avoid schema mismatch between the prompt schema and the existing tree structure
    gData.kpiDepth=(typeof appSettings!=='undefined'?appSettings.kpiDepth:1)||1;
    // Phase 5 fix (v8.118): persist this session's launch-time MI choice
    // (_sc.marketIntelligence — read fresh above, per this specific call,
    // never carried over from a prior run) so tab-reveal logic on RESUME
    // can distinguish "chose MI but skipped running it" from "chose no MI
    // at all" — previously this choice existed only as an ephemeral local
    // variable, never persisted anywhere, so resuming a session lost all
    // record of it and could only fall back to miGenerated (has MI
    // actually been run), which is the wrong question to ask. gData=parsed
    // above is a FULL reassignment to the AI's fresh JSON response every
    // single call (confirmed by reading this exact line) — not a mutation
    // of whatever gData held before — so this line is guaranteed to run
    // with THIS run's own fresh choice on every generation, never a stale
    // value surviving from an earlier run.
    gData.marketIntelligenceEnabled=(_sc&&_sc.marketIntelligence===true);

    // Reset banner state — always expanded on new generation
    mmBannerCollapsed=false;

    // Populate productContext — single source of truth for all downstream calls
    productContext={
      name:fd.name,
      url:fd.url,
      description:fd.description,
      industry:fd.industry,
      productType:fd.productType,
      kpis:fd.kpis,
      problem:fd.problem,
      icp:fd.icp,
      additionalContext:fd.additionalContext,
      measurementModelName:(parsed.measurementModel&&parsed.measurementModel.modelName)||'',
      frameworks:(parsed.measurementModel&&parsed.measurementModel.frameworks)||[],
      nsmMetric:(parsed.nsm&&parsed.nsm.metric)||''
    };

    // Phase 5 (v8.117): marker-guarded for consistency with the other 9
    // functions, even though aiGenInFlight's own guard already makes a
    // genuinely overlapping second call unlikely here.
    if(getIfCurrentAttempt('ls',_attempt)){hideLoad();}
    renderMM(parsed);
    capStore={};capStoreInvalidated=true;capActiveMetricKey=null;capActiveCapIdx=null;capActiveSubCapIdx=null;
    if(curTab==='cc')ccRenderEmpty();
    // v8.39: show session name in header, not just product name
    if(typeof hdrSetSessionName==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
      var _ssRaw=localStorage.getItem('pgt_session_'+_activeSessionId);
      var _ssMeta=_ssRaw?JSON.parse(_ssRaw):null;
      var _sesName=(_ssMeta&&_ssMeta.meta&&_ssMeta.meta.name)||fd.name||'';
      hdrSetSessionName(_sesName);
    }
    document.getElementById('mm-out').classList.add('on');
    document.getElementById('dd-out').classList.remove('on');
    curTab='mm';
    document.getElementById('tab-mm').classList.add('active');
    const tabDdEl=document.getElementById('tab-dd');if(tabDdEl)tabDdEl.classList.remove('active');
    if(typeof renderDDEmpty==='function'&&document.getElementById('dd-out'))renderDDEmpty();
    if(btn)btn.disabled=false;
    renderDiagnosticActionBar();
    // Reveal Capability Canvas tab now that Discovery Map results exist —
    // RA-off only. When Requirement Agent is on, CC is no longer the direct
    // next step from Discovery Map (the DM CTA routes to RA instead, see
    // above) — CC stays hidden until RA's own Finalize reveals it
    // (raRunFinalizeSequence(), requirement-agent.js). Revealing it here
    // unconditionally regardless of raEnabled was a confirmed regression:
    // it let CC become visible immediately after DM finished generating,
    // before the PM had even opened Requirement Agent.
    if(!(typeof raEnabled!=='undefined'&&raEnabled)){
      const ccTabEl=document.getElementById('tab-cc');
      if(ccTabEl) ccTabEl.style.display='';
      // Signal new/updated content in Capability Canvas (cleared on first visit)
      if(typeof markTabPending==='function')markTabPending('cc');
    }
    // Reveal MI tab if THIS SESSION chose MI at launch — Phase 5 fix
    // (v8.118): previously checked ONLY the global featMI setting, which
    // meant a session that itself chose "no MI" could still have the tab
    // incorrectly revealed here if the global setting happened to be on
    // for some other reason. Uses the same _ssShouldShowMiTab() helper the
    // resume path uses (session-store.js), so both reveal paths can't
    // silently drift apart on this logic again — but reads directly off
    // gData here since gData IS the object being constructed right now in
    // this same function call, not yet wrapped in the {gData:...} shape
    // _ssShouldShowMiTab() expects from a restored session snapshot.
    if((typeof gData!=='undefined'&&gData&&gData.marketIntelligenceEnabled===true)||miGenerated===true){
      const miTabEl=document.getElementById('tab-mi');
      if(miTabEl) miTabEl.style.display='';
      // If MI was pre-generated (session launched with MI enabled), render the screen now
      // so the tab shows results immediately on first visit — productContext is set by this point
      if(miGenerated&&typeof miRenderScreen==='function'){
        miRenderScreen();
        if(typeof miRenderLeftPanel==='function') miRenderLeftPanel();
      }
    }
    // Auto-save session after successful DM generation
    // Phase 5: checkpoint immediately before the save — see pi-planning.js
    // for the full rationale (second adversarial review round).
    _lock.throwIfLost();
    if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
      // Build A (v8.132, live sync): awaited inline, same sequencing already
      // proven necessary for CC — withGenerationLock releases as soon as
      // this callback's promise resolves, so the emit must happen before
      // that, not via .then().
      const _ok=await sessionStoreSave(_activeSessionId);
      if(_ok&&typeof _activeSessionIsShared!=='undefined'&&_activeSessionIsShared&&typeof _lsEmitContentEvent==='function'){
        await _lsEmitContentEvent(_activeSessionId,'mm','kpi_tree_generated',null,null);
      }
    }
    endAiGen();
  }catch(err){
    if(err.name==='AbortError'){
      endAiGen();
      // Phase 5: rethrow rather than return — see pi-planning.js for the
      // full rationale (adversarial review Finding 1).
      throw err;
    }
    if(err.message==='generation_lock_lost'){
      // Toast already shown by withGenerationLock() — avoid a duplicate.
      // Phase 5 (v8.117): marker-guarded — only hide the loader if this
      // attempt still owns it (a newer generateConfirmed() call hasn't
      // since re-stamped #ls for its own generation).
      if(getIfCurrentAttempt('ls',_attempt)){hideLoad();}
      if(btn)btn.disabled=false;
      endAiGen();
      throw err;
    }
    if(getIfCurrentAttempt('ls',_attempt)){hideLoad();}
    if(btn)btn.disabled=false;
    document.getElementById('er').classList.add('on');
    document.getElementById('er-msg').textContent='Error: '+err.message;
    endAiGen();
  }
    });
  }catch(lockErr){
    // Phase 5: reached in three cases — pre-fn lock failure (lock not
    // acquired/unknown/already running locally), or the rethrown
    // AbortError/lock-lost from the inner catch above. The inner catch
    // already did its own resets in every case that reaches here; this is
    // a final, idempotent safety net so the gen button never gets stuck
    // disabled if withGenerationLock() itself throws before the inner
    // try/catch ever runs.
    if(btn)btn.disabled=false;
  }
}
async function regen(){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  // v9.25 — stop-on-send: clicking this surface's own action button means
  // there's no "next message" for continued dictation to feed. abort(),
  // not stop() — traced regen()'s own flow: the
  // refinement text below is read synchronously in this same tick, before
  // either method's async tail could resolve, so they'd capture identical
  // text either way; abort() is still correct to guarantee no delayed,
  // surprise result can land later if the refine bar is reopened for an
  // unrelated second refinement.
  voiceStopActive('abort');
  const refinementText=gv('regen-in');
  // v8.133 fix (item 3): checked here too, not just inside generate() —
  // this function can route to _mmShowRegenConfirm's richer modal, which
  // bypasses generate() entirely until its own Regenerate button is
  // clicked deep inside that modal.
  if(typeof _lsPeekIfLocked==='function' && typeof _activeSessionId!=='undefined' && _activeSessionId){
    const _peek=await _lsPeekIfLocked(_activeSessionId);
    if(_peek.locked){
      showToast(_peek.holderName+' is already generating on this session. Try again in a moment.','warn');
      return;
    }
  }
  // Check if downstream data exists — warn before wiping
  const hasDownstream=(capStore&&Object.keys(capStore).length>0)||
    (scCanvas&&scCanvas.length>0)||
    (typeof piPlans!=='undefined'&&Array.isArray(piPlans)&&piPlans.length>0);
  if(hasDownstream){
    _mmShowRegenConfirm(refinementText);
  } else {
    generate(refinementText);
  }
}

// ── Regen confirm modal ──
function _mmShowRegenConfirm(refinementText){
  const existing=document.getElementById('mm-regen-confirm');
  if(existing)existing.remove();
  const modal=document.createElement('div');
  modal.id='mm-regen-confirm';
  modal.className='modal-overlay';
  modal.innerHTML=`
    <div class="modal" style="max-width:440px;position:relative;">
      <button onclick="document.getElementById('mm-regen-confirm').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:3px;color:var(--t3);display:flex;align-items:center;border-radius:4px;z-index:1;" title="Close" aria-label="Close"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      <div style="padding:16px 44px 14px 16px;border-bottom:0.5px solid var(--divider);">
        <div style="font-size:13px;font-weight:500;color:var(--t1);">Regenerate Discovery Map?</div>
      </div>
      <div class="modal-body">
        This will permanently clear your <strong>Capability Canvas, Feature Canvas, Story Canvas and Release Canvas</strong> data for this session. This cannot be undone.
        <div style="margin-top:12px;">
          <button id="mm-regen-export-btn" style="width:100%;background:none;border:1px solid var(--divider);border-radius:6px;padding:7px 12px;font-size:11px;color:var(--t2);cursor:pointer;text-align:left;display:flex;align-items:center;gap:6px;" onclick="_mmRegenExport()">
            <i class="ti ti-download" style="font-size:11px;" aria-hidden="true"></i> Export current work before clearing
          </button>
          <div id="mm-regen-export-status" style="font-size:10px;color:var(--t3);text-align:center;min-height:14px;margin-top:5px;"></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="modal-cancel-btn" onclick="document.getElementById('mm-regen-confirm').remove()">Cancel</button>
        <button id="mm-regen-confirm-btn" class="modal-confirm-btn danger" onclick="_mmRegenProceed(document.getElementById('regen-in').value||'')">Regenerate</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click',function(e){if(e.target===modal)modal.remove();});
}

function _mmRegenExport(){
  const statusEl=document.getElementById('mm-regen-export-status');
  const exportBtn=document.getElementById('mm-regen-export-btn');
  const confirmBtn=document.getElementById('mm-regen-confirm-btn');
  if(exportBtn)exportBtn.disabled=true;
  if(confirmBtn)confirmBtn.disabled=true;
  if(statusEl)statusEl.textContent='Preparing export...';
  // Use best available export
  const exportFn=typeof downloadDocx==='function'?downloadDocx:
    typeof miBuildDocx==='function'?null:null;
  try{
    if(scCanvas&&scCanvas.length>0&&typeof downloadDocx==='function'){
      downloadDocx();
    } else if(typeof ccExportDocx==='function'){
      ccExportDocx();
    }
    if(statusEl)statusEl.textContent='Export started — check your downloads.';
  } catch(e){
    if(statusEl)statusEl.textContent='Export failed. You can still regenerate.';
  }
  setTimeout(function(){
    if(exportBtn)exportBtn.disabled=false;
    if(confirmBtn)confirmBtn.disabled=false;
  },2000);
}

async function _mmRegenProceed(refinementText){
  const modal=document.getElementById('mm-regen-confirm');
  if(modal)modal.remove();
  // v8.135 fix (item 9): a fresh peek here, not just the one already run
  // inside regen() before this modal was shown — that earlier check can be
  // stale by the time the user actually clicks Regenerate on a modal that
  // may have sat open for a while.
  if(typeof _lsPeekIfLocked==='function' && typeof _activeSessionId!=='undefined' && _activeSessionId){
    const _peek=await _lsPeekIfLocked(_activeSessionId);
    if(_peek.locked){
      showToast(_peek.holderName+' is already generating on this session. Try again in a moment.','warn');
      return;
    }
  }
  // Fix 3 (v8.38): set dmRegenAt timestamp BEFORE clearing — used by sessionStoreSyncFromDB
  // to detect stale Supabase snapshots after regen
  if(typeof sessionContext!=='undefined'&&sessionContext){
    sessionContext.dmRegenAt=Date.now();
  }
  // Synchronously update localStorage snapshot with cleared downstream keys + dmRegenAt
  // This protects the fast-path restore even if Supabase write hasn't confirmed yet
  if(typeof _activeSessionId!=='undefined'&&_activeSessionId){
    try{
      var _SS_PREFIX='pgt_session_';
      var localRaw=localStorage.getItem(_SS_PREFIX+_activeSessionId);
      if(localRaw){
        var localEntry=JSON.parse(localRaw);
        if(localEntry&&localEntry.snapshot){
          localEntry.snapshot.capStore={};
          localEntry.snapshot.scCanvas=[];
          localEntry.snapshot.piPlans=[];
          // v9.27 code-review fix: this allowlist wasn't updated when
          // piReadinessPlans/raConversations gained their own in-memory
          // reset above - without these two, a tab close/crash before the
          // async Supabase write confirms would resume from this stale
          // localStorage snapshot and resurrect the exact stale Adoption
          // Readiness/Requirement Agent data the in-memory reset just fixed.
          localEntry.snapshot.piReadinessPlans=[];
          localEntry.snapshot.raConversations=[];
          localEntry.snapshot.dmRegenAt=sessionContext.dmRegenAt;
          localStorage.setItem(_SS_PREFIX+_activeSessionId,JSON.stringify(localEntry));
        }
      }
    } catch(e){ console.warn('dmRegenAt localStorage pre-clear failed:',e); }
  }
  // v8.135 fix (item 9): calls generateConfirmed() directly — the user has
  // already confirmed via THIS modal; calling generate() again would
  // re-run its own separate, differently-scoped confirmation check and
  // could show a second, different confirm dialog on top of this one
  // (confirmed live — the exact bug this fixes).
  generateConfirmed(refinementText);
}

// ── _mmReconcileManualCaps ──
// Called after parsing the AI response to buildTreePromptManual(). Ensures:
// 1. Every user-supplied capability (manualList) appears exactly once across
//    stages, with its original description (if any) as the authoritative "why".
// 2. AI-placed duplicates/renames of a supplied capability are corrected to
//    match the supplied name+description (fuzzy-matched by name).
// 3. Any l1_metrics entry not matching a supplied capability is treated as an
//    AI suggestion: kept (tagged _aiSuggested:true) only if allowAISuggestions
//    is true, otherwise removed.
// 4. Any supplied capability the AI failed to place is appended to the first
//    stage (safety net — should be rare given the prompt's explicit rules).
function _mmReconcileManualCaps(parsed,manualList,allowAISuggestions){
  if(!parsed||!Array.isArray(parsed.stages))return;
  const supplied=manualList.map(c=>({name:(c.name||'').trim(),description:(c.description||'').trim()}));
  const suppliedByLower=new Map(supplied.map(c=>[c.name.toLowerCase(),c]));
  const placed=new Set();

  parsed.stages.forEach(st=>{
    if(!Array.isArray(st.l1_metrics))st.l1_metrics=[];
    st.l1_metrics=st.l1_metrics.filter(l1=>{
      if(!l1||!l1.name)return false;
      const match=suppliedByLower.get(l1.name.trim().toLowerCase());
      if(match){
        if(placed.has(match.name.toLowerCase())){
          // Duplicate placement of the same supplied capability — drop this extra
          return false;
        }
        placed.add(match.name.toLowerCase());
        l1.name=match.name; // exact user-supplied name
        l1.why=match.description||l1.why||'';
        delete l1._aiSuggested;
        return true;
      }
      // Not a supplied capability — an AI addition
      if(allowAISuggestions){
        l1._aiSuggested=true;
        return true;
      }
      return false; // strip unsanctioned AI additions
    });
  });

  // Append any supplied capabilities the AI failed to place
  const missing=supplied.filter(c=>!placed.has(c.name.toLowerCase()));
  if(missing.length>0&&parsed.stages.length>0){
    missing.forEach(c=>{
      parsed.stages[0].l1_metrics.push({name:c.name,why:c.description||''});
    });
  }
}


function renderDiagnosticActionBar(){
  // v9.25 — this function does existing.remove()+full rebuild EVERY time
  // it's called, and it's called from far more places than just "after
  // regenerating" (confirmed via grep: also confirmDeleteStage() and the
  // equivalent add/edit/delete-stage/capability paths) — i.e. ANY stage or
  // capability mutation anywhere on this screen destroys #regen-in, even if
  // the refine bar is open with an active dictation session at the time and
  // has nothing to do with the edit being made. Single guard here covers
  // every one of those call sites at once, mirroring requirement-agent.js's
  // own raRenderCenter() choke-point pattern.
  voiceStopActive('abort');
  const existing=document.getElementById('diag-action-bar');
  if(existing)existing.remove();
  const right=document.querySelector('.right');
  if(!right)return;
  const bar=document.createElement('div');
  bar.id='diag-action-bar';
  bar.className='diag-action-bar';
  const isCap=gData&&gData.approach==='capability-based';
  const stageCount=gData&&gData.stages?gData.stages.length:0;
  const modelName=gData&&gData.measurementModel&&gData.measurementModel.modelName?gData.measurementModel.modelName:'';
  const metricCount=countAllMetrics(gData);
  const diagBtn=(featDiag&&!isCap)?`<button class="diag-bar-secondary" id="diag-run-btn" onclick="dvAnalyze()" disabled><i class="ti ti-microscope" style="font-size:12px;" aria-hidden="true"></i> Run Diagnostics</button><a id="diag-rerun-link" onclick="dvAnalyzeForce()" style="display:none;font-size:10px;color:rgba(255,255,255,0.6);cursor:pointer;margin-left:8px;text-decoration:underline;">Run again anyway</a>`:'';
  const refineLbl='Refine Discovery Map';  // v8.38 — always DM regardless of approach
  const refinePlaceholder=isCap?'e.g. Remove the Forecasting stage, add a Carrier Management stage, rename Real-Time Inventory Visibility to Live Stock Sync, focus more on returns handling, split Fulfillment into two stages...':'e.g. Remove the Forecasting stage, add a Carrier Management stage, rename Promise Accuracy to Delivery Commitment, focus more on exception handling, split Fulfillment into two stages...';
  const barHint=isCap?`Discovery Map ready &middot; ${metricCount} process area${metricCount!==1?'s':''} &middot; ${stageCount} stage${stageCount!==1?'s':''} ${modelName?'&middot; '+e(modelName):''}`:`Discovery Map ready &middot; ${metricCount} metrics &middot; ${stageCount} stage${stageCount!==1?'s':''} ${modelName?'&middot; '+e(modelName):''}`;
  // Requirement Agent redesign (Discovery-First Entry Point) — when RA is
  // on, this CTA is relabeled and rerouted to Requirement Agent instead of
  // Capability Canvas (RA is now entered from Discovery Map, not from CC —
  // see requirement-agent.js's raEnterFromDiscoveryMap()). Same position/
  // visual weight either way. RA-off: completely unchanged.
  const _dmRaOn=typeof raEnabled!=='undefined'&&!!raEnabled;
  const continueCta=_dmRaOn
    ?`<button class="diag-bar-cta" onclick="raEnterFromDiscoveryMap()"><i class="ti ti-arrow-right" style="font-size:12px;" aria-hidden="true"></i> Define Requirements</button>`
    :`<button class="diag-bar-cta" onclick="revealAndSwitchTab('cc')"><i class="ti ti-arrow-right" style="font-size:12px;" aria-hidden="true"></i> Continue to Capability Canvas</button>`;
  bar.innerHTML=`
    <div class="diag-refine-expand" id="diag-refine-expand" style="display:none;">
      <div class="diag-refine-lbl">${refineLbl}</div>
      <div class="diag-refine-row">
        <textarea class="diag-refine-txt" id="regen-in" placeholder="${refinePlaceholder}" rows="2"></textarea>
        <div class="diag-refine-btn-group">
          ${(typeof voiceButtonHtml==='function')?voiceButtonHtml({textareaId:'regen-in',buttonId:'regen-voice-btn',statusId:'regen-voice-status'}):''}
          <button class="diag-refine-send" id="diag-refine-send" onclick="regen()" title="Refine &amp; Regenerate"><i class="ti ti-refresh" style="font-size:13px;" aria-hidden="true"></i></button>
        </div>
      </div>
    </div>
    <div class="diag-bar-row">
      <span class="diag-bar-hint">${barHint}</span>
      <div class="diag-bar-btns">
        ${((typeof canEditSession!=='function')||canEditSession())?`<button class="diag-refine-btn-tertiary" id="diag-refine-btn" onclick="toggleRefineBar()"><i class="ti ti-refresh" style="font-size:11px;" aria-hidden="true"></i> ${refineLbl}</button>`:''}
        ${diagBtn}
        ${continueCta}
      </div>
    </div>`;
  right.appendChild(bar);
}

function toggleRefineBar(){
  const expand=document.getElementById('diag-refine-expand');
  const btn=document.getElementById('diag-refine-btn');
  if(!expand)return;
  const isOpen=expand.style.display!=='none';
  // v9.25 — collapsing the bar doesn't destroy #regen-in (just hides it via
  // display, so dictation could technically keep running unseen), but
  // collapsing reads as "I'm done here" the same way clicking Regenerate
  // does — stop on collapse, not on expand.
  if(isOpen)voiceStopActive('abort');
  expand.style.display=isOpen?'none':'block';
  const refineLbl='Refine Discovery Map';  // v8.38 — always DM regardless of approach
  if(btn)btn.innerHTML=isOpen?'<i class="ti ti-refresh" style="font-size:11px;" aria-hidden="true"></i> '+refineLbl:'<i class="ti ti-chevron-down" style="font-size:11px;" aria-hidden="true"></i> '+refineLbl;
  if(!isOpen){
    const txt=document.getElementById('regen-in');
    if(txt){txt.focus();txt.select();}
  }
}

function countAllMetrics(data){
  if(!data||!data.stages)return 0;
  let n=0;
  data.stages.forEach(st=>{
    (st.l1_metrics||[]).forEach(l1=>{
      n++;
      (l1.l2_metrics||[]).forEach(l2=>{
        n++;
        (l2.l3_metrics||[]).forEach(()=>n++);
      });
    });
  });
  return n;
}

function toggleMmBanner(){
  mmBannerCollapsed=!mmBannerCollapsed;
  const banner=document.getElementById('mm-model-banner');
  if(!banner)return;
  const body=document.getElementById('mm-model-banner-body');
  const toggle=document.getElementById('mm-model-banner-toggle');
  if(body)body.style.display=mmBannerCollapsed?'none':'block';
  if(toggle)toggle.textContent=mmBannerCollapsed?'show \u25BC':'hide \u25B2';
}

function renderMM(data){
  const c=document.getElementById('mm-out');
  // v9.06.01 fix: preserve horizontal scroll position across re-renders.
  // renderMM() fully replaces .stages' innerHTML, which resets scrollLeft
  // to 0 by default — a real problem once Custom Value Stage sits far to
  // the right (e.g. stage 8 of 8). Capture BEFORE rebuild; restore AFTER,
  // using requestAnimationFrame (layout must complete first) and clamped
  // against the new scrollWidth in case a stage was removed, shrinking it.
  const _oldStagesEl=c?c.querySelector('.stages'):null;
  const _savedScrollLeft=_oldStagesEl?_oldStagesEl.scrollLeft:0;
  const stages=data.stages||[];
  const mm=data.measurementModel||null;
  const hasMM=mm&&mm.modelName;
  const frameworks=mm&&mm.frameworks&&mm.frameworks.length?mm.frameworks:[];

  // ── NSM node (rationale removed) ──
  let h=`<div class="nsm-node"><div class="nsm-lbl">North Star Metric</div><div class="nsm-val">${e(data.nsm.metric)}</div><div class="nsm-def">${e(data.nsm.definition)}</div></div>`;

  // ── Measurement model banner ──
  if(hasMM){
    const pillsHtml=frameworks.map(f=>`<span class="mm-fw-pill">${e(f)}</span>`).join('');
    h+=`<div class="mm-model-banner" id="mm-model-banner">`;
    h+=`<div class="mm-banner-hdr">`;
    h+=`<div class="mm-banner-left"><i class="ti ti-book" aria-hidden="true"></i><span class="mm-model-name">${e(mm.modelName)}</span>${pillsHtml?'<span class="mm-fw-pills">'+pillsHtml+'</span>':''}</div>`;
    h+=`<button class="mm-banner-toggle" id="mm-model-banner-toggle" onclick="toggleMmBanner()">${mmBannerCollapsed?'show \u25BC':'hide \u25B2'}</button>`;
    h+=`</div>`;
    h+=`<div class="mm-banner-body" id="mm-model-banner-body" style="${mmBannerCollapsed?'display:none':''}">`;
    if(mm.rationale)h+=`<p class="mm-banner-rationale">${e(mm.rationale)}</p>`;
    h+=`</div>`;
    h+=`</div>`;
  } else {
    // Soft warning — measurementModel missing
    h+=`<div class="mm-model-banner mm-banner-warn"><i class="ti ti-alert-triangle" aria-hidden="true"></i> Framework attribution not available for this generation — click <strong>Refine</strong> to regenerate.</div>`;
  }

  // ── Scroll hint if > 4 stages ──
  if(stages.length>4){
    h+=`<div class="mm-scroll-hint"><i class="ti ti-arrow-right" aria-hidden="true"></i> ${stages.length} stages &mdash; scroll horizontally to see all</div>`;
  }

  // ── Stage columns ──
  h+=`<div class="stages">`;
  stages.forEach((st,idx)=>{
    if(!st||!st.id)return;
    // v9.06.02 fix: previous line unconditionally hardcoded the display
    // text to 'Custom Value Stage' for st.id==='pi', completely ignoring
    // any actual user rename — meaning a renamed stage NEVER visually
    // reflected its new name, even though the underlying data WAS
    // correctly updated. Now uses the centralized, narrow display helper
    // (exact-legacy-literal guard only, never overrides a real rename).
    const stLabel=typeof ccGetStageDisplayLabel==='function'?ccGetStageDisplayLabel(st):(st.label||st.id);
    const stDesc=st.description||'';
    const color=STAGE_PALETTE[idx%STAGE_PALETTE.length];
    const l1list=Array.isArray(st.l1_metrics)&&st.l1_metrics.length>0?st.l1_metrics:null;

    const scopeWarn=st._scopeWarning?`<div class="stage-scope-warn"><i class="ti ti-alert-triangle" aria-hidden="true"></i><span>Scope changed &mdash; review ${data.approach==='capability-based'?'capabilities':'metrics'} and evidence for continued relevance</span><button class="stage-scope-warn-dismiss" onclick="event.stopPropagation();dismissScopeWarn(${idx})" title="Dismiss">&times;</button></div>`:'';
    // v9.08.02: computed once per stage render, matches L1-metric pattern.
    const _canEditDmStage=(typeof canEditSession!=='function')||canEditSession();
    h+=`<div class="sc"><div class="sh" style="background:${color}"><div class="sh-lbl">Stage ${idx+1}</div><div class="sh-title">${e(stLabel)}</div>${stDesc?`<div class="sh-desc" title="${e(stDesc)}">${e(stDesc)}</div>`:''}<div class="sh-actions">${_canEditDmStage?`<button class="sh-action-btn" onclick="event.stopPropagation();editStage(${idx})" title="Edit stage"><i class="ti ti-pencil" style="font-size:11px;" aria-hidden="true"></i></button><button class="sh-action-btn" onclick="event.stopPropagation();deleteStage(${idx})" title="Delete stage"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`:''}</div></div>${scopeWarn}`;

    if(!l1list){
      h+=`<div class="stage-empty"><div class="stage-empty-icon"><i class="ti ti-minus" aria-hidden="true"></i></div><div class="stage-empty-msg">No recommended ${data.approach==='capability-based'?'capabilities':'KPIs'} for this stage</div><div class="stage-empty-sub">Refine your product context to generate ${data.approach==='capability-based'?'capabilities':'metrics'} here.</div></div>`;
    } else if(data.approach==='capability-based'){
      l1list.forEach((l1,li)=>{
        if(!l1||!l1.name)return;
        const lid=`l1-${st.id}-${li}`;
        const aiBadge=l1._aiSuggested?`<span class="l1-ai-badge" title="Added by AI to fill a gap in your capability list"><i class="ti ti-sparkles" style="font-size:9px;" aria-hidden="true"></i> AI suggested</span>`:'';
        // v9.08.06: this is a separate render branch from Outcome Metrics'
        // L1 row below (data.approach==='capability-based' vs the else) —
        // that branch's _canEditDm flag is out of scope here, so Process
        // Area's edit/delete icons were left ungated despite Outcome
        // Metrics' identical icons being fixed back in v9.08.
        const _canEditDmFlat=(typeof canEditSession!=='function')||canEditSession();
        h+=`<div class="l1 l1-flat" id="${lid}"><div class="l1-hdr"><div class="l1-info"><div class="l1-name">${e(l1.name)}${aiBadge}</div><div class="l1-why">${e(l1.why||'')}</div></div><div class="l1-cap-actions">${_canEditDmFlat?`<button class="l1-cap-edit" onclick="event.stopPropagation();editCapability(${idx},${li})" title="Edit capability"><i class="ti ti-pencil" style="font-size:10px;" aria-hidden="true"></i></button><button class="l1-cap-remove" onclick="event.stopPropagation();deleteCapability(${idx},${li})" title="Delete capability"><i class="ti ti-x" style="font-size:10px;" aria-hidden="true"></i></button>`:''}</div></div></div>`;
      });
    } else {
      l1list.forEach((l1,li)=>{
        if(!l1||!l1.name)return;
        const lid=`l1-${st.id}-${li}`;
        const l1MetKey=st.id+'||'+l1.name;
        // v9.07: only show the expand chevron and attach the row's expand-click
        // when there are actually L2/L3 children to reveal — previously shown
        // unconditionally even for childless L1 metrics.
        const _hasChildren=(l1.l2_metrics||[]).length>0;
        const _rowOnclick=_hasChildren?` onclick="tog('${lid}')"`:'';
        const _chevronHtml=_hasChildren?'<div class="exp">+</div>':'';
        // v9.08: computed once per row render — matches the existing
        // readOnly-inline-in-template pattern used in settings-page.js's
        // Company Profile section, rather than inventing a new CSS-class
        // approach for this codebase.
        const _canEditDm = (typeof canEditSession !== 'function') || canEditSession();
        h+=`<div class="l1" id="${lid}"${_rowOnclick}><div class="l1-hdr"><div class="l1-info"><div class="l1-name">${e(l1.name)}</div><div class="l1-why">${e(l1.why||'')}</div></div><div class="l1-cap-actions">${_canEditDm?`<button class="l1-cap-edit" onclick="event.stopPropagation();editCapability(${idx},${li})" title="Edit metric"><i class="ti ti-pencil" style="font-size:10px;" aria-hidden="true"></i></button><button class="l1-cap-remove" onclick="event.stopPropagation();deleteCapability(${idx},${li})" title="Delete metric"><i class="ti ti-x" style="font-size:10px;" aria-hidden="true"></i></button>`:''}</div>${_chevronHtml}</div><div class="l1-trigger-row"><button class="cap-trigger cap-trigger-dd" onclick="event.stopPropagation();ccOpenDDPanel('${e(l1MetKey)}','${e(l1.name)}','${e(stLabel)}')">Dictionary &#8594;</button><button class="cap-trigger cap-trigger-ev" onclick="event.stopPropagation();kpiOpenEvidenceDrawer('${e(l1.name)}','${e(l1.name)}','${e(stLabel)}','L1')">Evidence &#8594;</button></div><div class="l1-kids">`;
        (l1.l2_metrics||[]).forEach((l2,l2i)=>{
          if(!l2||!l2.name)return;
          const l2id=`l2-${st.id}-${li}-${l2i}`;
          h+=`<div class="l2" id="${l2id}" onclick="event.stopPropagation();tog('${l2id}')"><div class="l2-name">${e(l2.name)}</div><div class="l2-why">${e(l2.why||'')}</div><button class="cap-trigger cap-trigger-ev cap-trigger-sm" onclick="event.stopPropagation();kpiOpenEvidenceDrawer('${e(l2.name)}','${e(l2.name)}','${e(stLabel)}','L2')">Evidence &#8594;</button><div class="l2-kids">`;
          (l2.l3_metrics||[]).forEach((l3,l3i)=>{
            if(!l3||!l3.name)return;
            const l3id=`l3-${st.id}-${li}-${l2i}-${l3i}`;
            const hasL4=l3.l4_metrics&&l3.l4_metrics.length>0;
            h+=`<div class="l3${hasL4?' has-l4':''}" id="${l3id}" ${hasL4?`onclick="event.stopPropagation();tog('${l3id}')"`:''}>`;
            h+=`<div class="l3-name">${e(l3.name)}${hasL4?`<span class="l3-cnt">(+${l3.l4_metrics.length})</span>`:''}</div>`;
            if(hasL4)h+=`<div class="l3-kids">${l3.l4_metrics.map(l4=>`<span class="l4-chip">${e(l4)}</span>`).join('')}</div>`;
            h+=`<button class="cap-trigger cap-trigger-ev cap-trigger-xs" onclick="event.stopPropagation();kpiOpenEvidenceDrawer('${e(l3.name)}','${e(l3.name)}','${e(stLabel)}','L3')">Evidence &#8594;</button>`;
            h+=`</div>`;
          });
          h+=`</div></div>`;
        });
        h+=`</div></div>`;
      });
    }
    h+=`</div>`;
  });
  h+=`</div>`;
  c.innerHTML=h;
  if(_savedScrollLeft>0){
    requestAnimationFrame(function(){
      const _newStagesEl=c.querySelector('.stages');
      if(_newStagesEl){
        const _maxScroll=Math.max(0,_newStagesEl.scrollWidth-_newStagesEl.clientWidth);
        _newStagesEl.scrollLeft=Math.min(_savedScrollLeft,_maxScroll);
      }
    });
  }
}

function tog(id){const el=document.getElementById(id);if(el)el.classList.toggle('open');}

// ── Stage scope warning dismiss ──
function dismissScopeWarn(idx){
  if(!gData||!gData.stages[idx])return;
  delete gData.stages[idx]._scopeWarning;
  renderMM(gData);
}

// ── Stage delete cascade helpers ──
function stageGetAffectedFeatures(stageLabel){
  return (scCanvas||[]).filter(f=>f.stage===stageLabel&&f.origin!=='market'&&f.origin!=='pi');
}
function stageGetAffectedStoryCount(features){
  return features.reduce((sum,f)=>sum+(f.stories&&f.stories.length?f.stories.length:0),0);
}
function stageGetAffectedEvidenceCount(stageLabel){
  if(!diagnosticSessions||!diagnosticSessions.length)return 0;
  const session=diagnosticSessions.find(s=>s.id===activeDiagnosticId);
  if(!session||!session.tree)return 0;
  const st=session.tree.stages.find(s=>(s.label||s.id)===stageLabel);
  if(!st)return 0;
  let count=0;
  (st.l1_metrics||[]).forEach(l1=>{
    const ev=l1.evidence;
    if(ev&&(ev.currentValue||ev.previousValue||ev.targetBenchmark||ev.trend||ev.notes||ev.instrumentationStatus))count++;
    (l1.l2_metrics||[]).forEach(l2=>{
      const ev2=l2.evidence;
      if(ev2&&(ev2.currentValue||ev2.previousValue||ev2.targetBenchmark||ev2.trend||ev2.notes||ev2.instrumentationStatus))count++;
      (l2.l3_metrics||[]).forEach(l3=>{
        const ev3=l3.evidence;
        if(ev3&&(ev3.currentValue||ev3.previousValue||ev3.targetBenchmark||ev3.trend||ev3.notes||ev3.instrumentationStatus))count++;
      });
    });
  });
  return count;
}

function stageExecuteCascade(stageLabel,stageId){
  // v9.05: label-substring matching (`k.includes('||'+stageLabel)`) never
  // matches capStore's 'pi||'+capName key format — that substring check
  // only works for KPI-linked stages where the key IS stageId+'||'+metricName
  // and metricName directly derives from this stage's own l1_metrics. For
  // the Custom Value Stage (stageId==='pi'), use identity-based ownership
  // instead (isPiCapEntry, from pi-bucket.js) so cleanup actually reaches
  // every custom process area/metric's capabilities, not silently no-op.
  //
  // v9.07 fix: the "else" branch below was ALSO never actually working for
  // ordinary KPI-linked stages, contrary to this comment's original claim.
  // capStore keys are built as stageId+'||'+metricName (confirmed via direct
  // read of deleteCapability()/editCapability()), but this matched against
  // stageLabel (the display title, e.g. "Acquisition") instead of stageId
  // (the lowercase id, e.g. "acquisition") — for any stage where these
  // differ, which is every ordinary stage, the substring never matched and
  // this line silently deleted nothing. Confirmed via direct test: a
  // capStore entry survived a full stage delete untouched. Fixed to match
  // on stageId (the actual key prefix), consistent with how every other
  // capStore lookup in this file already keys these entries.
  if(stageId==='pi'&&typeof isPiCapEntry==='function'){
    Object.keys(capStore).forEach(k=>{if(isPiCapEntry(k,capStore[k]))delete capStore[k];});
  } else {
    // 1. Strip capStore keys for this stage
    Object.keys(capStore).forEach(k=>{if(k.startsWith(stageId+'||'))delete capStore[k];});
  }
  // 2. Merge evidence (discards this stage's metrics) if session exists
  const session=diagnosticSessions&&diagnosticSessions.find(s=>s.id===activeDiagnosticId);
  if(session)dvMergeEvidenceOnRegen(session,gData);
  // 3. Clear analysis if it exists
  if(productLeakAnalysis)laClearAnalysis();
  // 4. Purge Story Canvas features for this stage
  scPurgeStage(stageLabel);
  // 5. If on dv/la tab, switch back to mm
  if(curTab==='dv'||curTab==='la')switchTab('mm');
}

// ── Stage delete ──
function deleteStage(idx){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  if(!gData||!gData.stages[idx])return;
  const st=gData.stages[idx];
  const stageLabel=st.label||st.id;
  const _isPiStage=(st.id==='pi');
  const affected=stageGetAffectedFeatures(stageLabel);
  const storyCount=stageGetAffectedStoryCount(affected);
  const evidenceCount=stageGetAffectedEvidenceCount(stageLabel);
  const hasAnalysis=!!(productLeakAnalysis&&productLeakAnalysis.length>0);
  // v9.05: count custom-bucket capabilities separately — stageGetAffectedFeatures
  // only tracks scCanvas features linked to AI-generated stages' l1_metrics,
  // not pi|| capStore entries directly, so this needs its own count.
  const _piCapCount=_isPiStage&&typeof isPiCapEntry==='function'
    ?Object.keys(capStore).filter(k=>isPiCapEntry(k,capStore[k])).reduce((a,k)=>a+((capStore[k].capabilities||[]).length),0)
    :0;
  // v9.07 fix: ordinary (non-pi) stages had no equivalent capStore-capability
  // count in this warning — the modal never told the user how many
  // capabilities (independent of Feature Canvas linkage) were about to be
  // removed. Matches on st.id (stageId), NOT stageLabel — capStore keys are
  // built as stageId+'||'+metricName by deleteCapability()/editCapability(),
  // confirmed via direct read; stageLabel is the display title and would
  // silently never match (the same class of stale-key bug already
  // documented, and only partially fixed, for stageExecuteCascade() itself —
  // flagging that as a separate, pre-existing gap, not fixed here since it's
  // outside this feature's approved scope).
  const _stageCapStoreCount=(!_isPiStage)
    ?Object.keys(capStore).filter(k=>k.startsWith(st.id+'||')).reduce((a,k)=>a+((capStore[k].capabilities||[]).length),0)
    :0;

  // Build consequence list HTML
  let conseqItems='';
  if(_isPiStage){
    conseqItems+=`<li class="warn">&#9888; This deletes ALL custom process areas/metrics under Custom Value Stage — ${_piCapCount} capabilit${_piCapCount!==1?'ies':'y'} across every custom bucket, not just one.</li>`;
  }
  if(!_isPiStage&&_stageCapStoreCount>0)conseqItems+=`<li class="warn">&#9888; ${_stageCapStoreCount} capabilit${_stageCapStoreCount!==1?'ies':'y'} in Capability Canvas linked to this stage will be removed</li>`;
  if(affected.length>0)conseqItems+=`<li>${affected.length} feature${affected.length!==1?'s':''} on Feature Canvas linked to this stage will be removed</li>`;
  if(storyCount>0)conseqItems+=`<li class="warn">&#9888; ${storyCount} generated stor${storyCount===1?'y':'ies'} across those features will be permanently lost</li>`;
  if(evidenceCount>0)conseqItems+=`<li>Evidence entered for ${evidenceCount} metric${evidenceCount!==1?'s':''} in this stage will be discarded</li>`;
  if(hasAnalysis)conseqItems+=`<li>Experiment Canvas will be cleared and must be re-run</li>`;

  const conseqHTML=conseqItems?`<div class="stage-del-consequence"><div class="stage-del-consequence-title">What will be affected</div><ul>${conseqItems}</ul><div class="stage-del-consequence-note">This cannot be undone.</div></div>`:'<p style="font-size:11px;color:var(--t3);margin:0 0 16px;">No downstream data linked to this stage. Safe to delete.</p>';

  // Render modal
  const existing=document.getElementById('stage-modal-overlay');
  if(existing)existing.remove();
  const overlay=document.createElement('div');
  overlay.id='stage-modal-overlay';
  overlay.className='stage-modal-overlay';
  overlay.innerHTML=`<div class="stage-modal">
    <div class="stage-modal-head">
      <div class="stage-modal-title">Delete &ldquo;${e(stageLabel)}&rdquo;?</div>
      <button class="stage-modal-close" onclick="document.getElementById('stage-modal-overlay').remove()">&times;</button>
    </div>
    <div class="stage-modal-body">
      ${conseqHTML}
    </div>
    <div class="stage-modal-footer">
      <button class="stage-modal-cancel" onclick="document.getElementById('stage-modal-overlay').remove()">Cancel</button>
      <button class="stage-modal-save destructive" id="stage-del-save-btn" onclick="confirmDeleteStage(${idx},'${stageLabel.replace(/'/g,"\\'")}')">Delete stage</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click',function(ev){if(ev.target===overlay)overlay.remove();});
}

function confirmDeleteStage(idx,stageLabel){
  // v9.07: disable confirm button immediately to prevent double-click races.
  const _saveBtn=document.getElementById('stage-del-save-btn');
  if(_saveBtn)_saveBtn.disabled=true;
  document.getElementById('stage-modal-overlay').remove();
  if(!gData||!gData.stages[idx])return;
  const _stageId=gData.stages[idx].id;
  gData.stages.splice(idx,1);
  stageExecuteCascade(stageLabel,_stageId);
  renderMM(gData);
  renderDiagnosticActionBar();
  stageShowToast('Stage deleted. Downstream data updated.');
  _dmPersistAndSync();
}

// ── Stage edit ──
function editStage(idx){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  if(!gData||!gData.stages[idx])return;
  const st=gData.stages[idx];
  const stageLabel=st.label||st.id;
  const stageDesc=st.description||'';
  const affected=stageGetAffectedFeatures(stageLabel);
  const storyCount=stageGetAffectedStoryCount(affected);
  const evidenceCount=stageGetAffectedEvidenceCount(stageLabel);
  const hasAnalysis=!!(productLeakAnalysis&&productLeakAnalysis.length>0);
  const hasDownstream=affected.length>0||evidenceCount>0||hasAnalysis;

  // v9.06.01: Custom Value Stage's name is now editable — the v9.05 lock
  // is removed since stageRenameDownstream() has been hardened with a
  // stageId-aware branch (identity-based capStore field update, never a
  // substring-based re-key that never matched pi|| keys anyway).
  // Individual process areas/buckets WITHIN this stage remain separately
  // renameable via their own dedicated edit path (piBucketRename).
  const _isPiStage=(st.id==='pi');

  const _isCapMode=gData.approach==='capability-based';
  const _entityWord=_isCapMode?'capabilities':'metrics';
  const disabledNote=!hasDownstream?'<div class="stage-modal-radio-disabled-note">Options 2 &amp; 3 unlock once this stage has features, evidence, or diagnostics</div>':'';

  const existing=document.getElementById('stage-modal-overlay');
  if(existing)existing.remove();
  const overlay=document.createElement('div');
  overlay.id='stage-modal-overlay';
  overlay.className='stage-modal-overlay';
  overlay.innerHTML=`<div class="stage-modal">
    <div class="stage-modal-head">
      <div class="stage-modal-title">Edit Stage</div>
      <button class="stage-modal-close" onclick="document.getElementById('stage-modal-overlay').remove()">&times;</button>
    </div>
    <div class="stage-modal-body">
      <div class="stage-modal-field">
        <label>Stage name</label>
        <input type="text" id="edit-stage-name" value="${e(stageLabel)}" maxlength="60" oninput="editStageValidate()"/>
      </div>
      <div class="stage-modal-field">
        <label>Description <span style="font-weight:400;text-transform:none;letter-spacing:0;">(optional)</span></label>
        <textarea id="edit-stage-desc" rows="2" maxlength="200" oninput="editStageValidate()">${e(stageDesc)}</textarea>
      </div>
      <hr class="stage-modal-divider"/>
      <div class="stage-modal-radio-label">What kind of change is this?</div>
      <div class="stage-modal-radio-group" id="edit-stage-radio-group">
        <label class="stage-modal-radio-item" id="edit-radio-item-1">
          <input type="radio" name="edit-stage-type" value="label" onchange="editStageRadioChange()" />
          <div class="stage-modal-radio-text">
            <span class="stage-modal-radio-title">Label or description only</span>
            <span class="stage-modal-radio-sub">Terminology correction — no impact to ${_entityWord} or downstream work</span>
          </div>
        </label>
        <label class="stage-modal-radio-item${!hasDownstream?' disabled':''}" id="edit-radio-item-2">
          <input type="radio" name="edit-stage-type" value="scope-shift" onchange="editStageRadioChange()" ${!hasDownstream?'disabled':''}/>
          <div class="stage-modal-radio-text">
            <span class="stage-modal-radio-title">Scope has shifted — keep my work</span>
            <span class="stage-modal-radio-sub">Stage concept changed but existing ${_entityWord} and evidence still apply</span>
          </div>
        </label>
        <label class="stage-modal-radio-item${!hasDownstream?' disabled':''}" id="edit-radio-item-3">
          <input type="radio" name="edit-stage-type" value="scope-reset" onchange="editStageRadioChange()" ${!hasDownstream?'disabled':''}/>
          <div class="stage-modal-radio-text">
            <span class="stage-modal-radio-title">Scope has changed — reset this stage</span>
            <span class="stage-modal-radio-sub">${_isPiStage?'This deletes ALL custom process areas/metrics and their capabilities under Custom Value Stage — not just this description.':(_isCapMode?'Capabilities':'Metrics')+', evidence, and stories from this stage will be cleared'}</span>
          </div>
        </label>
      </div>
      ${disabledNote}
      <div id="edit-stage-consequence" style="display:none;"></div>
    </div>
    <div class="stage-modal-footer">
      <button class="stage-modal-cancel" onclick="document.getElementById('stage-modal-overlay').remove()">Cancel</button>
      <button class="stage-modal-save" id="edit-stage-save" disabled onclick="confirmEditStage(${idx},'${stageLabel.replace(/'/g,"\\'")}')">Save changes</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click',function(ev){if(ev.target===overlay)overlay.remove();});

  // Store downstream counts for consequence block
  overlay._affected=affected;
  overlay._storyCount=storyCount;
  overlay._evidenceCount=evidenceCount;
  overlay._hasAnalysis=hasAnalysis;
}

function editStageValidate(){
  const nameEl=document.getElementById('edit-stage-name');
  const saveBtn=document.getElementById('edit-stage-save');
  const radio=document.querySelector('input[name="edit-stage-type"]:checked');
  if(!nameEl||!saveBtn)return;
  const hasChange=nameEl.value.trim().length>0;
  const hasRadio=!!radio;
  saveBtn.disabled=!(hasChange&&hasRadio);
}

function editStageRadioChange(){
  editStageValidate();
  const radio=document.querySelector('input[name="edit-stage-type"]:checked');
  if(!radio)return;
  // Update selected styling
  document.querySelectorAll('.stage-modal-radio-item').forEach(el=>el.classList.remove('selected'));
  const checked=document.querySelector('input[name="edit-stage-type"]:checked');
  if(checked)checked.closest('.stage-modal-radio-item').classList.add('selected');
  // Update save button label and style
  const saveBtn=document.getElementById('edit-stage-save');
  if(radio.value==='scope-reset'){
    if(saveBtn){saveBtn.textContent='Save & Reset';saveBtn.classList.add('destructive');}
    // Show consequence block
    const overlay=document.getElementById('stage-modal-overlay');
    const affected=overlay._affected||[];
    const storyCount=overlay._storyCount||0;
    const evidenceCount=overlay._evidenceCount||0;
    const hasAnalysis=overlay._hasAnalysis||false;
    let items='';
    if(affected.length>0)items+=`<li>${affected.length} feature${affected.length!==1?'s':''} on Feature Canvas will be removed</li>`;
    if(storyCount>0)items+=`<li class="warn">&#9888; ${storyCount} generated stor${storyCount===1?'y':'ies'} will be permanently lost</li>`;
    if(evidenceCount>0)items+=`<li>Evidence for ${evidenceCount} metric${evidenceCount!==1?'s':''} in this stage will be discarded</li>`;
    if(hasAnalysis)items+=`<li>Experiment Canvas will be cleared and must be re-run</li>`;
    const conseq=document.getElementById('edit-stage-consequence');
    if(conseq){
      conseq.innerHTML=`<div class="stage-modal-consequence" style="margin-top:12px;"><div class="stage-modal-consequence-title"><i class="ti ti-alert-triangle" aria-hidden="true"></i> What will be affected</div><ul>${items}</ul><div class="stage-modal-consequence-note">This cannot be undone.</div></div>`;
      conseq.style.display='block';
    }
  }else{
    if(saveBtn){saveBtn.textContent='Save changes';saveBtn.classList.remove('destructive');}
    const conseq=document.getElementById('edit-stage-consequence');
    if(conseq)conseq.style.display='none';
  }
}

function confirmEditStage(idx,oldLabel){
  const nameEl=document.getElementById('edit-stage-name');
  const descEl=document.getElementById('edit-stage-desc');
  const radio=document.querySelector('input[name="edit-stage-type"]:checked');
  if(!nameEl||!radio||!gData||!gData.stages[idx])return;
  const _st=gData.stages[idx];
  const _isPiStage=(_st.id==='pi');
  // v9.06.01: re-enabled name editing for the Custom Value Stage — the
  // v9.05 lock (forcing the label back to 'PI Plan' regardless of input)
  // is removed now that stageRenameDownstream() has been hardened with a
  // stageId-aware branch (identity-based capStore.stageLabel update,
  // never re-keying) — see stageRenameDownstream()'s own comments.
  const newLabel=nameEl.value.trim();
  const newDesc=descEl?descEl.value.trim():'';
  const choice=radio.value;
  document.getElementById('stage-modal-overlay').remove();

  // Update gData
  gData.stages[idx].label=newLabel;
  gData.stages[idx].description=newDesc;

  if(choice==='label'){
    // Case A: rename only
    if(newLabel!==oldLabel)stageRenameDownstream(oldLabel,newLabel,_st.id);
    renderMM(gData);
    renderDiagnosticActionBar();
    if(typeof newScRender==='function')newScRender();
    if(typeof fcRenderCanvas==='function')fcRenderCanvas();
    // v9.06.01: CC's left panel/main view also need refresh when the pi
    // stage itself is renamed (same reasoning as piBucketRename()'s fix).
    if(_isPiStage&&typeof curTab!=='undefined'&&curTab==='cc'&&typeof ccOpenMetricNav==='function')ccOpenMetricNav();
    stageShowToast('Stage updated. No downstream changes made.');
    _dmPersistAndSync();
  } else if(choice==='scope-shift'){
    // Case B: rename + scope warning
    if(newLabel!==oldLabel)stageRenameDownstream(oldLabel,newLabel,_st.id);
    gData.stages[idx]._scopeWarning=true;
    renderMM(gData);
    renderDiagnosticActionBar();
    if(typeof newScRender==='function')newScRender();
    if(typeof fcRenderCanvas==='function')fcRenderCanvas();
    if(_isPiStage&&typeof curTab!=='undefined'&&curTab==='cc'&&typeof ccOpenMetricNav==='function')ccOpenMetricNav();
    // Toast if on dv or sc tab
    stageShowToast('Stage updated. Scope warning added — review metrics for relevance.');
    _dmPersistAndSync();
  } else if(choice==='scope-reset'){
    // Case C: rename + full cascade on OLD label first (before rename propagated)
    // v9.05: stageExecuteCascade() is now stageId-aware (see its own definition) —
    // passing _st.id lets it correctly use identity-based ownership cleanup
    // for the pi stage instead of the label-substring check that never
    // matches 'pi||'+capName keys.
    stageExecuteCascade(oldLabel,_st.id);
    if(_isPiStage){
      // Clear the stage's own l1_metrics too — every bucket is gone
      gData.stages[idx].l1_metrics=[];
    }
    // Now rename in gData (already done above) — propagate new name downstream (canvas is clear for this stage)
    renderMM(gData);
    renderDiagnosticActionBar();
    if(typeof newScRender==='function')newScRender();
    if(typeof fcRenderCanvas==='function')fcRenderCanvas();
    stageShowToast('Stage reset. Downstream data for this stage has been cleared.');
    _dmPersistAndSync();
  }
}

function stageRenameDownstream(oldLabel,newLabel,stageId){
  // v9.06.01: for the Custom Value Stage (stageId==='pi'), capStore keys
  // are 'pi||'+capabilityName — the stage LABEL never appears as a
  // substring of that key, so the general substring-based re-key below
  // silently does nothing for these entries (confirmed defect from
  // ChatGPT round-3 review). Use identity-based (stageId==='pi') field
  // update instead: patch stageLabel directly, NEVER re-key (capStore's
  // key format must stay 'pi||'+capName always, unrelated to stage label).
  if(stageId==='pi'){
    Object.keys(capStore).forEach(k=>{
      const entry=capStore[k];
      if(entry&&typeof isPiCapEntry==='function'&&isPiCapEntry(k,entry)){
        entry.stageId='pi';
        entry.stageLabel=newLabel;
      }
    });
  } else {
    // 1. Re-key capStore (unchanged — correct for ordinary KPI-linked stages)
    Object.keys(capStore).forEach(k=>{
      if(k.includes('||'+oldLabel)){
        const newKey=k.replace('||'+oldLabel,'||'+newLabel);
        capStore[newKey]=capStore[k];
        delete capStore[k];
      }
    });
  }
  // 2. Patch session.tree stage label
  const session=diagnosticSessions&&diagnosticSessions.find(s=>s.id===activeDiagnosticId);
  if(session&&session.tree){
    const st=session.tree.stages.find(s=>(s.label||s.id)===oldLabel);
    if(st)st.label=newLabel;
  }
  // 3. String-patch productLeakAnalysis — iterate all runs
  // v9.06.01: for the pi stage specifically, also patch the legacy literal
  // 'PI Plan' alongside oldLabel, in case any productLeakAnalysis entries
  // predate this fix and still reference the old literal directly (per
  // ChatGPT round-3 finding — productLeakAnalysis has no stageId, only
  // plain label strings, so this is a best-effort safety net, not a
  // guaranteed-complete fix).
  const _legacyLabelsToPatch=stageId==='pi'?[oldLabel,'PI Plan']:[oldLabel];
  if(productLeakAnalysis&&productLeakAnalysis.length>0){
    productLeakAnalysis.forEach(function(run){
      if(_legacyLabelsToPatch.includes(run.leakingStage))run.leakingStage=newLabel;
      (run.experiments||[]).forEach(function(exp){
        if(_legacyLabelsToPatch.includes(exp.lifecycleStage))exp.lifecycleStage=newLabel;
      });
    });
  }
  // 4. Patch scCanvas stage references
  (scCanvas||[]).forEach(f=>{if(f&&_legacyLabelsToPatch.includes(f.stage))f.stage=newLabel;});
}

function stageShowToast(msg){
  const existing=document.getElementById('stage-op-toast');
  if(existing)existing.remove();
  const toast=document.createElement('div');
  toast.id='stage-op-toast';
  toast.className='dv-merge-toast';
  toast.textContent=msg;
  document.body.appendChild(toast);
  setTimeout(()=>toast.classList.add('on'),50);
  setTimeout(()=>{toast.classList.remove('on');setTimeout(()=>toast.remove(),400);},4000);
}

// ── Capability-level edit/delete (Discovery Map, Capability-Based mode only) ──
// Modal edit/delete pattern mirrors stage edit/delete above.
function capGetAffectedFeatures(metricKey){
  const capEntry=capStore[metricKey];
  if(!capEntry)return[];
  let feats=[];
  (capEntry.capabilities||[]).forEach(cap=>{
    const fs=cap.featStore;
    if(!fs)return;
    Object.keys(fs).forEach(k=>{
      if(Array.isArray(fs[k]))feats=feats.concat(fs[k]);
    });
  });
  return feats;
}
// v9.07: shared persist+sync for Discovery Map stage/capability manual
// edit and delete actions. Mirrors the existing pattern used by every
// AI-generation call site (capture session id before async, save, only
// emit on success) but deliberately does NOT acquire the generation lock —
// these are fast, low-latency manual edits, not multi-second AI
// generations, and wrapping them in the full acquire/heartbeat/release
// lock lifecycle would add meaningful latency for a comparatively rare
// collision. A non-blocking courtesy check (_lsPeekIfLocked) warns if
// someone is actively generating on this session, but does not block or
// serialize the save — this is an accepted, documented simplification,
// not an oversight. See AI_EDITING_RULES.md's live-sync section for the
// full save/emit contract this follows.
//
// Known accepted limitation: because this does not take the real
// generation lock, a manual DM edit that saves concurrently with someone
// else's in-flight AI generation on the same session can still race —
// sessionStoreSave() is a full snapshot overwrite with no version
// checking (a pre-existing, documented limitation of this app, not
// introduced here). This mirrors the same accepted risk already present
// for PI's own non-locked manual edit path (piRemoveStoryFromBacklog).
async function _dmPersistAndSync(){
  if(typeof _isDemoSession!=='undefined'&&_isDemoSession)return;
  if(typeof sessionStoreSave!=='function'||typeof _activeSessionId==='undefined'||!_activeSessionId)return;
  const saveSessionId=_activeSessionId;
  const wasSharedSession=(typeof _activeSessionIsShared!=='undefined'&&_activeSessionIsShared);
  // Non-blocking courtesy check only — does not prevent or serialize the
  // save that follows. See function-level comment above.
  if(wasSharedSession&&typeof _lsPeekIfLocked==='function'){
    try{
      const _peek=await _lsPeekIfLocked(saveSessionId);
      if(_peek&&_peek.locked&&typeof showToast==='function'){
        showToast((_peek.holderName||'Someone on your team')+' is generating on this session right now — your change was saved, but may be overwritten if their generation completes after.','warn');
      }
    }catch(e){ /* non-fatal — peek is advisory only */ }
  }
  try{
    const ok=await sessionStoreSave(saveSessionId);
    if(ok&&wasSharedSession&&typeof _lsEmitContentEvent==='function'){
      try{
        await _lsEmitContentEvent(saveSessionId,'mm','discovery_map_updated',null,null);
      }catch(e){
        console.warn('[DM edit] Event emission failed (save already succeeded):',e);
      }
    }
  }catch(e){
    console.warn('[DM edit] sessionStoreSave failed:',e);
  }
}
function capGetAffectedStoryCount(features){
  return features.reduce((sum,f)=>sum+(f.stories&&f.stories.length?f.stories.length:0),0);
}
function capExecuteCascade(metricKey,capName,stageLabel){
  // 1. Delete the capStore entry for this capability
  delete capStore[metricKey];
  // 2. Purge matching scCanvas entries (features sent to Story/Feature Canvas from this capability)
  scCanvas=(scCanvas||[]).filter(f=>!(f.cap===capName&&f.stage===stageLabel));
}

function editCapability(stIdx,li){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  if(!gData||!gData.stages[stIdx]||!gData.stages[stIdx].l1_metrics||!gData.stages[stIdx].l1_metrics[li])return;
  const st=gData.stages[stIdx];
  const l1=st.l1_metrics[li];
  const stageLabel=st.label||st.id;
  const capName=l1.name;
  const capDesc=l1.why||'';
  // v9.05: for the Custom Value Stage (st.id==='pi'), this l1_metrics entry
  // represents a BUCKET (Custom Process Area/Metric), not a single capability
  // — l1.name is the bucket's display name, not an individual capability
  // name. st.id+'||'+capName would look up the wrong thing entirely in
  // capStore (capStore keys are 'pi||'+individualCapabilityName, never
  // 'pi||'+bucketDisplayName). Use bucketId-based lookup instead.
  const _isPiBucket=(st.id==='pi');
  let affected=[];
  let storyCount=0;
  if(_isPiBucket){
    const _bucketId=l1.bucketId;
    // v9.07: guard against undefined bucketId matching other undefined-bucketId
    // entries by coincidence — only aggregate if this bucket genuinely has an id.
    if(_bucketId){
      Object.keys(capStore).forEach(k=>{
        const entry=capStore[k];
        if(entry&&entry.bucketId===_bucketId){
          affected=affected.concat(capGetAffectedFeatures(k));
        }
      });
    }
    storyCount=capGetAffectedStoryCount(affected);
  } else {
    const metricKey=st.id+'||'+capName;
    affected=capGetAffectedFeatures(metricKey);
    storyCount=capGetAffectedStoryCount(affected);
  }
  const hasDownstream=affected.length>0;

  const existing=document.getElementById('cap-edit-modal-overlay');
  if(existing)existing.remove();
  const overlay=document.createElement('div');
  overlay.id='cap-edit-modal-overlay';
  overlay.className='stage-modal-overlay';
  overlay.innerHTML=`<div class="stage-modal">
    <div class="stage-modal-head">
      <div class="stage-modal-title">${_isPiBucket?((typeof gData!=='undefined'&&gData&&gData.approach==='capability-based')?'Edit Process Area':'Edit Metric'):(gData&&gData.approach==='capability-based'?'Edit Process Area':'Edit Capability')}</div>
      <button class="stage-modal-close" onclick="document.getElementById('cap-edit-modal-overlay').remove()">&times;</button>
    </div>
    <div class="stage-modal-body">
      <div class="stage-modal-field">
        <label>${_isPiBucket?((typeof gData!=='undefined'&&gData&&gData.approach==='capability-based')?'Process area name':'Metric name'):(gData&&gData.approach==='capability-based'?'Process area name':'Capability name')}</label>
        <input type="text" id="edit-cap-name" value="${e(capName)}" maxlength="80" oninput="editCapabilityValidate()"/>
      </div>
      <div class="stage-modal-field">
        <label>Description <span style="font-weight:400;text-transform:none;letter-spacing:0;">(optional)</span></label>
        <textarea id="edit-cap-desc" rows="2" maxlength="200" oninput="editCapabilityValidate()">${e(capDesc)}</textarea>
      </div>
      ${hasDownstream?`<div class="stage-modal-radio-disabled-note">This ${_isPiBucket?'process area':(gData&&gData.approach==='capability-based'?'process area':'capability')} has ${affected.length} feature${affected.length!==1?'s':''}${storyCount>0?' and '+storyCount+' stor'+(storyCount===1?'y':'ies'):''} generated. Renaming will keep them linked.</div>`:''}
    </div>
    <div class="stage-modal-footer">
      <button class="stage-modal-cancel" onclick="document.getElementById('cap-edit-modal-overlay').remove()">Cancel</button>
      <button class="stage-modal-save" id="edit-cap-save" onclick="confirmEditCapability(${stIdx},${li}${_isPiBucket?",'"+String(l1.bucketId||'').replace(/'/g,"\\'")+"'":',undefined'},'${String(capName).replace(/'/g,"\\'")}')">Save changes</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click',function(ev){if(ev.target===overlay)overlay.remove();});
  const _escHandler=function(ev){if(ev.key==='Escape'){overlay.remove();document.removeEventListener('keydown',_escHandler,true);}};
  document.addEventListener('keydown',_escHandler,true);
  trapFocus(overlay);
}

function editCapabilityValidate(){
  const nameEl=document.getElementById('edit-cap-name');
  const saveBtn=document.getElementById('edit-cap-save');
  if(!nameEl||!saveBtn)return;
  saveBtn.disabled=nameEl.value.trim().length===0;
}

function confirmEditCapability(stIdx,li,expectedBucketId,expectedName){
  const nameEl=document.getElementById('edit-cap-name');
  const descEl=document.getElementById('edit-cap-desc');
  if(!nameEl||!gData||!gData.stages[stIdx]||!gData.stages[stIdx].l1_metrics[li])return;
  const st=gData.stages[stIdx];
  const l1=st.l1_metrics[li];
  const newName=nameEl.value.trim();
  const newDesc=descEl?descEl.value.trim():'';
  document.getElementById('cap-edit-modal-overlay').remove();

  // v9.05: Custom Value Stage's l1_metrics entries are BUCKETS (Custom
  // Process Area/Metric), not individual capabilities — capRenameDownstream()
  // assumes exactly one capStore entry maps to one l1_metrics entry, which
  // is false here (many capStore['pi||'+capName] entries can share the same
  // bucketId). Redirect to the dedicated piBucketRename() function instead,
  // which propagates the display name to every entry sharing this bucketId
  // WITHOUT re-keying any capStore entry (no capability name/key touched).
  if(st.id==='pi'){
    // v9.05 defensive guard: stIdx/li are baked into this modal's Save
    // button at MODAL-OPEN time (editCapability()). If gData.stages was
    // mutated in the background while the modal sat open — e.g. a
    // live-sync poll cycle applied a teammate's change and
    // syncPiStageFromCapStore() spliced/reordered stages — stIdx/li could
    // now point at a completely different entry than the one the user was
    // actually looking at. Re-verify identity via bucketId (captured at
    // modal-open time, immune to array-index drift) before mutating
    // anything; abort silently rather than risk corrupting the wrong bucket.
    if(expectedBucketId!==undefined&&l1.bucketId!==expectedBucketId){
      showToast('This process area changed while you were editing. Please try again.','warn');
      renderMM(gData);
      return;
    }
    if(typeof piBucketRename==='function'){
      piBucketRename(stIdx,li,newName,newDesc);
      renderMM(gData);
      if(typeof fcRenderCanvas==='function')fcRenderCanvas();
      if(typeof newScRender==='function')newScRender();
      // v9.05 fix: CC's own left panel/main area were never refreshed after
      // a DM-side bucket rename — piBucketRename() correctly updates
      // capStore[k].metricName for every capability sharing this bucket,
      // but nothing told CC to re-render and pick up the change. Only
      // refresh if CC is the currently active tab (consistent with the
      // curTab guards used elsewhere for this kind of cross-tab sync).
      if(typeof curTab!=='undefined'&&curTab==='cc'&&typeof ccOpenMetricNav==='function')ccOpenMetricNav();
      stageShowToast('Process area updated.');
      _dmPersistAndSync();
    }
    return;
  }

  // v9.07: stale-index guard for the ordinary (non-pi) branch — mirrors the
  // pi-branch's expectedBucketId re-verification above. stIdx/li are baked
  // into the Save button at modal-open time; if gData.stages was mutated in
  // the background while the modal sat open (a live-sync wholesale apply
  // could replace gData entirely), stIdx/li could now point at a different
  // L1 entry than the one the user was actually looking at. Re-verify by
  // name (captured at modal-open time) before mutating anything.
  if(expectedName!==undefined&&l1.name!==expectedName){
    showToast('This capability changed while you were editing. Please try again.','warn');
    renderMM(gData);
    return;
  }

  const stageLabel=st.label||st.id;
  const oldName=l1.name;
  l1.name=newName;
  l1.why=newDesc;

  if(newName!==oldName)capRenameDownstream(oldName,newName,st.id,stageLabel);

  renderMM(gData);
  stageShowToast('Capability updated.');
  _dmPersistAndSync();
}

// Re-keys capStore and patches scCanvas — mirrors stageRenameDownstream() for the
// capability-level rename case (found missing in pre-build stress test).
// capStore keys use stageId (per PROJECT_MAP.md format); scCanvas.stage holds the
// display label, so both are needed — conflating them was the root cause of a
// bug where affected-features lookups always returned empty.
function capRenameDownstream(oldName,newName,stageId,stageLabel){
  const oldKey=stageId+'||'+oldName;
  const newKey=stageId+'||'+newName;
  if(capStore[oldKey]){
    capStore[newKey]=capStore[oldKey];
    delete capStore[oldKey];
  }
  (scCanvas||[]).forEach(f=>{if(f.cap===oldName&&f.stage===stageLabel)f.cap=newName;});
}

function deleteCapability(stIdx,li){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  if(!gData||!gData.stages[stIdx]||!gData.stages[stIdx].l1_metrics||!gData.stages[stIdx].l1_metrics[li])return;
  const st=gData.stages[stIdx];
  const l1=st.l1_metrics[li];
  const stageLabel=st.label||st.id;
  const capName=l1.name;
  const _isPiBucket=(st.id==='pi');
  let affected=[];
  let _bucketCapCount=0;
  let _capStoreCount=0; // v9.07: capabilities present in capStore directly, independent of Feature Canvas linkage
  if(_isPiBucket){
    const _bucketId=l1.bucketId;
    // v9.07: guard against undefined bucketId matching other undefined-bucketId
    // entries by coincidence — only aggregate if this bucket genuinely has an id.
    if(_bucketId){
      Object.keys(capStore).forEach(k=>{
        const entry=capStore[k];
        if(entry&&entry.bucketId===_bucketId){
          affected=affected.concat(capGetAffectedFeatures(k));
          _bucketCapCount+=(entry.capabilities||[]).length;
        }
      });
    }
  } else {
    const metricKey=st.id+'||'+capName;
    affected=capGetAffectedFeatures(metricKey);
    // v9.07 fix: capGetAffectedFeatures() only detects capabilities whose
    // features were explicitly sent to Feature Canvas — it has no visibility
    // into capabilities that exist in capStore but were never pushed
    // downstream. Confirmed repro: generate capabilities against this metric
    // in Capability Canvas, never send any features onward, then delete this
    // metric here — affected.length was 0, triggering an instant silent
    // delete that orphaned the capStore entry with zero warning. Counting
    // capStore capabilities directly closes this gap.
    const _capEntry=capStore[metricKey];
    _capStoreCount=(_capEntry&&_capEntry.capabilities)?_capEntry.capabilities.length:0;
  }
  const storyCount=capGetAffectedStoryCount(affected);
  // v9.07 fix: Outcome Metrics L1 rows can have nested L2/L3 children (unlike
  // Process Area rows, which are always flat) — now that delete is exposed
  // on these rows too, a delete with no capStore/feature downstream data but
  // WITH nested children would previously have silently wiped the whole
  // subtree via the instant-delete path below with no warning at all.
  const _nestedCount=(l1.l2_metrics||[]).length;

  if(affected.length===0&&_capStoreCount===0&&_nestedCount===0&&!_isPiBucket){
    // No downstream data of any kind — instant delete, no modal (KPI-linked
    // only; pi buckets always show the modal since they may hold multiple
    // capabilities even without any Feature Canvas downstream data)
    st.l1_metrics.splice(li,1);
    renderMM(gData);
    stageShowToast('Capability deleted.');
    _dmPersistAndSync();
    return;
  }

  // Downstream data exists — consequence modal
  let conseqItems='';
  if(_isPiBucket){
    conseqItems+=`<li class="warn">&#9888; This deletes ${_bucketCapCount} capabilit${_bucketCapCount!==1?'ies':'y'} in this process area, not just this entry.</li>`;
  }
  if(!_isPiBucket&&_capStoreCount>0)conseqItems+=`<li class="warn">&#9888; ${_capStoreCount} capabilit${_capStoreCount!==1?'ies':'y'} in Capability Canvas will be removed</li>`;
  if(_nestedCount>0)conseqItems+=`<li class="warn">&#9888; ${_nestedCount} nested L2/L3 metric${_nestedCount!==1?'s':''} beneath it will also be deleted</li>`;
  if(affected.length>0)conseqItems+=`<li>${affected.length} feature${affected.length!==1?'s':''} on Feature Canvas will be removed</li>`;
  if(storyCount>0)conseqItems+=`<li class="warn">&#9888; ${storyCount} generated stor${storyCount===1?'y':'ies'} will be permanently lost</li>`;
  const conseqHTML=`<div class="stage-del-consequence"><div class="stage-del-consequence-title">What will be affected</div><ul>${conseqItems}</ul><div class="stage-del-consequence-note">This cannot be undone.</div></div>`;

  const existing=document.getElementById('cap-del-modal-overlay');
  if(existing)existing.remove();
  const overlay=document.createElement('div');
  overlay.id='cap-del-modal-overlay';
  overlay.className='stage-modal-overlay';
  overlay.innerHTML=`<div class="stage-modal">
    <div class="stage-modal-head">
      <div class="stage-modal-title">Delete &ldquo;${e(capName)}&rdquo;?</div>
      <button class="stage-modal-close" onclick="document.getElementById('cap-del-modal-overlay').remove()">&times;</button>
    </div>
    <div class="stage-modal-body">
      ${conseqHTML}
    </div>
    <div class="stage-modal-footer">
      <button class="stage-modal-cancel" onclick="document.getElementById('cap-del-modal-overlay').remove()">Cancel</button>
      <button class="stage-modal-save destructive" id="cap-del-save-btn" onclick="confirmDeleteCapability(${stIdx},${li}${_isPiBucket?",'"+String(l1.bucketId||'').replace(/'/g,"\\'")+"'":',undefined'},'${String(capName).replace(/'/g,"\\'")}')">Delete capability</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click',function(ev){if(ev.target===overlay)overlay.remove();});
}

function confirmDeleteCapability(stIdx,li,expectedBucketId,expectedName){
  // v9.07: disable the confirm button immediately to prevent a double-click
  // from splicing twice or racing two saves — re-enabling isn't needed since
  // this function always either removes the overlay or returns early with
  // the overlay still in place (in which case the user can just retry).
  const _saveBtn=document.getElementById('cap-del-save-btn');
  if(_saveBtn)_saveBtn.disabled=true;
  document.getElementById('cap-del-modal-overlay').remove();
  if(!gData||!gData.stages[stIdx]||!gData.stages[stIdx].l1_metrics[li])return;
  const st=gData.stages[stIdx];
  const l1=st.l1_metrics[li];
  const stageLabel=st.label||st.id;
  const capName=l1.name;
  if(st.id==='pi'){
    // v9.05 defensive guard: same stale-index risk as confirmEditCapability()
    // — but here the consequence is destructive (piBucketDelete() removes
    // capStore entries), so this check is even more important. Re-verify
    // via bucketId (captured at modal-open time) before deleting anything.
    if(expectedBucketId!==undefined&&l1.bucketId!==expectedBucketId){
      showToast('This process area changed while you were viewing it. Please try again.','warn');
      renderMM(gData);
      return;
    }
    // v9.05: delete the whole bucket by bucketId (all capStore entries
    // sharing it), not a single KPI-linked capability by metricKey.
    if(typeof piBucketDelete==='function')piBucketDelete(l1.bucketId);
    st.l1_metrics.splice(li,1);
    renderMM(gData);
    if(typeof fcRenderCanvas==='function')fcRenderCanvas();
    if(typeof newScRender==='function')newScRender();
    // v9.05 fix: same missing CC refresh as confirmEditCapability()'s
    // pi-branch — piBucketDelete() removes capStore entries CC displays,
    // so CC needs to re-render if it's the active tab.
    if(typeof curTab!=='undefined'&&curTab==='cc'&&typeof ccOpenMetricNav==='function')ccOpenMetricNav();
    stageShowToast('Process area deleted. Downstream data updated.');
    _dmPersistAndSync();
    return;
  }
  // v9.07: stale-index guard for the ordinary (non-pi) branch — mirrors the
  // pi-branch's expectedBucketId re-verification above.
  if(expectedName!==undefined&&l1.name!==expectedName){
    showToast('This capability changed while you were viewing it. Please try again.','warn');
    renderMM(gData);
    return;
  }
  const metricKey=st.id+'||'+capName;
  capExecuteCascade(metricKey,capName,stageLabel);
  st.l1_metrics.splice(li,1);
  renderMM(gData);
  fcRenderCanvas();
  stageShowToast('Capability deleted. Downstream data updated.');
  _dmPersistAndSync();
}

// ── Evidence drawer entry point from KPI tree ──
function kpiOpenEvidenceDrawer(metricName, displayName, stageName, level){
  if(!gData){showToast('Generate a Discovery Map first.','info');return;}
  // Create diagnostic session on first use if it doesn't exist
  if(diagnosticSessions.length===0){
    const session={
      id:'diag-01',
      name:'Diagnostic 01',
      tree:dvDeepCloneTree(gData),
      readiness:null
    };
    diagnosticSessions=[session];
    activeDiagnosticId='diag-01';
  }
  // Resolve _dvId from metric name — dvFindMetricById requires _dvId, not name
  const session=diagnosticSessions.find(s=>s.id===activeDiagnosticId);
  if(!session)return;
  const allMetrics=dvFlattenMetrics(session.tree);
  const found=allMetrics.find(m=>m.name===metricName);
  if(!found){showToast('Metric not found in diagnostic session.','warn');return;}
  dvOpenEvidenceDrawer(found.id, displayName, stageName, level);
}

// ── Update Run Diagnostics button state ──
// Disabled if: no evidence at all, OR evidence exists but nothing changed since last run.
// Enabled if: evidence exists AND (no prior runs OR something changed).
function kpiUpdateRunDiagnosticsBtn(){
  const btn=document.getElementById('diag-run-btn');
  const rerunLink=document.getElementById('diag-rerun-link');
  if(!btn)return;
  const session=diagnosticSessions.find(s=>s.id===activeDiagnosticId);
  if(!session){btn.disabled=true;if(rerunLink)rerunLink.style.display='none';return;}
  const readiness=dvCalcReadiness(session);
  if(readiness.metricsWithEvidence===0){
    btn.disabled=true;
    btn.title='Add evidence to a metric first';
    if(rerunLink)rerunLink.style.display='none';
    return;
  }
  // Check if evidence changed since last run
  const noPriorRuns=!productLeakAnalysis||productLeakAnalysis.length===0;
  if(noPriorRuns){
    btn.disabled=false;
    btn.title='';
    if(rerunLink)rerunLink.style.display='none';
    return;
  }
  // Build current evidence snapshot and diff
  var hasChanged=false;
  if(typeof _dvBuildEvidenceSnapshot==='function'&&typeof _dvDiffEvidence==='function'){
    const stagesWithEvidence=(session.tree.stages||[]).map(function(st){return{
      stage:st.label||st.id,
      l1_metrics:(st.l1_metrics||[]).map(function(l1){return{
        name:l1.name,evidence:l1.evidence||null,
        evidenceStrength:typeof dvCalcEvidenceStrength==='function'?dvCalcEvidenceStrength(l1.evidence):'No evidence'
      };})
    };});
    const snap=_dvBuildEvidenceSnapshot(stagesWithEvidence);
    const changed=_dvDiffEvidence(snap);
    hasChanged=changed.length>0;
  } else {
    hasChanged=true; // fallback: always enable if diff functions not available
  }
  if(hasChanged){
    btn.disabled=false;
    btn.title='';
    if(rerunLink)rerunLink.style.display='none';
  } else {
    btn.disabled=true;
    btn.title='No new evidence since last run';
    if(rerunLink)rerunLink.style.display='';
  }
}

// ── Reflect evidence state on KPI tree metric nodes after save ──
function kpiRenderEvidenceStates(){
  const session=diagnosticSessions.find(s=>s.id===activeDiagnosticId);
  if(!session)return;
  const allMetrics=dvFlattenMetrics(session.tree);
  allMetrics.forEach(m=>{
    const evStr=dvCalcEvidenceStrength(m.evidence);
    const hasEvidence=evStr!=='No evidence';
    const dotCls=dvEvidenceDotClass(evStr);
    // Find Evidence buttons for this metric by scanning trigger rows
    document.querySelectorAll('.cap-trigger-ev').forEach(btn=>{
      const parent=btn.closest('.l1,.l2,.l3');
      if(!parent)return;
      const nameEl=parent.querySelector('.l1-name,.l2-name,.l3-name');
      if(!nameEl)return;
      // Get clean metric name — first text node only
      const firstText=Array.from(nameEl.childNodes).find(n=>n.nodeType===3);
      const nameTxt=firstText?firstText.textContent.trim():'';
      if(nameTxt!==m.name)return;
      // 1. Update dot in name element
      const existingDot=nameEl.querySelector('.kpi-ev-dot');
      if(existingDot)existingDot.remove();
      if(hasEvidence){
        const dot=document.createElement('span');
        dot.className=`kpi-ev-dot dv-ev-dot ${dotCls}`;
        dot.title=evStr;
        nameEl.appendChild(dot);
      }
      // 2. Update current value line below name
      const infoEl=parent.querySelector('.l1-info') || nameEl.parentElement;
      let valEl=infoEl.querySelector('.kpi-ev-val');
      if(hasEvidence&&m.evidence){
        const val=m.evidence.currentValue||'';
        const trend=m.evidence.trend||'';
        const notes=m.evidence.notes||'';
        let display=val?(val+(trend?' · '+trend:'')):(notes?notes.substring(0,40)+(notes.length>40?'…':''):'');
        if(display){
          if(!valEl){valEl=document.createElement('div');valEl.className='kpi-ev-val dv-current-val';infoEl.insertBefore(valEl,infoEl.querySelector('.l1-why,.l2-why')||null);}
          valEl.textContent=display;
        }
      } else {
        if(valEl)valEl.remove();
      }
      // 3. Update CTA label
      const _canEditKpiEv=(typeof canEditSession!=='function')||canEditSession();
      btn.innerHTML=(hasEvidence&&_canEditKpiEv)?'Edit evidence &#8594;':'Evidence &#8594;';
      btn.classList.toggle('cap-trigger-ev-done',hasEvidence);
    });
  });
  // Always apply diff-aware CTA state last (v8.42)
  if(typeof kpiUpdateRunDiagnosticsBtn==='function')kpiUpdateRunDiagnosticsBtn();
}
