import 'dotenv/config';
import mysql from 'mysql2/promise';

const sourceKey = String(process.argv[2] || 'SH').toUpperCase();
const sourceDatabase = String(process.argv[3] || sourceKey);
const companyCode = String(process.argv[4] || sourceKey).toUpperCase();
const target = String(process.argv[5] || process.env.DB_NAME || 'inventory_erp');
if (!/^[A-Z0-9_-]+$/.test(sourceKey) || !/^[A-Za-z0-9_$-]+$/.test(sourceDatabase) || !/^[A-Z0-9_-]+$/.test(companyCode) || !/^[A-Za-z0-9_$-]+$/.test(target)) throw new Error('Invalid migration context');
const db = await mysql.createConnection({
  host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: target,
  charset: 'utf8mb4', multipleStatements: false
});
const q = name => `\`${name.replaceAll('`', '``')}\``;
const S = q(sourceDatabase);
const context = { tenant: sourceKey, company: companyCode, system: 'iSM' };
const batchNo = `LEGACY-${sourceKey}-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0,14)}`;
const [batchResult] = await db.execute(`INSERT INTO erp_import_batches
  (batch_no,tenant_id,company_id,source_system,source_database,status,started_at,total_tables,notes)
  VALUES(?,?,?,?,?,'running',NOW(),8,?)`, [batchNo,context.tenant,context.company,context.system,sourceKey,'舊 ERP 單據同步；來源資料庫維持唯讀']);
const batchId = batchResult.insertId;
let imported = 0, skipped = 0, errors = 0;

async function run(name, sourceTable, targetTable, sourceCountSql, insertSql) {
  try {
    const [[countRow]] = await db.query(sourceCountSql);
    const sourceCount = Number(countRow.n || 0);
    const [result] = await db.query(insertSql);
    const added = Number(result.affectedRows || 0);
    imported += added; skipped += Math.max(sourceCount - added, 0);
    await db.execute(`INSERT INTO erp_import_reconciliations
      (batch_id,source_table,target_table,source_count,target_count,imported_count,skipped_count,error_count,status,note)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, [batchId,sourceTable,targetTable,sourceCount,sourceCount,added,Math.max(sourceCount-added,0),0,'completed',name]);
    console.log(`${name}: source=${sourceCount}, imported=${added}, existing=${Math.max(sourceCount-added,0)}`);
  } catch (error) {
    errors += 1;
    await db.execute(`INSERT INTO erp_import_errors(batch_id,source_table,error_code,error_message) VALUES(?,?,?,?)`,[batchId,sourceTable,'IMPORT_FAILED',String(error.message).slice(0,1000)]);
    console.error(`${name}: ERROR ${error.message}`);
  }
}

const valid = field => `${field} REGEXP '^[0-9]{8}$' AND ${field} BETWEEN '20000101' AND DATE_FORMAT(CURDATE(),'%Y%m%d')`;

await run('銷售訂單表頭','copta','sales_documents',
  `SELECT COUNT(*) n FROM ${S}.copta WHERE COMPANY=${db.escape(companyCode)} AND ${valid('TA003')}`,
  `INSERT IGNORE INTO sales_documents(tenant_id,company_id,source_system,source_database,document_kind,document_type,document_no,document_date,customer_code,currency_code,salesperson_code,status,inventory_status,note)
   SELECT ${db.escape(context.tenant)},${db.escape(context.company)},${db.escape(context.system)},${db.escape(sourceKey)},'sales_order',TA001,CONCAT(TA001,'/',TA002),STR_TO_DATE(TA003,'%Y%m%d'),TA004,IF(TA007 IN ('','NTD'),'TWD',TA007),TA005,
     CASE WHEN UPPER(TRIM(TA019))='V' THEN 'voided' WHEN UPPER(TRIM(TA019))='Y' THEN 'completed' ELSE 'approved' END,
     'not_applicable',CONCAT('舊ERP匯入；原單號 ',TA002,'；原始結案碼 ',COALESCE(NULLIF(TRIM(TA019),''),'(空白)'))
   FROM ${S}.copta WHERE COMPANY=${db.escape(companyCode)} AND ${valid('TA003')}`);
await run('銷售訂單明細','coptb','sales_document_items',
  `SELECT COUNT(*) n FROM ${S}.coptb b JOIN sales_documents d ON d.tenant_id=${db.escape(context.tenant)} AND d.company_id=${db.escape(context.company)} AND d.source_system=${db.escape(context.system)} AND d.document_kind='sales_order' AND d.document_no=CONCAT(b.TB001,'/',b.TB002) WHERE b.COMPANY=${db.escape(companyCode)}`,
  `INSERT IGNORE INTO sales_document_items(document_id,line_no,item_code,item_name,specification,unit,warehouse_code,quantity,unit_price,expected_date,note)
   SELECT d.id,CAST(NULLIF(b.TB003,'') AS UNSIGNED),TRIM(b.TB004),TRIM(b.TB005),TRIM(b.TB006),COALESCE(NULLIF(TRIM(b.TB008),''),'PCS'),NULL,COALESCE(b.TB007,0),COALESCE(b.TB009,0),IF(${valid('b.TB016')},STR_TO_DATE(b.TB016,'%Y%m%d'),NULL),'舊ERP匯入'
   FROM ${S}.coptb b JOIN sales_documents d ON d.tenant_id=${db.escape(context.tenant)} AND d.company_id=${db.escape(context.company)} AND d.source_system=${db.escape(context.system)} AND d.document_kind='sales_order' AND d.document_no=CONCAT(b.TB001,'/',b.TB002)
   WHERE b.COMPANY=${db.escape(companyCode)}`);

await run('銷貨表頭','coptg','sales_documents',
  `SELECT COUNT(*) n FROM ${S}.coptg WHERE COMPANY=${db.escape(companyCode)} AND ${valid('TG003')}`,
  `INSERT IGNORE INTO sales_documents(tenant_id,company_id,source_system,source_database,document_kind,document_type,document_no,document_date,customer_code,currency_code,salesperson_code,status,inventory_status,note)
   SELECT ${db.escape(context.tenant)},${db.escape(context.company)},${db.escape(context.system)},${db.escape(sourceKey)},'shipment',TG001,CONCAT(TG001,'/',TG002),STR_TO_DATE(TG003,'%Y%m%d'),TG004,IF(TG011 IN ('','NTD'),'TWD',TG011),TG006,'posted','posted',CONCAT('舊ERP匯入；原單號 ',TG002)
   FROM ${S}.coptg WHERE COMPANY=${db.escape(companyCode)} AND ${valid('TG003')}`);
await run('銷貨明細','copth','sales_document_items',
  `SELECT COUNT(*) n FROM ${S}.copth h JOIN sales_documents d ON d.tenant_id=${db.escape(context.tenant)} AND d.company_id=${db.escape(context.company)} AND d.source_system=${db.escape(context.system)} AND d.document_kind='shipment' AND d.document_no=CONCAT(h.TH001,'/',h.TH002) WHERE h.COMPANY=${db.escape(companyCode)}`,
  `INSERT IGNORE INTO sales_document_items(document_id,line_no,item_code,item_name,specification,unit,warehouse_code,quantity,unit_price,note)
   SELECT d.id,CAST(NULLIF(h.TH003,'') AS UNSIGNED),TRIM(h.TH004),TRIM(h.TH005),TRIM(h.TH006),COALESCE(NULLIF(TRIM(h.TH009),''),'PCS'),NULLIF(TRIM(h.TH007),''),COALESCE(h.TH008,0),COALESCE(h.TH012,0),'舊ERP匯入'
   FROM ${S}.copth h JOIN sales_documents d ON d.tenant_id=${db.escape(context.tenant)} AND d.company_id=${db.escape(context.company)} AND d.source_system=${db.escape(context.system)} AND d.document_kind='shipment' AND d.document_no=CONCAT(h.TH001,'/',h.TH002)
   WHERE h.COMPANY=${db.escape(companyCode)}`);

await run('採購單表頭','purtc','procurement_orders',
  `SELECT COUNT(*) n FROM ${S}.purtc WHERE COMPANY=${db.escape(companyCode)} AND ${valid('TC003')}`,
  `INSERT IGNORE INTO procurement_orders(purchase_order_no,supplier_code,order_date,currency_code,status,note,source_database,tenant_id,company_id,source_system,document_type)
   SELECT CONCAT(TC001,'/',TC002),TC004,STR_TO_DATE(TC003,'%Y%m%d'),IF(TC005 IN ('','NTD'),'TWD',TC005),'confirmed',CONCAT('舊ERP匯入；原單號 ',TC002,' ',TC009),${db.escape(sourceKey)},${db.escape(context.tenant)},${db.escape(context.company)},${db.escape(context.system)},TC001
   FROM ${S}.purtc WHERE COMPANY=${db.escape(companyCode)} AND ${valid('TC003')}`);
await run('採購單明細','purtd','procurement_order_items',
  `SELECT COUNT(*) n FROM ${S}.purtd d JOIN procurement_orders o ON o.source_database=${db.escape(sourceKey)} AND o.purchase_order_no=CONCAT(d.TD001,'/',d.TD002) WHERE d.COMPANY=${db.escape(companyCode)}`,
  `INSERT IGNORE INTO procurement_order_items(purchase_order_id,line_no,item_code,item_name,specification,warehouse_code,unit,qty_ordered,qty_received,unit_price,expected_date,note)
   SELECT o.id,CAST(NULLIF(d.TD003,'') AS UNSIGNED),TRIM(d.TD004),TRIM(d.TD005),TRIM(d.TD006),TRIM(d.TD007),COALESCE(NULLIF(TRIM(d.TD009),''),'PCS'),COALESCE(d.TD008,0),COALESCE(d.TD015,0),COALESCE(d.TD010,0),IF(${valid('d.TD012')},STR_TO_DATE(d.TD012,'%Y%m%d'),NULL),'舊ERP匯入'
   FROM ${S}.purtd d JOIN procurement_orders o ON o.source_database=${db.escape(sourceKey)} AND o.purchase_order_no=CONCAT(d.TD001,'/',d.TD002)
   WHERE d.COMPANY=${db.escape(companyCode)}`);
// PURTC.TC014 為確認／作廢狀態；PURTD.TD016 為明細結案碼。
// 先依舊 ERP 結案碼，再依已交量判斷「部分到貨／數量完成」，避免一律匯成 confirmed。
await db.query(`UPDATE procurement_orders o
  JOIN ${S}.purtc h ON o.purchase_order_no=CONCAT(h.TC001,'/',h.TC002) AND h.COMPANY=${db.escape(companyCode)}
  JOIN (SELECT TD001,TD002,COUNT(*) line_count,
        SUM(CASE WHEN UPPER(TRIM(TD016))='Y' THEN 1 ELSE 0 END) closed_count,
        SUM(CASE WHEN COALESCE(TD015,0)>0 THEN 1 ELSE 0 END) received_count,
        SUM(CASE WHEN COALESCE(TD008,0)>COALESCE(TD015,0) THEN 1 ELSE 0 END) open_count
        FROM ${S}.purtd WHERE COMPANY=${db.escape(companyCode)} GROUP BY TD001,TD002) d
    ON d.TD001=h.TC001 AND d.TD002=h.TC002
  SET o.status=CASE WHEN UPPER(TRIM(h.TC014))='V' THEN 'cancelled'
    WHEN d.closed_count=d.line_count THEN 'closed'
    WHEN d.open_count=0 THEN 'received'
    WHEN d.received_count>0 THEN 'partial_received' ELSE 'confirmed' END
  WHERE o.source_database=${db.escape(sourceKey)}`);

await run('進貨表頭','purtg','procurement_receipts',
  `SELECT COUNT(*) n FROM ${S}.purtg WHERE COMPANY=${db.escape(companyCode)} AND ${valid('TG014')}`,
  `INSERT IGNORE INTO procurement_receipts(receipt_no,supplier_code,receipt_date,status,note,source_database,tenant_id,company_id,source_system,document_type,inventory_status)
   SELECT CONCAT(TG001,'/',TG002),TG005,STR_TO_DATE(TG014,'%Y%m%d'),'posted',CONCAT('舊ERP匯入；原單號 ',TG002,' ',TG016),${db.escape(sourceKey)},${db.escape(context.tenant)},${db.escape(context.company)},${db.escape(context.system)},TG001,'posted'
   FROM ${S}.purtg WHERE COMPANY=${db.escape(companyCode)} AND ${valid('TG014')}`);
await run('進貨明細','purth','procurement_receipt_items',
  `SELECT COUNT(*) n FROM ${S}.purth d JOIN procurement_receipts r ON r.source_database=${db.escape(sourceKey)} AND r.receipt_no=CONCAT(d.TH001,'/',d.TH002) WHERE d.COMPANY=${db.escape(companyCode)}`,
  `INSERT IGNORE INTO procurement_receipt_items(receipt_id,line_no,item_code,item_name,specification,warehouse_code,unit,qty_received,qty_accepted,unit_cost,lot_no,note,inspection_status)
   SELECT r.id,CAST(NULLIF(d.TH003,'') AS UNSIGNED),TRIM(d.TH004),TRIM(d.TH005),TRIM(d.TH006),TRIM(d.TH009),COALESCE(NULLIF(TRIM(d.TH008),''),'PCS'),COALESCE(d.TH007,0),COALESCE(d.TH015,d.TH007,0),COALESCE(d.TH018,0),COALESCE(d.TH010,''),'舊ERP匯入','accepted'
   FROM ${S}.purth d JOIN procurement_receipts r ON r.source_database=${db.escape(sourceKey)} AND r.receipt_no=CONCAT(d.TH001,'/',d.TH002)
   WHERE d.COMPANY=${db.escape(companyCode)}`);

await run('應收立帳','acrta','finance_open_items',
  `SELECT COUNT(*) n FROM ${S}.acrta WHERE COMPANY=${db.escape(companyCode)} AND ${valid('TA003')}`,
  `INSERT IGNORE INTO finance_open_items(tenant_id,company_id,source_system,source_database,account_type,document_no,document_date,due_date,party_code,currency_code,source_kind,source_document_no,original_amount,settled_amount,balance_amount,status,note)
   SELECT ${db.escape(context.tenant)},${db.escape(context.company)},${db.escape(context.system)},${db.escape(sourceKey)},'AR',CONCAT(TA001,'/',TA002),STR_TO_DATE(TA003,'%Y%m%d'),IF(${valid('TA020')},STR_TO_DATE(TA020,'%Y%m%d'),NULL),TA004,IF(TA009 IN ('','NTD'),'TWD',TA009),'legacy_ar',TA002,ABS(COALESCE(TA031,0)),GREATEST(ABS(COALESCE(TA031,0))-ABS(COALESCE(TA044,0)),0),LEAST(ABS(COALESCE(TA044,0)),ABS(COALESCE(TA031,0))),IF(ABS(COALESCE(TA044,0))=0,'settled','open'),'舊ERP匯入'
   FROM ${S}.acrta WHERE COMPANY=${db.escape(companyCode)} AND ${valid('TA003')}`);
await run('應付立帳','acpta','finance_open_items',
  `SELECT COUNT(*) n FROM ${S}.acpta WHERE COMPANY=${db.escape(companyCode)} AND ${valid('TA003')}`,
  `INSERT IGNORE INTO finance_open_items(tenant_id,company_id,source_system,source_database,account_type,document_no,document_date,due_date,party_code,currency_code,source_kind,source_document_no,original_amount,settled_amount,balance_amount,status,note)
   SELECT ${db.escape(context.tenant)},${db.escape(context.company)},${db.escape(context.system)},${db.escape(sourceKey)},'AP',CONCAT(TA001,'/',TA002),STR_TO_DATE(TA003,'%Y%m%d'),IF(${valid('TA020')},STR_TO_DATE(TA020,'%Y%m%d'),NULL),TA004,IF(TA008 IN ('','NTD'),'TWD',TA008),'legacy_ap',TA002,ABS(COALESCE(TA030,0)),GREATEST(ABS(COALESCE(TA030,0))-ABS(COALESCE(TA040,0)),0),LEAST(ABS(COALESCE(TA040,0)),ABS(COALESCE(TA030,0))),IF(ABS(COALESCE(TA040,0))=0,'settled','open'),'舊ERP匯入'
   FROM ${S}.acpta WHERE COMPANY=${db.escape(companyCode)} AND ${valid('TA003')}`);
await run('收款紀錄','acrtc','finance_settlements',
  `SELECT COUNT(*) n FROM ${S}.acrtc WHERE COMPANY=${db.escape(companyCode)} AND ${valid('TC003')}`,
  `INSERT IGNORE INTO finance_settlements(tenant_id,company_id,source_system,source_database,account_type,settlement_no,settlement_date,party_code,payment_method,amount,status,note)
   SELECT ${db.escape(context.tenant)},${db.escape(context.company)},${db.escape(context.system)},${db.escape(sourceKey)},'AR',CONCAT(TC001,'/',TC002),STR_TO_DATE(TC003,'%Y%m%d'),TC004,'legacy',ABS(COALESCE(TC014,0)),'posted',CONCAT('舊ERP匯入；',TC007)
   FROM ${S}.acrtc WHERE COMPANY=${db.escape(companyCode)} AND ${valid('TC003')}`);
await run('付款紀錄','acptc','finance_settlements',
  `SELECT COUNT(*) n FROM ${S}.acptc WHERE COMPANY=${db.escape(companyCode)} AND ${valid('TC003')}`,
  `INSERT IGNORE INTO finance_settlements(tenant_id,company_id,source_system,source_database,account_type,settlement_no,settlement_date,party_code,payment_method,amount,status,note)
   SELECT ${db.escape(context.tenant)},${db.escape(context.company)},${db.escape(context.system)},${db.escape(sourceKey)},'AP',CONCAT(TC001,'/',TC002),STR_TO_DATE(TC003,'%Y%m%d'),TC004,'legacy',ABS(COALESCE(TC014,0)),'posted',CONCAT('舊ERP匯入；',TC007)
   FROM ${S}.acptc WHERE COMPANY=${db.escape(companyCode)} AND ${valid('TC003')}`);

await db.execute(`UPDATE erp_import_batches SET status=?,completed_at=NOW(),imported_rows=?,skipped_rows=?,error_rows=?,notes=? WHERE id=?`,
  [errors ? 'completed_with_errors' : 'completed', imported, skipped, errors, `SH 舊單據同步完成；來源唯讀；批次 ${batchNo}`, batchId]);
console.log(JSON.stringify({batchNo,batchId,imported,skipped,errors}));
await db.end();
if (errors) process.exitCode = 1;
