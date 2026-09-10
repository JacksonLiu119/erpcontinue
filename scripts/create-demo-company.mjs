import mysql from 'mysql2/promise';
import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();

const CONTROL_DB = process.env.DB_NAME || 'inventory_erp';
const DEMO_DB = 'inventory_erp_demo';
const DEMO_SOURCE_KEY = 'DEMO';
const DEMO_USERNAME = process.env.DEMO_FINANCE_USERNAME || 'demo_finance_admin';
const DEMO_PASSWORD = process.env.DEMO_FINANCE_PASSWORD || '';
const RESET = process.argv.includes('--reset');
const BATCH_SIZE = 500;
const SC_OFFSET = 1_000_000_000;
const cfg = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
};

const excludedDataTables = new Set([
  'erp_data_sources',
  'erp_import_batches', 'erp_import_errors', 'erp_import_logs', 'erp_import_quality_events',
  'erp_import_quality_issues', 'erp_import_reconciliations',
  'erp_master_source_mappings',
  'access_audit_log', 'access_password_reset_requests', 'access_role_permissions',
  'access_sessions', 'access_user_companies', 'access_user_departments',
  'audit_logs',
  'flow_audit_recommendation_events', 'flow_audit_recommendations',
]);

const dedupTables = new Set([
  'accounting_accounts', 'accounting_periods', 'accounting_system_parameters',
  'erp_calendars', 'erp_calendar_days', 'erp_currencies', 'erp_currency_rates',
  'finance_closing_settings', 'finance_closing_settings',
]);

const actorColumns = new Set([
  'created_by', 'updated_by', 'approved_by', 'posted_by', 'closed_by', 'reopened_by',
  'voided_by', 'priced_by', 'inspected_by', 'inventory_posted_by', 'submitted_by',
  'reviewed_by', 'requested_by', 'resolved_by', 'decided_by', 'changed_by', 'status_by',
  'source_locked_by', 'restored_by', 'completed_by',
]);

const jsonColumns = new Set([
  'raw_json', 'before_json', 'after_json', 'payload', 'details', 'metadata', 'config_json',
]);

const documentNumberColumns = new Set([
  'document_no', 'source_document_no', 'order_no', 'purchase_order_no', 'receipt_no',
  'return_no', 'requisition_no', 'change_no', 'voucher_no', 'journal_no', 'draft_no',
  'contract_no', 'forecast_no', 'schedule_no', 'pick_no', 'demand_no', 'reversal_no',
  'opening_no', 'closing_no', 'settlement_no', 'note_no', 'invoice_no', 'transaction_no',
  'transfer_no', 'move_no', 'delivery_note_no', 'depreciation_no', 'batch_no',
  'reference_no',
]);

const contextColumns = new Set(['tenant_id', 'company_id', 'source_system', 'source_database']);
const idLikeColumns = /(?:^id$|_id$)/i;
const freeTextColumns = new Set([
  'note', 'memo', 'description', 'reason', 'counterparty', 'close_note', 'reopen_note',
  'inspection_note', 'reference', 'remarks', 'remark', 'comment', 'comments',
]);
const entityTypeForColumn = {
  customer_code: 'customer',
  supplier_code: 'supplier',
  item_code: 'item',
  warehouse_code: 'warehouse',
  department_code: 'department',
  employee_code: 'employee',
};

function qi(value) {
  return `\`${String(value).replaceAll('`', '``')}\``;
}

function sourceTag(sourceKey) {
  return sourceKey === 'SH' ? 'SH' : 'SC';
}

function hashSuffix(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 8).toUpperCase();
}

function bounded(value, maxLength = 80) {
  if (value == null) return value;
  const text = String(value);
  if (!maxLength || text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 9))}-${hashSuffix(text)}`;
}

function prefixedCode(sourceKey, value, maxLength = 80, label = '') {
  if (value == null || value === '') return value;
  const prefix = `${sourceTag(sourceKey)}${label ? `-${label}` : ''}-`;
  return bounded(`${prefix}${String(value)}`, maxLength);
}

function prefixedNumber(sourceKey, value, maxLength = 80) {
  if (value == null || value === '') return value;
  return bounded(`${sourceTag(sourceKey)}-${String(value)}`, maxLength);
}

function isMaster(table, kind) {
  return table === `erp_${kind}s` || table === `${kind}s` ||
    (kind === 'item' && table === 'products') || (kind === 'warehouse' && table === 'warehouses');
}

function passwordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${digest}`;
}

async function connect(database) {
  return mysql.createConnection({ ...cfg, ...(database ? { database } : {}), charset: 'utf8mb4' });
}

async function listTables(conn, database) {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME`,
    [database],
  );
  return rows.map(row => row.TABLE_NAME);
}

async function showCreate(conn, table) {
  const [rows] = await conn.query(`SHOW CREATE TABLE ${qi(table)}`);
  return rows[0]?.['Create Table'] || rows[0]?.['Create Table'.toLowerCase()];
}

async function loadColumns(conn, database, tables) {
  if (!tables.length) return new Map();
  const [rows] = await conn.query(
    `SELECT TABLE_NAME,COLUMN_NAME,ORDINAL_POSITION,DATA_TYPE,IS_NULLABLE,COLUMN_KEY,CHARACTER_MAXIMUM_LENGTH,NUMERIC_PRECISION,NUMERIC_SCALE, COLUMN_DEFAULT
       FROM information_schema.columns
      WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME,ORDINAL_POSITION`,
    [database],
  );
  const allowed = new Set(tables);
  const result = new Map();
  for (const row of rows) {
    if (!allowed.has(row.TABLE_NAME)) continue;
    const list = result.get(row.TABLE_NAME) || [];
    list.push({
      name: row.COLUMN_NAME,
      dataType: row.DATA_TYPE,
      nullable: row.IS_NULLABLE === 'YES',
      key: row.COLUMN_KEY,
      maxLength: row.CHARACTER_MAXIMUM_LENGTH,
      precision: row.NUMERIC_PRECISION,
      scale: row.NUMERIC_SCALE,
      defaultValue: row.COLUMN_DEFAULT,
    });
    result.set(row.TABLE_NAME, list);
  }
  return result;
}

async function loadForeignKeys(conn, database) {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME,COLUMN_NAME,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE CONSTRAINT_SCHEMA=? AND REFERENCED_TABLE_NAME IS NOT NULL`,
    [database],
  );
  const result = new Map();
  for (const row of rows) {
    const byColumn = result.get(row.TABLE_NAME) || new Map();
    byColumn.set(row.COLUMN_NAME, {
      table: row.REFERENCED_TABLE_NAME,
      column: row.REFERENCED_COLUMN_NAME,
    });
    result.set(row.TABLE_NAME, byColumn);
  }
  return result;
}

async function loadUniqueIndexes(conn, database) {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX,COLUMN_NAME
       FROM information_schema.statistics
      WHERE TABLE_SCHEMA=? AND NON_UNIQUE=0 ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX`,
    [database],
  );
  const result = new Map();
  for (const row of rows) {
    if (row.INDEX_NAME === 'PRIMARY') continue;
    const table = result.get(row.TABLE_NAME) || new Map();
    const columns = table.get(row.INDEX_NAME) || [];
    columns[row.SEQ_IN_INDEX - 1] = row.COLUMN_NAME;
    table.set(row.INDEX_NAME, columns);
    result.set(row.TABLE_NAME, table);
  }
  return result;
}

function topoSort(tables, foreignKeys) {
  const known = new Set(tables);
  const dependencies = new Map(tables.map(table => [table, new Set()]));
  for (const [table, fks] of foreignKeys) {
    for (const fk of fks.values()) {
      if (known.has(fk.table) && fk.table !== table) dependencies.get(table).add(fk.table);
    }
  }
  const output = [];
  const remaining = new Set(tables);
  while (remaining.size) {
    const ready = [...remaining].filter(table => [...dependencies.get(table)].every(dep => !remaining.has(dep)));
    if (!ready.length) {
      output.push(...remaining);
      break;
    }
    ready.sort().forEach(table => {
      output.push(table);
      remaining.delete(table);
    });
  }
  return output;
}

async function ensureDatabase(conn) {
  await conn.query(`CREATE DATABASE IF NOT EXISTS ${qi(DEMO_DB)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  if (!RESET) return;
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS table_count FROM information_schema.tables WHERE TABLE_SCHEMA=?`,
    [DEMO_DB],
  );
  if (Number(rows[0].table_count) > 0) {
    await conn.query(`DROP DATABASE ${qi(DEMO_DB)}`);
    await conn.query(`CREATE DATABASE ${qi(DEMO_DB)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  }
}

async function cloneSchema(adminConn, targetConn, sourceTableLists) {
  const allTables = [...new Set(sourceTableLists.flatMap(source => source.tables))].sort();
  const ddlMap = new Map();
  const ddlDeps = new Map();
  for (const table of allTables) {
    let ddl;
    for (const source of sourceTableLists) {
      if (source.tables.includes(table)) {
        ddl = await showCreate(source.conn, table);
        if (ddl) break;
      }
    }
    if (!ddl) continue;
    ddl = ddl
      .replace(/^CREATE TABLE /i, 'CREATE TABLE IF NOT EXISTS ')
      .replace(/AUTO_INCREMENT=\d+/gi, '');
    ddlMap.set(table, ddl);
  }
  const fks = new Map();
  for (const source of sourceTableLists) {
    const sourceFks = await loadForeignKeys(source.conn, source.database);
    for (const [table, tableFks] of sourceFks) {
      const existing = fks.get(table) || new Map();
      for (const [column, fk] of tableFks) existing.set(column, fk);
      fks.set(table, existing);
    }
  }
  const order = topoSort([...ddlMap.keys()], fks);
  await targetConn.query('SET FOREIGN_KEY_CHECKS=0');
  for (const table of order) await targetConn.query(ddlMap.get(table));
  await targetConn.query('SET FOREIGN_KEY_CHECKS=1');
  return [...ddlMap.keys()];
}

async function readEntityRows(conn, database, table, columns, sourceKey) {
  if (!columns.has(table)) return [];
  const sourceColumns = columns.get(table).map(column => column.name);
  const codeColumn = sourceColumns.includes(table === 'products' ? 'sku' : 'code')
    ? (table === 'products' ? 'sku' : 'code')
    : sourceColumns.find(column => column.endsWith('_code'));
  const nameColumn = sourceColumns.includes('customer_name') ? 'customer_name'
    : sourceColumns.includes('supplier_name') ? 'supplier_name'
      : sourceColumns.includes('item_name') ? 'item_name'
        : sourceColumns.includes('warehouse_name') ? 'warehouse_name'
          : sourceColumns.includes('department_name') ? 'department_name'
            : sourceColumns.includes('employee_name') ? 'employee_name'
              : sourceColumns.includes('name') ? 'name' : null;
  if (!codeColumn || !nameColumn) return [];
  const where = sourceColumns.includes('source_database') ? ' WHERE source_database=?' : '';
  const params = sourceColumns.includes('source_database') ? [sourceKey] : [];
  const [rows] = await conn.query(
    `SELECT ${qi(codeColumn)} AS entity_code, ${qi(nameColumn)} AS entity_name FROM ${qi(table)}${where}`,
    params,
  );
  return rows;
}

async function buildEntityMaps(sourceConn, sourceKey, sourceColumns, targetColumns) {
  const definitions = [
    { kind: 'customer', tables: ['erp_customers', 'customers'], label: '客戶' },
    { kind: 'supplier', tables: ['erp_suppliers', 'suppliers'], label: '廠商' },
    { kind: 'item', tables: ['erp_items', 'products'], label: '品號' },
    { kind: 'warehouse', tables: ['erp_warehouses', 'warehouses'], label: '倉別' },
    { kind: 'department', tables: ['erp_departments'], label: '部門' },
    { kind: 'employee', tables: ['erp_employees'], label: '員工' },
  ];
  const maps = new Map();
  const replacements = [];
  for (const definition of definitions) {
    const collected = [];
    for (const table of definition.tables) {
      const rows = await readEntityRows(sourceConn, CONTROL_DB, table, sourceColumns, sourceKey);
      collected.push(...rows);
    }
    const unique = new Map();
    for (const row of collected) if (row.entity_code != null && !unique.has(String(row.entity_code))) unique.set(String(row.entity_code), row.entity_name);
    const output = new Map();
    const targetTable = definition.kind === 'customer' ? 'erp_customers'
      : definition.kind === 'supplier' ? 'erp_suppliers'
        : definition.kind === 'item' ? 'erp_items'
          : definition.kind === 'warehouse' ? 'erp_warehouses'
            : definition.kind === 'department' ? 'erp_departments' : 'erp_employees';
    const targetCodeColumn = definition.kind === 'customer' ? 'customer_code'
      : definition.kind === 'supplier' ? 'supplier_code'
        : definition.kind === 'item' ? 'item_code'
          : definition.kind === 'warehouse' ? 'warehouse_code'
            : definition.kind === 'department' ? 'department_code' : 'employee_code';
    const maxLength = targetColumns.get(targetTable)?.find(column => column.name === targetCodeColumn)?.maxLength || 80;
    [...unique.keys()].sort().forEach((code, index) => {
      const display = `Demo${definition.label}${sourceTag(sourceKey)}-${String(index + 1).padStart(5, '0')}`;
      output.set(code, { code: prefixedCode(sourceKey, code, maxLength), name: display });
      const originalName = unique.get(code);
      if (originalName) replacements.push([String(originalName), display]);
    });
    maps.set(definition.kind, output);
  }
  replacements.sort((a, b) => b[0].length - a[0].length);
  return { maps, replacements, scrubber: buildScrubber(replacements) };
}

function mapEntity(maps, kind, value, sourceKey, maxLength) {
  if (value == null || value === '') return value;
  const mapped = maps.get(kind)?.get(String(value));
  return mapped?.code || prefixedCode(sourceKey, value, maxLength);
}

function mapParty(maps, value, sourceKey, row, maxLength) {
  if (value == null || value === '') return value;
  const kind = String(row.account_type || '').toUpperCase() === 'AP' ? 'supplier' : 'customer';
  const first = mapEntity(maps, kind, value, sourceKey, maxLength);
  if (first !== prefixedCode(sourceKey, value, maxLength) || maps.get(kind)?.has(String(value))) return first;
  const alternate = kind === 'customer' ? 'supplier' : 'customer';
  return mapEntity(maps, alternate, value, sourceKey, maxLength);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildScrubber(replacements) {
  const replacementMap = new Map(replacements);
  const pattern = replacements.filter(([original]) => original && original.length >= 2).map(([original]) => escapeRegex(original)).join('|');
  const regex = pattern ? new RegExp(pattern, 'g') : null;
  return value => regex ? value.replace(regex, match => replacementMap.get(match) || match) : value;
}

function scrubText(value, replacements) {
  if (value == null || typeof value !== 'string') return value;
  if (typeof replacements === 'function') return replacements(value);
  let result = value;
  for (const [original, replacement] of replacements) {
    if (original && original.length >= 2) result = result.split(original).join(replacement);
  }
  return result;
}

function isSensitiveMasterColumn(table, column) {
  if (table === 'erp_customers' || table === 'customers') {
    return ['customer_name', 'short_name', 'contact_name', 'address', 'phone', 'email', 'tax_id', 'fax', 'mobile'].includes(column);
  }
  if (table === 'erp_suppliers' || table === 'suppliers') {
    return ['supplier_name', 'short_name', 'contact_name', 'address', 'phone', 'email', 'tax_id', 'fax', 'mobile'].includes(column);
  }
  if (table === 'erp_warehouses' || table === 'warehouses') return ['warehouse_name', 'name', 'address', 'phone'].includes(column);
  if (table === 'erp_departments') return ['department_name'].includes(column);
  if (table === 'erp_employees') return ['employee_name', 'email'].includes(column);
  return false;
}

function shouldPrefixType(table, column) {
  if (column === 'type_code' || column === 'rule_code') return true;
  if (column === 'document_type') return true;
  if (column === 'payment_term_code' || column === 'term_code') return true;
  if (column === 'bank_code' || column === 'center_code' || column === 'allocation_code') return true;
  if (column === 'parameter_code' && table === 'erp_common_parameters') return true;
  if (column === 'category_code' && table === 'erp_item_categories') return true;
  return false;
}

function transformValue({ table, column, value, row, sourceKey, offset, sourceForeignKeys, idMaps, entityMaps, replacements, scrubber, targetColumn }) {
  if (value == null) return value;
  const name = column.name;
  if (contextColumns.has(name)) {
    if (name === 'tenant_id' || name === 'company_id') return DEMO_SOURCE_KEY;
    if (name === 'source_system') return 'iSM';
    return DEMO_SOURCE_KEY;
  }
  if (name === 'source_key') return bounded(`${sourceKey}:${value}`, column.maxLength || 255);
  if (jsonColumns.has(name) || column.dataType === 'json') return null;
  if (isSensitiveMasterColumn(table, name)) {
    if (name.endsWith('_name') || name === 'name' || name === 'short_name' || name === 'contact_name') {
      const kind = table.includes('customer') || table === 'customers' ? 'customer'
        : table.includes('supplier') || table === 'suppliers' ? 'supplier'
          : table.includes('warehouse') || table === 'warehouses' ? 'warehouse'
            : table.includes('department') ? 'department' : 'employee';
      const mapped = entityMaps.get(kind)?.get(String(row.customer_code ?? row.supplier_code ?? row.item_code ?? row.warehouse_code ?? row.department_code ?? row.employee_code ?? row.code ?? ''));
      return mapped?.name || `Demo${kind}`;
    }
    return null;
  }
  if (actorColumns.has(name)) return column.nullable ? null : 1;
  const fk = sourceForeignKeys.get(name);
  if (fk && fk.column === 'id' && idLikeColumns.test(name)) {
    return idMaps.get(`${sourceKey}|${fk.table}|${value}`) ?? Number(value) + offset;
  }
  if (name === 'id') return Number(value) + offset;
  if (idLikeColumns.test(name) && !['line_no', 'version_no'].includes(name)) return Number(value) + offset;
  const kind = entityTypeForColumn[name];
  if (kind) return mapEntity(entityMaps, kind, value, sourceKey, column.maxLength || 80);
  if (name === 'party_code') return mapParty(entityMaps, value, sourceKey, row, column.maxLength || 80);
  if (name === 'external_item_code') return prefixedCode(sourceKey, value, column.maxLength || 80, 'EXT');
  if (name === 'code' && isMaster(table, 'customer')) return mapEntity(entityMaps, 'customer', value, sourceKey, column.maxLength || 80);
  if (name === 'code' && isMaster(table, 'supplier')) return mapEntity(entityMaps, 'supplier', value, sourceKey, column.maxLength || 80);
  if (name === 'code' && isMaster(table, 'item')) return mapEntity(entityMaps, 'item', value, sourceKey, column.maxLength || 80);
  if (name === 'code' && isMaster(table, 'warehouse')) return mapEntity(entityMaps, 'warehouse', value, sourceKey, column.maxLength || 80);
  if (name === 'document_no' || documentNumberColumns.has(name)) return prefixedNumber(sourceKey, value, column.maxLength || 80);
  if (name === 'source_document_no') return prefixedNumber(sourceKey, value, column.maxLength || 80);
  if (shouldPrefixType(table, name)) return prefixedCode(sourceKey, value, column.maxLength || 80);
  if (name === 'responsible_person' && entityMaps.get('employee')?.has(String(value))) return mapEntity(entityMaps, 'employee', value, sourceKey, column.maxLength || 80);
  if (name === 'company_code') return DEMO_SOURCE_KEY;
  if (name === 'account_code' || name === 'parent_account_code' || name === 'debit_account_code' || name === 'credit_account_code') return value;
  if (name === 'currency_code' || name === 'account_type' || name === 'document_kind' || name === 'source_kind') return value;
  if (typeof value === 'string') {
    if (freeTextColumns.has(name)) return bounded(scrubText(value, scrubber || replacements), column.maxLength || undefined);
    return bounded(value, column.maxLength || undefined);
  }
  return value;
}

function uniqueLookupSql(table, indexes, row, values) {
  for (const columns of indexes?.values() || []) {
    if (!columns.length || columns.some(column => !(column in values))) continue;
    const clauses = columns.map(column => `${qi(column)} <=> ?`);
    return { sql: `SELECT id FROM ${qi(table)} WHERE ${clauses.join(' AND ')} LIMIT 1`, params: columns.map(column => values[column]) };
  }
  return null;
}

async function insertRow(targetConn, table, columns, values, targetMeta, targetIndexes, useUpsert) {
  const columnNames = columns.map(column => column.name);
  const sql = `INSERT INTO ${qi(table)} (${columnNames.map(qi).join(',')}) VALUES (${columnNames.map(() => '?').join(',')})${useUpsert && targetMeta.some(column => column.name === 'id') ? ' ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)' : ' IGNORE'}`;
  const [result] = await targetConn.query(sql, columns.map(column => values[column.name]));
  const plannedId = values.id;
  if (!targetMeta.some(column => column.name === 'id')) return { inserted: result.affectedRows > 0, id: null };
  if (result.insertId) return { inserted: result.affectedRows > 0, id: Number(result.insertId) };
  if (result.affectedRows === 1 && plannedId != null) return { inserted: true, id: Number(plannedId) };
  const lookup = uniqueLookupSql(table, targetIndexes, values, values);
  if (lookup) {
    const [rows] = await targetConn.query(lookup.sql, lookup.params);
    if (rows[0]) return { inserted: false, id: Number(rows[0].id) };
  }
  return { inserted: result.affectedRows > 0, id: plannedId == null ? null : Number(plannedId) };
}

async function seedTargetAccess(targetConn) {
  const roleHash = passwordHash(crypto.randomBytes(18).toString('hex'));
  await targetConn.query(
    `INSERT IGNORE INTO access_roles(id,role_code,role_name,description,is_system) VALUES(1,'DEMO_SYSTEM','Demo系統操作員','Demo資料庫內部來源操作帳號',1)`,
  );
  await targetConn.query(
    `INSERT IGNORE INTO access_users(id,username,employee_code,display_name,password_hash,role_id,is_active,force_password_change) VALUES(1,'demo-system','DEMO','Demo系統操作員',?,1,1,0)`,
    [roleHash],
  );
}

async function insertDemoCompany(targetConn) {
  await targetConn.query(
    `INSERT INTO erp_companies(tenant_id,company_id,source_system,company_code,short_name,company_name,address,phone,tax_id,source_database,source_table,source_key)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE short_name=VALUES(short_name),company_name=VALUES(company_name),address=NULL,phone=NULL,tax_id=NULL,source_database=VALUES(source_database),source_key=VALUES(source_key)`,
    [DEMO_SOURCE_KEY, DEMO_SOURCE_KEY, 'iSM', DEMO_SOURCE_KEY, 'Demo公司', 'Demo公司', null, null, null, DEMO_SOURCE_KEY, 'demo_combined', 'DEMO:company'],
  );
}

async function copyTable({ source, target, table, sourceMeta, targetMeta, sourceForeignKeys, targetIndexes, sourceKey, offset, entityMaps, replacements, scrubber, idMaps, stats }) {
  if (!sourceMeta.has(table) || !targetMeta.has(table) || excludedDataTables.has(table) || table === 'erp_companies' || table === 'access_roles' || table === 'access_users') return;
  const sourceColumns = new Set(sourceMeta.get(table).map(column => column.name));
  const columns = targetMeta.get(table).filter(column => sourceColumns.has(column.name));
  if (!columns.length) return;
  const idColumn = columns.find(column => column.name === 'id');
  let lastId = 0;
  let offsetPage = 0;
  let done = false;
  let imported = 0;
  let skipped = 0;
  const hasSourceDatabase = sourceColumns.has('source_database');
  console.log(`[Demo] ${sourceKey} ${table}`);
  while (!done) {
    const conditions = [];
    const params = [];
    if (hasSourceDatabase) { conditions.push(`${qi('source_database')}=?`); params.push(sourceKey); }
    if (idColumn) { conditions.push(`${qi('id')}>?`); params.push(lastId); }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const order = idColumn ? ` ORDER BY ${qi('id')}` : '';
    const paging = idColumn ? ` LIMIT ${BATCH_SIZE}` : ` LIMIT ${BATCH_SIZE} OFFSET ${offsetPage * BATCH_SIZE}`;
    const [rows] = await source.query(
      `SELECT ${columns.map(column => qi(column.name)).join(',')} FROM ${qi(table)}${where}${order}${paging}`,
      params,
    );
    if (!rows.length) break;
    const transformedRows = [];
    for (const row of rows) {
      if (idColumn) lastId = Number(row.id);
      const values = {};
      for (const column of columns) {
        values[column.name] = transformValue({
          table,
          column,
          value: row[column.name],
          row,
          sourceKey,
          offset,
          sourceForeignKeys: sourceForeignKeys.get(table) || new Map(),
          idMaps,
          entityMaps,
          replacements,
          scrubber,
          targetColumn: column,
        });
      }
      transformedRows.push({ row, values });
    }
    try {
      if (dedupTables.has(table)) {
        for (const { row, values } of transformedRows) {
          const result = await insertRow(target, table, columns, values, targetMeta.get(table), targetIndexes.get(table), true);
          if (idColumn && row.id != null) idMaps.set(`${sourceKey}|${table}|${row.id}`, result.id || values.id);
          if (result.inserted) imported += 1; else skipped += 1;
        }
      } else {
        const columnNames = columns.map(column => column.name);
        const sql = `INSERT IGNORE INTO ${qi(table)} (${columnNames.map(qi).join(',')}) VALUES ${transformedRows.map(() => `(${columnNames.map(() => '?').join(',')})`).join(',')}`;
        const params = transformedRows.flatMap(({ values }) => columns.map(column => values[column.name]));
        const [result] = await target.query(sql, params);
        const batchInserted = Number(result.affectedRows || 0);
        const batchSkipped = Math.max(0, transformedRows.length - batchInserted);
        imported += batchInserted;
        skipped += batchSkipped;
        for (const { row, values } of transformedRows) {
          if (idColumn && row.id != null) idMaps.set(`${sourceKey}|${table}|${row.id}`, values.id);
        }
        // Normally source-prefixed keys and offset IDs make this branch unnecessary.
        // If an old unique key still collides, resolve only the collided rows so child FKs stay correct.
        if (batchSkipped > 0) {
          for (const { row, values } of transformedRows) {
            if (!idColumn || row.id == null) continue;
            const [[existing]] = await target.query(`SELECT id FROM ${qi(table)} WHERE id=? LIMIT 1`, [values.id]);
            if (existing) idMaps.set(`${sourceKey}|${table}|${row.id}`, Number(existing.id));
          }
        }
      }
    } catch (error) {
      error.message = `資料表 ${table}、${sourceKey}、批次起始 id ${rows[0]?.id ?? '(無 id)'}：${error.message}`;
      throw error;
    }
    if (!idColumn) offsetPage += 1;
    if (rows.length < BATCH_SIZE) done = true;
  }
  stats[table] = stats[table] || { SH: 0, SC: 0, imported: 0, skipped: 0 };
  stats[table][sourceKey] += imported + skipped;
  stats[table].imported += imported;
  stats[table].skipped += skipped;
}

async function seedControl(controlConn) {
  await controlConn.query(
    `INSERT INTO erp_data_sources(source_key,label,adapter_code,host,port,database_name,target_database,username,password_env,enabled,read_only,sort_order,tenant_id,company_id,source_system)
     VALUES(?,?,?,?,?,?,?,?,NULL,1,0,?,?,?,?)
     ON DUPLICATE KEY UPDATE label=VALUES(label),adapter_code=VALUES(adapter_code),host=VALUES(host),port=VALUES(port),database_name=VALUES(database_name),target_database=VALUES(target_database),username=VALUES(username),password_env=NULL,enabled=1,read_only=0,sort_order=VALUES(sort_order),tenant_id=VALUES(tenant_id),company_id=VALUES(company_id),source_system=VALUES(source_system)`,
    [DEMO_SOURCE_KEY, 'Demo公司', 'demo-combined', cfg.host, cfg.port, DEMO_DB, DEMO_DB, cfg.user, 30, DEMO_SOURCE_KEY, DEMO_SOURCE_KEY, 'iSM'],
  );
  const roleDescription = 'Demo公司限定；僅可使用應收、應付、自動分錄與會計總帳相關作業。';
  await controlConn.query(
    `INSERT INTO access_roles(role_code,role_name,description,is_system) VALUES(?,?,?,0)
     ON DUPLICATE KEY UPDATE role_name=VALUES(role_name),description=VALUES(description),is_system=0`,
    ['DEMO_FINANCE_ADMIN', 'Demo公司財務管理者', roleDescription],
  );
  const [[role]] = await controlConn.query(`SELECT id FROM access_roles WHERE role_code='DEMO_FINANCE_ADMIN' LIMIT 1`);
  if (!role) throw new Error('無法建立 Demo 公司限定角色');
  const permissions = [
    'finance-workflow', 'accounting-auto-rules', 'accounting-drafts', 'accounting-general-ledger',
    'accounting-periods', 'accounting-opening-balances', 'accounting-year-close', 'accounting-clearing',
  ];
  await controlConn.query(`DELETE FROM access_role_permissions WHERE role_id=?`, [role.id]);
  for (const feature of permissions) {
    await controlConn.query(
      `INSERT INTO access_role_permissions(role_id,feature_code,can_view,can_create,can_update,can_delete,can_approve) VALUES(?,?,1,1,1,1,1)`,
      [role.id, feature],
    );
  }
  if (!DEMO_PASSWORD) {
    const [[existing]] = await controlConn.query(`SELECT id FROM access_users WHERE username=? LIMIT 1`, [DEMO_USERNAME]);
    if (!existing) throw new Error('第一次建立 Demo 管理者時，請以 DEMO_FINANCE_PASSWORD 環境變數提供密碼；密碼不會寫入程式或 GitHub。');
  }
  const fields = ['employee_code','display_name','role_id','is_active','force_password_change'];
  const values = ['DEMO-FIN', 'Demo公司財務管理者', role.id, 1, 0];
  if (DEMO_PASSWORD) { fields.push('password_hash'); values.push(passwordHash(DEMO_PASSWORD)); }
  const update = fields.map(field => `${qi(field)}=VALUES(${qi(field)})`).join(',');
  await controlConn.query(
    `INSERT INTO access_users(username,${fields.map(qi).join(',')}) VALUES(?,${fields.map(() => '?').join(',')})
     ON DUPLICATE KEY UPDATE ${update}`,
    [DEMO_USERNAME, ...values],
  );
  const [[user]] = await controlConn.query(`SELECT id FROM access_users WHERE username=? LIMIT 1`, [DEMO_USERNAME]);
  await controlConn.query(`DELETE FROM access_user_companies WHERE user_id=?`, [user.id]);
  await controlConn.query(`DELETE FROM access_user_departments WHERE user_id=?`, [user.id]);
  await controlConn.query(`INSERT INTO access_user_companies(user_id,source_key,department_scope_mode) VALUES(?,?,?)`, [user.id, DEMO_SOURCE_KEY, 'all']);
  return { roleId: role.id, userId: user.id, permissions };
}

async function main() {
  if (DEMO_PASSWORD && DEMO_PASSWORD.length < 8) throw new Error('Demo 管理者密碼至少需要 8 個字元。');
  const admin = await connect(null);
  const control = await connect(CONTROL_DB);
  const sh = await connect('inventory_erp');
  const sc = await connect('inventory_erp_sc');
  let target;
  try {
    await ensureDatabase(admin);
    target = await connect(DEMO_DB);
    const shTables = await listTables(sh, 'inventory_erp');
    const scTables = await listTables(sc, 'inventory_erp_sc');
    const targetTables = await cloneSchema(admin, target, [
      { conn: sh, database: 'inventory_erp', tables: shTables },
      { conn: sc, database: 'inventory_erp_sc', tables: scTables },
    ]);
    const sourceTables = [...new Set([...shTables, ...scTables])];
    const shColumns = await loadColumns(sh, 'inventory_erp', sourceTables);
    const scColumns = await loadColumns(sc, 'inventory_erp_sc', sourceTables);
    const targetColumns = await loadColumns(target, DEMO_DB, targetTables);
    const shFks = await loadForeignKeys(sh, 'inventory_erp');
    const scFks = await loadForeignKeys(sc, 'inventory_erp_sc');
    const targetIndexes = await loadUniqueIndexes(target, DEMO_DB);
    const shEntities = await buildEntityMaps(sh, 'SH', shColumns, targetColumns);
    const scEntities = await buildEntityMaps(sc, 'SC', scColumns, targetColumns);
    await target.query('SET FOREIGN_KEY_CHECKS=0');
    await seedTargetAccess(target);
    await insertDemoCompany(target);
    const idMaps = new Map();
    const stats = {};
    const order = topoSort(targetTables, shFks);
    const sources = [
      { key: 'SH', conn: sh, columns: shColumns, fks: shFks, entities: shEntities, offset: 0, tables: shTables },
      { key: 'SC', conn: sc, columns: scColumns, fks: scFks, entities: scEntities, offset: SC_OFFSET, tables: scTables },
    ];
    for (const source of sources) {
      for (const table of order) {
        if (!source.tables.includes(table)) continue;
        await copyTable({
          source: source.conn,
          target,
          table,
          sourceMeta: source.columns,
          targetMeta: targetColumns,
          sourceForeignKeys: source.fks,
          targetIndexes,
          sourceKey: source.key,
          offset: source.offset,
          entityMaps: source.entities.maps,
          replacements: source.entities.replacements,
          scrubber: source.entities.scrubber,
          idMaps,
          stats,
        });
      }
    }
    await target.query('SET FOREIGN_KEY_CHECKS=1');
    await seedControl(control);
    const tableTotals = Object.values(stats).reduce((sum, row) => sum + row.imported, 0);
    console.log(JSON.stringify({
      ok: true,
      database: DEMO_DB,
      company: 'Demo公司',
      source_databases: ['SH', 'SC'],
      tables: targetTables.length,
      imported_rows: tableTotals,
      table_stats: stats,
      account: { username: DEMO_USERNAME, password_set: Boolean(DEMO_PASSWORD), role: 'DEMO_FINANCE_ADMIN', source_key: DEMO_SOURCE_KEY },
      anonymized: ['公司名稱、客戶／廠商名稱、聯絡資料、公司識別資料；業務代碼與來源鍵保留去識別化前綴'],
    }, null, 2));
  } finally {
    if (target) await target.end().catch(() => {});
    await Promise.all([admin, control, sh, sc].map(conn => conn.end().catch(() => {})));
  }
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
