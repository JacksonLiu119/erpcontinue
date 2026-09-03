import 'dotenv/config';
import mysql from 'mysql2/promise';

const API = 'http://127.0.0.1:3000/api';
const SOURCE = 'SC';
const DATE = '2026-08-26';
const MARKER = 'VERIFY:R03:PROCUREMENT-CLOSURE:20260826';
const config = { host:process.env.DB_HOST||'127.0.0.1', port:Number(process.env.DB_PORT||3306), user:process.env.DB_USER||'root', password:process.env.DB_PASSWORD||'', database:process.env.DB_NAME||'inventory_erp' };
const assert = (value, message) => { if (!value) throw new Error(message); };

async function login() {
  const response = await fetch(`${API}/auth/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:'admin',password:'12345678'}) });
  const result = await response.json();
  if (!response.ok || result.ok === false) throw new Error(result.error || '登入失敗');
  return result.data.token;
}
async function switchContext(token, sourceKey) {
  const response = await fetch(`${API}/auth/context`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_key: sourceKey }),
  });
  const result = await response.json();
  if (!response.ok || result.ok === false) throw new Error(result.error || '公司上下文切換失敗');
  return result.data ?? result;
}
async function request(token,path,method='GET',body) {
  const response = await fetch(`${API}${path}`, { method, headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})}, body:body?JSON.stringify(body):undefined });
  const result = await response.json();
  if (!response.ok || result.ok === false) throw new Error(result.error || response.statusText);
  return result.data ?? result;
}
async function fails(action, text) { try { await action(); } catch (error) { assert(String(error.message).includes(text), `預期「${text}」，實際「${error.message}」`); return; } throw new Error(`預期失敗：${text}`); }

async function cleanup(target) {
  await target.query('DELETE FROM procurement_receipt_pricing_events WHERE reason=?',[MARKER]);
  const [settlements] = await target.query('SELECT id FROM finance_settlements WHERE note=?',[MARKER]);
  if (settlements.length) await target.query('DELETE FROM finance_allocations WHERE settlement_id IN (?)',[settlements.map(row=>row.id)]);
  if (settlements.length) await target.query('DELETE FROM finance_settlements WHERE id IN (?)',[settlements.map(row=>row.id)]);
  const [vouchers] = await target.query('SELECT id FROM finance_vouchers WHERE note=?',[MARKER]);
  if (vouchers.length) await target.query("DELETE FROM finance_open_items WHERE source_kind='finance_voucher' AND source_document_id IN (?)",[vouchers.map(row=>row.id)]);
  if (vouchers.length) await target.query('DELETE FROM finance_vouchers WHERE id IN (?)',[vouchers.map(row=>row.id)]);
  const [documents] = await target.query('SELECT id,document_no FROM inventory_documents WHERE note=?',[MARKER]);
  if (documents.length) {
    await target.query('DELETE FROM inventory_movement_ledger WHERE document_no IN (?)',[documents.map(row=>row.document_no)]);
    await target.query('DELETE FROM inventory_document_items WHERE document_id IN (?)',[documents.map(row=>row.id)]);
    await target.query('DELETE FROM inventory_documents WHERE id IN (?)',[documents.map(row=>row.id)]);
  }
  const [returns] = await target.query('SELECT id FROM procurement_returns WHERE note=?',[MARKER]);
  if (returns.length) await target.query('DELETE FROM procurement_returns WHERE id IN (?)',[returns.map(row=>row.id)]);
  const [receipts] = await target.query('SELECT id FROM procurement_receipts WHERE note=?',[MARKER]);
  if (receipts.length) await target.query('DELETE FROM procurement_receipts WHERE id IN (?)',[receipts.map(row=>row.id)]);
  const [orders] = await target.query('SELECT id FROM procurement_orders WHERE note=?',[MARKER]);
  if (orders.length) await target.query('DELETE FROM procurement_orders WHERE id IN (?)',[orders.map(row=>row.id)]);
}

const db = await mysql.createConnection(config);
let target;
try {
  const [[source]] = await db.query("SELECT target_database FROM erp_data_sources WHERE source_key=?",[SOURCE]);
  assert(source?.target_database, '找不到 SC 目標資料庫');
  target = await mysql.createConnection({...config,database:source.target_database});
  await cleanup(target);
  const token = await login();
  await switchContext(token, SOURCE);
  const types = await request(token,`/procurement/document-types?source_database=${SOURCE}`);
  const type = kind => types.find(row=>row.document_kind===kind && Number(row.is_active));
  const poType=type('purchase_order'), receiptType=type('receipt'), returnType=type('purchase_return');
  assert(poType&&receiptType&&returnType,'SC 缺少採購、進貨或退貨單別');
  const [[warehouse]] = await target.query('SELECT warehouse_code FROM erp_warehouses WHERE source_database=? ORDER BY warehouse_code LIMIT 1',[SOURCE]);
  const warehouseCode=warehouse?.warehouse_code||'140';
  const po=await request(token,'/procurement/orders','POST',{source_database:SOURCE,document_type:poType.type_code,order_date:DATE,supplier_code:'R03-SUP',item_code:'R03-ITEM',item_name:'採購閉環驗證品',warehouse_code:warehouseCode,unit:'PCS',qty_ordered:10,unit_price:12,note:MARKER});
  await request(token,`/procurement/documents/orders/${po.id}/approve`,'POST',{source_database:SOURCE});
  const [[line]]=await target.query('SELECT id FROM procurement_order_items WHERE purchase_order_id=?',[po.id]);
  const receipt=await request(token,'/procurement/receipts','POST',{source_database:SOURCE,document_type:receiptType.type_code,purchase_order_item_id:line.id,receipt_date:DATE,arrival_date:DATE,supplier_code:'R03-SUP',warehouse_code:warehouseCode,item_code:'R03-ITEM',item_name:'採購閉環驗證品',unit:'PCS',qty_received:6,unit_cost:12,freight_amount:6,note:MARKER});
  await fails(()=>request(token,'/procurement/receipts','POST',{source_database:SOURCE,document_type:receiptType.type_code,purchase_order_item_id:line.id,receipt_date:DATE,supplier_code:'R03-SUP',warehouse_code:warehouseCode,item_code:'R03-ITEM',qty_received:5,unit_cost:12,note:MARKER}),'不可超過採購未交量');
  await request(token,`/procurement/receipts/${receipt.id}/inspect`,'POST',{source_database:SOURCE,qty_accepted:5,qty_rejected:1,inspection_note:MARKER});
  await request(token,`/inventory-workflow/procurement/receipt/${receipt.id}/post`,'POST',{source_database:SOURCE});
  const [[receiptItem]]=await target.query('SELECT id FROM procurement_receipt_items WHERE receipt_id=?',[receipt.id]);
  const listedReceipt=(await request(token,`/procurement/documents/receipts?source_database=${SOURCE}&limit=100`)).find(row=>Number(row.id)===Number(receipt.id));
  assert(listedReceipt&&Number(listedReceipt.receipt_item_id)===Number(receiptItem.id),'進貨明細查詢未回傳可計價的明細識別碼');
  const pricedFirst=await request(token,`/procurement/receipts/${receipt.id}/pricing`,'PUT',{source_database:SOURCE,receipt_item_id:receiptItem.id,qty_priced:5,freight_amount:6,insurance_amount:0,other_expense_amount:0,reason:MARKER});
  assert(pricedFirst.lines?.[0]&&Number(pricedFirst.lines[0].qty_priced)===5,'進貨計價量未與驗收合格量分開保存');
  const [[pricedReceiptCheck]]=await target.query('SELECT qty_received,qty_accepted,qty_rejected,qty_priced,qty_paid FROM procurement_receipt_items WHERE receipt_id=?',[receipt.id]);
  assert(Number(pricedReceiptCheck.qty_received)===6&&Number(pricedReceiptCheck.qty_accepted)===5&&Number(pricedReceiptCheck.qty_rejected)===1&&Number(pricedReceiptCheck.qty_priced)===5&&Number(pricedReceiptCheck.qty_paid)===0,'到貨／驗收／計價／付款數量欄位未分離');
  const returnable=await request(token,`/procurement/returnable-receipts?source_database=${SOURCE}`);
  const receiptLine=returnable.find(row=>row.receipt_no===receipt.documentNo);
  assert(receiptLine && Number(receiptLine.returnable_quantity)===5,'已入庫合格量未成為可退量');
  const physicalReturn=await request(token,'/procurement/returns','POST',{source_database:SOURCE,document_type:returnType.type_code,return_type:'return',receipt_item_id:receiptLine.receipt_item_id,return_date:DATE,return_quantity:2,reason:MARKER,note:MARKER});
  const [[createdReturn]]=await target.query('SELECT id,status,return_no FROM procurement_returns WHERE id=?',[physicalReturn.id]);
  assert(createdReturn?.status==='draft',`退貨草稿狀態異常：${JSON.stringify(createdReturn)}`);
  await request(token,`/procurement/returns/${physicalReturn.id}/approve`,'POST',{source_database:SOURCE});
  const [[beforePost]]=await target.query('SELECT qty_received FROM procurement_order_items WHERE id=?',[line.id]);
  assert(Number(beforePost.qty_received)===5,'退貨未過帳前不應回沖採購已交量');
  const [[returnBeforePost]]=await target.query('SELECT priced_quantity FROM procurement_return_items WHERE return_id=?',[physicalReturn.id]);
  assert(Number(returnBeforePost.priced_quantity)===2,'已計價進貨的退貨未分配已計價退回量');
  await request(token,`/inventory-workflow/procurement/return/${physicalReturn.id}/post`,'POST',{source_database:SOURCE});
  const [[afterPost]]=await target.query('SELECT qty_received FROM procurement_order_items WHERE id=?',[line.id]);
  assert(Number(afterPost.qty_received)===3,'退貨過帳後採購已交量未正確回沖');
  const [[returnedPricing]]=await target.query('SELECT qty_returned,qty_returned_priced,qty_priced FROM procurement_receipt_items WHERE id=?',[receiptLine.receipt_item_id]);
  assert(Number(returnedPricing.qty_returned)===2&&Number(returnedPricing.qty_returned_priced)===2&&Number(returnedPricing.qty_priced)===5,'退貨未同步已退量與已計價退回量');

  const receipt2=await request(token,'/procurement/receipts','POST',{source_database:SOURCE,document_type:receiptType.type_code,purchase_order_item_id:line.id,receipt_date:DATE,arrival_date:DATE,supplier_code:'R03-SUP',warehouse_code:warehouseCode,item_code:'R03-ITEM',item_name:'採購閉環驗證品',unit:'PCS',qty_received:3,unit_cost:12,freight_amount:3,insurance_amount:1,other_expense_amount:1,note:MARKER});
  await request(token,`/procurement/receipts/${receipt2.id}/inspect`,'POST',{source_database:SOURCE,qty_accepted:3,qty_rejected:0,inspection_note:MARKER});
  await request(token,`/inventory-workflow/procurement/receipt/${receipt2.id}/post`,'POST',{source_database:SOURCE});
  const [[receipt2Item]]=await target.query('SELECT id FROM procurement_receipt_items WHERE receipt_id=?',[receipt2.id]);
  const pricedSecond=await request(token,`/procurement/receipts/${receipt2.id}/pricing`,'PUT',{source_database:SOURCE,receipt_item_id:receipt2Item.id,qty_priced:3,freight_amount:3,insurance_amount:1,other_expense_amount:1,reason:MARKER});
  assert(pricedSecond.lines?.[0]&&Number(pricedSecond.lines[0].priced_amount)===41,'第二筆進貨的運費／保險／其他費用未納入計價');
  const sources=await request(token,`/finance-workflow/source-documents?source_database=${SOURCE}&account_type=AP&limit=100`);
  const firstSource=sources.find(row=>row.source_kind==='purchase_receipt'&&Number(row.source_document_id)===Number(receipt.id));
  const secondSource=sources.find(row=>row.source_kind==='purchase_receipt'&&Number(row.source_document_id)===Number(receipt2.id));
  const returnSource=sources.find(row=>row.source_kind==='purchase_return'&&Number(row.source_document_id)===Number(physicalReturn.id));
  assert(firstSource&&Math.abs(Number(firstSource.amount)-66)<0.0001&&Number(firstSource.quantity)===5,'第一筆進貨未依已計價量與運費產生應付來源');
  assert(secondSource&&Math.abs(Number(secondSource.amount)-41)<0.0001&&Number(secondSource.quantity)===3,'第二筆進貨未依計價量與費用產生應付來源');
  assert(returnSource&&Number(returnSource.amount)<0&&Math.abs(Number(returnSource.amount)+26.4)<0.0001&&Number(returnSource.quantity)===2,'退貨未依已計價退回量產生負向應付來源');
  const apVoucher=await request(token,'/finance-workflow/vouchers','POST',{source_database:SOURCE,account_type:'AP',document_type:'AP61',voucher_date:DATE,due_date:'2026-09-26',party_code:'R03-SUP',currency_code:'TWD',settlement_mode:'batch',source_rows:[
    {source_kind:'purchase_receipt',source_document_id:receipt.id,source_document_item_id:receiptLine.receipt_item_id,allocated_amount:Number(firstSource.remaining_amount)},
    {source_kind:'purchase_receipt',source_document_id:receipt2.id,source_document_item_id:receipt2Item.id,allocated_amount:Number(secondSource.remaining_amount)},
    {source_kind:'purchase_return',source_document_id:physicalReturn.id,source_document_item_id:returnSource.source_document_item_id,allocated_amount:Number(returnSource.remaining_amount)}
  ],note:MARKER});
  assert(Number(apVoucher.total_amount.toFixed?.(2)||apVoucher.total_amount)===80.6,'多筆進貨／退貨合併應付金額錯誤');
  const apApproval=await request(token,`/finance-workflow/vouchers/${apVoucher.id}/approve?source_database=${SOURCE}`,'POST',{source_database:SOURCE});
  const [[apOpenBefore]]=await target.query('SELECT original_amount,balance_amount,status FROM finance_open_items WHERE id=?',[apApproval.open_item_id]);
  assert(Math.abs(Number(apOpenBefore.original_amount)-80.6)<0.0001&&Number(apOpenBefore.balance_amount)===80.6&&apOpenBefore.status==='open','合併應付未建立未付帳款');
  const partialPayment=await request(token,'/finance-workflow/settlements','POST',{source_database:SOURCE,account_type:'AP',document_type:'AP64',settlement_date:'2026-08-30',party_code:'R03-SUP',currency_code:'TWD',allocations:[{open_item_id:apApproval.open_item_id,allocated_amount:40}],note:MARKER});
  await request(token,`/finance-workflow/settlements/${partialPayment.id}/post`,'POST',{source_database:SOURCE});
  const [[apOpenPartial]]=await target.query('SELECT balance_amount,status FROM finance_open_items WHERE id=?',[apApproval.open_item_id]);
  assert(Math.abs(Number(apOpenPartial.balance_amount)-40.6)<0.0001&&apOpenPartial.status==='partial','合併應付部分付款未保留未付餘額');
  const [[paidPartial]]=await target.query('SELECT qty_paid FROM procurement_receipt_items WHERE id=?',[receipt2Item.id]);
  assert(Number(paidPartial.qty_paid)>0&&Number(paidPartial.qty_paid)<3,'付款後未回寫進貨明細付款量');
  const finalPayment=await request(token,'/finance-workflow/settlements','POST',{source_database:SOURCE,account_type:'AP',document_type:'AP64',settlement_date:'2026-08-31',party_code:'R03-SUP',currency_code:'TWD',allocations:[{open_item_id:apApproval.open_item_id,allocated_amount:40.6}],note:MARKER});
  await request(token,`/finance-workflow/settlements/${finalPayment.id}/post`,'POST',{source_database:SOURCE});
  const [[apOpenAfter]]=await target.query('SELECT balance_amount,status FROM finance_open_items WHERE id=?',[apApproval.open_item_id]);
  assert(Math.abs(Number(apOpenAfter.balance_amount))<0.0001&&apOpenAfter.status==='settled','合併應付完成付款後未結清');
  const [[paidAfter]]=await target.query('SELECT qty_paid,qty_priced FROM procurement_receipt_items WHERE id=?',[receipt2Item.id]);
  assert(Math.abs(Number(paidAfter.qty_paid)-Number(paidAfter.qty_priced))<0.0001,'完成付款後付款量未回寫為已計價量');
  const inventoryTypes=await request(token,`/inventory-workflow/document-types?source_database=${SOURCE}`),tempIn=inventoryTypes.find(row=>row.movement_kind==='temp_in'),tempInReturn=inventoryTypes.find(row=>row.movement_kind==='temp_in_return');
  assert(tempIn&&tempInReturn,'SC 缺少暫入／暫入歸還單別');
  const temp=await request(token,'/inventory-workflow/documents','POST',{source_database:SOURCE,document_type:tempIn.type_code,document_date:DATE,item_code:'R03-TEMP',item_name:'暫入驗證品',unit:'PCS',to_warehouse_code:warehouseCode,quantity:3,unit_cost:1,counterparty:'R03-SUP',note:MARKER});
  await request(token,`/inventory-workflow/documents/${temp.id}/approve`,'POST',{source_database:SOURCE}); await request(token,`/inventory-workflow/documents/${temp.id}/post`,'POST',{source_database:SOURCE});
  await fails(()=>request(token,'/inventory-workflow/documents','POST',{source_database:SOURCE,document_type:tempInReturn.type_code,document_date:DATE,related_document_id:temp.id,item_code:'R03-TEMP',unit:'PCS',to_warehouse_code:warehouseCode,quantity:4,note:MARKER}),'不可超過未歸還量');
  const returned=await request(token,'/inventory-workflow/documents','POST',{source_database:SOURCE,document_type:tempInReturn.type_code,document_date:DATE,related_document_id:temp.id,item_code:'R03-TEMP',item_name:'暫入驗證品',unit:'PCS',to_warehouse_code:warehouseCode,quantity:2,unit_cost:1,note:MARKER});
  await request(token,`/inventory-workflow/documents/${returned.id}/approve`,'POST',{source_database:SOURCE}); await request(token,`/inventory-workflow/documents/${returned.id}/post`,'POST',{source_database:SOURCE});
  const openTemporary=await request(token,`/inventory-workflow/temporary-open?source_database=${SOURCE}`);
  const tempOpen=openTemporary.find(row=>row.id===temp.id);
  assert(tempOpen && Number(tempOpen.remaining_quantity)===1,'暫入歸還未正確扣除未歸還量');
  console.log(JSON.stringify({ok:true,checked:['pending arrival reservation','inspection acceptance/rejection','到貨／驗收／計價／付款量分離','費用分攤計價','return post reopens PO','priced return negative AP source','多筆進貨／退貨合併應付','部分／完成付款與付款量回寫','temporary return balance']},null,2));
} finally { if (target) { await cleanup(target); await target.end(); } await db.end(); }
