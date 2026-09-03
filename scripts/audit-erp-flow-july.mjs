import 'dotenv/config';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';

const API = 'http://127.0.0.1:3000/api';
const SOURCE = 'SH';
const DATE = '2026-07-15';
const FROM = '2026-07-01';
const TO = '2026-07-31';
const MARKER = 'FLOWAUDIT:SH:202607:10';
const CUSTOMER = 'AUDIT-CUST-0726';
const SUPPLIER = 'AUDIT-SUPP-0726';
const ITEMS = Array.from({ length: 10 }, (_, index) => `AUDIT202607${String(index + 1).padStart(2, '0')}`);
const ITEM_NAME = '7月流程稽核測試品';
const PURCHASE_QTY = 10;
const RECEIPT_QTYS = [4, 6];
const SHIPMENT_QTYS = [5, 5];
const UNIT_COST = 60;
const UNIT_PRICE = 100;

const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'inventory_erp',
};

function listParam(values) {
  return values.length ? values : ['__NO_TEST_VALUE__'];
}

async function cleanup(db) {
  const itemParams = listParam(ITEMS);
  await db.beginTransaction();
  try {
    const [[markerCounts]] = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM finance_vouchers WHERE note=?) AS voucher_count,
        (SELECT COUNT(*) FROM finance_open_items WHERE note=?) AS open_item_count,
        (SELECT COUNT(*) FROM finance_settlements WHERE note=?) AS settlement_count,
        (SELECT COUNT(*) FROM finance_notes WHERE memo=?) AS note_count,
        (SELECT COUNT(*) FROM accounting_journals WHERE memo=?) AS journal_count`, [MARKER, MARKER, MARKER, MARKER, MARKER]);
    const [sales] = await db.query(`SELECT DISTINCT d.id FROM sales_documents d JOIN sales_document_items i ON i.document_id=d.id WHERE i.item_code IN (?)`, [itemParams]);
    const [requisitions] = await db.query(`SELECT DISTINCT r.id FROM procurement_requisitions r JOIN procurement_requisition_items i ON i.requisition_id=r.id WHERE i.item_code IN (?) OR r.note=?`, [itemParams, MARKER]);
    const [orders] = await db.query(`SELECT DISTINCT o.id FROM procurement_orders o JOIN procurement_order_items i ON i.purchase_order_id=o.id WHERE i.item_code IN (?) OR o.note=?`, [itemParams, MARKER]);
    const [receipts] = await db.query(`SELECT DISTINCT r.id FROM procurement_receipts r JOIN procurement_receipt_items i ON i.receipt_id=r.id WHERE i.item_code IN (?) OR r.note=?`, [itemParams, MARKER]);
    const ids = rows => rows.map(row => row.id).filter(Boolean);
    const salesIds = ids(sales), requisitionIds = ids(requisitions), orderIds = ids(orders), receiptIds = ids(receipts);

    await db.query(`DELETE FROM accounting_journal_lines WHERE journal_id IN (SELECT id FROM accounting_journals WHERE memo=?)`, [MARKER]);
    await db.query(`DELETE FROM accounting_journals WHERE memo=?`, [MARKER]);
    await db.query(`DELETE FROM finance_notes WHERE memo=?`, [MARKER]);
    await db.query(`DELETE a FROM finance_allocations a JOIN finance_settlements s ON s.id=a.settlement_id WHERE s.note=?`, [MARKER]);
    await db.query(`DELETE FROM finance_settlements WHERE note=?`, [MARKER]);
    await db.query(`DELETE FROM finance_voucher_sources WHERE voucher_id IN (SELECT id FROM finance_vouchers WHERE note=?)`, [MARKER]);
    await db.query(`DELETE FROM finance_open_items WHERE note=?`, [MARKER]);
    await db.query(`DELETE FROM finance_vouchers WHERE note=?`, [MARKER]);

    if (receiptIds.length) {
      await db.query(`DELETE FROM procurement_receipt_items WHERE receipt_id IN (?)`, [receiptIds]);
      await db.query(`DELETE FROM procurement_receipts WHERE id IN (?)`, [receiptIds]);
    }
    if (orderIds.length) {
      await db.query(`DELETE FROM procurement_order_items WHERE purchase_order_id IN (?)`, [orderIds]);
      await db.query(`DELETE FROM procurement_order_changes WHERE purchase_order_id IN (?)`, [orderIds]);
      await db.query(`DELETE FROM procurement_orders WHERE id IN (?)`, [orderIds]);
    }
    if (requisitionIds.length) {
      await db.query(`DELETE FROM procurement_requisition_items WHERE requisition_id IN (?)`, [requisitionIds]);
      await db.query(`DELETE FROM procurement_requisitions WHERE id IN (?)`, [requisitionIds]);
    }
    if (salesIds.length) {
      await db.query(`DELETE FROM sales_document_items WHERE document_id IN (?)`, [salesIds]);
      await db.query(`DELETE FROM sales_documents WHERE id IN (?)`, [salesIds]);
    }
    await db.query(`DELETE FROM inventory_movement_ledger WHERE item_code IN (?)`, [itemParams]);
    await db.query(`DELETE FROM erp_inventory_balances WHERE item_code IN (?) AND source_system='iSM'`, [itemParams]);
    await db.query(`DELETE FROM erp_items WHERE item_code IN (?) AND source_table=?`, [itemParams, 'FLOW_AUDIT_202607']);
    await db.query(`DELETE FROM erp_customers WHERE customer_code=? AND source_key=?`, [CUSTOMER, MARKER]);
    await db.query(`DELETE FROM erp_suppliers WHERE supplier_code=? AND source_key=?`, [SUPPLIER, MARKER]);
    const approvalDocumentIds = [...requisitionIds, ...orderIds, ...receiptIds];
    if (approvalDocumentIds.length) {
      await db.query(`DELETE FROM procurement_document_approvals WHERE document_id IN (?)`, [approvalDocumentIds]);
    }
    await db.commit();
    return {
      before: {
        marker_vouchers: Number(markerCounts.voucher_count),
        marker_open_items: Number(markerCounts.open_item_count),
        marker_settlements: Number(markerCounts.settlement_count),
        marker_notes: Number(markerCounts.note_count),
        marker_journals: Number(markerCounts.journal_count),
      },
      removed: { sales: salesIds.length, requisitions: requisitionIds.length, orders: orderIds.length, receipts: receiptIds.length },
    };
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
  const token = payload.data?.token || payload.token;
  if (!token) throw new Error('登入沒有回傳權杖');
  return token;
}

function makeApi(token) {
  return async (path, method = 'GET', body) => {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { error: text }; }
    if (!response.ok || payload.ok === false) throw new Error(`${method} ${path}: ${payload.error || response.status}`);
    return payload.data ?? payload;
  };
}

function assert(condition, message, details = undefined) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

async function main() {
  const db = await mysql.createConnection(dbConfig);
  let token;
  let completed = false;
  try {
    const cleanupBefore = await cleanup(db);
    token = await login();
    const api = makeApi(token);
    const [[context]] = await db.query(`SELECT tenant_id,company_id,source_system FROM erp_companies WHERE source_database=? ORDER BY id LIMIT 1`, [SOURCE]);
    const [[warehouse]] = await db.query(`SELECT warehouse_code,warehouse_name FROM erp_warehouses WHERE source_database=? ORDER BY warehouse_code LIMIT 1`, [SOURCE]);
    assert(context, '找不到 SH／仙暉公司的標準資料來源');
    assert(warehouse, '找不到 SH／仙暉公司的庫別');

    await db.query(`INSERT INTO erp_items
      (tenant_id,company_id,source_system,item_code,item_name,specification,unit,source_database,source_table,source_key)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, [context.tenant_id, context.company_id, context.source_system, ITEMS[0], ITEM_NAME, MARKER, 'PCS', SOURCE, 'FLOW_AUDIT_202607', MARKER]);
    for (const item of ITEMS.slice(1)) {
      await db.query(`INSERT INTO erp_items
        (tenant_id,company_id,source_system,item_code,item_name,specification,unit,source_database,source_table,source_key)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, [context.tenant_id, context.company_id, context.source_system, item, ITEM_NAME, MARKER, 'PCS', SOURCE, 'FLOW_AUDIT_202607', MARKER]);
    }
    await db.query(`INSERT INTO erp_customers
      (source_database,tenant_id,company_id,source_system,customer_code,short_name,customer_name,currency_code,source_table,source_key)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, [SOURCE, context.tenant_id, context.company_id, context.source_system, CUSTOMER, '7月稽核客戶', '7月流程稽核測試客戶', 'TWD', 'FLOW_AUDIT_202607', MARKER]);
    await db.query(`INSERT INTO erp_suppliers
      (source_database,tenant_id,company_id,source_system,supplier_code,short_name,supplier_name,currency_code,source_table,source_key)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, [SOURCE, context.tenant_id, context.company_id, context.source_system, SUPPLIER, '7月稽核廠商', '7月流程稽核測試廠商', 'TWD', 'FLOW_AUDIT_202607', MARKER]);

    const salesTypes = await api(`/sales-workflow/document-types?source_database=${SOURCE}`);
    const quoteType = salesTypes.find(row => row.document_kind === 'quotation' && row.type_code === 'QT')?.type_code || salesTypes.find(row => row.document_kind === 'quotation')?.type_code;
    const orderType = salesTypes.find(row => row.document_kind === 'sales_order' && row.type_code === 'SO')?.type_code || 'SO';
    const shipmentType = salesTypes.find(row => row.document_kind === 'shipment' && row.type_code === 'SA')?.type_code || 'SA';
    const procurementTypes = await api(`/procurement/document-types?source_database=${SOURCE}`);
    const requisitionType = procurementTypes.find(row => row.document_kind === 'requisition' && row.type_code === 'RQ')?.type_code || 'RQ';
    const purchaseType = procurementTypes.find(row => row.document_kind === 'purchase_order' && row.type_code === '3310')?.type_code || procurementTypes.find(row => row.document_kind === 'purchase_order')?.type_code;
    const receiptType = procurementTypes.find(row => row.document_kind === 'receipt' && row.type_code === '3411')?.type_code || procurementTypes.find(row => row.document_kind === 'receipt')?.type_code;
    const arOpenType = (await api(`/finance-workflow/document-types?source_database=${SOURCE}&account_type=AR&document_kind=open_item`)).find(row => row.type_code === '6101')?.type_code || '6101';
    const apOpenType = (await api(`/finance-workflow/document-types?source_database=${SOURCE}&account_type=AP&document_kind=open_item`)).find(row => row.type_code === '7101')?.type_code || '7101';
    const arSettlementType = (await api(`/finance-workflow/document-types?source_database=${SOURCE}&account_type=AR&document_kind=settlement`)).find(row => row.type_code === '6301')?.type_code || '6301';
    const apSettlementType = (await api(`/finance-workflow/document-types?source_database=${SOURCE}&account_type=AP&document_kind=settlement`)).find(row => row.type_code === '7301')?.type_code || '7301';
    assert(quoteType && purchaseType && receiptType, 'SH 的單據性質不完整', { quoteType, orderType, shipmentType, requisitionType, purchaseType, receiptType, arOpenType, apOpenType, arSettlementType, apSettlementType });

    const chains = [];
    for (const item of ITEMS) {
      const chain = { item_code: item, receipt_items: [], shipment_items: [] };
      const requisition = await api('/procurement/requisitions', 'POST', {
        source_database: SOURCE, document_type: requisitionType, requisition_date: DATE, requester_code: 'admin',
        department_code: '100', warehouse_code: warehouse.warehouse_code, item_code: item, item_name: ITEM_NAME,
        unit: 'PCS', qty_requested: PURCHASE_QTY, required_date: DATE, note: MARKER,
      });
      chain.requisition = requisition;
      await api(`/procurement/documents/requisitions/${requisition.id}/approve?source_database=${SOURCE}`, 'POST', { source_database: SOURCE });
      const [[requisitionItem]] = await db.query(`SELECT id FROM procurement_requisition_items WHERE requisition_id=?`, [requisition.id]);
      assert(requisitionItem, `找不到請購明細：${item}`);
      await api(`/procurement/requisition-lines/${requisitionItem.id}/maintenance`, 'PUT', {
        source_database: SOURCE, suggested_supplier_code: SUPPLIER, suggested_unit_price: UNIT_COST,
        required_date: DATE, purchase_locked: 1, note: MARKER,
      });
      const purchase = await api(`/procurement/requisition-lines/${requisitionItem.id}/convert`, 'POST', {
        source_database: SOURCE, document_type: purchaseType, order_date: DATE, supplier_code: SUPPLIER, expected_date: DATE,
        currency_code: 'TWD', unit_price: UNIT_COST, note: MARKER,
      });
      chain.purchase = purchase;
      await api(`/procurement/documents/orders/${purchase.id}/approve?source_database=${SOURCE}`, 'POST', { source_database: SOURCE });
      const [[purchaseItem]] = await db.query(`SELECT id FROM procurement_order_items WHERE purchase_order_id=?`, [purchase.id]);
      assert(purchaseItem, `找不到採購明細：${item}`);
      for (const receiptQty of RECEIPT_QTYS) {
        const receipt = await api('/procurement/receipts', 'POST', {
          source_database: SOURCE, document_type: receiptType, purchase_order_item_id: purchaseItem.id,
          receipt_date: DATE, arrival_date: DATE, supplier_code: SUPPLIER, warehouse_code: warehouse.warehouse_code,
          item_code: item, item_name: ITEM_NAME, unit: 'PCS', qty_received: receiptQty, unit_cost: UNIT_COST,
          delivery_note_no: `${MARKER}-${receiptQty}`, note: MARKER,
        });
        await api(`/procurement/receipts/${receipt.id}/inspect`, 'POST', { source_database: SOURCE, qty_accepted: receiptQty, qty_rejected: 0, inspection_note: MARKER });
        await api(`/inventory-workflow/procurement/receipt/${receipt.id}/post`, 'POST', { source_database: SOURCE });
        const [[receiptItem]] = await db.query(`SELECT id FROM procurement_receipt_items WHERE receipt_id=?`, [receipt.id]);
        assert(receiptItem, `找不到進貨明細：${item}`);
        chain.receipt_items.push({ receipt, id: receiptItem.id, quantity: receiptQty });
      }

      const quote = await api('/sales-workflow/documents', 'POST', {
        source_database: SOURCE, document_kind: 'quotation', document_type: quoteType, document_date: DATE,
        customer_code: CUSTOMER, warehouse_code: warehouse.warehouse_code, item_code: item, item_name: ITEM_NAME,
        unit: 'PCS', quantity: PURCHASE_QTY, unit_price: UNIT_PRICE, unit_cost: UNIT_COST, expected_date: DATE, note: MARKER,
      });
      chain.quote = quote;
      await api(`/sales-workflow/documents/${quote.id}/approve?source_database=${SOURCE}`, 'POST', { source_database: SOURCE });
      const order = await api(`/sales-workflow/items/${quote.item_id}/convert`, 'POST', { source_database: SOURCE, document_type: orderType, document_date: DATE, warehouse_code: warehouse.warehouse_code, quantity: PURCHASE_QTY });
      chain.sales_order = order;
      await api(`/sales-workflow/documents/${order.id}/approve?source_database=${SOURCE}`, 'POST', { source_database: SOURCE });
      for (const shipmentQty of SHIPMENT_QTYS) {
        const shipment = await api(`/sales-workflow/items/${chain.sales_order.item_id}/convert`, 'POST', {
          source_database: SOURCE, document_type: shipmentType, document_date: DATE, warehouse_code: warehouse.warehouse_code, quantity: shipmentQty, unit_cost: UNIT_COST,
        });
        await api(`/sales-workflow/documents/${shipment.id}/approve?source_database=${SOURCE}`, 'POST', { source_database: SOURCE });
        await api(`/sales-workflow/documents/${shipment.id}/post`, 'POST', { source_database: SOURCE });
        const [[shipmentItem]] = await db.query(`SELECT id FROM sales_document_items WHERE document_id=?`, [shipment.id]);
        assert(shipmentItem, `找不到銷貨明細：${item}`);
        chain.shipment_items.push({ shipment, id: shipmentItem.id, quantity: shipmentQty });
      }
      chains.push(chain);
    }

    const arSources = chains.flatMap(chain => chain.shipment_items.map(row => ({
      source_document_id: row.shipment.id, source_document_item_id: row.id, allocated_amount: row.quantity * UNIT_PRICE,
    })));
    const apSources = chains.flatMap(chain => chain.receipt_items.map(row => ({
      source_document_id: row.receipt.id, source_document_item_id: row.id, allocated_amount: row.quantity * UNIT_COST,
    })));
    const arVoucher = await api('/finance-workflow/vouchers', 'POST', {
      source_database: SOURCE, account_type: 'AR', document_type: arOpenType, voucher_date: DATE, due_date: DATE,
      party_code: CUSTOMER, currency_code: 'TWD', settlement_mode: 'batch', source_rows: arSources, note: MARKER,
    });
    await api(`/finance-workflow/vouchers/${arVoucher.id}/approve`, 'POST', { source_database: SOURCE });
    const apVoucher = await api('/finance-workflow/vouchers', 'POST', {
      source_database: SOURCE, account_type: 'AP', document_type: apOpenType, voucher_date: DATE, due_date: DATE,
      party_code: SUPPLIER, currency_code: 'TWD', settlement_mode: 'batch', source_rows: apSources, note: MARKER,
    });
    await api(`/finance-workflow/vouchers/${apVoucher.id}/approve`, 'POST', { source_database: SOURCE });
    const [[arOpen]] = await db.query(`SELECT * FROM finance_open_items WHERE source_kind='finance_voucher' AND source_document_id=?`, [arVoucher.id]);
    const [[apOpen]] = await db.query(`SELECT * FROM finance_open_items WHERE source_kind='finance_voucher' AND source_document_id=?`, [apVoucher.id]);
    assert(arOpen && apOpen, '應收／應付批次結帳後沒有產生帳款');

    const arSettlement = await api('/finance-workflow/settlements-enhanced', 'POST', {
      source_database: SOURCE, document_type: arSettlementType, settlement_date: DATE,
      allocations: [{ open_item_id: arOpen.id, allocated_amount: Number(arOpen.original_amount) }], payment_method: 'bank_transfer', note: MARKER,
    });
    await api(`/finance-workflow/settlements/${arSettlement.id}/post`, 'POST', { source_database: SOURCE });
    const apSettlement = await api('/finance-workflow/settlements-enhanced', 'POST', {
      source_database: SOURCE, document_type: apSettlementType, settlement_date: DATE,
      allocations: [{ open_item_id: apOpen.id, allocated_amount: Number(apOpen.original_amount) }], payment_method: 'bank_transfer', note: MARKER,
    });
    await api(`/finance-workflow/settlements/${apSettlement.id}/post`, 'POST', { source_database: SOURCE });

    const arJournal = await api('/accounting/journals/transfer', 'POST', { source_database: SOURCE, open_item_id: arOpen.id, memo: MARKER });
    await api(`/accounting/journals/${arJournal.id}/post`, 'POST', { source_database: SOURCE });
    const apJournal = await api('/accounting/journals/transfer', 'POST', { source_database: SOURCE, open_item_id: apOpen.id, memo: MARKER });
    await api(`/accounting/journals/${apJournal.id}/post`, 'POST', { source_database: SOURCE });
    const arCashJournal = await api('/accounting/journals/transfer', 'POST', { source_database: SOURCE, settlement_id: arSettlement.id, memo: MARKER });
    await api(`/accounting/journals/${arCashJournal.id}/post`, 'POST', { source_database: SOURCE });
    const apCashJournal = await api('/accounting/journals/transfer', 'POST', { source_database: SOURCE, settlement_id: apSettlement.id, memo: MARKER });
    await api(`/accounting/journals/${apCashJournal.id}/post`, 'POST', { source_database: SOURCE });

    const [stockRows] = await db.query(`SELECT item_code,quantity_on_hand,inventory_amount FROM erp_inventory_balances
      WHERE tenant_id=? AND company_id=? AND source_system=? AND item_code IN (?) ORDER BY item_code`,
      [context.tenant_id, context.company_id, context.source_system, ITEMS]);
    const [financeRows] = await db.query(`SELECT account_type,status,balance_amount FROM finance_open_items WHERE note=? ORDER BY account_type`, [MARKER]);
    const [settlementRows] = await db.query(`SELECT account_type,status,amount FROM finance_settlements WHERE note=? ORDER BY account_type`, [MARKER]);
    const [journalRows] = await db.query(`
      SELECT j.id,j.journal_no,j.source_kind,j.status,COALESCE(SUM(l.debit_amount),0) debit_total,COALESCE(SUM(l.credit_amount),0) credit_total,COUNT(l.id) line_count
      FROM accounting_journals j JOIN accounting_journal_lines l ON l.journal_id=j.id
      WHERE j.memo=? GROUP BY j.id ORDER BY j.id`, [MARKER]);
    const salesAudit = await api(`/flow-audit/sales?source_database=${SOURCE}&from_date=${FROM}&to_date=${TO}&limit=500`);
    const procurementAudit = await api(`/flow-audit/procurement?source_database=${SOURCE}&from_date=${FROM}&to_date=${TO}&limit=500`);
    const healthAudit = await api(`/flow-audit/health?source_database=${SOURCE}&from_date=${FROM}&to_date=${TO}&limit=500`);
    const trialBalance = await api(`/accounting/trial-balance?source_database=${SOURCE}&date_from=${FROM}&date_to=${TO}`);
    const ledger = await api(`/accounting/ledger?source_database=${SOURCE}&from_date=${FROM}&to_date=${TO}&limit=100`);

    const salesSummary = salesAudit.summary || {};
    const procurementSummary = procurementAudit.summary || {};
    const testedSalesRows = (salesAudit.rows || []).filter(row => ITEMS.includes(String(row.item_code)));
    const testedProcurementRows = (procurementAudit.rows || []).filter(row => ITEMS.includes(String(row.item_code)));
    const total = (rows, field) => rows.reduce((sum, row) => sum + Number(row[field] || 0), 0);
    const testedSalesSummary = {
      order_count: new Set(testedSalesRows.map(row => row.order_no).filter(Boolean)).size,
      order_quantity: total(testedSalesRows, 'order_quantity'),
      delivered_quantity: total(testedSalesRows, 'delivered_quantity'),
      remaining_quantity: total(testedSalesRows, 'remaining_quantity'),
      billed_amount: total(testedSalesRows, 'billed_amount'),
      collected_amount: total(testedSalesRows, 'collected_amount'),
      uncollected_amount: total(testedSalesRows, 'uncollected_amount'),
      exception_count: testedSalesRows.filter(row => row.audit_status !== '流程完成').length,
    };
    const testedProcurementSummary = {
      purchase_order_count: new Set(testedProcurementRows.map(row => row.purchase_order_no).filter(Boolean)).size,
      order_quantity: total(testedProcurementRows, 'order_quantity'),
      accepted_quantity: total(testedProcurementRows, 'accepted_quantity'),
      remaining_quantity: total(testedProcurementRows, 'remaining_quantity'),
      billed_amount: total(testedProcurementRows, 'billed_amount'),
      paid_amount: total(testedProcurementRows, 'paid_amount'),
      unpaid_amount: total(testedProcurementRows, 'unpaid_amount'),
      exception_count: testedProcurementRows.filter(row => row.audit_status !== '流程完成').length,
    };
    const existingSourceAlerts = (healthAudit.alerts || [])
      .filter(row => !ITEMS.includes(String(row.item_code)))
      .map(row => ({ flow: row.flow, source: row.source, item_code: row.item_code, next_stage: row.next_stage, exception_reason: row.exception_reason }));
    assert(stockRows.length === ITEMS.length && stockRows.every(row => Math.abs(Number(row.quantity_on_hand)) < 0.000001), '10 組流程完成後庫存未歸零', stockRows);
    assert(financeRows.length === 2 && financeRows.every(row => row.status === 'settled' && Math.abs(Number(row.balance_amount)) < 0.000001), '應收／應付沒有完整沖銷', financeRows);
    assert(settlementRows.length === 2 && settlementRows.every(row => row.status === 'posted'), '收付款沒有全部過帳', settlementRows);
    assert(journalRows.length === 4 && journalRows.every(row => row.status === 'posted' && Number(row.line_count) >= 2 && Math.abs(Number(row.debit_total) - Number(row.credit_total)) < 0.000001), '傳票未全部借貸平衡過帳', journalRows);
    assert(testedSalesRows.length === 10 && testedSalesSummary.order_count === 10 && testedSalesSummary.delivered_quantity === 100 && testedSalesSummary.remaining_quantity === 0 && testedSalesSummary.uncollected_amount === 0 && testedSalesSummary.exception_count === 0, '銷售稽核未完整呈現 10 組流程', { testedSalesRows, testedSalesSummary, allSalesSummary: salesSummary });
    assert(testedProcurementRows.length === 10 && testedProcurementSummary.purchase_order_count === 10 && testedProcurementSummary.accepted_quantity === 100 && testedProcurementSummary.remaining_quantity === 0 && testedProcurementSummary.unpaid_amount === 0 && testedProcurementSummary.exception_count === 0, '採購稽核未完整呈現 10 組流程', { testedProcurementRows, testedProcurementSummary, allProcurementSummary: procurementSummary });
    assert(!(healthAudit.alerts || []).some(row => ITEMS.includes(String(row.item_code))), '7 月測試流程仍有營運稽核異常', healthAudit.alerts);
    assert((trialBalance.rows || []).length > 0 && (ledger.rows || []).length > 0, '總帳／試算表沒有 7 月過帳資料');
    completed = true;
    console.log(JSON.stringify({
      ok: true,
      test_marker: MARKER,
      company: { source_database: SOURCE, company_id: context.company_id, tenant_id: context.tenant_id, source_system: context.source_system, warehouse },
      period: { from: FROM, to: TO, note: '測試資料日期為 2026-07-15；SH 原始資料庫未被寫入' },
      generated: { chains: chains.length, sales_documents: chains.length * 4, purchase_requisitions: chains.length, purchase_orders: chains.length, receipts: chains.length * 2, shipments: chains.length * 2, ar_source_lines: arSources.length, ap_source_lines: apSources.length, finance_vouchers: 2, settlements: 2, journals: journalRows.length },
      checks: { stock_rows: stockRows.length, inventory_zero: true, finance_settled: true, settlements_posted: true, journals_balanced_posted: true, tested_sales_summary: testedSalesSummary, tested_procurement_summary: testedProcurementSummary, all_sales_summary: salesSummary, all_procurement_summary: procurementSummary, health_alerts: (healthAudit.alerts || []).length, existing_source_alerts: existingSourceAlerts, trial_balance_rows: (trialBalance.rows || []).length, ledger_rows: (ledger.rows || []).length },
      documents: { ar_voucher: arVoucher.voucher_no, ap_voucher: apVoucher.voucher_no, ar_settlement: arSettlement.settlement_no, ap_settlement: apSettlement.settlement_no, journals: journalRows.map(row => row.journal_no) },
      cleanup: 'node scripts/audit-erp-flow-july.mjs --cleanup',
      cleanup_before: cleanupBefore,
    }, null, 2));
  } catch (error) {
    if (!completed) {
      try { console.error(JSON.stringify({ ok: false, error: error.message, details: error.details || null, cleanup: await cleanup(db) }, null, 2)); }
      catch (cleanupError) { console.error(JSON.stringify({ ok: false, error: error.message, cleanup_error: cleanupError.message }, null, 2)); }
    }
    process.exitCode = 1;
  } finally {
    if (token) {
      try {
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        await db.query('DELETE FROM access_sessions WHERE token_hash=?', [tokenHash]);
      } catch { /* session cleanup is best effort */ }
    }
    await db.end();
  }
}

const db = await mysql.createConnection(dbConfig);
if (process.argv.includes('--cleanup')) {
  console.log(JSON.stringify({ ok: true, cleanup: await cleanup(db), test_marker: MARKER }, null, 2));
  await db.end();
} else {
  await db.end();
  await main();
}
