import 'dotenv/config';
import mysql from 'mysql2/promise';

const API='http://127.0.0.1:3000/api';
const SOURCE='SH';
const STAMP=String(Date.now());
const MARKER=`VERIFY:R05:FINANCE-MODES:${STAMP}`;
const CUSTOMER=`R05C${STAMP}`;
const SUPPLIER=`R05S${STAMP}`;
const config={host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER||'root',password:process.env.DB_PASSWORD||'',database:process.env.DB_NAME||'inventory_erp'};
const assert=(condition,message,details)=>{if(!condition){const error=new Error(message);error.details=details;throw error;}};
const closeEnough=(actual,expected,label)=>assert(Math.abs(Number(actual)-Number(expected))<0.0001,`${label}應為 ${expected}，實際 ${actual}`);
const dateOnly=value=>{if(!(value instanceof Date))return String(value??'').slice(0,10);const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(value).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));return `${parts.year}-${parts.month}-${parts.day}`;};

async function login(){
  const response=await fetch(`${API}/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'12345678'})});
  const payload=await response.json();
  if(!response.ok||payload.ok===false)throw new Error(payload.error||'登入失敗');
  return payload.data?.token||payload.token;
}

async function request(token,path,method='GET',body){
  const response=await fetch(`${API}${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text();let payload={};try{payload=JSON.parse(text);}catch{payload={error:text};}
  if(!response.ok||payload.ok===false)throw new Error(`${method} ${path}: ${payload.error||response.status}`);
  return payload.data??payload;
}

async function cleanup(target,settingSnapshots,context){
  if(!target)return;
  await target.beginTransaction();
  try{
    const [journalRows]=await target.query('SELECT id FROM accounting_journals WHERE memo=?',[MARKER]);
    const journalIds=journalRows.map(row=>Number(row.id));
    if(journalIds.length)await target.query('DELETE FROM accounting_journal_lines WHERE journal_id IN (?)',[journalIds]);
    if(journalIds.length)await target.query('DELETE FROM accounting_journals WHERE id IN (?)',[journalIds]);

    const [settlementRows]=await target.query('SELECT id FROM finance_settlements WHERE note=?',[MARKER]);
    const settlementIds=settlementRows.map(row=>Number(row.id));
    if(settlementIds.length)await target.query('DELETE FROM finance_allocations WHERE settlement_id IN (?)',[settlementIds]);
    if(settlementIds.length)await target.query('DELETE FROM finance_settlements WHERE id IN (?)',[settlementIds]);

    const [voucherRows]=await target.query('SELECT id FROM finance_vouchers WHERE note=?',[MARKER]);
    const voucherIds=voucherRows.map(row=>Number(row.id));
    if(voucherIds.length)await target.query('DELETE FROM finance_voucher_sources WHERE voucher_id IN (?)',[voucherIds]);
    if(voucherIds.length)await target.query('DELETE FROM finance_open_items WHERE source_kind=\'finance_voucher\' AND source_document_id IN (?)',[voucherIds]);
    if(voucherIds.length)await target.query('DELETE FROM finance_vouchers WHERE id IN (?)',[voucherIds]);

    const [salesRows]=await target.query('SELECT id FROM sales_documents WHERE note=?',[MARKER]);
    const salesIds=salesRows.map(row=>Number(row.id));
    if(salesIds.length)await target.query('DELETE FROM sales_document_items WHERE document_id IN (?)',[salesIds]);
    if(salesIds.length)await target.query('DELETE FROM sales_documents WHERE id IN (?)',[salesIds]);

    const [receiptRows]=await target.query('SELECT id FROM procurement_receipts WHERE note=?',[MARKER]);
    const receiptIds=receiptRows.map(row=>Number(row.id));
    if(receiptIds.length)await target.query('DELETE FROM procurement_receipt_items WHERE receipt_id IN (?)',[receiptIds]);
    if(receiptIds.length)await target.query('DELETE FROM procurement_receipts WHERE id IN (?)',[receiptIds]);

    await target.query('DELETE FROM erp_customers WHERE customer_code=? AND source_key=?',[CUSTOMER,MARKER]);
    await target.query('DELETE FROM erp_suppliers WHERE supplier_code=? AND source_key=?',[SUPPLIER,MARKER]);

    for(const settingSnapshot of Object.values(settingSnapshots||{}))if(settingSnapshot){
      await target.query(`UPDATE finance_closing_settings SET unified_closing_day=?,base_currency_code=?,exchange_gain_account_code=?,exchange_gain_account_name=?,exchange_loss_account_code=?,exchange_loss_account_name=?,auto_generate=?,note=? WHERE id=?`,[
        settingSnapshot.unified_closing_day,settingSnapshot.base_currency_code,settingSnapshot.exchange_gain_account_code,settingSnapshot.exchange_gain_account_name,
        settingSnapshot.exchange_loss_account_code,settingSnapshot.exchange_loss_account_name,settingSnapshot.auto_generate,settingSnapshot.note,settingSnapshot.id
      ]);
    }
    await target.commit();
  }catch(error){await target.rollback();throw error;}
}

const db=await mysql.createConnection(config);
let target;
let token;
let settingSnapshots={};
let context;
try{
  token=await login();
  const [[source]]=await db.query('SELECT target_database FROM erp_data_sources WHERE source_key=? AND enabled=1 LIMIT 1',[SOURCE]);
  assert(source,'找不到 SH 資料來源');
  target=await mysql.createConnection({...config,database:source.target_database||config.database});
  const [[ctx]]=await target.query('SELECT tenant_id,company_id,source_system FROM erp_data_sources WHERE source_key=? AND enabled=1 LIMIT 1',[SOURCE]);
  context=ctx;
  assert(context,'找不到 SH／仙暉公司範圍');
  const [[warehouse]]=await target.query('SELECT warehouse_code FROM erp_warehouses WHERE source_database=? ORDER BY warehouse_code LIMIT 1',[SOURCE]);
  assert(warehouse,'找不到 SH 庫別');

  await request(token,`/finance-workflow/closing-settings?source_database=${SOURCE}&account_type=AR`);
  await request(token,`/finance-workflow/closing-settings?source_database=${SOURCE}&account_type=AP`);
  const [[arSetting]]=await target.query('SELECT * FROM finance_closing_settings WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND account_type=\'AR\' LIMIT 1',[context.tenant_id,context.company_id,context.source_system,SOURCE]);
  const [[apSetting]]=await target.query('SELECT * FROM finance_closing_settings WHERE tenant_id=? AND company_id=? AND source_system=? AND source_database=? AND account_type=\'AP\' LIMIT 1',[context.tenant_id,context.company_id,context.source_system,SOURCE]);
  settingSnapshots={AR:arSetting,AP:apSetting};
  const [[arType]]=await target.query("SELECT type_code FROM sales_document_types WHERE source_database=? AND document_kind='shipment' AND is_active=1 ORDER BY type_code LIMIT 1",[SOURCE]);
  const [[arOpenType]]=await target.query("SELECT type_code FROM erp_document_natures WHERE source_database=? AND document_kind='ar_open' AND is_active=1 ORDER BY type_code LIMIT 1",[SOURCE]);
  const [[apOpenType]]=await target.query("SELECT type_code FROM erp_document_natures WHERE source_database=? AND document_kind='ap_open' AND is_active=1 ORDER BY type_code LIMIT 1",[SOURCE]);
  const shipmentType=arType?.type_code||'SA';
  const arDocumentType=arOpenType?.type_code||'6101';
  const apDocumentType=apOpenType?.type_code||'7101';

  await target.query(`INSERT INTO erp_customers(source_database,customer_code,short_name,customer_name,tax_id,source_table,source_key,tenant_id,company_id,source_system,currency_code,invoice_type,closing_day) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,[SOURCE,CUSTOMER,'R05客戶','R05 結帳模式驗證客戶','', 'VERIFY_R05',MARKER,context.tenant_id,context.company_id,context.source_system,'USD','2',15]);
  await target.query(`INSERT INTO erp_suppliers(source_database,supplier_code,short_name,supplier_name,tax_id,source_table,source_key,tenant_id,company_id,source_system,currency_code,invoice_type,closing_day) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,[SOURCE,SUPPLIER,'R05廠商','R05 結帳模式驗證廠商','', 'VERIFY_R05',MARKER,context.tenant_id,context.company_id,context.source_system,'TWD','3',20]);

  const [salesResult]=await target.query(`INSERT INTO sales_documents(tenant_id,company_id,source_system,source_database,document_kind,document_type,document_no,document_date,customer_code,currency_code,warehouse_code,status,inventory_status,note,created_by,posted_by,posted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,[context.tenant_id,context.company_id,context.source_system,SOURCE,'shipment',shipmentType,`R05-SA-${STAMP}-1`,'2026-08-10',CUSTOMER,'USD',warehouse.warehouse_code,'posted','posted',MARKER,1,1]);
  const salesId=salesResult.insertId;
  const [salesItemResult]=await target.query(`INSERT INTO sales_document_items(document_id,line_no,item_code,item_name,specification,unit,warehouse_code,quantity,related_quantity,unit_price,unit_cost,allowance_amount,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,[salesId,1,`R05-ITEM-${STAMP}`,'R05 多幣別驗證品','', 'PCS',warehouse.warehouse_code,100,0,10,5,0,MARKER]);
  const salesItemId=salesItemResult.insertId;

  const direct=await request(token,'/finance-workflow/vouchers','POST',{source_database:SOURCE,account_type:'AR',document_type:arDocumentType,voucher_date:'2026-08-12',due_date:'2026-09-12',party_code:CUSTOMER,currency_code:'USD',settlement_mode:'direct',exchange_rate:32,source_rows:[{source_kind:'shipment',source_document_id:salesId,source_document_item_id:salesItemId,allocated_amount:1000}],invoice_no:`R05-INV-${STAMP}-1`,invoice_date:'2026-08-12',invoice_type:'2',tax_id:'R05',note:MARKER});
  const [[directVoucher]]=await target.query('SELECT settlement_mode,closing_basis,source_code,invoice_no,invoice_date,invoice_status,exchange_rate,total_amount,base_total_amount FROM finance_vouchers WHERE id=?',[direct.id]);
  assert(directVoucher&&directVoucher.settlement_mode==='direct'&&directVoucher.source_code==='1','直接結帳模式或來源代碼錯誤',directVoucher);
  assert(directVoucher.invoice_status==='issued'&&directVoucher.invoice_no&&dateOnly(directVoucher.invoice_date)==='2026-08-12','直接結帳隨貨發票未正確保存',directVoucher);
  closeEnough(directVoucher.base_total_amount,32000,'直接結帳本位幣金額');
  const directApproval=await request(token,`/finance-workflow/vouchers/${direct.id}/approve?source_database=${SOURCE}`,'POST',{source_database:SOURCE});
  const [[directOpen]]=await target.query('SELECT id,exchange_rate,original_amount,base_original_amount,balance_amount FROM finance_open_items WHERE id=?',[directApproval.open_item_id]);
  assert(directOpen,'直接結帳核准後未建立應收帳款');
  closeEnough(directOpen.base_original_amount,32000,'應收本位幣原始金額');

  const manual=await request(token,'/finance-workflow/vouchers','POST',{source_database:SOURCE,account_type:'AP',document_type:apDocumentType,voucher_date:'2026-08-13',due_date:'2026-09-13',party_code:SUPPLIER,currency_code:'TWD',settlement_mode:'manual',total_amount:60,tax_amount:0,note:MARKER});
  const [[manualVoucher]]=await target.query('SELECT source_code,settlement_mode,invoice_status FROM finance_vouchers WHERE id=?',[manual.id]);
  assert(manualVoucher&&manualVoucher.source_code==='9'&&manualVoucher.settlement_mode==='manual','手動結帳未固定為來源 9 其他',manualVoucher);
  const manualApproval=await request(token,`/finance-workflow/vouchers/${manual.id}/approve?source_database=${SOURCE}`,'POST',{source_database:SOURCE});
  const invoiceSupplement=await request(token,`/finance-workflow/vouchers/${manual.id}/invoice?source_database=${SOURCE}`,'PUT',{source_database:SOURCE,invoice_no:`R05-INV-${STAMP}-2`,invoice_date:'2026-08-13',invoice_type:'3',tax_id:'R05',reason:'R05 補登測試'});
  assert(invoiceSupplement.invoice_status==='received','手動結帳發票補登失敗',invoiceSupplement);
  const invoiceVoid=await request(token,`/finance-workflow/vouchers/${manual.id}/invoice-void?source_database=${SOURCE}`,'POST',{source_database:SOURCE,reason:'R05 作廢測試'});
  assert(invoiceVoid.invoice_status==='voided','發票作廢失敗',invoiceVoid);
  const invoiceReopen=await request(token,`/finance-workflow/vouchers/${manual.id}/invoice-reopen?source_database=${SOURCE}`,'POST',{source_database:SOURCE,invoice_no:`R05-INV-${STAMP}-2R`,invoice_date:'2026-08-14',reason:'R05 重開測試'});
  assert(invoiceReopen.invoice_status==='received'&&invoiceReopen.invoice_no.endsWith('-2R'),'發票重開失敗',invoiceReopen);
  const [[eventCount]]=await target.query('SELECT COUNT(*) count FROM finance_invoice_events WHERE voucher_id=?',[manual.id]);
  assert(Number(eventCount.count)===3,'補登／作廢／重開事件歷程未完整保留',eventCount);

  const [autoSalesResult]=await target.query(`INSERT INTO sales_documents(tenant_id,company_id,source_system,source_database,document_kind,document_type,document_no,document_date,customer_code,currency_code,warehouse_code,status,inventory_status,note,created_by,posted_by,posted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,[context.tenant_id,context.company_id,context.source_system,SOURCE,'shipment',shipmentType,`R05-SA-${STAMP}-2`,'2026-08-11',CUSTOMER,'USD',warehouse.warehouse_code,'posted','posted',MARKER,1,1]);
  const autoSalesId=autoSalesResult.insertId;
  const [autoSalesItemResult]=await target.query(`INSERT INTO sales_document_items(document_id,line_no,item_code,item_name,specification,unit,warehouse_code,quantity,related_quantity,unit_price,unit_cost,allowance_amount,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,[autoSalesId,1,`R05-ITEM-${STAMP}-AUTO`,'R05 自動結帳驗證品','', 'PCS',warehouse.warehouse_code,20,0,10,5,0,MARKER]);
  const autoCustomer=await request(token,'/finance-workflow/vouchers/auto','POST',{source_database:SOURCE,account_type:'AR',document_type:arDocumentType,closing_basis:'customer',reference_date:'2026-08-12',party_code:CUSTOMER,note:MARKER});
  assert(autoCustomer.vouchers?.length===1,'客戶結帳日自動產生未建立一張草稿',autoCustomer);
  assert(String(autoCustomer.vouchers[0].voucher_date).slice(0,10)==='2026-08-15'&&autoCustomer.vouchers[0].closing_basis==='customer','客戶結帳日未套用 15 日',autoCustomer.vouchers[0]);
  closeEnough(autoCustomer.vouchers[0].total_amount,200,'客戶結帳日自動結帳金額');

  const [receiptResult]=await target.query(`INSERT INTO procurement_receipts(receipt_no,supplier_code,receipt_date,warehouse_code,status,note,source_database,tenant_id,company_id,source_system,document_type,inventory_status,arrival_date,received_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[`R05-GR-${STAMP}`,SUPPLIER,'2026-08-10',warehouse.warehouse_code,'accepted',MARKER,SOURCE,context.tenant_id,context.company_id,context.source_system,'3411','posted','2026-08-10','R05']);
  const receiptId=receiptResult.insertId;
  await target.query(`INSERT INTO procurement_receipt_items(receipt_id,purchase_order_item_id,line_no,item_code,item_name,specification,warehouse_code,unit,qty_received,qty_accepted,unit_cost,qty_rejected,qty_returned,inspection_status,inspection_note,inspected_by,inspected_at,qty_rejected_returned,freight_amount,insurance_amount,other_expense_amount,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),?,?,?,?,?)`,[receiptId,null,1,`R05-AP-ITEM-${STAMP}`,'R05 AP 自動結帳品','',warehouse.warehouse_code,'PCS',3,3,20,0,0,'accepted',MARKER,1,0,0,0,0,MARKER]);
  const unifiedDay=25;
  await request(token,'/finance-workflow/closing-settings','PUT',{source_database:SOURCE,account_type:'AP',unified_closing_day:unifiedDay,base_currency_code:'TWD',exchange_gain_account_code:settingSnapshots.AP.exchange_gain_account_code||'7161',exchange_gain_account_name:settingSnapshots.AP.exchange_gain_account_name||'兌換利益',exchange_loss_account_code:settingSnapshots.AP.exchange_loss_account_code||'7162',exchange_loss_account_name:settingSnapshots.AP.exchange_loss_account_name||'兌換損失',auto_generate:0,note:settingSnapshots.AP.note||null});
  const autoUnified=await request(token,'/finance-workflow/vouchers/auto','POST',{source_database:SOURCE,account_type:'AP',document_type:apDocumentType,closing_basis:'unified',reference_date:'2026-08-12',party_code:SUPPLIER,note:MARKER});
  assert(autoUnified.vouchers?.length===1,'公司統一結帳日自動產生未建立一張草稿',autoUnified);
  assert(String(autoUnified.vouchers[0].voucher_date).slice(0,10)==='2026-08-25'&&autoUnified.vouchers[0].closing_basis==='unified','公司統一結帳日未套用 25 日',autoUnified.vouchers[0]);
  closeEnough(autoUnified.vouchers[0].total_amount,60,'公司統一結帳日自動結帳金額');

  const settlement=await request(token,'/finance-workflow/settlements','POST',{source_database:SOURCE,account_type:'AR',document_type:'6301',settlement_date:'2026-08-31',payment_method:'transfer',exchange_rate:31,allocations:[{open_item_id:directOpen.id,allocated_amount:1000}],note:MARKER});
  closeEnough(settlement.base_amount,31000,'多幣別收款本位幣金額');
  closeEnough(settlement.exchange_difference,-1000,'多幣別應收匯兌差額');
  await request(token,`/finance-workflow/settlements/${settlement.id}/post?source_database=${SOURCE}`,'POST',{source_database:SOURCE});
  const journal=await request(token,'/accounting/journals/transfer','POST',{source_database:SOURCE,settlement_id:settlement.id,memo:MARKER});
  const [journalLines]=await target.query('SELECT account_code,debit_amount,credit_amount FROM accounting_journal_lines WHERE journal_id=? ORDER BY line_no',[journal.id]);
  const debitTotal=journalLines.reduce((sum,row)=>sum+Number(row.debit_amount),0),creditTotal=journalLines.reduce((sum,row)=>sum+Number(row.credit_amount),0);
  closeEnough(debitTotal,creditTotal,'匯兌差額傳票借貸平衡');
  const lossLine=journalLines.find(row=>row.account_code==='7162');
  assert(lossLine&&Number(lossLine.debit_amount)===1000,'應收匯兌損失未帶入 7162 科目',journalLines);
  await request(token,`/accounting/journals/${journal.id}/post?source_database=${SOURCE}`,'POST',{source_database:SOURCE});

  console.log(JSON.stringify({ok:true,checked:[
    '直接結帳單筆來源與隨貨附發票','手動結帳來源 9 其他','客戶結帳日自動產生','公司統一結帳日自動產生',
    '原幣／匯率／本位幣金額與匯兌差額','匯兌利益／損失科目傳票','發票補登／作廢／重開與事件歷程'
  ]},null,2));
}finally{
  if(target){try{await cleanup(target,settingSnapshots,context);}catch(error){console.error(`cleanup failed: ${error.message}`);}}
  if(token){try{await request(token,'/auth/logout','POST');}catch{}}
  if(target)await target.end();
  await db.end();
}
