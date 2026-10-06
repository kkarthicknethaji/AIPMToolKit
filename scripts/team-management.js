// TEAM MANAGEMENT — Settings Section 6 (Phase 4, v8.109)
// Admin-only. Replaces spTeamManagementPlaceholder() with a real table,
// invite modal, and row actions, calling the new /api/team/* proxy routes.
// No direct Supabase table access from this file — every read and write to
// mt_users_companies/mt_sessions goes through the service-role proxy, since
// admin actions here routinely touch OTHER users' rows, which the client-side
// RLS policies deliberately don't allow.

var _tmMembers = [];
var _tmLoading = false;
var _tmLoadError = null;

// ── Proxy base URL — mirrors auth.js's authCheckCompanyName() pattern exactly,
// since PROXY_URL already includes the /api/anthropic path and needs stripping. ──
function _tmProxyBase() {
  const isLocal = (window.location.hostname === '' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
  if (isLocal) return 'http://localhost:3001';
  return (typeof PROXY_URL !== 'undefined' && PROXY_URL)
    ? PROXY_URL.replace(/\/api\/anthropic\/?$/, '')
    : 'https://product-diagnostics-proxy.onrender.com';
}

// ── Shared POST helper for every /api/team/* call ──
async function _tmCall(path, body) {
  let authToken = '';
  try {
    if (typeof authGetFreshToken === 'function') authToken = await authGetFreshToken();
  } catch (e) {
    console.warn('_tmCall: could not retrieve session token', e);
  }
  const activeCompanyId = (function(){
    try { return localStorage.getItem(_PGT_ACTIVE_COMPANY_KEY) || ''; } catch(e) { return ''; }
  })();
  const payload = Object.assign({ company_id: activeCompanyId }, body || {});
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['X-Auth-Token'] = authToken;

  try {
    const res = await fetch(_tmProxyBase() + path, {
      method: 'POST', headers, body: JSON.stringify(payload)
    });
    const data = await res.json().catch(function(){
      return { error: { type: 'proxy_error', message: 'Request failed or timed out. Please try again.' } };
    });
    return data;
  } catch (e) {
    console.warn('_tmCall: network error on', path, e);
    return { error: { type: 'proxy_error', message: 'Could not reach the server. Check your connection and try again.' } };
  }
}

// ── Load + render ──
async function tmLoad() {
  _tmLoading = true;
  _tmLoadError = null;
  tmRender();
  const result = await _tmCall('/api/team/list', {});
  _tmLoading = false;
  if (result.error) {
    _tmLoadError = result.error.message || 'Could not load team members.';
    _tmMembers = [];
  } else {
    _tmMembers = result.members || [];
  }
  tmRender();
}

function tmRender() {
  const mount = document.getElementById('sp-p6');
  if (!mount) return;
  if (typeof _uiRowMenuClose === 'function') _uiRowMenuClose();
  mount.innerHTML = _tmBuildHTML();
  _tmRenderRows(); // #tm-rows-wrap only exists once the toolbar above has rendered
}

function _tmBuildHTML() {
  if (_tmLoading) {
    return '<div style="padding:40px 20px;text-align:center;font-size:11px;color:#A5AFBE;font-family:\'DM Sans\',sans-serif;">Loading team...</div>';
  }
  if (_tmLoadError) {
    return '<div style="padding:40px 20px;text-align:center;font-size:11px;color:#A32D2D;font-family:\'DM Sans\',sans-serif;">' + e(_tmLoadError) + '</div>';
  }
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;gap:10px;">
      <span style="font-size:9px;font-weight:700;color:#A5AFBE;font-family:'DM Sans',sans-serif;">${_tmMembers.length} Member${_tmMembers.length===1?'':'s'}</span>
      <div style="display:flex;align-items:center;gap:8px;">
        <div style="width:170px;display:flex;align-items:center;gap:6px;border:1px solid var(--divider);border-radius:6px;padding:6px 10px;background:var(--card);flex-shrink:0;">
          <i class="ti ti-search" style="font-size:12px;color:var(--label);" aria-hidden="true"></i>
          <input id="tm-search-input" placeholder="Search name or email" value="${e(_tmSearchQuery)}" oninput="_tmOnSearchInput(this.value)" style="border:none;background:none;outline:none;font-size:10px;flex:1;color:var(--t2);width:100%;font-family:'DM Sans',sans-serif;"/>
        </div>
        <button id="tm-filter-btn" onclick="_tmToggleFilterPanel(this)" class="${_tmActiveFilterCount()>0?'pgt-btn-outline':''}" style="display:flex;align-items:center;gap:4px;border:1px solid ${_tmActiveFilterCount()>0?'var(--purple)':'var(--divider)'};border-radius:6px;padding:6px 10px;font-size:10px;color:${_tmActiveFilterCount()>0?'var(--purple)':'var(--t2)'};font-weight:${_tmActiveFilterCount()>0?'700':'600'};background:${_tmActiveFilterCount()>0?'var(--purple-pale)':'#fff'};cursor:pointer;flex-shrink:0;font-family:'DM Sans',sans-serif;">
          <i class="ti ti-filter" style="font-size:11px;" aria-hidden="true"></i> Filter${_tmActiveFilterCount()>0?(' <span style="background:var(--purple);color:#fff;border-radius:8px;padding:0 5px;font-size:8px;">'+_tmActiveFilterCount()+'</span>'):''} <i class="ti ti-chevron-down" style="font-size:10px;" aria-hidden="true"></i>
        </button>
        <button onclick="tmShowInviteModal()" class="pgt-btn-outline" style="flex-shrink:0;white-space:nowrap;">
          <i class="ti ti-user-plus" style="font-size:11px;" aria-hidden="true"></i> Invite Member
        </button>
      </div>
    </div>
    <div id="tm-rows-wrap"></div>`;
}

// Rows render into their own container, separate from the toolbar built by
// _tmBuildHTML() above — specifically so search/filter changes only ever
// touch this inner container, never rebuilding (and thereby destroying) the
// search input itself. Typing a keystroke re-renders this div only; the
// input element stays alive throughout, so its value/focus/cursor position
// are never at risk of being clobbered by a full-toolbar rebuild the way
// they would be if search re-ran _tmBuildHTML() on every keystroke.
function _tmRenderRows() {
  const wrap = document.getElementById('tm-rows-wrap');
  if (!wrap) return;
  const filtered = _tmFilteredMembers();
  const rows = filtered.map(_tmRowHTML).join('');
  const countLine = (_tmMembers.length > 0 && filtered.length !== _tmMembers.length)
    ? `<div style="padding:8px 16px;font-size:9px;color:#A5AFBE;text-align:center;border-top:1px solid #D0D5E8;font-family:'DM Sans',sans-serif;">${filtered.length} of ${_tmMembers.length} member${_tmMembers.length===1?'':'s'} shown</div>`
    : '';
  wrap.innerHTML = `
    <div style="background:#fff;border-radius:8px;border:1px solid #D0D5E8;overflow:visible;">
      <div class="tm-row tm-row-head">
        <div>Name</div><div>Email</div><div>Role</div><div>Access</div><div>Status</div><div>Actions</div>
      </div>
      ${rows || '<div style="padding:30px 14px;text-align:center;font-size:11px;color:#A5AFBE;font-family:\'DM Sans\',sans-serif;">' + (_tmMembers.length ? 'No members match your search or filters.' : 'No members yet.') + '</div>'}
      ${countLine}
    </div>`;
}

// ── Search + filter state (v8.114) — module-level, survives full toolbar
// rebuilds (e.g. after tmLoad() following an invite/disable/enable action),
// clearing only on an explicit "Clear all filters" click. ──
let _tmSearchQuery = '';
let _tmRoleFilter = { admin: false, member: false, readonly: false };
let _tmStatusFilter = { active: false, disabled: false, invite_pending: false };
let _tmSearchDebounceTimer = null;

function _tmActiveFilterCount() {
  return Object.values(_tmRoleFilter).filter(Boolean).length + Object.values(_tmStatusFilter).filter(Boolean).length;
}

function _tmFilteredMembers() {
  const q = _tmSearchQuery.trim().toLowerCase();
  const roleKeys = Object.keys(_tmRoleFilter).filter(function(k){ return _tmRoleFilter[k]; });
  const statusKeys = Object.keys(_tmStatusFilter).filter(function(k){ return _tmStatusFilter[k]; });
  return _tmMembers.filter(function(m) {
    if (q && !(m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q))) return false;
    if (roleKeys.length && !roleKeys.includes(m.role)) return false;
    if (statusKeys.length && !statusKeys.includes(m.status)) return false;
    return true;
  });
}

function _tmOnSearchInput(value) {
  clearTimeout(_tmSearchDebounceTimer);
  _tmSearchDebounceTimer = setTimeout(function() {
    _tmSearchQuery = value;
    _tmRenderRows();
    // Filter button badge doesn't change from search, only the shown/total
    // count inside the rows container does — no need to touch the toolbar.
  }, 150);
}

function _tmToggleFilterPanel(triggerEl) {
  const items = [];
  items.push({ heading: 'Role' });
  items.push({ checkbox: true, key: 'admin', group: '_tmRoleFilter', label: 'Admin' });
  items.push({ checkbox: true, key: 'member', group: '_tmRoleFilter', label: 'Power User' });
  items.push({ checkbox: true, key: 'readonly', group: '_tmRoleFilter', label: 'Read Only' });
  items.push({ divider: true });
  items.push({ heading: 'Status' });
  items.push({ checkbox: true, key: 'active', group: '_tmStatusFilter', label: 'Active' });
  items.push({ checkbox: true, key: 'disabled', group: '_tmStatusFilter', label: 'Disabled' });
  items.push({ checkbox: true, key: 'invite_pending', group: '_tmStatusFilter', label: 'Invite pending' });

  const html = items.map(function(it) {
    if (it.heading) return `<div style="padding:8px 12px 4px;font-size:9px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--label);">${it.heading}</div>`;
    if (it.divider) return '<div style="height:0.5px;background:var(--divider);margin:4px 0;"></div>';
    // Checkbox state recomputed from the live filter-state object every time
    // the panel opens — _uiRowMenuToggle rebuilds this HTML fresh on each
    // open, so a hardcoded checked/unchecked here would silently ignore
    // whatever the person had actually selected last time.
    const isChecked = (it.group === '_tmRoleFilter' ? _tmRoleFilter : _tmStatusFilter)[it.key];
    return `<label role="menuitem" tabindex="0" class="tm-filter-row"><input type="checkbox" ${isChecked?'checked':''} onchange="_tmToggleFilterValue('${it.group}','${it.key}')"/> ${it.label}</label>`;
  }).join('') + `<div style="border-top:1px solid var(--divider);margin:4px 0;"></div><div style="padding:4px 12px 8px;"><button onclick="_tmClearAllFilters()" style="font-size:10px;color:var(--purple);background:none;border:none;cursor:pointer;padding:0;font-family:'DM Sans',sans-serif;">Clear all filters</button></div>`;

  const menuWrap = `<div style="width:180px;background:#fff;border:0.5px solid var(--divider);border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,0.12);overflow:hidden;">${html}</div>`;
  _uiRowMenuToggle(triggerEl, menuWrap);
}

function _tmToggleFilterValue(groupName, key) {
  const group = (groupName === '_tmRoleFilter') ? _tmRoleFilter : _tmStatusFilter;
  group[key] = !group[key];
  _tmRenderRows();
  // Update the Filter button's badge/style in place, without closing the
  // open panel — a full tmRender() here would rebuild the toolbar (and the
  // still-open panel along with it), which is unnecessary churn and would
  // otherwise risk losing the panel's own open state.
  const btn = document.getElementById('tm-filter-btn');
  if (btn) {
    const count = _tmActiveFilterCount();
    const active = count > 0;
    btn.style.borderColor = active ? 'var(--purple)' : 'var(--divider)';
    btn.style.color = active ? 'var(--purple)' : 'var(--t2)';
    btn.style.background = active ? 'var(--purple-pale)' : '#fff';
    btn.innerHTML = `<i class="ti ti-filter" style="font-size:11px;" aria-hidden="true"></i> Filter${active?(' <span style="background:var(--purple);color:#fff;border-radius:8px;padding:0 5px;font-size:8px;">'+count+'</span>'):''} <i class="ti ti-chevron-down" style="font-size:10px;" aria-hidden="true"></i>`;
  }
}

function _tmClearAllFilters() {
  _tmSearchQuery = '';
  _tmRoleFilter = { admin: false, member: false, readonly: false };
  _tmStatusFilter = { active: false, disabled: false, invite_pending: false };
  const searchInput = document.getElementById('tm-search-input');
  if (searchInput) searchInput.value = '';
  if (typeof _uiRowMenuClose === 'function') _uiRowMenuClose();
  tmRender(); // full rebuild — cheap, infrequent action, simplest way to reset the toolbar's visual state (badge, button styling) back to its unfiltered appearance
}

function _tmStatusBadge(status) {
  if (status === 'disabled') return '<span class="tm-badge tm-badge-disabled">Disabled</span>';
  if (status === 'invite_pending') return '<span class="tm-badge tm-badge-pending">Invite pending</span>';
  return '<span class="tm-badge tm-badge-active">Active</span>';
}

function _tmRoleBadge(role) {
  if (role === 'admin') return '<span class="tm-badge tm-badge-admin">Admin</span>';
  if (role === 'readonly') return '<span class="tm-badge tm-badge-readonly">Read Only</span>';
  return '<span class="tm-badge tm-badge-member">Power User</span>';
}

function _tmAccessBadge(access) {
  if (access === 'control_tower') return '<span class="tm-badge tm-badge-control-tower">Control Tower</span>';
  return '<span class="tm-badge tm-badge-full-suite">Full Suite</span>';
}

function _tmRowHTML(m) {
  const rowClass = 'tm-row' + (m.status === 'disabled' ? ' tm-row-disabled' : '');
  const nameHtml = m.namePlaceholder
    ? '<span style="font-style:italic;color:#6b6b68;">' + e(m.name) + '</span>'
    : e(m.name);
  const actionsCell = m.is_self
    ? '<div></div>'
    : `<div style="position:relative;">
        <button class="tm-dots" aria-label="Row actions" aria-expanded="false" onclick="event.stopPropagation();tmToggleRowMenu(this,'${e(m.user_id)}','${m.role}','${m.status}','${m.access}')">
          <i class="ti ti-dots-vertical" style="font-size:14px;" aria-hidden="true"></i>
        </button>
      </div>`;
  return `<div class="${rowClass}" data-user-id="${e(m.user_id)}">
    <div style="font-size:11px;font-weight:600;">${nameHtml}</div>
    <div style="font-size:11px;color:#6b6b68;">${e(m.email)}</div>
    <div>${_tmRoleBadge(m.role)}</div>
    <div>${_tmAccessBadge(m.access)}</div>
    <div>${_tmStatusBadge(m.status)}</div>
    ${actionsCell}
  </div>`;
}

// ── Row action menu ──
function tmToggleRowMenu(triggerEl, userId, role, status, access) {
  const items = [];
  if (status === 'invite_pending') {
    items.push({ label: 'Resend', icon: 'ti-refresh', action: `tmResend('${userId}')` });
    items.push({ label: 'Revoke', icon: 'ti-x', action: `tmRevoke('${userId}')`, danger: true });
  } else if (status === 'disabled') {
    items.push({ label: 'Re-enable', icon: 'ti-refresh', action: `tmEnable('${userId}')` });
    items.push({ label: 'Delete', icon: 'ti-trash', action: `tmStartDelete('${userId}')`, danger: true });
  } else {
    // v9.09 — 3-role stacked menu (Option B): show only the "Make X" items
    // that are NOT the member's current role, as peers to Disable/Delete —
    // no submenu/flyout, matching the existing menu shape exactly.
    // Section labels/dividers below match the reviewed prototype's grouping
    // (team-management-access-prototype.html) and reuse the exact heading/
    // divider pattern already established by _tmToggleFilterPanel() above,
    // rather than inventing a new one.
    items.push({ heading: 'Role' });
    var _roleActions = {
      admin:    { label: 'Make Admin',      icon: 'ti-shield' },
      member:   { label: 'Make Power User', icon: 'ti-user' },
      readonly: { label: 'Make Read Only',  icon: 'ti-eye' }
    };
    Object.keys(_roleActions).forEach(function(r) {
      if (r === role) return;
      items.push({ label: _roleActions[r].label, icon: _roleActions[r].icon, action: `tmSetRole('${userId}','${r}')` });
    });
    items.push({ divider: true });
    items.push({ heading: 'Access' });
    var _accessActions = {
      full_suite:    { label: 'Set Full Suite Access',  icon: 'ti-apps' },
      control_tower: { label: 'Set Control Tower Only', icon: 'ti-gauge' }
    };
    Object.keys(_accessActions).forEach(function(a) {
      if (a === access) return;
      items.push({ label: _accessActions[a].label, icon: _accessActions[a].icon, action: `tmSetAccess('${userId}','${a}')` });
    });
    items.push({ divider: true });
    items.push({ label: 'Disable', icon: 'ti-ban', action: `tmDisable('${userId}')` });
    items.push({ label: 'Delete', icon: 'ti-trash', action: `tmStartDelete('${userId}')`, danger: true });
  }
  const html = items.map(function(it, idx) {
    if (it.heading) return `<div style="padding:8px 12px 4px;font-size:9px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--label);">${it.heading}</div>`;
    if (it.divider) return '<div style="height:0.5px;background:#D0D5E8;"></div>';
    const dividerBefore = it.danger && idx > 0 ? '<div style="height:0.5px;background:#D0D5E8;"></div>' : '';
    return dividerBefore + `<div role="menuitem" tabindex="0" class="tm-menu-item${it.danger ? ' tm-menu-item-danger' : ''}"
      onclick="_uiRowMenuClose();${it.action}">
      <i class="ti ${it.icon}" style="font-size:13px;" aria-hidden="true"></i>${it.label}
    </div>`;
  }).join('');
  const menuWrap = `<div style="width:170px;background:#fff;border:0.5px solid #D0D5E8;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,0.12);overflow:hidden;">${html}</div>`;
  _uiRowMenuToggle(triggerEl, menuWrap);
}

// ── Invite modal ──
function tmShowInviteModal() {
  const existing = document.getElementById('tm-invite-overlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'tm-invite-overlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal" style="max-width:380px;position:relative;">
    <button onclick="document.getElementById('tm-invite-overlay').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:3px;color:var(--t3);" title="Close" aria-label="Close">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
    <div style="padding:20px 44px 16px 20px;display:flex;gap:12px;align-items:flex-start;">
      <div style="width:30px;height:30px;border-radius:7px;background:var(--purple-pale);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <i class="ti ti-user-plus" style="font-size:15px;color:var(--purple);" aria-hidden="true"></i>
      </div>
      <div>
        <div style="font-size:13px;font-weight:700;color:var(--t1);">Invite Team Member</div>
        <div style="font-size:10px;color:var(--t3);margin-top:2px;">They'll get an email to join your company.</div>
      </div>
    </div>
    <div style="padding:0 20px 4px;display:flex;flex-direction:column;gap:12px;">
      <div>
        <label style="font-size:10px;font-weight:700;color:var(--t2);display:block;margin-bottom:4px;">Full Name <span style="color:var(--label);font-weight:400;">(optional)</span></label>
        <input id="tm-inv-name" placeholder="Jane Doe" style="width:100%;height:32px;border:1px solid var(--divider);border-radius:6px;padding:0 10px;font-size:11px;box-sizing:border-box;"/>
      </div>
      <div>
        <label style="font-size:10px;font-weight:700;color:var(--t2);display:block;margin-bottom:4px;">Email <span style="color:var(--red);font-weight:700;">*</span></label>
        <input id="tm-inv-email" placeholder="jane.doe@hcltech.com" style="width:100%;height:32px;border:1px solid var(--divider);border-radius:6px;padding:0 10px;font-size:11px;box-sizing:border-box;"/>
        <div id="tm-inv-email-err" style="font-size:9px;color:var(--red);margin-top:3px;display:none;"></div>
      </div>
      <div>
        <label style="font-size:10px;font-weight:700;color:var(--t2);display:block;margin-bottom:4px;">Role</label>
        <div style="display:flex;gap:6px;">
          <div id="tm-inv-role-admin" onclick="_tmSelectInviteRole('admin')" style="flex:1;text-align:center;padding:7px 0;border:1px solid var(--divider);border-radius:6px;font-size:11px;font-weight:600;color:var(--t3);cursor:pointer;">Admin</div>
          <div id="tm-inv-role-member" onclick="_tmSelectInviteRole('member')" style="flex:1;text-align:center;padding:7px 0;border:1px solid var(--purple);background:var(--purple-pale);border-radius:6px;font-size:11px;font-weight:600;color:var(--purple);cursor:pointer;">Power User</div>
          <div id="tm-inv-role-readonly" onclick="_tmSelectInviteRole('readonly')" style="flex:1;text-align:center;padding:7px 0;border:1px solid var(--divider);border-radius:6px;font-size:11px;font-weight:600;color:var(--t3);cursor:pointer;">Read Only</div>
        </div>
      </div>
      <div>
        <label style="font-size:10px;font-weight:700;color:var(--t2);display:block;margin-bottom:4px;">Access</label>
        <div style="display:flex;gap:6px;">
          <div id="tm-inv-access-full_suite" onclick="_tmSelectInviteAccess('full_suite')" style="flex:1;text-align:center;padding:7px 0;border:1px solid var(--purple);background:var(--purple-pale);border-radius:6px;font-size:11px;font-weight:600;color:var(--purple);cursor:pointer;">Full Suite</div>
          <div id="tm-inv-access-control_tower" onclick="_tmSelectInviteAccess('control_tower')" style="flex:1;text-align:center;padding:7px 0;border:1px solid var(--divider);border-radius:6px;font-size:11px;font-weight:600;color:var(--t3);cursor:pointer;">Control Tower Only</div>
        </div>
      </div>
    </div>
    <div style="padding:16px 20px 18px;display:flex;justify-content:flex-end;gap:8px;">
      <button onclick="document.getElementById('tm-invite-overlay').remove()" class="modal-cancel-btn">Cancel</button>
      <button id="tm-inv-submit-btn" onclick="tmSubmitInvite()" style="background:var(--purple);color:#fff;border:none;border-radius:6px;padding:7px 16px;font-size:11px;font-weight:700;cursor:pointer;">Invite Member</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  window._tmSelectedRole = 'member';
  window._tmSelectedAccess = 'full_suite';
  const escC = function(ev){ if(ev.key==='Escape'){ overlay.remove(); document.removeEventListener('keydown',escC,true); } };
  document.addEventListener('keydown', escC, true);
  trapFocus(overlay);
}

function _tmSelectInviteRole(role) {
  window._tmSelectedRole = role;
  const admin = document.getElementById('tm-inv-role-admin');
  const member = document.getElementById('tm-inv-role-member');
  const readonly = document.getElementById('tm-inv-role-readonly');
  const activeStyle = 'flex:1;text-align:center;padding:7px 0;border:1px solid var(--purple);background:var(--purple-pale);border-radius:6px;font-size:11px;font-weight:600;color:var(--purple);cursor:pointer;';
  const inactiveStyle = 'flex:1;text-align:center;padding:7px 0;border:1px solid var(--divider);border-radius:6px;font-size:11px;font-weight:600;color:var(--t3);cursor:pointer;';
  if (admin) admin.style.cssText = role === 'admin' ? activeStyle : inactiveStyle;
  if (member) member.style.cssText = role === 'member' ? activeStyle : inactiveStyle;
  if (readonly) readonly.style.cssText = role === 'readonly' ? activeStyle : inactiveStyle;
}

function _tmSelectInviteAccess(access) {
  window._tmSelectedAccess = access;
  const fullSuite = document.getElementById('tm-inv-access-full_suite');
  const controlTower = document.getElementById('tm-inv-access-control_tower');
  const activeStyle = 'flex:1;text-align:center;padding:7px 0;border:1px solid var(--purple);background:var(--purple-pale);border-radius:6px;font-size:11px;font-weight:600;color:var(--purple);cursor:pointer;';
  const inactiveStyle = 'flex:1;text-align:center;padding:7px 0;border:1px solid var(--divider);border-radius:6px;font-size:11px;font-weight:600;color:var(--t3);cursor:pointer;';
  if (fullSuite) fullSuite.style.cssText = access === 'full_suite' ? activeStyle : inactiveStyle;
  if (controlTower) controlTower.style.cssText = access === 'control_tower' ? activeStyle : inactiveStyle;
}

async function tmSubmitInvite() {
  const nameEl = document.getElementById('tm-inv-name');
  const emailEl = document.getElementById('tm-inv-email');
  const errEl = document.getElementById('tm-inv-email-err');
  const btn = document.getElementById('tm-inv-submit-btn');
  const email = (emailEl.value || '').trim();
  errEl.style.display = 'none';

  if (!email) {
    errEl.textContent = 'Email is required.';
    errEl.style.display = 'block';
    return;
  }
  const domain = (typeof AUTH_DOMAIN !== 'undefined') ? AUTH_DOMAIN : 'hcltech.com';
  if (!email.toLowerCase().endsWith('@' + domain)) {
    errEl.textContent = 'Email must be a @' + domain + ' address.';
    errEl.style.display = 'block';
    return;
  }
  if (_tmMembers.some(function(m){ return m.email.toLowerCase() === email.toLowerCase(); })) {
    errEl.textContent = 'Already a member of this company.';
    errEl.style.display = 'block';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Inviting...';
  const result = await _tmCall('/api/team/invite', {
    email, full_name: (nameEl.value || '').trim(), role: window._tmSelectedRole || 'member',
    access: window._tmSelectedAccess || 'full_suite'
  });
  btn.disabled = false;
  btn.textContent = 'Invite Member';

  if (result.error) {
    errEl.textContent = result.error.message || 'Could not send invite.';
    errEl.style.display = 'block';
    return;
  }
  const overlay = document.getElementById('tm-invite-overlay');
  if (overlay) overlay.remove();
  if (typeof showToast === 'function') showToast(result.message || 'Invite sent.');
  tmLoad();
}

// ── Set role ──
async function tmSetRole(userId, newRole) {
  const result = await _tmCall('/api/team/set-role', { target_user_id: userId, new_role: newRole });
  if (result.error) {
    if (typeof showToast === 'function') showToast(result.error.message);
    return;
  }
  tmLoad();
}

// ── Set access ──
async function tmSetAccess(userId, newAccess) {
  const result = await _tmCall('/api/team/set-access', { target_user_id: userId, new_access: newAccess });
  if (result.error) {
    if (typeof showToast === 'function') showToast(result.error.message);
    return;
  }
  tmLoad();
}

// ── Disable / Enable ──
async function tmDisable(userId) {
  const member = _tmMembers.find(function(m){ return m.user_id === userId; });
  showConfirm(
    'They will lose access to this company immediately. You can re-enable them later.',
    'Disable ' + (member ? member.name : 'this member') + '?',
    async function(){
      const result = await _tmCall('/api/team/disable', { target_user_id: userId });
      if (result.error) { if (typeof showToast === 'function') showToast(result.error.message); return; }
      tmLoad();
    },
    'Disable', 'warn'
  );
}

async function tmEnable(userId) {
  const result = await _tmCall('/api/team/enable', { target_user_id: userId });
  if (result.error) {
    if (typeof showToast === 'function') showToast(result.error.message);
    return;
  }
  tmLoad();
}

// ── Delete — two-step: check shared sessions, then branch the confirm UI ──
async function tmStartDelete(userId) {
  const member = _tmMembers.find(function(m){ return m.user_id === userId; });
  const name = member ? member.name : 'this member';
  const step1 = await _tmCall('/api/team/delete', { target_user_id: userId });
  if (step1.error) {
    if (typeof showToast === 'function') showToast(step1.error.message);
    return;
  }
  const sharedCount = step1.shared_session_count || 0;
  const privateCount = step1.private_session_count || 0;
  // v8.114: Delete now actually deletes private sessions, not just the
  // membership row — the confirm copy discloses the count so this is
  // informed consent for a genuinely destructive action, not a vague
  // "can't be undone" that undersells what's actually about to happen.
  const sessionNote = privateCount > 0
    ? (' This will also permanently delete ' + privateCount + ' of their session' + (privateCount===1?'':'s') + '.')
    : '';
  if (sharedCount === 0) {
    showConfirm(
      "They'll lose access to this company." + sessionNote + ' This can\'t be undone.',
      'Delete ' + name + '?',
      // Phase 5: 'no_shared_sessions' replaces the old 'retain' string —
      // Retain is no longer a concept in the UI (see _tmShowSharedSessionChoice).
      // This path only runs when sharedCount===0, so there's nothing for
      // the server's reassign/delete_sessions branches to act on regardless
      // of the resolution value passed — this name just keeps the client
      // code honest about why, rather than referencing a removed choice.
      function(){ _tmExecuteDelete(userId, 'no_shared_sessions'); },
      'Delete', 'danger'
    );
  } else {
    _tmShowSharedSessionChoice(userId, name, sharedCount, privateCount);
  }
}

// Phase 5: rewritten to call the extended showConfirm() (see utils.js)
// instead of its own bespoke document.createElement overlay — this was
// previously the ONLY modal in the app that diverged from the shared
// confirm shell, and it looked it (3 stacked full-width buttons vs. the
// shell's icon+title+body+button-row pattern used everywhere else).
// Retain removed entirely — confirmed as a genuine correctness gap, not
// just a UI simplification: it left the session's user_id pointed at a
// departed member with zero active company membership, an orphaned-
// ownership state that fails the session's own RLS check for its nominal
// owner, with no cleanup path anywhere else in the app. Reassign already
// covers everything Retain claimed to, without the dangling pointer.
function _tmShowSharedSessionChoice(userId, name, count, privateCount) {
  const body = 'Choose what happens to ' + (count===1?'it':'them') + '.' +
    (privateCount>0 ? (' '+privateCount+' private session'+(privateCount===1?'':'s')+' will be deleted either way.') : '');
  showConfirm(
    body,
    e(name)+' shares '+count+' session'+(count===1?'':'s')+' with the team',
    function(){ _tmExecuteDelete(userId, 'delete_sessions'); },
    'Delete',
    'warn',
    'Cancel',
    null,
    {
      label: 'Reassign to me',
      bg: 'var(--blue-pale)', color: 'var(--blue)', borderColor: 'var(--blue-mid)',
      onClick: function(){ _tmExecuteDelete(userId, 'reassign'); }
    }
  );
}

async function _tmExecuteDelete(userId, resolution) {
  const result = await _tmCall('/api/team/delete', { target_user_id: userId, resolution });
  if (result.error) {
    if (typeof showToast === 'function') showToast(result.error.message);
    return;
  }
  // Phase 5: differentiated toast copy by resolution, using the real
  // affected count the server echoes back (see server.js's execute branch,
  // which now .select()s the mutated rows) — not the step-1 count, which
  // could theoretically have drifted between the count check and execute.
  if (typeof showToast === 'function') {
    const n = result.affected_count || 0;
    if (resolution === 'reassign') {
      showToast('Member removed. '+n+' session'+(n===1?'':'s')+' reassigned to you.', 'success');
    } else if (resolution === 'delete_sessions') {
      showToast('Member removed. '+n+' shared session'+(n===1?'':'s')+' deleted.', 'warn');
    } else {
      showToast('Member removed.', 'info');
    }
  }
  tmLoad();
}

// ── Resend / Revoke ──
async function tmResend(userId) {
  const result = await _tmCall('/api/team/resend', { target_user_id: userId });
  if (result.error) {
    if (typeof showToast === 'function') showToast(result.error.message);
    return;
  }
  _tmShowInviteLink(result.link);
}

function _tmShowInviteLink(link) {
  const existing = document.getElementById('tm-link-overlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'tm-link-overlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal" style="max-width:420px;position:relative;">
    <button onclick="document.getElementById('tm-link-overlay').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:3px;color:var(--t3);" title="Close" aria-label="Close">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
    <div style="padding:20px;">
      <div style="font-size:13px;font-weight:700;color:var(--t1);margin-bottom:6px;">New invite link ready</div>
      <div style="font-size:11px;color:var(--t3);margin-bottom:12px;line-height:1.5;">No email was sent — copy this link and share it with them directly.</div>
      <div style="display:flex;gap:6px;">
        <input id="tm-link-field" readonly value="${e(link || '')}" style="flex:1;height:32px;border:1px solid var(--divider);border-radius:6px;padding:0 10px;font-size:10px;box-sizing:border-box;color:var(--t2);"/>
        <button onclick="_tmCopyLink()" style="background:var(--purple);color:#fff;border:none;border-radius:6px;padding:0 14px;font-size:11px;font-weight:700;cursor:pointer;">Copy</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  trapFocus(overlay);
}

function _tmCopyLink() {
  const field = document.getElementById('tm-link-field');
  if (!field) return;
  field.select();
  try {
    document.execCommand('copy');
    if (typeof showToast === 'function') showToast('Link copied.');
  } catch(e) {
    console.warn('_tmCopyLink: copy failed', e);
  }
}

async function tmRevoke(userId) {
  const member = _tmMembers.find(function(m){ return m.user_id === userId; });
  showConfirm(
    "They won't be able to use their invite link anymore. This can't be undone.",
    'Revoke invite for ' + (member ? member.name : 'this person') + '?',
    async function(){
      const result = await _tmCall('/api/team/revoke', { target_user_id: userId });
      if (result.error) { if (typeof showToast === 'function') showToast(result.error.message); return; }
      tmLoad();
    },
    'Revoke', 'danger'
  );
}
