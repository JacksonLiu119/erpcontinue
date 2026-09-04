const ADMIN_TOKEN_KEY = 'erp-admin-token';
let token = localStorage.getItem(ADMIN_TOKEN_KEY) || '';
let profile = null;
let roles = [];
let permissions = [];
let users = [];
let companies = [];
let departmentRows = [];

const featureNames = {
  'access-control':'系統後台','basicdata':'基本資料','warehouses':'庫別','departments':'部門','employees':'員工',
  'source-customers':'客戶','source-suppliers':'廠商','item-categories':'品號類別','items':'品號主檔',
  'import-monitor':'匯入批次','data-quality':'匯入資料品質','inventory-opening':'庫存開帳',
  'inventory-document-types':'庫存單據性質','inventory-transactions':'庫存異動','inventory-transfers':'庫存轉撥',
  'inventory-temporary':'暫出／暫入','inventory-stocktake':'庫存盤點','inventory-posting':'庫存過帳',
  'inventory-reversals':'反過帳／更正','inventory-new-balance':'庫存餘額','inventory-new-ledger':'庫存異動帳',
  'procurement-document-types':'採購單據性質','requisition-entry':'請購建立','requisition-maintenance':'請購轉採購',
  'purchase-order-entry':'採購建立','purchase-order-changes':'採購變更','receipt-entry':'進貨建立',
  'receipt-inspection':'進貨驗收','purchase-returns':'採購退貨／折讓','purchase-progress':'採購進度',
  'open-purchase-orders':'未交採購','purchase-receipts':'進貨明細','sales-document-types':'銷售單據性質',
  'sales-quotations':'報價','sales-orders':'訂單','sales-order-changes':'訂單變更','sales-shipments':'銷貨',
  'sales-returns':'銷退／折讓','sales-progress':'銷售進度','sales-open-orders':'未交訂單',
  'sales-customer-items':'客戶品號（外部料號對照）',
  'finance-workflow':'應收／應付','finance-bookkeeping':'財務管帳（銀行明細）','finance-cash':'財務管錢（存提款／票據）',
  'finance-reconcile':'銀行逐筆對帳','accounting-general-ledger':'會計傳票／總帳','operations-health':'營運健康度',
  'sales-flow-audit':'銷售流程稽核','purchase-flow-audit':'採購流程稽核','architecture-flow':'系統架構與流程圖'
};

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw Error(body.error || `HTTP ${response.status}`);
  return body.data ?? body;
}

function toast(message, error = false) {
  const element = $('#toast');
  element.textContent = message;
  element.className = `toast${error ? ' error' : ''}`;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.hidden = true; }, 3000);
}

function showLogin(message = '') {
  token = '';
  localStorage.removeItem(ADMIN_TOKEN_KEY);
  $('#adminShell').hidden = true;
  $('#loginPage').hidden = false;
  $('#loginStatus').textContent = message;
}

function companyCheckboxes(selected, prefix) {
  const allowed = new Set(selected);
  return companies.map(company => `<label><input type="checkbox" data-company-key="${esc(company.source_database)}" id="${prefix}-${esc(company.source_database)}" ${allowed.has(company.source_database) ? 'checked' : ''}> ${esc(company.company_name)}（${esc(company.source_database)}）</label>`).join('') || '<span>目前沒有可用公司別</span>';
}

function userById(id) {
  return users.find(user => Number(user.id) === Number(id));
}

function scopeRow(userId, sourceKey) {
  return departmentRows.find(row => Number(row.user_id) === Number(userId) && String(row.source_key).toUpperCase() === String(sourceKey).toUpperCase());
}

function scopeSummary(user) {
  const sourceKeys = String(user.allowed_sources || '').split(',').filter(Boolean);
  if (!sourceKeys.length) return '未設定公司別';
  return sourceKeys.map(sourceKey => {
    const scope = scopeRow(user.id, sourceKey);
    if (!scope || scope.department_scope_mode === 'all') return `${esc(sourceKey)}：全部部門`;
    const codes = Array.isArray(scope.department_codes) ? scope.department_codes : [];
    return `${esc(sourceKey)}：指定 ${esc(codes.join('、'))}`;
  }).join('<br>');
}

async function loadRoles() {
  const data = await api('/api/access-roles');
  roles = data.roles || [];
  permissions = data.permissions || [];
  const options = roles.map(role => `<option value="${role.id}">${esc(role.role_name)}（${esc(role.role_code)}）</option>`).join('');
  $('#newUserRole').innerHTML = options;
  $('#permissionRole').innerHTML = options;
  renderPermissions();
}

async function loadCompanies() {
  companies = await api('/api/company-contexts');
  $('#newUserCompanies').innerHTML = companyCheckboxes([], 'new-company');
}

async function loadDepartmentRows() {
  departmentRows = await api('/api/access-departments');
}

function renderScopeSelectors() {
  const activeUserId = Number($('#scopeUser')?.value || users[0]?.id || 0);
  const userOptions = users.map(user => `<option value="${user.id}" ${Number(user.id) === activeUserId ? 'selected' : ''}>${esc(user.username)}（${esc(user.display_name)}）</option>`).join('');
  if ($('#scopeUser')) $('#scopeUser').innerHTML = userOptions || '<option value="">目前沒有帳號</option>';
  if ($('#auditUser')) $('#auditUser').innerHTML = '<option value="">全部帳號</option>' + userOptions;
  if ($('#auditCompany')) $('#auditCompany').innerHTML = '<option value="">全部公司</option>' + companies.map(company => `<option value="${esc(company.source_database)}">${esc(company.company_name)}（${esc(company.source_database)}）</option>`).join('');
  renderScopeCompanyOptions();
}

function renderScopeCompanyOptions() {
  const user = userById(Number($('#scopeUser')?.value));
  const sourceKeys = String(user?.allowed_sources || '').split(',').filter(Boolean);
  const current = String($('#scopeCompany')?.value || '').toUpperCase();
  if ($('#scopeCompany')) {
    $('#scopeCompany').innerHTML = sourceKeys.map(sourceKey => {
      const company = companies.find(row => String(row.source_database).toUpperCase() === sourceKey);
      return `<option value="${esc(sourceKey)}" ${sourceKey === current || (!current && sourceKey === sourceKeys[0]) ? 'selected' : ''}>${esc(company?.company_name || sourceKey)}（${esc(sourceKey)}）</option>`;
    }).join('') || '<option value="">請先設定可進入公司別</option>';
  }
}

async function loadScopeEditor() {
  renderScopeCompanyOptions();
  const userId = Number($('#scopeUser')?.value);
  const sourceKey = String($('#scopeCompany')?.value || '').toUpperCase();
  const scope = scopeRow(userId, sourceKey);
  $('#scopeMode').value = scope?.department_scope_mode === 'selected' ? 'selected' : 'all';
  await loadDepartmentOptions();
}

async function loadDepartmentOptions() {
  const container = $('#scopeDepartments');
  if (!container) return;
  const mode = $('#scopeMode')?.value || 'all';
  const sourceKey = String($('#scopeCompany')?.value || '').toUpperCase();
  if (!sourceKey) {
    container.innerHTML = '<span class="hint">請先在帳號資料設定可進入公司別</span>';
    return;
  }
  try {
    const options = await api(`/api/access-departments/options?source_key=${encodeURIComponent(sourceKey)}`);
    const existing = scopeRow(Number($('#scopeUser')?.value), sourceKey);
    const selected = new Set(existing?.department_codes || []);
    if (mode === 'all') {
      container.innerHTML = '<span class="hint">目前為全部部門模式，不需逐一勾選。</span>';
      return;
    }
    container.innerHTML = options.map(row => `<label><input type="checkbox" data-scope-department value="${esc(String(row.department_code).toUpperCase())}" ${selected.has(String(row.department_code).toUpperCase()) ? 'checked' : ''}> ${esc(row.department_code)}｜${esc(row.department_name || '')}</label>`).join('') || '<span class="hint">此公司尚未建立部門主檔，無法指定部門。</span>';
  } catch (error) {
    container.innerHTML = `<span class="hint error-text">${esc(error.message)}</span>`;
  }
}

async function loadUsers() {
  await loadDepartmentRows();
  users = await api('/api/access-users');
  $('#resetUser').innerHTML = users.filter(user => user.is_active).map(user => `<option value="${user.id}">${esc(user.username)}（${esc(user.display_name)}）</option>`).join('');
  $('#userRows').innerHTML = users.map(user => {
    const selected = String(user.allowed_sources || '').split(',').filter(Boolean);
    return `<tr data-user="${user.id}"><td><b>${esc(user.username)}</b></td><td><input data-field="employee_code" value="${esc(user.employee_code || '')}"></td><td><input data-field="display_name" value="${esc(user.display_name)}"></td><td><select data-field="role_id">${roles.map(role => `<option value="${role.id}" ${Number(role.id) === Number(user.role_id) ? 'selected' : ''}>${esc(role.role_name)}</option>`).join('')}</select></td><td><div class="company-checks compact">${companyCheckboxes(selected, `user-${user.id}`)}</div></td><td class="scope-summary">${scopeSummary(user)}<br><button class="small-button" type="button" data-edit-scope="${user.id}">設定部門</button></td><td><select data-field="is_active"><option value="1" ${user.is_active ? 'selected' : ''}>啟用</option><option value="0" ${!user.is_active ? 'selected' : ''}>停用</option></select></td><td><button data-save-user="${user.id}">儲存</button></td></tr>`;
  }).join('') || '<tr><td colspan="8">目前沒有登入帳號</td></tr>';
  renderScopeSelectors();
  document.querySelectorAll('[data-save-user]').forEach(button => { button.onclick = () => saveUser(Number(button.dataset.saveUser)); });
  document.querySelectorAll('[data-edit-scope]').forEach(button => { button.onclick = async () => { $('#scopeUser').value = button.dataset.editScope; renderScopeCompanyOptions(); await loadScopeEditor(); $('#scopeUser').closest('.card')?.scrollIntoView({ behavior:'smooth', block:'start' }); }; });
}

async function saveUser(id) {
  const row = document.querySelector(`[data-user="${id}"]`);
  const body = {};
  row.querySelectorAll('[data-field]').forEach(field => { body[field.dataset.field] = field.value; });
  body.source_keys = [...row.querySelectorAll('[data-company-key]:checked')].map(input => input.dataset.companyKey);
  body.is_active = body.is_active === '1';
  try {
    await api(`/api/access-users/${id}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    toast('帳號資料已儲存');
    await loadUsers();
  } catch (error) { toast(error.message, true); }
}

async function loadAudit() {
  try {
    const params = new URLSearchParams();
    if ($('#auditUser').value) params.set('target_user_id', $('#auditUser').value);
    if ($('#auditCompany').value) params.set('source_key', $('#auditCompany').value);
    if ($('#auditAction').value.trim()) params.set('action_code', $('#auditAction').value.trim());
    if ($('#auditFrom').value) params.set('from_date', $('#auditFrom').value);
    if ($('#auditTo').value) params.set('to_date', $('#auditTo').value);
    params.set('limit', '300');
    const rows = await api(`/api/access-audit?${params}`);
    $('#auditRows').innerHTML = rows.map(row => {
      const before = row.before_json == null ? '' : JSON.stringify(row.before_json);
      const after = row.after_json == null ? '' : JSON.stringify(row.after_json);
      return `<tr><td>${esc(row.created_at)}</td><td>${esc(row.actor_display_name || row.actor_username || '—')}</td><td>${esc(row.target_display_name || row.target_username || '—')}</td><td><b>${esc(row.action_code)}</b><br><small>${esc(row.entity_type)}／${esc(row.entity_id || '')}</small></td><td>${esc(row.source_key || '—')}／${esc(row.department_code || '—')}</td><td>${esc(row.ip_address || '—')}</td><td>${esc(row.reason || '—')}</td><td><details><summary>查看前後值</summary><small>前：${esc(before || '—')}<br>後：${esc(after || '—')}</small></details></td></tr>`;
    }).join('') || '<tr><td colspan="8">目前沒有符合條件的權限歷程</td></tr>';
  } catch (error) { $('#auditRows').innerHTML = `<tr><td colspan="8" class="error-text">${esc(error.message)}</td></tr>`; }
}

$('#adminLoginForm').onsubmit = async event => {
  event.preventDefault();
  $('#loginStatus').textContent = '登入中…';
  try {
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const result = await api('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) });
    if (result.user.role_code !== 'ADMIN') throw Error('此帳號沒有系統管理員權限');
    token = result.token;
    localStorage.setItem(ADMIN_TOKEN_KEY, token);
    await start();
  } catch (error) { showLogin(error.message); }
};

$('#logoutButton').onclick = () => showLogin('已登出後台');

document.querySelectorAll('[data-view]').forEach(button => {
  button.onclick = () => {
    document.querySelectorAll('[data-view]').forEach(item => item.classList.toggle('active', item === button));
    const view = button.dataset.view;
    $('#usersView').hidden = view !== 'users';
    $('#rolesView').hidden = view !== 'roles';
    $('#auditView').hidden = view !== 'audit';
    $('#pageTitle').textContent = view === 'users' ? '人員帳號管理' : view === 'roles' ? '角色與功能權限' : '權限異動歷程';
    if (view === 'roles') renderPermissions();
    if (view === 'audit') loadAudit();
  };
});

$('#createUserForm').onsubmit = async event => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget));
  body.source_keys = [...$('#newUserCompanies').querySelectorAll('[data-company-key]:checked')].map(input => input.dataset.companyKey);
  try {
    await api('/api/access-users', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    event.currentTarget.reset();
    $('#newUserCompanies').innerHTML = companyCheckboxes([], 'new-company');
    toast('登入帳號已建立');
    await loadUsers();
  } catch (error) { toast(error.message, true); }
};

$('#departmentScopeForm').onsubmit = async event => {
  event.preventDefault();
  const userId = Number($('#scopeUser').value);
  const sourceKey = String($('#scopeCompany').value || '').toUpperCase();
  const mode = $('#scopeMode').value;
  const departmentCodes = [...document.querySelectorAll('[data-scope-department]:checked')].map(input => input.value);
  try {
    await api(`/api/access-departments/${userId}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ source_key:sourceKey, mode, department_codes:departmentCodes, reason:$('#scopeReason').value.trim() }) });
    $('#scopeReason').value = '';
    toast('部門範圍已儲存，異動已寫入稽核歷程');
    await loadUsers();
    $('#scopeUser').value = String(userId);
    renderScopeCompanyOptions();
    await loadScopeEditor();
  } catch (error) { toast(error.message, true); }
};

$('#scopeUser').onchange = () => { renderScopeCompanyOptions(); loadScopeEditor(); };
$('#scopeCompany').onchange = loadScopeEditor;
$('#scopeMode').onchange = loadDepartmentOptions;
$('#reloadUsers').onclick = loadUsers;
$('#reloadAudit').onclick = loadAudit;
$('#auditFilterForm').onsubmit = event => { event.preventDefault(); loadAudit(); };

$('#resetPasswordForm').onsubmit = async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  if (data.new_password !== data.confirm_password) return toast('兩次密碼不一致', true);
  try {
    await api('/api/auth/admin-reset-password', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) });
    event.currentTarget.reset();
    toast('密碼已重設');
  } catch (error) { toast(error.message, true); }
};

$('#createRoleForm').onsubmit = async event => {
  event.preventDefault();
  try {
    await api('/api/access-roles', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    event.currentTarget.reset();
    toast('角色已建立');
    await loadRoles();
  } catch (error) { toast(error.message, true); }
};

$('#permissionRole').onchange = renderPermissions;

function renderPermissions() {
  if (!roles.length) return;
  const roleId = Number($('#permissionRole').value || roles[0].id);
  const role = roles.find(item => Number(item.id) === roleId);
  $('#roleDescription').textContent = role?.description || '';
  const codes = [...new Set([...Object.keys(featureNames), ...permissions.map(permission => permission.feature_code)])];
  const systemAdmin = role?.role_code === 'ADMIN';
  $('#permissionRows').innerHTML = codes.map(code => {
    const permission = permissions.find(item => Number(item.role_id) === roleId && item.feature_code === code) || {};
    return `<tr data-feature="${esc(code)}"><td><b>${esc(featureNames[code] || code)}</b><br><small>${esc(code)}</small></td>${['can_view','can_create','can_update','can_delete','can_approve'].map(key => `<td class="permission-check"><input type="checkbox" data-permission="${key}" ${permission[key] || systemAdmin ? 'checked' : ''} ${systemAdmin ? 'disabled' : ''}></td>`).join('')}</tr>`;
  }).join('');
  $('#savePermissions').disabled = systemAdmin;
  $('#savePermissions').textContent = systemAdmin ? '系統管理員固定擁有全部權限' : '儲存角色權限';
}

$('#savePermissions').onclick = async () => {
  const roleId = Number($('#permissionRole').value);
  const body = [...document.querySelectorAll('[data-feature]')].map(row => {
    const permission = { feature_code:row.dataset.feature };
    row.querySelectorAll('[data-permission]').forEach(input => { permission[input.dataset.permission] = input.checked; });
    return permission;
  });
  try {
    await api(`/api/access-roles/${roleId}/permissions`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ permissions:body }) });
    toast('角色權限已儲存，異動已寫入稽核歷程');
    await loadRoles();
  } catch (error) { toast(error.message, true); }
};

async function start() {
  try {
    profile = await api('/api/auth/me');
    if (profile.role_code !== 'ADMIN') throw Error('此帳號不是系統管理員，無法進入後台');
    $('#adminName').textContent = `${profile.display_name}（${profile.username}）`;
    $('#loginPage').hidden = true;
    $('#adminShell').hidden = false;
    await loadRoles();
    await loadCompanies();
    await loadUsers();
    await loadScopeEditor();
  } catch (error) { showLogin(error.message); }
}

if (token) start(); else showLogin();
