import 'dotenv/config';

const API = 'http://127.0.0.1:3000/api';
const SOURCES = ['SH', 'SC'];
const G02 = ['progress', 'supplier_expected', 'item_expected', 'manufacturing_expected', 'supplier_delivery'];
const G03 = ['supplier_detail', 'supplier_summary', 'supplier_statistics', 'item_history_detail', 'item_history_summary', 'rejected_open', 'purchase_detail', 'receipt_detail', 'rejected_return_detail', 'return_detail', 'requisition_detail', 'invoice_missing'];
const assert = (value, message) => { if (!value) throw new Error(message); };

async function login() {
  const response = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '12345678' }),
  });
  const result = await response.json();
  if (!response.ok || result.ok === false) throw new Error(result.error || '登入失敗');
  return result.data?.token || result.token;
}

async function switchContext(token, sourceKey) {
  const response = await fetch(`${API}/auth/context`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_key: sourceKey }),
  });
  const result = await response.json();
  if (!response.ok || result.ok === false) throw new Error(result.error || '公司上下文切換失敗');
  return result.data ?? result;
}

async function request(token, path, method = 'GET', body, extraHeaders = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...extraHeaders, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok || result.ok === false) throw new Error(result.error || response.statusText);
  return result.data ?? result;
}

async function expectFailure(action, expectedText) {
  try { await action(); } catch (error) {
    assert(String(error.message).includes(expectedText), `預期錯誤「${expectedText}」，實際「${error.message}」`);
    return;
  }
  throw new Error(`預期請求應被拒絕：${expectedText}`);
}

function checkPayload(payload, source, code, report) {
  assert(payload.source_database === source, `${code}/${report} 公司來源錯誤：${payload.source_database}`);
  assert(payload.company_id, `${code}/${report} 缺少公司別`);
  assert(payload.target_database, `${code}/${report} 缺少目標資料庫`);
  assert(Array.isArray(payload.rows), `${code}/${report} rows 不是陣列`);
  assert(Array.isArray(payload.columns), `${code}/${report} columns 不是陣列`);
  if (report !== 'manufacturing_expected') {
    for (const row of payload.rows.slice(0, 10)) {
      if (row.source_key) assert(String(row.source_key).startsWith('PUR-'), `${code}/${report} 來源鍵格式錯誤`);
      if (row.next_stage === undefined) throw new Error(`${code}/${report} 缺少下一階段欄位`);
    }
  }
}

const token = await login();
const result = { ok: true, sources: {}, checked: { g02: G02, g03: G03, g04: ['maintenance', 'recalculate-preview'] } };
try {
  for (const source of SOURCES) {
    await switchContext(token, source);
    const query = new URLSearchParams({ source_database: source, limit: '50' });
    const summary = { g02: {}, g03: {}, g04: {} };
    for (const report of G02) {
      const payload = await request(token, `/procurement/g02/reports?${new URLSearchParams({ ...Object.fromEntries(query), report })}`);
      checkPayload(payload, source, 'PUR-G02', report);
      if (report === 'manufacturing_expected') assert(payload.data_state === 'not_implemented', '製令預計進貨應明確標示未實作');
      summary.g02[report] = { data_state: payload.data_state, rows: payload.total_count };
    }
    for (const report of G03) {
      const payload = await request(token, `/procurement/g03/reports?${new URLSearchParams({ ...Object.fromEntries(query), report })}`);
      checkPayload(payload, source, 'PUR-G03', report);
      summary.g03[report] = { data_state: payload.data_state, rows: payload.total_count };
    }
    const maintenance = await request(token, `/procurement/g04/maintenance?${query}`);
    assert(maintenance.source_database === source && maintenance.module === 'PUR-G04', `PUR-G04/${source} 上下文錯誤`);
    assert(maintenance.reconciliation?.columns?.length && maintenance.supplier_ratings?.columns?.length && maintenance.exceptions?.columns?.length, `PUR-G04/${source} 欄位定義不完整`);
    assert(maintenance.summary && maintenance.summary.mismatch_count !== undefined, `PUR-G04/${source} 缺少差異摘要`);
    summary.g04.maintenance = { data_state: maintenance.data_state, mismatches: maintenance.summary.mismatch_count, exceptions: maintenance.summary.exception_count };
    const preview = await request(token, '/procurement/g04/recalculate', 'POST', { source_database: source, apply: false, reason: 'PUR-G02~04 regression preview' });
    assert(preview.applied === false && preview.updated_count === undefined, `PUR-G04/${source} 預覽不應寫入資料`);
    summary.g04.recalculate = { preview_count: preview.preview_count, applied: preview.applied };
    result.sources[source] = summary;
  }
  await switchContext(token, 'SH');
  await expectFailure(() => request(token, '/procurement/g02/reports?source_database=SC&report=progress'), '目前登入公司為 SH');
  result.cross_company_rejected = true;
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
}
