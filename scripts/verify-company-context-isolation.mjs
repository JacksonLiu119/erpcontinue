import dotenv from 'dotenv';

dotenv.config();

const baseUrl = String(process.env.ERP_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');

async function request(path, token = '', options = {}) {
  const headers = new Headers(options.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function contextHeaders(token, source, company) {
  return {
    Authorization: `Bearer ${token}`,
    'X-ERP-Context-Key': source,
    'X-Source-Database': source,
    'X-Company-Id': company
  };
}

async function setContext(token, source) {
  const result = await request('/api/auth/context', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_key: source })
  });
  assert(result.status === 200 && result.body.ok, `切換 ${source} 失敗：${result.body.error || result.status}`);
  return result.body.data;
}

let token = '';
let baseContext = null;
let alternateContext = null;
try {
  const login = await request('/api/auth/login', '', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.ERP_AUDIT_USER || 'admin',
      password: process.env.ERP_AUDIT_PASSWORD || '12345678'
    })
  });
  assert(login.status === 200 && login.body.ok && login.body.data?.token, `登入失敗：${login.body.error || login.status}`);
  token = login.body.data.token;

  const contexts = await request('/api/company-contexts', token);
  assert(contexts.status === 200 && contexts.body.ok, `取得公司上下文失敗：${contexts.body.error || contexts.status}`);
  const rows = contexts.body.data || [];
  baseContext = rows.find(row => String(row.source_database).toUpperCase() === 'SH') || rows[0];
  alternateContext = rows.find(row => String(row.source_database).toUpperCase() !== String(baseContext?.source_database || '').toUpperCase());
  assert(baseContext && alternateContext, '至少需要兩個啟用中的公司上下文才能執行隔離回歸');

  const baseSource = String(baseContext.source_database).toUpperCase();
  const alternateSource = String(alternateContext.source_database).toUpperCase();
  const baseCompany = String(baseContext.company_id || baseSource);
  const alternateCompany = String(alternateContext.company_id || alternateSource);
  await setContext(token, baseSource);

  const normal = await request(`/api/flow-audit/health?source_database=${baseSource}`, token, {
    headers: contextHeaders(token, baseSource, baseCompany)
  });
  assert(normal.status === 200 && normal.body.ok, `目前公司 ${baseSource} 正常稽核失敗：${normal.body.error || normal.status}`);

  const basePreview = await request(`/api/accounting/source-financial-preview?source_database=${baseSource}&from_date=2025-01-01&to_date=2025-12-31&limit=20`, token, {
    headers: contextHeaders(token, baseSource, baseCompany)
  });
  assert(basePreview.status === 200 && basePreview.body.ok, `${baseSource} 來源財報預覽失敗：${basePreview.body.error || basePreview.status}`);
  assert(String(basePreview.body.data?.source_database || '').toUpperCase() === baseSource, `${baseSource} 來源財報預覽回應來源不正確`);

  const crossCompany = await request(`/api/flow-audit/health?source_database=${alternateSource}`, token, {
    headers: contextHeaders(token, alternateSource, alternateCompany)
  });
  assert(crossCompany.status === 409, `跨公司查詢未被拒絕，回應 ${crossCompany.status}`);

  const conflictingSources = await request(`/api/flow-audit/health?source_database=${baseSource}&db=${alternateSource}`, token, {
    headers: contextHeaders(token, baseSource, baseCompany)
  });
  assert(conflictingSources.status === 409, `多個來源參數不一致未被拒絕，回應 ${conflictingSources.status}`);

  const conflictingCompany = await request(`/api/flow-audit/health?source_database=${baseSource}`, token, {
    headers: contextHeaders(token, baseSource, alternateCompany)
  });
  assert(conflictingCompany.status === 409, `公司代號與來源不一致未被拒絕，回應 ${conflictingCompany.status}`);

  await setContext(token, alternateSource);
  const switched = await request(`/api/flow-audit/health?source_database=${alternateSource}`, token, {
    headers: contextHeaders(token, alternateSource, alternateCompany)
  });
  assert(switched.status === 200 && switched.body.ok, `正式切換至 ${alternateSource} 後查詢失敗：${switched.body.error || switched.status}`);
  assert(String(switched.body.data?.source_database || '').toUpperCase() === alternateSource, '切換後回應來源不正確');
  const alternatePreview = await request(`/api/accounting/source-financial-preview?source_database=${alternateSource}&from_date=2025-01-01&to_date=2025-12-31&limit=20`, token, {
    headers: contextHeaders(token, alternateSource, alternateCompany)
  });
  assert(alternatePreview.status === 200 && alternatePreview.body.ok, `${alternateSource} 來源財報預覽失敗：${alternatePreview.body.error || alternatePreview.status}`);
  assert(String(alternatePreview.body.data?.source_database || '').toUpperCase() === alternateSource, `${alternateSource} 來源財報預覽回應來源不正確`);

  console.log(JSON.stringify({
    ok: true,
    base_url: baseUrl,
    checked: [baseSource, alternateSource],
    rejected: ['跨公司來源', '多來源參數衝突', '公司代號與來源衝突'],
    checked_reports: ['流程稽核', '公司別來源財報預覽'],
    message: '作業 API 已綁定登入公司上下文；只有正式切換 API 能變更目前公司。'
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  if (token && baseContext) {
    try { await setContext(token, String(baseContext.source_database).toUpperCase()); } catch (_) { /* 保留原始錯誤 */ }
  }
  if (token) {
    try { await request('/api/auth/logout', token, { method: 'POST' }); } catch (_) { /* 登出失敗不改變隔離結果 */ }
  }
}
