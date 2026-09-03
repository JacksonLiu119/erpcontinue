import 'dotenv/config';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';

const db=await mysql.createConnection({host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER||'root',password:process.env.DB_PASSWORD||'',database:process.env.DB_NAME||'inventory_erp'});
const marker='VERIFY_PARTIAL_RECEIPT';
const [[admin]]=await db.query("SELECT id FROM access_users WHERE username='admin'");
const token=crypto.randomBytes(48).toString('base64url');
await db.query('INSERT INTO access_sessions(user_id,token_hash,expires_at) VALUES(?,?,DATE_ADD(NOW(),INTERVAL 1 HOUR))',[admin.id,crypto.createHash('sha256').update(token).digest('hex')]);
const api=async(path,method='GET',body)=>{const r=await fetch(`http://127.0.0.1:3000/api${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const j=await r.json();if(!r.ok)throw new Error(j.error);return j.data??j;};
let orderId;
let targetDb;
try {
  const [[ctx]]=await db.query("SELECT tenant_id,company_id,source_system FROM erp_data_sources WHERE source_key='SC'");
  const [[source]]=await db.query("SELECT target_database FROM erp_data_sources WHERE source_key='SC'");
  targetDb=await mysql.createConnection({host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER||'root',password:process.env.DB_PASSWORD||'',database:source.target_database});
  await targetDb.query('DELETE FROM procurement_receipts WHERE note=?',[marker]);
  await targetDb.query('DELETE FROM procurement_orders WHERE note=?',[marker]);
  const types=await api('/procurement/document-types?source_database=SC');
  const poType=types.find(x=>x.document_kind==='purchase_order'&&x.is_active);
  const grType=types.find(x=>x.document_kind==='receipt'&&x.is_active);
  const po=await api('/procurement/orders','POST',{source_database:'SC',document_type:poType.type_code,order_date:'2026-08-24',supplier_code:'VERIFY-SUP',item_code:'VERIFY-PARTIAL',item_name:'分批進貨驗證',warehouse_code:'140',unit:'PCS',qty_ordered:10,unit_price:1,note:marker}); orderId=po.id;
  await api(`/procurement/documents/orders/${orderId}/approve`,'POST',{source_database:'SC'});
  const [[line]]=await targetDb.query('SELECT id FROM procurement_order_items WHERE purchase_order_id=?',[orderId]);
  const receive=async qty=>{const gr=await api('/procurement/receipts','POST',{source_database:'SC',document_type:grType.type_code,purchase_order_item_id:line.id,receipt_date:'2026-08-24',arrival_date:'2026-08-24',supplier_code:'VERIFY-SUP',warehouse_code:'140',item_code:'VERIFY-PARTIAL',item_name:'分批進貨驗證',unit:'PCS',qty_received:qty,unit_cost:1,note:marker});await api(`/procurement/receipts/${gr.id}/inspect`,'POST',{source_database:'SC',qty_accepted:qty,qty_rejected:0});return gr.id;};
  const r1=await receive(4); const [[s1]]=await targetDb.query('SELECT o.status,i.qty_received, i.qty_ordered-i.qty_received-i.qty_cancelled remaining FROM procurement_orders o JOIN procurement_order_items i ON i.purchase_order_id=o.id WHERE o.id=?',[orderId]);
  let blocked=false; try{await api(`/procurement/documents/orders/${orderId}/close`,'POST',{source_database:'SC'});}catch(e){blocked=/不能結案/.test(e.message);}
  const r2=await receive(6); const [[s2]]=await targetDb.query('SELECT o.status,i.qty_received, i.qty_ordered-i.qty_received-i.qty_cancelled remaining FROM procurement_orders o JOIN procurement_order_items i ON i.purchase_order_id=o.id WHERE o.id=?',[orderId]);
  await api(`/procurement/documents/orders/${orderId}/close`,'POST',{source_database:'SC'}); const [[s3]]=await targetDb.query('SELECT status,closed_at FROM procurement_orders WHERE id=?',[orderId]);
  console.log(JSON.stringify({first:{...s1,earlyCloseBlocked:blocked},second:s2,closed:{status:s3.status,hasClosedAt:Boolean(s3.closed_at)},receiptCount:2},null,2));
  await targetDb.query('DELETE FROM procurement_receipts WHERE id IN (?,?)',[r1,r2]);
} finally {
  if(targetDb) await targetDb.query('DELETE FROM procurement_receipts WHERE note=?',[marker]);
  if(orderId&&targetDb) await targetDb.query('DELETE FROM procurement_orders WHERE id=?',[orderId]);
  if(targetDb) await targetDb.end();
  await db.end();
}
