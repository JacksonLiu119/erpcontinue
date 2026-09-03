import 'dotenv/config';
import mysql from 'mysql2/promise';

const SOURCE = 'SC';
const TARGET_DB = 'inventory_erp_sc';
const DATE = '2026-08-19';
const ITEM = 'DEMO-20260819-01';
const CUSTOMER = 'DEMO-CUST';
const SUPPLIER = 'DEMO-SUPP';
const MARKER = `ERP_OPERATION_GUIDE:${ITEM}`;
const PURCHASE_QTY = 10;
const SALE_QTY = 6;
const COST = 80;
const PRICE = 120;

const common = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
};
const control = await mysql.createConnection({ ...common, database: process.env.DB_NAME || 'inventory_erp' });
const db = await mysql.createConnection({ ...common, database: TARGET_DB });
const base = 'http://127.0.0.1:3000/api';

async function api(path, method = 'GET', body) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Source-Database': SOURCE,
    'X-Company-Id': SOURCE,
  };
  const response = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) throw new Error(`${method} ${path}: ${payload.error || response.status}`);
  return payload.data ?? payload;
}

async function cleanup() {
  await db.query('SET FOREIGN_KEY_CHECKS=0');
  await db.query(`DELETE l FROM accounting_journal_lines l JOIN accounting_journals j ON j.id=l.journal_id WHERE j.memo=?`, [MARKER]);
  await db.query(`DELETE FROM accounting_journals WHERE memo=?`, [MARKER]);
  await db.query(`DELETE FROM finance_open_items WHERE note=?`, [MARKER]);
  await db.query(`DELETE FROM inventory_movement_ledger WHERE item_code=?`, [ITEM]);
  await db.query(`DELETE FROM erp_inventory_balances WHERE item_code=?`, [ITEM]);
  for (const [head, detail, key] of [
    ['sales_documents', 'sales_document_items', 'document_id'],
    ['procurement_receipts', 'procurement_receipt_items', 'receipt_id'],
    ['procurement_orders', 'procurement_order_items', 'purchase_order_id'],
    ['procurement_requisitions', 'procurement_requisition_items', 'requisition_id'],
  ]) {
    await db.query(`DELETE d FROM ${detail} d JOIN ${head} h ON h.id=d.${key} WHERE h.note=?`, [MARKER]);
    await db.query(`DELETE FROM ${head} WHERE note=?`, [MARKER]);
  }
  await db.query(`DELETE FROM erp_items WHERE item_code=?`, [ITEM]);
  await db.query(`DELETE FROM erp_customers WHERE customer_code=?`, [CUSTOMER]);
  await db.query(`DELETE FROM erp_suppliers WHERE supplier_code=?`, [SUPPLIER]);
  await db.query('SET FOREIGN_KEY_CHECKS=1');
}

let token;
try {
  const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: '12345678' }) });
  const loginPayload = await login.json();
  if (!login.ok || loginPayload.ok === false) throw new Error(loginPayload.error || '登入失敗');
  token = loginPayload.data?.token || loginPayload.token;
  if (!token) throw new Error('登入未取得權杖');

  await cleanup();
  const [[context]] = await db.query(`SELECT tenant_id,company_id,source_system FROM erp_companies WHERE source_database=? LIMIT 1`, [SOURCE]);
  const [[warehouse]] = await db.query(`SELECT warehouse_code,warehouse_name FROM erp_warehouses WHERE source_database=? ORDER BY warehouse_code LIMIT 1`, [SOURCE]);
  if (!context || !warehouse) throw new Error('SC 公司或倉庫主檔不存在');

  await db.query(`INSERT INTO erp_items(tenant_id,company_id,source_system,item_code,item_name,specification,unit,source_database,source_table,source_key) VALUES(?,?,?,?,?,?,?,?,?,?)`, [context.tenant_id, context.company_id, context.source_system, ITEM, 'ERP操作手冊測試商品', '可刪除流程示範', 'PCS', SOURCE, 'ERP_DEMO', MARKER]);
  await db.query(`INSERT INTO erp_customers(source_database,tenant_id,company_id,source_system,customer_code,short_name,customer_name,currency_code,source_table,source_key) VALUES(?,?,?,?,?,?,?,?,?,?)`, [SOURCE, context.tenant_id, context.company_id, context.source_system, CUSTOMER, '手冊客戶', 'ERP操作手冊測試客戶', 'TWD', 'ERP_DEMO', MARKER]);
  await db.query(`INSERT INTO erp_suppliers(source_database,tenant_id,company_id,source_system,supplier_code,short_name,supplier_name,currency_code,source_table,source_key) VALUES(?,?,?,?,?,?,?,?,?,?)`, [SOURCE, context.tenant_id, context.company_id, context.source_system, SUPPLIER, '手冊廠商', 'ERP操作手冊測試廠商', 'TWD', 'ERP_DEMO', MARKER]);

  const salesTypes = await api(`/sales-workflow/document-types?source_database=${SOURCE}`);
  const orderType = salesTypes.find(x => x.document_kind === 'sales_order')?.type_code || 'SO';
  const shipmentType = salesTypes.find(x => x.document_kind === 'shipment')?.type_code || 'SA';
  const procurementTypes = await api(`/procurement/document-types?source_database=${SOURCE}`);
  const requisitionType = procurementTypes.find(x => x.document_kind === 'requisition')?.type_code || 'RQ';
  const purchaseType = procurementTypes.find(x => x.document_kind === 'purchase_order')?.type_code || '3310';
  const receiptType = procurementTypes.find(x => x.document_kind === 'receipt')?.type_code || '3411';

  const salesOrder = await api('/sales-workflow/documents', 'POST', { source_database: SOURCE, document_kind: 'sales_order', document_type: orderType, document_date: DATE, customer_code: CUSTOMER, warehouse_code: warehouse.warehouse_code, item_code: ITEM, item_name: 'ERP操作手冊測試商品', unit: 'PCS', quantity: SALE_QTY, unit_price: PRICE, unit_cost: COST, expected_date: DATE, note: MARKER });
  await api(`/sales-workflow/documents/${salesOrder.id}/approve`, 'POST', {});
  const initialStock = 0;

  const requisition = await api('/procurement/requisitions', 'POST', { source_database: SOURCE, document_type: requisitionType, requisition_date: DATE, requester_code: 'admin', department_code: '100', warehouse_code: warehouse.warehouse_code, item_code: ITEM, item_name: 'ERP操作手冊測試商品', unit: 'PCS', qty_requested: PURCHASE_QTY, required_date: DATE, note: MARKER });
  await api(`/procurement/documents/requisitions/${requisition.id}/approve`, 'POST', {});
  const [[rqItem]] = await db.query('SELECT id FROM procurement_requisition_items WHERE requisition_id=?', [requisition.id]);
  await api(`/procurement/requisition-lines/${rqItem.id}/maintenance`, 'PUT', { source_database: SOURCE, suggested_supplier_code: SUPPLIER, suggested_unit_price: COST, required_date: DATE, purchase_locked: 1, note: MARKER });
  const purchaseOrder = await api('/procurement/orders', 'POST', { source_database: SOURCE, document_type: purchaseType, requisition_item_id: rqItem.id, order_date: DATE, supplier_code: SUPPLIER, expected_date: DATE, currency_code: 'TWD', item_code: ITEM, item_name: 'ERP操作手冊測試商品', warehouse_code: warehouse.warehouse_code, unit: 'PCS', qty_ordered: PURCHASE_QTY, unit_price: COST, note: MARKER });
  const [[purchaseState]] = await db.query('SELECT status FROM procurement_orders WHERE id=?', [purchaseOrder.id]);
  if (purchaseState?.status === 'draft') await api(`/procurement/documents/orders/${purchaseOrder.id}/approve`, 'POST', {});
  const [[poItem]] = await db.query('SELECT id FROM procurement_order_items WHERE purchase_order_id=?', [purchaseOrder.id]);
  const receipt = await api('/procurement/receipts', 'POST', { source_database: SOURCE, document_type: receiptType, purchase_order_item_id: poItem.id, receipt_date: DATE, supplier_code: SUPPLIER, warehouse_code: warehouse.warehouse_code, item_code: ITEM, item_name: 'ERP操作手冊測試商品', unit: 'PCS', qty_received: PURCHASE_QTY, unit_cost: COST, note: MARKER });
  await api(`/procurement/receipts/${receipt.id}/inspect`, 'POST', { qty_accepted: PURCHASE_QTY, qty_rejected: 0, inspection_note: MARKER });
  await api(`/inventory-workflow/procurement/receipt/${receipt.id}/post`, 'POST', {});
  const [[stockAfterReceipt]] = await db.query('SELECT quantity_on_hand,inventory_amount FROM erp_inventory_balances WHERE item_code=? AND warehouse_code=?', [ITEM, warehouse.warehouse_code]);

  const shipment = await api(`/sales-workflow/items/${salesOrder.item_id}/convert`, 'POST', { document_type: shipmentType, document_date: DATE, warehouse_code: warehouse.warehouse_code, quantity: SALE_QTY, unit_cost: COST });
  await api(`/sales-workflow/documents/${shipment.id}/approve`, 'POST', {});
  await api(`/sales-workflow/documents/${shipment.id}/post`, 'POST', {});
  const [[stockAfterShipment]] = await db.query('SELECT quantity_on_hand,inventory_amount FROM erp_inventory_balances WHERE item_code=? AND warehouse_code=?', [ITEM, warehouse.warehouse_code]);

  const ar = await api('/finance-workflow/open-items', 'POST', { source_database: SOURCE, account_type: 'AR', document_date: DATE, due_date: DATE, party_code: CUSTOMER, currency_code: 'TWD', source_kind: 'shipment', source_document_id: shipment.id, source_document_no: shipment.document_no, original_amount: SALE_QTY * PRICE, note: MARKER });
  await api(`/finance-workflow/open-items/${ar.id}/approve`, 'POST', {});
  const ap = await api('/finance-workflow/open-items', 'POST', { source_database: SOURCE, account_type: 'AP', document_date: DATE, due_date: DATE, party_code: SUPPLIER, currency_code: 'TWD', source_kind: 'purchase_receipt', source_document_id: receipt.id, source_document_no: receipt.documentNo, original_amount: PURCHASE_QTY * COST, note: MARKER });
  await api(`/finance-workflow/open-items/${ap.id}/approve`, 'POST', {});

  const arJournal = await api('/accounting/journals/transfer', 'POST', { source_database: SOURCE, open_item_id: ar.id, memo: MARKER });
  await api(`/accounting/journals/${arJournal.id}/post`, 'POST', { source_database: SOURCE });
  const apJournal = await api('/accounting/journals/transfer', 'POST', { source_database: SOURCE, open_item_id: ap.id, memo: MARKER });
  await api(`/accounting/journals/${apJournal.id}/post`, 'POST', { source_database: SOURCE });

  const [[arCheck]] = await db.query('SELECT document_no,original_amount,status FROM finance_open_items WHERE id=?', [ar.id]);
  const [[apCheck]] = await db.query('SELECT document_no,original_amount,status FROM finance_open_items WHERE id=?', [ap.id]);
  const [journals] = await db.query(`SELECT j.journal_no,UPPER(REPLACE(j.source_kind,'finance_','')) account_type,j.status,SUM(l.debit_amount) debit_total,SUM(l.credit_amount) credit_total FROM accounting_journals j JOIN accounting_journal_lines l ON l.journal_id=j.id WHERE j.id IN (?,?) GROUP BY j.id ORDER BY account_type`, [arJournal.id, apJournal.id]);

  if (Number(stockAfterReceipt.quantity_on_hand) !== PURCHASE_QTY) throw new Error('進貨後庫存驗證失敗');
  if (Number(stockAfterShipment.quantity_on_hand) !== PURCHASE_QTY - SALE_QTY) throw new Error('銷貨後庫存驗證失敗');
  if (Number(arCheck.original_amount) !== SALE_QTY * PRICE || Number(apCheck.original_amount) !== PURCHASE_QTY * COST) throw new Error('應收應付金額驗證失敗');
  if (journals.some(j => j.status !== 'posted' || Number(j.debit_total) !== Number(j.credit_total))) throw new Error('會計傳票借貸平衡驗證失敗');

  console.log(JSON.stringify({
    ok: true,
    source_database: SOURCE,
    target_database: TARGET_DB,
    warehouse,
    item_code: ITEM,
    customer_code: CUSTOMER,
    supplier_code: SUPPLIER,
    documents: { sales_order: salesOrder.document_no, requisition: requisition.documentNo, purchase_order: purchaseOrder.documentNo, receipt: receipt.documentNo, shipment: shipment.document_no, ar: arCheck.document_no, ap: apCheck.document_no, journals },
    checks: { initial_stock: initialStock, stock_after_receipt: Number(stockAfterReceipt.quantity_on_hand), stock_after_shipment: Number(stockAfterShipment.quantity_on_hand), ar_amount: Number(arCheck.original_amount), ap_amount: Number(apCheck.original_amount) },
    cleanup_marker: MARKER,
  }, null, 2));
} finally {
  await control.end();
  await db.end();
}
