import 'dotenv/config';
import mysql from 'mysql2/promise';

const connection = await mysql.createConnection({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'inventory_erp',
});
try {
  const [result] = await connection.query("DELETE FROM erp_data_sources WHERE source_key IN ('SMARTDSCSYS','DSCRPT')");
  const [active] = await connection.query('SELECT source_key,label,database_name,target_database FROM erp_data_sources WHERE enabled=1 ORDER BY sort_order');
  console.log(JSON.stringify({ ok:true, removed:result.affectedRows, active }, null, 2));
} finally {
  await connection.end();
}
