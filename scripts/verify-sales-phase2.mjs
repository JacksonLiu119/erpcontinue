import 'dotenv/config';
import { pool, reloadSourceDatabases, runWithTargetDatabase } from '../src/db.js';

const baseUrl = String(process.env.ERP_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const stamp = Date.now().toString(36).toUpperCase();
const contractNo = `T2CT${stamp}`.slice(0, 60);
const typeCode = `T2${stamp}`.slice(0, 20);
const requisitionTypeCode = `R2${stamp}`.slice(0, 20);
const purchaseTypeCode = `P2${stamp}`.slice(0, 20);
const gatedRequisitionTypeCode = `RG${stamp}`.slice(0, 20);
const gatedPurchaseTypeCode = `PG${stamp}`.slice(0, 20);
const priceDate = '2099-01-01';
let token = '', source = '', company = '', customerCode = '', itemCode = '', supplierCode = '', currencyCode = 'TWD';
let contractId = 0, orderId = 0, priceId = 0, scheduleId = 0, pickId = 0, demandIds = [];
let requisitionId = 0, requisitionItemId = 0, purchaseOrderId = 0;
let gatedDemandId = 0, gatedRequisitionId = 0, gatedRequisitionItemId = 0, gatedPurchaseOrderId = 0;
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (source) {
    headers.set('X-ERP-Context-Key', source);
    headers.set('X-Source-Database', source);
    headers.set('X-Company-Id', company);
  }
  const response = await fetch(baseUrl + path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function cleanup() {
  if (!source) return;
  await reloadSourceDatabases();
  await runWithTargetDatabase(source, async () => {
    if (purchaseOrderId) {
      await pool.query('DELETE FROM procurement_document_approvals WHERE document_kind=? AND document_id=?', ['orders', purchaseOrderId]);
      await pool.query('DELETE FROM procurement_order_items WHERE purchase_order_id=?', [purchaseOrderId]);
      await pool.query('DELETE FROM procurement_orders WHERE id=?', [purchaseOrderId]);
    }
    if (requisitionId) {
      await pool.query('DELETE FROM procurement_document_approvals WHERE document_kind=? AND document_id=?', ['requisitions', requisitionId]);
      await pool.query('DELETE FROM procurement_requisition_items WHERE requisition_id=?', [requisitionId]);
      await pool.query('DELETE FROM procurement_requisitions WHERE id=?', [requisitionId]);
    }
    if (gatedPurchaseOrderId) {
      await pool.query('DELETE FROM procurement_document_approvals WHERE document_kind=? AND document_id=?', ['orders', gatedPurchaseOrderId]);
      await pool.query('DELETE FROM procurement_order_items WHERE purchase_order_id=?', [gatedPurchaseOrderId]);
      await pool.query('DELETE FROM procurement_orders WHERE id=?', [gatedPurchaseOrderId]);
    }
    if (gatedRequisitionId) {
      await pool.query('DELETE FROM procurement_document_approvals WHERE document_kind=? AND document_id=?', ['requisitions', gatedRequisitionId]);
      await pool.query('DELETE FROM procurement_requisition_items WHERE requisition_id=?', [gatedRequisitionId]);
      await pool.query('DELETE FROM procurement_requisitions WHERE id=?', [gatedRequisitionId]);
    }
    if (demandIds.length) await pool.query('DELETE FROM erp_sales_procurement_demands WHERE id IN (?)', [demandIds]);
    if (pickId) {
      await pool.query('DELETE FROM erp_sales_pick_list_items WHERE pick_list_id=?', [pickId]);
      await pool.query('DELETE FROM erp_sales_pick_lists WHERE id=?', [pickId]);
    }
    if (scheduleId) {
      await pool.query('DELETE FROM erp_sales_delivery_schedule_events WHERE schedule_id=?', [scheduleId]);
      await pool.query('DELETE FROM erp_sales_delivery_schedules WHERE id=?', [scheduleId]);
    }
    if (orderId) {
      await pool.query('DELETE FROM sales_document_items WHERE document_id=?', [orderId]);
      await pool.query('DELETE FROM sales_documents WHERE id=?', [orderId]);
    }
    if (contractId) {
      await pool.query('DELETE FROM erp_sales_contract_events WHERE contract_id=?', [contractId]);
      await pool.query('DELETE FROM erp_sales_contract_items WHERE contract_id=?', [contractId]);
      await pool.query('DELETE FROM erp_sales_contracts WHERE id=?', [contractId]);
    }
    if (priceId) {
      await pool.query('DELETE FROM erp_customer_item_price_events WHERE pricing_id=?', [priceId]);
      await pool.query('DELETE FROM erp_customer_item_price_tiers WHERE pricing_id=?', [priceId]);
      await pool.query('DELETE FROM erp_customer_item_prices WHERE id=?', [priceId]);
    }
    await pool.query('DELETE FROM sales_document_types WHERE source_database=? AND type_code=?', [source, typeCode]);
    await pool.query('DELETE FROM procurement_document_types WHERE source_database=? AND type_code IN (?)', [source, [requisitionTypeCode, purchaseTypeCode, gatedRequisitionTypeCode, gatedPurchaseTypeCode]]);
  });
}

try {
  const login = await request('/api/auth/login', json({
    username: process.env.ERP_AUDIT_USER || 'admin',
    password: process.env.ERP_AUDIT_PASSWORD || '12345678'
  }));
  assert(login.status === 200 && login.body.data?.token, `登入失敗：${login.body.error || login.status}`);
  token = login.body.data.token;
  const contexts = await request('/api/company-contexts');
  const current = (contexts.body.data || []).find(row => String(row.source_database).toUpperCase() === 'SH') || (contexts.body.data || [])[0];
  assert(current, '沒有可測試的公司上下文');
  source = String(current.source_database).toUpperCase();
  company = String(current.company_id || source);
  const switched = await request('/api/auth/context', json({ source_key: source }));
  assert(switched.status === 200, `公司切換失敗：${switched.body.error || switched.status}`);

  const customers = await request(`/api/master/customers?db=${source}`);
  const customer = (customers.body.data || []).find(row => Number(row.is_active ?? 1) === 1) || (customers.body.data || [])[0];
  const items = await request(`/api/master/items?db=${source}`);
  const item = (items.body.data || [])[0];
  const suppliers = await request(`/api/master/suppliers?db=${source}`);
  const supplier = (suppliers.body.data || []).find(row => Number(row.is_active ?? 1) === 1) || (suppliers.body.data || [])[0];
  const currencies = await request(`/api/master/currencies?db=${source}`);
  const currency = (currencies.body.data || [])[0];
  assert(customer?.customer_code && item?.item_code && supplier?.supplier_code && currency?.currency_code, '目前公司缺少可供整合測試的客戶、品號、供應商或幣別');
  customerCode = customer.customer_code;
  itemCode = item.item_code;
  supplierCode = supplier.supplier_code;
  currencyCode = currency.currency_code;

  const batch = await request('/api/sales-workflow/customer-pricing/batch', json({
    batch_no: `T2BP${stamp}`,
    reason: 'S02～S07 整合測試，完成後清除',
    items: [{ customer_code: customerCode, item_code: itemCode, pricing_unit: item.unit || 'PCS', currency_code: currencyCode, unit_price: 123.45, effective_from: priceDate, discount_rate_pct: 5 }]
  }));
  assert(batch.status === 201 && batch.body.data?.ids?.length === 1, `S02 批次計價建立失敗：${batch.body.error || batch.status}`);
  priceId = Number(batch.body.data.ids[0]);
  const priceApprove = await request(`/api/sales-workflow/customer-pricing/${priceId}/approve`, json({ reason: 'S02 整合測試核准' }));
  assert(priceApprove.status === 200, `S02 批次計價核准失敗：${priceApprove.body.error || priceApprove.status}`);

  const docType = await request('/api/sales-workflow/document-types', json({ source_database: source, document_kind: 'sales_order', type_code: typeCode, type_name: 'S02～S07 整合測試單別', number_prefix: `${typeCode}-`, requires_approval: 0, note: '測試後刪除' }));
  assert(docType.status === 201, `整合測試單別建立失敗：${docType.body.error || docType.status}`);
  const requisitionType = await request('/api/procurement/document-types', json({ source_database: source, document_kind: 'requisition', type_code: requisitionTypeCode, type_name: 'S06 整合測試請購單別', number_prefix: `R${stamp}`, numbering_method: 'sequence', requires_approval: 0, auto_confirm: 1, note: '測試後刪除' }));
  assert(requisitionType.status === 201, `S06 整合測試請購單別建立失敗：${requisitionType.body.error || requisitionType.status}`);
  const purchaseType = await request('/api/procurement/document-types', json({ source_database: source, document_kind: 'purchase_order', type_code: purchaseTypeCode, type_name: 'S06 整合測試採購單別', number_prefix: `P${stamp}`, numbering_method: 'sequence', requires_approval: 0, auto_confirm: 1, note: '測試後刪除' }));
  assert(purchaseType.status === 201, `S06 整合測試採購單別建立失敗：${purchaseType.body.error || purchaseType.status}`);
  const gatedRequisitionType = await request('/api/procurement/document-types', json({ source_database: source, document_kind: 'requisition', type_code: gatedRequisitionTypeCode, type_name: 'S06 待核准請購單別', number_prefix: `G${stamp}`, numbering_method: 'sequence', requires_approval: 1, auto_confirm: 0, note: '測試後刪除' }));
  assert(gatedRequisitionType.status === 201, `S06 待核准請購單別建立失敗：${gatedRequisitionType.body.error || gatedRequisitionType.status}`);
  const gatedPurchaseType = await request('/api/procurement/document-types', json({ source_database: source, document_kind: 'purchase_order', type_code: gatedPurchaseTypeCode, type_name: 'S06 待核准採購單別', number_prefix: `H${stamp}`, numbering_method: 'sequence', requires_approval: 1, auto_confirm: 0, note: '測試後刪除' }));
  assert(gatedPurchaseType.status === 201, `S06 待核准採購單別建立失敗：${gatedPurchaseType.body.error || gatedPurchaseType.status}`);

  const contract = await request('/api/sales-workflow/contracts', json({
    contract_no: contractNo, customer_code: customerCode, contract_date: '2026-07-01', period_from: '2026-07-01', period_to: '2026-07-31', currency_code: currencyCode,
    items: [{ item_code: itemCode, quantity: 3, unit_price: 100, expected_date: '2026-07-10', unit: item.unit || 'PCS' }], note: 'S03～S07 整合測試，完成後清除'
  }));
  assert(contract.status === 201 && contract.body.data?.id, `S03 合約建立失敗：${contract.body.error || contract.status}`);
  contractId = Number(contract.body.data.id);
  const contractApprove = await request(`/api/sales-workflow/contracts/${contractId}/approve`, json({ reason: '整合測試核准' }));
  assert(contractApprove.status === 200 && contractApprove.body.data?.status === 'approved', `S03 合約核准失敗：${contractApprove.body.error || contractApprove.status}`);
  const contractLineId = Number(contractApprove.body.data.items?.[0]?.id);
  assert(contractLineId, 'S03 合約明細未回傳');
  const converted = await request(`/api/sales-workflow/contracts/${contractId}/convert`, json({ contract_item_id: contractLineId, quantity: 3, document_type: typeCode, document_date: '2026-07-02', note: '整合測試轉訂單' }));
  assert(converted.status === 201 && converted.body.data?.order_id, `S03 合約轉訂單失敗：${converted.body.error || converted.status}`);
  orderId = Number(converted.body.data.order_id);
  const contractAfter = await request(`/api/sales-workflow/contracts/${contractId}`);
  assert(Number(contractAfter.body.data?.remaining_quantity || 0) === 0 && contractAfter.body.data?.status === 'completed', 'S03 合約一對多轉單後剩餘量／結案狀態不正確');
  const closed = await request(`/api/sales-workflow/contracts/${contractId}/close`, json({ reason: '整合測試合約結案' }));
  assert(closed.status === 200 && closed.body.data?.status === 'closed', `S03 合約結案失敗：${closed.body.error || closed.status}`);

  const order = await request(`/api/sales-workflow/documents?document_kind=sales_order&limit=100`);
  const orderLine = (order.body.data || []).find(row => Number(row.id) === orderId);
  assert(orderLine, 'S03 轉出的訂單未在目前公司別訂單查詢中出現');
  const schedule = await request('/api/sales-workflow/delivery-schedules', json({ order_item_id: Number(orderLine.item_id), scheduled_date: '2026-07-05', quantity: 1, note: 'S04 整合測試' }));
  assert(schedule.status === 201 && schedule.body.data?.id, `S04 交期排程建立失敗：${schedule.body.error || schedule.status}`);
  scheduleId = Number(schedule.body.data.id);
  const scheduleApprove = await request(`/api/sales-workflow/delivery-schedules/${scheduleId}/approve`, json({ reason: '整合測試核准' }));
  assert(scheduleApprove.status === 200, `S04 交期排程核准失敗：${scheduleApprove.body.error || scheduleApprove.status}`);
  const scheduleReconcile = await request(`/api/sales-workflow/delivery-schedules/${scheduleId}/reconcile`, json({}));
  assert(scheduleReconcile.status === 200 && Number(scheduleReconcile.body.data?.target?.fulfilled_quantity || 0) === 0, 'S04 未出貨排程不應被誤認為已履約');

  const exceptions = await request('/api/sales-workflow/exceptions?from_date=2026-07-01&to_date=2026-07-31&as_of=2026-07-31');
  assert(exceptions.status === 200 && Array.isArray(exceptions.body.data?.rows) && exceptions.body.data?.source_database === source && exceptions.body.data?.criteria?.as_of === '2026-07-31', 'S05 例外查詢格式不正確');

  const pick = await request(`/api/sales-workflow/orders/${orderId}/pick-lists`, json({ pick_date: '2026-07-03', items: [{ order_item_id: Number(orderLine.item_id), quantity: 1 }], note: 'S06 整合測試' }));
  assert(pick.status === 201 && pick.body.data?.id, `S06 揀貨單建立失敗：${pick.body.error || pick.status}`);
  pickId = Number(pick.body.data.id);
  const pickApprove = await request(`/api/sales-workflow/pick-lists/${pickId}/approve`, json({}));
  assert(pickApprove.status === 200, `S06 揀貨單核准失敗：${pickApprove.body.error || pickApprove.status}`);
  const pickComplete = await request(`/api/sales-workflow/pick-lists/${pickId}/complete`, json({}));
  assert(pickComplete.status === 200 && pickComplete.body.data?.status === 'picked', `S06 揀貨完成失敗：${pickComplete.body.error || pickComplete.status}`);
  const gatedDemand = await request(`/api/sales-workflow/orders/${orderId}/procurement-demands`, json({ items: [{ order_item_id: Number(orderLine.item_id), quantity: 1, reason: 'S06 待核准分支測試', supplier_code: supplierCode, requisition_document_type: gatedRequisitionTypeCode, purchase_document_type: gatedPurchaseTypeCode, currency_code: currencyCode, unit_price: 77, expected_date: '2026-07-16', warehouse_code: orderLine.warehouse_code || '' }], demand_date: '2026-07-05', supplier_code: supplierCode, requisition_document_type: gatedRequisitionTypeCode, purchase_document_type: gatedPurchaseTypeCode, currency_code: currencyCode, unit_price: 77, expected_date: '2026-07-16', warehouse_code: orderLine.warehouse_code || '' }));
  assert(gatedDemand.status === 201 && gatedDemand.body.data?.ids?.length === 1, `S06 待核准分支需求建立失敗：${gatedDemand.body.error || gatedDemand.status}`);
  gatedDemandId = Number(gatedDemand.body.data.ids[0]);
  demandIds.push(gatedDemandId);
  const gatedSubmit = await request(`/api/sales-workflow/procurement-demands/${gatedDemandId}/submit`, json({}));
  assert(gatedSubmit.status === 200 && gatedSubmit.body.data?.status === 'pending', `S06 待核准分支送審失敗：${JSON.stringify(gatedSubmit.body)}`);
  const gatedApprove = await request(`/api/sales-workflow/procurement-demands/${gatedDemandId}/approve`, json({ supplier_code: supplierCode, requisition_document_type: gatedRequisitionTypeCode, purchase_document_type: gatedPurchaseTypeCode, currency_code: currencyCode, unit_price: 77, expected_date: '2026-07-16', warehouse_code: orderLine.warehouse_code || '' }));
  assert(gatedApprove.status === 200 && gatedApprove.body.data?.status === 'converted', `S06 待核准分支需求核准失敗：${gatedApprove.body.error || gatedApprove.status}`);
  assert(gatedApprove.body.data.formal_requisition?.status === 'draft' && !gatedApprove.body.data.formal_purchase_order, 'S06 請購需核准時不可提前建立正式採購');
  gatedRequisitionId = Number(gatedApprove.body.data.formal_requisition.id || gatedApprove.body.data.formal_requisition.requisition_id);
  gatedRequisitionItemId = Number(gatedApprove.body.data.formal_requisition.requisition_item_id || 0);
  assert(gatedRequisitionId && gatedRequisitionItemId && gatedApprove.body.data.next_stage === '等待正式請購核准', 'S06 待核准請購的來源鍵／下一階段不正確');
  const gatedRequisitionApprove = await request(`/api/procurement/documents/requisitions/${gatedRequisitionId}/approve`, json({ source_database: source, note: 'S06 待核准分支請購核准' }));
  assert(gatedRequisitionApprove.status === 200, `S06 正式請購核准失敗：${gatedRequisitionApprove.body.error || gatedRequisitionApprove.status}`);
  const gatedConvert = await request(`/api/sales-workflow/procurement-demands/${gatedDemandId}/convert`, json({ supplier_code: supplierCode, requisition_document_type: gatedRequisitionTypeCode, purchase_document_type: gatedPurchaseTypeCode, currency_code: currencyCode, unit_price: 77, expected_date: '2026-07-16', warehouse_code: orderLine.warehouse_code || '' }));
  assert(gatedConvert.status === 200 && gatedConvert.body.data?.formal_purchase_order?.status === 'draft', `S06 請購核准後建立待核准採購失敗：${gatedConvert.body.error || gatedConvert.status}`);
  assert(Number(gatedConvert.body.data.quantities?.pending_purchase_approval_quantity) === 1 && gatedConvert.body.data.next_stage === '等待正式採購核准', 'S06 待核准採購的剩餘量／下一階段不正確');
  gatedPurchaseOrderId = Number(gatedConvert.body.data.formal_purchase_order.id);
  const gatedPurchaseApprove = await request(`/api/procurement/documents/orders/${gatedPurchaseOrderId}/approve`, json({ source_database: source, note: 'S06 待核准分支採購核准' }));
  assert(gatedPurchaseApprove.status === 200, `S06 正式採購核准失敗：${gatedPurchaseApprove.body.error || gatedPurchaseApprove.status}`);
  const gatedAfterApproval = await request(`/api/sales-workflow/procurement-demands/${gatedDemandId}/convert`, json({ supplier_code: supplierCode, requisition_document_type: gatedRequisitionTypeCode, purchase_document_type: gatedPurchaseTypeCode, currency_code: currencyCode, unit_price: 77, expected_date: '2026-07-16', warehouse_code: orderLine.warehouse_code || '' }));
  assert(gatedAfterApproval.status === 200 && gatedAfterApproval.body.data?.formal_purchase_order?.status === 'confirmed', 'S06 採購核准後正式狀態未回寫');
  assert(Number(gatedAfterApproval.body.data.quantities?.confirmed_purchase_quantity) === 1 && Number(gatedAfterApproval.body.data.quantities?.remaining_to_purchase) === 0, 'S06 採購核准後雙向數量未回寫');
  const demand = await request(`/api/sales-workflow/orders/${orderId}/procurement-demands`, json({ items: [{ order_item_id: Number(orderLine.item_id), quantity: 1, reason: 'S06 整合測試缺料', supplier_code: supplierCode, requisition_document_type: requisitionTypeCode, purchase_document_type: purchaseTypeCode, currency_code: currencyCode, unit_price: 88, expected_date: '2026-07-15', warehouse_code: orderLine.warehouse_code || '' }], demand_date: '2026-07-04', supplier_code: supplierCode, requisition_document_type: requisitionTypeCode, purchase_document_type: purchaseTypeCode, currency_code: currencyCode, unit_price: 88, expected_date: '2026-07-15', warehouse_code: orderLine.warehouse_code || '' }));
  assert(demand.status === 201 && demand.body.data?.ids?.length === 1, `S06 採購需求建立失敗：${demand.body.error || demand.status}`);
  const standardDemandId = Number(demand.body.data.ids[0]);
  demandIds.push(standardDemandId);
  const demandSubmit = await request(`/api/sales-workflow/procurement-demands/${standardDemandId}/submit`, json({}));
  assert(demandSubmit.status === 200 && demandSubmit.body.data?.status === 'pending', 'S06 採購需求送審失敗');
  const demandApprove = await request(`/api/sales-workflow/procurement-demands/${standardDemandId}/approve`, json({ supplier_code: supplierCode, requisition_document_type: requisitionTypeCode, purchase_document_type: purchaseTypeCode, currency_code: currencyCode, unit_price: 88, expected_date: '2026-07-15', warehouse_code: orderLine.warehouse_code || '' }));
  const convertedDemand = demandApprove.body.data;
  assert(demandApprove.status === 200 && convertedDemand?.status === 'converted', `S06 採購需求核准失敗：${demandApprove.body.error || demandApprove.status}`);
  assert(convertedDemand.formal_requisition?.requisition_no && convertedDemand.formal_purchase_order?.purchase_order_no, 'S06 核准後未建立正式請購／採購單號');
  requisitionId = Number(convertedDemand.formal_requisition.id || convertedDemand.formal_requisition.requisition_id);
  requisitionItemId = Number(convertedDemand.formal_requisition.requisition_item_id || 0);
  purchaseOrderId = Number(convertedDemand.formal_purchase_order.id);
  assert(requisitionId && purchaseOrderId, 'S06 正式請購／採購識別碼未回傳');
  assert(Number(convertedDemand.quantities?.formal_purchase_quantity) === 1 && Number(convertedDemand.quantities?.remaining_to_purchase) === 0, 'S06 正式採購數量與未轉量回寫不正確');
  assert(convertedDemand.source?.order_no && convertedDemand.source?.order_item_id === Number(orderLine.item_id), 'S06 正式採購來源訂單追蹤鍵不正確');
  const demandList = await request(`/api/sales-workflow/procurement-demands?source_database=${source}&order_id=${orderId}`);
  const convertedRow = (demandList.body.data || []).find(row => Number(row.id) === standardDemandId);
  assert(convertedRow?.formal_requisition?.requisition_no === convertedDemand.formal_requisition.requisition_no && convertedRow?.formal_purchase_order?.purchase_order_no === convertedDemand.formal_purchase_order.purchase_order_no, 'S06 缺料需求查詢未回傳正式單號');

  const printed = await request(`/api/sales-workflow/documents/${orderId}/print`);
  assert(printed.status === 200 && printed.body.data?.document?.id === orderId && Array.isArray(printed.body.data?.items), `S07 列印資料失敗：${printed.body.error || printed.status}`);
  const exported = await request(`/api/sales-workflow/documents/export?document_kind=sales_order&from_date=2026-07-01&to_date=2026-07-31&limit=100`);
  assert(exported.status === 200 && exported.body.data?.csv?.includes(typeCode) && exported.body.data?.filename, `S07 匯出資料失敗：${exported.body.error || exported.status}`);
  const other = (contexts.body.data || []).find(row => String(row.source_database).toUpperCase() !== source);
  if (other) {
    const cross = await request(`/api/sales-workflow/contracts?source_database=${encodeURIComponent(String(other.source_database).toUpperCase())}`);
    assert(cross.status === 409, 'S02～S07 跨公司查詢未被固定公司上下文攔截');
  }
  console.log(`S02-S07 integrated sales verification passed for ${source}.`);
} catch (error) {
  console.error(`S02-S07 integrated sales verification failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  try { await cleanup(); } catch (error) { console.error(`S02-S07 cleanup failed: ${error.message}`); process.exitCode = 1; }
  await pool.end().catch(() => {});
  process.exit(process.exitCode || 0);
}
