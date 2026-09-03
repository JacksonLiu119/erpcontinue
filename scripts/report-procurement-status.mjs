import 'dotenv/config';
import mysql from 'mysql2/promise';
const config={host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER||'root',password:process.env.DB_PASSWORD||''};
const control=await mysql.createConnection({...config,database:process.env.DB_NAME||'inventory_erp'});
const [sources]=await control.query("SELECT source_key,target_database FROM erp_data_sources WHERE source_key IN ('SH','SC') ORDER BY source_key");
for(const source of sources){const target=source.target_database||process.env.DB_NAME||'inventory_erp';const db=await mysql.createConnection({...config,database:target});const [statuses]=await db.query('SELECT status,COUNT(*) count FROM procurement_orders WHERE source_database=? GROUP BY status ORDER BY status',[source.source_key]);const [[test]]=await db.query("SELECT COUNT(*) count FROM procurement_orders WHERE note='VERIFY_PARTIAL_RECEIPT'");console.log(JSON.stringify({source:source.source_key,target,statuses,testRows:Number(test.count)}));await db.end();}
await control.end();
