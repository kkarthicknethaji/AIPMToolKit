// ══════════════════════════════════════════════════════════════════════════
// VOICE INPUT (shared module, v9.24.02) — browser-native SpeechRecognition,
// extracted from Requirement Agent's original single-surface implementation
// (v9.24/v9.24.01) so every AI-refine textarea in the app can attach to it
// without re-discovering the defect classes RA's build already found: the
// connecting/listening state machine driven by a real onstart event (not
// just .start() being called, which is async and can sit behind a first-use
// mic-permission prompt), five involuntary teardown paths, abort-vs-stop
// semantics, and a manual-edit-vs-interim-transcript merge algorithm.
//
// Always on (v9.25.03 — legal sign-off received, Settings toggle removed),
// gated only by feature detection — see _viShouldRender().
//
// MANDATORY CONTRACT for every surface that attaches: any function that
// destroys or replaces a textarea's DOM node (innerHTML reassignment, node
// removal/recreation) MUST call voiceStopActive('abort') BEFORE doing so,
// even if that function has nothing to do with voice input itself. Not
// optional hardening — confirmed via live tracing on multiple surfaces
// (Capability Canvas's feature panel; Discovery Map's action bar, which
// rebuilds on completely unrelated stage/capability edits) that a re-render
// triggered by an unrelated action silently destroys an active dictation
// session's textarea if this isn't done, with no error and no visible
// symptom until someone notices content vanished.
//
// Only ONE instance can ever be actively listening at a time (only one
// tab/panel is interactive at once). voiceToggle()'s start path always
// calls voiceStopActive('abort') FIRST — synchronously nulling any prior
// recognizer reference before writing the new instance's ids into shared
// state — so a stale event from a just-superseded recognizer can never be
// checked against a newer instance's state. Every recognizer is also
// stamped with a newGenAttempt() id (utils.js — the same stale-async-result
// guard already used elsewhere in this codebase, e.g. capability-canvas.js's
// markGenAttempt()/outcome-pulse.js's _opSuggestAttemptId); every handler
// checks its own attempt id is still current before touching shared state,
// so even a genuinely late event from an old instance is a safe no-op
// instead of cross-writing into the wrong surface's textarea.
//
// Per-surface integration note: voiceButtonHtml() renders the mic button
// and status label as siblings. The status label is position:absolute — the
// CALLER'S own wrapping element (whatever groups the mic button with the
// surface's send/regenerate button) must be position:relative, same as
// Requirement Agent's own .ra-chat-btn-group.
// ══════════════════════════════════════════════════════════════════════════

var _viListening=false;        // is ANY instance currently toggled on
var _viUiState=null;           // null | 'connecting' | 'listening'
var _viRecognition=null;       // live SpeechRecognition instance, or null
var _viCommittedBase='';       // active textarea's value as of the last finalized speech segment
var _viLastWrittenValue=null;  // last value THIS module wrote into the active textarea — used to detect a manual edit between ticks
var _viRestartGuard=false;     // true once a permanent error fires — blocks onend's auto-restart
var _viActive=null;            // {textareaId,buttonId,statusId,attemptId} for whichever instance is current, or null

function _viSupported(){
  return typeof window!=='undefined'&&!!(window.SpeechRecognition||window.webkitSpeechRecognition);
}

// Centralizes the support gate every surface's render function needs — one
// place, not reimplemented per surface.
function _viShouldRender(){
  return _viSupported();
}

// Pure HTML-string builder — the caller's OWN render function embeds this
// into its own template, exactly like settings-page.js's _spTog() pattern.
// This module never reaches into another file's DOM to inject itself.
function voiceButtonHtml(config){
  if(!_viShouldRender())return '';
  var isThisActive=!!(_viActive&&_viActive.textareaId===config.textareaId);
  var listening=isThisActive&&_viListening&&_viUiState==='listening';
  var connecting=isThisActive&&_viListening&&_viUiState==='connecting';
  var cls='vi-btn'+(listening?' vi-btn-listening':'')+(connecting?' vi-btn-connecting':'');
  var title=(isThisActive&&_viListening)?'Stop dictation':'Start dictation';
  var statusText=(isThisActive&&_viListening)?(_viUiState==='listening'?'Listening…':'Connecting…'):'';
  return '<button class="'+cls+'" id="'+e(config.buttonId)+'" onclick="voiceToggle(\''+config.textareaId+'\',\''+config.buttonId+'\',\''+config.statusId+'\')" title="'+title+'"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg></button>'
    +'<span class="vi-status" id="'+e(config.statusId)+'">'+e(statusText)+'</span>';
}

// Constructs a fresh recognizer per toggle-on. Handlers close over attemptId
// (not a mutable global) so a stale event from THIS instance can always be
// told apart from whatever's current by the time it fires.
function _viInit(attemptId){
  var Ctor=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!Ctor)return null;
  var rec=new Ctor();
  rec.continuous=true;
  rec.interimResults=true;
  rec.lang='en-US';
  rec.onstart=function(){_viOnStart(attemptId);};
  rec.onresult=function(event){_viOnResult(event,attemptId);};
  rec.onerror=function(event){_viOnError(event,attemptId);};
  rec.onend=function(){_viOnEnd(attemptId);};
  return rec;
}

// Click handler for every surface's mic button.
function voiceToggle(textareaId,buttonId,statusId){
  if(_viListening&&_viActive&&_viActive.textareaId===textareaId){
    // Same instance the PM already has on — user-initiated stop. stop(),
    // not abort(): no reason to discard audio they just finished speaking
    // on purpose, unlike every involuntary path below.
    voiceStopActive('stop');
    return;
  }
  // Stop whatever else might be active FIRST — synchronously, before this
  // new instance's ids are written into shared state. Unconditional and
  // idempotent (safe no-op if nothing was running) — this ordering is what
  // prevents a stale event from an old recognizer from ever being checked
  // against a newer instance's state.
  voiceStopActive('abort');
  if(!_viSupported())return;
  var input=document.getElementById(textareaId);
  if(!input)return;
  var attempt=newGenAttempt();
  _viActive={textareaId:textareaId,buttonId:buttonId,statusId:statusId,attemptId:attempt.id};
  // Resync from the textarea's LIVE value, not a stale snapshot — covers
  // resuming dictation after a manual edit made while the mic was off.
  _viCommittedBase=input.value||'';
  _viLastWrittenValue=_viCommittedBase;
  _viRestartGuard=false;
  _viRecognition=_viInit(attempt.id);
  if(!_viRecognition){_viActive=null;return;}
  try{
    _viRecognition.start();
    _viListening=true;
    _viUiState='connecting'; // flips to 'listening' on the recognizer's own onstart event — start() is async
    _viRenderButtonState();
  }catch(err){
    console.warn('[voice-input] start failed',err);
    _viRecognition=null;
    _viActive=null;
  }
}

// Shared stop path for every cleanup call site across every surface.
// method:'stop' lets any audio already being processed finish and fire a
// final onresult; method:'abort' discards anything in flight immediately.
// Every INVOLUNTARY path (tab-leave, session-clear, settings-flag-off,
// re-render/conversation-switch, tab/window backgrounding, stop-on-send,
// handing the active slot to a different surface) uses 'abort' — none of
// them should let a trailing result land in a context the PM has already
// left, that no longer has the feature enabled, or that belongs to a
// different surface. Idempotent: safe to call with nothing active.
function voiceStopActive(method){
  _viListening=false;
  _viUiState=null;
  var rec=_viRecognition;
  _viRecognition=null;
  // v9.25 code-review fix — _viActive is deliberately NOT cleared here.
  // Previously it was nulled synchronously above, which meant a graceful
  // ('stop') call could never actually receive its own trailing onresult:
  // the native .stop() call is async and typically fires one more result
  // event with whatever was already captured, but _viOnResult()'s staleness
  // guard (checking _viActive.attemptId) would already see _viActive===null
  // and reject it — so 'stop' and 'abort' behaved identically in practice,
  // silently dropping the last few words spoken right at the moment of a
  // user-initiated stop. _viActive now stays set until _viOnEnd() confirms
  // the recognizer has truly finished (and won't restart), so a legitimate
  // trailing result from THIS instance still passes the attempt-id check.
  // This does not reopen the cross-instance race the attempt-id guard
  // exists for: voiceToggle()'s start path overwrites _viActive with the
  // new instance's data synchronously, before any async event from the old
  // instance can possibly fire, so a stale event is still correctly
  // rejected once a different surface takes over.
  if(rec){
    try{
      if(method==='abort'&&typeof rec.abort==='function')rec.abort();
      else rec.stop();
    }catch(err){/* already stopped/errored — safe no-op */}
  }
  _viRenderButtonState();
}

// Light-touch visual update — deliberately does NOT trigger any surface's
// own re-render (that would rebuild the textarea from scratch and, per the
// mandatory contract above, immediately trip that surface's own pre-destroy
// guard, killing the very session this function is trying to reflect).
// Defaults to _viActive; voiceStopActive() passes the just-cleared prior
// instance explicitly so its button/status still get reset to idle.
function _viRenderButtonState(ids){
  var i=ids||_viActive;
  if(!i)return;
  var btn=document.getElementById(i.buttonId);
  if(btn){
    btn.classList.toggle('vi-btn-listening',_viListening&&_viUiState==='listening');
    btn.classList.toggle('vi-btn-connecting',_viListening&&_viUiState==='connecting');
    btn.title=_viListening?'Stop dictation':'Start dictation';
  }
  var statusEl=document.getElementById(i.statusId);
  if(statusEl){
    statusEl.textContent=!_viListening?'':(_viUiState==='listening'?'Listening…':'Connecting…');
  }
}

// Fires once the browser has ACTUALLY started capturing audio — the real
// signal voiceToggle()'s call to .start() can't give on its own, since
// .start() is async and can sit behind the browser's own mic-permission
// prompt on first use.
function _viOnStart(attemptId){
  if(!_viActive||_viActive.attemptId!==attemptId)return; // stale — a newer/no instance has since taken over
  _viUiState='listening';
  _viRenderButtonState();
}

function _viOnResult(event,attemptId){
  if(!_viActive||_viActive.attemptId!==attemptId)return;
  var input=document.getElementById(_viActive.textareaId);
  if(!input)return; // torn down mid-flight — safe no-op
  // Manual-edit detection: if the textarea's current value doesn't match
  // the last value THIS module wrote, the PM typed/edited manually since
  // the last tick — resync the base to their edit instead of clobbering it.
  if(_viLastWrittenValue!==null&&input.value!==_viLastWrittenValue){
    _viCommittedBase=input.value;
  }
  var interim='',finalChunk='';
  for(var i=event.resultIndex;i<event.results.length;i++){
    var res=event.results[i];
    if(res.isFinal)finalChunk+=res[0].transcript;
    else interim+=res[0].transcript;
  }
  if(finalChunk){
    var sep=(_viCommittedBase&&!/\s$/.test(_viCommittedBase))?' ':'';
    _viCommittedBase=_viCommittedBase+sep+finalChunk.trim();
  }
  var display=interim?(_viCommittedBase+((_viCommittedBase&&!/\s$/.test(_viCommittedBase))?' ':'')+interim):_viCommittedBase;
  input.value=display;
  _viLastWrittenValue=display;
}

// Distinct, honest toast per error type. not-allowed/service-not-allowed
// are PERMANENT (permission denied outright) — onend's auto-restart below
// must never retry these, or a revoked mic produces a tight error/restart
// loop.
function _viOnError(event,attemptId){
  if(!_viActive||_viActive.attemptId!==attemptId)return;
  var err=event&&event.error;
  // v9.25.06 — 'aborted' fires whenever OUR OWN code calls rec.abort() (per
  // spec, immediately before 'end'), which is every deliberate stop-on-send/
  // tab-leave/session-clear/etc. across every surface in the app — never a
  // genuine failure. Falling through to the generic toast below showed
  // "Dictation error — stopped listening." on every intentional stop, which
  // is exactly backwards: the PM asked for this, it isn't an error.
  if(err==='aborted')return;
  var permanent=(err==='not-allowed'||err==='service-not-allowed');
  var messages={
    'no-speech':'No speech detected — dictation is still listening.',
    'audio-capture':'No microphone found.',
    'not-allowed':'Microphone access denied. Enable it in your browser settings to use dictation.',
    'service-not-allowed':'Microphone access denied. Enable it in your browser settings to use dictation.',
    'network':'Dictation lost its network connection.'
  };
  if(typeof showToast==='function')showToast(messages[err]||'Dictation error — stopped listening.','warn');
  if(permanent){
    _viRestartGuard=true;
    voiceStopActive('abort'); // permission genuinely gone — nothing in flight is worth waiting on
  }
}

// Chrome silently ends the recognition session after a few seconds of
// silence even with continuous:true — auto-restart unless the PM explicitly
// toggled off or a permanent error already fired above. Deliberately does
// NOT reset _viUiState back to 'connecting' — this restart is an internal
// implementation detail invisible to the PM, who never stopped dictating;
// flashing "Connecting…" on every silence-timeout cycle would be worse than
// not showing the label at all.
function _viOnEnd(attemptId){
  if(!_viActive||_viActive.attemptId!==attemptId)return;
  if(_viListening&&!_viRestartGuard&&_viRecognition){
    try{_viRecognition.start();}
    catch(err){voiceStopActive('abort');}
  } else {
    // Recognizer has fully ended and won't restart — safe to release the
    // instance now. This is the actual end of this attempt's lifecycle;
    // voiceStopActive() deliberately left this set so a trailing onresult
    // (fired between the stop()/abort() call and this onend) could still
    // land correctly.
    _viActive=null;
  }
}

// 5th involuntary teardown path (carried over from RA's original build,
// now app-wide via one shared listener instead of one per surface): the
// BROWSER tab/window itself losing visibility while the page keeps running
// in the background (switching to a different browser tab/app, or
// minimizing) — confirmed via live testing that this silently leaves
// dictation capturing and transcribing indefinitely into the still-live
// (just visually hidden) textarea, since nothing else reacts to tab/window
// visibility. No auto-resume when the tab becomes visible again, by design.
document.addEventListener('visibilitychange',function(){
  if(document.hidden&&_viListening)voiceStopActive('abort');
});
