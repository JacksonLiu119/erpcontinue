import 'dotenv/config';
import mysql from 'mysql2/promise';
import { fileURLToPath } from 'node:url';

export const TEST_ITEM = '20260811001';
export const TEST_MARKER = `FLOWTEST:${TEST_ITEM}`;

export async function cleanup(db) {
  await db.beginTransaction();
  try {
    const [sales] = await db.query(`SELECT DISTINCT d.id FROM sales_documents d JOIN sales_document_items i ON i.document_id=d.id WHERE i.item_code=?`,[TEST_ITEM]);
    const [receipts] = await db.query(`SELECT DISTINCT r.id FROM procurement_receipts r JOIN procurement_receipt_items i ON i.receipt_id=r.id WHERE i.item_code=?`,[TEST_ITEM]);
    const [orders] = await db.query(`SELECT DISTINCT o.id FROM procurement_orders o JOIN procurement_order_items i ON i.purchase_order_id=o.id WHERE i.item_code=?`,[TEST_ITEM]);
    const [reqs] = await db.query(`SELECT DISTINCT r.id FROM procurement_requisitions r JOIN procurement_requisition_items i ON i.requisition_id=r.id WHERE i.item_code=?`,[TEST_ITEM]);
    const ids = rows => rows.map(x=>x.id);
    await db.query(`DELETE FROM finance_notes WHERE memo=?`,[TEST_MARKER]);
    await db.query(`DELETE a FROM finance_allocations a JOIN finance_settlements s ON s.id=a.settlement_id WHERE s.note=?`,[TEST_MARKER]);
    await db.query(`DELETE FROM finance_settlements WHERE note=?`,[TEST_MARKER]);
    await db.query(`DELETE FROM finance_open_items WHERE note=?`,[TEST_MARKER]);
    await db.query(`DELETE FROM inventory_movement_ledger WHERE item_code=?`,[TEST_ITEM]);
    if(ids(sales).length) await db.query(`DELETE FROM sales_documents WHERE id IN (?)`,[ids(sales)]);
    if(ids(receipts).length) await db.query(`DELETE FROM procurement_receipts WHERE id IN (?)`,[ids(receipts)]);
    if(ids(orders).length) await db.query(`DELETE FROM procurement_orders WHERE id IN (?)`,[ids(orders)]);
    if(ids(reqs).length) await db.query(`DELETE FROM procurement_requisitions WHERE id IN (?)`,[ids(reqs)]);
    await db.query(`DELETE FROM erp_inventory_balances WHERE item_code=?`,[TEST_ITEM]);
    await db.query(`DELETE FROM erp_items WHERE item_code=? AND source_key=?`,[TEST_ITEM,TEST_MARKER]);
    await db.query(`DELETE FROM erp_customers WHERE customer_code='FLOW-CUST' AND source_key=?`,[TEST_MARKER]);
    await db.query(`DELETE FROM erp_suppliers WHERE supplier_code='FLOW-SUPP' AND source_key=?`,[TEST_MARKER]);
    await db.commit();
    return {sales:ids(sales).length,receipts:ids(receipts).length,orders:ids(orders).length,requisitions:ids(reqs).length};
  } catch (error) { await db.rollback(); throw error; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db=await mysql.createConnection({host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER||'root',password:process.env.DB_PASSWORD||'',database:process.env.DB_NAME||'inventory_erp'});
  console.log('removed',await cleanup(db)); await db.end();
}
