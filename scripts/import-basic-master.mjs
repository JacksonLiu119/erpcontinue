import 'dotenv/config';
import mysql from 'mysql2/promise';

const sourceKey = String(process.argv[2] || 'SC').toUpperCase();
const sourceDatabase = String(process.argv[3] || 'raw_sc_20260819');
const companyCode = String(process.argv[4] || sourceKey).toUpperCase();
const targetDatabase = String(process.argv[5] || 'inventory_erp_sc');
const safe = value => /^[A-Za-z0-9_$-]+$/.test(value);
if (![sourceKey, sourceDatabase, companyCode, targetDatabase].every(safe)) throw new Error('Invalid migration context');

const db = await mysql.createConnection({
  host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '',
  database: targetDatabase, charset: 'utf8mb4'
});
const q = name => `\`${name.replaceAll('`', '``')}\``;
const S = q(sourceDatabase);
const esc = value => db.escape(value);
const ctx = `${esc(sourceKey)},${esc(companyCode)},'iSM'`;
const batchNo = `MASTER-${sourceKey}-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0,14)}`;
const [batch] = await db.execute(`INSERT INTO erp_import_batches
  (batch_no,tenant_id,company_id,source_system,source_database,status,started_at,total_tables,notes)
  VALUES(?,?,?,?,?,'running',NOW(),7,?)`, [batchNo,sourceKey,companyCode,'iSM',sourceKey,'基本主檔匯入；raw 來源唯讀']);

const jobs = [
  ['公司','CMSML','erp_companies',`INSERT INTO erp_companies
    (tenant_id,company_id,source_system,company_code,short_name,company_name,address,phone,tax_id,source_database,source_table,source_key)
    SELECT ${ctx},TRIM(ML001),TRIM(ML002),TRIM(ML003),TRIM(ML012),TRIM(ML005),TRIM(ML007),${esc(sourceKey)},'CMSML',CONCAT(COMPANY,':',ML001)
    FROM ${S}.CMSML WHERE COMPANY=${esc(companyCode)}
    ON DUPLICATE KEY UPDATE short_name=VALUES(short_name),company_name=VALUES(company_name),address=VALUES(address),phone=VALUES(phone),tax_id=VALUES(tax_id),source_table=VALUES(source_table),source_key=VALUES(source_key)`],
  ['庫別','CMSMC','erp_warehouses',`INSERT INTO erp_warehouses
    (source_database,tenant_id,company_id,source_system,warehouse_code,warehouse_name,site_code,warehouse_type,allow_in,allow_out,source_table,source_key)
    SELECT ${esc(sourceKey)},${ctx},TRIM(MC001),TRIM(MC002),TRIM(MC003),TRIM(MC004),TRIM(MC005),TRIM(MC006),'CMSMC',CONCAT(COMPANY,':',MC001)
    FROM ${S}.CMSMC WHERE COMPANY=${esc(companyCode)} AND TRIM(MC001)<>''
    ON DUPLICATE KEY UPDATE warehouse_name=VALUES(warehouse_name),site_code=VALUES(site_code),warehouse_type=VALUES(warehouse_type),allow_in=VALUES(allow_in),allow_out=VALUES(allow_out),source_table=VALUES(source_table),source_key=VALUES(source_key)`],
  ['部門','CMSME','erp_departments',`INSERT INTO erp_departments
    (source_database,tenant_id,company_id,source_system,department_code,department_name,account_code,source_table,source_key)
    SELECT ${esc(sourceKey)},${ctx},TRIM(ME001),TRIM(ME002),TRIM(ME004),'CMSME',CONCAT(COMPANY,':',ME001)
    FROM ${S}.CMSME WHERE COMPANY=${esc(companyCode)} AND TRIM(ME001)<>''
    ON DUPLICATE KEY UPDATE department_name=VALUES(department_name),account_code=VALUES(account_code),source_table=VALUES(source_table),source_key=VALUES(source_key)`],
  ['員工','CMSMV','erp_employees',`INSERT INTO erp_employees
    (source_database,tenant_id,company_id,source_system,employee_code,employee_name,company_code,department_code,email,source_table,source_key)
    SELECT ${esc(sourceKey)},${ctx},TRIM(MV001),TRIM(MV002),COMPANY,TRIM(MV004),TRIM(MV020),'CMSMV',CONCAT(COMPANY,':',MV001)
    FROM ${S}.CMSMV WHERE COMPANY=${esc(companyCode)} AND TRIM(MV001)<>''
    ON DUPLICATE KEY UPDATE employee_name=VALUES(employee_name),department_code=VALUES(department_code),email=VALUES(email),source_table=VALUES(source_table),source_key=VALUES(source_key)`],
  ['品號','INVMB','erp_items',`INSERT INTO erp_items
    (tenant_id,company_id,source_system,item_code,item_name,specification,unit,category_1,category_2,source_database,source_table,source_key)
    SELECT ${ctx},TRIM(MB001),TRIM(MB002),TRIM(MB003),TRIM(MB004),TRIM(MB005),TRIM(MB006),${esc(sourceKey)},'INVMB',CONCAT(COMPANY,':',MB001)
    FROM ${S}.INVMB WHERE COMPANY=${esc(companyCode)} AND TRIM(MB001)<>''
    ON DUPLICATE KEY UPDATE item_name=VALUES(item_name),specification=VALUES(specification),unit=VALUES(unit),category_1=VALUES(category_1),category_2=VALUES(category_2),source_table=VALUES(source_table),source_key=VALUES(source_key)`],
  ['客戶','COPMA','erp_customers',`INSERT INTO erp_customers
    (tenant_id,company_id,source_system,customer_code,short_name,customer_name,phone,source_database,source_table,source_key)
    SELECT ${ctx},TRIM(MA001),TRIM(MA004),TRIM(MA003),TRIM(MA006),${esc(sourceKey)},'COPMA',CONCAT(COMPANY,':',MA001)
    FROM ${S}.COPMA WHERE COMPANY=${esc(companyCode)} AND TRIM(MA001)<>''
    ON DUPLICATE KEY UPDATE short_name=VALUES(short_name),customer_name=VALUES(customer_name),phone=VALUES(phone),source_table=VALUES(source_table),source_key=VALUES(source_key)`],
  ['廠商','PURMA','erp_suppliers',`INSERT INTO erp_suppliers
    (tenant_id,company_id,source_system,supplier_code,short_name,supplier_name,phone,source_database,source_table,source_key)
    SELECT ${ctx},TRIM(MA001),TRIM(MA004),TRIM(MA003),TRIM(MA006),${esc(sourceKey)},'PURMA',CONCAT(COMPANY,':',MA001)
    FROM ${S}.PURMA WHERE COMPANY=${esc(companyCode)} AND TRIM(MA001)<>''
    ON DUPLICATE KEY UPDATE short_name=VALUES(short_name),supplier_name=VALUES(supplier_name),phone=VALUES(phone),source_table=VALUES(source_table),source_key=VALUES(source_key)`]
];

let imported = 0, errors = 0;
for (const [name, sourceTable, targetTable, sql] of jobs) {
  try {
    const [result] = await db.query(sql);
    const [[sourceCount]] = await db.query(`SELECT COUNT(*) n FROM ${S}.${q(sourceTable)} WHERE COMPANY=?`, [companyCode]);
    const [[targetCount]] = await db.query(`SELECT COUNT(*) n FROM ${q(targetTable)} WHERE tenant_id=? AND company_id=? AND source_system='iSM'`, [sourceKey, companyCode]);
    imported += Number(result.affectedRows || 0);
    await db.execute(`INSERT INTO erp_import_reconciliations
      (batch_id,source_table,target_table,source_count,target_count,imported_count,skipped_count,error_count,status,note)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, [batch.insertId,sourceTable,targetTable,sourceCount.n,targetCount.n,result.affectedRows,0,0,'completed',name]);
    console.log(`${name}: source=${sourceCount.n}, target=${targetCount.n}`);
  } catch (error) {
    errors += 1;
    await db.execute('INSERT INTO erp_import_errors(batch_id,source_table,error_code,error_message) VALUES(?,?,?,?)',[batch.insertId,sourceTable,'MASTER_IMPORT_FAILED',String(error.message).slice(0,1000)]);
    console.error(`${name}: ERROR ${error.message}`);
  }
}
await db.execute(`UPDATE erp_import_batches SET status=?,completed_at=NOW(),imported_rows=?,error_rows=? WHERE id=?`,[errors?'completed_with_errors':'completed',imported,errors,batch.insertId]);
console.log(JSON.stringify({batchNo,batchId:batch.insertId,errors}));
await db.end();
if (errors) process.exitCode = 1;
