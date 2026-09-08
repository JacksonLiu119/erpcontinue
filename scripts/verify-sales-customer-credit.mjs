import 'dotenv/config';
import { pool, reloadSourceDatabases, runWithTargetDatabase } from '../src/db.js';

const baseUrl=String(process.env.ERP_BASE_URL||'http://127.0.0.1:3000').replace(/\/$/,'');
const stamp=Date.now().toString(36).toUpperCase();
const customerCode=('T'+stamp).slice(0,20);
const typeCode=('Z'+stamp).slice(0,18);
let token='',source='',company='',requestId=0,documentId=0;
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
async function request(path,options={}){
  const headers=new Headers(options.headers||{});
  if(token)headers.set('Authorization','Bearer '+token);
  if(source){headers.set('X-ERP-Context-Key',source);headers.set('X-Source-Database',source);headers.set('X-Company-Id',company);}
  const response=await fetch(baseUrl+path,{...options,headers});
  const body=await response.json().catch(()=>({}));
  return {status:response.status,body};
}
const json=body=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
async function cleanup(){
  if(!source)return;
  await reloadSourceDatabases();
  await runWithTargetDatabase(source,async()=>{
    if(documentId){await pool.query('DELETE FROM sales_credit_approval_requests WHERE document_id=?',[documentId]);await pool.query('DELETE FROM sales_document_items WHERE document_id=?',[documentId]);await pool.query('DELETE FROM sales_documents WHERE id=?',[documentId]);}
    if(requestId){await pool.query('DELETE FROM sales_customer_request_events WHERE request_id=?',[requestId]);await pool.query('DELETE FROM sales_customer_requests WHERE id=?',[requestId]);}
    await pool.query('DELETE FROM sales_document_types WHERE source_database=? AND type_code=?',[source,typeCode]);
    await pool.query('DELETE FROM erp_customers WHERE source_database=? AND customer_code=?',[source,customerCode]);
  });
}

try{
  const login=await request('/api/auth/login',json({username:process.env.ERP_AUDIT_USER||'admin',password:process.env.ERP_AUDIT_PASSWORD||'12345678'}));
  assert(login.status===200&&login.body.data?.token,'登入失敗：'+(login.body.error||login.status));
  token=login.body.data.token;
  const contexts=await request('/api/company-contexts');
  const current=(contexts.body.data||[]).find(x=>String(x.source_database).toUpperCase()==='SH')||(contexts.body.data||[])[0];
  assert(current,'沒有可測試的公司上下文');
  source=String(current.source_database).toUpperCase();company=String(current.company_id||source);
  const switched=await request('/api/auth/context',json({source_key:source}));
  assert(switched.status===200,'公司切換失敗');

  const created=await request('/api/sales-workflow/customer-controls/requests',json({source_database:source,request_kind:'new',customer_code:customerCode,customer_name:'S01 自動驗證客戶',short_name:'S01驗證',currency_code:'TWD',credit_limit:1,credit_policy:'approval',is_active:1,reason:'S01 自動回歸測試'}));
  assert(created.status===201&&created.body.data?.status==='draft','新客戶申請建立失敗：'+(created.body.error||created.status));
  requestId=Number(created.body.data.id);
  const submitted=await request(`/api/sales-workflow/customer-controls/requests/${requestId}/submit`,json({source_database:source,reason:'自動測試送審'}));
  assert(submitted.status===200&&submitted.body.data?.status==='pending','客戶申請送審失敗');
  const approved=await request(`/api/sales-workflow/customer-controls/requests/${requestId}/approve`,json({source_database:source,review_note:'自動測試核准'}));
  assert(approved.status===200&&approved.body.data?.status==='approved','客戶申請核准失敗：'+(approved.body.error||approved.status));
  const customers=await request(`/api/master/customers?db=${source}&keyword=${encodeURIComponent(customerCode)}`);
  const customer=(customers.body.data||[]).find(x=>x.customer_code===customerCode);
  assert(customer&&Number(customer.credit_limit)===1&&customer.credit_policy==='approval','核准後客戶主檔或信用設定不正確：'+JSON.stringify(customer||null));

  const type=await request('/api/sales-workflow/document-types',json({source_database:source,document_kind:'sales_order',type_code:typeCode,type_name:'S01 信用測試單別',number_prefix:typeCode,requires_approval:1,note:'自動測試後刪除'}));
  assert(type.status===201,'測試訂單單別建立失敗：'+(type.body.error||type.status));
  const order=await request('/api/sales-workflow/documents',json({source_database:source,document_kind:'sales_order',document_type:typeCode,document_date:new Date().toISOString().slice(0,10),customer_code:customerCode,item_code:'S01-ITEM',item_name:'S01 信用測試品',unit:'PCS',quantity:1,unit_price:100,note:'S01 自動測試'}));
  assert(order.status===201&&order.body.data?.status==='draft','信用測試訂單建立失敗：'+(order.body.error||order.status));
  documentId=Number(order.body.data.id);
  const blocked=await request(`/api/sales-workflow/documents/${documentId}/approve`,json({source_database:source}));
  assert(blocked.status===409,'超額訂單未進入信用放行：'+blocked.status);
  const report=await request(`/api/sales-workflow/customer-controls/credit-report?source_database=${source}&customer_code=${encodeURIComponent(customerCode)}`);
  const pending=(report.body.data?.pending||[]).find(x=>Number(x.document_id)===documentId&&x.status==='pending');
  assert(pending&&Number(pending.excess_amount)>0,'信用檢核表未產生待放行紀錄');
  const release=await request(`/api/sales-workflow/customer-controls/credit-approvals/${pending.id}/approve`,json({source_database:source,review_note:'S01 自動測試放行'}));
  assert(release.status===200,'信用放行核准失敗');
  const orderApproved=await request(`/api/sales-workflow/documents/${documentId}/approve`,json({source_database:source}));
  assert(orderApproved.status===200&&orderApproved.body.data?.status==='approved','信用放行後訂單仍無法核准');

  const other=(contexts.body.data||[]).find(x=>String(x.source_database).toUpperCase()!==source);
  if(other){const cross=await request(`/api/sales-workflow/customer-controls/requests?source_database=${String(other.source_database).toUpperCase()}`);assert(cross.status===409,'跨公司客戶申請查詢未被拒絕');}
  await reloadSourceDatabases();
  const eventCount=await runWithTargetDatabase(source,async()=>{const[[row]]=await pool.query('SELECT COUNT(*) count FROM sales_customer_request_events WHERE request_id=?',[requestId]);return Number(row.count);});
  assert(eventCount>=3,'客戶申請版本／審核事件歷程不完整');
  console.log(`S01 customer and credit verification passed for ${source}.`);
}catch(error){
  console.error('S01 customer and credit verification failed: '+error.message);
  process.exitCode=1;
}finally{
  try{await cleanup();}catch(error){console.error('S01 cleanup failed: '+error.message);process.exitCode=1;}
  await pool.end().catch(()=>{});
  process.exit(process.exitCode||0);
}
