// ── NEW STORY CANVAS (v7.00) ──
// Reads from scCanvas[] (shared global store owned by FC / story-canvas.js)
// Manages: story grooming, DoR, dependencies, notes, PI selection, filter, Add Story
// scPiSelectedIds and scStoryIdCounter are global — declared in story-canvas.js

// ── State ──
let newScFilter={priority:[],readiness:[],piStatus:[],dependencies:null,briefRq:[],storyType:[]};
let newScCollapsedGroups=new Set();
let newScPanelStoryId=null;
let newScPanelFeatId=null;
let newScFilterOpen=false;
let newScActiveNavFeat=null; // null = All Stories, else feature id
let newScProtoView=false;    // true = Prototype view active
let newScNavCollapsed=false; // left nav collapsed state, persisted across newScRender() rebuilds

// ── Normalize active feature state ──
// Validates newScActiveNavFeat is still a visible SC feature.
// Resets both newScActiveNavFeat and newScProtoView if feature gone or has no visible stories.
function newScNormalizeActiveFeature(){
  if(!newScActiveNavFeat){newScProtoView=false;return;}
  const feat=typeof scCanvas!=='undefined'&&scCanvas.find(function(f){return f.id===newScActiveNavFeat;});
  if(!feat||!feat.stories||!feat.stories.some(function(s){return s._inSC&&!s._hiddenFromSC;})){
    newScActiveNavFeat=null;
    newScProtoView=false;
  }
}

// ── Entry point (called from api.js on t==='sc') ──
function newScRender(){
  const layout=document.getElementById('nsc-layout');
  if(!layout)return;
  // Check if any stories exist
  const hasStories=typeof scCanvas!=='undefined'&&scCanvas.some(f=>f.stories&&f.stories.some(s=>s._inSC&&!s._hiddenFromSC));
  if(!hasStories){
    // Reset proto state when no stories — clean slate
    newScActiveNavFeat=null;
    newScProtoView=false;
    newScRenderEmpty(layout);
    return;
  }
  // Item 4 fix — preserve scroll position across the full innerHTML
  // rebuild below, matching the identical pattern already proven in
  // capability-canvas.js's ccRenderMainContent() (.cc-cap-grid-wrap) and
  // kpi-tree.js's renderMM() (.stages), via the shared _uiCaptureScrollTop()/
  // _uiRestoreScrollTop() helpers (utils.js). Capture BEFORE rebuild.
  const _savedScrollTop=_uiCaptureScrollTop('nsc-scroll');
  // Item 4 code-review fix — capture the active-feature scope BEFORE
  // normalizing, so a restore is skipped if normalization actually changes
  // it (e.g. the last visible story of the active feature just got removed,
  // dropping the view out to "All Stories"). The saved scrollTop belongs to
  // whatever list was on screen before the rebuild — restoring it into a
  // different, differently-ordered list lands the PM at an arbitrary
  // position instead of the top of genuinely new content.
  const _navFeatBeforeNormalize=newScActiveNavFeat;
  // Normalize active feature before building layout
  newScNormalizeActiveFeature();
  const _scopeChanged=(newScActiveNavFeat!==_navFeatBeforeNormalize);
  layout.innerHTML=newScBuildLayout();
  newScRenderLeftNav();
  newScRenderMain();
  newScUpdateActionBar();
  newScUpdateTabBadge();
  // Restore AFTER rebuild, clamped (inside the helper) against the new
  // content's scrollHeight in case the list is now shorter than before.
  if(!_scopeChanged)_uiRestoreScrollTop('nsc-scroll',_savedScrollTop);
  // Re-open panel if previously open (only in stories view)
  if(!newScProtoView&&newScPanelStoryId&&newScPanelFeatId){
    const feat=scCanvas.find(f=>f.id===newScPanelFeatId);
    const st=feat&&feat.stories&&feat.stories.find(s=>s.id===newScPanelStoryId);
    if(st&&feat)newScOpenPanel(st,feat);
  }
}

function newScClear(){
  newScFilter={priority:[],readiness:[],piStatus:[],dependencies:null,storyType:[]};
  newScCollapsedGroups=new Set();
  newScPanelStoryId=null;
  newScPanelFeatId=null;
  newScFilterOpen=false;
  newScActiveNavFeat=null;
  newScProtoView=false;
  const layout=document.getElementById('nsc-layout');
  if(layout)layout.innerHTML='';
}

function newScRenderEmpty(layout){
  layout.innerHTML=`<div class="nsc-empty">
    <div class="nsc-empty-icon"><i class="ti ti-list-details" aria-hidden="true"></i></div>
    <div class="nsc-empty-title">Story Canvas is empty</div>
    <div class="nsc-empty-desc">Generate stories in Feature Canvas first, then come back here to groom them for PI.</div>
    <button class="nsc-empty-cta" onclick="switchTab('fc')"><i class="ti ti-arrow-left" style="font-size:11px;" aria-hidden="true"></i> Go to Feature Canvas</button>
  </div>`;
}

function newScBuildLayout(){
  const pcAvail=typeof pcRenderView==='function';
  const showToggle=!!(newScActiveNavFeat&&pcAvail);
  const isProto=!!(newScProtoView&&showToggle);
  const pcModeClass=isProto?' pc-mode':'';
  return `<div class="nsc-body">
    <div class="nsc-left${newScNavCollapsed?' collapsed':''}" id="nsc-left">
      <div class="nsc-left-hdr">
        <div class="nsc-left-hdr-inner">
          <div class="nsc-left-title">Story Canvas</div>
          <div class="nsc-left-sub">Groom and select stories for PI</div>
        </div>
        <button class="sc-cap-nav-collapse" id="nsc-collapse-btn" onclick="newScToggleNav()" title="${newScNavCollapsed?'Expand':'Collapse'}" style="color:var(--t3);">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${newScNavCollapsed
            ?'<polyline points="9 18 15 12 9 6"/><polyline points="3 18 9 12 3 6"/>'
            :'<polyline points="15 18 9 12 15 6"/><polyline points="21 18 15 12 21 6"/>'}</svg>
        </button>
      </div>
      <div id="nsc-nav-tree"></div>
    </div>
    <div class="nsc-main-wrap${pcModeClass}">
      <div class="nsc-main" id="nsc-main">
        <div class="nsc-fixed-hdr">
          <div id="nsc-toolbar" class="nsc-toolbar">
            <div class="nsc-toolbar-l">
              <span class="cc-canvas-title">Story Canvas</span>
              <span class="sc-count-badge" id="nsc-story-count-badge">0 stories</span>
              <div id="nsc-filter-badge" style="display:none;font-size:9px;font-weight:700;background:var(--card-purple);color:var(--purple);border:1px solid #CECBF6;border-radius:10px;padding:2px 8px;align-items:center;gap:5px;">
                <i class="ti ti-filter" style="font-size:9px;" aria-hidden="true"></i>
                <span id="nsc-filter-badge-label"></span>
                <span onclick="newScClearFilters()" style="cursor:pointer;color:var(--t3);margin-left:2px;" title="Clear filters">&#x2715;</span>
              </div>
            </div>
            <div class="nsc-toolbar-r">
              ${showToggle?`<div class="nsc-view-toggle">
                <button class="nsc-view-btn${!isProto?' active':''}" onclick="newScSetProtoView(false)" title="Stories view"><i class="ti ti-list-details" style="font-size:10px;" aria-hidden="true"></i> Stories</button>
                <button class="nsc-view-btn${isProto?' active':''}" onclick="newScSetProtoView(true)" title="Prototype view"><i class="ti ti-layout-board" style="font-size:10px;" aria-hidden="true"></i> Prototype</button>
              </div>`:''}
              ${!isProto?`<div style="position:relative;">
                <button class="cc-tb-btn" id="nsc-filter-btn" onclick="newScToggleFilter(event)"><i class="ti ti-filter" style="font-size:10px;" aria-hidden="true"></i> Filter <i class="ti ti-chevron-down" style="font-size:10px;" aria-hidden="true"></i></button>
                <div class="cc-export-drop" id="nsc-filter-drop">
                  ${newScBuildFilterPanel()}
                </div>
              </div>
              ${_newScBriefFilterBtnHtml()}
              <button class="tm-dots" id="nsc-toolbar-kebab" onclick="event.stopPropagation();newScToggleToolbarMenu(this)" aria-label="Story Canvas actions" aria-haspopup="true" aria-expanded="false"><i class="ti ti-dots-vertical" aria-hidden="true"></i></button>`
              :`<button class="export-cta-btn" id="nsc-proto-export-btn" onclick="pcAvailCall('pcExportPrototype','${newScActiveNavFeat||''}')" ${!(typeof protoStore!=='undefined'&&protoStore[newScActiveNavFeat]&&protoStore[newScActiveNavFeat].variants&&protoStore[newScActiveNavFeat].variants['v1']&&protoStore[newScActiveNavFeat].variants['v1'].generated)?'disabled':''}><i class="ti ti-download" style="font-size:11px;" aria-hidden="true"></i> Export Prototype</button>`}
            </div>
          </div>
          <div class="sc-legend" style="margin-bottom:4px;${isProto?'display:none;':''}">
            <span class="sc-legend-lbl">Card states</span>
            <div class="sc-legend-item"><div class="sc-legend-bar" style="border-left:3px solid var(--label);background:#fff;border-radius:0 2px 2px 0;"></div> Not selected</div>
            <div class="sc-legend-item"><div class="sc-legend-bar" style="border-left:3px solid var(--purple);background:var(--purple-pale);border-radius:0 2px 2px 0;"></div> Release Selected</div>
            <div class="sc-legend-item"><div class="sc-legend-bar" style="border-left:3px solid var(--green);background:#fff;border-radius:0 2px 2px 0;"></div> DoR ready</div>
            <div class="sc-legend-item"><div class="sc-legend-bar" style="border-left:3px solid var(--green);background:#E8F5F0;border-radius:0 2px 2px 0;border-top:3px solid var(--green);"></div> In Release Plan</div>
          </div>
        </div>
        <div class="nsc-scroll" id="nsc-scroll" style="${isProto?'display:none;':''}">
          <div id="nsc-cards-container"></div>
        </div>
        <div class="sc-action-bar" id="nsc-action-bar" style="${isProto?'display:none;':''}">
          <div class="sc-action-left">
            <label class="sc-select-all-toggle" id="nsc-select-all-wrap">
              <input type="checkbox" id="nsc-select-all-chk" onchange="newScToggleSelectAll(this)" title="Select / deselect all">
              <span id="nsc-select-all-lbl">Select all</span>
            </label>
            <span class="sc-action-count" id="nsc-action-info"></span>
          </div>
          <div class="sc-action-btns">
            <button class="sc-gen-btn" id="nsc-send-pi-btn" onclick="newScSendToPI()" disabled><i class="ti ti-calendar-event" style="font-size:12px;" aria-hidden="true"></i> <span id="nsc-send-pi-label">Send to Release</span></button>
          </div>
        </div>
        <div class="pc-view${isProto?' on':''}" id="pc-view">
          <div class="pc-scroll" id="pc-scroll"></div>
          <div class="pc-refine-bar" id="pc-refine-bar"></div>
        </div>
      </div>
      <div class="sc-panel" id="nsc-panel">
        <div class="sc-panel-hdr" id="nsc-panel-hdr">
          <div class="sc-panel-tag">Story</div>
          <div class="sc-panel-feat" id="nsc-panel-title"></div>
          <button class="sc-panel-close" onclick="newScClosePanel()">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="sc-panel-scroll" id="nsc-panel-scroll">
          <div id="nsc-panel-content" style="padding:14px 16px;"></div>
        </div>
        <div class="sc-panel-footer" style="padding:10px 14px;border-top:1px solid var(--divider);background:var(--card);" id="nsc-panel-footer">
          <div id="nsc-remove-confirm" style="display:none;margin-bottom:8px;background:#FCEBEB;border:1px solid #F09595;border-radius:6px;padding:8px 10px;">
            <div style="font-size:10px;font-weight:600;color:#791F1F;margin-bottom:6px;">Remove this story from the canvas?</div>
            <div style="display:flex;gap:6px;">
              <button onclick="newScHideRemoveConfirm()" style="flex:1;font-size:10px;color:var(--t2);background:none;border:1px solid var(--divider);border-radius:5px;padding:5px 0;cursor:pointer;font-family:var(--font);">Cancel</button>
              <button id="nsc-remove-confirm-yes" style="flex:1;font-size:10px;font-weight:700;color:#fff;background:#A32D2D;border:none;border-radius:5px;padding:5px 0;cursor:pointer;font-family:var(--font);">Yes, Remove</button>
            </div>
          </div>
          <button id="nsc-remove-btn" onclick="newScShowRemoveConfirm()" style="font-size:11px;color:var(--red);background:none;border:1px solid var(--red);border-radius:5px;padding:5px 12px;cursor:pointer;font-family:var(--font);width:100%;">
            <i class="ti ti-trash" style="font-size:10px;" aria-hidden="true"></i> Remove story from canvas
          </button>
        </div>
      </div>
    </div>
  </div>`;
}

// ── pcAvailCall — safe cross-file call guard ──
function pcAvailCall(fn,arg){
  if(typeof window[fn]==='function')window[fn](arg);
}

// ── View toggle ──
function newScSetProtoView(on){
  // v9.25 — belt-and-suspenders alongside pcRenderView()'s own guard:
  // TURNING PROTO VIEW OFF doesn't necessarily call pcRenderView() again
  // (newScRenderMain() takes the non-proto branch instead once
  // newScProtoView is false), so that guard alone wouldn't catch this
  // specific transition. voiceStopActive() is a safe no-op either way.
  voiceStopActive('abort');
  newScProtoView=!!on;
  if(!newScActiveNavFeat)newScProtoView=false;
  if(newScProtoView&&typeof newScClosePanel==='function')newScClosePanel();
  newScRender();
}

// ── Nav feat setter — resets proto view on nav change (v1 behaviour) ──
function newScSetNavFeat(featId){
  // v9.25 — switching to a different feature while #pc-ctx-input is being
  // dictated into would otherwise misattribute that feature's dictated
  // context to the NEW feature (same shape of gap found in Feature
  // Canvas's scOpenPanel() — a context change, not a DOM destroy, on a
  // surface keyed by featId rather than a per-instance textarea).
  voiceStopActive('abort');
  newScActiveNavFeat=featId;
  newScProtoView=false;
  newScRender();
}

function newScBuildFilterPanel(){
  return `<div style="padding:8px 12px 4px;font-size:9px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--label);">Priority</div>
    ${['Must Have','Should Have','Could Have','Won\'t Have'].map(p=>`<label class="fc-filter-row"><input type="checkbox" onchange="newScToggleFilter_v('priority','${e(p)}')" ${newScFilter.priority.includes(p)?'checked':''}> ${p}</label>`).join('')}
    <div style="border-top:1px solid var(--divider);margin:4px 0;"></div>
    <div style="padding:6px 12px 4px;font-size:9px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--label);">Story Type</div>
    ${[{label:'Traditional',value:'traditional'},{label:'AI Feature',value:'ai_feature'},{label:'Agentic',value:'agentic'}].map(t=>`<label class="fc-filter-row"><input type="checkbox" onchange="newScToggleFilter_v('storyType','${t.value}')" ${newScFilter.storyType.includes(t.value)?'checked':''}> ${t.label}</label>`).join('')}
    <div style="border-top:1px solid var(--divider);margin:4px 0;"></div>
    <div style="padding:6px 12px 4px;font-size:9px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--label);">Readiness</div>
    ${['Ready','Not Ready','Points not set'].map(r=>`<label class="fc-filter-row"><input type="checkbox" onchange="newScToggleFilter_v('readiness','${e(r)}')" ${newScFilter.readiness.includes(r)?'checked':''}> ${r}</label>`).join('')}
    <div style="border-top:1px solid var(--divider);margin:4px 0;"></div>
    <div style="padding:6px 12px 4px;font-size:9px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--label);">Release Status</div>
    ${['Release Selected','Not Selected'].map(s=>`<label class="fc-filter-row"><input type="checkbox" onchange="newScToggleFilter_v('piStatus','${e(s)}')" ${newScFilter.piStatus.includes(s)?'checked':''}> ${s}</label>`).join('')}
    <div style="border-top:1px solid var(--divider);margin:4px 0;"></div>
    <div style="padding:6px 12px 4px;font-size:9px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--label);">Dependencies</div>
    ${['Yes','No'].map(d=>`<label class="fc-filter-row"><input type="checkbox" onchange="newScToggleFilter_v('dependencies','${e(d)}')" ${newScFilter.dependencies===d?'checked':''}> ${d}</label>`).join('')}
    <div style="border-top:1px solid var(--divider);margin:4px 4px 4px;"></div>
    <div style="padding:4px 12px 8px;"><button onclick="newScClearFilters()" style="font-size:10px;color:var(--purple);background:none;border:none;cursor:pointer;font-family:var(--font);padding:0;">Clear all filters</button></div>`;
}

// §9.2 — standalone "Brief" filter (flat list of finalized RQs, no Origin
// wrapper/nesting) — Story Canvas has no pre-existing Origin filter to nest
// a "Requirement Agent" value under. Its own toolbar button + popover, NOT
// folded into the "Filter" dropdown above — matches PI Canvas's §9.3
// pattern exactly (confirmed gap: an earlier pass nested this inside
// newScBuildFilterPanel(), which was inconsistent with PI's separate
// button and with the approved prototype). Filters read the story's
// PARENT FEATURE's intakeBriefId (no new field on story objects, §5.3).
function _newScBriefFilterBtnHtml(){
  const convs=(typeof raConversations!=='undefined'?raConversations:[]).filter(function(c){return c.status==='finalized';});
  if(!convs.length)return'';
  return `<div style="position:relative;">
    <button class="cc-tb-btn${newScFilter.briefRq.length>0?' active':''}" id="nsc-brief-filter-btn" onclick="newScToggleBriefFilterDrop(event)"><i class="ti ti-filter" style="font-size:10px;" aria-hidden="true"></i> Brief <i class="ti ti-chevron-down" style="font-size:10px;" aria-hidden="true"></i></button>
    <div class="cc-export-drop" id="nsc-brief-filter-drop">
      <div style="padding:8px 12px 4px;font-size:9px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--label);">Requirement Briefs</div>
      ${convs.map(function(c){
        const cnt=(typeof scCanvas!=='undefined'?scCanvas.filter(f=>f.intakeBriefId===c.id).reduce((a,f)=>a+(f.stories?f.stories.filter(s=>s._inSC&&!s._hiddenFromSC).length:0),0):0);
        const checked=newScFilter.briefRq.includes(c.id);
        return `<label class="fc-filter-row"><input type="checkbox" onchange="newScToggleFilter_v('briefRq','${e(c.id)}');newScUpdateBriefFilterBtn();" ${checked?'checked':''}> ${e(c.rqNumber||'')} &mdash; ${e(c.title||'Untitled')} <span style="margin-left:auto;font-size:9px;color:var(--t3);">${cnt}</span></label>`;
      }).join('')}
      <div style="border-top:1px solid var(--divider);margin:4px 0;"></div>
      <div style="padding:4px 12px 8px;"><button onclick="newScClearBriefFilter()" style="font-size:10px;color:var(--purple);background:none;border:none;cursor:pointer;font-family:var(--font);padding:0;">Clear all filters</button></div>
    </div>
  </div>`;
}
function newScToggleBriefFilterDrop(evt){
  if(evt)evt.stopPropagation();
  const drop=document.getElementById('nsc-brief-filter-drop');
  if(!drop)return;
  const isOpen=drop.classList.contains('open');
  if(isOpen){
    drop.classList.remove('open');
    document.removeEventListener('mousedown',_newScBriefFilterDropOutside);
  } else {
    drop.classList.add('open');
    setTimeout(()=>document.addEventListener('mousedown',_newScBriefFilterDropOutside),0);
  }
}
function _newScBriefFilterDropOutside(ev){
  const drop=document.getElementById('nsc-brief-filter-drop');
  if(!drop){document.removeEventListener('mousedown',_newScBriefFilterDropOutside);return;}
  if(!drop.contains(ev.target)){
    drop.classList.remove('open');
    document.removeEventListener('mousedown',_newScBriefFilterDropOutside);
  }
}
function newScUpdateBriefFilterBtn(){
  const btn=document.getElementById('nsc-brief-filter-btn');
  if(btn)btn.classList.toggle('active',newScFilter.briefRq.length>0);
}
function newScClearBriefFilter(){
  newScFilter.briefRq=[];
  const drop=document.getElementById('nsc-brief-filter-drop');
  if(drop)drop.querySelectorAll('input[type=checkbox]').forEach(cb=>cb.checked=false);
  newScUpdateBriefFilterBtn();
  newScUpdateFilterBadge();
  newScRenderMain();
}

// ── Left nav ──
function newScRenderLeftNav(){
  const tree=document.getElementById('nsc-nav-tree');
  if(!tree)return;
  if(!scCanvas||!scCanvas.length){tree.innerHTML='';return;}
  const stageColorMap={};
  if(gData&&gData.stages)gData.stages.forEach((s,i)=>{stageColorMap[s.label]=STAGE_PALETTE[i%STAGE_PALETTE.length];});
  let h='';
  // All Stories item
  const allActive=newScActiveNavFeat===null;
  const totalStories=scCanvas.reduce((a,f)=>a+(f.stories?f.stories.filter(s=>s._inSC&&!s._hiddenFromSC).length:0),0);
  h+=`<div class="sc-nav-all${allActive?' active':''}" onclick="newScSetNavFeat(null)">
    <i class="ti ti-layout-grid" style="font-size:12px;" aria-hidden="true"></i>
    <span class="sc-nav-all-text">All Stories</span>
    <span class="sc-nav-count${allActive?' active':''}">${totalStories}</span>
  </div>`;
  // Build Stage → Metric → Cap → Feature hierarchy (mirrors fcRenderCapNav)
  const stageOrder=gData?gData.stages.map(s=>s.label):[];
  const treeData={};
  // v9.06.02: removed the hardcoded 'Custom Capabilities' generic grouping
  // key — mirrors the identical fix in feature-canvas.js. Groups by
  // f.metric directly now, so distinct custom buckets stay visually
  // separate instead of collapsing into one undifferentiated group.
  scCanvas.forEach(f=>{
    if(!f.stories||!f.stories.some(s=>s._inSC&&!s._hiddenFromSC))return;
    const st=f.stage||'Other';
    const mt=f.metric||'Unknown';
    const cp=f.cap||'Uncategorised';
    if(!treeData[st])treeData[st]={metrics:{}};
    if(!treeData[st].metrics[mt])treeData[st].metrics[mt]={caps:{}};
    if(!treeData[st].metrics[mt].caps[cp])treeData[st].metrics[mt].caps[cp]=[];
    treeData[st].metrics[mt].caps[cp].push(f);
  });
  const orderedStages=[...stageOrder.filter(s=>treeData[s]),...Object.keys(treeData).filter(s=>!stageOrder.includes(s))];
  orderedStages.forEach(stage=>{
    const sg=treeData[stage];
    if(!sg)return;
    const color=stageColorMap[stage]||'var(--label)';
    // v9.01.01 fix: same display-only transformation as FC's identical
    // pattern -- internal 'stage' value stays untouched.
    const _dispStage=stage==='PI Plan'?'Custom Value Stage':stage;
    h+=`<div class="sc-nav-stage"><div class="sc-nav-stage-bar" style="background:${color}"></div><span class="sc-nav-stage-lbl" style="color:${color}">${e(_dispStage)}</span></div>`;
    Object.entries(sg.metrics).forEach(([metric,md])=>{
      // v9.06.02: removed the "Custom Capabilities" -> mode-aware-term
      // display transformation, mirrors FC's identical fix — metric is
      // already correct as-is (getOrCreateCurrentDefaultPiBucket() stores
      // the mode-aware default name directly at creation time).
      h+=`<div class="sc-nav-metric"><span class="sc-nav-metric-name">${e(metric)}</span></div>`;
      Object.entries(md.caps).forEach(([cap,feats])=>{
        // Cap label — structural, not clickable (matches FC pattern)
        h+=`<div class="sc-nav-cap" style="cursor:default;opacity:0.8;">
          <div class="sc-nav-cap-track"><div class="sc-nav-cap-node"></div></div>
          <div class="sc-nav-cap-body"><span class="sc-nav-cap-name" style="font-style:italic;color:var(--t3);font-size:10px;">${e(cap)}</span></div>
        </div>`;
        feats.forEach(f=>{
          const isActive=newScActiveNavFeat===f.id;
          const cnt=f.stories?f.stories.filter(s=>s._inSC&&!s._hiddenFromSC).length:0;
          h+=`<div class="sc-nav-cap${isActive?' active':''}" onclick="newScSetNavFeat('${e(f.id)}')" style="padding-left:14px;">
            <div class="sc-nav-cap-track"><div class="sc-nav-cap-node${isActive?' active':''}"></div></div>
            <div class="sc-nav-cap-body">
              <span class="sc-nav-cap-name">${e(f.name)}</span>
              <span class="sc-nav-count${isActive?' active':''}">${cnt}</span>
            </div>
          </div>`;
        });
      });
    });
  });
  tree.innerHTML=h;
}

function newScToggleNav(){
  const nav=document.getElementById('nsc-left');
  if(!nav)return;
  const isCol=newScNavCollapsed=nav.classList.toggle('collapsed');
  const btn=document.getElementById('nsc-collapse-btn');
  if(btn){
    btn.title=isCol?'Expand':'Collapse';
    btn.innerHTML=isCol
      ?'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/><polyline points="3 18 9 12 3 6"/></svg>'
      :'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/><polyline points="21 18 15 12 21 6"/></svg>';
  }
}

// ── Main panel ──
function newScRenderMain(){
  // Route to prototype view if active
  if(newScProtoView&&newScActiveNavFeat&&typeof pcRenderView==='function'){
    // Update story count badge to match active feature before routing
    const _pf=typeof scCanvas!=='undefined'&&scCanvas.find(function(f){return f.id===newScActiveNavFeat;});
    const _pc=_pf&&_pf.stories?_pf.stories.filter(function(s){return s._inSC&&!s._hiddenFromSC;}).length:0;
    const _pb=document.getElementById('nsc-story-count-badge');
    if(_pb)_pb.textContent=_pc+' stor'+(_pc!==1?'ies':'y');
    pcRenderView(newScActiveNavFeat);
    return;
  }
  const container=document.getElementById('nsc-cards-container');
  if(!container)return;
  const stageColorMap={};
  if(gData&&gData.stages)gData.stages.forEach((s,i)=>{stageColorMap[s.label]=STAGE_PALETTE[i%STAGE_PALETTE.length];});

  // Get visible features and their visible stories — single shared source,
  // same function the action bar and Select All / Clear All now use.
  const visibleEntries=newScGetVisibleFeaturesAndStories();

  // Build story list per feature, apply story filters
  let totalVisible=0;
  let h='';
  visibleEntries.forEach(({feat:f,stories})=>{
    if(stories.length===0)return;
    totalVisible+=stories.length;
    const color=stageColorMap[f.stage]||'var(--label)';
    const isCollapsed=newScCollapsedGroups.has(f.id);
    // Feature group header
    h+=`<div class="nsc-group-hdr" style="border-left:3px solid ${color};" id="nsc-grp-${e(f.id)}">
      <span class="nsc-stage-pill" style="background:${color};">${e(f.stage||'')}</span>
      <span class="nsc-breadcrumb">${e(f.cap||'')} <span style="color:var(--label);">›</span> <strong>${e(f.name)}</strong></span>
      <span class="sc-nav-count" style="margin-left:auto;">${stories.length} stor${stories.length!==1?'ies':'y'}</span>
      <button class="nsc-chevron" onclick="newScToggleGroup('${e(f.id)}')" title="${isCollapsed?'Expand':'Collapse'}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          ${isCollapsed?'<polyline points="9 18 15 12 9 6"/>':'<polyline points="18 15 12 9 6 15"/>'}
        </svg>
      </button>
    </div>`;
    if(isCollapsed){
      h+=`<div class="nsc-collapsed-hint">Stories hidden — click ▶ to expand</div>`;
    } else {
      h+=`<div class="nsc-story-grid">`;
      // Sort by story ID ascending
      const sorted=[...stories].sort((a,b)=>a.id.localeCompare(b.id));
      sorted.forEach(st=>{
        h+=newScBuildStoryCard(st,f,color);
      });
      h+=`</div>`;
    }
  });

  if(totalVisible===0){
    container.innerHTML=`<div style="padding:48px 24px;text-align:center;color:var(--t3);">
      <div style="font-size:13px;font-weight:600;color:var(--t2);margin-bottom:8px;">No stories match the current filter</div>
      <div style="font-size:11px;margin-bottom:12px;">Try clearing the filter to see all stories.</div>
      <button onclick="newScClearFilters()" style="background:none;border:1px solid var(--divider);border-radius:5px;padding:5px 12px;font-size:11px;cursor:pointer;color:var(--t2);">Clear all filters</button>
    </div>`;
  } else {
    container.innerHTML=h;
  }

  // Update story count badge
  const total=scCanvas.reduce((a,f)=>a+(f.stories?f.stories.filter(s=>s._inSC&&!s._hiddenFromSC).length:0),0);
  const badge=document.getElementById('nsc-story-count-badge');
  if(badge){
    badge.textContent=total+' stor'+(total!==1?'ies':'y')+(totalVisible<total?` · showing ${totalVisible}`:'');
  }

  // Update filter badge
  newScUpdateFilterBadge();

  // Update action bar
  newScUpdateActionBar();

  // Export button state
  const expBtn=document.getElementById('nsc-export-btn');
  if(expBtn)expBtn.disabled=totalVisible===0;
  const expSub=document.getElementById('nsc-export-all-sub');
  if(expSub)expSub.textContent=total+' stor'+(total!==1?'ies':'y')+' total';
  const piSub=document.getElementById('nsc-export-pi-sub');
  const piCount=Array.from(scPiSelectedIds||new Set()).reduce((a,fid)=>{
    const f=scCanvas.find(x=>x.id===fid);
    return a+(f&&f.stories?f.stories.filter(s=>s._stagedForPI).length:0);
  },0);
  if(piSub)piSub.textContent=piCount>0?piCount+' Release Selected':'Select Stories for Release First';
}

// Toolbar kebab menu - replaces the old standalone Add Story + Export
// buttons. Uses the generic _uiRowMenuToggle(triggerEl, menuHtml) helper
// already used by Outcome Pulse / Home / Team Management / PI Planning.
// Story Canvas has no bulk-upload path for stories, so unlike Capability
// Canvas / Feature Canvas this menu is flat - no submenu, no chevron.
function newScToggleToolbarMenu(triggerEl){
  const canEdit=(typeof canEditSession!=='function')||canEditSession();
  const addItem=canEdit?'<div class="tm-menu-item" role="menuitem" tabindex="-1" onclick="_uiRowMenuClose();newScShowAddStoryModal(null)"><i class="ti ti-plus" aria-hidden="true"></i> Add Story</div>':'';
  const menuHtml='<div class="tm-menu-static" role="menu">'
    +addItem
    +'<div class="tm-menu-item" role="menuitem" tabindex="-1" onclick="_uiRowMenuClose();newScExportAll()"><i class="ti ti-download" aria-hidden="true"></i> Export</div>'
    +'</div>';
  _uiRowMenuToggle(triggerEl,menuHtml);
}

// Finds the single release plan (out of the global piPlans array) that owns
// this story's sprint assignment, if any. Story Canvas has zero plan-
// awareness beyond this lookup - a story belongs to exactly one plan's
// storyAssignments at a time, never dual-tagged.
function scFindOwningPlan(storyId){
  return (typeof piPlans!=='undefined'&&Array.isArray(piPlans)) ? (piPlans.find(function(p){ return p.storyAssignments && p.storyAssignments[storyId]; }) || null) : null;
}

function newScBuildStoryCard(st,feat,stageColor){
  const isActive=newScPanelStoryId===st.id&&newScPanelFeatId===feat.id;
  const isPiSel=!!st._stagedForPI;
  const isInPIPlan=!!st._inPIPlan;
  const hasDeps=st.dependencies&&st.dependencies.length>0;
  // Check if story is assigned to a sprint in its owning release plan
  const _owningPlan=scFindOwningPlan(st.id);
  const sprintAssignment=_owningPlan&&_owningPlan.storyAssignments[st.id];
  const sprintLabel=sprintAssignment?('Sprint '+(sprintAssignment.sprint||'?')):null;
  const piPlanName=_owningPlan?_owningPlan.name:'In Release Plan';

  let cls='nsc-story-card sc-card';
  if(isInPIPlan||sprintLabel)cls+=' nsc-pi-planned';
  else if(isPiSel)cls+=' nsc-pi-sel';
  if(st.dor==='READY')cls+=' nsc-dor-ready';
  else if(st.dor==='BLOCKED')cls+=' nsc-dor-blocked';
  if(isActive)cls+=' sc-card-active';

  const priorityColors={'Must Have':'#FCEBEB','Should Have':'#FFF4D7','Could Have':'#F4F6FA','Won\'t Have':'#F4F6FA'};
  const priorityText={'Must Have':'#791F1F','Should Have':'#633806','Could Have':'#6b6b68','Won\'t Have':'#A5AFBE'};
  const priColor=priorityColors[st.priority]||'#F4F6FA';
  const priText=priorityText[st.priority]||'#6b6b68';

  let ptsLabel=st.points?st.points+' pts':'— pts';
  let dorLabel=st.dor==='READY'?'<span class="sc-story-dor-ok">Ready</span>':'<span class="sc-story-dor-no">Needs review</span>';
  // v9.08: computed once per card render.
  const _canEditScCard=(typeof canEditSession!=='function')||canEditSession();

  return `<div class="${cls}" onclick="newScOpenPanel(${JSON.stringify({id:st.id}).replace(/"/g,"'")},${JSON.stringify({id:feat.id}).replace(/"/g,"'")})" id="nsc-story-${e(st.id)}" style="cursor:pointer;position:relative;">
    ${(isInPIPlan||sprintLabel)?`<div style="position:absolute;top:0;left:0;right:0;height:3px;background:var(--green);border-radius:0 6px 0 0;"></div>`:''}    
    <div class="sc-card-top">
      <span class="sc-story-id" style="letter-spacing:0.5px;">${e(st.id)}</span>
      <div class="sc-card-actions">
        ${_canEditScCard?`<button class="sc-card-pencil" onclick="event.stopPropagation();newScShowEditStoryModal('${e(st.id)}','${e(feat.id)}')" title="Edit story" aria-label="Edit story" style="background:none;border:none;cursor:pointer;padding:2px;color:var(--t3);display:flex;align-items:center;"><i class="ti ti-pencil" style="font-size:10px;" aria-hidden="true"></i></button>`:''}
        ${isInPIPlan
          ?`<div class="nsc-pi-tag" title="${e(piPlanName)}"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> ${e(piPlanName)} ${_canEditScCard?`<span class="nsc-pi-tag-x" onclick="event.stopPropagation();newScConfirmRemoveFromPI('${e(st.id)}','${e(feat.id)}')" title="Remove from Release">&#x2715;</span>`:''}</div>`
          :(_canEditScCard?`<div class="sc-card-check${isPiSel?' sc-card-check-pi':''}" onclick="event.stopPropagation();newScToggleStoryPiSelect('${e(st.id)}','${e(feat.id)}')" title="${isPiSel?'Deselect for Release':'Select for Release'}">${isPiSel?'<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>':''}</div>`:'')
        }
        ${_canEditScCard?`<button class="sc-card-remove" onclick="event.stopPropagation();newScDeleteStoryById('${e(st.id)}','${e(feat.id)}')" title="Remove story">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>`:''}
      </div>
    </div>
    <div class="sc-card-name" style="margin:4px 0 3px;">${e(st.title)}</div>
    <div class="sc-card-footer">
      <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
        ${scStoryTypeBadge(st.storyType)}
        ${st.priority?`<span style="font-size:7.5px;font-weight:700;background:${priColor};color:${priText};border-radius:3px;padding:1px 5px;">${e(st.priority)}</span>`:''}
        <span style="font-size:8.5px;font-weight:600;color:var(--t3);">${ptsLabel}</span>
        ${dorLabel}
        ${hasDeps?`<span style="font-size:8px;color:var(--purple);font-weight:600;"><i class="ti ti-link" style="font-size:8px;" aria-hidden="true"></i></span>`:''}
        ${sprintLabel?`<span style="font-size:7.5px;font-weight:700;background:#FFF8EC;color:#633806;border:1px solid #FAC775;border-radius:3px;padding:1px 5px;"><i class="ti ti-calendar-event" style="font-size:7px;" aria-hidden="true"></i> ${e(sprintLabel)}</span>`:''}
      </div>
    </div>
  </div>`;
}

// ── Group collapse ──
function newScToggleGroup(featId){
  if(newScCollapsedGroups.has(featId))newScCollapsedGroups.delete(featId);
  else newScCollapsedGroups.add(featId);
  newScRenderMain();
}

// ── PI selection ──
function newScToggleStoryPiSelect(storyId,featId){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const feat=scCanvas.find(f=>f.id===featId);
  if(!feat||!feat.stories)return;
  const st=feat.stories.find(s=>s.id===storyId);
  if(!st)return;
  st._stagedForPI=!st._stagedForPI;
  // Rebuild scPiSelectedIds from story-level flags
  if(typeof scPiSelectedIds!=='undefined'){
    scPiSelectedIds=new Set();
    scCanvas.forEach(f=>{if(f.stories&&f.stories.some(s=>s._stagedForPI))scPiSelectedIds.add(f.id);});
  }
  newScRenderMain();
  // If panel is open for this story, refresh it
  if(newScPanelStoryId===storyId&&newScPanelFeatId===featId){
    const updatedFeat=scCanvas.find(f=>f.id===featId);
    const updatedSt=updatedFeat&&updatedFeat.stories&&updatedFeat.stories.find(s=>s.id===storyId);
    if(updatedSt&&updatedFeat)newScOpenPanel(updatedSt,updatedFeat);
  }
  if(typeof piCheckStaleness==='function')piCheckStaleness();
  // v8.146 fix: confirmed missing entirely. PI-staging state only — no
  // live-edit mark, same convention as newScConfirmRemoveFromPI above.
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId)sessionStoreSave(_activeSessionId);
}

function newScClearAllPiSelection(){
  newScGetAllVisibleStories().forEach(s=>{s._stagedForPI=false;});
  // Rebuild from whatever remains staged elsewhere — NOT a blanket empty Set,
  // since stories outside the active filter may still be legitimately staged.
  if(typeof scPiSelectedIds!=='undefined'){
    scPiSelectedIds=new Set();
    scCanvas.forEach(f=>{if(f.stories&&f.stories.some(s=>s._stagedForPI))scPiSelectedIds.add(f.id);});
  }
  newScRenderMain();
  // v8.146 fix: confirmed missing entirely. PI-staging state only — no
  // live-edit mark, same convention as the two functions above.
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId)sessionStoreSave(_activeSessionId);
}

// ── Action bar ──
function newScUpdateActionBar(){
  const bar=document.getElementById('nsc-action-bar');
  if(!bar)return;
  // v9.08: matches ccUpdateActionBar's pattern — this bar exists only to
  // stage/send stories to PI, nothing a view-only session can do.
  const _canEditScBar=(typeof canEditSession!=='function')||canEditSession();
  bar.style.display=_canEditScBar?'':'none';
  if(!_canEditScBar)return;
  const visibleStories=newScGetAllVisibleStories();
  const totalStories=visibleStories.length;
  const piCount=visibleStories.filter(s=>s._stagedForPI).length;
  const piPts=visibleStories.filter(s=>s._stagedForPI).reduce((p,s)=>p+(s.points||3),0);

  // Select All toggle state
  const chk=document.getElementById('nsc-select-all-chk');
  const lbl=document.getElementById('nsc-select-all-lbl');
  if(chk){
    chk.checked=totalStories>0&&piCount===totalStories;
    chk.indeterminate=piCount>0&&piCount<totalStories;
  }
  if(lbl)lbl.textContent=piCount===totalStories&&totalStories>0?'Deselect all':'Select all';

  // Info count
  const info=document.getElementById('nsc-action-info');
  if(info){
    if(piCount>0)info.innerHTML=`<strong>${piCount}</strong> stor${piCount!==1?'ies':'y'} selected &middot; ~<strong>${piPts}</strong> pts`;
    else info.innerHTML=totalStories>0?`${totalStories} stor${totalStories!==1?'ies':'y'} — select to send to release`:'';
  }

  // Send to PI button
  const btn=document.getElementById('nsc-send-pi-btn');
  const btnLbl=document.getElementById('nsc-send-pi-label');
  if(btn){btn.disabled=piCount===0;}
  if(btnLbl)btnLbl.textContent=piCount>0?'Send to Release ('+piCount+')':'Send to Release';
}

function newScToggleSelectAll(chk){
  if(chk.checked){newScSelectAll();}
  else{newScClearAllPiSelection();}
}

function newScSelectAll(){
  newScGetAllVisibleStories().forEach(s=>{s._stagedForPI=true;});
  // Rebuild scPiSelectedIds globally — tracks "feature has at least one staged
  // story" regardless of current filter, consistent with every other rebuild
  // site in this file.
  scPiSelectedIds=new Set();
  scCanvas.forEach(f=>{if(f.stories&&f.stories.some(s=>s._stagedForPI))scPiSelectedIds.add(f.id);});
  newScRender();
}

async function newScSendToPI(){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const piCount=scCanvas.reduce((a,f)=>a+(f.stories?f.stories.filter(s=>s._inSC&&!s._hiddenFromSC&&s._stagedForPI).length:0),0);
  if(piCount===0){showToast('Select stories for release first.','info');return;}
  // Story Canvas has zero plan-awareness by design - it never references
  // any release plan object. Stories staged for PI go straight into the
  // GLOBAL backlog array; which plan (if any) eventually claims them is
  // entirely PI Planning's concern.
  if(typeof piBacklogStoryIds==='undefined'||!Array.isArray(piBacklogStoryIds)){
    piBacklogStoryIds=[];
  }
  // Dispatch: mark _inPIPlan, clear _stagedForPI, sync backlog
  scCanvas.forEach(f=>{
    if(!f.stories)return;
    f.stories.forEach(st=>{
      if(st._inSC&&!st._hiddenFromSC&&st._stagedForPI){
        st._inPIPlan=true;
        st._stagedForPI=false;
        if(!piBacklogStoryIds.includes(st.id)&&!scFindOwningPlan(st.id)){
          piBacklogStoryIds.push(st.id);
        }
      }
    });
  });
  // Rebuild scPiSelectedIds
  scPiSelectedIds=new Set();
  scCanvas.forEach(f=>{if(f.stories&&f.stories.some(s=>s._stagedForPI))scPiSelectedIds.add(f.id);});
  // Reveal PI tab silently — stay in SC
  const piTabBtn=document.getElementById('tab-pi');
  if(piTabBtn)piTabBtn.classList.add('revealed');
  // Signal new content in PI Canvas (cleared on first visit)
  if(piCount>0&&typeof markTabPending==='function')markTabPending('pi');
  if(typeof piRenderLeftPanel==='function')piRenderLeftPanel();
  if(typeof piUpdateTabBadge==='function')piUpdateTabBadge();
  // Inline confirm on Send to PI button
  const sendBtn=document.getElementById('nsc-send-pi-btn');
  if(sendBtn){
    const origHtml=sendBtn.innerHTML;
    sendBtn.innerHTML='<i class="ti ti-check" style="font-size:12px;" aria-hidden="true"></i> <span>'+piCount+' Sent to Release</span>';
    sendBtn.style.cssText='background:var(--green);color:#fff;border:none;';
    sendBtn.disabled=true;
    setTimeout(()=>{
      sendBtn.innerHTML=origHtml;
      sendBtn.style.cssText='';
      sendBtn.disabled=false;
      newScRender();
      newScUpdateTabBadge();
      if(typeof fcUpdateTabBadge==='function')fcUpdateTabBadge();
      if(typeof fcRenderCanvas==='function')fcRenderCanvas();
    },2000);
  } else {
    newScRender();
    newScUpdateTabBadge();
    if(typeof fcUpdateTabBadge==='function')fcUpdateTabBadge();
    if(typeof fcRenderCanvas==='function')fcRenderCanvas();
  }
  showToast(`${piCount} stor${piCount!==1?'ies':'y'} added to Release Canvas.`,'success');
  // v9.01-diag fix: this save is now AWAITED before the function returns.
  // Previously fire-and-forget — if the user navigated to Home quickly
  // after Send to PI, homeClearSession()'s own (also unawaited) save
  // could fire, and/or a resume could re-fetch before this write actually
  // completed. Awaiting here closes that race for THIS action specifically.
  if(piCount>0&&!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    const _saveOk=await sessionStoreSave(_activeSessionId);
    // v9.01 fix: this action never emitted a live-sync content event at
    // all — confirmed root cause for shared-session collaborators (e.g.
    // ES) getting no refresh toast and no resume-pickup when stories were
    // sent to PI. Reuses the existing 'pi_plan_updated' event type (a
    // manual-edit pattern, already has a corresponding RLS insert policy
    // gated on a recent save) rather than introducing a new event type
    // that would need its own DB-side policy change.
    if(_saveOk&&typeof _activeSessionIsShared!=='undefined'&&_activeSessionIsShared&&typeof _lsEmitContentEvent==='function'){
      await _lsEmitContentEvent(_activeSessionId,'pi','pi_plan_updated',null,null);
    }
  }
}

// ── Filter ──
function newScToggleFilter(evt){
  if(evt)evt.stopPropagation();
  const drop=document.getElementById('nsc-filter-drop');
  if(!drop)return;
  const isOpen=drop.classList.contains('open');
  if(isOpen){
    drop.classList.remove('open');
    document.removeEventListener('mousedown',_newScFilterOutside);
  } else {
    drop.classList.add('open');
    // Use mousedown (not click) so it fires before the checkbox change event
    setTimeout(()=>document.addEventListener('mousedown',_newScFilterOutside),0);
  }
}
function _newScFilterOutside(e){
  const drop=document.getElementById('nsc-filter-drop');
  if(!drop){document.removeEventListener('mousedown',_newScFilterOutside);return;}
  if(!drop.contains(e.target)){
    drop.classList.remove('open');
    document.removeEventListener('mousedown',_newScFilterOutside);
  }
}

function newScToggleFilter_v(section,value){
  if(section==='dependencies'){
    newScFilter.dependencies=newScFilter.dependencies===value?null:value;
  } else {
    const arr=newScFilter[section];
    const idx=arr.indexOf(value);
    if(idx>=0)arr.splice(idx,1);
    else arr.push(value);
  }
  const hasFilter=newScFilter.priority.length||newScFilter.readiness.length||newScFilter.piStatus.length||newScFilter.dependencies||newScFilter.briefRq.length||newScFilter.storyType.length;
  const btn=document.getElementById('nsc-filter-btn');
  if(btn)btn.classList.toggle('active',!!hasFilter);
  newScUpdateFilterBadge();
  newScRenderMain();
}

function newScUpdateFilterBadge(){
  const badge=document.getElementById('nsc-filter-badge');
  const lbl=document.getElementById('nsc-filter-badge-label');
  if(!badge||!lbl)return;
  const count=(newScFilter.priority.length)+(newScFilter.readiness.length)+(newScFilter.piStatus.length)+(newScFilter.dependencies?1:0)+(newScFilter.storyType.length);
  if(count>0){
    lbl.textContent=count+' filter'+(count!==1?'s':'');
    badge.style.display='inline-flex';
  } else {
    badge.style.display='none';
  }
}

function newScClearFilters(){
  newScFilter={priority:[],readiness:[],piStatus:[],dependencies:null,briefRq:[],storyType:[]};
  const btn=document.getElementById('nsc-filter-btn');
  if(btn)btn.classList.remove('active');
  const drop=document.getElementById('nsc-filter-drop');
  if(drop){
    drop.querySelectorAll('input[type=checkbox]').forEach(cb=>cb.checked=false);
    drop.classList.remove('open');
    document.removeEventListener('mousedown',_newScFilterOutside);
  }
  newScUpdateFilterBadge();
  newScUpdateBriefFilterBtn();
  newScRenderMain();
}

function newScApplyFilter(stories,feat){
  let result=stories;
  if(newScFilter.priority.length)result=result.filter(s=>newScFilter.priority.includes(s.priority));
  if(newScFilter.storyType.length)result=result.filter(s=>newScFilter.storyType.includes(s.storyType||'traditional'));
  if(newScFilter.readiness.length){
    result=result.filter(s=>{
      if(newScFilter.readiness.includes('Ready')&&s.dor==='READY')return true;
      if(newScFilter.readiness.includes('Not Ready')&&s.dor!=='READY'&&s.points)return true;
      if(newScFilter.readiness.includes('Points not set')&&!s.points)return true;
      return false;
    });
  }
  if(newScFilter.piStatus.length){
    result=result.filter(s=>{
      if(newScFilter.piStatus.includes('Release Selected')&&(s._stagedForPI||s._inPIPlan))return true;
      if(newScFilter.piStatus.includes('Not Selected')&&!s._stagedForPI&&!s._inPIPlan)return true;
      return false;
    });
  }
  if(newScFilter.dependencies==='Yes')result=result.filter(s=>s.dependencies&&s.dependencies.length>0);
  if(newScFilter.dependencies==='No')result=result.filter(s=>!s.dependencies||s.dependencies.length===0);
  // §9.2 — Brief filter reads the PARENT FEATURE's intakeBriefId (no new
  // field on story objects) — one added condition, same cost profile as
  // every other filter check in this function, not a new filtering pass.
  if(newScFilter.briefRq.length)result=feat&&newScFilter.briefRq.includes(feat.intakeBriefId)?result:[];
  return result;
}

// ── Shared visible-set computation ──
// Mirrors the established fcGetVisibleCanvas/ccGetVisibleCapKeys pattern from
// feature-canvas.js/capability-canvas.js: one function, used by render, the
// action bar count, Select All, and Clear All, so none of them can drift out
// of sync with what's actually on screen (the original bug — Select All
// staged all 25 stories while only 5 were visible under feature nav).
//
// Returns features currently in scope (nav-filtered), each with ITS visible
// stories already filtered (_inSC/_hiddenFromSC + newScApplyFilter applied).
function newScGetVisibleFeaturesAndStories(){
  let features=scCanvas.filter(f=>f.stories&&f.stories.some(s=>s._inSC&&!s._hiddenFromSC));
  if(newScActiveNavFeat)features=features.filter(f=>f.id===newScActiveNavFeat);
  return features.map(f=>{
    let stories=(f.stories||[]).filter(s=>s._inSC&&!s._hiddenFromSC);
    stories=newScApplyFilter(stories,f);
    return {feat:f,stories};
  });
}

// Flat convenience wrapper — every visible story across every visible
// feature, with no per-feature grouping. Used by the action bar count and
// the Select All / Clear All mutations, none of which need grouping.
function newScGetAllVisibleStories(){
  let all=[];
  newScGetVisibleFeaturesAndStories().forEach(function(entry){
    all=all.concat(entry.stories);
  });
  return all;
}

// ── Filter badge updated inline via newScUpdateFilterBadge() ──


// ── Right panel ──
function newScOpenPanel(stOrId,featOrId){
  // Accept either objects or ids
  const feat=typeof featOrId==='object'?scCanvas.find(f=>f.id===featOrId.id):scCanvas.find(f=>f.id===featOrId);
  if(!feat)return;
  const st=typeof stOrId==='object'?feat.stories&&feat.stories.find(s=>s.id===stOrId.id):feat.stories&&feat.stories.find(s=>s.id===stOrId);
  if(!st)return;
  newScPanelStoryId=st.id;
  newScPanelFeatId=feat.id;
  const main=document.getElementById('nsc-main');
  const panel=document.getElementById('nsc-panel');
  if(main)main.classList.add('panel-open');
  if(panel)panel.classList.add('open');
  // Title: ST-XXX · Story Title
  const titleEl=document.getElementById('nsc-panel-title');
  if(titleEl)titleEl.textContent=st.id+' · '+(st.title||'');
  // Content
  newScRenderPanelContent(st,feat);
  // v9.08.02: "Remove story from canvas" is a static button built once in
  // newScBuildLayout(), not part of the per-story template — synced here
  // since this function runs every time the panel opens for any story.
  const removeBtn=document.getElementById('nsc-remove-btn');
  if(removeBtn)removeBtn.style.display=((typeof canEditSession!=='function')||canEditSession())?'':'none';
  // Reset inline remove confirm
  newScHideRemoveConfirm();
}

function newScClosePanel(){
  newScPanelStoryId=null;
  newScPanelFeatId=null;
  const main=document.getElementById('nsc-main');
  const panel=document.getElementById('nsc-panel');
  if(main)main.classList.remove('panel-open');
  if(panel)panel.classList.remove('open');
}

function newScRenderPanelContent(st,feat){
  const el=document.getElementById('nsc-panel-content');
  if(!el)return;
  const hasDeps=st.dependencies&&st.dependencies.length>0;

  // Build dependency options for the add form
  const allStories=[];
  scCanvas.forEach(f=>{if(f.stories)f.stories.forEach(s=>{if(s.id!==st.id)allStories.push({id:s.id,title:s.title,feat:f.name});});});

  // Story body — Statement+AC / Outcome+Evals / Goal+Operating Contract,
  // chosen per st.storyType. Shared with Release Canvas's own detail panels
  // via scGetStorySections() (feature-canvas.js) so both screens stay in
  // sync without duplicating the per-type branching.
  const _scSections=(typeof scGetStorySections==='function')?scGetStorySections(st):[];
  const sectionsHtml=_scSections.map((sec,si)=>`
    <div style="margin-bottom:14px;">
      <div class="pi-section-lbl" style="margin-bottom:5px;">${e(sec.label)}</div>
      ${si===0?`<div style="background:var(--card);border-radius:5px;padding:8px 10px;">${sec.html}</div>`:sec.html}
    </div>`).join('');

  // v9.08: computed once per panel render, matches the readOnly-inline-
  // in-template pattern used elsewhere (settings-page.js Company Profile).
  const _canEditSc=(typeof canEditSession!=='function')||canEditSession();
  el.innerHTML=`
    <!-- Traceability — uses FC scRenderLineage with nsc-trace-meta target -->
    <div id="nsc-trace-meta" style="margin-bottom:10px;"></div>

    ${sectionsHtml}

    <!-- DoR toggle -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--divider);">
      <div>
        <div style="font-size:11px;font-weight:600;color:var(--t1);">Definition of Ready</div>
        <div style="font-size:10px;color:var(--t3);margin-top:2px;">PM-confirmed readiness for sprint planning</div>
      </div>
      <label class="sp-toggle${_canEditSc?'':' sp-toggle-locked'}" ${_canEditSc?`onclick="event.preventDefault();newScToggleDor('${e(st.id)}','${e(feat.id)}')"`:''}>
        <input type="checkbox" ${st.dor==='READY'?'checked':''} ${_canEditSc?'readonly':'disabled'}>
        <div class="sp-track"></div><div class="sp-thumb"></div>
      </label>
    </div>

    <!-- Dependencies -->
    <div style="margin-bottom:14px;">
      <div class="pi-section-lbl" style="margin-bottom:8px;">Dependencies</div>
      <div id="nsc-dep-list-${e(st.id)}">
        ${hasDeps?st.dependencies.map((dep,di)=>`
          <div class="nsc-dep-row">
            <span class="nsc-dep-dir ${dep.direction==='blocks'?'nsc-dep-blocks':dep.direction==='blocked-by'?'nsc-dep-blocked':'nsc-dep-external'}">${dep.direction==='blocks'?'Blocks →':dep.direction==='blocked-by'?'← Blocked by':'⚙ External'}</span>
            <span style="flex:1;font-size:10px;color:var(--t2);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${e(dep.storyTitle||dep.storyId)}</span>
            ${_canEditSc?`<button onclick="newScRemoveDep('${e(st.id)}','${e(feat.id)}',${di})" style="border:none;background:none;cursor:pointer;color:var(--t3);padding:2px;flex-shrink:0;font-size:10px;" title="Remove dependency">✕</button>`:''}
          </div>`).join(''):'<div style="font-size:10px;color:var(--label);font-style:italic;margin-bottom:6px;">No dependencies linked.</div>'}
      </div>
      ${_canEditSc?`<!-- Add dep form -->
      <div id="nsc-dep-form-${e(st.id)}" style="display:none;margin-top:8px;">
        <div style="display:flex;gap:5px;margin-bottom:6px;">
          <button class="nsc-dir-btn" id="nsc-dir-blocks" onclick="newScSetDepDir('${e(st.id)}','blocks')">This Blocks →</button>
          <button class="nsc-dir-btn" id="nsc-dir-blocked-by" onclick="newScSetDepDir('${e(st.id)}','blocked-by')">← Blocked By</button>
          <button class="nsc-dir-btn" id="nsc-dir-external" onclick="newScSetDepDir('${e(st.id)}','external')">⚙ External</button>
        </div>
        <!-- Custom searchable story picker -->
        <div style="position:relative;margin-bottom:6px;">
          <input type="text" id="nsc-dep-search-${e(st.id)}" placeholder="Search stories…" oninput="newScFilterDepSearch('${e(st.id)}')" autocomplete="off"
            style="width:100%;height:28px;border:1px solid var(--divider);border-radius:5px;padding:0 8px;font-size:11px;font-family:var(--font);box-sizing:border-box;"/>
          <div id="nsc-dep-list-drop-${e(st.id)}" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid var(--divider);border-radius:5px;max-height:160px;overflow-y:auto;z-index:20;box-shadow:0 4px 12px rgba(0,0,0,0.08);">
            ${allStories.map(s=>`<div class="nsc-dep-option" data-id="${e(s.id)}" data-title="${e(s.title)}" onclick="newScSelectDepStory('${e(st.id)}','${e(s.id)}','${e(s.title).replace(/'/g,"&#39;")}')" style="padding:6px 10px;font-size:10px;cursor:pointer;border-bottom:1px solid var(--divider);color:var(--t2);">[${e(s.id)}] ${e(s.title)}</div>`).join('')||'<div style="padding:8px 10px;font-size:10px;color:var(--label);">No other stories yet.</div>'}
          </div>
        </div>
        <div id="nsc-dep-selected-${e(st.id)}" style="font-size:10px;color:var(--purple);margin-bottom:6px;min-height:16px;"></div>
        <div style="display:flex;gap:5px;">
          <button onclick="newScAddDep('${e(st.id)}','${e(feat.id)}')" style="background:var(--purple);color:#fff;border:none;border-radius:5px;padding:5px 16px;font-size:11px;font-weight:600;cursor:pointer;font-family:var(--font);">Link ✓</button>
          <button onclick="document.getElementById('nsc-dep-form-${e(st.id)}').style.display='none';newScClearDepForm('${e(st.id)}');" style="background:none;border:1px solid var(--divider);border-radius:5px;padding:5px 12px;font-size:11px;cursor:pointer;color:var(--t2);font-family:var(--font);">Cancel</button>
        </div>
      </div>
      <button onclick="document.getElementById('nsc-dep-form-${e(st.id)}').style.display=document.getElementById('nsc-dep-form-${e(st.id)}').style.display==='none'?'block':'none';" style="margin-top:6px;font-size:10px;color:var(--purple);background:none;border:1px solid #CECBF6;border-radius:5px;padding:3px 10px;cursor:pointer;font-family:var(--font);">+ Add dependency</button>`:''}
    </div>

    <!-- Notes -->
    <div>
      <div class="pi-section-lbl" style="margin-bottom:5px;">Notes <span style="font-size:9px;color:var(--label);font-weight:400;">${RELEASE_EXPORT_NOTE_LABEL}</span></div>
      <textarea id="nsc-notes-${e(st.id)}" rows="3" ${_canEditSc?'':'readonly'} style="width:100%;border:1px solid var(--divider);border-radius:5px;padding:6px 8px;font-size:11px;font-family:var(--font);color:${_canEditSc?'var(--t1)':'var(--t3)'};resize:vertical;box-sizing:border-box;${_canEditSc?'':'background:var(--card);cursor:default;'}" placeholder="Add notes visible to the team…" ${_canEditSc?`oninput="newScSaveNotes('${e(st.id)}','${e(feat.id)}')"`:''}>${e(st.notes||'')}</textarea>
    </div>`;
  // Render traceability using FC's scRenderLineage — same pattern, same logic, same Link one? CTA
  if(typeof scRenderLineage==='function'){
    scLineageTargetElId='nsc-trace-meta';
    scRenderLineage(feat,'nsc-trace-meta');
  }
}

// ── Panel interactions ──
function newScToggleDor(storyId,featId){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const feat=scCanvas.find(f=>f.id===featId);
  if(!feat||!feat.stories)return;
  const st=feat.stories.find(s=>s.id===storyId);
  if(!st)return;
  st.dor=st.dor==='READY'?'NOT READY':'READY';
  newScRenderMain();
  newScOpenPanel(st,feat);
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('sc',featId+_LS_SC_TARGET_SEP+storyId); });
  }
}

let _newScDepDir='blocks';
function newScSetDepDir(storyId,dir){
  _newScDepDir=dir;
  ['blocks','blocked-by','external'].forEach(d=>{
    const btn=document.getElementById('nsc-dir-'+d);
    if(btn)btn.classList.toggle('active',d===dir);
  });
}

// Custom dep search — filters inline list (Item 29)
let _newScDepSelectedId='';
let _newScDepSelectedTitle='';

function newScFilterDepSearch(storyId){
  const inp=document.getElementById('nsc-dep-search-'+storyId);
  const drop=document.getElementById('nsc-dep-list-drop-'+storyId);
  if(!inp||!drop)return;
  const q=inp.value.trim().toLowerCase();
  drop.style.display='block';
  Array.from(drop.querySelectorAll('.nsc-dep-option')).forEach(opt=>{
    opt.style.display=opt.textContent.toLowerCase().includes(q)||!q?'':'none';
  });
}

function newScSelectDepStory(storyId,targetId,targetTitle){
  _newScDepSelectedId=targetId;
  _newScDepSelectedTitle=targetTitle;
  const inp=document.getElementById('nsc-dep-search-'+storyId);
  const drop=document.getElementById('nsc-dep-list-drop-'+storyId);
  const sel=document.getElementById('nsc-dep-selected-'+storyId);
  if(inp)inp.value='';
  if(drop)drop.style.display='none';
  if(sel)sel.textContent='Selected: ['+targetId+'] '+targetTitle;
}

function newScClearDepForm(storyId){
  _newScDepSelectedId='';
  _newScDepSelectedTitle='';
  const inp=document.getElementById('nsc-dep-search-'+storyId);
  const drop=document.getElementById('nsc-dep-list-drop-'+storyId);
  const sel=document.getElementById('nsc-dep-selected-'+storyId);
  if(inp)inp.value='';
  if(drop)drop.style.display='none';
  if(sel)sel.textContent='';
}

function newScAddDep(storyId,featId){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const feat=scCanvas.find(f=>f.id===featId);
  if(!feat||!feat.stories)return;
  const st=feat.stories.find(s=>s.id===storyId);
  if(!st)return;
  const targetId=_newScDepSelectedId;
  if(!targetId){showToast('Select a story first.','warn');return;}
  const targetTitle=_newScDepSelectedTitle||targetId;
  if(!st.dependencies)st.dependencies=[];
  if(!st.dependencies.some(d=>d.storyId===targetId&&d.direction===_newScDepDir)){
    st.dependencies.push({direction:_newScDepDir,storyId:targetId,storyTitle:targetTitle});
  }
  if(typeof pcMarkStale==='function')pcMarkStale(featId);
  // Reset
  _newScDepSelectedId='';
  _newScDepSelectedTitle='';
  const form=document.getElementById('nsc-dep-form-'+storyId);
  if(form)form.style.display='none';
  newScOpenPanel(st,feat);
  newScRenderMain();
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('sc',featId+_LS_SC_TARGET_SEP+storyId); });
  }
}

function newScRemoveDep(storyId,featId,depIdx){
  const feat=scCanvas.find(f=>f.id===featId);
  if(!feat||!feat.stories)return;
  const st=feat.stories.find(s=>s.id===storyId);
  if(!st||!st.dependencies)return;
  st.dependencies.splice(depIdx,1);
  if(typeof pcMarkStale==='function')pcMarkStale(featId);
  newScOpenPanel(st,feat);
  newScRenderMain();
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('sc',featId+_LS_SC_TARGET_SEP+storyId); });
  }
}

function newScSaveNotes(storyId,featId){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const feat=scCanvas.find(f=>f.id===featId);
  if(!feat||!feat.stories)return;
  const st=feat.stories.find(s=>s.id===storyId);
  if(!st)return;
  const inp=document.getElementById('nsc-notes-'+storyId);
  if(inp)st.notes=inp.value;
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('sc',featId+_LS_SC_TARGET_SEP+storyId); });
  }
}

// ── Inline remove confirm (Item 31) ──
function newScShowRemoveConfirm(){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  if(!newScPanelStoryId||!newScPanelFeatId)return;
  const confirm=document.getElementById('nsc-remove-confirm');
  const btn=document.getElementById('nsc-remove-btn');
  const yesBtn=document.getElementById('nsc-remove-confirm-yes');
  if(!confirm||!yesBtn)return;
  confirm.style.display='block';
  if(btn)btn.style.display='none';
  // Wire yes button with current story/feat IDs
  yesBtn.onclick=function(){newScDoRemoveStory(newScPanelStoryId,newScPanelFeatId);};
}

function newScHideRemoveConfirm(){
  const confirm=document.getElementById('nsc-remove-confirm');
  const btn=document.getElementById('nsc-remove-btn');
  if(confirm)confirm.style.display='none';
  if(btn)btn.style.display='';
}

// ── Confirm remove story from PI (Option C × button) ──
function newScConfirmRemoveFromPI(storyId,featId){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  showConfirm(
    'Remove from Release plan?',
    'This story will be deselected and removed from your Release Canvas backlog.',
    ()=>{
      const feat=scCanvas.find(f=>f.id===featId);
      if(!feat||!feat.stories)return;
      const st=feat.stories.find(s=>s.id===storyId);
      if(st){
        st._inPIPlan=false;
        st._stagedForPI=false;
        // Remove from whichever plan owns it (if any), and return it to
        // the global backlog rather than any plan-scoped field.
        const _owner=scFindOwningPlan(storyId);
        if(_owner&&_owner.storyAssignments)delete _owner.storyAssignments[storyId];
        if(typeof piBacklogStoryIds!=='undefined'&&Array.isArray(piBacklogStoryIds)){
          piBacklogStoryIds=piBacklogStoryIds.filter(id=>id!==storyId);
        }
        scPiSelectedIds=new Set();
        scCanvas.forEach(f=>{if(f.stories&&f.stories.some(s=>s._stagedForPI))scPiSelectedIds.add(f.id);});
      }
      newScRender();
      if(typeof piCheckStaleness==='function')piCheckStaleness();
      // Item 4 edge case — if a piStatus filter is active, removing this
      // story may drop it out of the currently-filtered view; a scroll
      // restore that lands on a shifted/empty list is confusing without
      // this. Conservative approximation: fires whenever any piStatus
      // filter is active, not only when THIS card would be hidden by it —
      // worst case shows the more cautious message when the card would
      // have stayed visible anyway, never the reverse.
      const _filterActive=Array.isArray(newScFilter.piStatus)&&newScFilter.piStatus.length>0;
      showToast(_filterActive?'Removed — filtered out of current view.':'Story removed from release plan.','success');
      // v8.146 fix: confirmed missing entirely. PI-staging state only —
      // deliberately no live-edit mark, matching the existing convention
      // that selection/staging state isn't live-synced (same as
      // scSelectedIds/leakSelectedIds elsewhere in this app).
      if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId)sessionStoreSave(_activeSessionId);
    }
  );
}

function newScDoRemoveStory(storyId,featId){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const feat=scCanvas.find(f=>f.id===featId);
  if(!feat||!feat.stories)return;
  const st=feat.stories.find(s=>s.id===storyId);
  if(!st)return;
  // Hide from SC only — do not delete from FC (shared data model)
  st._hiddenFromSC=true;
  st._inSC=false;
  st._stagedForPI=false;
  // Clean PI plan - resolve the owning plan (if any) and strip the story
  // from the global backlog too, never a plan-scoped field.
  const _owner=scFindOwningPlan(storyId);
  if(_owner&&_owner.storyAssignments)delete _owner.storyAssignments[storyId];
  if(typeof piBacklogStoryIds!=='undefined'&&Array.isArray(piBacklogStoryIds)){
    piBacklogStoryIds=piBacklogStoryIds.filter(id=>id!==storyId);
  }
  if(typeof scPiSelectedIds!=='undefined'){
    scPiSelectedIds=new Set();
    scCanvas.forEach(f=>{if(f.stories&&f.stories.some(s=>s._stagedForPI))scPiSelectedIds.add(f.id);});
  }
  if(newScPanelStoryId===storyId)newScClosePanel();
  newScRender();
  newScUpdateTabBadge();
  if(typeof fcUpdateTabBadge==='function')fcUpdateTabBadge();
  if(typeof fcRenderCanvas==='function')fcRenderCanvas();
  if(typeof piUpdateTabBadge==='function')piUpdateTabBadge();
  if(typeof piCheckStaleness==='function')piCheckStaleness();
  showToast('Story removed from Story Canvas.','success');
  // v8.146 fix: confirmed missing entirely — this soft-hide (a genuine
  // content change collaborators should see) was never persisted.
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('sc',featId+_LS_SC_TARGET_SEP+storyId); });
  }
}

// ── Delete story (from card × button — still uses confirm for accidental tap prevention) ──
function newScDeleteStoryById(storyId,featId){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const feat=scCanvas.find(f=>f.id===featId);
  if(!feat||!feat.stories)return;
  const st=feat.stories.find(s=>s.id===storyId);
  if(!st)return;
  const isInPI=!!st._inPIPlan;
  const warningMsg=isInPI
    ?'This story is selected for the release. Removing it will also remove it from your Release Canvas.'
    :'This action cannot be undone.';
  showConfirm(
    `Remove "${st.title||st.id}"?`,
    warningMsg,
    ()=>{
      // Remove from PI plan if assigned - resolve the owning plan, and
      // strip the story from the global backlog too, never a plan-scoped
      // field.
      const _owner=scFindOwningPlan(storyId);
      if(_owner&&_owner.storyAssignments)delete _owner.storyAssignments[storyId];
      if(typeof piBacklogStoryIds!=='undefined'&&Array.isArray(piBacklogStoryIds)){
        piBacklogStoryIds=piBacklogStoryIds.filter(id=>id!==storyId);
      }
      // Hide from SC only — do not delete from FC (shared data model)
      const _st=feat.stories.find(s=>s.id===storyId);
      if(_st){_st._hiddenFromSC=true;_st._inSC=false;_st._stagedForPI=false;_st._inPIPlan=false;}
      // Clean PI selection
      if(typeof scPiSelectedIds!=='undefined'){
        scPiSelectedIds=new Set();
        scCanvas.forEach(f=>{if(f.stories&&f.stories.some(s=>s._stagedForPI))scPiSelectedIds.add(f.id);});
      }
      if(newScPanelStoryId===storyId)newScClosePanel();
      if(typeof pcMarkStale==='function')pcMarkStale(featId);
      newScRender();
      newScUpdateTabBadge();
      if(typeof fcUpdateTabBadge==='function')fcUpdateTabBadge();
      if(typeof fcRenderCanvas==='function')fcRenderCanvas();
      if(typeof piUpdateTabBadge==='function')piUpdateTabBadge();
      if(typeof piCheckStaleness==='function')piCheckStaleness();
      if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId)sessionStoreSave(_activeSessionId);
    },
    'Remove',
    'danger'
  );
}

function newScDeleteStoryConfirm(){
  if(!newScPanelStoryId||!newScPanelFeatId)return;
  newScDeleteStoryById(newScPanelStoryId,newScPanelFeatId);
}

// ── Add Story modal ──
function newScShowAddStoryModal(prefeatId){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  // Build sorted feature list
  const features=scCanvas.filter(f=>f.stories&&f.stories.length>=0);
  features.sort((a,b)=>a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const featOpts=features.map(f=>`<option value="${e(f.id)}"${f.id===prefeatId?' selected':''}>${e(f.name)} (${e(f.stage||'')})</option>`).join('');
  const overlay=document.createElement('div');
  overlay.className='modal-overlay';
  overlay.id='nsc-add-story-overlay';
  overlay.innerHTML=`<div class="modal" style="max-width:500px;;position:relative;">
    <button onclick="document.getElementById('nsc-add-story-overlay').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:3px;color:var(--t3);display:flex;align-items:center;border-radius:4px;z-index:1;" title="Close"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    <div style="padding:16px 44px 14px 16px;border-bottom:0.5px solid var(--divider);">
      <div style="font-size:13px;font-weight:500;color:var(--t1);">Add Story</div>
    </div>
    <div class="modal-body" style="font-size:11px;color:var(--t3);">Manually define a story. DoR, dependencies and notes can be set from the right panel after saving.</div>
    <div style="display:flex;flex-direction:column;gap:10px;padding:0 20px 4px;">
      <div>
        <label style="font-size:10px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">Feature <span style="color:var(--red);">*</span></label>
        ${features.length>10?`<input type="text" id="nsc-add-feat-search" placeholder="Search features…" oninput="newScFilterFeatSearch()" style="width:100%;height:28px;border:1px solid var(--divider);border-radius:5px;padding:0 8px;font-size:11px;font-family:var(--font);margin-bottom:4px;box-sizing:border-box;"/>`:''}
        <select id="nsc-add-feat-sel" onchange="newScValidateAddStory()" style="width:100%;height:30px;border:1px solid var(--divider);border-radius:5px;padding:0 8px;font-size:11px;font-family:var(--font);color:var(--t1);appearance:none;">
          <option value="">— Select feature —</option>
          ${featOpts}
        </select>
      </div>
      <div>
        <label style="font-size:10px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">Title <span style="color:var(--red);">*</span></label>
        <input type="text" id="nsc-add-title" placeholder="Short story title" oninput="newScValidateAddStory()" style="width:100%;height:30px;border:1px solid var(--divider);border-radius:5px;padding:0 8px;font-size:11px;font-family:var(--font);color:var(--t1);box-sizing:border-box;"/>
      </div>
      <div>
        <label style="font-size:10px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">Statement <span style="color:var(--red);">*</span></label>
        <textarea id="nsc-add-stmt" placeholder="As a [persona], I want to [action], so that [outcome]." oninput="newScValidateAddStory()" rows="3" style="width:100%;border:1px solid var(--divider);border-radius:5px;padding:6px 8px;font-size:11px;font-family:var(--font);color:var(--t1);resize:none;box-sizing:border-box;"></textarea>
      </div>
      <div>
        <label style="font-size:10px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">Acceptance Criteria <span style="font-size:9px;color:var(--label);font-weight:400;">(optional)</span></label>
        <textarea id="nsc-add-ac" placeholder="Scenario: …&#10;Given …&#10;When …&#10;Then …" rows="5" style="width:100%;border:1px solid var(--divider);border-radius:5px;padding:6px 8px;font-size:11px;font-family:var(--font);color:var(--t1);resize:vertical;box-sizing:border-box;"></textarea>
      </div>
      <div style="display:flex;gap:8px;">
        <div style="flex:1;">
          <label style="font-size:10px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">Priority</label>
          <select id="nsc-add-priority" style="width:100%;height:30px;border:1px solid var(--divider);border-radius:5px;padding:0 8px;font-size:11px;font-family:var(--font);color:var(--t1);appearance:none;">
            <option value="">— Not set —</option>
            <option>Must Have</option><option>Should Have</option><option>Could Have</option><option>Won't Have</option>
          </select>
        </div>
        <div style="flex:1;">
          <label style="font-size:10px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">Story points</label>
          <select id="nsc-add-pts" style="width:100%;height:30px;border:1px solid var(--divider);border-radius:5px;padding:0 8px;font-size:11px;font-family:var(--font);color:var(--t1);appearance:none;">
            <option value="">— Not set —</option>
            <option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="5">5</option><option value="8">8</option><option value="13">13</option>
          </select>
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <div style="flex:1;font-size:9px;color:var(--label);font-style:italic;">Fill Title and Statement to enable.</div>
      <button class="modal-cancel-btn" onclick="document.getElementById('nsc-add-story-overlay').remove()">Cancel</button>
      <button class="modal-confirm-btn" id="nsc-add-story-submit" disabled onclick="newScDoAddStory()">Add Story</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const _esc=function(ev){if(ev.key==='Escape'){overlay.remove();document.removeEventListener('keydown',_esc,true);}};
  document.addEventListener('keydown',_esc,true);
  trapFocus(overlay);
  // Pre-select active nav feature
  if(prefeatId||newScActiveNavFeat){
    const sel=document.getElementById('nsc-add-feat-sel');
    if(sel&&(prefeatId||newScActiveNavFeat))sel.value=prefeatId||newScActiveNavFeat;
  }
  newScValidateAddStory();
}

function newScFilterFeatSearch(){
  const inp=document.getElementById('nsc-add-feat-search');
  const sel=document.getElementById('nsc-add-feat-sel');
  if(!inp||!sel)return;
  const q=inp.value.trim().toLowerCase();
  Array.from(sel.options).forEach(opt=>{
    if(!opt.value){opt.style.display='';return;}
    opt.style.display=opt.text.toLowerCase().includes(q)?'':'none';
  });
}

function newScValidateAddStory(){
  const title=document.getElementById('nsc-add-title');
  const stmt=document.getElementById('nsc-add-stmt');
  const feat=document.getElementById('nsc-add-feat-sel');
  const btn=document.getElementById('nsc-add-story-submit');
  if(btn)btn.disabled=!(title&&title.value.trim()&&stmt&&stmt.value.trim()&&feat&&feat.value);
}

function newScDoAddStory(){
  const featId=(document.getElementById('nsc-add-feat-sel')||{}).value;
  const title=(document.getElementById('nsc-add-title')||{}).value||'';
  const stmt=(document.getElementById('nsc-add-stmt')||{}).value||'';
  const priority=(document.getElementById('nsc-add-priority')||{}).value||'';
  const ptsRaw=(document.getElementById('nsc-add-pts')||{}).value;
  const acRaw=(document.getElementById('nsc-add-ac')||{}).value||'';
  const pts=ptsRaw?parseInt(ptsRaw):null;
  if(!featId||!title.trim()||!stmt.trim())return;
  const feat=scCanvas.find(f=>f.id===featId);
  if(!feat)return;
  if(!feat.stories)feat.stories=[];
  scStoryIdCounter++;
  const newId='ST-'+String(scStoryIdCounter).padStart(3,'0');
  const scenarios=acRaw.trim()?[acRaw.trim()]:[];
  feat.stories.push({id:newId,title:title.trim(),statement:stmt.trim(),priority:priority||null,points:pts||null,dor:'NOT READY',dorReason:'',scenarios,_stagedForPI:false,_inPIPlan:false,_inSC:true,_hiddenFromSC:false});
  if(typeof pcMarkStale==='function')pcMarkStale(featId);
  document.getElementById('nsc-add-story-overlay').remove();
  fcUpdateTabBadge();
  newScUpdateTabBadge();
  newScRevealTab();
  newScRender();
  if(typeof piCheckStaleness==='function')piCheckStaleness();
  // Auto-scroll to new story card and open its right panel
  const _newStory={id:newId,title:title.trim(),statement:stmt.trim()};
  const _newFeat=feat;
  requestAnimationFrame(()=>{
    requestAnimationFrame(()=>{
      const _card=document.getElementById('nsc-story-'+newId);
      if(_card)_card.scrollIntoView({behavior:'smooth',block:'center'});
      newScOpenPanel(_newStory,_newFeat);
    });
  });
  showToast('Story '+newId+' added.','success');
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('sc',featId+_LS_SC_TARGET_SEP+newId); });
  }
}
// Shared text<->structure conversion for the non-traditional story-edit
// fields below — same "one concept per line" convention as the existing
// Gherkin scenariosToText()/parse-back, just generalized to plain bullet
// lists, eval-scenario/rubric pairs, and name:threshold metric lines.
function _nscBulletsToText(arr){return(arr&&arr.length)?arr.join('\n'):'';}
function _nscTextToBullets(text){return(text||'').split('\n').map(l=>l.trim()).filter(Boolean);}
function _nscEvalScenariosToText(arr){
  if(!arr||!arr.length)return'';
  return arr.map(s=>{
    let block='Scenario: '+(s.scenario||'')+'\nRubric: '+(s.rubric||'');
    if(s.category)block+='\nCategory: '+(typeof _scCategoryLabel==='function'?_scCategoryLabel(s.category):s.category);
    if(s.scoring){
      block+='\nScoring Method: '+(s.scoring.evaluatorType||'');
      block+='\nScale: '+(s.scoring.scale||'');
      if(s.scoring.threshold)block+='\nThreshold: '+s.scoring.threshold;
      if(s.scoring.rationale)block+='\nRationale: '+s.scoring.rationale;
    }
    return block;
  }).join('\n\n');
}
// Category:/Scoring Method:/Scale:/Threshold:/Rationale: are optional lines
// on top of the existing Scenario:/Rubric: pair, each its own line (not
// packed onto one delimited "Scoring: a, b, c — d" line) specifically so a
// comma or hyphen inside a hand-typed or LLM-generated threshold/rationale
// can never be mistaken for a field separator. Omitting every one of the
// scoring sub-fields (or the Category line) leaves that field genuinely
// absent — not a defaulted value — so a legacy, pre-categorization entry
// round-trips with no stray badge. Every raw value is piped through the
// same _scNormalizeRubricCategory()/_scNormalizeScoring() (feature-canvas.js)
// used at generation time, so a typo degrades the same defensive way
// instead of crashing or silently keeping garbage. A continuation line that
// matches none of the field prefixes is always appended to whichever field
// was last matched — never silently dropped, for any field.
const _nscEvalFieldPrefixes=[['scenario',/^Scenario:\s*/i],['rubric',/^Rubric:\s*/i],['category',/^Category:\s*/i],['method',/^Scoring Method:\s*/i],['scale',/^Scale:\s*/i],['threshold',/^Threshold:\s*/i],['rationale',/^Rationale:\s*/i]];
function _nscTextToEvalScenarios(text){
  if(!text||!text.trim())return[];
  return text.trim().split(/\n{2,}/).map(block=>{
    const lines=block.split('\n').map(l=>l.trim()).filter(Boolean);
    const fields={scenario:'',rubric:'',category:'',method:'',scale:'',threshold:'',rationale:''};
    let last='scenario';
    lines.forEach(l=>{
      const hit=_nscEvalFieldPrefixes.find(p=>p[1].test(l));
      if(hit){last=hit[0];fields[last]=l.replace(hit[1],'');}
      else{fields[last]=fields[last]?fields[last]+' '+l:l;}
    });
    const out={scenario:fields.scenario,rubric:fields.rubric};
    if(fields.category&&typeof _scNormalizeRubricCategory==='function')out.category=_scNormalizeRubricCategory(fields.category);
    if((fields.method||fields.scale||fields.threshold||fields.rationale)&&typeof _scNormalizeScoring==='function'){
      out.scoring=_scNormalizeScoring({evaluator_type:fields.method,scale:fields.scale,threshold:fields.threshold,rationale:fields.rationale});
    }
    return out;
  }).filter(s=>s.scenario||s.rubric);
}
function _nscMetricsToText(metrics){
  if(!metrics||!metrics.length)return'';
  return metrics.map(m=>(m.name||'')+': '+(m.threshold||'')).join('\n');
}
function _nscTextToMetrics(text){
  if(!text||!text.trim())return[];
  return text.trim().split('\n').map(l=>l.trim()).filter(Boolean).map(l=>{
    const idx=l.lastIndexOf(':'); // last, not first — a metric name can itself contain a colon (e.g. "Ratio (A:B)")
    if(idx===-1)return{name:l,threshold:''};
    return{name:l.slice(0,idx).trim(),threshold:l.slice(idx+1).trim()};
  });
}

function newScShowEditStoryModal(storyId,featId){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const feat=scCanvas.find(f=>f.id===featId);
  if(!feat||!feat.stories)return;
  const st=feat.stories.find(s=>s.id===storyId);
  if(!st)return;
  const storyType=st.storyType||'traditional';
  const d=st.detail||{};
  // Convert structured scenarios to Gherkin text for editing
  function scenariosToText(scenarios){
    if(!scenarios||!scenarios.length)return '';
    return scenarios.map(sc=>{
      if(typeof sc==='string')return sc;
      let t='Scenario: '+(sc.name||'');
      if(sc.given)t+='\nGiven '+sc.given;
      if(sc.when)t+='\nWhen '+sc.when;
      if(sc.then)t+='\nThen '+sc.then;
      if(sc.and)t+='\nAnd '+sc.and;
      return t;
    }).join('\n\n');
  }
  const acText=scenariosToText(st.scenarios||[]);
  const lbl=(text,opt)=>`<label style="font-size:10px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">${text} ${opt?'<span style="font-size:9px;color:var(--label);font-weight:400;">(optional)</span>':'<span style="color:var(--red);">*</span>'}</label>`;
  const ta=(id,rows,val,placeholder,required)=>`<textarea id="${id}" rows="${rows}" ${placeholder?`placeholder="${placeholder}"`:''} ${required?'oninput="newScValidateEditStory()"':''} style="width:100%;border:1px solid var(--divider);border-radius:5px;padding:6px 8px;font-size:11px;font-family:var(--font);color:var(--t1);resize:vertical;box-sizing:border-box;line-height:1.6;">${e(val)}</textarea>`;
  let bodyFields;
  if(storyType==='ai_feature'){
    bodyFields=`
      <div>${lbl('Outcome')}${ta('nsc-edit-outcome',3,d.outcome||'','',true)}</div>
      <div>${lbl('Behavior Expectations',true)}${ta('nsc-edit-behavior',3,_nscBulletsToText(d.behaviorExpectations),'One expectation per line')}</div>
      <div>${lbl('Eval Scenarios &amp; Rubrics',true)}${ta('nsc-edit-evals',9,_nscEvalScenariosToText(d.evalScenarios),'Scenario: …&#10;Rubric: …&#10;Category: Groundedness (optional)&#10;Scoring Method: llm_judge (optional)&#10;Scale: 0-1&#10;Threshold: &gt;= 0.7&#10;Rationale: …')}</div>
      <div style="display:flex;gap:8px;">
        <div style="flex:2;">${lbl('Quality Bar metrics',true)}${ta('nsc-edit-metrics',3,_nscMetricsToText(d.qualityBar&&d.qualityBar.metrics),'Task success rate: &gt;= 90%')}</div>
        <div style="flex:1;">${lbl('Rerun trigger',true)}${ta('nsc-edit-rerun',3,(d.qualityBar&&d.qualityBar.rerunTrigger)||'')}</div>
      </div>`;
  } else if(storyType==='agentic'){
    bodyFields=`
      <div>${lbl('Goal')}${ta('nsc-edit-goal',3,d.goal||'','',true)}</div>
      <div>${lbl('Decision Rights',true)}${ta('nsc-edit-decision-rights',3,_nscBulletsToText(d.decisionRights),'One per line')}</div>
      <div>${lbl('Guardrails',true)}${ta('nsc-edit-guardrails',3,_nscBulletsToText(d.guardrails),'One per line')}</div>
      <div style="display:flex;gap:8px;">
        <div style="flex:1;">${lbl('Escalation triggers',true)}${ta('nsc-edit-esc-triggers',3,_nscBulletsToText((d.escalation||{}).triggers),'One per line')}</div>
        <div style="flex:1;">${lbl('Handoff includes',true)}${ta('nsc-edit-esc-handoff',3,_nscBulletsToText((d.escalation||{}).handoff),'One per line')}</div>
      </div>
      <div style="display:flex;gap:8px;">
        <div style="flex:2;">${lbl('Acceptance Envelope metrics',true)}${ta('nsc-edit-metrics',3,_nscMetricsToText(d.acceptanceEnvelope&&d.acceptanceEnvelope.metrics),'Name: Threshold, one per line')}</div>
        <div style="flex:1;">${lbl('Rerun trigger',true)}${ta('nsc-edit-rerun',3,(d.acceptanceEnvelope&&d.acceptanceEnvelope.rerunTrigger)||'')}</div>
      </div>
      <div>${lbl('Acceptance Envelope rubrics',true)}${ta('nsc-edit-ae-rubrics',8,_nscEvalScenariosToText(d.acceptanceEnvelope&&d.acceptanceEnvelope.rubrics),'Scenario: a judgment-call situation the agent may face&#10;Rubric: what a sound decision looks like&#10;Category: Accuracy (optional)&#10;Scoring Method: llm_judge (optional)&#10;Scale: 0-1&#10;Threshold: &gt;= 0.7&#10;Rationale: …')}</div>`;
  } else {
    bodyFields=`
      <div>${lbl('Statement')}<textarea id="nsc-edit-stmt" rows="3" oninput="newScValidateEditStory()" style="width:100%;border:1px solid var(--divider);border-radius:5px;padding:6px 8px;font-size:11px;font-family:var(--font);color:var(--t1);resize:none;box-sizing:border-box;">${e(st.statement||'')}</textarea></div>
      <div>${lbl('Acceptance Criteria',true)}<textarea id="nsc-edit-ac" rows="6" placeholder="Scenario: …&#10;Given …&#10;When …&#10;Then …" style="width:100%;border:1px solid var(--divider);border-radius:5px;padding:6px 8px;font-size:11px;font-family:var(--font);color:var(--t1);resize:vertical;box-sizing:border-box;line-height:1.6;">${e(acText)}</textarea></div>`;
  }
  // Build feature options
  const featOpts=scCanvas.map(f=>`<option value="${e(f.id)}"${f.id===featId?' selected':''}>${e(f.name)}</option>`).join('');
  const typeTag=scStoryTypeBadge(storyType,{size:9,extraStyle:'margin-left:5px;'});
  const overlay=document.createElement('div');
  overlay.className='modal-overlay';
  overlay.id='nsc-edit-story-overlay';
  overlay.dataset.storyType=storyType;
  overlay.innerHTML=`<div class="modal" style="max-width:500px;position:relative;">
    <button onclick="document.getElementById('nsc-edit-story-overlay').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:3px;color:var(--t3);display:flex;align-items:center;border-radius:4px;z-index:1;" title="Close">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
    <div style="padding:16px 44px 14px 16px;border-bottom:0.5px solid var(--divider);">
      <div style="font-size:13px;font-weight:500;color:var(--t1);">Edit Story <span style="font-size:10px;color:var(--label);font-weight:400;">${e(st.id)}</span>${typeTag}</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;padding:14px 16px 4px;max-height:60vh;overflow-y:auto;">
      <div>
        <label style="font-size:10px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">Feature</label>
        <select id="nsc-edit-feat" style="width:100%;height:30px;border:1px solid var(--divider);border-radius:5px;padding:0 8px;font-size:11px;font-family:var(--font);color:var(--t1);">${featOpts}</select>
      </div>
      <div>
        <label style="font-size:10px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">Title <span style="color:var(--red);">*</span></label>
        <input type="text" id="nsc-edit-title" value="${e(st.title||'')}" oninput="newScValidateEditStory()" style="width:100%;height:30px;border:1px solid var(--divider);border-radius:5px;padding:0 8px;font-size:11px;font-family:var(--font);color:var(--t1);box-sizing:border-box;"/>
      </div>
      ${bodyFields}
      <div style="display:flex;gap:8px;">
        <div style="flex:1;">
          <label style="font-size:10px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">Priority</label>
          <select id="nsc-edit-priority" style="width:100%;height:30px;border:1px solid var(--divider);border-radius:5px;padding:0 8px;font-size:11px;font-family:var(--font);color:var(--t1);appearance:none;">
            <option value="">— Not set —</option>
            <option${st.priority==='Must Have'?' selected':''}>Must Have</option>
            <option${st.priority==='Should Have'?' selected':''}>Should Have</option>
            <option${st.priority==='Could Have'?' selected':''}>Could Have</option>
            <option${st.priority==="Won't Have"?' selected':''}>Won't Have</option>
          </select>
        </div>
        <div style="flex:1;">
          <label style="font-size:10px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">Story points</label>
          <select id="nsc-edit-pts" style="width:100%;height:30px;border:1px solid var(--divider);border-radius:5px;padding:0 8px;font-size:11px;font-family:var(--font);color:var(--t1);appearance:none;">
            <option value="">— Not set —</option>
            <option value="1"${st.points===1?' selected':''}>1</option>
            <option value="2"${st.points===2?' selected':''}>2</option>
            <option value="3"${st.points===3?' selected':''}>3</option>
            <option value="5"${st.points===5?' selected':''}>5</option>
            <option value="8"${st.points===8?' selected':''}>8</option>
            <option value="13"${st.points===13?' selected':''}>13</option>
          </select>
        </div>
      </div>
    </div>
    <div class="modal-footer" style="padding:10px 16px 14px;display:flex;justify-content:flex-end;gap:6px;">
      <button class="modal-cancel-btn" onclick="document.getElementById('nsc-edit-story-overlay').remove()">Cancel</button>
      <button class="modal-confirm-btn" id="nsc-edit-story-submit" onclick="newScDoEditStory('${e(storyId)}','${e(featId)}')">Save Changes</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const _esc=function(ev){if(ev.key==='Escape'){overlay.remove();document.removeEventListener('keydown',_esc,true);}};
  document.addEventListener('keydown',_esc,true);
  trapFocus(overlay);
  newScValidateEditStory();
}

function newScValidateEditStory(){
  const overlay=document.getElementById('nsc-edit-story-overlay');
  const storyType=(overlay&&overlay.dataset.storyType)||'traditional';
  const title=document.getElementById('nsc-edit-title');
  const btn=document.getElementById('nsc-edit-story-submit');
  const primaryId=storyType==='ai_feature'?'nsc-edit-outcome':storyType==='agentic'?'nsc-edit-goal':'nsc-edit-stmt';
  const primary=document.getElementById(primaryId);
  if(btn)btn.disabled=!(title&&title.value.trim()&&primary&&primary.value.trim());
}

function newScDoEditStory(storyId,origFeatId){
  const origFeat=scCanvas.find(f=>f.id===origFeatId);
  if(!origFeat||!origFeat.stories)return;
  const st=origFeat.stories.find(s=>s.id===storyId);
  if(!st)return;
  const storyType=st.storyType||'traditional';
  const title=(document.getElementById('nsc-edit-title')||{}).value||'';
  const priority=(document.getElementById('nsc-edit-priority')||{}).value||'';
  const ptsRaw=(document.getElementById('nsc-edit-pts')||{}).value;
  const newFeatId=(document.getElementById('nsc-edit-feat')||{}).value||origFeatId;
  if(!title.trim())return;
  if(storyType==='ai_feature'){
    const outcome=(document.getElementById('nsc-edit-outcome')||{}).value||'';
    if(!outcome.trim())return;
    st.detail={
      outcome:outcome.trim(),
      behaviorExpectations:_nscTextToBullets((document.getElementById('nsc-edit-behavior')||{}).value),
      evalScenarios:_nscTextToEvalScenarios((document.getElementById('nsc-edit-evals')||{}).value),
      qualityBar:{
        metrics:_nscTextToMetrics((document.getElementById('nsc-edit-metrics')||{}).value),
        rerunTrigger:((document.getElementById('nsc-edit-rerun')||{}).value||'').trim()
      }
    };
  } else if(storyType==='agentic'){
    const goal=(document.getElementById('nsc-edit-goal')||{}).value||'';
    if(!goal.trim())return;
    st.detail={
      goal:goal.trim(),
      decisionRights:_nscTextToBullets((document.getElementById('nsc-edit-decision-rights')||{}).value),
      guardrails:_nscTextToBullets((document.getElementById('nsc-edit-guardrails')||{}).value),
      escalation:{
        triggers:_nscTextToBullets((document.getElementById('nsc-edit-esc-triggers')||{}).value),
        handoff:_nscTextToBullets((document.getElementById('nsc-edit-esc-handoff')||{}).value)
      },
      acceptanceEnvelope:{
        metrics:_nscTextToMetrics((document.getElementById('nsc-edit-metrics')||{}).value),
        rubrics:_nscTextToEvalScenarios((document.getElementById('nsc-edit-ae-rubrics')||{}).value),
        rerunTrigger:((document.getElementById('nsc-edit-rerun')||{}).value||'').trim()
      }
    };
  } else {
    const stmt=(document.getElementById('nsc-edit-stmt')||{}).value||'';
    if(!stmt.trim())return;
    st.statement=stmt.trim();
    const acRaw=(document.getElementById('nsc-edit-ac')||{}).value||'';
    // Parse AC text back into structured scenarios
    if(acRaw.trim()){
      const blocks=acRaw.trim().split(/\n{2,}/);
      st.scenarios=blocks.map(block=>{
        const lines=block.split('\n').map(l=>l.trim()).filter(Boolean);
        const sc={name:'',given:'',when:'',then:'',and:''};
        let lastField='name';
        lines.forEach(l=>{
          if(/^Scenario:/i.test(l)){sc.name=l.replace(/^Scenario:\s*/i,'');lastField='name';}
          else if(/^Given/i.test(l)){sc.given=l.replace(/^Given\s*/i,'');lastField='given';}
          else if(/^When/i.test(l)){sc.when=l.replace(/^When\s*/i,'');lastField='when';}
          else if(/^Then/i.test(l)){sc.then=l.replace(/^Then\s*/i,'');lastField='then';}
          else if(/^And/i.test(l)){sc.and=l.replace(/^And\s*/i,'');lastField='and';}
          else{
            // Unmatched line — append to last matched field
            if(sc[lastField])sc[lastField]+=' '+l;
            else sc[lastField]=l;
          }
        });
        return sc;
      });
    } else {
      st.scenarios=[];
    }
  }
  st.title=title.trim();
  st.priority=priority||null;
  st.points=ptsRaw?parseInt(ptsRaw):null;
  // Feature reassignment
  if(newFeatId!==origFeatId){
    const newFeat=scCanvas.find(f=>f.id===newFeatId);
    if(newFeat){
      origFeat.stories=origFeat.stories.filter(s=>s.id!==storyId);
      if(!newFeat.stories)newFeat.stories=[];
      newFeat.stories.push(st);
      if(typeof pcMarkStale==='function'){pcMarkStale(origFeatId);pcMarkStale(newFeatId);}
    }
  } else {
    if(typeof pcMarkStale==='function')pcMarkStale(origFeatId);
  }
  document.getElementById('nsc-edit-story-overlay').remove();
  newScRender();
  if(newScPanelStoryId===storyId){
    const targetFeat=scCanvas.find(f=>f.id===newFeatId)||origFeat;
    newScOpenPanel(st,targetFeat);
  }
  showToast('Story updated.','success');
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    // Reassignment marks BOTH the old and new feature+story targets —
    // matches the local pcMarkStale(origFeatId,newFeatId) pattern already
    // used just above. Old-parent-first ordering (already the natural
    // order here) biases any partial-failure window toward "briefly
    // missing" rather than "briefly duplicated", per the confirmed-safe
    // reasoning from design review.
    var _reassigned=(newFeatId!==origFeatId);
    sessionStoreSave(_activeSessionId).then(function(ok){
      if(!ok||typeof _lsMarkManualEdit!=='function')return;
      _lsMarkManualEdit('sc',origFeatId+_LS_SC_TARGET_SEP+storyId);
      if(_reassigned)_lsMarkManualEdit('sc',newFeatId+_LS_SC_TARGET_SEP+storyId);
    });
  }
}
function newScRevealTab(){
  const btn=document.getElementById('tab-sc');
  if(btn)btn.classList.add('revealed');
}

function newScUpdateTabBadge(){
  const badge=document.getElementById('sc-tab-badge');
  if(!badge)return;
  const total=scCanvas.reduce((a,f)=>a+(f.stories?f.stories.filter(s=>s._inSC&&!s._hiddenFromSC).length:0),0);
  badge.textContent=total;
  badge.classList.toggle('on',total>0);
}

// ── SC Export — in-flight state ──
var scExportInFlight=false;
function scSyncExportBtn(){
  var btn=document.getElementById('nsc-export-btn');
  if(!btn)return;
  btn.disabled=!!scExportInFlight;
  btn.innerHTML=scExportInFlight?
    '<i class="ti ti-loader-2" style="font-size:11px;animation:spin 1s linear infinite;" aria-hidden="true"></i> Exporting\u2026':
    '<i class="ti ti-download" style="font-size:11px;" aria-hidden="true"></i> Export';
}
function newScToggleExportDrop(){}
function newScExportPiSelected(){newScExportAll();}
async function newScExportAll(){
  if(scExportInFlight)return;
  var snap=scCanvas.filter(function(f){return f.stories&&f.stories.length>0;});
  if(!snap.length){showToast('No stories to export.','info');return;}
  var productName=typeof getProductCtx==='function'?getProductCtx().name:'Product';
  scExportInFlight=true;scSyncExportBtn();
  try{
    await scDownloadSprintDOCX(snap,productName);
  }catch(err){
    showToast('Export failed: '+err.message,'error');
    console.error('[SC Export]',err);
  }finally{
    scExportInFlight=false;scSyncExportBtn();
  }
}
