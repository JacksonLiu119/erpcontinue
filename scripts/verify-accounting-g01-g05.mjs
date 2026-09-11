import 'dotenv/config';
import mysql from 'mysql2/promise';

const baseUrl = String(process.env.ERP_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const apiBase = `${baseUrl}/api`;
const source = 'SH';
const stamp = String(Date.now());
const marker = `VERIFY:G01G05:${stamp}`;
const codes = {
  parameter: `V_G01_${stamp}`,
  account: `9${stamp}`,
  budget: `V_G03_${stamp}`,
  asset: `FA${stamp}`,
  center: `C${stamp}`,
  allocation: `A${stamp}`
};
const testDate = '2026-08-31';
const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'inventory_erp'
};

const assert = (condition, message, details) => {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
};

async function login() {
  const response = await fetch(`${apiBase}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.ERP_VERIFY_USER || 'admin',
      password: process.env.ERP_VERIFY_PASSWORD || '12345678'
    })
  });
  const payload = await response.json().catch(() => ({}));
  assert(response.ok && payload.ok !== false, `管理員登入失敗：${payload.error || response.status}`);
  return payload.data?.token || payload.token;
}

function makeRequest(token) {
  return async (path, method = 'GET', body, extraHeaders = {}) => {
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-ERP-Context-Key': source,
      'X-Source-Database': source,
      ...extraHeaders
    };
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { error: text }; }
    return { response, payload, data: payload.data ?? payload };
  };
}

async function expectOk(request, path, method = 'GET', body) {
  const result = await request(path, method, body);
  assert(result.response.ok && result.payload.ok !== false, `${method} ${path} 失敗：${result.payload.error || result.response.status}`, result.payload);
  return result.data;
}

async function deleteIds(db, table, column, ids) {
  const list = [...new Set(ids.map(Number).filter(Boolean))];
  if (list.length) await db.query(`DELETE FROM ${table} WHERE ${column} IN (?)`, [list]);
}

async function cleanup(db, ids) {
  // 若 API 在資料庫寫入後回應前中斷，依本次唯一代號／標記補抓殘留 ID，再進行同一套安全清理。
  const [parameterRows] = await db.query('SELECT id FROM accounting_system_parameters WHERE parameter_code=?', [codes.parameter]);
  ids.parameterIds.push(...parameterRows.map(row => Number(row.id)));
  const [accountRows] = await db.query('SELECT id FROM accounting_accounts WHERE account_code=?', [codes.account]);
  ids.accountIds.push(...accountRows.map(row => Number(row.id)));
  const [budgetRows] = await db.query('SELECT id FROM accounting_budgets WHERE budget_code=?', [codes.budget]);
  ids.budgetIds.push(...budgetRows.map(row => Number(row.id)));
  const [assetRows] = await db.query('SELECT id FROM accounting_fixed_assets WHERE asset_no=?', [codes.asset]);
  ids.assetIds.push(...assetRows.map(row => Number(row.id)));
  const [centerRows] = await db.query('SELECT id FROM accounting_profit_centers WHERE center_code=?', [codes.center]);
  ids.centerIds.push(...centerRows.map(row => Number(row.id)));
  const [allocationRows] = await db.query('SELECT id FROM accounting_profit_center_allocations WHERE allocation_code=?', [codes.allocation]);
  ids.allocationIds.push(...allocationRows.map(row => Number(row.id)));
  const assetIds = [...new Set(ids.assetIds.map(Number).filter(Boolean))];
  if (assetIds.length) {
    const [depreciationRows] = await db.query('SELECT id,journal_draft_id FROM accounting_fixed_asset_depreciations WHERE asset_id IN (?)', [assetIds]);
    ids.depreciationIds.push(...depreciationRows.map(row => Number(row.id)));
    ids.draftIds.push(...depreciationRows.map(row => Number(row.journal_draft_id)));
  }
  const depreciationIds = [...new Set(ids.depreciationIds.map(Number).filter(Boolean))];
  if (depreciationIds.length) {
    const [journalRows] = await db.query('SELECT id FROM accounting_journals WHERE source_kind=? AND source_id IN (?)', ['fixed_asset_depreciation', depreciationIds]);
    ids.journalIds.push(...journalRows.map(row => Number(row.id)));
  }

  for (const key of Object.keys(ids)) ids[key] = [...new Set(ids[key].map(Number).filter(Boolean))];
  // 先刪除 G04 折舊產生的正式傳票與底稿，再刪除其來源資產。
  await deleteIds(db, 'accounting_journal_lines', 'journal_id', ids.journalIds);
  await deleteIds(db, 'accounting_journals', 'id', ids.journalIds);
  await deleteIds(db, 'accounting_draft_lines', 'draft_id', ids.draftIds);
  await deleteIds(db, 'accounting_draft_sources', 'draft_id', ids.draftIds);
  await deleteIds(db, 'accounting_draft_events', 'draft_id', ids.draftIds);
  await deleteIds(db, 'accounting_drafts', 'id', ids.draftIds);
  await deleteIds(db, 'accounting_fixed_asset_depreciations', 'id', ids.depreciationIds);
  await deleteIds(db, 'accounting_fixed_asset_events', 'asset_id', ids.assetIds);
  await deleteIds(db, 'accounting_fixed_assets', 'id', ids.assetIds);

  // G05 事件表同時記錄中心與分攤，依 entity_kind 分開移除，避免碰到其他既有資料。
  if (ids.allocationIds.length) await db.query('DELETE FROM accounting_profit_center_events WHERE entity_kind=? AND entity_id IN (?)', ['allocation', ids.allocationIds]);
  if (ids.centerIds.length) await db.query('DELETE FROM accounting_profit_center_events WHERE entity_kind=? AND entity_id IN (?)', ['center', ids.centerIds]);
  await deleteIds(db, 'accounting_profit_center_allocations', 'id', ids.allocationIds);
  await deleteIds(db, 'accounting_profit_centers', 'id', ids.centerIds);

  await deleteIds(db, 'accounting_budget_events', 'budget_id', ids.budgetIds);
  await deleteIds(db, 'accounting_budget_lines', 'budget_id', ids.budgetIds);
  await deleteIds(db, 'accounting_budgets', 'id', ids.budgetIds);

  await deleteIds(db, 'accounting_account_events', 'account_id', ids.accountIds);
  await deleteIds(db, 'accounting_accounts', 'id', ids.accountIds);

  await deleteIds(db, 'accounting_system_parameter_events', 'parameter_id', ids.parameterIds);
  await deleteIds(db, 'accounting_system_parameters', 'id', ids.parameterIds);
}

const ids = {
  parameterIds: [], accountIds: [], budgetIds: [], assetIds: [], depreciationIds: [],
  draftIds: [], journalIds: [], centerIds: [], allocationIds: []
};
const db = await mysql.createConnection(dbConfig);
let token = '';

try {
  token = await login();
  const request = makeRequest(token);

  // 觸發增量 schema 檢查，並確認目前登入上下文確實是 SH。
  await expectOk(request, `/accounting/g01/parameters?source_database=${source}`);
  const contexts = await expectOk(request, '/company-contexts');
  assert(contexts.some(row => String(row.source_database || '').toUpperCase() === source), '找不到 SH 公司上下文');
  await expectOk(request, '/auth/context', 'POST', { source_key: source });

  const parameter = await expectOk(request, '/accounting/g01/parameters', 'POST', {
    source_database: source,
    parameter_code: codes.parameter,
    parameter_name: 'G01 回歸參數',
    data_type: 'number',
    parameter_value: '8',
    effective_from: '2026-01-01',
    effective_to: '2026-12-31',
    note: marker
  });
  ids.parameterIds.push(parameter.id);
  assert(parameter.status === 'draft', 'G01 建立後不是草稿', parameter);
  const parameterApproved = await expectOk(request, `/accounting/g01/parameters/${parameter.id}/approve`, 'POST', { source_database: source });
  assert(parameterApproved.status === 'approved', 'G01 核准失敗', parameterApproved);
  const parameterAudit = await expectOk(request, `/accounting/g01/audit?source_database=${source}`);
  assert(!parameterAudit.issues.some(issue => Number(issue.parameter_id) === Number(parameter.id)), 'G01 參數稽核不應產生本次資料異常', parameterAudit);

  const account = await expectOk(request, '/accounting/g02/accounts', 'POST', {
    source_database: source,
    account_code: codes.account,
    account_name: 'G02 回歸科目',
    account_type: 'expense',
    account_level: 2,
    normal_balance: 'debit',
    is_detail: 1,
    effective_from: '2026-01-01',
    note: marker
  });
  ids.accountIds.push(account.id);
  assert(account.status === 'draft', 'G02 建立後不是草稿', account);
  const accountApproved = await expectOk(request, `/accounting/g02/accounts/${account.id}/approve`, 'POST', { source_database: source });
  assert(accountApproved.status === 'approved', 'G02 核准失敗', accountApproved);
  const accountAudit = await expectOk(request, `/accounting/g02/tree-audit?source_database=${source}`);
  const normalBalanceExpectations = new Map([['2101', 'credit'], ['3201', 'credit'], ['4101', 'credit'], ['5101', 'debit']]);
  for (const [accountCode, expected] of normalBalanceExpectations) {
    const row = accountAudit.rows.find(item => String(item.account_code) === accountCode);
    assert(row && String(row.normal_balance) === expected, `G02 ${accountCode} 正常餘額不正確`, row || accountAudit);
  }
  assert(!accountAudit.issues.some(issue => issue.account_code === codes.account), 'G02 回歸科目稽核不應產生異常', accountAudit);

  const budget = await expectOk(request, '/accounting/g03/budgets', 'POST', {
    source_database: source,
    budget_code: codes.budget,
    budget_name: 'G03 回歸預算',
    fiscal_year: '2026',
    version_name: 'BASE',
    period_count: 12,
    currency_code: 'TWD',
    note: marker,
    lines: [
      { line_no: 1, account_code: '4101', period_no: 8, budget_amount: 1000, note: marker },
      { line_no: 2, account_code: '5101', period_no: 8, budget_amount: 600, note: marker }
    ]
  });
  ids.budgetIds.push(budget.id);
  assert(budget.status === 'draft' && budget.lines.length === 2, 'G03 多行預算建立失敗', budget);
  const budgetApproved = await expectOk(request, `/accounting/g03/budgets/${budget.id}/approve`, 'POST', { source_database: source });
  assert(budgetApproved.status === 'approved', 'G03 核准失敗', budgetApproved);
  const budgetReport = await expectOk(request, `/accounting/g03/report?source_database=${source}&fiscal_year=2026&budget_code=${encodeURIComponent(codes.budget)}`);
  assert(budgetReport.budgets.length === 1 && budgetReport.rows.length === 2, 'G03 報表未正確去重並保留兩行明細', budgetReport);
  const budgetControl = await expectOk(request, `/accounting/g03/control?source_database=${source}&fiscal_year=2026&budget_code=${encodeURIComponent(codes.budget)}`);
  assert(budgetControl.rows.length === 2 && budgetControl.rows.every(row => 'available_amount' in row && 'control_status' in row), 'G03 執行控制欄位不完整', budgetControl);

  const asset = await expectOk(request, '/accounting/g04/assets', 'POST', {
    source_database: source,
    asset_no: codes.asset,
    asset_name: 'G04 回歸固定資產',
    category_code: 'VERIFY',
    account_code: '1501',
    account_name: '累計折舊',
    depreciation_expense_account_code: '5101',
    depreciation_expense_account_name: '銷貨成本',
    original_cost: 1200,
    residual_value: 0,
    useful_life_months: 12,
    acquisition_date: '2026-08-01',
    in_service_date: '2026-08-01',
    currency_code: 'TWD',
    note: marker
  });
  ids.assetIds.push(asset.id);
  assert(asset.status === 'draft', 'G04 建立後不是草稿', asset);
  const assetApproved = await expectOk(request, `/accounting/g04/assets/${asset.id}/approve`, 'POST', { source_database: source });
  assert(assetApproved.status === 'approved', 'G04 固定資產核准失敗', assetApproved);
  const depreciation = await expectOk(request, '/accounting/g04/depreciation', 'POST', {
    source_database: source,
    asset_id: asset.id,
    depreciation_period: '2026-08',
    note: marker
  });
  ids.depreciationIds.push(depreciation.id);
  ids.draftIds.push(depreciation.draft_id);
  assert(depreciation.status === 'draft' && depreciation.draft_id, 'G04 折舊底稿建立失敗', depreciation);
  const depreciationApproved = await expectOk(request, `/accounting/g04/depreciation/${depreciation.id}/approve`, 'POST', { source_database: source });
  assert(depreciationApproved.status === 'approved', 'G04 折舊底稿核准失敗', depreciationApproved);
  const depreciationPosted = await expectOk(request, `/accounting/g04/depreciation/${depreciation.id}/post`, 'POST', { source_database: source });
  ids.journalIds.push(depreciationPosted.journal_id);
  assert(depreciationPosted.status === 'posted' && Number(depreciationPosted.accumulated_depreciation) > 0, 'G04 折舊過帳失敗', depreciationPosted);
  const assetDetail = await expectOk(request, `/accounting/g04/assets/${asset.id}?source_database=${source}`);
  assert(assetDetail.depreciations.some(row => String(row.status) === 'posted'), 'G04 資產卡片未回寫已過帳折舊', assetDetail);
  assert(assetDetail.events.some(row => String(row.event_kind) === 'depreciation_post'), 'G04 資產事件未保留折舊過帳', assetDetail);

  const center = await expectOk(request, '/accounting/g05/centers', 'POST', {
    source_database: source,
    center_code: codes.center,
    center_name: 'G05 回歸利潤中心',
    allocation_basis: 'direct',
    note: marker
  });
  ids.centerIds.push(center.id);
  assert(center.status === 'draft', 'G05 中心建立後不是草稿', center);
  const centerApproved = await expectOk(request, `/accounting/g05/centers/${center.id}/approve`, 'POST', { source_database: source });
  assert(centerApproved.status === 'approved', 'G05 中心核准失敗', centerApproved);
  const allocation = await expectOk(request, '/accounting/g05/allocations', 'POST', {
    source_database: source,
    allocation_code: codes.allocation,
    allocation_name: 'G05 回歸分攤',
    fiscal_year: '2026',
    source_account_code: '5101',
    target_center_code: codes.center,
    allocation_ratio: 1,
    note: marker
  });
  ids.allocationIds.push(allocation.id);
  assert(allocation.status === 'draft', 'G05 分攤建立後不是草稿', allocation);
  const allocationApproved = await expectOk(request, `/accounting/g05/allocations/${allocation.id}/approve`, 'POST', { source_database: source });
  assert(allocationApproved.status === 'approved', 'G05 分攤核准失敗', allocationApproved);
  const profitReport = await expectOk(request, `/accounting/g05/report?source_database=${source}&fiscal_year=2026`);
  assert(Array.isArray(profitReport.centers) && Array.isArray(profitReport.allocations) && Array.isArray(profitReport.rows), 'G05 報表資料結構不完整', profitReport);

  const scAvailable = contexts.some(row => String(row.source_database || '').toUpperCase() === 'SC');
  let crossCompanyRejected = false;
  if (scAvailable) {
    const cross = await request(`/accounting/g01/parameters?source_database=SC`);
    crossCompanyRejected = cross.response.status === 409;
    assert(crossCompanyRejected, `SH 上下文查詢 SC 未被拒絕：${cross.response.status}`, cross.payload);
  }

  console.log(JSON.stringify({
    ok: true,
    source,
    marker,
    modules: ['G01 會計系統參數設定作業', 'G02 會計科目設定作業', 'G03 預算管理', 'G04 固定資產管理系統', 'G05 利潤中心管理'],
    checked: ['G01 參數版本／生效稽核', 'G02 科目樹／正常餘額稽核', 'G03 多行明細／執行控制與版本去重報表', 'G04 折舊底稿→正式傳票→資產回寫／事件', 'G05 分攤比例與報表', 'SH／SC 公司隔離'],
    cross_company_rejected: crossCompanyRejected
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message, details: error.details }, null, 2));
  process.exitCode = 1;
} finally {
  try { await cleanup(db, ids); } catch (error) { console.error(`G01～G05 cleanup failed: ${error.message}`); process.exitCode = 1; }
  if (token) {
    try {
      const response = await fetch(`${apiBase}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
      await response.text();
    } catch (_) { /* 回歸結果不因登出失敗改變 */ }
  }
  await db.end();
}
