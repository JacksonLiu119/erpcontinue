import 'dotenv/config';
import mysql from 'mysql2/promise';

const API = 'http://127.0.0.1:3000/api';
const SOURCE = 'SH';
const FROM = '2026-08-01';
const TO = '2026-08-31';
const DATE = '2026-08-26';
const MARKER = 'FLOWAUDIT:R01:ROOTS:20260826';
const ITEM = 'FLOWR01-20260826';
const CUSTOMER = 'FLOWR01-CUST';
const SUPPLIER = 'FLOWR01-SUPP';
const SALES_DOCS = ['R01-QT-20260826', 'R01-SA-20260826', 'R01-SA-ORPHAN-20260826', 'R01-SR-20260826'];
const REQUISITION_NO = 'R01-RQ-20260826';
const PURCHASE_ORDER_NO = 'R01-PO-SC-20260826';
const RECEIPT_NOS = ['R01-GR-20260826', 'R01-GR-ORPHAN-20260826'];
const INVENTORY_DOCS = ['R01-TO-20260826', 'R01-TI-20260826'];

const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'inventory_erp',
};

function assert(condition, message, details = undefined) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

async function removeFixture(db) {
  const [sales] = await db.query('SELECT id FROM sales_documents WHERE document_no IN (?) OR note=?', [SALES_DOCS, MARKER]);
  const [requisitions] = await db.query('SELECT id FROM procurement_requisitions WHERE requisition_no=? OR note=?', [REQUISITION_NO, MARKER]);
  const [orders] = await db.query('SELECT id FROM procurement_orders WHERE purchase_order_no=? OR note=?', [PURCHASE_ORDER_NO, MARKER]);
  const [receipts] = await db.query('SELECT id FROM procurement_receipts WHERE receipt_no IN (?) OR note=?', [RECEIPT_NOS, MARKER]);
  const [inventory] = await db.query('SELECT id FROM inventory_documents WHERE document_no IN (?) OR note=?', [INVENTORY_DOCS, MARKER]);
  const ids = rows => rows.map(row => Number(row.id)).filter(Boolean);
  const salesIds = ids(sales), requisitionIds = ids(requisitions), orderIds = ids(orders), receiptIds = ids(receipts), inventoryIds = ids(inventory);
  await db.beginTransaction();
  try {
    if (inventoryIds.length) {
      await db.query('DELETE FROM inventory_document_items WHERE document_id IN (?)', [inventoryIds]);
      await db.query('DELETE FROM inventory_documents WHERE id IN (?)', [inventoryIds]);
    }
    if (receiptIds.length) {
      await db.query('DELETE FROM procurement_receipt_items WHERE receipt_id IN (?)', [receiptIds]);
      await db.query('DELETE FROM procurement_receipts WHERE id IN (?)', [receiptIds]);
    }
    if (orderIds.length) {
      await db.query('DELETE FROM procurement_order_items WHERE purchase_order_id IN (?)', [orderIds]);
      await db.query('DELETE FROM procurement_orders WHERE id IN (?)', [orderIds]);
    }
    if (requisitionIds.length) {
      await db.query('DELETE FROM procurement_requisition_items WHERE requisition_id IN (?)', [requisitionIds]);
      await db.query('DELETE FROM procurement_requisitions WHERE id IN (?)', [requisitionIds]);
    }
    if (salesIds.length) {
      await db.query('DELETE FROM sales_document_items WHERE document_id IN (?)', [salesIds]);
      await db.query('DELETE FROM sales_documents WHERE id IN (?)', [salesIds]);
    }
    await db.commit();
    return { sales: salesIds.length, requisitions: requisitionIds.length, orders: orderIds.length, receipts: receiptIds.length, inventory: inventoryIds.length };
  } catch (error) {
    await db.rollback();
    throw error;
  }
}

async function login() {
  const response = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '12345678' }),
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) throw new Error(payload.error || '管理員登入失敗');
  return payload.data?.token;
}

async function audit(token, kind) {
  const response = await fetch(`${API}/flow-audit/${kind}?source_database=${SOURCE}&from_date=${FROM}&to_date=${TO}&limit=200`, { headers: { Authorization: `Bearer ${token}` } });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `${kind} 稽核失敗`);
  return payload.data;
}

async function main() {
  const db = await mysql.createConnection(dbConfig);
  let fixture;
  try {
    await removeFixture(db);
    const [[context]] = await db.query('SELECT tenant_id,company_id,source_system FROM erp_data_sources WHERE source_key=? AND enabled=1 LIMIT 1', [SOURCE]);
    const [[warehouse]] = await db.query('SELECT warehouse_code FROM erp_warehouses WHERE source_database=? ORDER BY warehouse_code LIMIT 1', [SOURCE]);
    assert(context && warehouse, '找不到 SH 的公司範圍或庫別');
    const c = [context.tenant_id, context.company_id, context.source_system];

    const insertSales = async (documentKind, documentType, documentNo, status, sourceItemId = null, returnType = null) => {
      const [result] = await db.query(`INSERT INTO sales_documents
        (tenant_id,company_id,source_system,source_database,document_kind,document_type,document_no,document_date,customer_code,currency_code,return_type,status,inventory_status,note)
        VALUES(?,?,?,?,?,?,?,?,?,'TWD',?,?,?,?)`, [...c, SOURCE, documentKind, documentType, documentNo, DATE, CUSTOMER, returnType, status, documentKind === 'shipment' || documentKind === 'sales_return' ? 'posted' : 'not_applicable', MARKER]);
      await db.query(`INSERT INTO sales_document_items
        (document_id,line_no,source_item_id,item_code,item_name,unit,warehouse_code,quantity,unit_price,unit_cost,note)
        VALUES(?,1,?,?,?,?,?,?,?, ?,?)`, [result.insertId, sourceItemId, ITEM, 'R01 合法起點測試品', 'PCS', warehouse.warehouse_code, 2, 100, 60, MARKER]);
    };
    await insertSales('quotation', 'QT', SALES_DOCS[0], 'approved');
    await insertSales('shipment', 'SA', SALES_DOCS[1], 'posted');
    await insertSales('shipment', 'SA', SALES_DOCS[2], 'posted', 999999999);
    await insertSales('sales_return', 'SR', SALES_DOCS[3], 'posted', null, 'return');

    const [rq] = await db.query(`INSERT INTO procurement_requisitions
      (requisition_no,requisition_date,requester_code,department_code,warehouse_code,status,note,source_database)
      VALUES(?,?,?,?,?,'approved',?,?)`, [REQUISITION_NO, DATE, 'admin', '100', warehouse.warehouse_code, MARKER, SOURCE]);
    await db.query(`INSERT INTO procurement_requisition_items
      (requisition_id,line_no,item_code,item_name,warehouse_code,unit,qty_requested,qty_ordered,required_date,note)
      VALUES(?,1,?,?,?,'PCS',4,0,?,?)`, [rq.insertId, ITEM, 'R01 合法起點測試品', warehouse.warehouse_code, DATE, MARKER]);

    const [po] = await db.query(`INSERT INTO procurement_orders
      (purchase_order_no,supplier_code,order_date,expected_date,currency_code,status,note,source_database)
      VALUES(?,?,?,?,'TWD','confirmed',?,'SC')`, [PURCHASE_ORDER_NO, SUPPLIER, DATE, DATE, MARKER]);
    const [poi] = await db.query(`INSERT INTO procurement_order_items
      (purchase_order_id,requisition_item_id,line_no,item_code,item_name,warehouse_code,unit,qty_ordered,qty_received,unit_price,expected_date,note)
      VALUES(?,NULL,1,?,?,?,'PCS',2,0,50,?,?)`, [po.insertId, ITEM, 'R01 合法起點測試品', warehouse.warehouse_code, DATE, MARKER]);

    const insertReceipt = async (receiptNo, purchaseOrderItemId = null) => {
      const [result] = await db.query(`INSERT INTO procurement_receipts
        (receipt_no,supplier_code,receipt_date,warehouse_code,status,note,source_database)
        VALUES(?,?,?,?,'posted',?,'SH')`, [receiptNo, SUPPLIER, DATE, warehouse.warehouse_code, MARKER]);
      await db.query(`INSERT INTO procurement_receipt_items
        (receipt_id,purchase_order_item_id,line_no,item_code,item_name,warehouse_code,unit,qty_received,qty_accepted,unit_cost,note)
        VALUES(?, ?,1,?,?,?,'PCS',2,2,50,?)`, [result.insertId, purchaseOrderItemId, ITEM, 'R01 合法起點測試品', warehouse.warehouse_code, MARKER]);
    };
    await insertReceipt(RECEIPT_NOS[0]);
    await insertReceipt(RECEIPT_NOS[1], poi.insertId);

    const insertInventory = async (documentNo, movementKind, status) => {
      const [result] = await db.query(`INSERT INTO inventory_documents
        (tenant_id,company_id,source_system,source_database,document_no,document_type,movement_kind,document_date,status,note)
        VALUES(?,?,?,?,?,?,?,? ,?,?)`, [...c, SOURCE, documentNo, movementKind === 'temp_out' ? 'TO' : 'TI', movementKind, DATE, status, MARKER]);
      await db.query(`INSERT INTO inventory_document_items
        (document_id,line_no,item_code,item_name,unit,from_warehouse_code,to_warehouse_code,quantity,unit_cost,reason)
        VALUES(?,1,?,?,? ,?,?,1,60,?)`, [result.insertId, ITEM, 'R01 合法起點測試品', 'PCS', warehouse.warehouse_code, null, MARKER]);
    };
    await insertInventory(INVENTORY_DOCS[0], 'temp_out', 'posted');
    await insertInventory(INVENTORY_DOCS[1], 'temp_in', 'draft');
    fixture = { requisition: rq.insertId, order: po.insertId };

    const token = await login();
    const sales = await audit(token, 'sales');
    const procurement = await audit(token, 'procurement');
    const health = await audit(token, 'health');
    const salesKinds = new Set(sales.rows.map(row => row.root_kind));
    const procurementKinds = new Set(procurement.rows.map(row => row.root_kind));
    assert(salesKinds.has('unconverted_quotation'), '未轉訂單報價未被稽核納入', [...salesKinds]);
    assert(salesKinds.has('standalone_shipment'), '獨立銷貨未被稽核納入', [...salesKinds]);
    assert(salesKinds.has('orphan_shipment'), '孤兒銷貨未被標示', [...salesKinds]);
    assert(salesKinds.has('sales_return'), '銷退／折讓起點未被稽核納入', [...salesKinds]);
    assert(procurementKinds.has('unconverted_requisition'), '未轉採購請購未被稽核納入', [...procurementKinds]);
    assert(procurementKinds.has('standalone_receipt'), '獨立進貨未被稽核納入', [...procurementKinds]);
    assert(procurementKinds.has('orphan_receipt'), '孤兒進貨未被標示', [...procurementKinds]);
    assert((sales.supplemental_rows || []).length >= 2, '庫存補充／暫出入未被銷售稽核納入');
    assert((procurement.supplemental_rows || []).length >= 2, '庫存補充／暫出入未被採購稽核納入');
    assert((health.alerts || []).some(row => row.flow === '庫存補充'), '營運健康度未納入庫存補充異常');
    console.log(JSON.stringify({
      ok: true,
      sales: { rows: sales.rows.length, supplemental: sales.supplemental_rows.length, roots: [...salesKinds] },
      procurement: { rows: procurement.rows.length, supplemental: procurement.supplemental_rows.length, roots: [...procurementKinds] },
      health_alerts: health.alerts.length,
    }, null, 2));
  } finally {
    await removeFixture(db);
    await db.end();
  }
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, error: error.message, details: error.details }, null, 2));
  process.exitCode = 1;
});
