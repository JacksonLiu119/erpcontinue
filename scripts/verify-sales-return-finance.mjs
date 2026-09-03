import 'dotenv/config';
import mysql from 'mysql2/promise';

const API='http://127.0.0.1:3000/api';
const SOURCE='SH';
const DATE='2026-08-28';
const STAMP=String(Date.now());
const MARKER=`VERIFY:R04:SALES-RETURN-FINANCE:${STAMP}`;
const ITEM_PREFIX=`R04-RETURN-${STAMP}-`;
const config={host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER||'root',password:process.env.DB_PASSWORD||'',database:process.env.DB_NAME||'inventory_erp'};
const assert=(value,message)=>{if(!value)throw new Error(message);};
const closeEnough=(actual,expected,label)=>assert(Math.abs(Number(actual)-Number(expected))<0.0001,`${label}應為 ${expected}，實際 ${actual}`);

async function login(){
  const response=await fetch(`${API}/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'12345678'})});
  const result=await response.json();
  if(!response.ok||result.ok===false)throw new Error(result.error||'登入失敗');
  return result.data.token;
}

async function request(token,path,method='GET',body){
  const response=await fetch(`${API}${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const result=await response.json().catch(()=>({}));
  if(!response.ok||result.ok===false)throw new Error(result.error||response.statusText||`HTTP ${response.status}`);
  return result.data??result;
}

async function fails(action,expected){
  try{await action();}catch(error){assert(String(error.message).includes(expected),`預期「${expected}」，實際「${error.message}」`);return;}
  throw new Error(`預期失敗：${expected}`);
}

async function ids(target,sql,values=[]){
  const [rows]=await target.query(sql,values);
  return rows.map(row=>Number(row.id));
}

async function cleanup(target){
  const [docs]=await target.query(`SELECT DISTINCT d.id,d.document_no
    FROM sales_documents d JOIN sales_document_items i ON i.document_id=d.id
    WHERE i.item_code LIKE ? OR d.note LIKE ?`,[`${ITEM_PREFIX}%`,`${MARKER}%`]);
  const docIds=docs.map(row=>Number(row.id)),docNos=docs.map(row=>row.document_no);
  const returnIds=await ids(target,docIds.length?'SELECT id FROM sales_documents WHERE id IN (?) AND document_kind=\'sales_return\'':'SELECT id FROM sales_documents WHERE 1=0',docIds);
  const returnAdjustmentIds=await ids(target,returnIds.length?'SELECT id FROM finance_return_adjustments WHERE sales_return_id IN (?)':'SELECT id FROM finance_return_adjustments WHERE 1=0',returnIds);
  const creditIds=await ids(target,returnAdjustmentIds.length?'SELECT id FROM finance_customer_credits WHERE source_adjustment_id IN (?)':'SELECT id FROM finance_customer_credits WHERE 1=0',returnAdjustmentIds);
  const settlementIds=await ids(target,`SELECT id FROM finance_settlements WHERE note LIKE ?`,[`${MARKER}%`]);
  const shipmentIds=await ids(target,docIds.length?'SELECT id FROM sales_documents WHERE id IN (?) AND document_kind=\'shipment\'':'SELECT id FROM sales_documents WHERE 1=0',docIds);
  const orderItemIds=await ids(target,docIds.length?`SELECT i.id FROM sales_document_items i JOIN sales_documents d ON d.id=i.document_id WHERE d.id IN (?) AND d.document_kind='sales_order'`:"SELECT i.id FROM sales_document_items i WHERE 1=0",docIds);

  if(creditIds.length)await target.query('DELETE FROM finance_customer_credit_movements WHERE credit_id IN (?)',[creditIds]);
  if(creditIds.length)await target.query('DELETE FROM finance_customer_credits WHERE id IN (?)',[creditIds]);
  if(returnAdjustmentIds.length)await target.query('DELETE FROM finance_return_adjustment_allocations WHERE adjustment_id IN (?)',[returnAdjustmentIds]);
  if(returnAdjustmentIds.length)await target.query('DELETE FROM finance_return_adjustments WHERE id IN (?)',[returnAdjustmentIds]);
  if(settlementIds.length)await target.query('DELETE FROM finance_allocations WHERE settlement_id IN (?)',[settlementIds]);
  if(settlementIds.length)await target.query('DELETE FROM finance_settlements WHERE id IN (?)',[settlementIds]);
  if(shipmentIds.length)await target.query('DELETE FROM finance_allocations WHERE open_item_id IN (SELECT id FROM finance_open_items WHERE source_kind=\'shipment\' AND source_document_id IN (?))',[shipmentIds]);
  if(shipmentIds.length)await target.query('DELETE FROM finance_open_items WHERE source_kind=\'shipment\' AND source_document_id IN (?)',[shipmentIds]);
  if(orderItemIds.length)await target.query('DELETE FROM sales_order_changes WHERE order_item_id IN (?)',[orderItemIds]);
  if(docIds.length)await target.query('DELETE FROM sales_order_versions WHERE order_id IN (?) OR source_document_id IN (?)',[docIds,docIds]);
  if(docNos.length)await target.query('DELETE FROM inventory_movement_ledger WHERE document_no IN (?)',[docNos]);
  if(docIds.length)await target.query('DELETE FROM sales_documents WHERE id IN (?)',[docIds]);
  await target.query('DELETE FROM erp_inventory_balances WHERE item_code LIKE ?',[`${ITEM_PREFIX}%`]);
}

async function sourceContext(target){
  const [[context]]=await target.query('SELECT tenant_id,company_id,source_system FROM erp_data_sources WHERE source_key=? AND enabled=1 LIMIT 1',[SOURCE]);
  assert(context,'找不到 SH 公司範圍');
  const [[warehouse]]=await target.query('SELECT warehouse_code FROM erp_warehouses WHERE source_database=? ORDER BY warehouse_code LIMIT 1',[SOURCE]);
  return {...context,warehouse_code:warehouse?.warehouse_code||'101'};
}

async function createOrder(token,type,context,code,customer,warehouse,quantity){
  const order=await request(token,'/sales-workflow/documents','POST',{source_database:SOURCE,document_kind:'sales_order',document_type:type,document_date:DATE,customer_code:customer,item_code:code,item_name:'R04 銷退應收驗證品',unit:'PCS',warehouse_code:warehouse,quantity,unit_price:100,unit_cost:60,note:MARKER});
  if(order.status==='draft')await request(token,`/sales-workflow/documents/${order.id}/approve`,'POST',{source_database:SOURCE});
  const [[item]]=await context.connection.query('SELECT * FROM sales_document_items WHERE document_id=?',[order.id]);
  assert(item,`找不到測試訂單明細 ${order.id}`);
  return {header:order,item};
}

async function createShipment(token,context,orderItem,type,quantity){
  const shipment=await request(token,`/sales-workflow/items/${orderItem.id}/convert`,'POST',{source_database:SOURCE,document_type:type,document_date:DATE,quantity});
  if(shipment.status==='draft')await request(token,`/sales-workflow/documents/${shipment.id}/approve`,'POST',{source_database:SOURCE});
  const [[item]]=await context.connection.query('SELECT * FROM sales_document_items WHERE document_id=?',[shipment.id]);
  assert(item,`找不到測試銷貨明細 ${shipment.id}`);
  await request(token,`/sales-workflow/documents/${shipment.id}/post`,'POST',{source_database:SOURCE});
  return {header:shipment,item};
}

async function createReturn(token,context,shipmentItem,type,customer,warehouse,quantity,returnType='return',allowanceAmount=0){
  const row=await request(token,'/sales-workflow/documents','POST',{source_database:SOURCE,document_kind:'sales_return',document_type:type,document_date:DATE,customer_code:customer,item_code:shipmentItem.item_code,item_name:'R04 銷退應收驗證品',unit:'PCS',warehouse_code:warehouse,quantity,unit_price:100,unit_cost:60,allowance_amount:allowanceAmount,return_type:returnType,source_item_id:shipmentItem.id,note:MARKER});
  if(row.status==='draft')await request(token,`/sales-workflow/documents/${row.id}/approve`,'POST',{source_database:SOURCE});
  if(returnType==='return')await request(token,`/sales-workflow/documents/${row.id}/inspect-return`,'POST',{source_database:SOURCE,result:'accepted'});
  await request(token,`/sales-workflow/documents/${row.id}/post`,'POST',{source_database:SOURCE});
  return row;
}

async function createOpenItem(target,context,shipment,customer,amount,code){
  const documentNo=`R04-AR-${STAMP}-${code}`;
  const [result]=await target.query(`INSERT INTO finance_open_items(
      tenant_id,company_id,source_system,source_database,account_type,document_no,document_date,due_date,party_code,currency_code,
      source_kind,source_document_id,source_document_no,original_amount,balance_amount,base_original_amount,base_balance_amount,status,note,created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?)`,[
    context.tenant_id,context.company_id,context.source_system,SOURCE,'AR',documentNo,DATE,DATE,customer,'TWD','shipment',shipment.header.id,shipment.header.document_no,amount,amount,amount,amount,MARKER,1
  ]);
  const openItemId=result.insertId;
  return openItemId;
}

async function approveOpenItem(token,id){await request(token,`/finance-workflow/open-items/${id}/approve`,'POST',{source_database:SOURCE});}

async function settleOpenItem(token,id,amount){
  const settlement=await request(token,'/finance-workflow/settlements-enhanced','POST',{source_database:SOURCE,account_type:'AR',document_type:'TC',settlement_date:DATE,party_code:'R04-CUSTOMER',currency_code:'TWD',exchange_rate:1,allocations:[{open_item_id:id,allocated_amount:amount}],note:MARKER});
  await request(token,`/finance-workflow/settlements/${settlement.id}/post-enhanced`,'POST',{source_database:SOURCE});
}

const db=await mysql.createConnection(config);
let target;
let token;
try{
  const [[source]]=await db.query('SELECT target_database FROM erp_data_sources WHERE source_key=? AND enabled=1',[SOURCE]);
  assert(source,'找不到 SH 資料來源');
  target=await mysql.createConnection({...config,database:source.target_database||config.database});
  token=await login();
  await request(token,`/finance-workflow/customer-credits?source_database=${SOURCE}`);
  const context=await sourceContext(target);
  context.connection=target;
  await cleanup(target);
  const [[orderType]]=await target.query(`SELECT type_code FROM sales_document_types
    WHERE source_database=? AND document_kind='sales_order' AND is_active=1 ORDER BY auto_confirm DESC,requires_approval,type_code LIMIT 1`,[SOURCE]);
  const [[shipmentType]]=await target.query(`SELECT type_code FROM sales_document_types
    WHERE source_database=? AND document_kind='shipment' AND is_active=1 ORDER BY auto_confirm DESC,requires_approval,type_code LIMIT 1`,[SOURCE]);
  const [[returnType]]=await target.query(`SELECT type_code FROM sales_document_types
    WHERE source_database=? AND document_kind='sales_return' AND is_active=1 ORDER BY auto_confirm DESC,requires_approval,type_code LIMIT 1`,[SOURCE]);
  assert(orderType&&shipmentType&&returnType,'SH 缺少銷售、銷貨或銷退單別');

  const customerA='R04-CUSTOMER-A',customerB='R04-CUSTOMER-B',customerC='R04-CUSTOMER-C',warehouse=context.warehouse_code;
  for(const code of [`${ITEM_PREFIX}A`,`${ITEM_PREFIX}B`,`${ITEM_PREFIX}C`]){
    await target.query(`INSERT INTO erp_inventory_balances(tenant_id,company_id,source_system,item_code,warehouse_code,location_code,quantity_on_hand,unit_cost,inventory_amount,last_movement_at)
      VALUES(?,?,?,?,?,'',20,60,1200,NOW())`,[context.tenant_id,context.company_id,context.source_system,code,warehouse]);
  }

  const orderA=await createOrder(token,orderType.type_code,context,`${ITEM_PREFIX}A`,customerA,warehouse,10);
  const shipmentA=await createShipment(token,context,orderA.item,shipmentType.type_code,10);
  const openA=await createOpenItem(target,context,shipmentA,customerA,1000,'A');
  await approveOpenItem(token,openA);
  const [[stockAfterShipmentA]]=await target.query('SELECT quantity_on_hand FROM erp_inventory_balances WHERE item_code=? AND warehouse_code=?',[`${ITEM_PREFIX}A`,warehouse]);
  closeEnough(stockAfterShipmentA.quantity_on_hand,10,'銷貨過帳後庫存');
  const returnA=await createReturn(token,context,shipmentA.item,returnType.type_code,customerA,warehouse,3,'return',0);
  const [[arAfterReturnA]]=await target.query('SELECT balance_amount,adjustment_amount,status FROM finance_open_items WHERE id=?',[openA]);
  closeEnough(arAfterReturnA.balance_amount,700,'未收銷退後應收餘額');
  closeEnough(arAfterReturnA.adjustment_amount,300,'未收銷退應收沖帳');
  const [[adjustmentA]]=await target.query('SELECT receivable_offset_amount,customer_credit_amount,status FROM finance_return_adjustments WHERE sales_return_id=?',[returnA.id]);
  closeEnough(adjustmentA.receivable_offset_amount,300,'銷退沖帳紀錄');
  assert(Number(adjustmentA.customer_credit_amount)===0&&adjustmentA.status==='offset','未收銷退應為 offset');
  const [[orderAAfterReturn]]=await target.query('SELECT status FROM sales_documents WHERE id=?',[orderA.header.id]);
  const [[orderLineAAfterReturn]]=await target.query('SELECT quantity,related_quantity FROM sales_document_items WHERE id=?',[orderA.item.id]);
  assert(orderAAfterReturn.status==='partial','銷退後已結案訂單未受控解結為 partial');
  closeEnough(orderLineAAfterReturn.related_quantity,7,'銷退後訂單已交量');
  const [versionsAfterReturn]=await target.query('SELECT version_no,change_kind,before_status,after_status,before_delivered_quantity,after_delivered_quantity FROM sales_order_versions WHERE order_id=? ORDER BY version_no',[orderA.header.id]);
  assert(versionsAfterReturn.length===1&&versionsAfterReturn[0].change_kind==='sales_return_reopen'&&versionsAfterReturn[0].after_status==='partial','銷退解結版本未留存');
  const allowanceA=await createReturn(token,context,shipmentA.item,returnType.type_code,customerA,warehouse,1,'allowance',50);
  const [[stockAfterAllowanceA]]=await target.query('SELECT quantity_on_hand FROM erp_inventory_balances WHERE item_code=? AND warehouse_code=?',[`${ITEM_PREFIX}A`,warehouse]);
  closeEnough(stockAfterAllowanceA.quantity_on_hand,13,'折讓不應影響庫存');
  const [[arAfterAllowanceA]]=await target.query('SELECT balance_amount,adjustment_amount FROM finance_open_items WHERE id=?',[openA]);
  closeEnough(arAfterAllowanceA.balance_amount,650,'折讓後應收餘額');
  closeEnough(arAfterAllowanceA.adjustment_amount,350,'銷退與折讓累計沖帳');
  await fails(()=>createReturn(token,context,shipmentA.item,returnType.type_code,customerA,warehouse,8,'return',0),'銷退數量超過原銷貨可退量');
  const change=await request(token,'/sales-workflow/order-changes','POST',{source_database:SOURCE,order_item_id:orderA.item.id,change_date:DATE,new_quantity:8,new_unit_price:105,reason:MARKER});
  await request(token,`/sales-workflow/order-changes/${change.id}/approve`,'POST',{source_database:SOURCE});
  const [[changedOrder]]=await target.query('SELECT status FROM sales_documents WHERE id=?',[orderA.header.id]);
  const [[changedOrderLine]]=await target.query('SELECT quantity,related_quantity FROM sales_document_items WHERE id=?',[orderA.item.id]);
  const [versionsAfterChange]=await target.query('SELECT version_no,change_kind FROM sales_order_versions WHERE order_id=? ORDER BY version_no',[orderA.header.id]);
  assert(changedOrder.status==='partial'&&Number(changedOrderLine.quantity)===8&&Number(changedOrderLine.related_quantity)===7&&versionsAfterChange.length===2&&versionsAfterChange[1].change_kind==='order_change','受控重開後重新核准或版本紀錄錯誤');

  const orderB=await createOrder(token,orderType.type_code,context,`${ITEM_PREFIX}B`,customerB,warehouse,5);
  const shipmentB=await createShipment(token,context,orderB.item,shipmentType.type_code,5);
  const openB=await createOpenItem(target,context,shipmentB,customerB,500,'B');
  await approveOpenItem(token,openB);
  await settleOpenItem(token,openB,500);
  const returnB=await createReturn(token,context,shipmentB.item,returnType.type_code,customerB,warehouse,2,'return',0);
  const [[arAfterPaidReturn]]=await target.query('SELECT balance_amount,adjustment_amount,status FROM finance_open_items WHERE id=?',[openB]);
  assert(Number(arAfterPaidReturn.balance_amount)===0&&Number(arAfterPaidReturn.adjustment_amount)===0&&arAfterPaidReturn.status==='settled','已收款原應收不應被錯誤改成負數');
  const [[creditB]]=await target.query('SELECT c.original_amount,c.balance_amount,c.status FROM finance_customer_credits c JOIN finance_return_adjustments a ON a.id=c.source_adjustment_id WHERE a.sales_return_id=?',[returnB.id]);
  assert(creditB&&Number(creditB.original_amount)===200&&Number(creditB.balance_amount)===200&&creditB.status==='available','已收銷退未形成客戶待抵');
  const credits=await request(token,`/finance-workflow/customer-credits?source_database=${SOURCE}`);
  const creditRow=credits.find(row=>Number(row.original_amount)===200&&row.sales_return_no===returnB.document_no);
  assert(creditRow,'客戶待抵查詢未回傳銷退來源');
  await request(token,`/finance-workflow/customer-credits/${creditRow.id}/refund`,'POST',{source_database:SOURCE,movement_date:DATE,amount:50,reference_no:`R04-REFUND-${STAMP}`,note:MARKER});
  const [[creditAfterRefund]]=await target.query('SELECT balance_amount,refunded_amount,status FROM finance_customer_credits WHERE id=?',[creditRow.id]);
  const [[adjustmentAfterRefund]]=await target.query('SELECT refund_amount FROM finance_return_adjustments WHERE sales_return_id=?',[returnB.id]);
  closeEnough(creditAfterRefund.balance_amount,150,'退款後客戶待抵餘額');
  closeEnough(creditAfterRefund.refunded_amount,50,'退款紀錄');
  closeEnough(adjustmentAfterRefund.refund_amount,50,'銷退沖帳退款紀錄');

  const orderC=await createOrder(token,orderType.type_code,context,`${ITEM_PREFIX}C`,customerC,warehouse,4);
  const shipmentC=await createShipment(token,context,orderC.item,shipmentType.type_code,4);
  const returnC=await createReturn(token,context,shipmentC.item,returnType.type_code,customerC,warehouse,1,'return',0);
  const [[pendingAdjustment]]=await target.query('SELECT status,receivable_offset_amount,customer_credit_amount FROM finance_return_adjustments WHERE sales_return_id=?',[returnC.id]);
  assert(pendingAdjustment.status==='pending'&&Number(pendingAdjustment.receivable_offset_amount)===0&&Number(pendingAdjustment.customer_credit_amount)===0,'未立應收的銷退不應誤列客戶待抵，應保留 pending');

  console.log(JSON.stringify({ok:true,checked:['sales return accepted then inventory increase','allowance decreases AR without inventory movement','unpaid AR offset','paid AR customer credit and refund','return quantity limit','controlled order reopen and version approval','unbilled return pending status']},null,2));
}finally{
  if(token){try{await request(token,'/auth/logout','POST');}catch(_){}}
  if(target){await cleanup(target);await target.end();}
  await db.end();
}
