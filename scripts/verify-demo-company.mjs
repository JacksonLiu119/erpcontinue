import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const baseUrl = String(process.env.ERP_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const username = process.env.DEMO_FINANCE_USERNAME || 'demo_finance_admin';
const password = process.env.DEMO_FINANCE_PASSWORD || '';
const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'inventory_erp',
};

const expectedPermissions = [
  'accounting-auto-rules', 'accounting-clearing', 'accounting-drafts', 'accounting-general-ledger',
  'accounting-opening-balances', 'accounting-periods', 'accounting-year-close', 'finance-workflow',
];

const coreTables = [
  'erp_customers', 'erp_suppliers', 'erp_items', 'erp_warehouses',
  'sales_documents', 'sales_document_items',
  'procurement_orders', 'procurement_order_items', 'procurement_receipts', 'procurement_receipt_items',
  'finance_open_items', 'finance_settlements', 'accounting_journals', 'accounting_journal_lines',
];

function assert(condition, message, details = undefined) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

function qi(value) {
  return `\`${String(value).replaceAll('`', '``')}\``;
}

async function request(path, token = '', options = {}) {
  const headers = new Headers(options.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function contextHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'X-ERP-Context-Key': 'DEMO',
    'X-Source-Database': 'DEMO',
    'X-Company-Id': 'DEMO',
  };
}

async function login() {
  assert(password, '請以 DEMO_FINANCE_PASSWORD 提供 Demo 管理者密碼後再驗證。');
  const result = await request('/api/auth/login', '', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert(result.status === 200 && result.body.ok && result.body.data?.token, `Demo 管理者登入失敗：${result.body.error || result.status}`);
  return result.body.data;
}

async function verifyData(db) {
  const [tables] = await db.query(`SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'`);
  assert(tables.length === 152, `Demo 目標表數量不符，實際 ${tables.length}`);
  const tableNames = tables.map(row => row.TABLE_NAME);
  const [columnRows] = await db.query(`SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.columns WHERE TABLE_SCHEMA=DATABASE()`);
  const byTable = new Map();
  for (const row of columnRows) byTable.set(row.TABLE_NAME, [...(byTable.get(row.TABLE_NAME) || []), row.COLUMN_NAME]);
  const contextViolations = [];
  for (const [table, columns] of byTable) {
    const predicates = [];
    if (columns.includes('source_database')) predicates.push(`${qi('source_database')}<>'DEMO'`);
    if (columns.includes('tenant_id')) predicates.push(`${qi('tenant_id')}<>'DEMO'`);
    if (columns.includes('company_id')) predicates.push(`${qi('company_id')}<>'DEMO'`);
    if (columns.includes('source_system')) predicates.push(`${qi('source_system')}<>'iSM'`);
    if (!predicates.length) continue;
    const [[row]] = await db.query(`SELECT COUNT(*) AS n FROM ${qi(table)} WHERE ${predicates.join(' OR ')}`);
    if (Number(row.n) > 0) contextViolations.push({ table, count: Number(row.n) });
  }
  assert(!contextViolations.length, 'Demo 內存在非 DEMO 公司上下文資料', contextViolations);

  const counts = {};
  for (const table of coreTables) {
    const [[row]] = await db.query(`SELECT COUNT(*) AS n FROM ${qi(table)}`);
    counts[table] = Number(row.n);
    assert(counts[table] > 0, `Demo 核心資料表 ${table} 沒有資料`);
  }
  const expectedSums = {
    erp_customers: ['inventory_erp', 'inventory_erp_sc'],
    erp_suppliers: ['inventory_erp', 'inventory_erp_sc'],
    erp_items: ['inventory_erp', 'inventory_erp_sc'],
    erp_warehouses: ['inventory_erp', 'inventory_erp_sc'],
    sales_documents: ['inventory_erp', 'inventory_erp_sc'],
    sales_document_items: ['inventory_erp', 'inventory_erp_sc'],
    procurement_orders: ['inventory_erp', 'inventory_erp_sc'],
    procurement_order_items: ['inventory_erp', 'inventory_erp_sc'],
    procurement_receipts: ['inventory_erp', 'inventory_erp_sc'],
    procurement_receipt_items: ['inventory_erp', 'inventory_erp_sc'],
    finance_open_items: ['inventory_erp', 'inventory_erp_sc'],
    finance_settlements: ['inventory_erp', 'inventory_erp_sc'],
    accounting_journals: ['inventory_erp', 'inventory_erp_sc'],
    accounting_journal_lines: ['inventory_erp', 'inventory_erp_sc'],
  };
  const sourceConn = await mysql.createConnection(dbConfig);
  for (const [table, databases] of Object.entries(expectedSums)) {
    let expected = 0;
    for (const sourceDb of databases) {
      const [[row]] = await sourceConn.query(`SELECT COUNT(*) AS n FROM ${qi(sourceDb)}.${qi(table)}`);
      expected += Number(row.n);
    }
    assert(counts[table] === expected, `${table} 匯入筆數不符：Demo=${counts[table]}、SH+SC=${expected}`);
  }
  const [[company]] = await db.query(`SELECT company_code,company_name,source_database,tenant_id,company_id FROM erp_companies WHERE source_database='DEMO' LIMIT 1`);
  assert(company && company.company_name === 'Demo公司' && company.company_code === 'DEMO', 'Demo 公司主檔不存在或未去識別化');

  const sourceNames = new Set();
  for (const sourceDb of ['inventory_erp', 'inventory_erp_sc']) {
    const [rows] = await sourceConn.query(`SELECT customer_name FROM ${qi(sourceDb)}.erp_customers WHERE customer_name IS NOT NULL AND customer_name<>''`);
    for (const row of rows) sourceNames.add(String(row.customer_name));
  }
  const [demoCustomers] = await db.query(`SELECT customer_name,short_name,contact_name FROM erp_customers`);
  assert(demoCustomers.length > 0, 'Demo 客戶主檔沒有資料');
  const leakedNames = demoCustomers.filter(row => sourceNames.has(String(row.customer_name)) || sourceNames.has(String(row.short_name)) || sourceNames.has(String(row.contact_name)));
  assert(!leakedNames.length, 'Demo 客戶名稱仍含原始客戶名稱', leakedNames.slice(0, 5));
  assert(demoCustomers.every(row => String(row.customer_name).startsWith('Demo客戶')), 'Demo 客戶顯示名稱未全部標準化');

  const [sourceDatabaseColumns] = await sourceConn.query(`SELECT TABLE_SCHEMA,TABLE_NAME FROM information_schema.columns WHERE TABLE_SCHEMA IN ('inventory_erp','inventory_erp_sc') AND COLUMN_NAME='source_database' GROUP BY TABLE_SCHEMA,TABLE_NAME`);
  const sourceLeaks = [];
  for (const row of sourceDatabaseColumns) {
    const [[count]] = await sourceConn.query(`SELECT COUNT(*) AS n FROM ${qi(row.TABLE_SCHEMA)}.${qi(row.TABLE_NAME)} WHERE source_database='DEMO'`);
    if (Number(count.n)) sourceLeaks.push({ database: row.TABLE_SCHEMA, table: row.TABLE_NAME, count: Number(count.n) });
  }
  assert(!sourceLeaks.length, 'SH／SC 原資料庫出現 DEMO 寫入痕跡', sourceLeaks);

  const [fkRows] = await db.query(`SELECT TABLE_NAME,COLUMN_NAME,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`);
  const orphanRows = [];
  for (const fk of fkRows) {
    const [[row]] = await db.query(`SELECT COUNT(*) AS n FROM ${qi(fk.TABLE_NAME)} child LEFT JOIN ${qi(fk.REFERENCED_TABLE_NAME)} parent ON child.${qi(fk.COLUMN_NAME)}=parent.${qi(fk.REFERENCED_COLUMN_NAME)} WHERE child.${qi(fk.COLUMN_NAME)} IS NOT NULL AND parent.${qi(fk.REFERENCED_COLUMN_NAME)} IS NULL`);
    if (Number(row.n)) orphanRows.push({ table: fk.TABLE_NAME, column: fk.COLUMN_NAME, referenced: fk.REFERENCED_TABLE_NAME, count: Number(row.n) });
  }
  assert(!orphanRows.length, 'Demo 存在外鍵孤兒資料', orphanRows);
  await sourceConn.end();
  return { table_count: tables.length, counts };
}

let db;
let token = '';
try {
  db = await mysql.createConnection({ ...dbConfig, database: 'inventory_erp_demo' });
  const user = await login();
  token = user.token;
  const me = await request('/api/auth/me', token);
  assert(me.status === 200 && me.body.ok && String(me.body.data?.current_source_key).toUpperCase() === 'DEMO', '登入後目前公司不是 Demo');

  const contexts = await request('/api/company-contexts', token);
  assert(contexts.status === 200 && contexts.body.ok, `Demo 公司上下文查詢失敗：${contexts.body.error || contexts.status}`);
  const contextRows = contexts.body.data || [];
  assert(contextRows.length === 1 && String(contextRows[0].source_database).toUpperCase() === 'DEMO' && contextRows[0].company_name === 'Demo公司', '受限帳號可見的公司範圍不正確', contextRows);

  const access = await request('/api/auth/access', token);
  assert(access.status === 200 && access.body.ok && access.body.data?.is_admin === false, 'Demo 帳號不應具有全域 ADMIN 權限');
  const permissionCodes = (access.body.data.permissions || []).filter(row => Number(row.can_view)).map(row => row.feature_code).sort();
  assert(JSON.stringify(permissionCodes) === JSON.stringify([...expectedPermissions].sort()), 'Demo 帳號權限不是四個模組的完整受限集合', permissionCodes);
  assert(JSON.stringify((access.body.data.allowed_sources || []).map(String).sort()) === JSON.stringify(['DEMO']), 'Demo 帳號公司範圍不正確', access.body.data.allowed_sources);

  const allowedPaths = [
    '/api/finance-workflow/open-items?source_database=DEMO&account_type=AR&limit=1',
    '/api/accounting/auto-rules?source_database=DEMO',
    '/api/accounting/drafts?source_database=DEMO',
    '/api/accounting/journals?source_database=DEMO',
  ];
  const allowedResults = [];
  for (const path of allowedPaths) {
    const result = await request(path, token, { headers: contextHeaders(token) });
    assert(result.status === 200 && result.body.ok, `授權作業查詢失敗 ${path}：${result.body.error || result.status}`);
    allowedResults.push({ path, status: result.status });
  }
  const denied = await request('/api/procurement/open-orders?source_database=DEMO', token, { headers: contextHeaders(token) });
  assert(denied.status === 403, `未授權採購模組未被拒絕，回應 ${denied.status}`);
  const deniedSources = [];
  for (const source of ['SH', 'SC']) {
    const result = await request('/api/auth/context', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_key: source }),
    });
    assert(result.status === 403, `Demo 帳號可切換至 ${source}，回應 ${result.status}`);
    deniedSources.push({ source, status: result.status });
  }
  const sourceList = await request('/api/source-databases', token);
  assert(sourceList.status === 200 && sourceList.body.ok && sourceList.body.data.length === 1 && sourceList.body.data[0].key === 'DEMO', '來源清單未限制為 Demo');

  const data = await verifyData(db);
  console.log(JSON.stringify({
    ok: true,
    base_url: baseUrl,
    login: { username, current_source_key: 'DEMO', company: 'Demo公司' },
    allowed_modules: ['應收', '應付', '自動分錄', '會計總帳'],
    allowed_requests: allowedResults,
    rejected: { procurement: denied.status, cross_company: deniedSources },
    data,
    message: 'Demo 公司資料、客戶去識別化、SH／SC 原庫隔離、公司範圍與模組權限驗證通過。',
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message, details: error.details }, null, 2));
  process.exitCode = 1;
} finally {
  if (token) {
    try { await request('/api/auth/logout', token, { method: 'POST' }); } catch (_) { /* 保留原始驗證結果 */ }
  }
  if (db) await db.end().catch(() => {});
}
