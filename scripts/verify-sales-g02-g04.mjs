import 'dotenv/config';

const baseUrl = String(process.env.ERP_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function request(path, token = '', options = {}) {
  const headers = new Headers(options.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function contextHeaders(token, source, company) {
  return {
    Authorization: `Bearer ${token}`,
    'X-ERP-Context-Key': source,
    'X-Source-Database': source,
    'X-Company-Id': company
  };
}

function encodedQuery(values) {
  return new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== '')).toString();
}

function assertScopedRows(data, source, label, limit = 20) {
  assert(data?.source_database === source, `${source}/${label} 回傳來源資料庫不符：${data?.source_database}`);
  assert(Array.isArray(data?.rows), `${source}/${label} 缺少 rows`);
  assert(data.rows.length <= limit, `${source}/${label} 超過 ${limit} 筆上限：${data.rows.length}`);
  for (const row of data.rows) {
    if (row.source_database !== undefined && row.source_database !== null) {
      assert(String(row.source_database).toUpperCase() === source, `${source}/${label} 明細混入其他來源：${row.source_database}`);
    }
  }
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
let originalSource = '';
try {
  const auditPassword = String(process.env.ERP_AUDIT_PASSWORD || '');
  assert(auditPassword, '請在本機環境變數 ERP_AUDIT_PASSWORD 設定回歸測試帳號密碼');
  const login = await request('/api/auth/login', '', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.ERP_AUDIT_USER || 'admin',
      password: auditPassword
    })
  });
  assert(login.status === 200 && login.body.ok && login.body.data?.token, `登入失敗：${login.body.error || login.status}`);
  token = login.body.data.token;

  const contextResult = await request('/api/company-contexts', token);
  assert(contextResult.status === 200 && contextResult.body.ok, `取得公司上下文失敗：${contextResult.body.error || contextResult.status}`);
  const contexts = (contextResult.body.data || []).filter(row => ['SH', 'SC'].includes(String(row.source_database || '').toUpperCase()));
  assert(contexts.length > 0, '沒有可驗證的 SH／SC 公司上下文');
  originalSource = String(contexts[0].source_database).toUpperCase();

  const checked = [];
  for (const context of contexts) {
    const source = String(context.source_database).toUpperCase();
    const company = String(context.company_id || source);
    await setContext(token, source);
    const headers = contextHeaders(token, source, company);
    const scope = { source_database: source, from_date: '2000-01-01', to_date: '2026-12-31', limit: '20' };

    for (const [label, path] of [
      ['管理維護訂單', '/api/sales-workflow/maintenance/orders'],
      ['客戶資訊查詢', '/api/sales-workflow/maintenance/queries/customer'],
      ['訂單資訊查詢', '/api/sales-workflow/maintenance/queries/order'],
      ['訂單樹狀資訊查詢', '/api/sales-workflow/maintenance/queries/tree'],
      ['客戶商品交易記錄查詢', '/api/sales-workflow/maintenance/queries/customer-transactions']
    ]) {
      const result = await request(`${path}?${encodedQuery(scope)}`, token, { headers });
      assert(result.status === 200 && result.body.ok, `${source}/${label} 失敗：${result.body.error || result.status}`);
      assertScopedRows(result.body.data, source, label);
    }

    const catalogSeed = await request(`/api/sales-workflow/report-center?${encodedQuery({ ...scope, report_key: 'customer-order-statistics', as_of_date: scope.to_date })}`, token, { headers });
    assert(catalogSeed.status === 200 && catalogSeed.body.ok, `${source}/報表中心目錄查詢失敗：${catalogSeed.body.error || catalogSeed.status}`);
    assertScopedRows(catalogSeed.body.data, source, '報表中心目錄');
    assert(Array.isArray(catalogSeed.body.data.catalog) && catalogSeed.body.data.catalog.length > 0, `${source}/報表中心缺少 iSM 報表目錄`);

    const reportResults = [];
    for (const report of catalogSeed.body.data.catalog) {
      const result = await request(`/api/sales-workflow/report-center?${encodedQuery({ ...scope, report_key: report.key, as_of_date: scope.to_date })}`, token, { headers });
      assert(result.status === 200 && result.body.ok, `${source}/${report.key} 報表失敗：${result.body.error || result.status}`);
      const data = result.body.data;
      assertScopedRows(data, source, report.key);
      assert(Array.isArray(data.columns) && data.columns.length > 0, `${source}/${report.key} 缺少欄位定義`);
      assert(Array.isArray(data.source_definitions) && data.source_definitions.length > 0, `${source}/${report.key} 缺少來源定義`);
      if (data.availability === 'planned') assert(data.rows.length === 0, `${source}/${report.key} 尚未完成報表不應有查詢列`);
      reportResults.push({ key: report.key, status: data.status, availability: data.availability, rows: data.rows.length });
    }

    const detail = reportResults.find(row => row.key === 'customer-order-detail');
    assert(detail && detail.availability === 'queryable', `${source}/客戶訂單明細表未可查`);
    if (source === originalSource) assert(detail.rows === 20, `${source}/20 筆銷售資料回歸不足，實際 ${detail.rows} 筆`);

    const pricing = reportResults.find(row => row.key === 'pricing-detail');
    assert(pricing && pricing.availability === 'queryable', `${source}/計價資料明細表未可查`);
    checked.push({ source, company, report_count: reportResults.length, twenty_row_report: detail.rows, pricing_rows: pricing.rows, queryable_reports: reportResults.filter(row => row.availability === 'queryable').length });
  }

  if (contexts.length > 1) {
    const first = contexts[0];
    const second = contexts[1];
    const source = String(first.source_database).toUpperCase();
    const other = String(second.source_database).toUpperCase();
    const company = String(first.company_id || source);
    const otherCompany = String(second.company_id || other);
    await setContext(token, source);
    const cross = await request(`/api/sales-workflow/maintenance/queries/order?${encodedQuery({ source_database: other, limit: '20' })}`, token, { headers: contextHeaders(token, other, otherCompany) });
    assert(cross.status === 409, `管理維護跨公司請求未被拒絕：${cross.status}`);
    const crossReport = await request(`/api/sales-workflow/report-center?${encodedQuery({ source_database: other, report_key: 'customer-order-detail', limit: '20' })}`, token, { headers: contextHeaders(token, other, otherCompany) });
    assert(crossReport.status === 409, `報表中心跨公司請求未被拒絕：${crossReport.status}`);
  }

  console.log(JSON.stringify({
    ok: true,
    base_url: baseUrl,
    scope: 'SAL-G02～G04：管理維護／只讀查詢、計價資料明細、iSM 報表中心',
    read_only: true,
    source_data_written: false,
    checked,
    cross_company_rejected: contexts.length > 1,
    message: '已以目前公司上下文逐一查詢，所有結果上限 20 筆並完成來源隔離檢查。'
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  if (token && originalSource) {
    try { await setContext(token, originalSource); } catch (_) { /* 保留原始錯誤 */ }
  }
  if (token) {
    try { await request('/api/auth/logout', token, { method: 'POST' }); } catch (_) { /* 登出失敗不改變回歸結果 */ }
  }
}
