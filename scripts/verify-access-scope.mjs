import 'dotenv/config';
import mysql from 'mysql2/promise';

const baseUrl = String(process.env.ERP_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'inventory_erp'
};

async function request(path, token = '', options = {}) {
  const headers = new Headers(options.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function assert(condition, message, details = undefined) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

function contextHeaders(token, source, company) {
  return {
    Authorization: `Bearer ${token}`,
    'X-ERP-Context-Key': source,
    'X-Source-Database': source,
    'X-Company-Id': company
  };
}

async function login(username, password) {
  const result = await request('/api/auth/login', '', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  assert(result.status === 200 && result.body.ok && result.body.data?.token, `登入 ${username} 失敗：${result.body.error || result.status}`);
  return result.body.data;
}

let db;
let adminToken = '';
let testToken = '';
let testUsername = '';
let testUserId = null;

try {
  db = await mysql.createConnection(dbConfig);
  const admin = await login(process.env.ERP_AUDIT_USER || 'admin', process.env.ERP_AUDIT_PASSWORD || '12345678');
  adminToken = admin.token;
  const adminHeaders = { Authorization: `Bearer ${adminToken}` };

  const contexts = await request('/api/company-contexts', adminToken);
  assert(contexts.status === 200 && contexts.body.ok, `取得公司上下文失敗：${contexts.body.error || contexts.status}`);
  const sh = (contexts.body.data || []).find(row => String(row.source_database).toUpperCase() === 'SH');
  const alternate = (contexts.body.data || []).find(row => String(row.source_database).toUpperCase() !== 'SH');
  assert(sh, '找不到 SH 公司上下文');
  assert(alternate, '至少需要另一個公司上下文才能驗證跨公司攔截');
  const shCompany = String(sh.company_id || 'SH');
  const alternateSource = String(alternate.source_database).toUpperCase();
  const alternateCompany = String(alternate.company_id || alternateSource);

  const roleResult = await request('/api/access-roles', adminToken);
  assert(roleResult.status === 200 && roleResult.body.ok, `取得角色失敗：${roleResult.body.error || roleResult.status}`);
  const purchaser = (roleResult.body.data?.roles || []).find(role => String(role.role_code).toUpperCase() === 'PURCHASER');
  assert(purchaser, '找不到 PURCHASER 採購角色');

  const departmentResult = await request('/api/access-departments/options?source_key=SH', adminToken);
  assert(departmentResult.status === 200 && departmentResult.body.ok, `取得 SH 部門選項失敗：${departmentResult.body.error || departmentResult.status}`);
  const departments = departmentResult.body.data || [];
  const selectedDepartment = String(departments[0]?.department_code || '').trim().toUpperCase();
  assert(selectedDepartment, 'SH 尚未有可供權限驗證的部門主檔');
  const otherDepartment = String(departments.find(row => String(row.department_code).trim().toUpperCase() !== selectedDepartment)?.department_code || 'ZZ_VERIFY').trim().toUpperCase();

  testUsername = `scope_verify_${Date.now()}`;
  const created = await request('/api/access-users', adminToken, {
    method: 'POST',
    headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: testUsername,
      employee_code: 'VERIFY',
      display_name: '權限範圍暫存驗證',
      password: 'ScopeTest!2026',
      role_id: Number(purchaser.id),
      source_keys: ['SH']
    })
  });
  assert(created.status === 201 && created.body.ok && created.body.data?.id, `建立暫存驗證帳號失敗：${created.body.error || created.status}`);
  testUserId = Number(created.body.data.id);

  const savedScope = await request(`/api/access-departments/${testUserId}`, adminToken, {
    method: 'PUT',
    headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_key: 'SH', mode: 'selected', department_codes: [selectedDepartment], reason: '自動化權限範圍驗證' })
  });
  assert(savedScope.status === 200 && savedScope.body.ok, `儲存指定部門範圍失敗：${savedScope.body.error || savedScope.status}`);

  const user = await login(testUsername, 'ScopeTest!2026');
  testToken = user.token;
  const userAccess = await request('/api/auth/access', testToken);
  assert(userAccess.status === 200 && userAccess.body.ok, `取得一般帳號權限失敗：${userAccess.body.error || userAccess.status}`);
  const scope = (userAccess.body.data?.department_scopes || []).find(row => String(row.source_key).toUpperCase() === 'SH');
  assert(scope?.mode === 'selected' && (scope.department_codes || []).map(code => String(code).toUpperCase()).includes(selectedDepartment), '登入後未取得指定部門範圍');

  const allowed = await request(`/api/procurement/open-orders?source_database=SH&department_code=${encodeURIComponent(selectedDepartment)}`, testToken, {
    headers: contextHeaders(testToken, 'SH', shCompany)
  });
  assert(allowed.status === 200 && allowed.body.ok, `授權部門查詢失敗：${allowed.body.error || allowed.status}`);

  const missingContext = await request('/api/procurement/open-orders?source_database=SH', testToken, {
    headers: contextHeaders(testToken, 'SH', shCompany)
  });
  assert(missingContext.status === 403, `指定部門帳號未要求部門上下文，回應 ${missingContext.status}`);

  const denied = await request(`/api/procurement/open-orders?source_database=SH&department_code=${encodeURIComponent(otherDepartment)}`, testToken, {
    headers: contextHeaders(testToken, 'SH', shCompany)
  });
  assert(denied.status === 403, `未授權部門未被拒絕，回應 ${denied.status}`);

  const crossCompany = await request(`/api/procurement/open-orders?source_database=${alternateSource}`, testToken, {
    headers: contextHeaders(testToken, alternateSource, alternateCompany)
  });
  assert(crossCompany.status === 409, `跨公司請求未被拒絕，回應 ${crossCompany.status}`);

  const audit = await request(`/api/access-audit?target_user_id=${testUserId}`, adminToken);
  assert(audit.status === 200 && audit.body.ok, `取得權限稽核歷程失敗：${audit.body.error || audit.status}`);
  const auditRows = audit.body.data || [];
  assert(auditRows.some(row => row.action_code === 'DEPARTMENT_SCOPE_UPDATED'), '部門範圍異動未寫入稽核歷程');
  assert(auditRows.some(row => row.action_code === 'CROSS_DEPARTMENT_REQUEST_REJECTED'), '跨部門拒絕未寫入稽核歷程');
  assert(auditRows.some(row => row.action_code === 'CROSS_COMPANY_REQUEST_REJECTED'), '跨公司拒絕未寫入稽核歷程');

  console.log(JSON.stringify({
    ok: true,
    base_url: baseUrl,
    tested_role: 'PURCHASER',
    tested_company: 'SH',
    tested_department: selectedDepartment,
    allowed_request_status: allowed.status,
    rejected: { missing_department_context: missingContext.status, cross_department: denied.status, cross_company: crossCompany.status },
    audit_events: ['DEPARTMENT_SCOPE_UPDATED', 'CROSS_DEPARTMENT_REQUEST_REJECTED', 'CROSS_COMPANY_REQUEST_REJECTED'],
    message: '帳號公司範圍、指定部門範圍、跨公司／跨部門攔截與權限稽核均通過。'
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message, details: error.details }, null, 2));
  process.exitCode = 1;
} finally {
  if (testToken) {
    try { await request('/api/auth/logout', testToken, { method: 'POST' }); } catch (_) { /* 清理失敗不覆蓋原始驗證結果 */ }
  }
  if (adminToken) {
    try { await request('/api/auth/logout', adminToken, { method: 'POST' }); } catch (_) { /* 清理失敗不覆蓋原始驗證結果 */ }
  }
  if (db) {
    try {
      if (!testUserId && testUsername) {
        const [[row]] = await db.query('SELECT id FROM access_users WHERE username=?', [testUsername]);
        testUserId = row?.id ? Number(row.id) : null;
      }
      if (testUserId) {
        await db.query('DELETE FROM access_audit_log WHERE target_user_id=? OR actor_user_id=?', [testUserId, testUserId]);
        await db.query('DELETE FROM access_user_departments WHERE user_id=?', [testUserId]);
        await db.query('DELETE FROM access_user_companies WHERE user_id=?', [testUserId]);
        await db.query('DELETE FROM access_sessions WHERE user_id=?', [testUserId]);
        await db.query('DELETE FROM access_users WHERE id=?', [testUserId]);
      }
    } catch (cleanupError) {
      console.error(JSON.stringify({ ok: false, cleanup_error: cleanupError.message }, null, 2));
      process.exitCode = 1;
    } finally {
      await db.end();
    }
  }
}
