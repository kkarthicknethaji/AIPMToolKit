// GUIDED LAUNCH (gl) — v9.15, unified onto mt_sessions in v9.15.02
// Conversational intake flow, second entry path from Home alongside Quick
// Launch. Owns its own tab (#gl-tab). As of v9.15.02, a Guided Launch
// session IS a real mt_sessions row from the moment of creation — the same
// sessionStoreCreate()/sessionStoreSave()/sessionStoreRestore() machinery
// every other canvas uses, not a separate mt_intake_sessions/mt_intake_messages
// pair (those tables are gone — dropped directly against Supabase, per the
// migration). Chat transcript and draft/final brief live in the session's
// own snapshot.gl* keys (see session-store.js's _sessionStoreBuildSnapshot());
// mt_sessions.intake_status ('active'|'completed'|null) drives tab
// visibility (session-store.js's _ssRevealTabs()) and resume routing
// (sessionStoreRestore()'s targetTab==='gl' branch). Finalize hands a
// finalized markdown brief to the existing, unmodified Discovery Map
// generation pipeline via sessionContext.additionalContext (see
// glFinalize()) — no changes to kpi-tree.js's generation path itself.
//
// Entry points: glCreateAndOpen() (called from home.js's homeGuidedLaunch()),
// glApplyRestoredSnapshot() (called from session-store.js's
// sessionStoreRestore()). There is no separate resume function — resuming a
// Guided-Launch-originated session is the same sessionStoreRestore() path
// every other session uses. Everything else here is internal to this file.

// ── State ── (module-scoped globals, mirroring outcome-pulse.js's pattern —
// no dedicated state.js entry since nothing here is read outside this file
// except through the three entry points above)
var glSessionId=null;
var glStatus='active'; // 'active' | 'completed'
var glMessages=[]; // [{role:'user'|'agent', content, attachments}]
var glDraftMd='';
var glFinalMd=null;
var glMdOpen=false;
var glContextHash=null;
var glProductId=null;
var glCompanyId=null;
var glSessionCtx=null; // sessionContext snapshot — company/product profile, docs, approach/mode
var glBusy=false; // true while an AI call is in flight — blocks concurrent sends
var glLastChangedSectionId=null; // one-shot flash target for the next glRenderMdBody()
var glPanelOpen=true; // left panel expand/collapse state (v9.15.01, Items 1-4) — independent of DM's own panelOpen in left-panel.js
// Item 5 (v9.15.04) — plain integer, not a float: incrementing a float by
// 0.01 repeatedly risks binary floating-point drift over many edits (e.g.
// 0.01+0.01+... not landing exactly on 0.03). Stored as a count, formatted
// as "v0.0N" for display only, in _glFormatVersion() below. Starts at 1
// after the opening turn (displayed "v0.01"); increments by 1 on every
// successful revision turn (chat or upload — both go through
// _glRunRevisionTurn()).
var glVersionCount=1;
var _glLeaveConfirmed=false; // one-shot bypass for the leave-confirmation modal's own retry, see blockIfLeavingGuidedLaunch()

// Leave-confirmation modal for an unfinalized Guided Launch session, mid-
// response only (v9.15.04, Item 1 — narrowed from v9.15.03's original
// "fires on any departure while unfinalized," an explicit product reversal:
// leaving an idle unfinalized chat is fine, only leaving mid-agent-response
// warns, matching DM's own aiGenInFlight-gated pattern). Reuses showConfirm()
// (utils.js), the same component DM's "Hold on, don't lose this" modal
// (blockIfGenerating()) uses. Called from api.js's switchTab(), right after
// the existing blockIfGenerating() guard. _glLeaveConfirmed is a one-shot
// bypass flag for the retry after "Leave anyway" — unlike aiGenInFlight,
// glBusy doesn't change on its own after the user confirms (there's no
// in-flight request to abort here), so the retry needs an explicit escape
// hatch or it would re-trigger itself forever.
function blockIfLeavingGuidedLaunch(t){
  if(_glLeaveConfirmed){ _glLeaveConfirmed=false; return false; }
  if(typeof curTab==='undefined'||curTab!=='gl'||t==='gl')return false;
  // v9.15.04, Item 1 — narrowed to mid-response only (glBusy), per explicit
  // reversal of the original "fires on any departure while unfinalized"
  // design: leaving an unfinalized-but-idle chat now navigates freely.
  if(glStatus!=='active'||!glBusy)return false;
  showConfirm(
    "You won't lose your progress. Resume this session anytime from Home. You'll just need to come back and finalize before your Discovery Map can be generated.",
    'Leave this chat?',
    null,
    'Stay here',
    'stay',
    'Leave anyway',
    function(){
      _glLeaveConfirmed=true;
      switchTab(t);
    }
  );
  return true;
}

// ── Reset (v9.15.01, Item 20) ──
// Called by home.js's homeClearSession() — the one shared cleanup function
// every session-transition path already funnels through. Nulls every gl*
// global back to its initial value; does NOT touch #gl-tab's DOM or
// tab-gl's visibility (homeClearSession() does that itself, alongside its
// own equivalent handling for every other tab). Safe to call at any time,
// including when no Guided Launch session was ever active (every field is
// already at its reset value in that case — a no-op).
function glResetState(){
  glSessionId=null;
  glStatus='active';
  glMessages=[];
  glDraftMd='';
  glFinalMd=null;
  glMdOpen=false;
  glContextHash=null;
  glProductId=null;
  glCompanyId=null;
  glSessionCtx=null;
  glBusy=false;
  glLastChangedSectionId=null;
  glPanelOpen=true;
  glVersionCount=1;
}

// Item 5 (v9.15.04) — "v0.01", "v0.02", ... "v1.00" past 100 edits. Display
// only; glVersionCount itself stays a plain integer (see its declaration).
function _glFormatVersion(){
  return 'v'+(glVersionCount/100).toFixed(2);
}

// ── Context-freshness hash ──
// Deliberately simple (not cryptographic) — only needs to detect "did the
// serialized profile change at all," per spec Section 6.4.
function _glHashContext(companyProfile,productProfile){
  var s=JSON.stringify({c:companyProfile||{},p:productProfile||{}});
  var h=0;
  for(var i=0;i<s.length;i++){ h=((h<<5)-h+s.charCodeAt(i))|0; }
  return 'h'+h;
}

// Inline emphasis - **bold** and _italic_ - applied AFTER e() escapes the
// raw text, since * and _ are plain ASCII untouched by HTML-escaping, so
// this ordering is safe. Confirmed via live testing that neither ever
// actually rendered before this: requirement-agent.js's "**Assumed:**"/
// "**Risk:**" prefixes and _RA_EMPTY_SECTION_BODY's "_Yet to be
// discussed_" placeholder were both showing literal asterisks/underscores
// in the UI instead of bold/italic - _glMdToHtml() only ever handled
// block-level structure (headings, bullets, paragraphs), never inline
// markers, for any caller.
function _glInlineMd(text){
  return e(text).replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/_(.+?)_/g,'<em>$1</em>');
}
// ── Minimal markdown -> HTML ──
// No markdown library is loaded anywhere in this app (confirmed via grep) —
// this covers exactly what the AI is instructed to produce (H1/H2/H3,
// paragraphs, "- " bullet lists, **bold**/_italic_ inline). flashHeading,
// when it matches an H2's text (case-insensitive), wraps that section in
// .gl-flash for the one render that follows a revision turn.
function _glMdToHtml(md,flashHeading){
  if(!md)return '';
  var lines=md.split('\n');
  var html='';
  var openList=false;
  var flashOpen=false;
  function closeList(){ if(openList){html+='</ul>';openList=false;} }
  for(var i=0;i<lines.length;i++){
    var line=lines[i];
    var h1=line.match(/^#\s+(.*)/);
    var h2=line.match(/^##\s+(.*)/);
    var h3=line.match(/^###\s+(.*)/);
    var li=line.match(/^[-*]\s+(.*)/);
    if(h2){
      closeList();
      if(flashOpen){ html+='</div>'; flashOpen=false; }
      var isFlash=flashHeading && h2[1].trim().toLowerCase()===String(flashHeading).trim().toLowerCase();
      if(isFlash){ html+='<div class="gl-flash">'; flashOpen=true; }
      html+='<h2>'+_glInlineMd(h2[1])+'</h2>';
      continue;
    }
    if(h1){ closeList(); html+='<h1>'+_glInlineMd(h1[1])+'</h1>'; continue; }
    if(h3){ closeList(); html+='<h3>'+_glInlineMd(h3[1])+'</h3>'; continue; }
    if(li){ if(!openList){html+='<ul>';openList=true;} html+='<li>'+_glInlineMd(li[1])+'</li>'; continue; }
    closeList();
    if(line.trim()===''){ continue; }
    html+='<p>'+_glInlineMd(line)+'</p>';
  }
  closeList();
  if(flashOpen)html+='</div>';
  return html;
}

// ── AI response JSON parsing ──
// Guided Launch's own responses are much smaller/simpler than the Discovery
// Map tree api.js's parseJSON()/repairJSON() are built for — a plain parse
// with a code-fence strip covers the actual failure mode (model wrapping
// JSON in ```json fences despite the system prompt's instruction not to).
function _glParseJSON(txt){
  var clean=(txt||'').replace(/```json|```/g,'').trim();
  try{ return JSON.parse(clean); }catch(e){}
  var first=clean.indexOf('{'), last=clean.lastIndexOf('}');
  if(first>=0&&last>first){
    try{ return JSON.parse(clean.slice(first,last+1)); }catch(e2){}
  }
  return null;
}

// ── Shared model call ──
// Routes through the standard callAPI()/resolveModelDecision() chain in
// Optimized mode (general tier -> Sonnet for Anthropic) rather than a
// hardcoded model string, per the explicit product decision overriding the
// spec's original "hardcode Sonnet" instruction — this way a company on a
// non-Anthropic provider still gets a valid, catalog-checked model.
// extraFields tags mt_ai_usage_events with session_type:'ChatCanvas' so
// Guided Launch's chat-turn costs stay distinguishable from Discovery Map
// generation costs, even though both now share the same real mt_sessions
// row (session_id/product_id here are that same row's own values — see
// api.js/proxy/server.js).
async function _glCallModel(sys,usr){
  var extra={session_id:glSessionId,product_id:glProductId,session_type:'ChatCanvas'};
  return await callAPI(sys,usr,3000,null,null,'guided-launch',null,extra);
}

// ══════════════════════════════════════════════════════════════════════════
// Entry points
// ══════════════════════════════════════════════════════════════════════════

// Called by home.js's homeGuidedLaunch(). v9.15.02 — creates a REAL
// mt_sessions row immediately via the same sessionStoreCreate() every other
// canvas uses (not a second, unrelated table) — this is what gives Guided
// Launch a dashboard card, real left-panel content, and correct tab
// visibility from turn one, and what closes the v9.15.01 cross-session-leak
// class of bug at its root: sessionActive=true here means switchTab('home')'s
// existing guard now reliably fires homeClearSession() -> glResetState() on
// every departure, exactly like every other real session.
// v9.15.03, Items 3+5 fix — parameter renamed from "sessionContext" to "sc":
// the old name shadowed the GLOBAL sessionContext variable for this entire
// function body, so the global was never assigned here. sessionStoreCreate()
// calls _sessionStoreBuildSnapshot() with no arguments, which reads the
// GLOBAL sessionContext for its snapshot.sessionContext key — meaning every
// snapshot saved from the moment of creation (including every chat-turn
// save afterward) persisted a stale/null sessionContext, even though
// in-memory glSessionCtx stayed correct (masking this during the live chat
// itself). On resume, glApplyRestoredSnapshot() reads that corrupted
// snapshot.sessionContext back out — this is the confirmed root cause of
// Item 3 (empty left panel on resume). Explicitly assigning the global here
// mirrors exactly how _homeDoLaunch() already does it for Quick Launch
// (no parameter shadowing there, since it's not passed as an argument).
async function glCreateAndOpen(sc){
  glSessionCtx=sc;
  sessionContext=sc;
  glStatus='active';
  glMessages=[];
  glDraftMd='';
  glFinalMd=null;
  glMdOpen=false;
  glContextHash=_glHashContext(sc.companyProfile,sc.productProfile);

  var id=sessionStoreCreate(sc,{lastTab:'gl',lastStage:'Guided Launch',intakeStatus:'active'});
  glSessionId=id;
  glProductId=(sc.productProfile&&sc.productProfile.id)||null;
  glCompanyId=(function(){ try{ return localStorage.getItem(_PGT_ACTIVE_COMPANY_KEY)||null; }catch(e){ return null; } })();

  sessionActive=true;
  _activeSessionOwnerId=(typeof currentUser!=='undefined'&&currentUser)?currentUser.id:null;

  // _ssSyncTabVisibility() (session-store.js) only runs on RESTORE — a
  // fresh creation reveals its own tab directly, same pattern _homeDoLaunch()
  // already uses for tab-mm.
  var tabBtn=document.getElementById('tab-gl');
  if(tabBtn)tabBtn.style.display='';

  switchTab('gl');
  glRenderShell();
  glRunOpeningTurn();
}

// Called by session-store.js's sessionStoreRestore() whenever the restored
// session's meta.intakeStatus is set (active or completed) — independent of
// which tab is actually landed on (see that call site's own comment): a
// completed session lands on 'mm' but #gl-tab still needs real content the
// moment the user clicks into it. Populates state only; navigation is the
// caller's existing switchTab(targetTab) call, already run by this point.
function glApplyRestoredSnapshot(meta,snapshot){
  glSessionId=(typeof _activeSessionId!=='undefined')?_activeSessionId:null;
  glCompanyId=(function(){ try{ return localStorage.getItem(_PGT_ACTIVE_COMPANY_KEY)||null; }catch(e){ return null; } })();
  glProductId=meta.productId||null;
  glStatus=meta.intakeStatus||'active';
  glMessages=(snapshot&&snapshot.glMessages)||[];
  glDraftMd=(snapshot&&snapshot.glDraftMd)||'';
  glFinalMd=(snapshot&&snapshot.glFinalMd)||null;
  glContextHash=(snapshot&&snapshot.glContextHash)||null;
  glSessionCtx=(snapshot&&snapshot.sessionContext)||null;
  glVersionCount=(snapshot&&snapshot.glVersionCount)||1;
  glMdOpen=true;

  glRenderShell();
  glRenderChatHistory();
  glRenderMdBody();
  glOpenPanel();
  glUpdateFooterState();

  // Freshness check — never silent. Only meaningful while still chatting;
  // a completed session's profile snapshot is intentionally frozen.
  if(glStatus==='active'&&glSessionCtx){
    var freshHash=_glHashContext(glSessionCtx.companyProfile,glSessionCtx.productProfile);
    if(freshHash!==glContextHash){
      glAppendAgentMessage('Your company or product profile was updated since we last talked — want me to refresh the summary with the latest info? Just say so, or keep going as-is.',null,true);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Shell rendering
// ══════════════════════════════════════════════════════════════════════════

function glRenderShell(){
  var root=document.getElementById('gl-tab');
  if(!root)return;

  root.innerHTML=
    // Left panel (v9.15.01 Items 1-4, content source fixed v9.15.02 Item 2):
    // real .left/.ph/.ph-title/.ph-sub/.collapse-btn structure, copied
    // directly from index.html's #left-panel (no shared render function to
    // call instead — left-panel.js only owns togglePanel(), the markup is
    // static per-tab). Body content now calls the SAME
    // _mmBuildSessionSummaryHtml(sc) helper DM's own left panel uses
    // (home.js) — this only became possible once Guided Launch sessions
    // carried a real sessionContext from creation (v9.15.02 unification);
    // previously this was a hand-built lookalike reading only a thin
    // snapshot. glTogglePanel() mirrors togglePanel()'s exact logic, scoped
    // to #gl-left/its own icon ids so it can't interfere with DM's panel.
    '<div class="left gl-left" id="gl-left">'
      +'<div class="ph">'
        +'<div class="ph-text"><div class="ph-title">Requirement Agent</div><div class="ph-sub">Pin down what you\'re building.</div></div>'
        +'<button class="collapse-btn" onclick="glTogglePanel()" title="Toggle panel">'
          +'<svg id="icon-gl-exp" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/><polyline points="21 18 15 12 21 6"/></svg>'
          +'<svg id="icon-gl-col" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:none"><polyline points="9 18 15 12 9 6"/><polyline points="3 18 9 12 3 6"/></svg>'
        +'</button>'
      +'</div>'
      +'<div class="gl-left-body">'
        +(typeof _mmBuildSessionSummaryHtml==='function'?_mmBuildSessionSummaryHtml(glSessionCtx):'')
      +'</div>'
    +'</div>'
    +'<div class="gl-center">'
      +'<div class="gl-chat-hdr">'
        +'<div><div class="gl-chat-hdr-eyebrow">Guided Launch</div><div class="gl-chat-hdr-title" id="gl-status-label">Drafting requirements together</div></div>'
      +'</div>'
      +'<div class="gl-chat-body" id="gl-chat-body"></div>'
      +'<div class="gl-chat-input-wrap">'
        +'<div class="gl-chat-input-row">'
          +'<textarea class="gl-chat-input" id="gl-chat-input" rows="1" placeholder="Type your response..." onkeydown="if(event.key===\'Enter\'&&!event.shiftKey){event.preventDefault();glSendMessage();}"></textarea>'
          +'<button class="gl-chat-send" id="gl-send-btn" onclick="glSendMessage()" title="Send"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg></button>'
        +'</div>'
        +'<div class="gl-upload-chip" id="gl-upload-chip" onclick="if(glStatus===\'active\'&&!glBusy)document.getElementById(\'gl-file-input\').click()" title="Click to select a file to upload">'
          +'<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>'
          +' <span id="gl-upload-chip-text" style="text-decoration:underline;">Upload a document</span><span id="gl-upload-chip-suffix"> to add context anytime</span>'
        +'</div>'
        +'<input type="file" id="gl-file-input" accept=".docx,.pdf,.txt,.xlsx,.csv" style="display:none;" onchange="glHandleUpload(this)">'
      +'</div>'
    +'</div>'
    +'<div class="gl-md-collapsed-rail" id="gl-collapsed-rail" onclick="glOpenPanel()" title="Reopen requirements draft">'
      // Chevron rule: arrow points in the direction the panel recedes
      // toward when collapsing (or, for a reopen affordance like this one,
      // the direction it expands back INTO). This rail expands the panel
      // LEFTWARD, back into view from the right edge, so it needs a
      // left-pointing "<" — points="15 18 9 12 15 6" (vertex at x=9, left
      // of both endpoints at x=15). Item 4 (v9.15.02): the v9.15.01 build
      // had this as points="9 18 15 12 9 6" (vertex at x=15, RIGHT of the
      // endpoints — a ">") and its own comment incorrectly described that
      // shape as "points left." Re-derived from the raw coordinates this
      // time, not re-asserted from the prior comment.
      +'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>'
      +'<div class="gl-md-collapsed-label">REQUIREMENTS DRAFT</div>'
    +'</div>'
    +'<div class="gl-md-panel" id="gl-md-panel">'
      +'<div class="gl-md-hdr">'
        +'<div><div class="gl-md-hdr-eyebrow">Live Draft</div><div class="gl-md-hdr-title" id="gl-md-hdr-title"></div></div>'
        +'<div class="gl-md-hdr-actions">'
          +'<button class="gl-export-btn" onclick="glExportMd()" title="Download the current draft as a .md file"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Export</button>'
          // Chevron rule (v9.15.01): the arrow points in the direction the
          // panel visually recedes toward when collapsing. This is the
          // RIGHT panel — it collapses toward the right edge — so its
          // collapse icon points right (double-right), mirrored from the
          // left panel's double-left convention. Fixed in this cycle
          // (Item 11): was previously copied verbatim from the left panel's
          // glyph, which pointed the wrong way for a right-side panel.
          +'<button class="collapse-btn" onclick="glCollapsePanel()" title="Collapse panel"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/><polyline points="3 18 9 12 3 6"/></svg></button>'
        +'</div>'
      +'</div>'
      +'<div class="gl-md-body" id="gl-md-body"></div>'
      +'<div class="gl-md-footer">'
        +'<button class="gl-finalize-btn" id="gl-finalize-btn" onclick="glFinalize()"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Finalize &amp; Generate</button>'
        +'<div class="gl-footer-note" id="gl-footer-note">Locks your brief and starts Discovery Map generation.</div>'
        // Item 6 (v9.15.03) — visible only when glStatus==='completed', same
        // condition that disables the Finalize button above (both driven
        // from glUpdateFooterState() so they can never disagree). Handles
        // the case where the user finalized then left before generation
        // ever produced gData — reuses the existing "Generation was
        // interrupted" empty state rather than landing on a blank Discovery Map.
        +'<button class="gl-continue-dm-btn" id="gl-continue-dm-btn" style="display:none;" onclick="glContinueToDiscoveryMap()">&#8594; Continue to Discovery Map</button>'
      +'</div>'
    +'</div>';

  glRenderChatHistory();
  glRenderMdBody();
  glUpdateFooterState();
}

// ══════════════════════════════════════════════════════════════════════════
// Chat
// ══════════════════════════════════════════════════════════════════════════

function _glFormatChatText(text){
  return e(text||'').replace(/\n/g,'<br>');
}
function _glUserInitials(){
  var name=(typeof currentUser!=='undefined'&&currentUser)?currentUser.displayName:'';
  return (typeof _avatarInitials==='function')?_avatarInitials(name):'You';
}
function _glBuildBubbleHtml(m){
  var isUser=m.role==='user';
  return '<div class="gl-msg-row '+(isUser?'user':'agent')+'">'
    +'<div class="gl-avatar '+(isUser?'user-av':'agent-av')+'">'+(isUser?e(_glUserInitials()):'AI')+'</div>'
    +'<div class="gl-bubble">'+_glFormatChatText(m.content)+'</div>'
  +'</div>';
}
function glRenderChatHistory(){
  var body=document.getElementById('gl-chat-body');
  if(!body)return;
  body.innerHTML=glMessages.map(_glBuildBubbleHtml).join('');
  body.scrollTop=body.scrollHeight;
}
function glAppendAgentMessage(content,attachments,persist){
  glMessages.push({role:'agent',content:content,attachments:attachments||null});
  var body=document.getElementById('gl-chat-body');
  if(body){ body.insertAdjacentHTML('beforeend',_glBuildBubbleHtml(glMessages[glMessages.length-1])); body.scrollTop=body.scrollHeight; }
  if(persist!==false)_glPersistMessage('agent',content,attachments);
}
function glAppendUserMessage(content){
  glMessages.push({role:'user',content:content,attachments:null});
  var body=document.getElementById('gl-chat-body');
  if(body){ body.insertAdjacentHTML('beforeend',_glBuildBubbleHtml(glMessages[glMessages.length-1])); body.scrollTop=body.scrollHeight; }
  _glPersistMessage('user',content,null);
}
// v9.15.02 — persistence now goes through the same sessionStoreSave()
// every other canvas calls after a mutation (glMessages already updated in
// the live global by the caller before this runs) — replaces the old
// direct mt_intake_messages/mt_intake_sessions table writes entirely, since
// those tables no longer exist. _sessionStoreBuildSnapshot() picks up
// glMessages/glDraftMd/glFinalMd/glContextHash from the live globals.
async function _glPersistMessage(role,content,attachments){
  if(!glSessionId||typeof sessionStoreSave!=='function')return;
  try{ await sessionStoreSave(_activeSessionId); }
  catch(err){ console.warn('[guided-launch] message persist failed',err); }
}
async function _glPersistDraft(){
  if(!glSessionId||typeof sessionStoreSave!=='function')return;
  try{ await sessionStoreSave(_activeSessionId); }
  catch(err){ console.warn('[guided-launch] draft persist failed',err); }
}

function _glSetBusy(busy){
  glBusy=busy;
  var sendBtn=document.getElementById('gl-send-btn');
  var input=document.getElementById('gl-chat-input');
  if(sendBtn)sendBtn.disabled=busy;
  if(input)input.disabled=busy;
  // Item 4 (v9.15.03) — upload chip's onclick already checks glBusy (see
  // glRenderShell()), this is the matching visual state so it stops
  // looking clickable while the agent is thinking, same as send/input above.
  var uploadChip=document.getElementById('gl-upload-chip');
  if(uploadChip)uploadChip.classList.toggle('gl-upload-chip-disabled',busy||glStatus==='completed');
}
// Items 5+7 (v9.15.01) — cc-spin-sm was an orphaned reference to a
// Capability Canvas class that doesn't exist in this file, rendering as a
// stray glyph instead of a spinner. Replaced with a self-contained animated
// indicator (3 pulsing dots, defined entirely in 22-guided-launch.css) plus
// rotating status phrases, cycled here — no streaming, that's an explicit
// future enhancement, out of scope for this cycle.
var _GL_TYPING_PHRASES=['Reading context...','Drafting...','Thinking it through...'];
var _glTypingPhraseTimer=null;
function _glTypingIndicatorHtml(){
  return '<div class="gl-msg-row agent" id="gl-typing-row"><div class="gl-avatar agent-av">AI</div>'
    +'<div class="gl-bubble gl-typing-bubble">'
      +'<div class="gl-typing-dots"><span></span><span></span><span></span></div>'
      +'<span id="gl-typing-phrase">'+_GL_TYPING_PHRASES[0]+'</span>'
    +'</div></div>';
}
function _glShowTyping(){
  var body=document.getElementById('gl-chat-body');
  if(body){ body.insertAdjacentHTML('beforeend',_glTypingIndicatorHtml()); body.scrollTop=body.scrollHeight; }
  var idx=0;
  _glTypingPhraseTimer=setInterval(function(){
    idx=(idx+1)%_GL_TYPING_PHRASES.length;
    var el=document.getElementById('gl-typing-phrase');
    if(el)el.textContent=_GL_TYPING_PHRASES[idx];
  },1800);
}
function _glHideTyping(){
  if(_glTypingPhraseTimer){clearInterval(_glTypingPhraseTimer);_glTypingPhraseTimer=null;}
  var row=document.getElementById('gl-typing-row');
  if(row)row.remove();
}

// Opening turn — fires once, automatically, on a brand-new session.
async function glRunOpeningTurn(){
  if(glStatus!=='active')return;
  _glSetBusy(true);
  _glShowTyping();
  try{
    var built=buildGuidedLaunchOpeningPrompt(glSessionCtx);
    var raw=await _glCallModel(built.sys,built.usr);
    var parsed=_glParseJSON(raw);
    _glHideTyping();
    if(!parsed||!parsed.markdown){
      glAppendAgentMessage('I had trouble putting together an opening summary just now. Try typing a message below and I’ll pick this up from there.',null,true);
      return;
    }
    glDraftMd=parsed.markdown;
    glAppendAgentMessage(parsed.chatReply||'Here’s a starting draft — take a look on the right.',null,true);
    glRenderMdBody();
    _glPersistDraft();
    glOpenPanel();
  }catch(err){
    _glHideTyping();
    console.warn('[guided-launch] opening turn failed',err);
    glAppendAgentMessage('Something went wrong generating the opening summary ('+(err&&err.message?err.message:'unknown error')+'). Type a message below to continue, or refresh and try again.',null,true);
  }finally{
    _glSetBusy(false);
  }
}

async function glSendMessage(){
  if(glBusy||glStatus!=='active')return;
  var input=document.getElementById('gl-chat-input');
  if(!input)return;
  var text=input.value.trim();
  if(!text)return;
  input.value='';
  glAppendUserMessage(text);
  await _glRunRevisionTurn(text,null,null);
}

async function _glRunRevisionTurn(userMessage,uploadedDocText,uploadedDocName){
  _glSetBusy(true);
  _glShowTyping();
  try{
    var built=buildGuidedLaunchTurnPrompt(glSessionCtx,glDraftMd,glMessages.slice(0,-1),userMessage,uploadedDocText,uploadedDocName);
    var raw=await _glCallModel(built.sys,built.usr);
    var parsed=_glParseJSON(raw);
    _glHideTyping();
    if(!parsed||!parsed.markdown){
      glAppendAgentMessage('I couldn’t process that update. Could you rephrase, or try again?',null,true);
      return;
    }
    glDraftMd=parsed.markdown;
    glLastChangedSectionId=parsed.changedSectionHeading||null;
    glVersionCount++; // Item 5 (v9.15.04) — every successful revision, chat or upload
    glAppendAgentMessage(parsed.chatReply||'Updated the draft — take a look.',null,true);
    glRenderMdBody();
    _glPersistDraft();
  }catch(err){
    _glHideTyping();
    console.warn('[guided-launch] revision turn failed',err);
    glAppendAgentMessage('Something went wrong processing that ('+(err&&err.message?err.message:'unknown error')+'). Please try again.',null,true);
  }finally{
    _glSetBusy(false);
  }
}

// ── Mid-chat upload ──
// Extracts text client-side (extractTextFromFile, shared with Home's session
// docs — see utils.js) then feeds it into the SAME revision-turn AI call so
// the model summarizes/merges it into the draft. The raw extracted text is
// never persisted — only the AI's own chatReply/markdown output is stored,
// matching the "no raw file text in draft_md/attachments" acceptance
// criterion.
async function glHandleUpload(inputEl){
  if(typeof currentUserRole!=='undefined'&&currentUserRole==='readonly')return;
  var file=inputEl.files&&inputEl.files[0];
  inputEl.value='';
  if(!file||glBusy||glStatus!=='active')return;

  glAppendUserMessage('Uploaded: '+file.name);
  _glSetBusy(true);
  _glShowTyping();
  try{
    var extractFn=(typeof extractTextFromFile==='function')?extractTextFromFile:function(){return Promise.reject(new Error('extractTextFromFile not available'));};
    var text=await extractFn(file);
    if(!text||!text.trim()){
      _glHideTyping();
      _glSetBusy(false);
      glAppendAgentMessage(file.name+' didn’t have any readable text — try a different file, or tell me about it directly in chat.',null,true);
      return;
    }
    _glHideTyping();
    _glSetBusy(false);
    await _glRunRevisionTurn(null,text,file.name);
  }catch(err){
    _glHideTyping();
    _glSetBusy(false);
    var msg=(err&&err.message==='PASSWORD_PROTECTED')
      ?file.name+' is password-protected — remove the password and re-upload.'
      :'Could not read '+file.name+'.';
    glAppendAgentMessage(msg,null,true);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// MD panel
// ══════════════════════════════════════════════════════════════════════════

// Item 5 (v9.15.04) — "{ProductName} Requirements Brief v0.0N". Called
// wherever the draft/version could have changed (glRenderShell() on first
// build, glRenderMdBody() on every subsequent re-render) rather than only
// at creation, since the title itself isn't rebuilt by those later calls.
function _glUpdateMdTitle(){
  var titleEl=document.getElementById('gl-md-hdr-title');
  if(!titleEl)return;
  var pName=(glSessionCtx&&glSessionCtx.productProfile&&glSessionCtx.productProfile.productName)||'Product';
  titleEl.textContent=pName+' Requirements Brief '+_glFormatVersion();
}

function glRenderMdBody(){
  var body=document.getElementById('gl-md-body');
  if(!body)return;
  _glUpdateMdTitle();
  var md=(glStatus==='completed')?(glFinalMd||glDraftMd):glDraftMd;
  var badge='<span class="gl-status-badge '+(glStatus==='completed'?'gl-status-final':'gl-status-drafting')+'">'+(glStatus==='completed'?'Finalized':'Drafting')+'</span>';
  var hadFlash=!!glLastChangedSectionId;
  body.innerHTML=badge+_glMdToHtml(md,glLastChangedSectionId);
  glLastChangedSectionId=null; // one-shot
  // Item 12 (v9.15.01) — bring the revised section into view; only when a
  // revision turn actually flashed something, not on every render (opening
  // turn, resume, finalize all call this too and have nothing to scroll to).
  if(hadFlash){
    var flashEl=body.querySelector('.gl-flash');
    if(flashEl&&typeof flashEl.scrollIntoView==='function'){
      flashEl.scrollIntoView({behavior:'smooth',block:'center'});
    }
  }
}

function glUpdateFooterState(){
  var btn=document.getElementById('gl-finalize-btn');
  var note=document.getElementById('gl-footer-note');
  var statusLbl=document.getElementById('gl-status-label');
  var isCompletedForFooter=(glStatus==='completed');
  if(btn)btn.disabled=isCompletedForFooter;
  // Item 4 (v9.15.04) — hidden entirely once finalized, not just re-texted;
  // the extra line's height was also throwing off footer alignment across
  // the three panels.
  if(note){
    note.style.display=isCompletedForFooter?'none':'';
    note.textContent='Locks your brief and starts Discovery Map generation.';
  }
  if(statusLbl)statusLbl.textContent=isCompletedForFooter?'Finalized — Discovery Map generation in progress':'Drafting requirements together';
  // Item 6 (v9.15.03) — same condition as the Finalize button's disabled
  // state above, so the two can never disagree.
  var continueBtn=document.getElementById('gl-continue-dm-btn');
  if(continueBtn)continueBtn.style.display=isCompletedForFooter?'block':'none';

  // v9.16 — glSendMessage() already hard-guards glStatus!=='active', this
  // closes the matching visual gap so finalized sessions don't look typeable.
  var chatInput=document.getElementById('gl-chat-input');
  var chatSend=document.getElementById('gl-send-btn');
  if(chatInput)chatInput.disabled=isCompletedForFooter;
  if(chatSend)chatSend.disabled=isCompletedForFooter;

  // Item 10 (v9.15.01) — uploads are a no-op post-finalize at the handler
  // level already (glHandleUpload()'s own glStatus check); this adds the
  // matching visual/interactive disabled state so the chip stops looking
  // clickable once it actually stops doing anything. Item 4 (v9.15.03):
  // also disabled while glBusy — _glSetBusy() applies the same combined
  // condition, this just keeps it correct on calls that don't go through
  // _glSetBusy (e.g. right after a fresh render).
  var uploadChip=document.getElementById('gl-upload-chip');
  var uploadText=document.getElementById('gl-upload-chip-text');
  var uploadSuffix=document.getElementById('gl-upload-chip-suffix');
  var isCompleted=(glStatus==='completed');
  if(uploadChip)uploadChip.classList.toggle('gl-upload-chip-disabled',isCompleted||glBusy);
  if(uploadText)uploadText.textContent=isCompleted?'Session finalized.':'Upload a document';
  if(uploadSuffix)uploadSuffix.textContent=isCompleted?' Uploads closed.':' to add context anytime';
}

// Item 6 (v9.15.03) — only reachable when glStatus==='completed' (button is
// hidden otherwise, per glUpdateFooterState()). If generation genuinely
// never produced gData (user left before it finished), shows the same
// "Generation was interrupted" state sessionStoreRestore() shows on a
// direct resume-to-mm, rather than landing on a silently blank Discovery
// Map — reuses _ssShowInterruptedGenerationState(), does not duplicate it.
function glContinueToDiscoveryMap(){
  if(glStatus!=='completed')return;
  var tabMm=document.getElementById('tab-mm');
  if(tabMm)tabMm.style.display='';
  switchTab('mm');
  if(!gData&&typeof _ssShowInterruptedGenerationState==='function'){
    _ssShowInterruptedGenerationState({sessionContext:glSessionCtx});
  }
}

// Left panel collapse/expand (v9.15.01, Items 1-4) — mirrors left-panel.js's
// togglePanel() exactly, scoped to #gl-left/its own icon ids.
function glTogglePanel(){
  glPanelOpen=!glPanelOpen;
  var left=document.getElementById('gl-left');
  if(left)left.classList.toggle('collapsed',!glPanelOpen);
  var expIcon=document.getElementById('icon-gl-exp');
  var colIcon=document.getElementById('icon-gl-col');
  if(expIcon)expIcon.style.display=glPanelOpen?'block':'none';
  if(colIcon)colIcon.style.display=glPanelOpen?'none':'block';
}

function glOpenPanel(){
  glMdOpen=true;
  var p=document.getElementById('gl-md-panel'); if(p)p.classList.add('open');
  var rail=document.getElementById('gl-collapsed-rail'); if(rail)rail.classList.remove('show');
}
function glCollapsePanel(){
  glMdOpen=false;
  var p=document.getElementById('gl-md-panel'); if(p)p.classList.remove('open');
  var rail=document.getElementById('gl-collapsed-rail'); if(rail)rail.classList.add('show');
}

function glExportMd(){
  var md=(glStatus==='completed')?(glFinalMd||glDraftMd):glDraftMd;
  var blob=new Blob([md||''],{type:'text/markdown'});
  var url=URL.createObjectURL(blob);
  var a=document.createElement('a');
  var pname=(glSessionCtx&&glSessionCtx.productProfile&&glSessionCtx.productProfile.name)||'requirements-brief';
  a.href=url;
  a.download=pname.replace(/[^a-z0-9\-_]+/gi,'-').toLowerCase()+'-requirements-brief.md';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function(){URL.revokeObjectURL(url);},1000);
}

// ══════════════════════════════════════════════════════════════════════════
// Finalize — single, one-way action (no active<->completed reversal)
// ══════════════════════════════════════════════════════════════════════════

async function glFinalize(){
  if(glStatus==='completed'||glBusy)return;
  glStatus='completed';
  glFinalMd=glDraftMd;
  glUpdateFooterState();
  glRenderMdBody();

  // v9.15.02 — the session already exists (created at glCreateAndOpen()
  // time); this UPDATES the same row rather than creating a second,
  // unrelated one. sessionStoreSetIntakeStatus() flips the meta flag
  // locally; the immediately-following sessionStoreSave() persists both
  // that flag and the full snapshot (including glFinalMd, already set
  // above) together, in one immediate write — not deferred to whatever
  // save generate() eventually does on its own.
  if(typeof sessionStoreSetIntakeStatus==='function') sessionStoreSetIntakeStatus(_activeSessionId,'completed');

  glAppendAgentMessage('Great — finalizing the brief and starting Discovery Map generation now.',null,true);

  // Hand off to the existing, unmodified Discovery Map generation pipeline —
  // the finalized markdown rides in sessionContext.additionalContext, the
  // same channel every prompts.js builder already reads (buildTreePrompt()
  // etc.), rather than any change to the generation prompts themselves.
  var ctx=Object.assign({},glSessionCtx);
  ctx.additionalContext=((ctx.additionalContext||'')+'\n\nGuided Launch requirements brief:\n'+glFinalMd).trim();
  sessionContext=ctx;

  if(typeof sessionStoreSave==='function'){
    await sessionStoreSave(_activeSessionId);
  }

  var lock=document.getElementById('home-tab-lock');
  if(lock)lock.style.display='none';
  var tabMm=document.getElementById('tab-mm');
  if(tabMm)tabMm.style.display='';

  switchTab('mm');
  if(typeof generate==='function')generate();
}
