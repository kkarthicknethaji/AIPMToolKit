let panelOpen=true;
function toggleSettings(){
  // Delegates to settings page open/close
  if(typeof openSettingsPage==='function') openSettingsPage();
}
function saveSettings(){
  // Delegates to settings page save — kept for any legacy callers
  if(typeof settingsPageSave==='function') settingsPageSave();
}
function applyFeats(){
  // Read from appSettings (single source of truth) instead of fly-out DOM checkboxes
  featDD   = appSettings.featDD;
  featCap  = true;
  featDiag = appSettings.featDiag;
  featMI   = appSettings.featMI;
  featPI   = appSettings.featPI;
  featOutcomePulse = appSettings.featOutcomePulse;
  featRA = appSettings.featRA;

  // #tab-dd retired — no longer a tab. DD is download-only panel triggered from KPI tree.
  document.querySelectorAll('.cap-trigger').forEach(function(b){b.style.display='';});
  // Story Canvas: reveal only when features exist — never force-show on settings save
  if(scCanvas&&scCanvas.length>0){
    const scTabEl=document.getElementById('tab-sc');
    if(scTabEl)scTabEl.classList.add('revealed');
  }
  document.querySelectorAll('.feat-item-check').forEach(function(c){c.style.display='';});
  const capFooter=document.getElementById('cap-drawer-footer');
  if(capFooter)capFooter.style.display=scCanvas.length===0?'none':'flex';
  // Diagnostic: hide/show CTA bar and leak tab
  const diagBar=document.getElementById('diag-action-bar');
  // Guard: only show diag bar when on mm tab — Settings save must not stomp other tabs
  if(diagBar)diagBar.style.display=(featDiag&&curTab==='mm')?'':'none';
  const laTabEl=document.getElementById('tab-la');
  // Only hide tab if it was revealed — if hidden by default, leave as-is
  if(!featDiag){
    if(laTabEl&&laTabEl.style.display!=='none')laTabEl.style.display='none';
    if(curTab==='la')switchTab('mm');
  }
  // Reveal PD tab only when a diagnostic run actually exists (length>0, not bare truthy)
  if(featDiag&&productLeakAnalysis&&productLeakAnalysis.length>0){
    if(laTabEl)laTabEl.style.display='';
  }
  // Restore/refresh bottom bar CTA if on mm tab and KPI tree exists. Always
  // re-renders (renderDiagnosticActionBar() removes+rebuilds fresh, so this
  // is safe/idempotent) rather than skipping when the bar already exists —
  // the CTA's label/route depends on the live raEnabled value (see
  // kpi-tree.js's _dmRaOn), so a settings save that flips raEnabled while
  // Discovery Map is already on screen must force a real re-render here,
  // not silently leave the bar showing its pre-toggle CTA (confirmed
  // regression: the old "!document.getElementById(...)" guard blocked
  // exactly this case).
  if(featDiag&&gData&&curTab==='mm'){
    renderDiagnosticActionBar();
  }
  // Market Intelligence: hide/show tab and mi-gated elements
  document.querySelectorAll('.mi-gated').forEach(function(el){
    el.style.display=featMI?'':'none';
  });
  if(!featMI){
    const miTabEl=document.getElementById('tab-mi');
    if(miTabEl)miTabEl.style.display='none';
    if(curTab==='mi')switchTab('mm');
  }
  // PI Planning: hide tab if disabled, show if enabled and a release plan exists
  const piTabEl=document.getElementById('tab-pi');
  if(piTabEl){
    if(!featPI){
      piTabEl.classList.remove('revealed');
      if(curTab==='pi')switchTab('mm');
    } else if(typeof piPlans!=='undefined'&&Array.isArray(piPlans)&&piPlans.length>0){
      piTabEl.classList.add('revealed');
    }
  }
  // Adoption Readiness tab (v9.22, real top-nav tab) — reveal once at
  // least one readinessPlan exists in the session, same content-truthiness
  // convention as tab-sc/tab-pi above (never un-reveal here; only Home's
  // reset flow un-reveals tabs, matching tab-sc/tab-pi's own precedent).
  const arpTabEl=document.getElementById('tab-arp');
  if(arpTabEl&&typeof piReadinessPlans!=='undefined'&&Array.isArray(piReadinessPlans)&&piReadinessPlans.length>0){
    arpTabEl.classList.add('revealed');
  }
  // Adoption Readiness gating (v9.21) — REPLACES the old "reveal once a
  // feature flag + Discovery Map + Feature Canvas content exist" trigger
  // entirely (that condition is retired, not layered under this one, per
  // ADOPTION_READINESS_SPEC.md §3.1). Outcome Pulse now only ever becomes
  // visible once the FIRST Adoption Readiness Plan in this session reaches
  // status:"finalized" (opUnlocked, a one-way session-level flag set by
  // readiness-canvas.js's rcFinalize()). Once true it stays visible for the
  // remainder of the session, regardless of any later reopen/un-finalize.
  const opTabEl=document.getElementById('tab-op');
  if(opTabEl){
    if(!(typeof opUnlocked!=='undefined'&&opUnlocked)){
      opTabEl.style.display='none';
      if(curTab==='op')switchTab('mm');
    } else {
      opTabEl.style.display='';
    }
  }
  // Requirement Agent redesign (Discovery-First Entry Point) — raEnabled now
  // only gates Discovery Map's "Define Requirements" CTA relabel/reroute
  // (kpi-tree.js's renderDiagnosticActionBar()); Capability Canvas no longer
  // reads raEnabled at all. Settings > Feature Modules remains the single,
  // immediate-effect control for the toggle, matching every other module
  // toggle's pattern; syncing it here on every settings save is what makes
  // it take effect without a reload.
  if(typeof raEnabled!=='undefined' && raEnabled!==featRA){
    raEnabled=featRA;
    if(typeof capActiveMetricKey!=='undefined'){
      if(capActiveMetricKey===null && typeof ccRenderAllCaps==='function') ccRenderAllCaps();
      else if(typeof ccRenderMainContent==='function') ccRenderMainContent();
    }
  }
}
function updateFeatLock(){
  // Retired in v6.75 — fly-out panel DOM IDs (feat-locked, feat-toggles) no longer exist.
  // Settings page handles key status inline. Shell kept to avoid errors from any call sites.
}
function togglePanel(){
  panelOpen=!panelOpen;
  document.getElementById('left-panel').classList.toggle('collapsed',!panelOpen);
  document.getElementById('icon-exp').style.display=panelOpen?'block':'none';
  document.getElementById('icon-col').style.display=panelOpen?'none':'block';
}

// ── Seg controls wiring ──
function initSegControls(){
  // Product Type segmented control
  const ptSeg=document.getElementById('seg-producttype');
  if(ptSeg){
    ptSeg.querySelectorAll('.seg-btn').forEach(btn=>{
      btn.addEventListener('click',function(){
        ptSeg.querySelectorAll('.seg-btn').forEach(b=>b.classList.remove('active'));
        this.classList.add('active');
        seg.productType=this.dataset.v;
      });
    });
  }
  // Industry Vertical dropdown
  const indSel=document.getElementById('f-industry');
  if(indSel){
    indSel.addEventListener('change',function(){
      seg.industry=this.value;
    });
    seg.industry=indSel.value||'Technology & Software';
  }
  // Additional Context character counter
  const ctxArea=document.getElementById('f-context');
  const ctxCounter=document.getElementById('f-context-counter');
  if(ctxArea&&ctxCounter){
    const MAX=2000;
    const WARN=1600;
    ctxArea.addEventListener('input',function(){
      const len=this.value.length;
      if(len>MAX){this.value=this.value.substring(0,MAX);return;}
      ctxCounter.textContent=len+'/'+MAX;
      ctxCounter.className='ctx-counter'+(len>=MAX?' ctx-counter-red':len>=WARN?' ctx-counter-amber':'');
    });
  }
  // Custom Value Chain character counter
  const vcArea=document.getElementById('f-custom-vc');
  const vcCounter=document.getElementById('f-vc-counter');
  if(vcArea&&vcCounter){
    const MAX=2000;
    const WARN=1600;
    vcArea.addEventListener('input',function(){
      const len=this.value.length;
      if(len>MAX){this.value=this.value.substring(0,MAX);return;}
      vcCounter.textContent=len+'/'+MAX;
      vcCounter.className='ctx-counter'+(len>=MAX?' ctx-counter-red':len>=WARN?' ctx-counter-amber':'');
    });
  }
}

