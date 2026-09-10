import 'dotenv/config';

const baseUrl = String(process.env.ERP_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

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
    'X-Company-Id': company,
  };
}

async function setContext(token, source) {
  const result = await request('/api/auth/context', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_key: source }),
  });
  assert(result.status === 200 && result.body.ok, `切換 ${source} 失敗：${result.body.error || result.status}`);
  return result.body.data;
}

function queryFor(source, reportKind, overrides = {}) {
  return new URLSearchParams({
    report_kind: reportKind,
    source_database: source,
    from_date: '2020-01-01',
    to_date: '2026-12-31',
    as_of_date: '2026-12-31',
    limit: '20',
    ...overrides,
  }).toString();
}

const requiredColumns = ['salesperson_code', 'invoice_no', 'source_key', 'original_amount', 'settled_amount', 'balance_amount'];
const reportKinds = [
  'statement', 'customer_detail', 'customer_aging', 'salesperson_detail', 'salesperson_aging',
  'salesperson_collection', 'ledger', 'invoice_difference', 'overdue', 'statement_total', 'open',
  'party_relation', 'e_invoice',
];

let token = '';
try {
  const login = await request('/api/auth/login', '', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.ERP_AUDIT_USER || 'admin',
      password: process.env.ERP_AUDIT_PASSWORD || '12345678',
    }),
  });
  assert(login.status === 200 && login.body.ok && login.body.data?.token, `登入失敗：${login.body.error || login.status}`);
  token = login.body.data.token;

  const contextsResult = await request('/api/company-contexts', token);
  assert(contextsResult.status === 200 && contextsResult.body.ok, `取得公司上下文失敗：${contextsResult.body.error || contextsResult.status}`);
  const contexts = (contextsResult.body.data || []).filter(row => ['SH', 'SC'].includes(String(row.source_database || '').toUpperCase()));
  assert(contexts.length > 0, '沒有可驗證的 SH／SC 公司上下文');

  const primary = contexts.find(row => String(row.source_database).toUpperCase() === 'SH') || contexts[0];
  const primarySource = String(primary.source_database).toUpperCase();
  const primaryCompany = String(primary.company_id || primarySource);
  await setContext(token, primarySource);
  const headers = contextHeaders(token, primarySource, primaryCompany);

  let firstStatementRow = null;
  for (const reportKind of reportKinds) {
    const result = await request(`/api/reports/receivable-center?${queryFor(primarySource, reportKind)}`, token, { headers });
    assert(result.status === 200 && result.body.ok, `${primarySource}/${reportKind} 查詢失敗：${result.body.error || result.status}`);
    const data = result.body.data;
    assert(data?.report === 'receivable-center', `${primarySource}/${reportKind} 未回傳集中報表中心識別`);
    assert(data.requested_report === reportKind, `${primarySource}/${reportKind} 回傳報表種類不符`);
    assert(String(data.source_database).toUpperCase() === primarySource, `${primarySource}/${reportKind} 來源資料庫不符`);
    assert(String(data.company?.company_id || '').toUpperCase() === primaryCompany.toUpperCase(), `${primarySource}/${reportKind} 公司別不符`);
    assert(data.meta?.central_report === true, `${primarySource}/${reportKind} 未標示集中報表中心`);
    const columns = (data.columns || []).map(column => column.key);
    for (const column of requiredColumns) assert(columns.includes(column), `${primarySource}/${reportKind} 缺少欄位 ${column}`);
    assert(Array.isArray(data.rows) && data.rows.length <= 20, `${primarySource}/${reportKind} 明細上限未生效`);
    if (reportKind === 'statement' && data.rows[0]) firstStatementRow = data.rows[0];
    if (['customer_aging', 'salesperson_aging', 'overdue', 'open'].includes(reportKind)) {
      for (const row of data.rows) assert(Number(row.balance_amount) > 0, `${primarySource}/${reportKind} 混入無剩餘金額資料`);
    }
    if (reportKind === 'overdue') {
      for (const row of data.rows) assert(Number(row.overdue_days) > 0, `${primarySource}/overdue 混入未逾期資料`);
    }
    if (reportKind !== 'statement_total' && reportKind !== 'party_relation' && data.rows.length) {
      for (const row of data.rows) assert(String(row.source_key || '').startsWith(`${primarySource}:`), `${primarySource}/${reportKind} 缺少同公司來源鍵`);
    }
  }

  if (firstStatementRow?.salesperson_code) {
    const salesperson = String(firstStatementRow.salesperson_code).split('、')[0];
    const filtered = await request(`/api/reports/receivable-center?${queryFor(primarySource, 'salesperson_detail', { salesperson_code: salesperson })}`, token, { headers });
    assert(filtered.status === 200 && filtered.body.ok, `${primarySource}/salesperson_code 篩選失敗`);
    for (const row of filtered.body.data.rows || []) assert(String(row.salesperson_code).split('、').includes(salesperson), '業務員維度篩選未生效');
  }

  const invoiceDifference = await request(`/api/reports/receivable-center?${queryFor(primarySource, 'invoice_difference')}`, token, { headers });
  assert(invoiceDifference.status === 200 && invoiceDifference.body.ok, `${primarySource}/invoice_difference 查詢失敗`);
  assert(invoiceDifference.body.data.requested_report_label === '銷貨發票差異明細表', '發票差異報表名稱不符');

  const impossible = await request(`/api/reports/receivable-center?${queryFor(primarySource, 'statement', { source_key: '__NO_SUCH_SOURCE_KEY__' })}`, token, { headers });
  assert(impossible.status === 200 && impossible.body.ok && impossible.body.data.rows.length === 0, '來源鍵無結果篩選未生效');

  const alternate = contexts.find(row => String(row.source_database).toUpperCase() !== primarySource);
  if (alternate) {
    const alternateSource = String(alternate.source_database).toUpperCase();
    const alternateCompany = String(alternate.company_id || alternateSource);
    const crossCompany = await request(`/api/reports/receivable-center?${queryFor(alternateSource, 'statement')}`, token, {
      headers: contextHeaders(token, alternateSource, alternateCompany),
    });
    assert(crossCompany.status === 409, `跨公司應收報表請求未被拒絕：${crossCompany.status}`);
  }

  console.log(`Receivable report verification passed for ${primarySource}${alternate ? `; cross-company isolation checked against ${String(alternate.source_database).toUpperCase()}` : ''}.`);
} catch (error) {
  console.error(`Receivable report verification failed: ${error.message}`);
  process.exitCode = 1;
}
