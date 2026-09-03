let authToken = localStorage.getItem('erp-auth-token') || '';
let currentUser = JSON.parse(localStorage.getItem('erp-auth-user') || 'null');
const baseLoadAccessControl = loadAccessControl;

async function authenticatedApi(path, options = {}) {
  const target = path.startsWith('/api/sh/') ? `${path}${path.includes('?') ? '&' : '?'}db=${encodeURIComponent(currentDatabase)}` : path;
  const headers = new Headers(options.headers || {});
  if (authToken) headers.set('Authorization', `Bearer ${authToken}`);
  const response = await fetch(target, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    if (response.status === 401 && path !== '/api/auth/login') showLogin('登入已失效，請重新登入。');
    throw Error(body.error || 'API error');
  }
  return body.data;
}

function showLogin(message = '') { $('#loginGate').hidden = false; $('#loginStatus').textContent = message; }
function hideLogin() { $('#loginGate').hidden = true; $('#loginStatus').textContent = ''; }

async function beginAuthenticatedApp() {
  try {
    const profile = await authenticatedApi('/api/auth/me');
    const access = await authenticatedApi('/api/auth/access');
    currentUser = profile; localStorage.setItem('erp-auth-user', JSON.stringify(profile));
    hideLogin();
    accessState.activeRoleId = Number(profile.role_id); localStorage.setItem('erp-active-role-id', String(profile.role_id));
    accessState.isAdmin = Boolean(access.is_admin); accessState.permissions = access.permissions || [];
    const userLabel = $('#currentUserLabel'); const userAvatar = $('#currentUserAvatar');
    if (userLabel) userLabel.textContent = `${profile.display_name}（${profile.username}｜${profile.role_name}）`;
    if (userAvatar) userAvatar.textContent = String(profile.username || profile.display_name || '--').slice(0, 2).toUpperCase();
    await loadCompanyOptions(); await loadDatabaseOptions(); renderAll(); await refresh();
  } catch (error) {
    console.error('ERP login initialization failed:', error);
    showLogin(`登入後初始化失敗：${error.message}`);
  }
}

async function loadAuthenticatedAccessControl() {
  if (currentUser?.role_code !== 'ADMIN') return;
  await baseLoadAccessControl();
  if (currentUser?.role_code !== 'ADMIN' || $('#accessUserPanel')) return;
  $('#canvas .screen-body').insertAdjacentHTML('beforeend', `<div class="panel" id="accessUserPanel" style="margin-top:18px"><div class="panel-head">員工登入帳號與密碼維護</div><div class="panel-body"><form id="accessUserForm"><div class="row c3"><div class="field"><label>登入帳號</label><input name="username" required></div><div class="field"><label>員工代號</label><input name="employee_code"></div><div class="field"><label>員工姓名</label><input name="display_name" required></div></div><div class="row c2"><div class="field"><label>初始密碼</label><input name="password" type="password" minlength="8" required></div><div class="field"><label>角色</label><select name="role_id" id="accessUserRole"></select></div></div><button class="btn primary" type="submit">建立員工帳號</button></form><hr style="margin:20px 0;border:0;border-top:1px solid #e8dfd2"><form id="adminPasswordResetForm"><div class="row c3"><div class="field"><label>重設帳號</label><select name="user_id" id="resetUserId" required></select></div><div class="field"><label>新密碼（至少 8 碼）</label><input name="new_password" type="password" minlength="8" required></div><div class="field"><label>確認新密碼</label><input name="confirm_password" type="password" minlength="8" required></div></div><button class="btn primary" type="submit">重設密碼</button></form><div id="accessUserStatus" class="desc" style="margin-top:12px"></div><div class="table-wrap"><table class="grid"><thead><tr><th>帳號</th><th>員工</th><th>角色</th><th>狀態</th><th>首次登入改密碼</th></tr></thead><tbody id="accessUserRows"></tbody></table></div></div></div>`);
  $('#accessUserRole').innerHTML = accessState.roles.map(role => `<option value="${role.id}">${role.role_name}</option>`).join('');
  $('#accessUserForm').onsubmit = async event => {
    event.preventDefault(); const form = event.currentTarget; const data = Object.fromEntries(new FormData(form).entries());
    try { await api('/api/access-users', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) }); form.reset(); await loadAccessUsers(); toast('員工登入帳號已建立。'); } catch (error) { toast(error.message, true); }
  };
  $('#adminPasswordResetForm').onsubmit = async event => {
    event.preventDefault(); const form = event.currentTarget; const data = Object.fromEntries(new FormData(form).entries());
    if (data.new_password !== data.confirm_password) return toast('兩次輸入的新密碼不一致。', true);
    try {
      await api('/api/auth/admin-reset-password', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) });
      form.reset(); await loadAccessUsers(); toast('密碼已重設；其他已登入裝置將需要重新登入。');
    } catch (error) { toast(error.message, true); }
  };
  await loadAccessUsers();
}

async function loadAccessUsers() {
  try {
    const rows = await api('/api/access-users');
    $('#accessUserStatus').textContent = `目前共 ${rows.length} 個登入帳號。`;
    $('#accessUserRows').innerHTML = rows.map(row => `<tr><td>${esc(row.username)}</td><td>${esc(row.employee_code || '-')} / ${esc(row.display_name)}</td><td>${esc(row.role_name)}</td><td>${row.is_active ? '啟用' : '停用'}</td><td>${row.force_password_change ? '是' : '否'}</td></tr>`).join('') || '<tr><td colspan="5" class="empty-hint">尚未建立帳號</td></tr>';
    $('#resetUserId').innerHTML = rows.filter(row => row.is_active).map(row => `<option value="${row.id}">${esc(row.username)}（${esc(row.display_name)}）</option>`).join('');
  } catch (error) { $('#accessUserStatus').textContent = error.message; }
}

function renderAuthenticatedScreen() {
  renderScreen();
  const documentKinds = { 'requisition-entry':'requisitions', 'purchase-order-entry':'orders', 'receipt-entry':'receipts' };
  const kind = documentKinds[state.f];
  if (!kind) return;
  queueMicrotask(() => {
    const form = $('#canvas form'); if (!form || $('#approveDraftDocument')) return;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'btn'; button.id = 'approveDraftDocument'; button.textContent = '核准目前草稿'; button.style.marginLeft = '8px';
    button.onclick = async () => {
      const id = form.dataset.editId;
      if (!id) return toast('請先從近期單據選擇一筆本系統草稿，再執行核准。', true);
      try { await api(`/api/procurement/documents/${kind}/${id}/approve`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({}) }); toast('單據已核准，後續不可直接修改。'); renderScreen(); } catch (error) { toast(error.message, true); }
    };
    form.querySelector('button[type=submit]')?.insertAdjacentElement('afterend', button);
  });
}

$('#loginForm').onsubmit = async event => {
  event.preventDefault(); const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
  $('#loginStatus').textContent = '登入中…';
  try {
    const response = await fetch('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
    const body = await response.json(); if (!response.ok || !body.ok) throw Error(body.error || '登入失敗');
    authToken = body.data.token; currentUser = body.data.user;
    localStorage.setItem('erp-auth-token', authToken); localStorage.setItem('erp-auth-user', JSON.stringify(currentUser));
    await beginAuthenticatedApp();
  } catch (error) { $('#loginStatus').textContent = error.message; }
};

if (authToken) beginAuthenticatedApp(); else showLogin();
