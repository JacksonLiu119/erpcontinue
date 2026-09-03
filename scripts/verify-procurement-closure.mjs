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
async function request(token,path,method='GET',body) {
  const response = await fetch(`${API}${path}`, { method, headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})}, body:body?JSON.stringify(body):undefined });
  const result = await response.json();
  if (!response.ok || result.ok === false) throw new Error(result.error || response.statusText);
  return result.data ?? result;
}
async function fails(action, text) { try { await action(); } catch (error) { assert(String(error.message).includes(text), `預期「${text}」，實際「${error.message}」`); return; } throw new Error(`預期失敗：${text}`); }

async function cleanup(target) {
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
  const returnable=await request(token,`/procurement/returnable-receipts?source_database=${SOURCE}`);
  const receiptLine=returnable.find(row=>row.receipt_no===receipt.documentNo);
  assert(receiptLine && Number(receiptLine.returnable_quantity)===5,'已入庫合格量未成為可退量');
  const physicalReturn=await request(token,'/procurement/returns','POST',{source_database:SOURCE,document_type:returnType.type_code,return_type:'return',receipt_item_id:receiptLine.receipt_item_id,return_date:DATE,return_quantity:2,reason:MARKER,note:MARKER});
  const [[createdReturn]]=await target.query('SELECT id,status,return_no FROM procurement_returns WHERE id=?',[physicalReturn.id]);
  assert(createdReturn?.status==='draft',`退貨草稿狀態異常：${JSON.stringify(createdReturn)}`);
  await request(token,`/procurement/returns/${physicalReturn.id}/approve`,'POST',{source_database:SOURCE});
  const [[beforePost]]=await target.query('SELECT qty_received FROM procurement_order_items WHERE id=?',[line.id]);
  assert(Number(beforePost.qty_received)===5,'退貨未過帳前不應回沖採購已交量');
  await request(token,`/inventory-workflow/procurement/return/${physicalReturn.id}/post`,'POST',{source_database:SOURCE});
  const [[afterPost]]=await target.query('SELECT qty_received FROM procurement_order_items WHERE id=?',[line.id]);
  assert(Number(afterPost.qty_received)===3,'退貨過帳後採購已交量未正確回沖');
  const sources=await request(token,`/finance-workflow/source-documents?source_database=${SOURCE}&account_type=AP&limit=100`);
  assert(sources.some(row=>row.source_kind==='purchase_return'&&row.source_document_id===physicalReturn.id&&Number(row.amount)<0),'退貨未成為負向應付來源');
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
  console.log(JSON.stringify({ok:true,checked:['pending arrival reservation','inspection acceptance/rejection','receipt post','return post reopens PO','negative AP source','temporary return balance']},null,2));
} finally { if (target) { await cleanup(target); await target.end(); } await db.end(); }
