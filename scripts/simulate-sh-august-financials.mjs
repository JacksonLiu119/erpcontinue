import 'dotenv/config';

const baseUrl = String(process.env.ERP_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const sourceDatabase = 'SH';
const marker = 'SIM_SH_202608_FINANCIALS_V1';
const itemCode = 'SIMSH2608I';
const supplierCode = 'SIMSH2608S';
const customerCode = 'SIMSH2608C';
const fromDate = '2026-08-01';
const toDate = '2026-08-31';
const purchaseQuantity = 10;
const salesQuantity = 4;
const count = 20;
const EPS = 0.000001;

let token = '';
let companyId = '';
let currentContext = null;
let simulationCurrency = 'TWD';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

function asNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function asText(value) {
  return String(value ?? '').trim();
}

function statusOf(row) {
  return asText(row?.status || row?.document_status || row?.voucher_status).toLowerCase();
}

function idOf(value, fields = ['id', 'document_id', 'source_document_id']) {
  const row = value?.data && typeof value.data === 'object' ? value.data : value;
  for (const field of fields) {
    const id = asNumber(row?.[field]);
    if (id) return id;
  }
  return 0;
}

function dataOf(body) {
  if (body && body.data !== undefined) return body.data;
  return body;
}

function rowsOf(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of ['rows', 'items', 'documents', 'results', 'contexts', 'data']) {
    if (Array.isArray(value[key])) return value[key];
  }
  if (value.data && typeof value.data === 'object') return rowsOf(value.data);
  return [];
}

function jsonErrorBody(body) {
  try { return JSON.stringify(body); } catch (_) { return String(body); }
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (currentContext) {
    headers.set('X-ERP-Context-Key', sourceDatabase);
    headers.set('X-Source-Database', sourceDatabase);
    headers.set('X-Company-Id', companyId);
  }
  const fetchOptions = { ...options, headers };
  delete fetchOptions.json;
  if (options.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    fetchOptions.body = JSON.stringify(options.json);
  }
  const response = await fetch(`${baseUrl}${path}`, fetchOptions);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || (body?.ok === false && response.status >= 400)) {
    const error = new Error(`${options.method || 'GET'} ${path}：HTTP ${response.status} ${body?.error || body?.message || jsonErrorBody(body)}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return { status: response.status, body, data: dataOf(body) };
}

async function get(path) {
  return (await request(path)).data;
}

async function maybeGet(path) {
  try { return await get(path); } catch (error) {
    if (error.status === 404) return [];
    throw error;
  }
}

async function post(path, json) {
  return (await request(path, { method: 'POST', json })).data;
}

async function put(path, json) {
  return (await request(path, { method: 'PUT', json })).data;
}

function rowId(row, fields = ['id', 'document_id']) {
  return idOf(row, fields);
}

function hasMarker(row, value) {
  const haystack = [row?.note, row?.reason, row?.memo, row?.description, row?.batch_no]
    .map(asText).join('|');
  return haystack.includes(value);
}

function sameId(row, fields, expected) {
  return fields.some(field => asNumber(row?.[field]) === asNumber(expected));
}

function firstActive(rows) {
  return rows.find(row => Number(row.is_active ?? row.active ?? 1) === 1) || rows[0];
}

function typeKind(row) {
  return asText(row?.document_kind || row?.kind || row?.type_kind || row?.document_type_kind).toLowerCase();
}

function typeCode(row) {
  return asText(row?.type_code || row?.document_type || row?.code);
}

function selectDocumentType(rows, wanted, aliases = []) {
  const terms = [wanted, ...aliases].map(value => String(value).toLowerCase());
  const matching = rows.filter(row => {
    const kind = typeKind(row);
    const code = typeCode(row).toLowerCase();
    return terms.some(term => kind === term || kind.includes(term) || code === term);
  });
  const candidates = matching.length ? matching : rows;
  assert(candidates.length, `目前公司沒有可使用的${wanted}單別`);
  return candidates.find(row => Number(row.is_active ?? 1) === 1 && Number(row.requires_approval ?? 0) === 0)
    || candidates.find(row => Number(row.is_active ?? 1) === 1)
    || candidates[0];
}

async function ensureItem() {
  const rows = rowsOf(await get(`/api/master/items?db=${sourceDatabase}&keyword=${encodeURIComponent(itemCode)}`));
  let item = rows.find(row => asText(row.item_code || row.code) === itemCode);
  if (!item) {
    const created = await post('/api/master/items', {
      source_database: sourceDatabase,
      item_code: itemCode,
      item_name: '仙暉 2026/08 模擬測試品',
      specification: 'SIM-202608',
      unit: 'PCS',
      category_1: '',
      category_2: '',
      category_3: '',
      category_4: '',
    });
    item = created;
  }
  assert(itemCode === asText(item?.item_code || item?.code) || idOf(item), '模擬品號建立／查詢失敗');
  return { ...item, item_code: item.item_code || item.code || itemCode, unit: item.unit || 'PCS' };
}

async function ensureSupplier() {
  const rows = rowsOf(await get(`/api/master/suppliers?db=${sourceDatabase}&keyword=${encodeURIComponent(supplierCode)}`));
  let supplier = rows.find(row => asText(row.supplier_code || row.code) === supplierCode);
  if (!supplier) {
    supplier = await post('/api/master/suppliers', {
      source_database: sourceDatabase,
      supplier_code: supplierCode,
      short_name: '仙暉模擬廠商',
      supplier_name: '仙暉 2026/08 模擬廠商',
      supplier_class: '',
      responsible_person: '',
      contact_name: '',
      phone: '',
      fax: '',
      email: '',
      mobile: '',
      tax_id: '',
      currency_code: simulationCurrency,
      payment_method: 'CASH',
      payment_term_code: '',
      payment_term_source_value: '',
      invoice_type: '',
      tax_type: '',
      closing_month_offset: 0,
      closing_day: '31',
    });
  }
  if (supplier && asText(supplier.currency_code || '').toUpperCase() !== simulationCurrency) {
    supplier = await put(`/api/master/suppliers/${encodeURIComponent(supplierCode)}?source_database=${sourceDatabase}`, {
      source_database: sourceDatabase,
      short_name: supplier.short_name || '仙暉模擬廠商',
      supplier_name: supplier.supplier_name || '仙暉 2026/08 模擬廠商',
      supplier_class: supplier.supplier_class,
      responsible_person: supplier.responsible_person,
      contact_name: supplier.contact_name,
      phone: supplier.phone,
      fax: supplier.fax,
      email: supplier.email,
      mobile: supplier.mobile,
      tax_id: supplier.tax_id,
      currency_code: simulationCurrency,
      payment_method: supplier.payment_method || 'CASH',
      payment_term_code: supplier.payment_term_code,
      payment_term_source_value: supplier.payment_term_source_value,
      invoice_type: supplier.invoice_type,
      tax_type: supplier.tax_type,
      closing_month_offset: supplier.closing_month_offset || 0,
      closing_day: supplier.closing_day || '31',
    });
  }
  assert(supplierCode === asText(supplier?.supplier_code || supplier?.code) || idOf(supplier), '模擬廠商建立／查詢失敗');
  return { ...supplier, supplier_code: supplier.supplier_code || supplier.code || supplierCode };
}

async function ensureCustomer() {
  let rows = rowsOf(await get(`/api/master/customers?db=${sourceDatabase}&keyword=${encodeURIComponent(customerCode)}`));
  let customer = rows.find(row => asText(row.customer_code || row.code) === customerCode);
  if (customer && asText(customer.currency_code || '').toUpperCase() !== simulationCurrency) {
    const existingRequests = rowsOf(await maybeGet(`/api/sales-workflow/customer-controls/requests?source_database=${sourceDatabase}&limit=200`));
    let currencyRequest = existingRequests.find(row => hasMarker(row, `${marker}|CUSTOMER_CURRENCY`) && asText(row.customer_code) === customerCode);
    let currencyRequestId = rowId(currencyRequest);
    if (!currencyRequestId) {
      currencyRequest = await post('/api/sales-workflow/customer-controls/requests', {
        source_database: sourceDatabase,
        request_kind: 'change',
        customer_code: customerCode,
        short_name: customer.short_name || '仙暉模擬客戶',
        customer_name: customer.customer_name || '仙暉 2026/08 模擬客戶',
        responsible_person: customer.responsible_person,
        contact_name: customer.contact_name,
        phone: customer.phone,
        fax: customer.fax,
        email: customer.email,
        mobile: customer.mobile,
        tax_id: customer.tax_id,
        currency_code: simulationCurrency,
        payment_term_code: customer.payment_term_code,
        invoice_type: customer.invoice_type,
        tax_type: customer.tax_type,
        closing_day: customer.closing_day || '31',
        credit_limit: customer.credit_limit || 0,
        credit_policy: customer.credit_policy || 'warning',
        is_active: customer.is_active ?? 1,
        reason: `${marker}|CUSTOMER_CURRENCY`,
      });
      currencyRequestId = rowId(currencyRequest);
    }
    assert(currencyRequestId, '模擬客戶幣別變更申請未回傳 ID');
    if (statusOf(currencyRequest) === 'draft') currencyRequest = await post(`/api/sales-workflow/customer-controls/requests/${currencyRequestId}/submit`, {});
    if (['draft', 'pending', 'submitted', 'review'].includes(statusOf(currencyRequest))) {
      await post(`/api/sales-workflow/customer-controls/requests/${currencyRequestId}/approve`, {
        source_database: sourceDatabase,
        review_note: `${marker} 客戶幣別調整為 ${simulationCurrency}`,
      });
    }
    rows = rowsOf(await get(`/api/master/customers?db=${sourceDatabase}&keyword=${encodeURIComponent(customerCode)}`));
    customer = rows.find(row => asText(row.customer_code || row.code) === customerCode);
  }
  if (customer) return { ...customer, customer_code: customer.customer_code || customer.code || customerCode };

  const requests = rowsOf(await maybeGet(`/api/sales-workflow/customer-controls/requests?source_database=${sourceDatabase}&limit=200`));
  let requestRow = requests.find(row => hasMarker(row, marker) && asText(row.customer_code) === customerCode);
  let requestId = rowId(requestRow);
  if (!requestId) {
    const created = await post('/api/sales-workflow/customer-controls/requests', {
      source_database: sourceDatabase,
      request_kind: 'new',
      customer_code: customerCode,
      short_name: '仙暉模擬客戶',
      customer_name: '仙暉 2026/08 模擬客戶',
      currency_code: simulationCurrency,
      closing_day: '31',
      credit_limit: 0,
      credit_policy: 'warning',
      is_active: 1,
      reason: marker,
    });
    requestId = rowId(created);
    requestRow = created;
  }
  assert(requestId, '模擬客戶申請單未回傳 ID');
  const requestStatus = statusOf(requestRow);
  if (requestStatus === 'draft') {
    requestRow = await post(`/api/sales-workflow/customer-controls/requests/${requestId}/submit`, {});
  }
  const submittedStatus = statusOf(requestRow);
  if (['draft', 'pending', 'submitted', 'review'].includes(submittedStatus)) {
    requestRow = await post(`/api/sales-workflow/customer-controls/requests/${requestId}/approve`, {
      source_database: sourceDatabase,
      review_note: `${marker} 核准`,
    });
  }
  rows = rowsOf(await get(`/api/master/customers?db=${sourceDatabase}&keyword=${encodeURIComponent(customerCode)}`));
  customer = rows.find(row => asText(row.customer_code || row.code) === customerCode);
  assert(customer, '模擬客戶核准後未出現在目標主檔');
  return { ...customer, customer_code: customer.customer_code || customer.code || customerCode };
}

async function ensureWarehouse() {
  const rows = rowsOf(await get(`/api/master/warehouses?db=${sourceDatabase}`));
  const warehouse = firstActive(rows);
  assert(warehouse, '目前公司沒有可用庫別');
  return { ...warehouse, warehouse_code: warehouse.warehouse_code || warehouse.code };
}

async function ensureCurrency() {
  const rows = rowsOf(await get(`/api/master/currencies?db=${sourceDatabase}`));
  // 仙暉來源的台幣主檔代號是 NTD；若未來公司別已有 TWD，才優先採用 TWD。
  const currency = rows.find(row => asText(row.currency_code || row.code).toUpperCase() === 'TWD')
    || rows.find(row => asText(row.currency_code || row.code).toUpperCase() === 'NTD')
    || firstActive(rows);
  assert(currency, '目前公司沒有可用幣別');
  simulationCurrency = asText(currency.currency_code || currency.code).toUpperCase();
  assert(simulationCurrency, '目前公司幣別代號為空白');
  return { ...currency, currency_code: simulationCurrency };
}

async function ensurePurchase(i, types, master) {
  const suffix = String(i).padStart(2, '0');
  const note = `${marker}|P${suffix}`;
  const expectedCost = 100 + i;
  let requisitions = rowsOf(await get(`/api/procurement/documents/requisitions?source_database=${sourceDatabase}&limit=200`));
  let requisition = requisitions.find(row => hasMarker(row, note));
  let requisitionId = rowId(requisition, ['id', 'requisition_id', 'document_id']);
  if (!requisitionId) {
    requisition = await post('/api/procurement/requisitions', {
      source_database: sourceDatabase,
      document_type: typeCode(types.requisition),
      requisition_date: `2026-08-${suffix}`,
      requester_code: 'SIMUSER',
      department_code: '',
      warehouse_code: master.warehouse.warehouse_code,
      item_code: itemCode,
      item_name: master.item.item_name || '仙暉 2026/08 模擬測試品',
      specification: master.item.specification || 'SIM-202608',
      unit: master.item.unit || 'PCS',
      qty_requested: purchaseQuantity,
      required_date: `2026-08-${suffix}`,
      note,
    });
    requisitionId = rowId(requisition, ['id', 'requisition_id', 'document_id']);
  }
  assert(requisitionId, `P${suffix} 請購未回傳 ID`);
  if (!['approved', 'confirmed', 'converted', 'closed'].includes(statusOf(requisition))) {
    requisition = await post(`/api/procurement/documents/requisitions/${requisitionId}/approve`, { source_database: sourceDatabase });
  }

  let orders = rowsOf(await get(`/api/procurement/documents/orders?source_database=${sourceDatabase}&limit=500`));
  let order = orders.find(row => hasMarker(row, note) || sameId(row, ['source_line_id', 'requisition_item_id'], requisitionId));
  let maintenance = rowsOf(await get(`/api/procurement/requisition-maintenance?source_database=${sourceDatabase}&limit=500`));
  let requisitionLine = maintenance.find(row => sameId(row, ['requisition_id', 'document_id'], requisitionId) && asText(row.item_code) === itemCode);
  // 已轉單的請購明細不再出現在「待轉採購」查詢，續跑時使用採購單保存的來源明細鍵。
  const convertedRequisitionLineId = rowId(order, ['source_line_id', 'requisition_item_id']);
  if (!requisitionLine && convertedRequisitionLineId) requisitionLine = { id: convertedRequisitionLineId, item_code: itemCode, already_converted: true };
  assert(requisitionLine, `P${suffix} 請購明細查無資料`);
  const requisitionLineId = rowId(requisitionLine, ['id', 'requisition_item_id', 'item_id']);
  if (!requisitionLineId) throw new Error(`P${suffix} 請購明細未回傳 ID`);
  if (!requisitionLine.already_converted) {
    await put(`/api/procurement/requisition-lines/${requisitionLineId}/maintenance`, {
      source_database: sourceDatabase,
      suggested_supplier_code: supplierCode,
      suggested_unit_price: expectedCost,
      required_date: `2026-08-${suffix}`,
      purchase_locked: 1,
      note,
    });
  }

  orders = rowsOf(await get(`/api/procurement/documents/orders?source_database=${sourceDatabase}&limit=200`));
  order = orders.find(row => hasMarker(row, note) || sameId(row, ['source_line_id', 'requisition_item_id'], requisitionLineId));
  let orderId = rowId(order, ['id', 'purchase_order_id', 'document_id']);
  if (!orderId) {
    const converted = await post(`/api/procurement/requisition-lines/${requisitionLineId}/convert`, {
      source_database: sourceDatabase,
      document_type: typeCode(types.purchaseOrder),
      order_date: `2026-08-${suffix}`,
      expected_date: `2026-08-${suffix}`,
      supplier_code: supplierCode,
      currency_code: simulationCurrency,
      qty_ordered: purchaseQuantity,
      unit_price: expectedCost,
      note,
    });
    order = converted;
    orderId = rowId(converted, ['id', 'purchase_order_id', 'document_id']);
  }
  assert(orderId, `P${suffix} 採購單未回傳 ID`);
  if (statusOf(order) === 'draft') {
    order = await post(`/api/procurement/documents/orders/${orderId}/approve`, { source_database: sourceDatabase });
  }

  let receipts = rowsOf(await get(`/api/procurement/documents/receipts?source_database=${sourceDatabase}&limit=500`));
  let receipt = receipts.find(row => hasMarker(row, note));
  let orderLines = rowsOf(await get(`/api/procurement/order-lines?source_database=${sourceDatabase}&limit=500`));
  const orderDocumentNo = asText(order.document_no || order.purchase_order_no);
  let orderLine = orderLines.find(row => sameId(row, ['purchase_order_id', 'order_id', 'document_id'], orderId)
    || (orderDocumentNo && asText(row.purchase_order_no) === orderDocumentNo)
    || hasMarker(row, note));
  let purchaseOrderItemId = rowId(orderLine, ['id', 'purchase_order_item_id', 'item_id']);
  if (!purchaseOrderItemId && receipt) purchaseOrderItemId = asNumber(receipt.source_line_id || receipt.purchase_order_item_id);
  assert(purchaseOrderItemId || receipt, `P${suffix} 採購明細 ID 未取得`);
  if (!receipt) {
    assert(purchaseOrderItemId, `P${suffix} 建立進貨前無法取得採購明細 ID`);
    receipt = await post('/api/procurement/receipts', {
      source_database: sourceDatabase,
      document_type: typeCode(types.receipt),
      purchase_order_item_id: purchaseOrderItemId,
      receipt_date: `2026-08-${suffix}`,
      arrival_date: `2026-08-${suffix}`,
      supplier_code: supplierCode,
      warehouse_code: master.warehouse.warehouse_code,
      item_code: itemCode,
      item_name: master.item.item_name || '仙暉 2026/08 模擬測試品',
      specification: master.item.specification || 'SIM-202608',
      unit: master.item.unit || 'PCS',
      qty_received: purchaseQuantity,
      unit_cost: expectedCost,
      freight_amount: 0,
      insurance_amount: 0,
      other_expense_amount: 0,
      note,
    });
  }
  const receiptId = rowId(receipt, ['id', 'receipt_id', 'document_id']);
  assert(receiptId, `P${suffix} 進貨單未回傳 ID`);

  const receiptStatus = statusOf(receipt);
  const accepted = asNumber(receipt.qty_accepted || receipt.accepted_quantity);
  if (!['accepted', 'partially_accepted'].includes(receiptStatus) || accepted < purchaseQuantity - EPS) {
    receipt = await post(`/api/procurement/receipts/${receiptId}/inspect`, {
      source_database: sourceDatabase,
      qty_accepted: purchaseQuantity,
      qty_rejected: 0,
      inspection_note: `${note} 驗收合格`,
    });
  }
  const inventoryStatus = asText(receipt.inventory_status || receipt.stock_status).toLowerCase();
  if (!['posted', 'completed', 'confirmed'].includes(inventoryStatus)) {
    receipt = await post(`/api/inventory-workflow/procurement/receipt/${receiptId}/post`, { source_database: sourceDatabase });
  }

  receipts = rowsOf(await get(`/api/procurement/documents/receipts?source_database=${sourceDatabase}&limit=500`));
  receipt = receipts.find(row => rowId(row, ['id', 'receipt_id', 'document_id']) === receiptId) || receipt;
  const receiptItemId = rowId(receipt, ['receipt_item_id', 'item_id', 'id']);
  const qtyPriced = asNumber(receipt.qty_priced || receipt.priced_quantity);
  if (!receiptItemId) throw new Error(`P${suffix} 進貨明細未回傳 ID`);
  if (qtyPriced < purchaseQuantity - EPS) {
    await put(`/api/procurement/receipts/${receiptId}/pricing`, {
      source_database: sourceDatabase,
      receipt_item_id: receiptItemId,
      qty_priced: purchaseQuantity,
      freight_amount: 0,
      insurance_amount: 0,
      other_expense_amount: 0,
      reason: `${note} 計價完成`,
    });
  }
  await ensureFinanceFlow({ accountType: 'AP', documentId: receiptId, documentItemId: receiptItemId, partyCode: supplierCode, date: `2026-08-${suffix}`, note });
  return { requisitionId, orderId, receiptId, quantity: purchaseQuantity, unitCost: expectedCost };
}

async function ensureSale(i, types, master) {
  const suffix = String(i).padStart(2, '0');
  const note = `${marker}|S${suffix}`;
  const unitPrice = 500 + i;
  const unitCost = 100 + i;
  let documents = rowsOf(await get(`/api/sales-workflow/documents?source_database=${sourceDatabase}&limit=500`));
  let order = documents.find(row => hasMarker(row, note) && /sales_order|order/.test(asText(row.document_kind).toLowerCase()));
  let orderId = rowId(order, ['id', 'document_id']);
  if (!orderId) {
    order = await post('/api/sales-workflow/documents', {
      source_database: sourceDatabase,
      document_kind: 'sales_order',
      document_type: typeCode(types.salesOrder),
      document_date: `2026-08-${suffix}`,
      customer_code: customerCode,
      item_code: itemCode,
      item_name: master.item.item_name || '仙暉 2026/08 模擬測試品',
      specification: master.item.specification || 'SIM-202608',
      unit: master.item.unit || 'PCS',
      quantity: salesQuantity,
      unit_price: unitPrice,
      unit_cost: unitCost,
      warehouse_code: master.warehouse.warehouse_code,
      currency_code: simulationCurrency,
      note,
    });
    orderId = rowId(order, ['id', 'document_id']);
  }
  assert(orderId, `S${suffix} 銷售訂單未回傳 ID`);
  if (statusOf(order) === 'draft') {
    order = await post(`/api/sales-workflow/documents/${orderId}/approve`, { source_database: sourceDatabase });
  }

  documents = rowsOf(await get(`/api/sales-workflow/documents?source_database=${sourceDatabase}&limit=500`));
  order = documents.find(row => rowId(row, ['id', 'document_id']) === orderId) || order;
  const orderItemId = rowId(order, ['item_id', 'document_item_id', 'sales_order_item_id']);
  assert(orderItemId, `S${suffix} 銷售訂單明細未回傳 ID`);
  let shipment = documents.find(row => hasMarker(row, note) && /shipment|delivery|sales_issue/.test(asText(row.document_kind).toLowerCase()))
    || documents.find(row => sameId(row, ['source_item_id', 'source_document_item_id'], orderItemId)
      && /shipment|delivery|sales_issue/.test(asText(row.document_kind).toLowerCase()));
  let shipmentId = rowId(shipment, ['id', 'document_id']);
  if (!shipmentId && asNumber(order.related_quantity || order.shipped_quantity || order.qty_shipped) < salesQuantity - EPS) {
    shipment = await post(`/api/sales-workflow/items/${orderItemId}/convert`, {
      source_database: sourceDatabase,
      document_type: typeCode(types.shipment),
      document_date: `2026-08-${suffix}`,
      warehouse_code: master.warehouse.warehouse_code,
      quantity: salesQuantity,
      unit_cost: unitCost,
      note,
    });
    shipmentId = rowId(shipment, ['id', 'document_id']);
  }
  assert(shipmentId, `S${suffix} 銷貨單未回傳 ID`);
  if (statusOf(shipment) === 'draft') {
    shipment = await post(`/api/sales-workflow/documents/${shipmentId}/approve`, { source_database: sourceDatabase });
  }
  if (!['posted', 'completed', 'confirmed'].includes(statusOf(shipment))) {
    shipment = await post(`/api/sales-workflow/documents/${shipmentId}/post`, { source_database: sourceDatabase });
  }
  documents = rowsOf(await get(`/api/sales-workflow/documents?source_database=${sourceDatabase}&limit=500`));
  shipment = documents.find(row => rowId(row, ['id', 'document_id']) === shipmentId) || shipment;
  const shipmentItemId = rowId(shipment, ['item_id', 'document_item_id', 'shipment_item_id']);
  assert(shipmentItemId, `S${suffix} 銷貨明細未回傳 ID`);
  await ensureFinanceFlow({ accountType: 'AR', documentId: shipmentId, documentItemId: shipmentItemId, partyCode: customerCode, date: `2026-08-${suffix}`, note });
  return { orderId, shipmentId, quantity: salesQuantity, unitPrice };
}

async function ensureFinanceFlow({ accountType, documentId, documentItemId, partyCode, date, note }) {
  const voucherRows = rowsOf(await maybeGet(`/api/finance-workflow/vouchers?source_database=${sourceDatabase}&account_type=${accountType}&limit=500`));
  let voucher = voucherRows.find(row => hasMarker(row, note));
  let voucherId = rowId(voucher, ['id', 'voucher_id', 'document_id']);
  let openItemId = asNumber(voucher?.open_item_id || voucher?.finance_open_item_id);
  const settlementRows = rowsOf(await maybeGet(`/api/finance-workflow/settlements?source_database=${sourceDatabase}&account_type=${accountType}&limit=500`));
  let settlement = settlementRows.find(row => hasMarker(row, note));
  let settlementId = rowId(settlement, ['id', 'settlement_id', 'document_id']);
  // 續跑時，先前已完成的帳款在 open-items 查詢中不再出現；
  // 只要憑單與收付款都已過帳，就直接補確認收付款分錄並視為完成，避免重複立帳。
  if (voucherId && ['approved', 'posted'].includes(statusOf(voucher)) && settlementId && ['posted', 'completed', 'confirmed'].includes(statusOf(settlement))) {
    let existingSettlementJournal = await post('/api/accounting/journals/transfer', {
      source_database: sourceDatabase,
      settlement_id: settlementId,
      memo: `${note} ${accountType} 收付款分錄續檢`,
    });
    const existingSettlementJournalId = rowId(existingSettlementJournal, ['id', 'journal_id']);
    if (existingSettlementJournalId && statusOf(existingSettlementJournal) === 'draft') {
      existingSettlementJournal = await post(`/api/accounting/journals/${existingSettlementJournalId}/post`, { source_database: sourceDatabase });
    }
    return { voucherId, openItemId, settlementId, settlementJournalId: existingSettlementJournalId, alreadyComplete: true };
  }
  if (!voucherId) {
    const sourceRows = rowsOf(await get(`/api/finance-workflow/source-documents?source_database=${sourceDatabase}&account_type=${accountType}&limit=500`));
    const sourceRow = sourceRows.find(row => sameId(row, ['source_document_id', 'document_id'], documentId)
      && sameId(row, ['source_document_item_id', 'document_item_id'], documentItemId)
      && asNumber(row.remaining_amount) > EPS);
    assert(sourceRow, `${note} 找不到可立帳的${accountType}來源明細`);
    const documentTypes = rowsOf(await get(`/api/finance-workflow/document-types?source_database=${sourceDatabase}&account_type=${accountType}&document_kind=open_item`));
    const documentType = selectDocumentType(documentTypes, 'open_item', ['voucher', 'invoice']);
    voucher = await post('/api/finance-workflow/vouchers-enhanced', {
      source_database: sourceDatabase,
      account_type: accountType,
      document_type: typeCode(documentType),
      voucher_date: date,
      due_date: date,
      party_code: partyCode,
      currency_code: asText(sourceRow.currency_code || simulationCurrency).toUpperCase(),
      settlement_mode: 'direct',
      source_rows: [{
        source_kind: sourceRow.source_kind,
        source_document_id: asNumber(sourceRow.source_document_id || documentId),
        source_document_item_id: asNumber(sourceRow.source_document_item_id || documentItemId),
        allocated_amount: asNumber(sourceRow.remaining_amount),
      }],
      note,
    });
    voucherId = rowId(voucher, ['id', 'voucher_id', 'document_id']);
  }
  assert(voucherId, `${note} ${accountType} 憑單未回傳 ID`);
  if (statusOf(voucher) === 'draft') {
    const approved = await post(`/api/finance-workflow/vouchers/${voucherId}/approve-enhanced`, { source_database: sourceDatabase });
    openItemId = asNumber(approved?.open_item_id || approved?.id || openItemId);
  }
  if (!openItemId) {
    const openItems = rowsOf(await maybeGet(`/api/finance-workflow/open-items?source_database=${sourceDatabase}&account_type=${accountType}&limit=500`));
    const openItem = openItems.find(row => sameId(row, ['source_document_id', 'voucher_id', 'source_voucher_id'], voucherId) || hasMarker(row, note));
    openItemId = rowId(openItem, ['id', 'open_item_id']);
  }
  assert(openItemId, `${note} ${accountType} 核准後未產生應收／應付帳款`);

  let journal = await post('/api/accounting/journals/transfer', {
    source_database: sourceDatabase,
    open_item_id: openItemId,
    memo: `${note} ${accountType} 立帳分錄`,
  });
  const journalId = rowId(journal, ['id', 'journal_id']);
  if (journalId && statusOf(journal) === 'draft') {
    journal = await post(`/api/accounting/journals/${journalId}/post`, { source_database: sourceDatabase });
  }

  if (!settlementId) {
    const openItems = rowsOf(await maybeGet(`/api/finance-workflow/open-items?source_database=${sourceDatabase}&account_type=${accountType}&limit=500`));
    const openItem = openItems.find(row => rowId(row, ['id', 'open_item_id']) === openItemId);
    const remaining = asNumber(openItem?.remaining_amount || openItem?.balance_amount || openItem?.amount || openItem?.original_amount);
    assert(remaining > EPS, `${note} ${accountType} 沒有可結帳餘額`);
    const settlementTypes = rowsOf(await get(`/api/finance-workflow/document-types?source_database=${sourceDatabase}&account_type=${accountType}&document_kind=settlement`));
    const settlementType = selectDocumentType(settlementTypes, 'settlement', ['receipt', 'payment']);
    settlement = await post('/api/finance-workflow/settlements-enhanced', {
      source_database: sourceDatabase,
      settlement_date: date,
      document_type: typeCode(settlementType),
      payment_method: 'bank',
      allocations: [{ open_item_id: openItemId, allocated_amount: remaining }],
      note,
    });
    settlementId = rowId(settlement, ['id', 'settlement_id', 'document_id']);
  }
  assert(settlementId, `${note} ${accountType} 收付款單未回傳 ID`);
  if (!['posted', 'completed', 'confirmed'].includes(statusOf(settlement))) {
    settlement = await post(`/api/finance-workflow/settlements/${settlementId}/post-enhanced`, { source_database: sourceDatabase });
  }
  let settlementJournal = await post('/api/accounting/journals/transfer', {
    source_database: sourceDatabase,
    settlement_id: settlementId,
    memo: `${note} ${accountType} 收付款分錄`,
  });
  const settlementJournalId = rowId(settlementJournal, ['id', 'journal_id']);
  if (settlementJournalId && statusOf(settlementJournal) === 'draft') {
    settlementJournal = await post(`/api/accounting/journals/${settlementJournalId}/post`, { source_database: sourceDatabase });
  }
  return { voucherId, openItemId, settlementId, journalId, settlementJournalId };
}

async function loginAndSelectContext() {
  const login = await request('/api/auth/login', {
    method: 'POST',
    json: {
      username: process.env.ERP_AUDIT_USER || 'admin',
      password: process.env.ERP_AUDIT_PASSWORD || '12345678',
    },
  });
  token = asText(login.data?.token);
  assert(token, '登入失敗：未取得工作階段 token');
  const contexts = rowsOf((await request('/api/company-contexts')).data);
  const context = contexts.find(row => asText(row.source_database).toUpperCase() === sourceDatabase);
  assert(context, `找不到 ${sourceDatabase} 公司上下文，停止以避免誤寫其他公司`);
  companyId = asText(context.company_id || sourceDatabase);
  const switched = await post('/api/auth/context', { source_key: sourceDatabase });
  assert(switched, `切換 ${sourceDatabase} 公司上下文失敗`);
  currentContext = context;
  return context;
}

async function validateFinancialStatements() {
  const result = await get(`/api/accounting/financial-statements?source_database=${sourceDatabase}&from_date=${fromDate}&to_date=${toDate}&limit=1000`);
  const payload = result?.data && typeof result.data === 'object' ? result.data : result;
  assert(payload?.checks, '三大財報 API 未回傳檢核結果');
  assert(payload.checks.complete, `三大財報整體檢核未通過：${(payload.warnings || []).join('；')}`);
  assert(payload.checks.journals_balanced, '目標 ERP 傳票借貸不平衡');
  assert(payload.checks.period_journals_balanced, '本期傳票借貸不平衡');
  assert(payload.checks.balance_sheet_balanced, '資產負債表不平衡');
  assert(payload.checks.cash_flow_reconciled, '現金流量表與現金科目不一致');
  assert(payload.checks.cash_flow_classification_complete, '現金流量表仍有未分類傳票');
  assert(asNumber(payload.source_check?.period_voucher_count) >= count * 4, '8 月已過帳傳票筆數不足，未形成完整進銷及收付款分錄');
  assert((payload.profit_and_loss?.rows || []).length > 0, '損益表沒有收入／費用科目');
  assert((payload.balance_sheet?.rows || []).length > 0, '資產負債表沒有資產／負債／權益科目');
  assert((payload.cash_flow?.categories || []).some(row => asNumber(row.net) !== 0), '現金流量表沒有活動分類金額');
  return payload;
}

async function main() {
  const context = await loginAndSelectContext();
  const item = await ensureItem();
  const warehouse = await ensureWarehouse();
  const currency = await ensureCurrency();
  const supplier = await ensureSupplier();
  const customer = await ensureCustomer();
  const master = { item, supplier, customer, warehouse, currency };
  const procurementTypes = rowsOf(await get(`/api/procurement/document-types?source_database=${sourceDatabase}`));
  const salesTypes = rowsOf(await get(`/api/sales-workflow/document-types?source_database=${sourceDatabase}`));
  const types = {
    requisition: selectDocumentType(procurementTypes, 'requisition', ['purchase_requisition']),
    purchaseOrder: selectDocumentType(procurementTypes, 'purchase_order', ['purchase-order', 'order']),
    receipt: selectDocumentType(procurementTypes, 'receipt', ['purchase_receipt', 'arrival', 'inbound']),
    salesOrder: selectDocumentType(salesTypes, 'sales_order', ['order']),
    shipment: selectDocumentType(salesTypes, 'shipment', ['sales_shipment', 'delivery']),
  };
  console.log(`開始 ${sourceDatabase} 2026-08 模擬：20 筆進貨＋20 筆銷貨；資料標記 ${marker}`);
  const purchases = [];
  const sales = [];
  for (let i = 1; i <= count; i += 1) {
    const purchase = await ensurePurchase(i, types, master);
    const sale = await ensureSale(i, types, master);
    purchases.push(purchase);
    sales.push(sale);
    console.log(`已完成 ${String(i).padStart(2, '0')}/20：進貨 ${purchase.receiptId}／銷貨 ${sale.shipmentId}（驗收、庫存過帳、計價、立帳、收付款與分錄）`);
  }
  const financial = await validateFinancialStatements();
  const summary = {
    ok: true,
    source_database: sourceDatabase,
    company_id: asText(context.company_id || sourceDatabase),
    target_database: financial.target_database,
    period: '2026-08',
    purchase_count: purchases.length,
    sales_count: sales.length,
    purchase_quantity: purchases.reduce((sum, row) => sum + row.quantity, 0),
    sales_quantity: sales.reduce((sum, row) => sum + row.quantity, 0),
    profit_and_loss: financial.profit_and_loss?.totals,
    balance_sheet: financial.balance_sheet?.totals,
    cash_flow: {
      opening_cash: financial.cash_flow?.opening_cash,
      ending_cash: financial.cash_flow?.ending_cash,
      cash_change: financial.cash_flow?.cash_change,
      reconciliation_difference: financial.cash_flow?.reconciliation_difference,
      categories: financial.cash_flow?.categories,
    },
    checks: financial.checks,
    cleanup: '資料刻意保留，待使用者確認報表後再清除；SH 原始資料庫未寫入。',
  };
  console.log(JSON.stringify(summary, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error.message,
    marker,
    source_database: sourceDatabase,
    cleanup: '未執行清除；若已建立部分資料，請保留供續跑／檢查。',
  }, null, 2));
  process.exitCode = 1;
} finally {
  if (token) {
    try { await request('/api/auth/logout', { method: 'POST' }); } catch (_) { /* 登出失敗不影響驗證結果 */ }
  }
}
