import 'dotenv/config';
import mysql from 'mysql2/promise';

const API = 'http://127.0.0.1:3000/api';
const DATE = '2026-08-26';
const MARKER = 'R02:DOCUMENT-NATURE-ROUTING:20260826';
const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || 'inventory_erp',
};

function assert(value, message) { if (!value) throw new Error(message); }
async function login() {
  const response = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: '12345678' }) });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) throw new Error(payload.error || '登入失敗');
  return payload.data.token;
}
async function switchContext(token, sourceKey) {
  const response = await fetch(`${API}/auth/context`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_key: sourceKey }),
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) throw new Error(payload.error || '公司上下文切換失敗');
  return payload.data ?? payload;
}
function request(token, path, method = 'GET', body) {
  return fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    .then(async response => { const payload = await response.json(); if (!response.ok || payload.ok === false) { const error = new Error(payload.error || response.statusText); error.status = response.status; throw error; } return payload.data ?? payload; });
}
async function expectFailure(action, expected) {
  try { await action(); } catch (error) { assert(String(error.message).includes(expected), `預期錯誤「${expected}」，實際為「${error.message}」`); return; }
  throw new Error(`預期失敗但成功：${expected}`);
}
function nature(source, module, kind, type, extra = {}) {
  return { source_database: source, module_code: module, document_kind: kind, nature_code: type.slice(-4), type_code: type, type_name: `${source} ${kind} R02`, number_prefix: type, numbering_method: 'daily', year_digits: 4, serial_digits: 3, requires_approval: 1, auto_confirm: 0, direct_settlement: 0, settlement_mode: 'batch', require_source_document: 0, source_document_kind: '', inventory_effect: 'none', is_default: 0, is_active: 1, note: MARKER, ...extra };
}
async function cleanup(db) {
  const [sales] = await db.query('SELECT id FROM sales_documents WHERE note=?', [MARKER]);
  const [orders] = await db.query('SELECT id FROM procurement_orders WHERE note=?', [MARKER]);
  const [reqs] = await db.query('SELECT id FROM procurement_requisitions WHERE note=?', [MARKER]);
  const ids = rows => rows.map(row => row.id);
  await db.beginTransaction();
  try {
    if (ids(sales).length) await db.query('DELETE FROM sales_documents WHERE id IN (?)', [ids(sales)]);
    if (ids(orders).length) await db.query('DELETE FROM procurement_orders WHERE id IN (?)', [ids(orders)]);
    if (ids(reqs).length) await db.query('DELETE FROM procurement_requisitions WHERE id IN (?)', [ids(reqs)]);
    await db.query('DELETE FROM erp_document_natures WHERE note=?', [MARKER]);
    await db.query('DELETE FROM procurement_document_types WHERE note=?', [MARKER]);
    await db.query('DELETE FROM sales_document_types WHERE note=?', [MARKER]);
    await db.commit();
  } catch (error) { await db.rollback(); throw error; }
}

async function verifyCompany(token, db, source, otherSource) {
  await switchContext(token, source);
  const suffix = source === 'SH' ? 'H' : 'C';
  const types = { rq: `R02${suffix}RQ`, po: `R02${suffix}PO`, qt: `R02${suffix}QT`, so: `R02${suffix}SO`, sa: `R02${suffix}SA` };
  for (const payload of [
    nature(source, 'PUR', 'requisition', types.rq),
    nature(source, 'PUR', 'purchase_order', types.po, { require_source_document: 1, source_document_kind: 'requisition' }),
    nature(source, 'SAL', 'quotation', types.qt),
    nature(source, 'SAL', 'sales_order', types.so, { require_source_document: 1, source_document_kind: 'quotation' }),
    nature(source, 'SAL', 'shipment', types.sa, { require_source_document: 1, source_document_kind: 'sales_order', direct_settlement: 1, settlement_mode: 'per_document' }),
  ]) await request(token, '/document-natures', 'POST', payload);

  const [[warehouseRow]] = await db.query('SELECT warehouse_code FROM erp_warehouses WHERE source_database=? ORDER BY warehouse_code LIMIT 1', [source]);
  const warehouse = warehouseRow?.warehouse_code || '101';
  await expectFailure(() => request(token, '/procurement/requisitions', 'POST', { source_database: source, document_type: `${types.rq}X`, requisition_date: DATE, item_code: 'R02-ITEM', qty_requested: 1 }), '有效的請購單別');

  const requisition = await request(token, '/procurement/requisitions', 'POST', { source_database: source, document_type: types.rq, requisition_date: DATE, requester_code: 'R02', warehouse_code: warehouse, item_code: 'R02-ITEM', item_name: 'R02 採購驗證品', qty_requested: 2, note: MARKER });
  await request(token, `/procurement/documents/requisitions/${requisition.id}/approve`, 'POST', { source_database: source });
  const reqLine = (await request(token, `/procurement/requisition-maintenance?source_database=${source}`)).find(row => row.requisition_no === requisition.documentNo);
  assert(reqLine, `${source} 找不到請購明細`);
  await request(token, `/procurement/requisition-lines/${reqLine.id}/maintenance`, 'PUT', { source_database: source, suggested_supplier_code: 'R02-SUPP', suggested_unit_price: 10, required_date: DATE, purchase_locked: 1, note: MARKER });
  if (otherSource) await expectFailure(() => request(token, `/procurement/requisition-lines/${reqLine.id}/convert`, 'POST', { source_database: source, document_type: `R02${otherSource === 'SH' ? 'H' : 'C'}PO`, order_date: DATE, supplier_code: 'R02-SUPP', unit_price: 10 }), '採購單別');
  const purchase = await request(token, `/procurement/requisition-lines/${reqLine.id}/convert`, 'POST', { source_database: source, document_type: types.po, order_date: DATE, supplier_code: 'R02-SUPP', unit_price: 10, note: MARKER });
  assert(purchase.document_no.startsWith(`${types.po}20260826`), `${source} 採購單號未依單別規則編號：${purchase.document_no}`);
  await request(token, `/procurement/documents/orders/${purchase.id}/approve`, 'POST', { source_database: source });

  await expectFailure(() => request(token, '/sales-workflow/documents', 'POST', { source_database: source, document_kind: 'sales_order', document_type: types.so, document_date: DATE, customer_code: 'R02-CUST', item_code: 'R02-ITEM', quantity: 1 }), '必須帶入前置單據');
  const quote = await request(token, '/sales-workflow/documents', 'POST', { source_database: source, document_kind: 'quotation', document_type: types.qt, document_date: DATE, customer_code: 'R02-CUST', warehouse_code: warehouse, item_code: 'R02-ITEM', item_name: 'R02 銷售驗證品', unit: 'PCS', quantity: 1, unit_price: 20, note: MARKER });
  await request(token, `/sales-workflow/documents/${quote.id}/approve`, 'POST', { source_database: source });
  const order = await request(token, `/sales-workflow/items/${quote.item_id}/convert`, 'POST', { source_database: source, document_type: types.so, document_date: DATE, warehouse_code: warehouse, quantity: 1 });
  assert(order.document_no.startsWith(`${types.so}20260826`), `${source} 訂單單號未依單別規則編號：${order.document_no}`);
  await request(token, `/sales-workflow/documents/${order.id}/approve`, 'POST', { source_database: source });
  const shipment = await request(token, `/sales-workflow/items/${order.item_id}/convert`, 'POST', { source_database: source, document_type: types.sa, document_date: DATE, warehouse_code: warehouse, quantity: 1 });
  assert(shipment.document_no.startsWith(`${types.sa}20260826`), `${source} 銷貨單號未依單別規則編號：${shipment.document_no}`);
  return { source, purchase_no: purchase.document_no, order_no: order.document_no, shipment_no: shipment.document_no };
}

async function main() {
  const db = await mysql.createConnection(dbConfig);
  try {
    await cleanup(db);
    const token = await login();
    const sh = await verifyCompany(token, db, 'SH', 'SC');
    const sc = await verifyCompany(token, db, 'SC', 'SH');
    console.log(JSON.stringify({ ok: true, sh, sc, checked: ['company isolation', 'selected conversion type', 'source rule', 'approval rule', 'configured numbering'] }, null, 2));
  } finally { await cleanup(db); await db.end(); }
}
main().catch(error => { console.error(JSON.stringify({ ok: false, error: error.message }, null, 2)); process.exitCode = 1; });
