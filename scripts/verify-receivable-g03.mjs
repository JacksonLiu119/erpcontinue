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

const requiredChecks = new Set([
  'COMPANY_CONTEXT', 'SOURCE_READ_ONLY', 'AR_FORMULA', 'GL_AR_RECONCILIATION',
  'UNALLOCATED_SETTLEMENT', 'ORPHAN_OPEN_ITEM', 'DRAFT_VOUCHER', 'PENDING_RETURN',
  'AR_CONTROL_ACCOUNT', 'ACCOUNTING_PERIOD', 'MONTH_CLOSING_SNAPSHOT'
]);

let token = '';
let originalSource = '';
try {
  const password = String(process.env.ERP_AUDIT_PASSWORD || '12345678');
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
    const filters = { source_database: source, from_date: '2000-01-01', to_date: '2099-12-31', as_of_date: '2099-12-31', limit: '100' };

    const overviewResult = await request(`/api/finance-workflow/ar-g03/overview?${query(filters)}`, token, { headers });
    assert(overviewResult.status === 200 && overviewResult.body.ok, `${source}/AR-G03 應收總覽失敗：${overviewResult.body.error || overviewResult.status}`);
    const overview = overviewResult.body.data;
    assert(String(overview.source_database).toUpperCase() === source, `${source}/AR-G03 來源資料庫不符`);
    assert(String(overview.company?.company_id || '').toUpperCase() === company.toUpperCase(), `${source}/AR-G03 公司別不符`);
    assert(overview.calculation_mode === 'read_only_on_demand', `${source}/AR-G03 未標示唯讀即時計算`);
    assert(Array.isArray(overview.monthly) && Array.isArray(overview.rows) && Array.isArray(overview.checks), `${source}/AR-G03 回傳結構不完整`);
    const checkCodes = new Set(overview.checks.map(item => item.code));
    for (const code of requiredChecks) assert(checkCodes.has(code), `${source}/AR-G03 缺少檢核 ${code}`);

    const recalculateResult = await request('/api/finance-workflow/ar-g03/recalculate', token, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(filters)
    });
    assert(recalculateResult.status === 200 && recalculateResult.body.ok, `${source}/AR-G03 重算預覽失敗：${recalculateResult.body.error || recalculateResult.status}`);
    assert(recalculateResult.body.data?.operation === 'recalculate_preview', `${source}/AR-G03 重算預覽不是唯讀操作`);
    assert(Number(recalculateResult.body.data?.summary?.open_item_count || 0) === Number(overview.summary?.open_item_count || 0), `${source}/AR-G03 重算前後帳款筆數不一致`);

    const period = new Date().toISOString().slice(0, 7);
    const closeResult = await request(`/api/finance-workflow/ar-g03/month-close-check?${query({ source_database: source, period_code: period, close_date: `${period}-${new Date().getUTCDate().toString().padStart(2, '0')}` })}`, token, { headers });
    assert(closeResult.status === 200 && closeResult.body.ok, `${source}/AR-G03 月底前置檢核失敗：${closeResult.body.error || closeResult.status}`);
    assert(Array.isArray(closeResult.body.data?.checks) && typeof closeResult.body.data?.can_build_existing_snapshot === 'boolean', `${source}/AR-G03 月底前置檢核回傳不完整`);

    const candidatesResult = await request(`/api/finance-workflow/ar-g03/archive-candidates?${query({ source_database: source, limit: 20 })}`, token, { headers });
    assert(candidatesResult.status === 200 && candidatesResult.body.ok, `${source}/AR-G03 封存候選清單失敗：${candidatesResult.body.error || candidatesResult.status}`);
    const candidates = candidatesResult.body.data?.rows || [];
    const previews = [];
    for (const candidate of candidates.slice(0, 20)) {
      const previewResult = await request(`/api/finance-workflow/ar-g03/vouchers/${candidate.id}/archive-check?${query({ source_database: source })}`, token, { headers });
      assert(previewResult.status === 200 && previewResult.body.ok, `${source}/憑單 ${candidate.id} 封存檢核失敗：${previewResult.body.error || previewResult.status}`);
      const preview = previewResult.body.data;
      assert(typeof preview.can_archive === 'boolean' && Array.isArray(preview.checks), `${source}/憑單 ${candidate.id} 封存檢核結構不完整`);
      previews.push({ id: candidate.id, voucher_no: candidate.voucher_no, can_archive: preview.can_archive, blocked_count: preview.checks.filter(item => item.status === 'blocked').length });
    }
    const blocked = previews.find(item => !item.can_archive);
    if (blocked) {
      const rejected = await request(`/api/finance-workflow/ar-g03/vouchers/${blocked.id}/archive?${query({ source_database: source })}`, token, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_database: source, archive_date: new Date().toISOString().slice(0, 10), reason: 'AR-G03 回歸測試：應由下游關聯／期間／發票檢核拒絕' })
      });
      assert(rejected.status === 400, `${source}/憑單 ${blocked.id} 不符合封存條件卻未被拒絕：${rejected.status}`);
    }
    checked.push({ source, company, open_item_count: Number(overview.summary?.open_item_count || 0), monthly_count: overview.monthly.length, check_count: overview.checks.length, archive_candidates: candidates.length, archive_previews: previews.length, blocked_archive_count: previews.filter(item => !item.can_archive).length, write_succeeded: false });
  }

  if (contexts.length > 1) {
    const first = contexts[0];
    const second = contexts[1];
    const firstSource = String(first.source_database).toUpperCase();
    const secondSource = String(second.source_database).toUpperCase();
    await setContext(token, firstSource);
    const cross = await request(`/api/finance-workflow/ar-g03/overview?${query({ source_database: secondSource, from_date: '2000-01-01', to_date: '2099-12-31', as_of_date: '2099-12-31' })}`, token, {
      headers: contextHeaders(token, firstSource, String(first.company_id || firstSource))
    });
    assert(cross.status === 409, `AR-G03 跨公司查詢未被拒絕：${cross.status}`);
  }

  console.log(JSON.stringify({
    ok: true,
    base_url: baseUrl,
    scope: 'AR-G03 應收單據清除替代、月統計重算、子帳／1101 總帳核對、月底前置與公司隔離',
    read_only: true,
    source_data_written: false,
    checked,
    cross_company_rejected: contexts.length > 1,
    message: '已逐家公司完成唯讀總覽、重算預覽、月底條件與封存檢核；只對阻擋型候選測試拒絕，不執行成功封存。'
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

