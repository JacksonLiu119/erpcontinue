import 'dotenv/config';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { cleanup, TEST_ITEM, TEST_MARKER } from './cleanup-erp-flow.mjs';

const base='http://127.0.0.1:3000/api', date='2026-08-11', qty=10, sellQty=2, cost=30, price=50;
const db=await mysql.createConnection({host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER||'root',password:process.env.DB_PASSWORD||'',database:process.env.DB_NAME||'inventory_erp'});
await cleanup(db);
const [[admin]]=await db.query("SELECT id FROM access_users WHERE username='admin'");
const token=crypto.randomBytes(48).toString('base64url'), tokenHash=crypto.createHash('sha256').update(token).digest('hex');
await db.query(`INSERT INTO access_sessions(user_id,token_hash,expires_at) VALUES(?,?,DATE_ADD(NOW(),INTERVAL 1 HOUR))`,[admin.id,tokenHash]);
const api=async(path,method='GET',body)=>{const r=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const j=await r.json();if(!r.ok||j.ok===false)throw new Error(`${method} ${path}: ${j.error||r.status}`);return j.data??j;};
const step=[];
try {
  await db.query(`INSERT INTO erp_items(tenant_id,company_id,source_system,item_code,item_name,specification,unit,source_database,source_table,source_key) VALUES('SH','SH','iSM',?,'流程驗證品號','端對端流程測試','PCS','SH','FLOW_TEST',?)`,[TEST_ITEM,TEST_MARKER]);
  await db.query(`INSERT INTO erp_customers(source_database,tenant_id,company_id,source_system,customer_code,short_name,customer_name,currency_code,source_table,source_key) VALUES('SH','SH','SH','iSM','FLOW-CUST','流程客戶','流程驗證客戶','TWD','FLOW_TEST',?)`,[TEST_MARKER]);
  await db.query(`INSERT INTO erp_suppliers(source_database,tenant_id,company_id,source_system,supplier_code,short_name,supplier_name,currency_code,source_table,source_key) VALUES('SH','SH','SH','iSM','FLOW-SUPP','流程廠商','流程驗證廠商','TWD','FLOW_TEST',?)`,[TEST_MARKER]);
  step.push(['主檔',TEST_ITEM]);

  const rq=await api('/procurement/requisitions','POST',{source_database:'SH',document_type:'RQ',requisition_date:date,requester_code:'admin',department_code:'100',warehouse_code:'101',item_code:TEST_ITEM,item_name:'流程驗證品號',unit:'PCS',qty_requested:qty,required_date:date,note:TEST_MARKER});
  await api(`/procurement/documents/requisitions/${rq.id}/approve`,'POST',{}); const [[rqi]]=await db.query(`SELECT id FROM procurement_requisition_items WHERE requisition_id=?`,[rq.id]); step.push(['請購',rq.documentNo]);
  const po=await api('/procurement/orders','POST',{source_database:'SH',document_type:'3310',requisition_item_id:rqi.id,order_date:date,supplier_code:'FLOW-SUPP',expected_date:date,currency_code:'TWD',item_code:TEST_ITEM,item_name:'流程驗證品號',warehouse_code:'101',unit:'PCS',qty_ordered:qty,unit_price:cost,note:TEST_MARKER});
  await api(`/procurement/documents/orders/${po.id}/approve`,'POST',{}); const [[poi]]=await db.query(`SELECT id FROM procurement_order_items WHERE purchase_order_id=?`,[po.id]); step.push(['採購',po.documentNo]);
  const gr=await api('/procurement/receipts','POST',{source_database:'SH',document_type:'3411',purchase_order_item_id:poi.id,receipt_date:date,supplier_code:'FLOW-SUPP',warehouse_code:'101',item_code:TEST_ITEM,item_name:'流程驗證品號',unit:'PCS',qty_received:qty,unit_cost:cost,note:TEST_MARKER});
  await api(`/procurement/receipts/${gr.id}/inspect`,'POST',{qty_accepted:qty,qty_rejected:0,inspection_note:TEST_MARKER});
  await api(`/inventory-workflow/procurement/receipt/${gr.id}/post`,'POST',{}); step.push(['進貨驗收與庫存',gr.documentNo]);

  const quote=await api('/sales-workflow/documents','POST',{source_database:'SH',document_kind:'quotation',document_type:'QT',document_date:date,customer_code:'FLOW-CUST',warehouse_code:'101',item_code:TEST_ITEM,item_name:'流程驗證品號',unit:'PCS',quantity:sellQty,unit_price:price,unit_cost:cost,note:TEST_MARKER});
  await api(`/sales-workflow/documents/${quote.id}/approve`,'POST',{}); step.push(['報價',quote.document_no]);
  const so=await api(`/sales-workflow/items/${quote.item_id}/convert`,'POST',{document_date:date,warehouse_code:'101',quantity:sellQty});
  await api(`/sales-workflow/documents/${so.id}/approve`,'POST',{}); step.push(['訂單',so.document_no]);
  const ship=await api(`/sales-workflow/items/${so.item_id}/convert`,'POST',{document_date:date,warehouse_code:'101',quantity:sellQty,unit_cost:cost});
  await api(`/sales-workflow/documents/${ship.id}/approve`,'POST',{}); await api(`/sales-workflow/documents/${ship.id}/post`,'POST',{}); step.push(['銷貨與扣庫',ship.document_no]);

  const ar=await api('/finance-workflow/open-items','POST',{source_database:'SH',account_type:'AR',document_date:date,due_date:date,party_code:'FLOW-CUST',currency_code:'TWD',source_kind:'shipment',source_document_id:ship.id,source_document_no:ship.document_no,original_amount:sellQty*price,note:TEST_MARKER});
  await api(`/finance-workflow/open-items/${ar.id}/approve`,'POST',{}); step.push(['應收結帳',ar.document_no]);
  const ap=await api('/finance-workflow/open-items','POST',{source_database:'SH',account_type:'AP',document_date:date,due_date:date,party_code:'FLOW-SUPP',currency_code:'TWD',source_kind:'purchase_receipt',source_document_id:gr.id,source_document_no:gr.documentNo,original_amount:qty*cost,note:TEST_MARKER});
  await api(`/finance-workflow/open-items/${ap.id}/approve`,'POST',{}); step.push(['應付憑單',ap.document_no]);
  const rc=await api('/finance-workflow/settlements','POST',{document_type:'6301',open_item_id:ar.id,settlement_date:date,amount:sellQty*price,payment_method:'check',note:TEST_MARKER}); await api(`/finance-workflow/settlements/${rc.id}/post`,'POST',{}); step.push(['收款',rc.settlement_no]);
  const py=await api('/finance-workflow/settlements','POST',{document_type:'7301',open_item_id:ap.id,settlement_date:date,amount:qty*cost,payment_method:'check',note:TEST_MARKER}); await api(`/finance-workflow/settlements/${py.id}/post`,'POST',{}); step.push(['付款',py.settlement_no]);
  const arn=await api('/finance-workflow/notes','POST',{source_database:'SH',account_type:'AR',settlement_id:rc.id,note_type:'check',issue_date:date,due_date:'2026-09-11',amount:sellQty*price,bank_code:'TEST',memo:TEST_MARKER}); step.push(['應收票據',arn.note_no]);
  const apn=await api('/finance-workflow/notes','POST',{source_database:'SH',account_type:'AP',settlement_id:py.id,note_type:'check',issue_date:date,due_date:'2026-09-11',amount:qty*cost,bank_code:'TEST',memo:TEST_MARKER}); step.push(['應付票據',apn.note_no]);

  const [[balance]]=await db.query(`SELECT quantity_on_hand,unit_cost,inventory_amount FROM erp_inventory_balances WHERE tenant_id='SH' AND company_id='SH' AND source_system='iSM' AND item_code=? AND warehouse_code='101'`,[TEST_ITEM]);
  const [[arCheck]]=await db.query(`SELECT status,balance_amount FROM finance_open_items WHERE id=?`,[ar.id]); const [[apCheck]]=await db.query(`SELECT status,balance_amount FROM finance_open_items WHERE id=?`,[ap.id]);
  if(Number(balance?.quantity_on_hand)!==qty-sellQty)throw new Error(`庫存驗證失敗：${balance?.quantity_on_hand}`);
  if(arCheck.status!=='settled'||Number(arCheck.balance_amount)!==0||apCheck.status!=='settled'||Number(apCheck.balance_amount)!==0)throw new Error('應收應付沖銷驗證失敗');
  console.table(step.map(([stage,document])=>({stage,document})));
  console.log(JSON.stringify({ok:true,item_code:TEST_ITEM,inventory_quantity:Number(balance.quantity_on_hand),inventory_amount:Number(balance.inventory_amount),ar_status:arCheck.status,ap_status:apCheck.status,cleanup:'npm.cmd run cleanup:flow-test'}));
} finally { await db.query(`DELETE FROM access_sessions WHERE token_hash=?`,[tokenHash]); await db.end(); }
