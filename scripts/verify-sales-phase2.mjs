import 'dotenv/config';
import { pool, reloadSourceDatabases, runWithTargetDatabase } from '../src/db.js';

const baseUrl = String(process.env.ERP_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const stamp = Date.now().toString(36).toUpperCase();
const contractNo = `T2CT${stamp}`.slice(0, 60);
const typeCode = `T2${stamp}`.slice(0, 20);
const priceDate = '2099-01-01';
let token = '', source = '', company = '', customerCode = '', itemCode = '', currencyCode = 'TWD';
let contractId = 0, orderId = 0, priceId = 0, scheduleId = 0, pickId = 0, demandIds = [];
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
  const currencies = await request(`/api/master/currencies?db=${source}`);
  const currency = (currencies.body.data || [])[0];
  assert(customer?.customer_code && item?.item_code && currency?.currency_code, '目前公司缺少可供整合測試的客戶、品號或幣別');
  customerCode = customer.customer_code;
  itemCode = item.item_code;
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
  const demand = await request(`/api/sales-workflow/orders/${orderId}/procurement-demands`, json({ items: [{ order_item_id: Number(orderLine.item_id), quantity: 1, reason: 'S06 整合測試缺料' }], demand_date: '2026-07-04' }));
  assert(demand.status === 201 && demand.body.data?.ids?.length === 1, `S06 採購需求建立失敗：${demand.body.error || demand.status}`);
  demandIds = demand.body.data.ids.map(Number);
  const demandSubmit = await request(`/api/sales-workflow/procurement-demands/${demandIds[0]}/submit`, json({}));
  assert(demandSubmit.status === 200 && demandSubmit.body.data?.status === 'pending', 'S06 採購需求送審失敗');
  const demandApprove = await request(`/api/sales-workflow/procurement-demands/${demandIds[0]}/approve`, json({}));
  assert(demandApprove.status === 200 && demandApprove.body.data?.status === 'converted', 'S06 採購需求核准失敗');

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
