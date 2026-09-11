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

function query(values) {
  return new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== '')).toString();
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

const expectedCodes = new Set([
  'ORDER_STATUS', 'ORDER_ITEMS', 'DELIVERED_QUANTITY', 'DOWNSTREAM_DOCUMENTS',
  'DELIVERY_SCHEDULES', 'PICK_LISTS', 'PROCUREMENT_DEMANDS', 'PENDING_CHANGES',
  'FINANCE_LINKS', 'CREDIT_APPROVALS', 'ACCOUNTING_PERIOD', 'DEPARTMENT_SCOPE'
]);

let token = '';
let originalSource = '';
try {
  const password = String(process.env.ERP_AUDIT_PASSWORD || '');
  assert(password, '請在本機環境變數 ERP_AUDIT_PASSWORD 設定回歸測試帳號密碼');
  const login = await request('/api/auth/login', '', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.ERP_AUDIT_USER || 'admin', password })
  });
  assert(login.status === 200 && login.body.ok && login.body.data?.token, `登入失敗：${login.body.error || login.status}`);
  token = login.body.data.token;

  const contextResult = await request('/api/company-contexts', token);
  assert(contextResult.status === 200 && contextResult.body.ok, `取得公司上下文失敗：${contextResult.body.error || contextResult.status}`);
  const contexts = (contextResult.body.data || []).filter(row => row.source_database);
  assert(contexts.length > 0, '沒有可驗證的公司上下文');
  originalSource = String(contexts[0].source_database).toUpperCase();

  const checked = [];
  for (const context of contexts) {
    const source = String(context.source_database).toUpperCase();
    const company = String(context.company_id || source);
    await setContext(token, source);
    const headers = contextHeaders(token, source, company);
    const ordersResult = await request(`/api/sales-workflow/maintenance/orders?${query({ source_database: source, from_date: '2000-01-01', to_date: '2099-12-31', limit: '2000' })}`, token, { headers });
    assert(ordersResult.status === 200 && ordersResult.body.ok, `${source}/訂單清單失敗：${ordersResult.body.error || ordersResult.status}`);
    const data = ordersResult.body.data;
    assert(data.source_database === source, `${source}/訂單清單來源不符：${data.source_database}`);
    const orderRows = Array.isArray(data.rows) ? data.rows : [];
    const orderIds = [...new Map(orderRows.map(row => [Number(row.order_id), row]).filter(([id]) => Number.isInteger(id) && id > 0)).values()];
    const previews = [];
    for (const row of orderIds.slice(0, 20)) {
      const previewResult = await request(`/api/sales-workflow/maintenance/orders/${row.order_id}/archive-check?${query({ source_database: source, archive_date: '2026-09-11' })}`, token, { headers });
      assert(previewResult.status === 200 && previewResult.body.ok, `${source}/訂單 ${row.order_id} 封存預覽失敗：${previewResult.body.error || previewResult.status}`);
      const preview = previewResult.body.data;
      assert(preview.source_database === source && preview.company_id === company, `${source}/訂單 ${row.order_id} 預覽公司上下文不符`);
      assert(typeof preview.can_archive === 'boolean', `${source}/訂單 ${row.order_id} 缺少 can_archive`);
      assert(Array.isArray(preview.checks), `${source}/訂單 ${row.order_id} 缺少 checks`);
      const codes = new Set(preview.checks.map(check => check.code));
      for (const code of expectedCodes) assert(codes.has(code), `${source}/訂單 ${row.order_id} 缺少檢核項目 ${code}`);
      previews.push({ order_id: row.order_id, status: preview.status, can_archive: preview.can_archive, blocking_count: (preview.blocking_reasons || []).length });
    }

    const blocked = previews.find(row => !row.can_archive);
    if (blocked) {
      const rejected = await request(`/api/sales-workflow/maintenance/orders/${blocked.order_id}/archive`, token, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_database: source, archive_date: '2026-09-11', reason: 'SAL-G02-R1 回歸測試：應拒絕的既有下游關聯訂單' })
      });
      assert(rejected.status === 400, `${source}/訂單 ${blocked.order_id} 未拒絕不符合封存條件的請求：${rejected.status}`);
    }
    checked.push({ source, company, order_count: orderRows.length, inspected_orders: previews.length, blocked_preview_count: previews.filter(row => !row.can_archive).length, write_attempted: Boolean(blocked), write_succeeded: false });
  }

  if (contexts.length > 1) {
    const first = contexts[0];
    const second = contexts[1];
    const firstSource = String(first.source_database).toUpperCase();
    const secondSource = String(second.source_database).toUpperCase();
    await setContext(token, firstSource);
    const cross = await request(`/api/sales-workflow/maintenance/orders/1/archive-check?${query({ source_database: secondSource, archive_date: '2026-09-11' })}`, token, {
      headers: contextHeaders(token, firstSource, String(first.company_id || firstSource))
    });
    assert(cross.status === 409, `跨公司封存預覽未被拒絕：${cross.status}`);
  }

  console.log(JSON.stringify({
    ok: true,
    base_url: baseUrl,
    scope: 'SAL-G02-R1 受控作廢／封存預覽、下游關聯攔截、公司隔離',
    read_only: true,
    source_data_written: false,
    checked,
    cross_company_rejected: contexts.length > 1,
    message: '已逐家公司預覽最多 20 張既有訂單；僅對不符合條件的訂單測試拒絕，不執行任何成功封存。'
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
