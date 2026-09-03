import 'dotenv/config';
import mysql from 'mysql2/promise';

const control=await mysql.createConnection({host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER||'root',password:process.env.DB_PASSWORD||'',database:process.env.DB_NAME||'inventory_erp'});
const [sources]=await control.query("SELECT source_key,database_name FROM erp_data_sources WHERE source_key IN ('SH','SC') ORDER BY source_key");
for(const source of sources){
  const db=await mysql.createConnection({host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER||'root',password:process.env.DB_PASSWORD||'',database:source.database_name});
  const report={source:source.source_key,database:source.database_name,tables:{}};
  for(const table of ['purtc','purtd','copta','coptb']){
    const [columns]=await db.query(`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND DATA_TYPE IN ('char','varchar','tinyint','smallint','int') AND (CHARACTER_MAXIMUM_LENGTH IS NULL OR CHARACTER_MAXIMUM_LENGTH<=10) ORDER BY ORDINAL_POSITION`,[table]);
    const candidates=[];
    for(const {COLUMN_NAME:column} of columns){
      const safe=column.replace(/`/g,'``');
      const [values]=await db.query(`SELECT CAST(\`${safe}\` AS CHAR) value,COUNT(*) count FROM \`${table}\` GROUP BY \`${safe}\` ORDER BY count DESC LIMIT 12`);
      if(values.length<=10)candidates.push({column,values});
    }
    report.tables[table]=candidates;
  }
  console.log(JSON.stringify(report,null,2));
  await db.end();
}
await control.end();
