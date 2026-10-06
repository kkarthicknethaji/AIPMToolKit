// REQUIREMENT AGENT (ra) — Discovery-First Entry Point redesign
// Global, session-scoped, MULTI-conversation requirements agent — distinct
// from the pre-existing "Guided Launch" chat (rebranded to the tab label
// "Requirement Agent" in a prior v9.16 commit on this same file tree — see
// index.html's #tab-gl comment; that is a copy-only rename of an unrelated,
// single-conversation, pre-Discovery-Map intake flow and is NOT this
// module). One conversation here = one release scope, symmetric across
// every capability it touches from turn one. Unlike Guided Launch (one
// mt_sessions row per conversation), every Requirement Agent conversation
// lives inside the snapshot of the ONE already-active session — see
// state.js's raConversations[] and session-store.js's
// _sessionStoreBuildSnapshot()/_ssApplySnapshotFields().
//
// Value chain (Discovery-First Entry Point redesign): Discovery Map ->
// "Define Requirements" CTA (RA on only) -> Requirement Agent (this file,
// Pass 1 greenfield / Pass 2 iterative) -> Finalize Brief (atomic: lock
// content, assign next RQ number, CREATE capabilities only — no feature
// generation here, see raRunFinalizeSequence()) -> Capability Canvas
// (auto-populated, PM clicks "Generate Features" per capability as today,
// grounded in the intake brief) -> Feature Canvas -> Story Canvas -> PI
// Canvas. RA is no longer entered from Capability Canvas at all.
//
// Chat primitives (.gl-msg-row/.gl-avatar/.gl-bubble/_glFormatChatText) are
// reused verbatim from guided-launch.js, per this build's explicit
// instruction — not reimplemented here.

// ══════════════════════════════════════════════════════════════════════════
// Reset (mirrors guided-launch.js's glResetState(), called from the same
// call site in home.js's homeClearSession())
// ══════════════════════════════════════════════════════════════════════════
// v14 product decision (post-v9.27 review) — NON-destructive. Resets only
// RA's in-memory/UI view; never touches the database, never removes a
// document. Used whenever a session is being LEFT/paused, not permanently
// destroyed — home.js's homeClearSession() (New Session, product change,
// load demo, resume a different session) calls THIS, not raResetState()
// below. The outgoing session's own sessionStoreSave() call (which runs
// before this, inside homeClearSession()) already persisted its real
// conversations and documents intact, so this function only needs to blank
// the view for whatever comes next.
function raClearInMemoryState(){
  // v9.24.02 — a mic session left listening must not survive into whichever
  // session is opened next. This is the SOLE cleanup point that fires during
  // homeClearSession()'s live-sync kickout path (home.js wipes #ra-tab's
  // innerHTML BEFORE calling this — raRenderCenter()'s own guard never runs
  // in that path) — verified by reading homeClearSession() directly, not
  // assumed. abort(), not stop(): a stray final result landing after the
  // session was "cleared" would write into whatever textarea DOM happens to
  // exist next, which could belong to a different session entirely.
  // voiceStopActive() is a safe no-op if this surface isn't the active one.
  voiceStopActive('abort');
  // v9.25 code-review fix — _raChatDraftByConvId/_raLastRenderedConvId
  // otherwise survive a session clear indefinitely (this state is never
  // persisted, only bounded by page reload). Not a live bug today — by the
  // time raRenderCenter() next runs, #ra-tab has already been wiped by
  // homeClearSession(), so _raCaptureChatDraft() finds nothing to capture
  // regardless of the stale conversation id — but it's unbounded growth
  // across repeated clears in one long-lived tab, and a latent trap for
  // whichever future change adds per-conversation delete or ever reuses an
  // id from _raUid()'s generation scheme.
  _raChatDraftByConvId={};
  _raLastRenderedConvId=null;
  // v14 code-review fix — same unbounded-growth-across-clears reasoning as
  // _raChatDraftByConvId above; this is view-scoped, per-conversation
  // cache state, not something that should survive past whichever
  // conversations are about to disappear.
  _raDocsExistCache={};
  // Item 3 code-review fix — same reasoning as _raChatDraftByConvId above,
  // missed when the staged-upload map was first added: without this, a
  // staged-but-unsent document's full extracted text stays resident in
  // memory under a now-gone conversation id indefinitely (bounded only by
  // page reload), contradicting this map's own stated design intent of
  // never letting an ephemeral upload survive past its conversation.
  _raStagedUploadByConvId={};
  // Confirmed pre-existing bug (predates the Discovery-First redesign):
  // this used to hardcode raEnabled=false unconditionally, so every
  // session relaunch after the first one in a browser tab reset raEnabled
  // to false with nothing to resync it from appSettings.featRA before
  // Discovery Map's own CTA render (kpi-tree.js's renderDiagnosticActionBar())
  // ran — showing "Continue to Capability Canvas" instead of "Define
  // Requirements" even when the Requirement Agent feature module is on.
  // raEnabled reflects the global Settings toggle, not per-session state,
  // so a session reset must resync it from the authoritative source
  // (appSettings.featRA) rather than hardcode a default.
  raEnabled=(typeof appSettings!=='undefined'&&appSettings)?!!appSettings.featRA:false;
  raConversations=[];
  raLastOpenConversationId=null;
  raActiveConversationId=null;
  raBusy=false;
}

// DESTRUCTIVE — product decision (post-v9.27 review): reachable ONLY from a
// genuine, permanent reset of this session's RA state. Today that's
// kpi-tree.js's generateConfirmed() (Regenerate Discovery Map) alone — NOT
// home.js's homeClearSession(), which calls raClearInMemoryState() above
// instead (an earlier build of this feature called this function from both,
// on the mistaken premise that every raConversations wipe is equally
// permanent; it isn't — a New Session/session-switch is a pause, and its
// documents must survive for later resume).
//
// p_sessionId (optional) — the caller's own session id, captured by the
// CALLER before any of its own state resets could null the global
// _activeSessionId. Falls back to the live global for a caller like
// generateConfirmed(), which never nulls it before this function runs.
//
// Cleans up documents belonging to every conversation about to disappear
// BEFORE clearing raConversations (and before that clear is persisted) —
// these conversation ids are only valid to operate against right now, while
// they still exist in the database's current snapshot; once gone,
// _ra_is_authorized() permanently and correctly blocks every document RPC
// from ever touching them again. Best-effort per conversation: a failure is
// logged and skipped, never thrown — the opportunistic
// ra_purge_orphaned_documents() call (see raOnTabEnter()) is the self-
// healing backstop for anything this pass misses.
async function raResetState(p_sessionId){
  var _rrsSessionId=p_sessionId||((typeof _activeSessionId!=='undefined')?_activeSessionId:null);
  if(_rrsSessionId&&typeof _pgtRpc==='function'){
    // v14 code-review fix — snapshot BEFORE the async loop starts, and
    // iterate the snapshot only. raConversations is a live global; reading
    // it fresh on every loop iteration across several awaits risked skipping
    // or double-processing a conversation if anything else mutated it
    // concurrently (e.g. a rename, or another reset firing) mid-loop.
    var _rrsSnapshot=raConversations.slice();
    // v14 code-review fix (efficiency) — parallelized ACROSS conversations,
    // sequential only WITHIN one. sql/ra-doc-chunks.sql's advisory lock key
    // is hashtext(conversation_id)-scoped, so different conversations never
    // contend with each other and gain nothing from being serialized; this
    // turned an O(total documents across every conversation) sequential
    // chain — which generateConfirmed() (kpi-tree.js) now awaits, blocking
    // Regenerate Discovery Map from continuing — into O(the single slowest
    // conversation's own document count). Removals WITHIN one conversation
    // MUST stay sequential: they share that conversation's lock, and
    // ra_remove_document()'s own pg_try_advisory_xact_lock is a non-
    // blocking try-lock that would fail a concurrent second call outright,
    // not queue behind it.
    await Promise.all(_rrsSnapshot.map(function(_rrsConv){
      var _rrsConvId=_rrsConv.id;
      return (async function(){
        try{
          var _rrsListRes=await _pgtRpc('ra_list_documents',{p_session_id:_rrsSessionId,p_conversation_id:_rrsConvId});
          if(_rrsListRes&&_rrsListRes.error)throw _rrsListRes.error;
          var _rrsDocs=(_rrsListRes&&_rrsListRes.data)||[];
          for(var _rrsJ=0;_rrsJ<_rrsDocs.length;_rrsJ++){
            var _rrsRemoveRes=await _pgtRpc('ra_remove_document',{p_session_id:_rrsSessionId,p_conversation_id:_rrsConvId,p_doc_id:_rrsDocs[_rrsJ].doc_id});
            if(_rrsRemoveRes&&_rrsRemoveRes.error)console.warn('[requirement-agent] raResetState: failed to remove document',_rrsDocs[_rrsJ].doc_id,_rrsRemoveRes.error);
          }
        }catch(err){
          console.warn('[requirement-agent] raResetState: document cleanup failed for conversation '+_rrsConvId+' — relying on ra_purge_orphaned_documents() to catch it later',err);
        }
      })();
    }));
  }
  raClearInMemoryState();
}

// ══════════════════════════════════════════════════════════════════════════
// Small helpers
// ══════════════════════════════════════════════════════════════════════════
// v14 code-review fix (post-v9.27 review) — RA is owner-only by product
// decision, stricter than the general canEditSession() (which also returns
// true for a shared session's OTHER edit-mode collaborator, not just its
// owner). Without this, a non-owner editor could see RA's composer and
// action buttons render as usable, while every underlying RPC's own DB-side
// authorization (session ownership, scoped by mt_sessions.user_id) rejected
// them anyway — "the button works but every call fails" is a worse failure
// mode than the button never rendering. Every gate in THIS file uses this,
// never bare canEditSession() — canEditSession() itself is untouched and
// stays correct for every other surface that calls it directly.
//
// v14 code-review fix (round 4, reuse) — the ownership comparison itself
// is now session-store.js's shared _ssIsSessionOwner() primitive, not a
// third hand-copy of the same three-variable check already duplicated
// there twice (hdrApplySessionNameVisibility()/hdrRenameSession()). Those
// two fail OPEN on unknown ownership (legacy-record compatibility); RA has
// no such legacy gap, so this fails CLOSED (=== true, not !== false) —
// same deliberate divergence as before, just expressed through the shared
// primitive instead of re-deriving it.
function _raCanEditOwner(){
  if(typeof canEditSession==='function'&&!canEditSession())return false;
  // Private (non-shared) session: canEditSession() already returning true
  // here means "I own it" — RLS never lets a non-owner load a private
  // session at all, matching canEditSession()'s own line for this exact case.
  if(typeof _activeSessionIsShared==='undefined'||_activeSessionIsShared!==true)return true;
  return (typeof _ssIsSessionOwner==='function')&&_ssIsSessionOwner()===true;
}

// Escapes literal control characters (newline/CR/tab) but ONLY while inside
// a JSON string value - tracks quote/escape state char-by-char so it never
// touches real structural whitespace between tokens. Confirmed root cause
// of the recurring "I couldn't process that update" failures: liveDraftMd
// is multi-line markdown, and the model occasionally emits a literal
// newline inside that JSON string value instead of an escaped "\n", which
// JSON.parse rejects outright ("Bad control character in string literal").
// A no-op on already-valid JSON (including strings with real backslashes
// or escaped quotes) - verified against both known-good and known-bad
// samples before use here.
function _raSanitizeJsonControlChars(s){
  var out='',inStr=false,esc=false;
  for(var i=0;i<s.length;i++){
    var ch=s[i];
    if(esc){out+=ch;esc=false;continue;}
    if(ch==='\\'){out+=ch;if(inStr)esc=true;continue;}
    if(ch==='"'){inStr=!inStr;out+=ch;continue;}
    if(inStr){
      if(ch==='\n'){out+='\\n';continue;}
      if(ch==='\r'){out+='\\r';continue;}
      if(ch==='\t'){out+='\\t';continue;}
    }
    out+=ch;
  }
  return out;
}
function _raParseJSON(txt){
  var clean=(txt||'').replace(/```json|```/g,'').trim();
  try{ return JSON.parse(clean); }catch(e){}
  var first=clean.indexOf('{'), last=clean.lastIndexOf('}');
  if(first>=0&&last>first){
    var sliced=clean.slice(first,last+1);
    try{ return JSON.parse(sliced); }catch(e2){}
    // Trailing comma right before the JSON blob's own final closing brace -
    // scoped to only the last few characters, never a global replace, so
    // it can't touch a comma sitting inside liveDraftMd's markdown prose.
    var trimmedEnd=sliced.replace(/,\s*\}\s*$/,'}');
    if(trimmedEnd!==sliced){
      try{ return JSON.parse(trimmedEnd); }catch(e3){}
    }
    // Last resort — repair unescaped control characters inside string
    // values (see _raSanitizeJsonControlChars comment above), then retry
    // both the plain slice and the trailing-comma-trimmed variant.
    var sanitized=_raSanitizeJsonControlChars(sliced);
    if(sanitized!==sliced){
      try{ return JSON.parse(sanitized); }catch(e4){}
      var sanitizedTrimmed=sanitized.replace(/,\s*\}\s*$/,'}');
      if(sanitizedTrimmed!==sanitized){
        try{ return JSON.parse(sanitizedTrimmed); }catch(e5){}
      }
    }
  }
  return null;
}
// First name of the logged-in user, for the opening-turn greeting. Mirrors
// guided-launch.js's _glUserInitials() pattern (reads currentUser.displayName)
// but takes the first whitespace-delimited token instead of initials.
function _raFirstName(){
  var name=(typeof currentUser!=='undefined'&&currentUser)?(currentUser.displayName||''):'';
  var first=name.trim().split(/\s+/)[0];
  return first||'there';
}
// Dedupe openQuestions text before mapping to tracked objects — a safety
// net against the model returning a duplicate/near-duplicate question
// (confirmed contributor to the "modal count doesn't match visible chat
// questions" bug: a duplicate entry inflates openQuestions.length without
// a second visible numbered item in chatReply). Case/whitespace-insensitive.
function _raDedupeQuestions(arr){
  var seen={};
  return (arr||[]).filter(function(q){
    var k=String(q||'').trim().toLowerCase();
    if(!k||seen[k])return false;
    seen[k]=true;
    return true;
  });
}
// Defensive parse of the model's clarifyingQuestions field (prompts.js's
// _raClarifyingQuestionsRules()) into the shape _raQuickReplyHtml() renders.
// Mirrors _raDedupeQuestions()'s defensive style, but operates on richer
// {question,targetSection,options} objects rather than plain strings, so
// it can't reuse that helper directly. Drops any entry missing question/
// targetSection, clamps options to 2-4, caps the whole array to 1 entry -
// confirmed via live testing that the model returned 2 questions on an
// opening turn despite the prompt's own "never more than 1 per turn" rule,
// so this is the actual enforcement point, not the prompt text.
function _raSanitizeClarifyingQuestions(arr){
  return (arr||[]).filter(function(q){
    return q&&typeof q==='object'&&String(q.question||'').trim()&&String(q.targetSection||'').trim()&&Array.isArray(q.options)&&q.options.length>=2;
  }).map(function(q){
    return {
      question:String(q.question).trim(),
      targetSection:String(q.targetSection).trim(),
      options:q.options.map(function(o){return String(o||'').trim();}).filter(Boolean).slice(0,4)
    };
  }).filter(function(q){return q.options.length>=2;}).slice(0,1);
}
// Client-side backstop for the PM opt-out (prompts.js's
// _raClarifyingQuestionsRules() STEP 1) — confirmed via live testing that
// the model can say "Noted - I will not offer choices" in chatReply while
// still populating clarifyingQuestions in the SAME JSON response, so the
// prompt instruction alone is not reliable enough on its own. Once any
// message in this conversation matches, conv.raQuestionsOptedOut is set
// and _raRunTurn()/raRunOpeningTurn() force clarifyingQuestions to empty
// from then on regardless of what the model returns, guaranteeing the PM's
// request is honored even if the model slips again.
function _raDetectsQuestionsOptOut(text){
  return /\b(don'?t|do not|stop|no more)\b[^.!?\n]{0,40}\b(ask|question|choice|option)/i.test(text||'')
    || /\bi(?:'?ll| will) (just )?tell you\b/i.test(text||'')
    || /\bwithout (choices|options)\b/i.test(text||'');
}

// ══════════════════════════════════════════════════════════════════════════
// Section-patch merge (live PM feedback fix — was "return the FULL draft
// every turn", confirmed the actual cause of both the opening-turn
// hallucination bug (the model had to invent something for every one of
// 11 sections just to have a complete document to hand back) and the
// 30-90s-per-turn latency (regenerating the entire document from scratch
// every single turn, even for a one-line answer). Now the model only
// returns sectionUpdates for what it actually has real content for
// (prompts.js's buildRequirementAgentTurnPrompt()/DMOpeningPrompt()); the
// client owns the document's structure entirely — numbering, headings, and
// the placeholder text for anything never yet discussed — so the model
// never needs to touch, or even see the exact heading format of, a section
// it isn't updating.
// ══════════════════════════════════════════════════════════════════════════

// Single source of truth for the 11 canonical section names, in order —
// must stay a bare name (no numbering) since _raBuildDraftMd() is the only
// place that ever writes "## N. Name". The model refers to these same 11
// bare names via prompts.js's "section" field.
var _RA_SECTION_NAMES=['Requirement Summary','Problem Statement','Success Criteria','Capabilities','Features','Target Users','User Journeys','Non-Functional Requirements','Out of Scope','Assumptions','Open Questions'];
// Shown for any section with no real content yet — deliberately reads as a
// placeholder, not a guess dressed up as an answer, so a PM never mistakes
// "nothing written" for "the AI looked and found nothing."
var _RA_EMPTY_SECTION_BODY='_Yet to be discussed_';

// Parses an existing liveDraftMd string (as produced by _raBuildDraftMd()
// below) back into a {name: body} map, keyed by the bare canonical name.
// Tolerates a missing/empty string (the opening turn's conv.liveDraftMd
// starts as '') by simply returning {} — every section then falls back to
// the empty-body placeholder in _raBuildDraftMd(). Heading match tolerates
// an optional "N. " numeric prefix, matching the same convention already
// used by _raParseTouchedCapabilities()/_raParseFeatureNarratives() below.
function _raSplitSectionsMd(md){
  var out={};
  if(!md)return out;
  var lines=md.split('\n');
  var current=null,buf=[];
  function flush(){
    if(current)out[current]=buf.join('\n').replace(/^\n+|\n+$/g,'');
    buf=[];
  }
  for(var i=0;i<lines.length;i++){
    var line=lines[i];
    var m=line.match(/^##\s*(?:\d+\.\s*)?(.+?)\s*$/);
    var matchedName=null;
    if(m){
      var candidate=m[1].trim();
      for(var j=0;j<_RA_SECTION_NAMES.length;j++){
        if(_RA_SECTION_NAMES[j].toLowerCase()===candidate.toLowerCase()){matchedName=_RA_SECTION_NAMES[j];break;}
      }
    }
    if(matchedName){
      flush();
      current=matchedName;
      continue;
    }
    if(current)buf.push(line);
  }
  flush();
  return out;
}

// Rebuilds the full liveDraftMd string from a {name: body} map, in
// canonical order, synthesizing every heading (numbering can never drift
// since the client generates it, never the model) and the H1 title from
// conv.title (removing the old latent risk of the model's own embedded H1
// disagreeing with conv.title, back when the model wrote the whole doc).
// Any name missing from sectionBodyMap gets _RA_EMPTY_SECTION_BODY, so the
// PM always sees an explicit "not yet discussed" rather than a blank gap.
function _raBuildDraftMd(title,sectionBodyMap){
  var map=sectionBodyMap||{};
  var lines=['# '+(title||'Requirements Brief'),''];
  _RA_SECTION_NAMES.forEach(function(name,i){
    lines.push('## '+(i+1)+'. '+name);
    lines.push('');
    lines.push((map[name]&&String(map[name]).trim())?String(map[name]).trim():_RA_EMPTY_SECTION_BODY);
    lines.push('');
  });
  return lines.join('\n').replace(/\n+$/,'\n');
}

// The actual merge step, called once per turn. Splits whatever's currently
// stored, defensively validates and overlays each update (case-insensitive
// name match, tolerating a stray "## N. " prefix if the model includes one
// despite being told not to — same defensive posture as
// _raSanitizeClarifyingQuestions() above; unrecognized names are dropped
// with a console.warn rather than silently eaten, so a real prompt/model
// mismatch is visible in the console instead of just quietly losing
// content), then rebuilds. A section never named in sectionUpdates simply
// keeps whatever was already in the map (or the placeholder if it was
// never there) - this is the whole point, the model only pays for what it
// actually changes.
function _raApplySectionUpdates(conv,sectionUpdates){
  var map=_raSplitSectionsMd(conv&&conv.liveDraftMd);
  (sectionUpdates||[]).forEach(function(u){
    if(!u||typeof u!=='object')return;
    var rawName=String(u.section||'').trim().replace(/^#{1,6}\s*(?:\d+\.\s*)?/,'');
    if(!rawName)return;
    // u.body===undefined/null means the model sent no body at all for this
    // entry - not a real update, drop it. An explicit body:"" IS a real
    // update (a deliberate clear-to-placeholder, e.g. openQuestions just
    // emptied out) and must be applied, not treated the same as "no update".
    if(u.body===undefined||u.body===null)return;
    var body=String(u.body).trim();
    var matched=null;
    for(var i=0;i<_RA_SECTION_NAMES.length;i++){
      if(_RA_SECTION_NAMES[i].toLowerCase()===rawName.toLowerCase()){matched=_RA_SECTION_NAMES[i];break;}
    }
    if(!matched){console.warn('[requirement-agent] sectionUpdates: unrecognized section name, dropped',u.section);return;}
    // Empty-body clearing is scoped to "Open Questions" only - the one
    // section the prompt is actually instructed to send body:"" for (see
    // prompts.js's "CRITICAL - openQuestions consistency" rule). Any OTHER
    // section with an empty/whitespace-only body is dropped exactly like
    // the old behavior (safe no-op, keeps existing content) instead of
    // wiping real PM-written content because of a malformed/hallucinated
    // turn that sent an empty body for the wrong section.
    if(!body&&matched!=='Open Questions'){console.warn('[requirement-agent] sectionUpdates: empty body for non-Open-Questions section, dropped',matched);return;}
    if(!body)console.warn('[requirement-agent] sectionUpdates: empty body for section, clearing to placeholder',matched);
    map[matched]=body;
  });
  return _raBuildDraftMd(conv&&conv.title,map);
}

// Parse the Live Draft's "## 4. Capabilities" section into structured
// {key,name,isNew} entries. This is the ONLY source of truth for
// conv.touchedCapabilityKeys — the model returns capability info solely as
// markdown sub-headings inside liveDraftMd (see buildRequirementAgent*
// Prompt()'s "(existing)"/"(will be created)" tagging rule in prompts.js),
// never as a separate structured field. Without this parser,
// touchedCapabilityKeys stays permanently empty and raRunFinalizeSequence()
// has nothing to iterate over (confirmed root cause of Finalize being a
// silent no-op — capStore/scCanvas never receive any writes).
//
// Bucketing fix (QA issue #10): a "will be created" tag now optionally
// carries "— under: <Metric/Process Area Name>" — the specific EXISTING
// Discovery Map metric/process area this capability belongs under, or (if
// none genuinely fits) a specific, real proposed name for a new one —
// never a generic placeholder. Finalize resolves this name against the
// real Discovery Map tree itself (see _raResolveExistingMetricBucket()) —
// the model doesn't need to self-classify existing-vs-new correctly, it
// only needs to name the target; Finalize's own lookup decides.
// QA issue #1 — also captures the descriptive bullet text under each
// capability's sub-heading (the "what changes for that capability in this
// release" list _raSectionContentRules() already requires the model to
// write), as `description`. Used at Finalize time as the new capability's
// `.why` field instead of a generic "Created by Requirement Agent for this
// release." placeholder.
function _raParseTouchedCapabilities(md){
  var lines=(md||'').split('\n');
  var inSection=false;
  var out=[];
  var seen={};
  var current=null;
  var descLines=[];
  function _flushDesc(){
    if(current&&descLines.length)current.description=descLines.join(' ').replace(/\s+/g,' ').trim();
    descLines=[];
  }
  for(var i=0;i<lines.length;i++){
    var line=lines[i];
    if(/^##\s*(?:\d+\.\s*)?Capabilities\s*$/i.test(line)){inSection=true;continue;}
    if(inSection&&/^##\s+/.test(line)){break;} // next top-level "## " section ends it
    if(!inSection)continue;
    var m=line.match(/^#{2,6}\s*\**\s*(.+?)\s*\**\s*\((existing|will be created)(?:\s*[—-]\s*under:\s*(.+?))?\)\s*$/i);
    if(m){
      _flushDesc();
      var name=m[1].trim().replace(/^\**|\**$/g,'').trim();
      if(!name){current=null;continue;}
      var isNew=/will be created/i.test(m[2]);
      var dedupeKey=name.toLowerCase();
      if(seen[dedupeKey]){current=null;continue;}
      seen[dedupeKey]=true;
      current={key:name,name:name,isNew:isNew,bucketMetricName:m[3]?m[3].trim():null,description:null};
      out.push(current);
      continue;
    }
    var bullet=line.match(/^\s*[-*]\s+(.+)$/);
    if(bullet&&current&&descLines.length<2){ // first 1-2 bullets are enough for a concise .why
      descLines.push(bullet[1].trim());
    }
  }
  _flushDesc();
  return out;
}
// Parse the Live Draft's "## 5. Features" section into per-
// capability feature detail: {name, isNew, narrative}. Extends the same
// exact-copy tagging convention _raParseTouchedCapabilities() already keys
// off ("(existing)"/"(will be created)" on capability sub-headings) down to
// the feature level — each feature bullet is tagged "(new feature)" or
// "(existing feature)", followed by a colon and the requirement narrative
// the PM actually described (specific behaviors, edge cases, operational
// definitions), never just a restatement of the feature name. Without this,
// the brief only ever captures a table of contents, never the substance
// needed to ground feature-generation (buildRAFeatureGenPrompt(), §6.5) or
// story-generation (scBuildStoryPrompt(), §10) once Finalize creates the
// capability shell but no features.
function _raParseFeatureNarratives(md){
  var lines=(md||'').split('\n');
  var inSection=false;
  var currentCap=null;
  var out={}; // capName.toLowerCase() -> [{name,isNew,narrative}]
  for(var i=0;i<lines.length;i++){
    var line=lines[i];
    if(/^##\s*(?:\d+\.\s*)?Features\s*$/i.test(line)){inSection=true;continue;}
    if(inSection&&/^##\s+/.test(line)){break;}
    if(!inSection)continue;
    var capHead=line.match(/^#{2,6}\s*\**\s*(.+?)\s*\**\s*$/);
    if(/^#{3,6}\s/.test(line)&&capHead){
      currentCap=capHead[1].trim().replace(/^\**|\**$/g,'').trim();
      if(currentCap&&!out[currentCap.toLowerCase()])out[currentCap.toLowerCase()]=[];
      continue;
    }
    if(!currentCap)continue;
    var fm=line.match(/^-\s*\**\s*(.+?)\s*\**\s*\((new|existing)\s+feature\)\s*:\s*(.*)$/i);
    if(fm){
      out[currentCap.toLowerCase()].push({name:fm[1].trim(),isNew:/^new$/i.test(fm[2]),narrative:fm[3].trim()});
    }
  }
  return out;
}
// Return the requirement-narrative detail this conversation's brief
// captured for a single capability — used as the targeted, per-capability
// extraction §6.5 and §10 both require instead of passing the entire
// liveDraftMd blob into a generation prompt. Includes the capability's
// feature list (name/new-or-existing/narrative) plus the release-level
// Success Criteria section (shared across all capabilities this brief
// touches — there is no per-capability split for that section).
function _raGetCapabilityBriefExcerpt(conv,capName){
  if(!conv||!conv.liveDraftMd||!capName)return'';
  var md=conv.liveDraftMd;
  var feats=(_raParseFeatureNarratives(md)[capName.toLowerCase()])||[];
  var parts=[];
  if(feats.length){
    parts.push('Feature detail captured for "'+capName+'" during this release\'s Requirement Agent conversation:\n'+feats.map(function(f){
      return '- '+f.name+' ('+(f.isNew?'new':'existing')+')'+(f.narrative?(': '+f.narrative):'');
    }).join('\n'));
  }
  var successCriteria=_raExtractSection(md,'Success Criteria');
  if(successCriteria)parts.push('Release success criteria:\n'+successCriteria);
  return parts.join('\n\n');
}
// Extract one "## <headingText>" section's body (everything up to the next
// "## " heading) from a liveDraftMd blob. Small shared helper for the
// targeted-extraction requirement in §6.5/§10 — never used to pass the
// whole document, only a single named section. headingText is the bare
// section name (e.g. "Success Criteria") — the numbered-heading prefix
// ("## 3. Success Criteria") is matched via the optional (?:\d+\.\s*)?
// group below, so callers never need to know/pass the current number.
function _raExtractSection(md,headingText){
  var lines=(md||'').split('\n');
  var re=new RegExp('^##\\s*(?:\\d+\\.\\s*)?'+headingText.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\s*$','i');
  var inSection=false;
  var out=[];
  for(var i=0;i<lines.length;i++){
    var line=lines[i];
    if(re.test(line)){inSection=true;continue;}
    if(inSection&&/^##\s+/.test(line))break;
    if(inSection)out.push(line);
  }
  return out.join('\n').trim();
}
function _raUid(){
  return 'ra_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8);
}
function _raFindConv(id){
  return raConversations.find(function(c){return c.id===id;})||null;
}
function _raActiveConv(){
  return raActiveConversationId?_raFindConv(raActiveConversationId):null;
}
function _raRqLabel(n){
  // Zero-padded to 2 digits, e.g. "RQ02" — per spec, never re-derived or
  // reused once assigned.
  var s=String(n);
  return 'RQ'+(s.length<2?('0'+s):s);
}
function _raRelTime(iso){
  if(!iso)return'';
  var ms=Date.now()-new Date(iso).getTime();
  if(ms<0)ms=0;
  var mins=Math.round(ms/60000);
  if(mins<1)return'just now';
  if(mins<60)return mins+' min ago';
  var hrs=Math.round(mins/60);
  if(hrs<24)return hrs+' hour'+(hrs!==1?'s':'')+' ago';
  var days=Math.round(hrs/24);
  return days+' day'+(days!==1?'s':'')+' ago';
}
// Reuses guided-launch.js's markdown renderer verbatim — same subset of
// markdown (H1/H2/H3, paragraphs, "- " bullets) the AI is instructed to
// produce in both modules' prompts.
function _raMdToHtml(md){
  if(typeof _glMdToHtml==='function')return _glMdToHtml(md,null);
  return '<pre style="white-space:pre-wrap;">'+e(md||'')+'</pre>';
}

// ══════════════════════════════════════════════════════════════════════════
// Session-resume entry point (called from session-store.js's
// sessionStoreRestore(), independent of targetTab — same reasoning as
// glApplyRestoredSnapshot())
// ══════════════════════════════════════════════════════════════════════════
function raApplyRestoredSnapshot(s){
  raConversations=(s&&s.raConversations)||[];
  raLastOpenConversationId=(s&&s.raLastOpenConversationId)||null;
  raActiveConversationId=raLastOpenConversationId&&_raFindConv(raLastOpenConversationId)?raLastOpenConversationId:null;
  // Render happens lazily on tab entry (raOnTabEnter(), called from
  // api.js's switchTab()) — mirrors every OTHER tab's resume pattern in
  // this codebase (fcRenderCanvas/newScRender/etc. all render on tab entry,
  // not eagerly at restore time), not just Guided Launch's own eager
  // pattern (which is the one exception, because #gl-tab needs to be
  // populated even when landing directly on 'mm' — Requirement Agent has
  // no equivalent post-finalize redirect-away-and-still-need-content case).
  var root=document.getElementById('ra-tab');
  if(root&&root.classList.contains('on'))raOnTabEnter();
}

// ══════════════════════════════════════════════════════════════════════════
// Tab entry
// ══════════════════════════════════════════════════════════════════════════
function raOnTabEnter(){
  // v9.25 — must capture BEFORE raRenderShell(), not inside raRenderCenter().
  // raRenderShell() does its own root.innerHTML= on the ENTIRE #ra-tab
  // (including a brand-new, empty #ra-center) as a step BEFORE it calls
  // raRenderCenter() — so by the time raRenderCenter()'s own capture runs,
  // the old #ra-chat-input is already gone. Confirmed via live debug
  // logging (oldChatInput found:false on the tab-entry path specifically) —
  // raOpenConversation()/raNewConversation() don't have this problem, since
  // they call raRenderCenter() directly with no destructive wrapper first.
  _raCaptureChatDraft();
  raRenderShell();
  _raPurgeOrphanedDocsOpportunistic();
}

// v14 — self-healing safety net (RA-Persistent-Doc-RAG-Spec-v14 D4/OI-20).
// Fire-and-forget by design: background reconciliation, not something the
// PM needs to wait on or see, and its failure must never block entering the
// tab. Catches any document left orphaned by a reset path raResetState()'s
// own cleanup missed (a tab closed mid-cleanup, a network error, or a
// future reset flow added without knowing it needs to cooperate) — see
// ra_purge_orphaned_documents()'s own comment in sql/ra-doc-chunks.sql for
// why it's safe to call unconditionally, on any session, at any time,
// including one with nothing to purge.
// v14 code-review fix — throttled to once per session per page load
// (a Set, not a single boolean, since a PM can switch between sessions
// within one browser tab and each session's orphans are independent). Every
// RA tab RE-entry for the SAME session skipped after the first, since this
// is a background reconciliation pass, not something that needs to re-run
// every time the tab is revisited in one sitting.
var _raPurgedSessionIds=new Set();

// v14 code-review fix (efficiency) — conv.id -> boolean, "does this
// conversation have at least one active document." Populated by
// raRenderAttachedDocs() (which already fetches ra_list_documents() on
// conversation open/upload/removal) and consulted by _raRunTurn()'s
// retrieval block before deciding whether to bother with the embed+search
// round trip at all — undefined (never primed) is the only state that
// falls back to a real fetch. Deliberately never explicitly invalidated on
// upload/removal: both of those already call raRenderAttachedDocs() on
// success, which overwrites the entry with the freshly-fetched truth.
var _raDocsExistCache={};
function _raPurgeOrphanedDocsOpportunistic(){
  // The RPC itself requires active, non-readonly membership
  // (sql/ra-doc-chunks.sql), so a readonly viewer's call was never going to
  // succeed; gating here avoids a guaranteed, predictable failed round trip
  // on every single RA tab entry for that viewer, same as every other new
  // RA entry point in this build is gated.
  if(typeof _raCanEditOwner==='function'&&!_raCanEditOwner())return;
  if(typeof _activeSessionId==='undefined'||!_activeSessionId||typeof _pgtRpc!=='function')return;
  if(_raPurgedSessionIds.has(_activeSessionId))return;
  // v14 code-review fix — mark this session purged only on actual success,
  // not before the call even fires. Marking it upfront meant a failed call
  // (network error, transient RPC failure) permanently skipped this session
  // for the rest of the page's lifetime, since the throttle set had already
  // recorded it as done — the opposite of "self-healing." Now a failure
  // leaves the session unmarked, so the next tab entry/session load retries.
  _pgtRpc('ra_purge_orphaned_documents',{p_session_id:_activeSessionId}).then(function(res){
    if(res&&res.error){console.warn('[requirement-agent] ra_purge_orphaned_documents failed',res.error);return;}
    _raPurgedSessionIds.add(_activeSessionId);
  }).catch(function(err){
    console.warn('[requirement-agent] ra_purge_orphaned_documents failed',err);
  });
}

// ══════════════════════════════════════════════════════════════════════════
// Entry from Discovery Map — "Define Requirements" CTA (RA on only; see
// kpi-tree.js's renderDiagnosticActionBar()). Replaces the pre-redesign
// raDefineRequirements(), which was entered from Capability Canvas — RA no
// longer has any Capability-Canvas-side entry point.
// ══════════════════════════════════════════════════════════════════════════
function raEnterFromDiscoveryMap(){
  // Resume the PM's most recent Draft conversation if one exists (most
  // recent by updatedAt among status==='draft'), else create a new one.
  var drafts=raConversations.filter(function(c){return c.status==='draft';});
  drafts.sort(function(a,b){return new Date(b.updatedAt)-new Date(a.updatedAt);});
  var tabRa=document.getElementById('tab-ra');
  if(tabRa)tabRa.classList.add('revealed');
  if(drafts.length){
    raActiveConversationId=drafts[0].id;
    switchTab('ra');
  } else {
    switchTab('ra');
    raNewConversation();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Shell render — left panel (conversation list) + chat + live draft
// ══════════════════════════════════════════════════════════════════════════
var raFilterState='all'; // 'all' | 'draft' | 'finalized' — left-panel filter chips, view-scoped only, not persisted
var raPanelOpen=true;    // left panel expand/collapse state — view-scoped only, mirrors guided-launch.js's glPanelOpen (not persisted)
var raRightPanelOpen=true; // Live Draft panel expand/collapse — view-scoped only, mirrors guided-launch.js's glMdOpen (not persisted)
var _raLastRenderedConvId=null; // which conversation's DOM was actually on screen before the CURRENT capture call — see _raCaptureChatDraft()
var _raChatDraftByConvId={};    // unsent #ra-chat-input text, keyed by conversation id — view-scoped only, not persisted
// Item 3 fix — single staged attachment (RAG-off path only), keyed by
// conversation id, mirroring _raChatDraftByConvId's existing convention.
// Discarded (not carried over) on conversation switch — matches the
// existing "uploaded doc text is ephemeral, never persisted" convention
// already documented in this file, and avoids one client's document
// silently surviving into a different client's brief.
var _raStagedUploadByConvId={}; // convId -> {name, text, wasTruncated}

// Shared by raOnTabEnter() (before raRenderShell()'s own destructive wipe of
// #ra-tab) and raRenderCenter() (for its other two callers, raOpenConversation()/
// raNewConversation(), which call it directly with no destructive wrapper in
// between) — captures whatever's currently in #ra-chat-input, keyed by
// whichever conversation was actually on screen, before it's destroyed.
// Safe to call redundantly: a no-op if the element is already gone (e.g.
// raRenderCenter()'s own call, running after raRenderShell() already wiped
// it via the earlier raOnTabEnter() call) or if there's nothing tracked yet.
function _raCaptureChatDraft(){
  var _oldChatInput=document.getElementById('ra-chat-input');
  if(_oldChatInput&&_raLastRenderedConvId){
    _raChatDraftByConvId[_raLastRenderedConvId]=_oldChatInput.value;
    // Item 3 code-review fix — only discard the staged attachment (and
    // toast) when the conversation is ACTUALLY changing, not on every
    // capture call. raActiveConversationId already reflects whichever
    // conversation is about to render next: raOpenConversation()/
    // raNewConversation() reassign it BEFORE calling raRenderCenter(), and
    // a plain tab re-entry via raOnTabEnter() leaves it untouched. Without
    // this check, simply leaving the RA tab and coming back (same
    // conversation still active) silently discarded a staged upload with a
    // false "switched conversations" toast, since this function has no
    // other way to distinguish that from a genuine switch.
    var _upcomingConvId=(typeof raActiveConversationId!=='undefined')?raActiveConversationId:null;
    if(_raLastRenderedConvId!==_upcomingConvId&&_raStagedUploadByConvId[_raLastRenderedConvId]){
      delete _raStagedUploadByConvId[_raLastRenderedConvId];
      if(typeof showToast==='function')showToast('Attachment discarded — switched conversations.','info');
    }
  }
}

// Left panel — the real global .left/.ph/.collapse-btn structure (copied
// from index.html's #left-panel, same convention guided-launch.js's
// #gl-left already follows — see glRenderShell()'s comment), NOT a bespoke
// panel. raTogglePanel() mirrors glTogglePanel()/left-panel.js's
// togglePanel() exactly, scoped to #ra-left/its own icon ids.
function raRenderShell(){
  var root=document.getElementById('ra-tab');
  if(!root)return;
  root.innerHTML=
    '<div class="left ra-left'+(raPanelOpen?'':' collapsed')+'" id="ra-left">'
      +'<div class="ph">'
        +'<div class="ph-text"><div class="ph-title">Requirement Agent</div><div class="ph-sub">Pin down what you\'re building.</div></div>'
        +'<button class="collapse-btn" onclick="raTogglePanel()" title="Toggle panel">'
          +'<svg id="icon-ra-exp" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:'+(raPanelOpen?'block':'none')+'"><polyline points="15 18 9 12 15 6"/><polyline points="21 18 15 12 21 6"/></svg>'
          +'<svg id="icon-ra-col" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:'+(raPanelOpen?'none':'block')+'"><polyline points="9 18 15 12 9 6"/><polyline points="3 18 9 12 3 6"/></svg>'
        +'</button>'
      +'</div>'
      +'<div class="ra-left-body">'
        +'<div class="ra-filter-chips" id="ra-filter-chips"></div>'
        +'<div class="ra-conv-list" id="ra-conv-list"></div>'
        +(((typeof _raCanEditOwner!=='function')||_raCanEditOwner())?'<button class="ra-new-conv-btn" id="ra-new-conv-btn" onclick="raNewConversation()"><i class="ti ti-plus" style="font-size:11px;" aria-hidden="true"></i> New Conversation</button>':'')
      +'</div>'
    +'</div>'
    +'<div class="ra-center" id="ra-center"></div>'
    +'<div class="ra-md-collapsed-rail'+(raRightPanelOpen?'':' show')+'" id="ra-collapsed-rail" onclick="raOpenRightPanel()" title="Reopen Live Draft">'
      +'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>'
      +'<div class="ra-md-collapsed-label">LIVE DRAFT</div>'
    +'</div>'
    +'<div class="ra-right" id="ra-right" style="display:'+(raRightPanelOpen?'flex':'none')+';"></div>';
  raRenderFilterChips();
  raRenderConvList();
  raRenderCenter();
}

function raCollapseRightPanel(){
  raRightPanelOpen=false;
  var right=document.getElementById('ra-right'); if(right)right.style.display='none';
  var rail=document.getElementById('ra-collapsed-rail'); if(rail)rail.classList.add('show');
}
function raOpenRightPanel(){
  raRightPanelOpen=true;
  var right=document.getElementById('ra-right'); if(right)right.style.display='flex';
  var rail=document.getElementById('ra-collapsed-rail'); if(rail)rail.classList.remove('show');
}

function raTogglePanel(){
  raPanelOpen=!raPanelOpen;
  var left=document.getElementById('ra-left');
  if(left)left.classList.toggle('collapsed',!raPanelOpen);
  var expIcon=document.getElementById('icon-ra-exp');
  var colIcon=document.getElementById('icon-ra-col');
  if(expIcon)expIcon.style.display=raPanelOpen?'block':'none';
  if(colIcon)colIcon.style.display=raPanelOpen?'none':'block';
}

function raRenderFilterChips(){
  var chips=document.getElementById('ra-filter-chips');
  if(!chips)return;
  chips.innerHTML=['all','draft','finalized'].map(function(f){
    return '<button class="ra-chip'+(raFilterState===f?' active':'')+'" onclick="raSetFilter(\''+f+'\')">'+(f==='all'?'All':f==='draft'?'Draft':'Finalized')+'</button>';
  }).join('');
}

function raSetFilter(f){
  raFilterState=f;
  raRenderFilterChips();
  raRenderConvList();
}

function raRenderConvList(){
  var list=document.getElementById('ra-conv-list');
  if(!list)return;
  var items=raConversations.slice();
  items.sort(function(a,b){return new Date(b.updatedAt)-new Date(a.updatedAt);});
  if(raFilterState!=='all')items=items.filter(function(c){return c.status===raFilterState;});
  if(!items.length){
    list.innerHTML='<div class="ra-conv-empty">No conversations yet. Start one below.</div>';
    return;
  }
  list.innerHTML=items.map(function(c){
    var isActive=c.id===raActiveConversationId;
    var capCount=(c.touchedCapabilityKeys||[]).length;
    // generatedFeatureIds is permanently empty post-v9.18 (Finalize no
    // longer generates features — see raNewConversation()'s field comment),
    // so the count is now derived from the real, live source of truth:
    // Capability Canvas's own featStore.top for every capability this
    // conversation's Finalize created. Tolerant of stale/missing keys —
    // a capability referenced here could since have been deleted/reindexed
    // elsewhere in Capability Canvas.
    var featCount=(c.createdCapabilityKeys||[]).reduce(function(sum,key){
      if(typeof capStore==='undefined')return sum;
      // metricKey itself is stageId+'||'+metricName (ccMetricKey()) or
      // 'pi||'+capName (ccPIKey()) — already pipe-delimited — so this
      // composite key can't be split on every '|'. capIdx is always the
      // last segment and always a plain integer (never free text), so
      // lastIndexOf isolates it correctly regardless of what characters
      // appear in the metric/capability name. Mirrors the same
      // lastIndexOf-based parsing capability-canvas.js already uses for
      // this exact key shape.
      var keyStr=String(key);
      var sep=keyStr.lastIndexOf('|');
      var metricKey=sep>=0?keyStr.slice(0,sep):keyStr;
      var capIdx=sep>=0?parseInt(keyStr.slice(sep+1),10):NaN;
      var entry=capStore[metricKey];
      var cap=entry&&entry.capabilities&&entry.capabilities[capIdx];
      return sum+((cap&&cap.featStore&&cap.featStore.top)?cap.featStore.top.length:0);
    },0);
    var summary=c.status==='finalized'
      ?(capCount+' capabilit'+(capCount!==1?'ies':'y')+' · '+featCount+' feature'+(featCount!==1?'s':'')+' · finalized '+_raRelTime(c.updatedAt))
      :('Updated '+_raRelTime(c.updatedAt)+' · not yet finalized');
    var tag=(c.status==='finalized'&&c.rqNumber)?('<span class="ra-rq-tag">'+e(c.rqNumber)+'</span> '):'';
    return '<div class="ra-conv-card'+(isActive?' active':'')+'" onclick="raOpenConversation(\''+c.id+'\')">'
      +'<div class="ra-conv-title-row">'
        +'<div class="ra-conv-title" id="ra-conv-title-'+c.id+'">'+tag+e(c.title||'Untitled conversation')+'</div>'
        +((isActive&&((typeof _raCanEditOwner!=='function')||_raCanEditOwner()))?'<button class="ra-conv-rename-btn" onclick="event.stopPropagation();raRenameConversation(\''+c.id+'\')" title="Rename"><i class="ti ti-pencil" style="font-size:10px;" aria-hidden="true"></i></button>':'')
      +'</div>'
      +'<div class="ra-conv-summary">'+e(summary)+'</div>'
    +'</div>';
  }).join('');
}

function raRenameConversation(id){
  if(typeof _raCanEditOwner==='function'&&!_raCanEditOwner())return;
  var conv=_raFindConv(id);
  if(!conv)return;
  var titleEl=document.getElementById('ra-conv-title-'+id);
  if(!titleEl)return;
  var current=conv.title||'';
  titleEl.innerHTML='<input type="text" class="ra-rename-input" id="ra-rename-input-'+id+'" value="'+e(current)+'" onkeydown="if(event.key===\'Enter\')raSaveRename(\''+id+'\');if(event.key===\'Escape\')raRenderConvList();" onblur="raSaveRename(\''+id+'\')">';
  var input=document.getElementById('ra-rename-input-'+id);
  if(input){input.focus();input.select();}
}
function raSaveRename(id){
  var conv=_raFindConv(id);
  var input=document.getElementById('ra-rename-input-'+id);
  if(!conv||!input)return;
  var val=input.value.trim();
  if(val){conv.title=val;conv.titleIsPlaceholder=false;conv.titleLocked=true;}
  conv.updatedAt=new Date().toISOString();
  raRenderConvList();
  _raPersist();
}

// ══════════════════════════════════════════════════════════════════════════
// Center (chat) + right (live draft) — rendered together per active conv
// ══════════════════════════════════════════════════════════════════════════
function raRenderCenter(){
  // v9.24.02 — confirmed via grep this is the ONLY function (3 call sites,
  // all in this file: tab-entry shell render, raOpenConversation(),
  // raNewConversation()) that rebuilds #ra-chat-input's DOM node from
  // scratch. abort(), not stop(): the old node is about to be discarded
  // regardless, and letting a trailing result land would write into
  // whichever NEW conversation's textarea replaces it — the exact
  // dictation-bleeds-into-a-different-conversation bug this guard exists
  // to prevent. voiceStopActive() is a safe no-op if voice input isn't
  // active, or if some other surface (not this one) is the active instance.
  voiceStopActive('abort');
  // v9.25 — preserve any unsent draft text before the old textarea (if any)
  // is destroyed below. Keyed by whichever conversation was ACTUALLY on
  // screen before this render, NOT raActiveConversationId — callers like
  // raOpenConversation()/raNewConversation() already reassign that BEFORE
  // calling this function, so it no longer identifies the outgoing
  // conversation by the time we get here. Confirmed via live testing this
  // is a pre-existing gap in this render function (it has always rebuilt
  // #ra-chat-input empty on every call, with no value ever interpolated
  // in) — not something voice input introduced. It would equally discard
  // an unsent manually-typed draft; voice just makes hitting it far more
  // likely, since dictating naturally accumulates more unsent content
  // before a PM would think to hit Send. Redundant-but-harmless on the
  // tab-entry path specifically — raOnTabEnter() already captured before
  // raRenderShell()'s own destructive wipe, so this call finds nothing left
  // to capture; still load-bearing for the other two callers below.
  _raCaptureChatDraft();
  var center=document.getElementById('ra-center');
  var right=document.getElementById('ra-right');
  if(!center||!right)return;
  var conv=_raActiveConv();
  _raLastRenderedConvId=conv?conv.id:null;
  if(!conv){
    center.innerHTML='<div class="ra-empty-state"><i class="ti ti-clipboard-text" style="font-size:28px;color:var(--label);" aria-hidden="true"></i><div style="font-size:13px;font-weight:600;color:var(--t2);margin-top:10px;">No conversation open</div><div style="font-size:11px;color:var(--t3);margin-top:4px;">Start a new one, or pick a conversation on the left.</div></div>';
    right.innerHTML='';
    return;
  }
  // Reverted to the v9.16 Guided Launch format per QA: static category
  // eyebrow + a fixed, friendly status line - the conversation's own
  // contextualized title now lives in the Live Draft banner (raRenderLiveDraft())
  // instead, so it isn't lost by dropping it from here.
  // v14 — RA's whole composer (textarea, mic, send, upload chip, file
  // input) is hidden together as one unit for a non-editable session,
  // matching the exact precedent already established elsewhere in this
  // codebase (e.g. capability-canvas.js's .cc-chat-bar) — the mic is never
  // gated on its own, it's just a sibling inside whatever gets hidden here.
  // Reuses the existing .ra-finalized-note treatment rather than inventing
  // a second "closed" visual for a second reason.
  var _raCanEdit=(typeof _raCanEditOwner!=='function')||_raCanEditOwner();
  center.innerHTML=
    '<div class="ra-chat-hdr"><div class="ra-chat-hdr-eyebrow">Requirement Agent</div><div class="ra-chat-hdr-title">'+(conv.status==='finalized'?('Finalized'+(conv.rqNumber?(' — '+e(conv.rqNumber)):'')):'Drafting requirements together')+'</div></div>'
    +'<div class="ra-chat-body" id="ra-chat-body"></div>'
    +'<div class="ra-attached-docs" id="ra-attached-docs"></div>'
    +(conv.status==='finalized'
      ?'<div class="ra-chat-input-wrap"><div class="ra-finalized-note">This conversation is finalized — chat is closed.</div></div>'
      :!_raCanEdit
      ?'<div class="ra-chat-input-wrap"><div class="ra-finalized-note">You have view-only access to this session, chat is closed.</div></div>'
      :'<div class="ra-chat-input-wrap"><div class="ra-chat-input-row">'
        +'<textarea class="ra-chat-input" id="ra-chat-input" rows="1" placeholder="Type your response..." onkeydown="if(event.key===\'Enter\'&&!event.shiftKey){event.preventDefault();raSendMessage();}"></textarea>'
        +'<div class="ra-chat-btn-group">'
          // v9.25 code-review fix — guarded with typeof, matching every
          // other surface's call site convention (was unguarded here,
          // safe in practice since voice-input.js always loads first, but
          // an inconsistent pattern for future surfaces to copy from).
          +((typeof voiceButtonHtml==='function')?voiceButtonHtml({textareaId:'ra-chat-input',buttonId:'ra-voice-btn',statusId:'ra-voice-status'}):'')
          +'<button class="ra-chat-send" id="ra-send-btn" onclick="raSendMessage()" title="Send"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg></button>'
        +'</div>'
      +'</div>'
      +'<div class="gl-upload-chip" id="ra-upload-chip" onclick="if(!raBusy)document.getElementById(\'ra-file-input\').click()" title="Click to select a file to upload">'
        +'<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>'
        +' <span id="ra-upload-chip-text" style="text-decoration:underline;">Upload a document</span><span id="ra-upload-chip-suffix">'+(_raRagEnabled()?' to add context anytime':' to add context for this reply')+'</span>'
      +'</div>'
      +'<div id="ra-staged-attachment" style="margin-top:4px;"></div>'
      +'<input type="file" id="ra-file-input" accept=".docx,.pdf,.txt,.xlsx,.csv" style="display:none;" onchange="raHandleUpload(this)">'
      +'</div>');
  // Restore this SAME conversation's preserved draft, if any — one-shot,
  // deleted after restoring so a later re-render of this conversation
  // (once it's genuinely empty again) doesn't reapply a stale value.
  if(conv.status!=='finalized'&&_raCanEdit&&_raChatDraftByConvId[conv.id]){
    var _newChatInput=document.getElementById('ra-chat-input');
    if(_newChatInput)_newChatInput.value=_raChatDraftByConvId[conv.id];
    delete _raChatDraftByConvId[conv.id];
  }
  // Item 3 — a staged attachment survives a re-render that doesn't destroy
  // the conversation (mirrors the chat-draft restore just above).
  _raRenderStagedAttachment(conv);
  raRenderChatHistory();
  raRenderLiveDraft();
  raRenderAttachedDocs(conv);
  if(!conv.messages||!conv.messages.length){
    raRunOpeningTurn(conv);
  }
}

function raOpenConversation(id){
  raActiveConversationId=id;
  raLastOpenConversationId=id;
  raRenderConvList();
  raRenderCenter();
  _raPersist();
}

// Quick-select chip block — rendered under the newest agent message only
// (never on history), so an answered/superseded turn never shows a stale
// set of options. targetSection/question/options come straight from the
// model's clarifyingQuestions field (prompts.js's _raClarifyingQuestionsRules()),
// already sanitized by _raSanitizeClarifyingQuestions() before storage.
function _raQuickReplyHtml(cq){
  return (cq||[]).map(function(q){
    return '<div class="ra-quick-reply-block">'
      +'<span class="ra-quick-reply-target-tag">'+e(q.targetSection)+'</span>'
      +'<div class="ra-quick-reply-q">'+e(q.question)+'</div>'
      +'<div class="ra-quick-reply-row">'
        +(q.options||[]).map(function(opt){
          return '<button type="button" class="ra-quick-reply-chip" data-answer="'+e(opt)+'" onclick="raQuickReplyClick(this)">'+e(opt)+'</button>';
        }).join('')
      +'</div>'
    +'</div>';
  }).join('');
}
// v9.30.03 — suggested-questions chip row, rendered under a doc-gist
// message (raAppendMessage's {suggestedQuestions:[...]} extra, built from
// _raGetDocGist()'s result in raHandleUpload()). Visually matches
// .ra-quick-reply-chip/-row but is a DELIBERATELY separate field/click
// handler from clarifyingQuestions: those are structured
// {question,targetSection,options} tied into conv.openQuestions'
// resolved-tracking for the brief's own Open Questions section (see
// _raSanitizeClarifyingQuestions()) — plain "things you could ask about
// this document" have no targetSection and must never be tracked as an
// open drafting question.
function _raSuggestedQuestionsHtml(questions){
  if(!questions||!questions.length)return'';
  return '<div class="ra-quick-reply-block">'
    +'<div class="ra-quick-reply-row">'
      +questions.map(function(q){
        return '<button type="button" class="ra-quick-reply-chip" data-question="'+e(q)+'" onclick="raSuggestedQuestionClick(this)">'+e(q)+'</button>';
      }).join('')
    +'</div>'
  +'</div>';
}
function raSuggestedQuestionClick(btnEl){
  var conv=_raActiveConv();
  if(!conv||raBusy||conv.status!=='draft')return;
  if(typeof _raCanEditOwner==='function'&&!_raCanEditOwner())return;
  var question=btnEl.dataset.question;
  if(!question)return;
  var block=btnEl.closest('.ra-quick-reply-block');
  if(block)block.remove();
  _raSubmitUserMessage(conv,question);
}
function _raBubbleHtml(m,idx,total){
  var isUser=m.role==='user';
  var highlightId='ra-msg-'+idx;
  var conv=_raActiveConv();
  var isLast=idx===(total-1);
  var canEdit=(typeof _raCanEditOwner!=='function')||_raCanEditOwner();
  var showChips=!isUser&&isLast&&conv&&conv.status==='draft'&&m.clarifyingQuestions&&m.clarifyingQuestions.length>0&&canEdit;
  var showSuggested=!isUser&&isLast&&conv&&conv.status==='draft'&&m.suggestedQuestions&&m.suggestedQuestions.length>0&&canEdit;
  return '<div class="gl-msg-row '+(isUser?'user':'agent')+'" id="'+highlightId+'">'
    +'<div class="gl-avatar '+(isUser?'user-av':'agent-av')+'">'+(isUser?e((typeof _glUserInitials==='function')?_glUserInitials():'You'):'AI')+'</div>'
    +'<div class="gl-bubble">'+(typeof _glFormatChatText==='function'?_glFormatChatText(m.text):e(m.text||''))
      +(showChips?_raQuickReplyHtml(m.clarifyingQuestions):'')
      +(showSuggested?_raSuggestedQuestionsHtml(m.suggestedQuestions):'')
    +'</div>'
  +'</div>';
}
function raRenderChatHistory(){
  var body=document.getElementById('ra-chat-body');
  var conv=_raActiveConv();
  if(!body||!conv)return;
  var total=(conv.messages||[]).length;
  body.innerHTML=(conv.messages||[]).map(function(m,idx){return _raBubbleHtml(m,idx,total);}).join('');
  body.scrollTop=body.scrollHeight;
}
function raAppendMessage(conv,role,text,extra){
  conv.messages=conv.messages||[];
  conv.messages.push(Object.assign({role:role,text:text,timestamp:new Date().toISOString()},extra||{}));
  var body=document.getElementById('ra-chat-body');
  if(body){
    // Stale quick-reply block(s) from the previous agent turn must not
    // linger once ANY new message lands (typed or chip-driven) — otherwise
    // a PM could click an old, already-superseded option. querySelectorAll,
    // not querySelector: confirmed via live testing that when a turn ever
    // surfaces more than one question block, querySelector's single-match
    // removal left the second block's chips clickable after the first was
    // answered, silently discarding that question with no way to answer it
    // (clarifyingQuestions is now capped to 1/turn client-side specifically
    // to avoid this, but this cleanup should never depend on that cap).
    var oldQrs=body.querySelectorAll('.ra-quick-reply-block');
    oldQrs.forEach(function(el){el.remove();});
    var total=conv.messages.length;
    body.insertAdjacentHTML('beforeend',_raBubbleHtml(conv.messages[total-1],total-1,total));
    body.scrollTop=body.scrollHeight;
  }
}
function _raSetBusy(busy){
  raBusy=busy;
  var sendBtn=document.getElementById('ra-send-btn');
  var uploadChip=document.getElementById('ra-upload-chip');
  if(uploadChip)uploadChip.classList.toggle('gl-upload-chip-disabled',busy);
  if(sendBtn)sendBtn.disabled=busy;
  // The textarea itself deliberately stays enabled while busy (PM feedback:
  // a turn can take a minute or more, so the PM should be able to type their
  // next message while waiting instead of staring at a disabled box) - only
  // sending/uploading is blocked. raSendMessage() checks raBusy before
  // touching the textarea's value, so an Enter press mid-generation is a
  // safe no-op that leaves whatever the PM was typing intact.
}

// v14 code-review fix (altitude) — raBusy is a bare flag with no owning
// abstraction, hand-guarded at every RA action's own call site. That gap
// caused two real bugs in this same build: raNewConversation() became a
// second concurrent writer of raBusy alongside raRunOpeningTurn(), and the
// first fix for that left raBusy stuck true forever on a failed save, with
// nothing left to ever clear it. _raWithBusy() is the actual invariant
// that kept getting hand-rolled and getting one part wrong: set busy, run
// the async work, ALWAYS clear busy after, success or failure, via a real
// try/finally rather than a hand-placed pair of _raSetBusy() calls. New RA
// actions with a single async critical section should build on this
// rather than re-deriving the shape by hand; functions with more layered
// state around their busy window (raRunOpeningTurn(), _raRunTurn(),
// raHandleUpload() — typing/indexing indicators, streaming bubbles, error-
// specific messaging interleaved with the busy window) are left as their
// own already-correct, already-reviewed try/finally blocks rather than
// force-fit into this simpler shape for no behavior change.
async function _raWithBusy(fn){
  _raSetBusy(true);
  try{
    return await fn();
  }finally{
    _raSetBusy(false);
  }
}
// v14 code-review fix — _raShowTyping/_raHideTyping and the newer
// _raShowIndexing/_raHideIndexing were near-identical copies of each other
// (same transient, never-persisted-to-conv.messages DOM row: insert on
// show, getElementById().remove() on hide). Consolidated into one shared
// pair; _raTypingRowHtml()/_raIndexingRowHtml() are kept as named builders
// since nothing about their own signatures needed to change.
function _raStatusRowHtml(rowId,innerHtml){
  return '<div class="gl-msg-row agent" id="'+rowId+'"><div class="gl-avatar agent-av">AI</div><div class="gl-bubble gl-typing-bubble">'+innerHtml+'</div></div>';
}
function _raShowStatusRow(rowId,innerHtml){
  var body=document.getElementById('ra-chat-body');
  if(body){body.insertAdjacentHTML('beforeend',_raStatusRowHtml(rowId,innerHtml));body.scrollTop=body.scrollHeight;}
}
function _raHideStatusRow(rowId){
  var row=document.getElementById(rowId);
  if(row)row.remove();
}
var _RA_TYPING_DOTS_HTML='<div class="gl-typing-dots"><span></span><span></span><span></span></div>';
function _raTypingRowHtml(){
  return _raStatusRowHtml('ra-typing-row',_RA_TYPING_DOTS_HTML);
}
function _raShowTyping(){
  _raShowStatusRow('ra-typing-row',_RA_TYPING_DOTS_HTML);
}
function _raHideTyping(){
  _raHideStatusRow('ra-typing-row');
}

function _raIndexingRowHtml(fileName){
  return _raStatusRowHtml('ra-indexing-row',_RA_TYPING_DOTS_HTML+' Indexing '+e(fileName)+'… don’t close this tab yet');
}
function _raShowIndexing(fileName){
  _raShowStatusRow('ra-indexing-row',_RA_TYPING_DOTS_HTML+' Indexing '+e(fileName)+'… don’t close this tab yet');
}
function _raHideIndexing(){
  _raHideStatusRow('ra-indexing-row');
}

// ── v-next: dual-mode streaming switch, default OFF ──
// Now a real, persisted company setting - Settings > Company Profile &
// Access > API & Access > "Live AI Streaming" (see settings-page.js's spP1()
// and settingsPageSave()) - rather than a dev-only localStorage flag.
// Requirement Agent behaves EXACTLY as it did before this feature existed
// until an admin explicitly turns this on. See the approved plan for why
// this ships as a runtime switch rather than a one-way cutover: the
// streaming path depends on a different prompt response contract
// (prompts.js's streamingMode param), so this same flag gates both sides
// together, never one without the other.
function _raStreamingEnabled(){
  return (typeof appSettings!=='undefined'&&appSettings)?appSettings.aiStreamingEnabled===true:false;
}
// v9.27.01 — company-wide switch between the persistent-document RAG
// pipeline (chunk/embed/ingest, retrieval every turn) and the pre-v9.27
// ephemeral one-shot upload (extract, feed into that single turn, nothing
// persisted). Default OFF: RAG depends on an Azure OpenAI embedding call
// currently blocked by IT network/compliance policy. See raHandleUpload()
// and _raRunTurn() for the two gated code paths.
function _raRagEnabled(){
  return (typeof appSettings!=='undefined'&&appSettings)?appSettings.raRagEnabled===true:false;
}
// Live streaming bubble - a plain DOM element updated as deltas arrive,
// entirely separate from conv.messages/raAppendMessage() until the stream
// finishes. Once the full text is known (chatReply + sectionUpdates JSON
// split apart), this bubble is removed and raAppendMessage() runs exactly
// as it does on the non-streaming path - so every downstream behavior
// (quick-reply chips, history re-render, persistence) is unchanged code.
function _raStreamBubbleShow(){
  var body=document.getElementById('ra-chat-body');
  if(!body)return null;
  body.insertAdjacentHTML('beforeend','<div class="gl-msg-row agent" id="ra-stream-bubble"><div class="gl-avatar agent-av">AI</div><div class="gl-bubble" id="ra-stream-bubble-text"></div></div>');
  body.scrollTop=body.scrollHeight;
  return document.getElementById('ra-stream-bubble-text');
}
function _raStreamBubbleRemove(){
  var row=document.getElementById('ra-stream-bubble');
  if(row)row.remove();
}
// Splits a streaming response (plain-text chatReply + sentinel + JSON tail,
// per prompts.js's streamingMode contract) into the same {chatReply,
// sectionUpdates, openQuestions, clarifyingQuestions, suggestedTitle} shape
// _raParseJSON() returns for the non-streaming path, so every call site
// downstream of parsing can stay identical regardless of which mode ran.
function _raSplitStreamResponse(raw){
  var idx=(raw||'').indexOf(_RA_STREAM_SENTINEL);
  if(idx<0)return null;
  var chatReply=raw.slice(0,idx).trim();
  var jsonPart=raw.slice(idx+_RA_STREAM_SENTINEL.length);
  var parsed=_raParseJSON(jsonPart);
  if(!parsed)return null;
  parsed.chatReply=chatReply;
  return parsed;
}

// Shared by every callAPI()/callAPIStream() call site in this file (non-
// streaming _raCallModel() below, plus both streaming branches in
// raRunOpeningTurn()/_raRunTurn()) - previously copy-pasted at each site,
// which risked the streaming and non-streaming paths silently diverging in
// what they report for usage tracking if only one copy got updated.
// AI Trace Layer — assigns a client-generated trace id to a conversation
// once, on first use, and reuses it for every subsequent call belonging to
// that same conversation (spec Invariant 2: client_trace_id is the only
// trace-continuation key). Property lives directly on conv (an ordinary
// object _raPersist()/sessionStoreSave() already saves in full), so no new
// persistence code is needed for it to survive a refresh.
function _raEnsureTraceCtx(conv){
  // Code-review fix — crypto.randomUUID is unavailable in some contexts
  // (the same concern api.js's _generateFallbackUuid() already exists for);
  // both call sites below invoke this before their own try{}, so an
  // unguarded throw here would skip their finally{ _raSetBusy(false); }
  // and leave Requirement Agent permanently stuck busy.
  if(!conv.aiClientTraceId) conv.aiClientTraceId=(typeof crypto!=='undefined'&&crypto.randomUUID)?crypto.randomUUID():_generateFallbackUuid();
  return {client_trace_id: conv.aiClientTraceId, agent_name: 'requirement-agent'};
}
function _raUsageExtraFields(traceCtx){
  // Outcome-Based Cost (AI Cost Control Tower v2), Phase 3 fix — session_type
  // was incorrectly hardcoded to 'ChatCanvas' here, a value that means
  // exactly one thing elsewhere in this app: "session_id points at
  // mt_intake_sessions, not mt_sessions" (guided-launch.js's own genuine
  // ChatCanvas flow, api.js:835). Requirement Agent is triggered from
  // Discovery Map — _activeSessionId is always a real mt_sessions row — so
  // this mislabeling made proxy/server.js's product_id lookup
  // (if (_sessionId && !_sessionType)) skip itself on every single
  // requirement-agent call, silently zeroing out product_id even when the
  // session had a real one. Confirmed via a live Phase 3 test: mt_sessions
  // had product_id populated, mt_ai_usage_events.product_id came back null
  // anyway. Removed entirely — the proxy's own mt_sessions lookup is
  // authoritative once this stops short-circuiting it.
  return Object.assign({session_id:(typeof _activeSessionId!=='undefined'?_activeSessionId:null),product_id:(typeof productContext!=='undefined'&&productContext?productContext.id:null)}, traceCtx||{});
}
async function _raCallModel(sys,usr,signal,traceCtx){
  var extra=_raUsageExtraFields(traceCtx);
  // v-next: lowered back from 8000 - that cap was raised for the OLD
  // return-the-FULL-document-every-turn design, where a large capability
  // set easily produced ~13.7k characters. Now that turns return
  // sectionUpdates (only what changed, see _raApplySectionUpdates()), a
  // typical turn needs a fraction of that - but confirmed via a live
  // "[AI TIMEOUT] ... timeoutMs: 120000" proxy log that the model can still,
  // on a rich multi-section PM answer, generate enough output to run past
  // the PROXY'S OWN hard 120s timeout - which loses the entire turn with no
  // recovery, unlike hitting max_tokens, which _raParseJSON()'s truncation
  // recovery can often salvage. 4000 bounds worst-case generation length
  // (and so worst-case time) to roughly half of the old ceiling, while still
  // comfortably covering a turn that legitimately updates several sections
  // at once.
  return await callAPI(sys,usr,4000,signal||null,null,'requirement-agent',null,extra);
}

// ── New conversation ──
async function raNewConversation(){
  // Round-2 code-review fix — this function has an await in the middle
  // (the persist below) with no guard of its own, so a double-click before
  // the first call's persist resolves used to push a SECOND conversation,
  // whose later raRenderCenter()/raRunOpeningTurn() could start a second,
  // concurrent opening-turn AI call once the first click's persist finally
  // resolved and re-enabled everything. Checked first, same convention as
  // every other RA entry point (raSendMessage, raHandleUpload, etc.).
  if(raBusy)return;
  if(typeof _raCanEditOwner==='function'&&!_raCanEditOwner())return;
  var conv={
    id:_raUid(),
    title:'New Conversation',
    rqNumber:null,
    createdAt:new Date().toISOString(),
    updatedAt:new Date().toISOString(),
    status:'draft',
    touchedCapabilityKeys:[],
    messages:[],
    openQuestions:[],
    liveDraftMd:'',
    draftVersion:0,
    generatedFeatureIds:[], // retained for backward compat with pre-redesign finalized conversations — stays empty going forward, Finalize no longer generates features (§7)
    createdCapabilityKeys:[], // NEW — capStore key(s) of every capability this conversation's Finalize created (new capabilities only, not pre-existing ones it touched)
    titleIsPlaceholder:true, // informational only — no longer gates auto-retitling (see titleLocked); tracks whether conv.title is still the boilerplate 'Release requirements' fallback
    titleLocked:false // set true ONLY by an explicit PM rename (raSaveRename) — the actual gate on auto-retitling, so the model can keep proposing a better title on later turns (e.g. if the PM pivots to a different idea) without ever overwriting a title the PM chose themselves
  };
  raConversations.push(conv);
  raActiveConversationId=conv.id;
  raLastOpenConversationId=conv.id;
  var tabRa=document.getElementById('tab-ra');
  if(tabRa)tabRa.classList.add('revealed');
  raRenderConvList();
  // v14 (OI-9, reordered per post-v9.27 code review) — persistence must
  // happen, and resolve, BEFORE raRenderCenter() runs, not after: that
  // function fires raRunOpeningTurn() (fire-and-forget) whenever a
  // conversation has no messages yet, and raRunOpeningTurn() checks and
  // owns this SAME raBusy flag itself (its own guard, its own
  // finally{_raSetBusy(false)}). Doing the busy/persist dance AFTER calling
  // raRenderCenter() made this function a SECOND concurrent writer of
  // raBusy — this function's own _raSetBusy(false) could fire while the
  // opening turn was still generating, silently re-enabling upload/send
  // mid-turn. Persisting first means the opening turn becomes the sole
  // subsequent owner of raBusy once persistence is confirmed done, never a
  // second one racing it. Also closes OI-9 itself: an upload immediately
  // after creating this conversation would otherwise race this same save,
  // since ra_ingest_document_chunks()'s authorization check reads the
  // database's current snapshot, which won't contain this conversation's
  // id until this resolves.
  // Round-2 code-review fix — ALWAYS clear raBusy after this, success or
  // not. The original failure branch left it permanently true with no
  // other writer left to clear it: raRenderCenter()'s freshly-rendered
  // composer has no actual disabled attribute on its Send button/upload
  // chip (that only reflects raBusy at the moment of rendering, not
  // afterward), so this looked clickable but silently no-opped forever,
  // for THIS conversation and every OTHER already-healthy one, until a
  // page reload. Round-4 fix: expressed via _raWithBusy() (see its own
  // comment) instead of a hand-placed _raSetBusy(true)/(false) pair —
  // this exact function is the one whose bug motivated that helper.
  var _raNcPersisted=await _raWithBusy(function(){return _raPersist();});
  if(!_raNcPersisted){
    // Warn via toast, not a persisted chat message — an earlier version
    // used raAppendMessage(), which pushes into conv.messages, which is
    // part of the persisted snapshot: the very next successful save (this
    // conversation's own opening turn ends with one, fire-and-forget)
    // would bake that error in permanently, AND raRenderCenter()'s
    // "no messages yet -> auto-run the opening turn" branch would then
    // never fire again for this conversation (conv.messages.length>0
    // forever), leaving it stuck empty with no opening summary. A toast
    // has none of that persistence baggage. The opening turn proceeds
    // regardless of this save's outcome — it needs no database at all;
    // only an upload (gated by its own fresh session/RPC checks in
    // raHandleUpload()) actually depends on this row existing yet, and
    // that call's own error surfacing already explains a failure clearly
    // if the retry (this conversation's own later persists) hasn't
    // caught up yet.
    if(typeof showToast==='function')showToast('This conversation may not have saved yet - it will retry automatically.','warn');
  }
  raRenderCenter();
}

async function raRunOpeningTurn(conv){
  if(!conv||raBusy)return;
  _raSetBusy(true);
  _raShowTyping();
  // v9.17.03 (Item 3) — every other tab's in-flight AI call (Capability
  // Canvas feature-gen, Market Intelligence, PI scoring, etc.) is guarded by
  // startAiGen()/endAiGen() so switchTab() shows a "leave/stay" confirmation
  // if the user navigates away mid-call. Requirement Agent's raBusy flag was
  // never wired into that shared mechanism, so navigating away mid-turn just
  // silently proceeded — confirmed as a real gap (raBusy exists and blocks
  // RA's own UI, but aiGenInFlight, the thing switchTab() actually checks,
  // was never set). Wiring it in here, in _raRunTurn(), and in
  // raRunFinalizeSequence() below.
  var _signal=(typeof startAiGen==='function')?startAiGen('Requirement Agent is drafting the opening summary. Leaving now discards it, you\'ll need to start over.'):null;
  var _streaming=_raStreamingEnabled();
  var _raTraceCtx=_raEnsureTraceCtx(conv);
  try{
    var _raDocRes1=(typeof buildDocContext==='function')?buildDocContext('ra'):{text:'',truncated:false};
    var _raDocCtx1=_raDocRes1.text;
    _fireDocTruncatedToast(_raDocRes1.truncated);
    var built=buildRequirementAgentDMOpeningPrompt(typeof sessionContext!=='undefined'?sessionContext:{},_raFirstName(),_raDocCtx1,_streaming);
    var raw,parsed;
    if(_streaming){
      var _bubbleEl=null;
      var extra=_raUsageExtraFields(_raTraceCtx);
      raw=await callAPIStream(built.sys,built.usr,4000,_signal,null,'requirement-agent',null,extra,function(delta){
        _raHideTyping();
        if(!_bubbleEl)_bubbleEl=_raStreamBubbleShow();
        if(_bubbleEl){
          _bubbleEl.textContent=(_bubbleEl.textContent||'')+delta;
          var _body=document.getElementById('ra-chat-body');
          if(_body)_body.scrollTop=_body.scrollHeight;
        }
      });
      _raStreamBubbleRemove();
      parsed=_raSplitStreamResponse(raw);
    }else{
      raw=await _raCallModel(built.sys,built.usr,_signal,_raTraceCtx);
      parsed=_raParseJSON(raw);
    }
    _raHideTyping();
    if(typeof endAiGen==='function')endAiGen();
    if(!parsed||!Array.isArray(parsed.sectionUpdates)){
      raAppendMessage(conv,'agent','I had trouble putting together an opening summary just now. Try typing a message below and I’ll pick this up from there.');
      _raPersist();
      return;
    }
    // QA issue #7 — use the AI's own contextual suggestedTitle if still on
    // the default placeholder (never overwrite a conversation the user has
    // already renamed). Falls back to the old boilerplate only if the model
    // omitted the field entirely — never leaves the title un-set. Only a
    // genuine model suggestion clears titleIsPlaceholder — the boilerplate
    // fallback keeps it true so a later turn (see _raRunTurn()) can still
    // retitle once the conversation gets more specific. Set BEFORE
    // _raApplySectionUpdates() below, since _raBuildDraftMd() reads
    // conv.title for the brief's H1 — otherwise the H1 would lag one turn
    // behind the actual title.
    if(conv.titleIsPlaceholder){
      var _suggested=(parsed.suggestedTitle||'').trim();
      if(_suggested){conv.title=_suggested;conv.titleIsPlaceholder=false;}
      else conv.title='Release requirements'; // product-name-free fallback — titleIsPlaceholder stays true so a later turn can still replace this
    }
    conv.liveDraftMd=_raApplySectionUpdates(conv,parsed.sectionUpdates);
    conv.draftVersion=1;
    conv.touchedCapabilityKeys=_raParseTouchedCapabilities(conv.liveDraftMd);
    conv.openQuestions=_raDedupeQuestions(parsed.openQuestions).map(function(q,i){return {id:'oq'+i,type:'clarification',resolved:false,messageIndex:(conv.messages||[]).length};});
    raAppendMessage(conv,'agent',parsed.chatReply||'Here’s a starting draft — take a look on the right.',{clarifyingQuestions:conv.raQuestionsOptedOut?[]:_raSanitizeClarifyingQuestions(parsed.clarifyingQuestions)});
    conv.updatedAt=new Date().toISOString();
    raRenderLiveDraft();
    raRenderConvList();
    _raPersist();
  }catch(err){
    _raHideTyping();
    _raStreamBubbleRemove();
    if(typeof endAiGen==='function')endAiGen();
    if(err&&err.name==='AbortError')return; // user chose "Leave anyway" — no error bubble needed
    console.warn('[requirement-agent] opening turn failed',err);
    raAppendMessage(conv,'agent','Something went wrong generating the opening summary ('+(err&&err.message?err.message:'unknown error')+'). Type a message below, or refresh and try again.');
    _raPersist();
  }finally{
    _raSetBusy(false);
  }
}

// Shared tail for "the user has answered/said something, submit it as the
// next turn" - used by both the free-text textarea (raSendMessage()) and
// the quick-select chip click (raQuickReplyClick()) so there is exactly one
// place that appends the user message and runs the turn, not two competing
// copies of the same three lines.
// Item 3 code-review fix — takes the whole `staged` attachment object
// (or null/undefined) instead of three separate uploadedDocText/
// uploadedDocName/wasTruncated params that only ever came from one object
// at the single call site that populates them; avoids a signature that
// grows a new parameter (and a new caller-side ternary to keep in sync)
// for every future attachment field. Returns true if the message actually
// went through the guard below, false if it was rejected — callers use
// this to know whether it's safe to discard a staged attachment.
async function _raSubmitUserMessage(conv,text,staged){
  var uploadedDocText=staged?staged.text:null;
  var uploadedDocName=staged?staged.name:null;
  var wasTruncated=staged?staged.wasTruncated:false;
  if(!conv||raBusy||conv.status!=='draft'||(!text&&!uploadedDocText))return false;
  // v9.25.04 — stop-on-send (product decision), centralized here rather
  // than duplicated in raSendMessage()/raQuickReplyClick(): RA's mic
  // previously stayed listening across Sends by design (a multi-turn chat,
  // unlike every other single-shot AI-refine box's own stop-on-send), but
  // that was reported as unexpected in practice. Placing the call AFTER
  // the guard above (not in each caller, before their own guards) matters:
  // a code-review pass on the first version of this fix found it firing
  // before the empty-text/empty-answer checks in both callers, silently
  // killing an active dictation session on a no-op Enter press or stray
  // click — the exact class of bug capability-canvas.js's
  // ccGenerateFeaturesForCapClick() was already fixed for once before
  // (guard-before-stop). Since this function is the single choke point
  // both callers route through, one guarded call here covers both, and
  // any future third submit path automatically inherits it too.
  voiceStopActive('abort');
  if(text&&_raDetectsQuestionsOptOut(text))conv.raQuestionsOptedOut=true;
  // Item 3 — transcript display: a text-line prepended to the message
  // (not a new badge component), per confirmed decision — reuses the
  // existing bubble renderer as-is, no new visual pattern.
  var displayText=uploadedDocName?('📎 Uploaded: '+uploadedDocName+(text?('\n\n'+text):'')):text;
  raAppendMessage(conv,'user',displayText);
  await _raRunTurn(conv,text,uploadedDocText,uploadedDocName);
  if(wasTruncated){
    // v9.30.05 code-review fix — _raRunTurn()'s own persist (its success
    // path) already ran before this message exists, so nothing else in
    // this flow would ever save it; persisted explicitly here instead.
    raAppendMessage(conv,'agent','Only the first '+RA_MAX_UPLOAD_WORDS.toLocaleString()+' words of '+uploadedDocName+' were used - for a longer document, consider uploading just the most relevant section.');
    _raPersist();
  }
  return true;
}
async function raSendMessage(){
  // Checked first, before ever touching the textarea's value - the
  // textarea now stays enabled while a turn is in flight (see
  // _raSetBusy()) so the PM can keep typing during the ~minute a turn
  // takes, so an Enter press or stray Send click mid-generation must be a
  // pure no-op that leaves whatever they were typing untouched, not
  // silently clear it out from under them.
  if(raBusy)return;
  if(typeof _raCanEditOwner==='function'&&!_raCanEditOwner())return;
  // Item 1 fix — Send-while-dictating stops the mic and leaves the
  // transcribed text in the box for review/edit, matching Claude's own
  // voice UX, instead of submitting immediately. Checked BEFORE reading/
  // clearing the textarea. _viListening is true for both the 'connecting'
  // and 'listening' UI states (it flips true synchronously on .start(),
  // before the state moves from connecting to listening on the real
  // onstart event) — so this single check covers both without a race where
  // the mic finishes connecting a beat after Send is clicked and starts
  // writing into a box that's already been cleared/submitted.
  if(_viListening&&_viActive&&_viActive.textareaId==='ra-chat-input'){
    voiceStopActive('stop'); // 'stop', not 'abort' — lets the last in-flight spoken segment land, same as the manual mic-toggle-off path
    return;
  }
  var conv=_raActiveConv();
  var input=document.getElementById('ra-chat-input');
  if(!input)return;
  var text=input.value.trim();
  var staged=conv&&_raStagedUploadByConvId[conv.id];
  if(!text&&!staged)return; // Item 3 — was `if(!text)return;`; now either is sufficient
  input.value='';
  if(staged){
    delete _raStagedUploadByConvId[conv.id];
    _raRenderStagedAttachment(conv); // clear the chip visually before the turn starts
  }
  var _raSubmitted=await _raSubmitUserMessage(conv,text,staged);
  // Item 3 code-review fix — if the submit guard rejected the message
  // (e.g. a collaborator finalized this conversation in the window between
  // staging and clicking Send), restore the just-cleared attachment rather
  // than silently losing the extracted document text with no way back
  // short of re-uploading the file.
  if(staged&&!_raSubmitted){
    _raStagedUploadByConvId[conv.id]=staged;
    _raRenderStagedAttachment(conv);
  }
}
// Handles a click on a quick-select chip (_raQuickReplyHtml()) - forwards
// the chosen option text through the same submit path as typing it would,
// so the model's next turn sees it exactly like any other user message.
function raQuickReplyClick(btnEl){
  var conv=_raActiveConv();
  if(!conv||raBusy||conv.status!=='draft')return;
  if(typeof _raCanEditOwner==='function'&&!_raCanEditOwner())return;
  var answer=btnEl.dataset.answer;
  if(!answer)return;
  // Remove the whole quick-reply block immediately - confirms the pick
  // visually and prevents a double-click submitting the same answer twice.
  var block=btnEl.closest('.ra-quick-reply-block');
  if(block)block.remove();
  _raSubmitUserMessage(conv,answer);
}

// uploadedDocText/uploadedDocName (optional) — a document dropped via the
// mid-chat upload chip (raHandleUpload()), ephemeral by design: matches
// Guided Launch's existing convention exactly (see guided-launch.js's
// _glRunRevisionTurn()) — the raw text is never persisted, only whatever
// the model merges into liveDraftMd survives a refresh.
// v14 (D6) — retrieval query priority order: current message in full, then
// the agent's prior reply, then the PM's prior message. By the time this
// runs, conv.messages already has the CURRENT user message appended as its
// last entry (raAppendMessage() in _raSubmitUserMessage()/raQuickReplyClick()
// runs before _raRunTurn() is called) — scans backward from before that
// entry, by role, rather than assuming strict turn alternation.
function _raBuildRetrievalQuery(conv,userMessage){
  var parts=[];
  if(userMessage)parts.push(userMessage);
  var msgs=(conv.messages||[]).slice(0,-1);
  var priorAgent=null,priorUser=null;
  for(var i=msgs.length-1;i>=0&&(priorAgent===null||priorUser===null);i--){
    if(priorAgent===null&&msgs[i].role==='agent')priorAgent=msgs[i].text;
    else if(priorUser===null&&msgs[i].role==='user')priorUser=msgs[i].text;
  }
  if(priorAgent)parts.push(priorAgent);
  if(priorUser)parts.push(priorUser);
  return parts.join('\n\n').trim();
}

// Below this similarity, a retrieved chunk is treated as not actually
// relevant to the current turn and dropped rather than injected — an
// initial, conservative value; tune against real retrieval quality once
// this is live (not specified numerically anywhere in the spec, unlike the
// 20,000-word upload cap in OI-3, so treated as a tunable default here
// rather than a fixed requirement).
var RA_RETRIEVAL_RELEVANCE_THRESHOLD=0.3;

// v14 (D3) — groups retrieved chunks by source document and formats each
// document's group once via the shared, existing _docFormatBlock() (D3) —
// not a new framing mechanism.
function _raFormatRetrievedChunks(rows){
  if(!rows||!rows.length)return '';
  var byDoc={};
  var order=[];
  rows.forEach(function(r){
    if(!byDoc[r.doc_name]){byDoc[r.doc_name]=[];order.push(r.doc_name);}
    byDoc[r.doc_name].push(r.chunk_text);
  });
  if(typeof _docFormatBlock!=='function')return '';
  return order.map(function(name){
    var doc={name:name,docType:'other',scope:'session',sessionScoped:true};
    return _docFormatBlock(doc,byDoc[name].join('\n\n...\n\n'));
  }).join('\n\n');
}

async function _raRunTurn(conv,userMessage,uploadedDocText,uploadedDocName){
  _raSetBusy(true);
  _raShowTyping();
  var _signal=(typeof startAiGen==='function')?startAiGen('Requirement Agent is updating the draft. Leaving now discards this update, you\'ll need to resend your message.'):null;
  var _streaming=_raStreamingEnabled();
  var _raTraceCtx=_raEnsureTraceCtx(conv);
  try{
    // v14 (D5/D6/D8) — existence-only gate first: skip the embed+search
    // round trip entirely when this conversation has no active documents.
    // Every step below degrades to "no retrieved context" on any failure
    // (network, embedding service down, schema-version mismatch) rather
    // than blocking the turn — a PM's ability to keep chatting must never
    // depend on the embedding service being up.
    var _raRetrievedCtx='';
    // v14 code-review fix — captured once, before any of the awaits below,
    // per this project's own "capture session identity BEFORE async work"
    // convention (already followed in raHandleUpload()). Re-reading the
    // global separately for the list-documents call and the later
    // search-chunks call meant a PM switching sessions mid-turn could pair
    // the NEW session's id with this (OLD) conversation's id on the second
    // call, producing a spurious authorization error the surrounding catch
    // would just silently degrade to "no retrieved context."
    var _raRetrievalSessionId=(typeof _activeSessionId!=='undefined')?_activeSessionId:null;
    // Code-review fix — _raUsageExtraFields() otherwise re-reads the live
    // _activeSessionId global AFTER the retrieval awaits below, which can
    // differ from the session this trace was created/continued under if
    // the PM switches sessions mid-turn (the same race this file already
    // guards against for the retrieval calls above). A mismatch makes the
    // RPC's identity check reject the whole usage-event write, silently
    // losing that call's cost/telemetry row. Pinning session_id onto
    // _raTraceCtx here — before any await — makes _raUsageExtraFields()'s
    // Object.assign(defaults, traceCtx) pick up this same captured value
    // instead of re-reading the global.
    _raTraceCtx.session_id=_raRetrievalSessionId;
    try{
      if(_raRagEnabled()&&_raRetrievalSessionId&&typeof _pgtRpc==='function'){
        // v14 code-review fix (efficiency) — _raDocsExistCache (populated by
        // raRenderAttachedDocs(), which already fetches this same list on
        // conversation open/upload/removal) lets most turns skip this RPC
        // entirely instead of re-fetching the full document list purely to
        // check its length. Only a genuinely unknown state (undefined —
        // cache never primed for this conversation yet) falls back to a
        // real fetch, which then primes the cache for every turn after it.
        var _raHasDocs=_raDocsExistCache[conv.id];
        if(_raHasDocs===undefined){
          var _raDocsRes=await _pgtRpc('ra_list_documents',{p_session_id:_raRetrievalSessionId,p_conversation_id:conv.id});
          _raHasDocs=!!(_raDocsRes&&!_raDocsRes.error&&Array.isArray(_raDocsRes.data)&&_raDocsRes.data.length);
          _raDocsExistCache[conv.id]=_raHasDocs;
        }
        if(_raHasDocs){
          var _raQuery=_raBuildRetrievalQuery(conv,userMessage);
          if(_raQuery){
            var _raQueryEmbedRes=await _raEmbedTexts([_raQuery]);
            if(_raQueryEmbedRes&&Array.isArray(_raQueryEmbedRes.embeddings)&&_raQueryEmbedRes.embeddings[0]){
              var _raSearchRes=await _pgtRpc('ra_search_doc_chunks',{
                p_session_id:_raRetrievalSessionId,
                p_conversation_id:conv.id,
                p_query_embedding:_raQueryEmbedRes.embeddings[0],
                p_current_schema_version:_raQueryEmbedRes.embedding_schema_version,
                p_limit:4
              });
              if(_raSearchRes&&!_raSearchRes.error&&Array.isArray(_raSearchRes.data)){
                var _raRelevant=_raSearchRes.data.filter(function(r){return typeof r.similarity==='number'&&r.similarity>=RA_RETRIEVAL_RELEVANCE_THRESHOLD;});
                _raRetrievedCtx=_raFormatRetrievedChunks(_raRelevant);
              }
            }
          }
        }
      }
    }catch(_raRetrievalErr){
      console.warn('[requirement-agent] document retrieval failed — continuing without retrieved context',_raRetrievalErr);
    }

    // Reuse _raQuery from the retrieval block above (var-hoisted, so safely
    // referenced even when that block never ran) instead of re-scanning
    // conv.messages via _raBuildRetrievalQuery a second time — only recompute
    // when it was never set (RAG off, or no docs yet), which also preserves
    // D7's current-message/prior-reply/prior-message fallback chain for that case.
    var _raRankQuery=(typeof _raQuery!=='undefined'&&_raQuery)?_raQuery:((typeof _raBuildRetrievalQuery==='function')?_raBuildRetrievalQuery(conv,userMessage):userMessage);
    var _raDocRes2=(typeof buildDocContext==='function')?buildDocContext('ra',_raRankQuery):{text:'',truncated:false};
    var _raDocCtx2=_raDocRes2.text;
    _fireDocTruncatedToast(_raDocRes2.truncated);
    var built=buildRequirementAgentTurnPrompt(typeof sessionContext!=='undefined'?sessionContext:{},conv.liveDraftMd,(conv.messages||[]).slice(0,-1),userMessage,_raDocCtx2,uploadedDocText,uploadedDocName,_streaming,_raRetrievedCtx);
    var raw,parsed;
    if(_streaming){
      var _bubbleEl=null;
      var extra=_raUsageExtraFields(_raTraceCtx);
      raw=await callAPIStream(built.sys,built.usr,4000,_signal,null,'requirement-agent',null,extra,function(delta){
        _raHideTyping();
        if(!_bubbleEl)_bubbleEl=_raStreamBubbleShow();
        if(_bubbleEl){
          _bubbleEl.textContent=(_bubbleEl.textContent||'')+delta;
          var _body=document.getElementById('ra-chat-body');
          if(_body)_body.scrollTop=_body.scrollHeight;
        }
      });
      _raStreamBubbleRemove();
      parsed=_raSplitStreamResponse(raw);
    }else{
      raw=await _raCallModel(built.sys,built.usr,_signal,_raTraceCtx);
      parsed=_raParseJSON(raw);
    }
    _raHideTyping();
    if(typeof endAiGen==='function')endAiGen();
    if(!parsed||!Array.isArray(parsed.sectionUpdates)){
      raAppendMessage(conv,'agent','I couldn’t process that update. Could you rephrase, or try again?');
      _raPersist();
      return;
    }
    // Gated on titleLocked, not titleIsPlaceholder — a PM's explicit rename
    // is the only thing that should ever stop auto-retitling. Gating on
    // titleIsPlaceholder instead (the old bug) latched permanently the
    // FIRST time any real suggestedTitle landed, so a later, genuine topic
    // pivot could never update the title again even though it was never
    // manually set. Set BEFORE _raApplySectionUpdates() below — see
    // raRunOpeningTurn()'s matching comment for why the ordering matters
    // (conv.title feeds the brief's H1).
    if(!conv.titleLocked){
      var _suggestedTurn=(parsed.suggestedTitle||'').trim();
      if(_suggestedTurn){conv.title=_suggestedTurn;conv.titleIsPlaceholder=false;}
    }
    conv.liveDraftMd=_raApplySectionUpdates(conv,parsed.sectionUpdates);
    conv.draftVersion=(conv.draftVersion||1)+1;
    conv.touchedCapabilityKeys=_raParseTouchedCapabilities(conv.liveDraftMd);
    var existingResolved={};
    (conv.openQuestions||[]).forEach(function(q){existingResolved[q.id]=q.resolved;});
    conv.openQuestions=_raDedupeQuestions(parsed.openQuestions).map(function(q,i){var id='oq'+i;return {id:id,type:'clarification',resolved:!!existingResolved[id],messageIndex:(conv.messages||[]).length};});
    raAppendMessage(conv,'agent',parsed.chatReply||'Updated the draft — take a look.',{clarifyingQuestions:conv.raQuestionsOptedOut?[]:_raSanitizeClarifyingQuestions(parsed.clarifyingQuestions)});
    conv.updatedAt=new Date().toISOString();
    raRenderLiveDraft();
    raRenderConvList();
    _raPersist();
  }catch(err){
    _raHideTyping();
    _raStreamBubbleRemove();
    if(typeof endAiGen==='function')endAiGen();
    if(err&&err.name==='AbortError')return; // user chose "Leave anyway" — no error bubble needed
    console.warn('[requirement-agent] turn failed',err);
    raAppendMessage(conv,'agent','Something went wrong processing that ('+(err&&err.message?err.message:'unknown error')+'). Please try again.');
    _raPersist();
  }finally{
    _raSetBusy(false);
  }
}

// ── Mid-chat upload (persistent, RA-Persistent-Doc-RAG-Spec-v14) ──
// Extracts text client-side (extractTextFromFile, shared with Home's
// session docs and Guided Launch's own mid-chat upload — see utils.js),
// chunks + caps it, embeds every chunk via the proxy, then ingests it via
// ra_ingest_document_chunks() so it's retrievable for this conversation's
// FULL lifetime (including after pause/resume) — not fed into the current
// turn directly. This is the actual behavior change this spec exists to
// make: retrieval happens later, per-turn, in _raRunTurn(); this function's
// only job is getting the document indexed.
var RA_MAX_UPLOAD_WORDS=20000;
// v9.30.03 — separate, much smaller cap for _raGetDocGist()'s own call,
// below. That call only needs enough text to characterize the document, not
// the full up-to-20,000-word ingest text — keeping it small keeps the
// gist/suggested-questions step cheap and fast.
var RA_GIST_MAX_WORDS=3000;
// v9.27.01 code-review fix — shared by both raHandleUpload() branches (RAG-
// on ingest and RAG-off ephemeral), which otherwise duplicated this same
// extract-and-normalize preamble verbatim and had already begun to drift
// in their fallback-unavailable error message.
async function _raExtractUpload(file){
  var extractFn=(typeof extractTextFromFile==='function')?extractTextFromFile:function(){return Promise.reject(new Error('extractTextFromFile not available'));};
  var extracted=await extractFn(file,RA_MAX_UPLOAD_WORDS);
  return {
    text:(extracted&&typeof extracted==='object')?extracted.text:extracted,
    wasTruncated:!!(extracted&&typeof extracted==='object'&&extracted.truncated)
  };
}
// v14 code-review fix (round 3) — the original deterministic-hash approach
// (derived purely from name+size+lastModified, no randomness at all) meant
// re-uploading the EXACT same file after a client-side timeout always
// regenerated the identical doc_id — which D4's lifecycle model correctly
// treats as terminal and never resurrects, so that specific file could
// never be re-attached to that conversation again, and the RPC's own
// "upload it again as a new document" advice was impossible to satisfy
// (re-selecting the same file always produces the same id).
//
// Replaced with a short-lived, in-memory-only retry cache instead: the
// SAME file re-selected while an earlier attempt for it is still pending
// (not yet confirmed success) reuses that attempt's id — which is what
// D4's idempotency path actually exists for (a client-side timeout after
// the server already committed). Any other case — a fresh upload, or
// re-uploading after the earlier attempt succeeded — gets a brand new
// random id via _raUid(), exactly like every other identity in this file.
// Cleared on confirmed ingest success (raHandleUpload(), below) —
// per-document removal no longer exists (v9.30.03), so that's the only
// clear path now.
var _raPendingUploadIds={}; // key: "convId|name|size|lastModified" -> doc_id
function _raUploadIdKey(conv,file){
  return conv.id+'|'+file.name+'|'+file.size+'|'+(file.lastModified||0);
}

// Item 3 — renders (or clears) the staged-attachment chip for the given
// conversation, reusing the existing .sp-file-chip/.sp-file-chip-remove
// component (styles/15-settings.css) rather than a new one-off style.
function _raRenderStagedAttachment(conv){
  var box=document.getElementById('ra-staged-attachment');
  if(!box)return;
  var staged=conv&&_raStagedUploadByConvId[conv.id];
  if(!staged){box.innerHTML='';return;}
  box.innerHTML='<span class="sp-file-chip"><i class="ti ti-file" style="font-size:9px;" aria-hidden="true"></i> '+e(staged.name)+'<button class="sp-file-chip-remove" onclick="_raClearStagedAttachment()" aria-label="Remove attachment"><i class="ti ti-x" style="font-size:9px;" aria-hidden="true"></i></button></span>';
}
function _raClearStagedAttachment(){
  var conv=_raActiveConv();
  if(conv)delete _raStagedUploadByConvId[conv.id];
  _raRenderStagedAttachment(conv);
}

async function raHandleUpload(inputEl){
  var conv=_raActiveConv();
  var file=inputEl.files&&inputEl.files[0];
  inputEl.value='';
  if(!file||!conv||raBusy||conv.status!=='draft')return;
  if(typeof _raCanEditOwner==='function'&&!_raCanEditOwner())return;

  if(!_raRagEnabled()){
    // Item 3 fix — RAG off: stage the extracted text as a removable chip
    // instead of submitting the instant extraction finishes, so a caption
    // can be added before sending. Extraction still shares the same 20k-word
    // cap as the RAG-on path, with its own truncation disclosure.
    _raSetBusy(true);
    _raShowTyping(); // reuse existing "reading file" indicator — no new UI for the extraction wait
    try{
      var _raExt=await _raExtractUpload(file);
      var text=_raExt.text,wasTruncated=_raExt.wasTruncated;
      _raHideTyping();
      _raSetBusy(false);
      if(!text||!text.trim()){
        raAppendMessage(conv,'agent',file.name+' didn’t have any readable text - try a different file, or tell me about it directly in chat.');
        _raPersist();
        return;
      }
      // Stage, don't submit — replaces any previously staged attachment for
      // this conversation (single-attachment v1, confirmed with Nethaji).
      _raStagedUploadByConvId[conv.id]={name:file.name,text:text,wasTruncated:wasTruncated};
      // Item 3 code-review fix — raOpenConversation() has no busy guard, so
      // the PM can switch to a different conversation while this extraction
      // (an await above) is still in flight. #ra-staged-attachment is a
      // single, non-namespaced DOM slot — writing into it unconditionally
      // here would render THIS conversation's chip into whichever OTHER
      // conversation is now on screen. Only write the DOM if this
      // conversation is still the one actually displayed; otherwise the
      // data is already correctly stored under conv.id and will render
      // correctly whenever raRenderCenter() next shows this conversation.
      if(_raActiveConv()===conv)_raRenderStagedAttachment(conv);
    }catch(err){
      _raHideTyping();
      _raSetBusy(false);
      var msg=(err&&err.message==='PASSWORD_PROTECTED')
        ?file.name+' is password-protected - remove the password and re-upload.'
        :'Could not read '+file.name+'.';
      raAppendMessage(conv,'agent',msg);
      _raPersist();
    }
    return;
  }

  // v14 code-review fix — captured into a local now, before any async work
  // below, per AI_EDITING_RULES.md's "capture session identity BEFORE async
  // work" rule: reading the _activeSessionId global again after the
  // extract/embed awaits below could pick up a DIFFERENT session's id if
  // the PM switched sessions mid-upload.
  var sessionId=(typeof _activeSessionId!=='undefined')?_activeSessionId:null;

  // v9.30.05 code-review fixes, both scoped to this RAG-on branch (the one
  // with several multi-second awaits — embed, ingest, the gist call):
  //  - _raPersistThisUpload(): _raPersist() itself always targets the LIVE
  //    _activeSessionId global, not any argument, so calling it after the
  //    PM has switched to a DIFFERENT session mid-upload would silently
  //    persist that other session's own snapshot while this upload's
  //    message is never saved anywhere. Guards on the sessionId captured
  //    above — the same identity already used for every RPC call here —
  //    and skips the persist rather than risk that silent misdirected save.
  //  - _raUploadReject()/_raUploadFailAfterIndexing(): the
  //    raAppendMessage()+persist(+cleanup) sequence was repeated verbatim
  //    at every one of this branch's early-return/catch points; a future
  //    edit to it (or a new early return) could easily miss the persist
  //    call at one site, silently reintroducing the very bug these are
  //    fixing. One call site per pattern instead of nine.
  function _raPersistThisUpload(){
    if(typeof _activeSessionId==='undefined'||_activeSessionId===sessionId)_raPersist();
  }
  function _raUploadReject(msg){
    raAppendMessage(conv,'agent',msg);
    _raPersistThisUpload();
  }
  function _raUploadFailAfterIndexing(msg){
    _raHideIndexing();
    _raSetBusy(false);
    raAppendMessage(conv,'agent',msg);
    _raPersistThisUpload();
  }

  if(!sessionId){
    _raUploadReject('Could not upload '+file.name+' - no active session.');
    return;
  }
  // v14 code-review fix — filename length checked client-side, before
  // anything else runs. mt_ra_docs' own doc_name CHECK (1-300 chars) would
  // catch this too, but only after extraction AND embedding already ran -
  // this rejects it for free, before any of that work starts.
  if(file.name.length>300){
    _raUploadReject('That filename is too long (over 300 characters) - rename the file and try again.');
    return;
  }

  // v14 code-review fix (round 2) — moved before the "Uploaded: X" message
  // below, and out of the main try block: fetch the CURRENT document count
  // fresh (never a stale client-held count) and reject before anything is
  // added to the transcript. This used to run AFTER "Uploaded: X" was
  // already appended, so a rejected upload left a permanent, false record
  // in the conversation history claiming something was uploaded when
  // nothing was — the same class of persisted-false-state bug
  // raNewConversation()'s own fix (elsewhere in this file) was careful to
  // avoid by using a toast instead of raAppendMessage() on failure.
  var _raCountRes;
  try{
    _raCountRes=await _pgtRpc('ra_list_documents',{p_session_id:sessionId,p_conversation_id:conv.id});
  }catch(err){
    _raUploadReject((err&&err.message)||('Could not upload '+file.name+'.'));
    return;
  }
  if(_raCountRes&&_raCountRes.error){
    _raUploadReject(_raCountRes.error.message||('Could not upload '+file.name+'.'));
    return;
  }
  if(Array.isArray(_raCountRes&&_raCountRes.data)&&_raCountRes.data.length>=5){
    _raUploadReject('Maximum 5 documents per conversation reached - remove one before uploading another.');
    return;
  }

  raAppendMessage(conv,'user','Uploaded: '+file.name);
  _raSetBusy(true);
  _raShowIndexing(file.name);
  try{
    var _raExt=await _raExtractUpload(file);
    var text=_raExt.text,wasTruncated=_raExt.wasTruncated;
    if(!text||!text.trim()){
      _raUploadFailAfterIndexing(file.name+' didn’t have any readable text - try a different file, or tell me about it directly in chat.');
      return;
    }

    // D3 — word-based chunks from the shared chunker, then capped to
    // mt_ra_doc_chunks' 4000-character CHECK constraint (a chunk of short,
    // dense words can exceed 4000 characters despite being under the word
    // cap — see _raCapChunkChars()'s own comment in utils.js).
    var chunks=_raCapChunkChars(chunkText(text));
    if(!chunks.length){
      _raUploadFailAfterIndexing(file.name+' didn’t have any readable text - try a different file, or tell me about it directly in chat.');
      return;
    }

    var embedRes=await _raEmbedTexts(chunks);
    if(!embedRes||!Array.isArray(embedRes.embeddings)||embedRes.embeddings.length!==chunks.length){
      throw new Error('Embedding response did not match the number of chunks sent.');
    }

    var payloadChunks=chunks.map(function(t,i){return {chunk_text:t,embedding:embedRes.embeddings[i]};});
    var _raUpKey=_raUploadIdKey(conv,file);
    var docId=_raPendingUploadIds[_raUpKey]||_raUid();
    _raPendingUploadIds[_raUpKey]=docId;
    var ingestRes=await _pgtRpc('ra_ingest_document_chunks',{
      p_session_id:sessionId,
      p_conversation_id:conv.id,
      p_doc_id:docId,
      p_doc_name:file.name,
      p_embedding_schema_version:embedRes.embedding_schema_version,
      p_chunks:payloadChunks
    });
    // Surfaces the RPC's own exact message per D4's lifecycle model
    // (previously-removed, reused-with-different-content, max-5-documents,
    // lock-contention/BUSY) rather than a generic failure — D8. Lock
    // contention is never auto-retried here; the RPC's own message already
    // tells the PM to try again shortly, on their own action.
    if(ingestRes&&ingestRes.error)throw ingestRes.error;
    delete _raPendingUploadIds[_raUpKey]; // confirmed success - no longer "pending"; a future re-upload of this same file gets a fresh id

    // Attached-docs list reflects real, already-committed backend state, so
    // it's shown immediately — independent of the gist wait below.
    raRenderAttachedDocs(conv);

    // v9.30.04 — the spinner (and raBusy, which keeps the composer from
    // accepting a new message mid-upload) is now held through the gist call
    // too, not just embed/ingest, and the two outcomes are revealed as ONE
    // merged message. Confirmed via live PM feedback on the earlier design
    // (separate, later, fire-and-forget gist message): "Indexed X" appearing
    // immediately read as "upload finished, nothing else coming" — the PM
    // had already started typing by the time the gist/suggested-questions
    // message popped in seconds later, unprompted. _raGetDocGist() is
    // internally bounded by RA_GIST_TIMEOUT_MS, so this can never leave the
    // PM waiting indefinitely — on timeout or failure it resolves null and
    // the plain "Indexed X..." confirmation below (today's original copy)
    // is used as-is, with no chips and no later pop-in for the same reason.
    var truncNote=wasTruncated?' Only the first '+RA_MAX_UPLOAD_WORDS.toLocaleString()+' words were indexed - for a longer document, consider uploading just the most relevant section.':'';
    var gistResult=await _raGetDocGist(conv,file.name,text);
    _raHideIndexing();
    _raSetBusy(false);
    // v9.30.05 code-review fix — restores the guard the old, separate
    // _raShowDocGist() had before its own append (dropped when its message
    // was merged into this one): raOpenConversation() has no busy guard
    // (see this branch's own earlier comment), so the PM can switch to a
    // different conversation during this up-to-8s wait. raAppendMessage()
    // is DOM-unconditional — appending here regardless would paint this
    // confirmation (and its suggested-question chips, clickable via
    // _raActiveConv()) into whichever OTHER conversation is now on screen.
    if(_raActiveConv()!==conv||conv.status!=='draft')return;
    // v9.30.05 code-review fix — one call with a computed tail instead of
    // two near-identical raAppendMessage calls that both rebuilt the same
    // 'Indexed '+file.name+'.'+truncNote+' ' prefix.
    var tail=(gistResult&&gistResult.gist)?gistResult.gist:'You can ask me about it anytime while this conversation is open.';
    raAppendMessage(conv,'agent','Indexed '+file.name+'.'+truncNote+' '+tail,{suggestedQuestions:gistResult&&gistResult.suggestedQuestions});
    _raPersistThisUpload();
  }catch(err){
    var msg;
    if(err&&err.message==='PASSWORD_PROTECTED'){
      msg=file.name+' is password-protected - remove the password and re-upload.';
    }else if(err&&err.message){
      msg=err.message;
    }else{
      msg='Could not upload '+file.name+'.';
    }
    _raUploadFailAfterIndexing(msg);
  }
}

// v9.30.04 — returns {gist,suggestedQuestions} once resolved, or null on
// any failure/timeout; appends nothing itself (raHandleUpload(), above,
// owns building and appending the single merged confirmation message, and
// deciding the plain-copy fallback when this returns null).
// v9.30.06 — bumped from 8000: confirmed via live use that 8s was too
// tight for the real call's latency (proxy relay + model) on at least one
// real upload, silently falling back to the plain copy with zero evidence
// of why — see the per-branch console.warn calls added below, which now
// distinguish timeout / call failure / unusable response so the NEXT
// silent fallback is actually diagnosable instead of a repeat guessing game.
var RA_GIST_TIMEOUT_MS=20000;
async function _raGetDocGist(conv,fileName,text){
  try{
    if(typeof buildRequirementAgentDocGistPrompt!=='function'||typeof _raCallModel!=='function')return null;
    // v9.30.05 code-review fix (efficiency) — cheap length pre-check before
    // the expensive split/filter below, which only ever matters for a
    // document long enough to plausibly exceed RA_GIST_MAX_WORDS words; *2
    // is a deliberately conservative (short) chars-per-word floor, so this
    // can never skip truncation for a document that's actually over the
    // cap. The common case (a short upload) now skips tokenizing the whole
    // document just to learn it's already under the cap.
    var gistInput=text;
    if(text&&text.length>RA_GIST_MAX_WORDS*2){
      var words=text.trim().split(/\s+/).filter(Boolean);
      if(words.length>RA_GIST_MAX_WORDS)gistInput=words.slice(0,RA_GIST_MAX_WORDS).join(' ');
    }
    var built=buildRequirementAgentDocGistPrompt(fileName,gistInput);
    // v9.30.05 code-review fix — AbortController is already used
    // unconditionally elsewhere in this codebase (utils.js's startAiGen(),
    // itself called by this file's own raRunOpeningTurn()/_raRunTurn()), so
    // the previous typeof guard here was inconsistent, defensive complexity
    // for a browser gap nothing else in this app guards against.
    var controller=new AbortController();
    // v9.30.05 code-review fix — the abort signal only reaches the eventual
    // fetch() inside callAPI(); it does NOT cover the authGetFreshToken()
    // await callAPI() runs before that fetch, so a stall there wasn't
    // actually bounded by this timeout despite the old comment's claim.
    // Racing the whole call against a timeout (in addition to still
    // aborting, so the fetch itself is cancelled once/if reached)
    // guarantees this never waits past RA_GIST_TIMEOUT_MS regardless of
    // which stage stalls.
    // v9.30.06 — the model call's .catch() now logs before resolving to
    // null (previously silent, per a code-review fix that raced it against
    // the timeout — that fix was correct to race it, but swallowing the
    // real error along with it made a genuine failure indistinguishable
    // from a plain timeout). `timedOut` disambiguates the two outcomes
    // below: a rejection logs here; a timeout logs after the race instead
    // (whichever settles first still wins the race and clears the other).
    var timedOut=false;
    var timer;
    var timeoutPromise=new Promise(function(resolve){
      timer=setTimeout(function(){timedOut=true;controller.abort();resolve(null);},RA_GIST_TIMEOUT_MS);
    });
    var raw=await Promise.race([
      _raCallModel(built.sys,built.usr,controller.signal,_raEnsureTraceCtx(conv)).catch(function(err){
        // Our own timeout firing first is what triggers this AbortError in
        // the first place (controller.abort() above) — the dedicated
        // "timed out" log below already covers that case, so logging it
        // here too would just be a second, redundant line for one event.
        if(!(err&&err.name==='AbortError'))console.warn('[requirement-agent] doc gist call failed for '+fileName,err);
        return null;
      }),
      timeoutPromise
    ]);
    clearTimeout(timer);
    if(!raw){
      if(timedOut)console.warn('[requirement-agent] doc gist timed out after '+RA_GIST_TIMEOUT_MS+'ms for '+fileName);
      return null;
    }
    var parsed=_raParseJSON(raw);
    var gist=parsed&&String(parsed.gist||'').trim();
    if(!gist){
      console.warn('[requirement-agent] doc gist response had no usable gist field for '+fileName,raw);
      return null;
    }
    var questions=Array.isArray(parsed.suggestedQuestions)
      ?parsed.suggestedQuestions.map(function(q){return String(q||'').trim();}).filter(Boolean).slice(0,3)
      :[];
    return {gist:gist,suggestedQuestions:questions};
  }catch(err){
    console.warn('[requirement-agent] doc gist skipped (unexpected error) for '+fileName,err);
    return null;
  }
}

// ── Attached-documents display (D5) — read-only ──
// Fetches fresh from ra_list_documents() every time — never cached, per D5
// — since a stale client-side list could show a document as attached after
// its conversation was removed elsewhere (raResetState()'s cleanup pass).
//
// v9.30.03 — per-document removal deliberately dropped. Product call: once a
// file is indexed here it behaves like an attachment sent in any chat-LLM
// turn — permanent for the rest of THIS conversation, not an editable
// "staged" item you can retract later, matching how ChatGPT/Claude-style
// chat handles an uploaded file once it's part of the thread (only the
// pre-send staged chip, _raRenderStagedAttachment(), is ever removable).
// This list is now pure traceability ("what's grounding this conversation"),
// not a management surface — no remove control, no file-type icon, and no
// per-doc embedding-staleness badge (ra_search_doc_chunks already filters
// non-matching embedding-schema-version chunks server-side via
// p_current_schema_version, so a stale doc is silently excluded from
// retrieval regardless of any UI signal — the badge was transparency-only,
// never functionally load-bearing).
async function raRenderAttachedDocs(conv){
  var box=document.getElementById('ra-attached-docs');
  if(!box)return;
  // ra_list_documents() is a plain Supabase RPC with no Azure OpenAI
  // embedding dependency, so this list stays visible even while RAG is
  // toggled off — only new-upload ingest (raHandleUpload()) and retrieval
  // search (_raRunTurn()) are gated by _raRagEnabled().
  var ragOff=!_raRagEnabled();
  var offNote='<div style="font-size:11px;color:var(--t3);">RAG is off - uploads apply only to your next message.</div>';
  if(!conv||typeof _activeSessionId==='undefined'||!_activeSessionId||typeof _pgtRpc!=='function'){box.innerHTML=ragOff?offNote:'';return;}
  var res;
  try{
    res=await _pgtRpc('ra_list_documents',{p_session_id:_activeSessionId,p_conversation_id:conv.id});
  }catch(err){
    console.warn('[requirement-agent] raRenderAttachedDocs failed',err);
    if(_raActiveConv()===conv)box.innerHTML=ragOff?offNote:'';
    return;
  }
  // v14 code-review fix (efficiency) — primes _raDocsExistCache with this
  // fetch's real answer regardless of whether THIS render turns out to be
  // stale below; the data is accurate for conv.id either way, and this is
  // what lets _raRunTurn() skip its own existence-check RPC on later turns.
  if(res&&!res.error&&Array.isArray(res.data)){
    _raDocsExistCache[conv.id]=res.data.length>0;
  }
  // Re-check we're still looking at the same conversation's box — a slow
  // fetch landing after the PM has since switched conversations must not
  // paint the wrong conversation's documents into a box that survived the
  // switch only because #ra-attached-docs is part of the same DOM subtree.
  if(_raActiveConv()!==conv)return;
  if(!res||res.error||!Array.isArray(res.data)||!res.data.length){box.innerHTML=ragOff?offNote:'';return;}
  box.innerHTML=(ragOff?'<div style="font-size:11px;color:var(--t3);margin-bottom:4px;">RAG is off - these won\'t be searched for your next message.</div>':'')
    +'<div class="ra-doc-list-plain">Attached: '+res.data.map(function(d){
      return '<span class="ra-doc-plain-item" title="'+e(d.doc_name)+'">'+e(d.doc_name)+' ('+e(_raRelTime(d.created_at))+')</span>';
    }).join('<span class="ra-doc-plain-sep">&middot;</span>')+'</div>';
}

// ── Live draft (right panel) ──
function raRenderLiveDraft(){
  var right=document.getElementById('ra-right');
  var conv=_raActiveConv();
  if(!right||!conv)return;
  var unresolvedCount=(conv.openQuestions||[]).filter(function(q){return!q.resolved;}).length;
  // §7 — Finalize is disabled until the conversation actually has a draft:
  // liveDraftMd is only populated once the opening turn completes (see
  // raRunOpeningTurn()/_raRunTurn()), so an empty/still-loading conversation
  // has nothing to finalize yet. Confirmed gap: previously Finalize was
  // clickable on a brand-new, empty conversation with zero effect other
  // than an unnecessary RPC/save round-trip.
  var hasDraftContent=!!(conv.liveDraftMd&&conv.liveDraftMd.trim().length>0);
  var verLabel=(conv.draftVersion>0)?(' · v0.'+(String(conv.draftVersion).length<2?('0'+conv.draftVersion):conv.draftVersion)):'';
  var exportBtn='<button class="gl-export-btn" onclick="raExportMd()" title="Download the current draft as a .md file"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Export</button>';
  right.innerHTML=
    // QA follow-up: the grey banner is back (it was over-removed in the
    // previous pass) — "LIVE DRAFT" eyebrow + the conversation's own
    // contextualized title (never the product name) + version badge, with
    // Export living here only (top-right), not duplicated in the footer.
    // The markdown body still starts directly at "## 1. Requirement Summary"
    // — only the body's own redundant "# H1" line is stripped, not this banner.
    '<div class="ra-md-hdr"><div class="ra-md-hdr-text"><div class="ra-md-hdr-eyebrow">Live Draft</div><div class="ra-md-hdr-title">'+e(conv.title||'Requirements Brief')+'<span class="ra-md-hdr-ver">'+verLabel+'</span></div></div>'
      +'<div class="ra-md-hdr-actions">'
      +(hasDraftContent?exportBtn:'')
      +'<button class="collapse-btn" onclick="raCollapseRightPanel()" title="Collapse panel"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/><polyline points="3 18 9 12 3 6"/></svg></button>'
      +'</div></div>'
    +'<div class="ra-md-body" id="ra-md-body">'+_raMdToHtml(_raStripLeadingH1(conv.liveDraftMd))+'</div>'
    +(conv.status==='finalized'
      ?'<div class="ra-md-footer"><div class="ra-status-badge ra-status-final">Finalized'+(conv.rqNumber?(' · '+e(conv.rqNumber)):'')+'</div></div>'
      :((typeof _raCanEditOwner!=='function')||_raCanEditOwner())
      ?'<div class="ra-md-footer"><div class="ra-footer-row">'
        +'<div class="ra-footer-note">Creates the capabilities and opens Capability Canvas.</div>'
        +'<button class="ra-finalize-btn'+(hasDraftContent?'':' ra-finalize-btn-disabled')+'" id="ra-finalize-btn" '+(hasDraftContent?'onclick="raFinalizeClick()"':'disabled title="Start the conversation to build a draft before finalizing"')+'><i class="ti ti-check" style="font-size:12px;" aria-hidden="true"></i> Finalize</button>'
      +'</div></div>'
      // v14 (D7) — Finalize is a standalone action button, hidden entirely
      // for a non-editable session rather than disabled, per the same
      // hidden-vs-disabled rule the rest of this app already follows.
      :'');
  _raEnhanceLiveDraftDom();
}

// Strips the live draft's own leading "# H1 title" line, since the banner
// above #ra-md-body already shows the conversation's contextualized title —
// keeping both would reintroduce the duplicate the earlier QA pass flagged.
// Only the first line is touched; everything from "## 1. Requirement
// Summary" onward is untouched.
function _raStripLeadingH1(md){
  if(!md)return md;
  return md.replace(/^\s*#\s[^\n]*\n+/,'');
}

// Mirrors Guided Launch's glExportMd() (guided-launch.js) — downloads the
// active conversation's live draft as a .md file, named from the
// conversation's own contextual title rather than the product name (RA's
// draft can cover any capability/release scope, not a whole product).
function raExportMd(){
  var conv=_raActiveConv();
  if(!conv)return;
  var md=conv.liveDraftMd||'';
  var blob=new Blob([md],{type:'text/markdown'});
  var url=URL.createObjectURL(blob);
  var a=document.createElement('a');
  var name=(conv.title||'requirements-brief').replace(/[^a-z0-9\-_]+/gi,'-').toLowerCase();
  a.href=url;
  a.download=name+'-requirements-brief.md';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function(){URL.revokeObjectURL(url);},1000);
}

// ══════════════════════════════════════════════════════════════════════════
// Live Draft New/Existing tagging (§11) — post-processes the rendered
// #ra-md-body DOM (rather than the markdown->HTML step itself) so
// _raMdToHtml() stays the same shared, generic renderer guided-launch.js
// uses. Applies identically in Pass 1 and Pass 2 — no conditional
// suppression based on pass number, per explicit confirmation in the spec.
//   - Capability-level: "(existing)"/"(will be created)" heading suffix ->
//     right-aligned NEW/EXISTING pill.
//   - Feature-level: "(new feature)"/"(existing feature): narrative" bullet
//     -> inline "(new)" suffix (existing features get no suffix, matching
//     the spec's "never re-list existing features as if newly proposed")
//     plus a click-to-expand requirement narrative, since always-visible
//     narrative text would make the panel very long for capabilities with
//     several features.
// ══════════════════════════════════════════════════════════════════════════
function _raEnhanceLiveDraftDom(){
  var body=document.getElementById('ra-md-body');
  if(!body)return;
  // Capability sub-headings — h3 elements tagged "(existing)"/"(will be created)".
  Array.prototype.slice.call(body.querySelectorAll('h3')).forEach(function(h){
    var m=h.textContent.match(/^(.*?)\s*\((existing|will be created)\)\s*$/i);
    if(!m)return;
    var isNew=/will be created/i.test(m[2]);
    h.innerHTML='<span class="ra-cap-tag-row"><span class="ra-cap-tag-name">'+e(m[1].trim())+'</span>'
      +'<span class="ra-tag-pill '+(isNew?'ra-tag-new':'ra-tag-existing')+'">'+(isNew?'NEW':'EXISTING')+'</span></span>';
  });
  // Feature bullets — li elements tagged "(new feature)"/"(existing feature): narrative".
  var uid=0;
  Array.prototype.slice.call(body.querySelectorAll('li')).forEach(function(li){
    var m=li.textContent.match(/^(.*?)\s*\((new|existing)\s+feature\)\s*:\s*(.*)$/i);
    if(!m)return;
    var isNew=/^new$/i.test(m[2]);
    var narrative=m[3].trim();
    var toggleId='ra-narr-'+(uid++);
    li.innerHTML='<span class="ra-feat-line">'+e(m[1].trim())+(isNew?' <span class="ra-feat-new-suffix">(new)</span>':'')
      +(narrative?' <button type="button" class="ra-feat-narr-toggle" onclick="var b=document.getElementById(\''+toggleId+'\');b.style.display=b.style.display===\'block\'?\'none\':\'block\';this.textContent=b.style.display===\'block\'?\'less\':\'more\';">more</button>':'')
      +'</span>'
      +(narrative?'<div class="ra-feat-narrative" id="'+toggleId+'" style="display:none;">'+e(narrative)+'</div>':'');
  });
  // Item 2 fix — tag the Open Questions heading with a stable id so
  // raReviewQuestions() can scroll the Live Draft panel to it, not just the
  // chat transcript.
  Array.prototype.slice.call(body.querySelectorAll('h2')).forEach(function(h){
    if(h.textContent.replace(/^\d+\.\s*/,'').trim()==='Open Questions'){
      h.id='ra-md-open-questions';
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════
// Finalize-blocked assumption modal — Type-1 Warn, per DESIGN_SYSTEM.md §8
// ══════════════════════════════════════════════════════════════════════════
function raFinalizeClick(){
  var conv=_raActiveConv();
  if(!conv||conv.status==='finalized'||raBusy)return;
  if(typeof _raCanEditOwner==='function'&&!_raCanEditOwner())return;
  // §9 — Finalize would create zero capabilities. Confirmed gap: previously
  // nothing checked this, so Finalize would silently "succeed" while
  // creating nothing. Surfaced explicitly, distinct from the unresolved-
  // questions warning below (a conversation can have real content and zero
  // unresolved questions, yet still touch no NEW capabilities at all).
  var newCapCount=(conv.touchedCapabilityKeys||[]).filter(function(t){return t.isNew;}).length;
  var unresolved=(conv.openQuestions||[]).filter(function(q){return!q.resolved;});
  if(newCapCount===0){
    raShowZeroCapabilityModal(conv,unresolved.length);
    return;
  }
  if(!unresolved.length){
    raRunFinalizeSequence(conv,false);
    return;
  }
  raShowAssumptionModal(conv,unresolved.length);
}

function raShowAssumptionModal(conv,n){
  var overlayId='ra-assume-overlay';
  var existing=document.getElementById(overlayId);
  if(existing)existing.remove();
  var overlay=document.createElement('div');
  overlay.className='modal-overlay';
  overlay.id=overlayId;
  overlay.innerHTML=
    '<div class="modal" style="max-width:400px;position:relative;">'
      +'<button onclick="document.getElementById(\''+overlayId+'\').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:3px;color:var(--t3);display:flex;align-items:center;border-radius:4px;z-index:1;" title="Close">'
        +'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
      +'</button>'
      +'<div style="padding:20px 52px 20px 20px;display:flex;align-items:flex-start;gap:12px;">'
        +'<div style="width:30px;height:30px;border-radius:7px;background:#FAEEDA;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;">'
          +'<i class="ti ti-alert-triangle" style="font-size:15px;color:#BA7517;" aria-hidden="true"></i>'
        +'</div>'
        +'<div style="flex:1;min-width:0;">'
          +'<div style="font-size:13px;font-weight:500;color:var(--t1);line-height:1.35;margin-bottom:6px;">Unanswered questions in this conversation</div>'
          +'<div style="font-size:11px;color:var(--t3);line-height:1.6;">You have '+n+' unanswered question(s) in this conversation. If you finalize now, Requirement Agent will make its own assumptions to fill the gaps, clearly marked in the brief.</div>'
        +'</div>'
      +'</div>'
      +'<div style="padding:10px 20px 16px;display:flex;justify-content:flex-end;gap:6px;">'
        +'<button style="background:none;color:var(--t2);border:1px solid var(--divider);border-radius:5px;padding:5px 14px;font-size:11px;font-weight:700;font-family:var(--font);cursor:pointer;" onclick="raReviewQuestions(\''+conv.id+'\',\''+overlayId+'\')">Review Questions</button>'
        +'<button style="background:#BA7517;color:#fff;border:none;border-radius:5px;padding:5px 14px;font-size:11px;font-weight:700;font-family:var(--font);cursor:pointer;" onclick="raFinalizeWithAssumptions(\''+conv.id+'\',\''+overlayId+'\')">Finalize with Assumptions</button>'
      +'</div>'
    +'</div>';
  document.body.appendChild(overlay);
  trapFocus(overlay);
  var _esc=function(ev){
    if(ev.key==='Escape'){overlay.remove();document.removeEventListener('keydown',_esc,true);}
  };
  document.addEventListener('keydown',_esc,true);
}

// §9 — zero-new-capabilities Finalize warning. Same Type-1 Warn shape as
// raShowAssumptionModal() (DESIGN_SYSTEM.md §8), distinct copy: warns that
// Finalizing now creates nothing. If unresolved open questions ALSO exist,
// "Finalize Anyway" runs with assumptions so the PM never has to click
// through two separate warnings in a row.
function raShowZeroCapabilityModal(conv,unresolvedCount){
  var overlayId='ra-zerocap-overlay';
  var existing=document.getElementById(overlayId);
  if(existing)existing.remove();
  var overlay=document.createElement('div');
  overlay.className='modal-overlay';
  overlay.id=overlayId;
  overlay.innerHTML=
    '<div class="modal" style="max-width:400px;position:relative;">'
      +'<button onclick="document.getElementById(\''+overlayId+'\').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:3px;color:var(--t3);display:flex;align-items:center;border-radius:4px;z-index:1;" title="Close">'
        +'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
      +'</button>'
      +'<div style="padding:20px 52px 20px 20px;display:flex;align-items:flex-start;gap:12px;">'
        +'<div style="width:30px;height:30px;border-radius:7px;background:#FAEEDA;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;">'
          +'<i class="ti ti-alert-triangle" style="font-size:15px;color:#BA7517;" aria-hidden="true"></i>'
        +'</div>'
        +'<div style="flex:1;min-width:0;">'
          +'<div style="font-size:13px;font-weight:500;color:var(--t1);line-height:1.35;margin-bottom:6px;">No capabilities will be created</div>'
          +'<div style="font-size:11px;color:var(--t3);line-height:1.6;">This conversation hasn\'t identified any new capabilities yet. Finalizing now will lock the brief but won\'t create anything in Capability Canvas.</div>'
        +'</div>'
      +'</div>'
      +'<div style="padding:10px 20px 16px;display:flex;justify-content:flex-end;gap:6px;">'
        +'<button style="background:none;color:var(--t2);border:1px solid var(--divider);border-radius:5px;padding:5px 14px;font-size:11px;font-weight:700;font-family:var(--font);cursor:pointer;" onclick="document.getElementById(\''+overlayId+'\').remove()">Keep Drafting</button>'
        +'<button style="background:#BA7517;color:#fff;border:none;border-radius:5px;padding:5px 14px;font-size:11px;font-weight:700;font-family:var(--font);cursor:pointer;" onclick="raFinalizeWithAssumptions(\''+conv.id+'\',\''+overlayId+'\')">Finalize Anyway</button>'
      +'</div>'
    +'</div>';
  document.body.appendChild(overlay);
  trapFocus(overlay);
  var _esc=function(ev){
    if(ev.key==='Escape'){overlay.remove();document.removeEventListener('keydown',_esc,true);}
  };
  document.addEventListener('keydown',_esc,true);
}

// "Review Questions" — closes modal, jumps to/highlights the first
// unresolved question's message in chat. Reuses guided-launch.js's own
// flash/scroll-into-view convention (glRenderMdBody()'s .gl-flash pattern)
// applied here to a chat bubble instead of a markdown section — the closest
// existing "jump to and highlight a specific message" precedent in this
// codebase (confirmed via grep of guided-launch.js/feature-canvas.js/
// story-canvas-new.js; no other file implements a message-level highlight).
function raReviewQuestions(convId,overlayId){
  var overlay=document.getElementById(overlayId);
  if(overlay)overlay.remove();
  var conv=_raFindConv(convId);
  if(!conv)return;
  var unresolved=(conv.openQuestions||[]).filter(function(q){return!q.resolved;});
  if(!unresolved.length)return;
  var target=unresolved[0];
  var row=document.getElementById('ra-msg-'+target.messageIndex);
  if(row&&typeof row.scrollIntoView==='function'){
    row.scrollIntoView({behavior:'smooth',block:'center'});
    row.classList.add('gl-flash');
    setTimeout(function(){row.classList.remove('gl-flash');},2600);
  }
  // Item 2 fix — also navigate the Live Draft (brief) panel to its own
  // Open Questions section, expanding it first if collapsed (scrollIntoView
  // on a display:none panel is a silent no-op).
  if(!raRightPanelOpen&&typeof raOpenRightPanel==='function')raOpenRightPanel();
  var oqHeading=document.getElementById('ra-md-open-questions');
  if(oqHeading&&typeof oqHeading.scrollIntoView==='function'){
    oqHeading.scrollIntoView({behavior:'smooth',block:'start'});
    oqHeading.classList.add('gl-flash');
    setTimeout(function(){oqHeading.classList.remove('gl-flash');},2600);
  }
  var input=document.getElementById('ra-chat-input');
  if(input)input.focus();
}

// "Finalize with Assumptions" — resolves every unanswered open question
// with the agent's own best assumption, logs each as a distinct persisted
// "**Assumed:**" line in liveDraftMd (not just shown transiently in chat),
// then runs the same finalize sequence.
async function raFinalizeWithAssumptions(convId,overlayId){
  var overlay=document.getElementById(overlayId);
  if(overlay)overlay.remove();
  var conv=_raFindConv(convId);
  if(!conv||raBusy)return;
  await raRunFinalizeSequence(conv,true);
}

// ══════════════════════════════════════════════════════════════════════════
// Capability bucketing (QA issue #10) — resolve a new capability's target
// metric/process area against the REAL Discovery Map tree first, only
// falling back to a Custom Value Stage bucket when no existing metric
// genuinely fits. Confirmed root cause of the pre-fix behavior: every RA-
// created capability landed in the generic Custom Value Stage bucket
// unconditionally, with no attempt at matching — contradicting this
// redesign's own §1 value-chain diagram ("correctly bucketed under their
// metric/process area").
// ══════════════════════════════════════════════════════════════════════════

// Exact (case-insensitive, trimmed) name match against every metric/
// process area already in gData.stages[].l1_metrics[] — the same tree
// Discovery Map itself renders from, so a match here is guaranteed to be
// a REAL existing metric, not a guess. Creates the capStore entry for that
// metric on first use if it doesn't exist yet (a metric can exist in
// gData without ever having a capStore entry, e.g. no capabilities
// generated for it yet).
function _raResolveExistingMetricBucket(bucketMetricName){
  if(!bucketMetricName||typeof gData==='undefined'||!gData||!Array.isArray(gData.stages))return null;
  var needle=bucketMetricName.trim().toLowerCase();
  var found=null;
  gData.stages.forEach(function(st){
    if(found)return;
    (st.l1_metrics||[]).forEach(function(m){
      if(found)return;
      if(m&&m.name&&m.name.trim().toLowerCase()===needle){
        var mk=(typeof ccMetricKey==='function')?ccMetricKey(st.id,m.name):(st.id+'||'+m.name);
        found={metricKey:mk,stageId:st.id,stageLabel:st.label,metricName:m.name};
      }
    });
  });
  // Fallback within this same "existing" match: the AI can reasonably name
  // a whole value chain STAGE rather than one specific metric/process area
  // under it, when a capability is genuinely cross-cutting (spans several
  // process areas within that stage). Confirmed live: without this, such a
  // capability fell through to the custom-bucket path and got a NEW bucket
  // that happened to share the stage's exact name — confusing, and not the
  // "correctly bucketed under an existing value chain stage" outcome this
  // fix is for. Resolve a stage-label match to that stage's FIRST listed
  // metric/process area, deterministically.
  if(!found){
    gData.stages.forEach(function(st){
      if(found)return;
      if(st&&st.label&&st.label.trim().toLowerCase()===needle&&(st.l1_metrics||[]).length){
        var m0=st.l1_metrics[0];
        var mk0=(typeof ccMetricKey==='function')?ccMetricKey(st.id,m0.name):(st.id+'||'+m0.name);
        found={metricKey:mk0,stageId:st.id,stageLabel:st.label,metricName:m0.name};
      }
    });
  }
  if(found&&typeof capStore!=='undefined'&&!capStore[found.metricKey]){
    capStore[found.metricKey]={metricName:found.metricName,stageLabel:found.stageLabel,stageId:found.stageId,capabilities:[]};
  }
  return found;
}
// Fallback — no existing Discovery Map metric fits. Mints a NEW, distinctly-
// named Custom Value Stage bucket for this specific proposed name (its own
// bucketId, its own l1_metrics entry) — deliberately NOT the shared
// "_isDefaultCustomMetric" catch-all bucket (getOrCreateCurrentDefaultPiBucket()),
// since that bucket exists for genuinely anonymous manual adds with no name
// proposal, and reusing it here would reproduce QA issue #11 (every
// RA-created custom-area capability showing the same generic label). Also
// writes the new l1_metrics entry into gData directly (not just capStore),
// so Discovery Map and the left nav reflect the real name immediately
// rather than waiting on the next syncPiStageFromCapStore() pass (QA
// issues #12/#13).
function _raResolveOrCreateCapabilityBucket(bucketMetricName){
  var piKey=(typeof ccPIKey==='function')?ccPIKey(bucketMetricName):('pi||'+bucketMetricName.toLowerCase().replace(/[^a-z0-9]+/g,'_'));
  if(typeof capStore!=='undefined'&&capStore[piKey]){
    return {metricKey:piKey,stageLabel:capStore[piKey].stageLabel,metricName:capStore[piKey].metricName};
  }
  var piStageLabel=(typeof getPiStageLabel==='function')?getPiStageLabel(gData):'Custom Value Stage';
  var newBucketId=(typeof makeBucketId==='function')?makeBucketId():('bkt_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8));
  if(typeof gData!=='undefined'&&gData){
    if(!Array.isArray(gData.stages))gData.stages=[];
    var piStage=gData.stages.filter(function(s){return s&&s.id==='pi';})[0];
    if(!piStage){
      piStage={id:'pi',label:piStageLabel,description:'Capabilities that don\'t map to an existing Discovery Map metric or process area.',l1_metrics:[]};
      gData.stages.push(piStage);
    }
    if(!Array.isArray(piStage.l1_metrics))piStage.l1_metrics=[];
    piStage.l1_metrics.push({name:bucketMetricName,why:'Proposed by Requirement Agent — no existing Discovery Map metric or process area fit this capability.',bucketId:newBucketId});
  }
  if(typeof capStore!=='undefined'){
    capStore[piKey]={metricName:bucketMetricName,stageLabel:piStageLabel,stageId:'pi',bucketId:newBucketId,_piFirst:true,capabilities:[]};
  }
  return {metricKey:piKey,stageLabel:piStageLabel,metricName:bucketMetricName};
}

// ══════════════════════════════════════════════════════════════════════════
// Finalize sequence (atomic) — Discovery-First Entry Point redesign.
// Finalize now CREATES CAPABILITIES ONLY — it never generates features (that
// remains a manual, per-capability action on Capability Canvas, unchanged
// trigger/button, see ccGenerateFeaturesForCapClick()).
//   1. Resolve open questions with assumptions if needed (logged in
//      liveDraftMd, persisted — not transient chat-only). UNCHANGED.
//   2. For every isNew:true touched capability, resolve its target metric/
//      process area against the REAL Discovery Map tree first (§10 —
//      _raResolveExistingMetricBucket()), only falling back to a
//      distinctly-named Custom Value Stage bucket when no existing metric
//      fits (_raResolveOrCreateCapabilityBucket()) — never the generic
//      shared default bucket. A name match against a capability already
//      owned by a DIFFERENT conversation is treated as a distinct entity,
//      never silently reused (§14/§15/§16 provenance fix). Existing
//      (non-new) touched capabilities are left alone — nothing to create,
//      no generation to source them for anymore. Reconciles capStore into
//      gData via syncPiStageFromCapStore() synchronously right after, so
//      Capability Canvas/Discovery Map/left-nav can't drift (§12/§13).
//   3. Call ra_next_seq — this already fires at the correct point in the
//      sequence (after capability creation, confirmed via code research),
//      so no reordering was needed. NEW: immediately stamp intakeBriefId +
//      rqNumber onto every capability object created in step 2 — a
//      straightforward additive loop, not a resequencing.
//   4. Populate conv.createdCapabilityKeys with every created capability's
//      capStore key — this is what Capability Canvas's Origin-filter
//      "Requirement Agent" nested RQ sub-list reads from (§8.2).
//   5. Save per AI_EDITING_RULES.md's live-sync contract: capture
//      _activeSessionId into a local var BEFORE any async work -> mutate ->
//      sessionStoreSave() -> emit live-sync event ONLY on success.
//   6. Navigate to Capability Canvas automatically (CHANGED from Feature
//      Canvas) — CC auto-selects the first populated metric on arrival, see
//      capability-canvas.js's ccSelectFirstPopulatedMetric() (§8.1).
// ══════════════════════════════════════════════════════════════════════════
async function raRunFinalizeSequence(conv,withAssumptions){
  if(!conv||raBusy)return;
  raBusy=true;
  var btn=document.getElementById('ra-finalize-btn');
  if(btn){btn.disabled=true;btn.textContent='Finalizing...';}
  // Single guard for the whole atomic sequence — capability creation is a
  // synchronous data write (no network call except ra_next_seq), but the
  // save/emit tail still needs the same interruption guard every other
  // long-running operation in this codebase uses.
  var _finalizeSignal=(typeof startAiGen==='function')?startAiGen('Requirement Agent is finalizing this brief. Leaving now will leave the brief partially finalized.'):null;

  // Capture session identity BEFORE any async work — never re-read
  // _activeSessionId inside a later callback, per AI_EDITING_RULES.md.
  var saveSessionId=(typeof _activeSessionId!=='undefined')?_activeSessionId:null;
  var wasSharedSession=(typeof _activeSessionIsShared!=='undefined'&&_activeSessionIsShared);

  try{
    // Step 1 — resolve open questions with assumptions, logged persistently.
    if(withAssumptions){
      var unresolved=(conv.openQuestions||[]).filter(function(q){return!q.resolved;});
      if(unresolved.length){
        var assumedLines=unresolved.map(function(q,i){
          return '**Assumed:** Requirement Agent could not get a direct answer to open question #'+(i+1)+' before finalizing and proceeded with its own best judgment based on the brief above.';
        });
        conv.liveDraftMd=(conv.liveDraftMd||'')+'\n\n## Assumptions Made at Finalize\n'+assumedLines.join('\n')+'\n';
        conv.openQuestions.forEach(function(q){q.resolved=true;});
      }
    }

    // Step 2 — create capStore entries for isNew:true touched capabilities
    // only. Existing (non-new) touched capabilities need no action here —
    // there is no feature generation left to source them for.
    var touched=conv.touchedCapabilityKeys||[];
    var newCapRefs=[]; // [{metricKey, capIdx, cap}] — capabilities THIS conversation's Finalize actually created

    touched.forEach(function(t){
      if(!t.isNew)return;
      var capNameGuess=t.name||t.key;
      var bucketMetricName=(t.bucketMetricName||'').trim();

      // §10 — resolve against a REAL existing Discovery Map metric/process
      // area first; only fall back to a (distinctly-named) Custom Value
      // Stage bucket when no existing metric fits. If the model somehow
      // returned no bucket annotation at all (malformed response), fall
      // back to proposing the capability's own name as the bucket name —
      // still better than the old silent generic-label behavior.
      var target=_raResolveExistingMetricBucket(bucketMetricName)
        ||_raResolveOrCreateCapabilityBucket(bucketMetricName||capNameGuess);
      if(!target||typeof capStore==='undefined')return;
      var entry=capStore[target.metricKey];
      if(!entry)return;

      // §14/§15/§16 — RQ provenance fix: a name match against a capability
      // already OWNED by a DIFFERENT conversation is a different entity,
      // not a reuse — the pre-fix code matched by name alone and silently
      // overwrote that other conversation's intakeBriefId/rqNumber.
      var existingIdx=entry.capabilities.findIndex(function(c){return c.name===capNameGuess;});
      var existingCap=existingIdx>=0?entry.capabilities[existingIdx]:null;
      var ownedByOther=!!(existingCap&&existingCap.intakeBriefId&&existingCap.intakeBriefId!==conv.id);
      var capObj;
      if(existingCap&&!ownedByOther){
        capObj=existingCap; // same conversation touching it again, or not yet owned by anyone — safe to reuse
      } else {
        // QA issue #1 — use the actual descriptive bullet(s) the model wrote
        // under this capability's own sub-heading (t.description, parsed by
        // _raParseTouchedCapabilities()) as .why, falling back to a generic
        // placeholder only if the model genuinely wrote nothing (shouldn't
        // happen per the section-content rules, but never leave .why empty).
        capObj={name:capNameGuess,why:t.description||'Created by Requirement Agent for this release.',subCaps:null,features:[],_manual:true};
        entry.capabilities.push(capObj);
      }
      newCapRefs.push({metricKey:target.metricKey,capIdx:entry.capabilities.indexOf(capObj),cap:capObj});
    });

    // §12/§13 — reconcile capStore's bucket metric names into Discovery
    // Map's own tree immediately, synchronously, regardless of whether a
    // session save happens below. Confirmed root cause of the pre-fix
    // "CC shows one name, DM/left-nav show another until refresh" bug:
    // this sync previously only ran as an indirect side effect of
    // sessionStoreSave(), which never fires at all for sessions with no
    // active saveSessionId (demo/local).
    if(typeof syncPiStageFromCapStore==='function'&&typeof gData!=='undefined'&&typeof capStore!=='undefined'){
      syncPiStageFromCapStore(gData,capStore);
    }

    // Step 3 — assign the RQ number. Confirmed via code research: this
    // already fires after capability creation (step 2), which is exactly
    // the ordering needed to stamp intakeBriefId/rqNumber onto the newly
    // created capabilities below — no reorder required.
    var rqLabel=null;
    if(saveSessionId){
      try{
        var _rpcRes=await _pgtRpc('ra_next_seq',{p_session_id:saveSessionId});
        if(_rpcRes&&!_rpcRes.error&&typeof _rpcRes.data==='number'){
          rqLabel=_raRqLabel(_rpcRes.data);
        }
      }catch(rpcErr){
        console.warn('[requirement-agent] ra_next_seq RPC failed',rpcErr);
      }
    }
    // Fallback numbering (RPC unreachable, e.g. local/offline dev) — still
    // deterministic and never reused, just not sequence-safe across
    // concurrent sessions. Flagged via console.warn above; not silent.
    if(!rqLabel){
      var _maxExisting=raConversations.reduce(function(mx,c){
        if(c.rqNumber){var n=parseInt(String(c.rqNumber).replace(/\D/g,''),10);if(!isNaN(n)&&n>mx)mx=n;}
        return mx;
      },0);
      rqLabel=_raRqLabel(_maxExisting+1);
    }

    // Stamp intakeBriefId + rqNumber onto every capability created in step
    // 2 — additive only, no feature generation, no scCanvas push (§5.2,§7).
    newCapRefs.forEach(function(ref){
      ref.cap.intakeBriefId=conv.id;
      ref.cap.rqNumber=rqLabel;
    });
    conv.createdCapabilityKeys=newCapRefs.map(function(ref){return ref.metricKey+'|'+ref.capIdx;});

    // Signal Capability Canvas's tab badge/pending indicator — mirrors the
    // existing markTabPending() convention used elsewhere for "new content
    // arrived on a tab you're not currently viewing."
    if(typeof markTabPending==='function')markTabPending('cc');

    // Mark conversation finalized as part of the SAME save.
    conv.status='finalized';
    conv.rqNumber=rqLabel;
    conv.updatedAt=new Date().toISOString();

    // Step 5 — persist per the live-sync save/emit contract.
    var saved=false;
    if(saveSessionId&&typeof sessionStoreSave==='function'){
      try{
        saved=await sessionStoreSave(saveSessionId);
      }catch(saveErr){
        console.warn('[requirement-agent] finalize save failed',saveErr);
        saved=false;
      }
    } else {
      saved=true; // no active session id (e.g. demo/local) — nothing to persist against
    }

    if(!saved){
      showToast('Could not save the finalized brief. Please try again.','warn');
      conv.status='draft'; // revert — do not leave a mismatched finalized-but-unsaved state
      conv.rqNumber=null;
      conv.createdCapabilityKeys=[];
      raBusy=false;
      if(btn){btn.disabled=false;btn.textContent='Finalize';}
      raRenderLiveDraft();
      return;
    }

    if(wasSharedSession&&typeof _lsEmitContentEvent==='function'){
      try{
        _lsEmitContentEvent(saveSessionId,'cc','capabilities_generated',null,null);
      }catch(emitErr){
        console.warn('Event emission failed (save already succeeded):',emitErr);
      }
    }

    raRenderConvList();
    raRenderLiveDraft();

    // End the nav-in-flight guard BEFORE this function's own automatic
    // navigation below — switchTab() itself checks aiGenInFlight.active via
    // blockIfGenerating(), so leaving the guard up here would make Finalize's
    // own auto-navigate step trip its own "Hold on, don't lose this"
    // confirmation on itself. Same ordering requirement as the pre-redesign
    // switchTab('fc') call site — re-verified to still hold for 'cc'.
    raBusy=false;
    if(typeof endAiGen==='function')endAiGen();
    if(btn){btn.disabled=false;btn.textContent='Finalize';}

    // Step 6 — navigate to Capability Canvas automatically, no intermediate
    // "continue" link. Capability creation (step 2) is already complete and
    // saved by this point, so CC's arrival auto-select-first-metric helper
    // finds real data the instant it runs.
    var tabCc=document.getElementById('tab-cc');
    if(tabCc)tabCc.classList.remove('data-home-hidden');
    if(tabCc)tabCc.style.display='';
    switchTab('cc');
    if(typeof ccSelectFirstPopulatedMetric==='function')ccSelectFirstPopulatedMetric();
  } finally {
    raBusy=false;
    if(typeof endAiGen==='function')endAiGen();
    if(btn){btn.disabled=false;btn.textContent='Finalize';}
  }
}

// Persistence — same optimistic pattern glMessages/glDraftMd use via
// _glPersistMessage()/_glPersistDraft(): mutate the live global first (every
// function above already did that before calling this), then save.
// v14 code-review fix — returns a real boolean instead of resolving to
// undefined regardless of outcome (which every caller that awaits this and
// then proceeds was silently treating as "it worked"). No active session to
// persist against (e.g. demo/local mode) is NOT a failure — there's
// genuinely nothing to save, so that resolves true. A real save attempt
// that returns false or throws resolves false — callers that await this
// must check the result and not proceed as if nothing went wrong.
async function _raPersist(){
  if(typeof sessionStoreSave!=='function'||typeof _activeSessionId==='undefined'||!_activeSessionId)return true;
  try{
    var ok=await sessionStoreSave(_activeSessionId);
    if(!ok)console.warn('[requirement-agent] persist failed — sessionStoreSave returned false');
    return !!ok;
  }catch(err){
    console.warn('[requirement-agent] persist failed',err);
    return false;
  }
}
