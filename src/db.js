import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

dotenv.config();

const baseConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
  decimalNumbers: true
};

export const sourceDatabases = Object.create(null); /* legacy hardcoded list removed; loaded from erp_data_sources */
/*
  SH: { database: 'sh', label: 'SH（目前資料庫）' },
  SMARTDSCSYS: { database: 'smartdscsys', label: 'SMARTDSCSYS（已匯入）' },
  DSCRPT: { database: 'dscrpt', label: 'DSCRPT（報表定義）' }
};
*/

const controlDatabase = process.env.DB_NAME || 'inventory_erp';
export const controlPool = mysql.createPool({ ...baseConfig, database: controlDatabase });
const targetContext = new AsyncLocalStorage();
const targetPools = new Map();

function activePool() { return targetContext.getStore()?.pool || controlPool; }
export const pool = new Proxy(controlPool, {
  get(_target, property) {
    const selected = activePool();
    const value = selected[property];
    return typeof value === 'function' ? value.bind(selected) : value;
  }
});

export function runWithTargetDatabase(sourceName, work) {
  const source = sourceDatabases[String(sourceName || '').toUpperCase()];
  const database = source?.target_database;
  if (!database || database === controlDatabase) return work();
  if (!targetPools.has(database)) targetPools.set(database, mysql.createPool({ ...baseConfig, database, connectionLimit: 10 }));
  return targetContext.run({ pool: targetPools.get(database), sourceName: source.key, database }, work);
}

const sourcePools = new Map();
export function getSourcePool(sourceName = 'SH') {
  const key = String(sourceName).toUpperCase();
  const source = sourceDatabases[key];
  if (!source) throw new Error(`不允許的資料庫來源：${sourceName}`);
  if (!sourcePools.has(key)) {
    const password = source.password_env ? (process.env[source.password_env] || '') : baseConfig.password;
    sourcePools.set(key, mysql.createPool({
      ...baseConfig,
      host: source.host || baseConfig.host,
      port: Number(source.port || baseConfig.port),
      user: source.username || baseConfig.user,
      password,
      database: source.database,
      connectionLimit: 5
    }));
  }
  return sourcePools.get(key);
}

// 資料來源只有在採購、庫存、銷售三個核心模組都存在實際資料時，
// 才能登錄成可切換的營運公司。系統庫、報表庫與空資料庫會被拒絕。
export async function validateOperationalSource(config = {}) {
  const connection = await mysql.createConnection({
    ...baseConfig,
    host: config.host || baseConfig.host,
    port: Number(config.port || baseConfig.port),
    user: config.username || baseConfig.user,
    password: config.password_env ? (process.env[config.password_env] || '') : baseConfig.password,
    database: config.database_name,
  });
  try {
    const [tables] = await connection.query(`SELECT TABLE_NAME table_name, TABLE_ROWS estimated_rows
      FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'`);
    const names = tables.map(row => String(row.table_name));
    // 排除 PURMA/COPMA/INVMB 等純主檔；必須找到實際交易或庫存帳資料。
    const groups = {
      procurement: names.filter(name => /^(PURT[A-Z]|PURH[A-Z]|PURL[A-Z])$/i.test(name)),
      inventory: names.filter(name => /^(INVT[A-Z]|INVL[A-Z])$/i.test(name)),
      sales: names.filter(name => /^(COPT[A-Z]|COPL[A-Z])$/i.test(name)),
    };
    const result = {};
    for (const [group, candidates] of Object.entries(groups)) {
      let dataTable = null;
      let rowCount = 0;
      for (const table of candidates.slice(0, 30)) {
        const safeTable = table.replace(/`/g, '``');
        const [[row]] = await connection.query(`SELECT COUNT(*) count FROM \`${safeTable}\` LIMIT 1`);
        if (Number(row.count) > 0) { dataTable = table; rowCount = Number(row.count); break; }
      }
      result[group] = { passed: Boolean(dataTable), table: dataTable, row_count: rowCount, candidates: candidates.length };
    }
    const passed = Object.values(result).every(item => item.passed);
    return { passed, database: config.database_name, table_count: names.length, modules: result };
  } finally {
    await connection.end();
  }
}

export async function reloadSourceDatabases() {
  const [rows] = await pool.query(`SELECT source_key, label, adapter_code, host, port,
      database_name, target_database, username, password_env, tenant_id, company_id, source_system,
      enabled, read_only, sort_order
    FROM erp_data_sources WHERE enabled=1 ORDER BY sort_order, source_key`);
  for (const key of Object.keys(sourceDatabases)) delete sourceDatabases[key];
  for (const row of rows) {
    const key = String(row.source_key).toUpperCase();
    sourceDatabases[key] = {
      key, label: row.label, adapter_code: row.adapter_code, host: row.host,
      port: Number(row.port), database: row.database_name, target_database: row.target_database || (process.env.DB_NAME || 'inventory_erp'), username: row.username,
      password_env: row.password_env, enabled: Boolean(row.enabled),
      read_only: Boolean(row.read_only), sort_order: Number(row.sort_order),
      tenant_id: row.tenant_id, company_id: row.company_id, source_system: row.source_system
    };
    sourcePools.get(key)?.end().catch(() => {});
    sourcePools.delete(key);
  }
  return sourceDatabases;
}

let procurementSchemaPromise;
async function addColumnIfMissing(table, column, definition) {
  const [[row]] = await pool.query(
    'SELECT COUNT(*) AS count FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',
    [table, column]
  );
  if (!Number(row.count)) {
    try {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      return true;
    } catch (error) {
      // Two first requests can initialise the same target schema concurrently.
      // If one request already added the column, the other request can continue safely.
      if (error.code !== 'ER_DUP_FIELDNAME') throw error;
    }
  }
  return false;
}

export function ensureProcurementSchema() {
  if (!procurementSchemaPromise) {
    procurementSchemaPromise = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS erp_data_sources (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        source_key VARCHAR(60) NOT NULL UNIQUE,
        label VARCHAR(120) NOT NULL,
        adapter_code VARCHAR(60) NOT NULL,
        host VARCHAR(255) NOT NULL DEFAULT '127.0.0.1',
        port INT UNSIGNED NOT NULL DEFAULT 3306,
        database_name VARCHAR(120) NOT NULL,
        target_database VARCHAR(120) NULL,
        username VARCHAR(120) NOT NULL DEFAULT 'root',
        password_env VARCHAR(120) NULL,
        tenant_id VARCHAR(60) NOT NULL DEFAULT 'SH',
        company_id VARCHAR(60) NOT NULL DEFAULT 'SH',
        source_system VARCHAR(60) NOT NULL DEFAULT 'iSM',
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        read_only TINYINT(1) NOT NULL DEFAULT 1,
        sort_order INT NOT NULL DEFAULT 100,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`INSERT IGNORE INTO erp_data_sources
        (source_key, label, adapter_code, host, port, database_name, username, password_env, enabled, read_only, sort_order)
        VALUES
        ('SH', 'SH（鼎新營運資料）', 'ism-sh', '127.0.0.1', 3306, 'sh', 'root', NULL, 1, 1, 10)`);
      await addColumnIfMissing('erp_data_sources', 'tenant_id', "VARCHAR(60) NOT NULL DEFAULT 'SH'");
      await addColumnIfMissing('erp_data_sources', 'company_id', "VARCHAR(60) NOT NULL DEFAULT 'SH'");
      await addColumnIfMissing('erp_data_sources', 'source_system', "VARCHAR(60) NOT NULL DEFAULT 'iSM'");
      await addColumnIfMissing('erp_data_sources', 'target_database', "VARCHAR(120) NULL");
      await pool.query(`UPDATE erp_data_sources
        SET tenant_id=CASE WHEN tenant_id='SH' AND source_key<>'SH' THEN source_key ELSE tenant_id END,
            company_id=CASE WHEN company_id='SH' AND source_key<>'SH' THEN source_key ELSE company_id END,
            source_system=CASE WHEN source_system IS NULL OR source_system='' THEN 'iSM' ELSE source_system END`);
      await pool.query(`CREATE TABLE IF NOT EXISTS erp_warehouses (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
         source_database VARCHAR(60) NOT NULL,
         tenant_id VARCHAR(60) NOT NULL DEFAULT 'SH',
         company_id VARCHAR(60) NOT NULL DEFAULT 'SH',
         source_system VARCHAR(60) NOT NULL DEFAULT 'iSM',
         warehouse_code VARCHAR(30) NOT NULL,
        warehouse_name VARCHAR(120) NOT NULL,
        site_code VARCHAR(30) NULL,
        warehouse_type VARCHAR(20) NULL,
        allow_in VARCHAR(5) NULL,
        allow_out VARCHAR(5) NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        source_table VARCHAR(60) NULL,
        source_key VARCHAR(160) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_erp_warehouse_source (source_database, warehouse_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS erp_departments (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
         source_database VARCHAR(60) NOT NULL,
         tenant_id VARCHAR(60) NOT NULL DEFAULT 'SH',
         company_id VARCHAR(60) NOT NULL DEFAULT 'SH',
         source_system VARCHAR(60) NOT NULL DEFAULT 'iSM',
         department_code VARCHAR(30) NOT NULL,
        department_name VARCHAR(120) NOT NULL,
        note VARCHAR(255) NULL,
        account_code VARCHAR(30) NULL,
        source_table VARCHAR(60) NULL,
        source_key VARCHAR(160) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_erp_department_source (source_database, department_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS erp_employees (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
         source_database VARCHAR(60) NOT NULL,
         tenant_id VARCHAR(60) NOT NULL DEFAULT 'SH',
         company_id VARCHAR(60) NOT NULL DEFAULT 'SH',
         source_system VARCHAR(60) NOT NULL DEFAULT 'iSM',
         employee_code VARCHAR(30) NOT NULL,
        employee_name VARCHAR(120) NOT NULL,
        company_code VARCHAR(30) NULL,
        department_code VARCHAR(30) NULL,
        job_title VARCHAR(80) NULL,
        email VARCHAR(120) NULL,
        source_table VARCHAR(60) NULL,
        source_key VARCHAR(160) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_erp_employee_source (source_database, employee_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS erp_customers (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
         source_database VARCHAR(60) NOT NULL,
         tenant_id VARCHAR(60) NOT NULL DEFAULT 'SH',
         company_id VARCHAR(60) NOT NULL DEFAULT 'SH',
         source_system VARCHAR(60) NOT NULL DEFAULT 'iSM',
         customer_code VARCHAR(30) NOT NULL,
        short_name VARCHAR(30) NULL,
        customer_name VARCHAR(160) NOT NULL,
        responsible_person VARCHAR(80) NULL,
        contact_name VARCHAR(80) NULL,
        phone VARCHAR(40) NULL,
        fax VARCHAR(40) NULL,
        email VARCHAR(120) NULL,
        mobile VARCHAR(40) NULL,
        tax_id VARCHAR(30) NULL,
        currency_code VARCHAR(10) NULL,
        payment_term_code VARCHAR(30) NULL,
        payment_term_source_value VARCHAR(80) NULL,
        invoice_type VARCHAR(10) NULL,
        tax_type VARCHAR(10) NULL,
        closing_day VARCHAR(10) NULL,
        source_table VARCHAR(60) NULL,
        source_key VARCHAR(160) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_erp_customer_source (source_database, customer_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS erp_suppliers (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
         source_database VARCHAR(60) NOT NULL,
         tenant_id VARCHAR(60) NOT NULL DEFAULT 'SH',
         company_id VARCHAR(60) NOT NULL DEFAULT 'SH',
         source_system VARCHAR(60) NOT NULL DEFAULT 'iSM',
         supplier_code VARCHAR(30) NOT NULL,
        short_name VARCHAR(30) NULL,
        supplier_name VARCHAR(160) NOT NULL,
        supplier_class VARCHAR(30) NULL,
        responsible_person VARCHAR(80) NULL,
        contact_name VARCHAR(80) NULL,
        phone VARCHAR(40) NULL,
        fax VARCHAR(40) NULL,
        email VARCHAR(120) NULL,
        mobile VARCHAR(40) NULL,
        tax_id VARCHAR(30) NULL,
        currency_code VARCHAR(10) NULL,
        payment_method VARCHAR(10) NULL,
        payment_term_code VARCHAR(30) NULL,
        payment_term_source_value VARCHAR(80) NULL,
        invoice_type VARCHAR(10) NULL,
        tax_type VARCHAR(10) NULL,
        closing_month_offset VARCHAR(10) NULL,
        closing_day VARCHAR(10) NULL,
        source_table VARCHAR(60) NULL,
        source_key VARCHAR(160) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
         UNIQUE KEY uq_erp_supplier_source (source_database, supplier_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      const standardMasterKeys = [
        ['erp_warehouses', 'warehouse_code', 'uq_erp_warehouse_source', 'uq_erp_warehouse_tenant_company'],
        ['erp_departments', 'department_code', 'uq_erp_department_source', 'uq_erp_department_tenant_company'],
        ['erp_employees', 'employee_code', 'uq_erp_employee_source', 'uq_erp_employee_tenant_company'],
        ['erp_customers', 'customer_code', 'uq_erp_customer_source', 'uq_erp_customer_tenant_company'],
        ['erp_suppliers', 'supplier_code', 'uq_erp_supplier_source', 'uq_erp_supplier_tenant_company']
      ];
      for (const [table, codeField, oldIndex, newIndex] of standardMasterKeys) {
        await addColumnIfMissing(table, 'tenant_id', "VARCHAR(60) NOT NULL DEFAULT 'SH'");
        await addColumnIfMissing(table, 'company_id', "VARCHAR(60) NOT NULL DEFAULT 'SH'");
        await addColumnIfMissing(table, 'source_system', "VARCHAR(60) NOT NULL DEFAULT 'iSM'");
        await pool.query(`UPDATE ${table} SET tenant_id=source_database, company_id=source_database, source_system='iSM'
          WHERE tenant_id='SH' AND company_id='SH' AND source_database<>'SH'`);
        try { await pool.query(`ALTER TABLE ${table} DROP INDEX ${oldIndex}`); } catch (_) { /* already migrated */ }
        try { await pool.query(`ALTER TABLE ${table} ADD UNIQUE KEY ${newIndex} (tenant_id, company_id, source_system, ${codeField})`); } catch (_) { /* already migrated */ }
      }
      for (const [table, columns] of Object.entries({
        erp_customers: {
          responsible_person: 'VARCHAR(80) NULL', fax: 'VARCHAR(40) NULL', mobile: 'VARCHAR(40) NULL',
          currency_code: 'VARCHAR(10) NULL', payment_term_code: 'VARCHAR(30) NULL', payment_term_source_value: 'VARCHAR(80) NULL',
          invoice_type: 'VARCHAR(10) NULL', tax_type: 'VARCHAR(10) NULL', closing_day: 'VARCHAR(10) NULL'
        },
        erp_suppliers: {
          supplier_class: 'VARCHAR(30) NULL', responsible_person: 'VARCHAR(80) NULL', fax: 'VARCHAR(40) NULL', mobile: 'VARCHAR(40) NULL',
          currency_code: 'VARCHAR(10) NULL', payment_method: 'VARCHAR(10) NULL', payment_term_code: 'VARCHAR(30) NULL',
          payment_term_source_value: 'VARCHAR(80) NULL', invoice_type: 'VARCHAR(10) NULL', tax_type: 'VARCHAR(10) NULL',
          closing_month_offset: 'VARCHAR(10) NULL', closing_day: 'VARCHAR(10) NULL'
        }
      })) {
        for (const [column, definition] of Object.entries(columns)) await addColumnIfMissing(table, column, definition);
      }
      await pool.query(`CREATE TABLE IF NOT EXISTS erp_companies (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(60) NOT NULL DEFAULT 'SH', company_id VARCHAR(60) NOT NULL DEFAULT 'SH', source_system VARCHAR(60) NOT NULL DEFAULT 'iSM',
        company_code VARCHAR(30) NOT NULL, short_name VARCHAR(60) NULL, company_name VARCHAR(160) NOT NULL,
        address VARCHAR(255) NULL, phone VARCHAR(40) NULL, tax_id VARCHAR(30) NULL,
        source_database VARCHAR(60) NOT NULL, source_table VARCHAR(60) NULL, source_key VARCHAR(160) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_erp_company_context (tenant_id, company_id, source_system, company_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS erp_code_rules (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(60) NOT NULL DEFAULT 'SH', company_id VARCHAR(60) NOT NULL DEFAULT 'SH', source_system VARCHAR(60) NOT NULL DEFAULT 'iSM',
        rule_type VARCHAR(20) NOT NULL, rule_value VARCHAR(120) NULL, rule_code VARCHAR(30) NULL, default_name VARCHAR(120) NULL,
        source_database VARCHAR(60) NOT NULL, source_table VARCHAR(60) NULL, source_key VARCHAR(160) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_erp_code_rule_context (tenant_id, company_id, source_system, rule_type, rule_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS erp_common_parameters (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(60) NOT NULL DEFAULT 'SH', company_id VARCHAR(60) NOT NULL DEFAULT 'SH', source_system VARCHAR(60) NOT NULL DEFAULT 'iSM',
        parameter_code VARCHAR(30) NOT NULL, parameter_value TEXT NULL, data_type VARCHAR(20) NULL, source_field VARCHAR(30) NOT NULL,
        source_database VARCHAR(60) NOT NULL, source_table VARCHAR(60) NULL, source_key VARCHAR(160) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_erp_common_parameter_context (tenant_id, company_id, source_system, parameter_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS erp_item_categories (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(60) NOT NULL DEFAULT 'SH', company_id VARCHAR(60) NOT NULL DEFAULT 'SH', source_system VARCHAR(60) NOT NULL DEFAULT 'iSM',
        category_type VARCHAR(10) NOT NULL, category_code VARCHAR(30) NOT NULL, category_name VARCHAR(120) NOT NULL,
        source_database VARCHAR(60) NOT NULL, source_table VARCHAR(60) NULL, source_key VARCHAR(160) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_erp_item_category_context (tenant_id, company_id, source_system, category_type, category_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS erp_items (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(60) NOT NULL DEFAULT 'SH', company_id VARCHAR(60) NOT NULL DEFAULT 'SH', source_system VARCHAR(60) NOT NULL DEFAULT 'iSM',
        item_code VARCHAR(40) NOT NULL, item_name VARCHAR(160) NOT NULL, specification VARCHAR(160) NULL, unit VARCHAR(20) NULL,
        category_1 VARCHAR(30) NULL, category_2 VARCHAR(30) NULL, category_3 VARCHAR(30) NULL, category_4 VARCHAR(30) NULL,
        source_database VARCHAR(60) NOT NULL, source_table VARCHAR(60) NULL, source_key VARCHAR(160) NULL, raw_json JSON NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_erp_item_context (tenant_id, company_id, source_system, item_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await addColumnIfMissing('erp_items', 'category_4', 'VARCHAR(30) NULL');
      await pool.query(`CREATE TABLE IF NOT EXISTS erp_job_categories (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
        job_code VARCHAR(30) NOT NULL, job_category VARCHAR(10) NULL, job_name VARCHAR(120) NULL, note VARCHAR(255) NULL,
        source_database VARCHAR(60) NOT NULL, source_table VARCHAR(60) NULL, source_key VARCHAR(160) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_erp_job_category_context (tenant_id, company_id, source_system, job_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS erp_job_category_employees (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
        assignment_code VARCHAR(80) NOT NULL, job_code VARCHAR(30) NOT NULL, employee_code VARCHAR(30) NOT NULL,
        assignment_type VARCHAR(10) NULL, assignment_name VARCHAR(120) NULL, note VARCHAR(255) NULL,
        source_database VARCHAR(60) NOT NULL, source_table VARCHAR(60) NULL, source_key VARCHAR(160) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_erp_job_employee_context (tenant_id, company_id, source_system, job_code, employee_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS erp_currencies (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
        currency_code VARCHAR(10) NOT NULL, currency_name VARCHAR(120) NOT NULL,
        unit_price_digits TINYINT UNSIGNED NULL, amount_digits TINYINT UNSIGNED NULL,
        unit_cost_digits TINYINT UNSIGNED NULL, cost_amount_digits TINYINT UNSIGNED NULL, note VARCHAR(255) NULL,
        source_database VARCHAR(60) NOT NULL, source_table VARCHAR(60) NULL, source_key VARCHAR(160) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_erp_currency_context (tenant_id, company_id, source_system, currency_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS erp_currency_rates (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
        rate_code VARCHAR(40) NOT NULL, currency_code VARCHAR(10) NOT NULL, effective_date CHAR(8) NOT NULL,
        bank_buy_rate DECIMAL(18,6) NULL, bank_sell_rate DECIMAL(18,6) NULL,
        customs_buy_rate DECIMAL(18,6) NULL, customs_sell_rate DECIMAL(18,6) NULL,
        source_database VARCHAR(60) NOT NULL, source_table VARCHAR(60) NULL, source_key VARCHAR(160) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_erp_currency_rate_context (tenant_id, company_id, source_system, currency_code, effective_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS erp_payment_terms (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
        term_type VARCHAR(10) NOT NULL, term_code VARCHAR(30) NOT NULL, term_name VARCHAR(120) NOT NULL,
        due_rule_type VARCHAR(10) NULL, due_offset DECIMAL(10,2) NULL, due_base_type VARCHAR(10) NULL, due_base_day VARCHAR(10) NULL,
        realization_rule_type VARCHAR(10) NULL, realization_offset DECIMAL(10,2) NULL,
        realization_base_type VARCHAR(10) NULL, realization_base_day VARCHAR(10) NULL,
        is_enabled VARCHAR(5) NULL, due_months DECIMAL(10,2) NULL, due_day DECIMAL(10,2) NULL,
        realization_months DECIMAL(10,2) NULL, realization_day DECIMAL(10,2) NULL, note VARCHAR(255) NULL,
        source_database VARCHAR(60) NOT NULL, source_table VARCHAR(60) NULL, source_key VARCHAR(160) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_erp_payment_term_context (tenant_id, company_id, source_system, term_type, term_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS erp_calendars (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
        calendar_code VARCHAR(60) NOT NULL, industry_type VARCHAR(10) NOT NULL, calendar_year CHAR(4) NOT NULL,
        shift_code VARCHAR(20) NOT NULL, shift_name VARCHAR(120) NULL, note VARCHAR(255) NULL,
        source_database VARCHAR(60) NOT NULL, source_table VARCHAR(60) NULL, source_key VARCHAR(160) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_erp_calendar_context (tenant_id, company_id, source_system, industry_type, calendar_year, shift_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS erp_calendar_days (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
        calendar_day_code VARCHAR(80) NOT NULL, calendar_code VARCHAR(60) NOT NULL,
        industry_type VARCHAR(10) NOT NULL, calendar_year CHAR(4) NOT NULL, shift_code VARCHAR(20) NOT NULL,
        work_date CHAR(8) NOT NULL, day_type VARCHAR(10) NULL, work_hours DECIMAL(10,2) NULL, note VARCHAR(255) NULL, closed_flag VARCHAR(5) NULL,
        source_database VARCHAR(60) NOT NULL, source_table VARCHAR(60) NULL, source_key VARCHAR(160) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_erp_calendar_day_context (tenant_id, company_id, source_system, industry_type, calendar_year, shift_code, work_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS erp_inventory_opening_batches (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        opening_no VARCHAR(60) NOT NULL,
        tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
        source_database VARCHAR(60) NOT NULL, source_table VARCHAR(60) NOT NULL DEFAULT 'invmc',
        opening_date CHAR(8) NOT NULL, status VARCHAR(30) NOT NULL DEFAULT 'draft',
        source_rows INT UNSIGNED NOT NULL DEFAULT 0, imported_rows INT UNSIGNED NOT NULL DEFAULT 0,
        error_rows INT UNSIGNED NOT NULL DEFAULT 0, warning_rows INT UNSIGNED NOT NULL DEFAULT 0,
        total_quantity DECIMAL(24,3) NOT NULL DEFAULT 0, total_amount DECIMAL(24,6) NOT NULL DEFAULT 0,
        import_batch_id BIGINT UNSIGNED NULL, note VARCHAR(500) NULL,
        created_by BIGINT UNSIGNED NULL, validated_by BIGINT UNSIGNED NULL, validated_at DATETIME NULL,
        approved_by BIGINT UNSIGNED NULL, approved_at DATETIME NULL, posted_by BIGINT UNSIGNED NULL, posted_at DATETIME NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_erp_inventory_opening_no (tenant_id, company_id, source_system, opening_no),
        KEY ix_erp_inventory_opening_status (tenant_id, company_id, source_system, status, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS erp_inventory_opening_lines (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        batch_id BIGINT UNSIGNED NOT NULL, line_no INT UNSIGNED NOT NULL,
        item_code VARCHAR(40) NOT NULL, item_name VARCHAR(160) NULL, specification VARCHAR(160) NULL, unit VARCHAR(20) NULL,
        warehouse_code VARCHAR(30) NOT NULL, warehouse_name VARCHAR(120) NULL, location_code VARCHAR(30) NULL,
        quantity DECIMAL(24,3) NOT NULL DEFAULT 0, unit_cost DECIMAL(24,6) NOT NULL DEFAULT 0, amount DECIMAL(24,6) NOT NULL DEFAULT 0,
        validation_status VARCHAR(20) NOT NULL DEFAULT 'ok', validation_message VARCHAR(500) NULL, note VARCHAR(255) NULL,
        source_table VARCHAR(60) NOT NULL DEFAULT 'invmc', source_key VARCHAR(160) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_erp_inventory_opening_line (batch_id, line_no),
        UNIQUE KEY uq_erp_inventory_opening_source (batch_id, source_key),
        KEY ix_erp_inventory_opening_item (batch_id, item_code, warehouse_code),
        CONSTRAINT fk_erp_inventory_opening_line_batch FOREIGN KEY (batch_id) REFERENCES erp_inventory_opening_batches(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS erp_inventory_balances (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
        item_code VARCHAR(40) NOT NULL, warehouse_code VARCHAR(30) NOT NULL, location_code VARCHAR(30) NOT NULL DEFAULT '',
        quantity_on_hand DECIMAL(24,3) NOT NULL DEFAULT 0, unit_cost DECIMAL(24,6) NOT NULL DEFAULT 0,
        inventory_amount DECIMAL(24,6) NOT NULL DEFAULT 0, opening_batch_id BIGINT UNSIGNED NULL,
        last_movement_at DATETIME NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_erp_inventory_balance (tenant_id, company_id, source_system, item_code, warehouse_code, location_code),
        KEY ix_erp_inventory_balance_warehouse (tenant_id, company_id, warehouse_code, item_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS inventory_document_types (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
        type_code VARCHAR(20) NOT NULL, type_name VARCHAR(80) NOT NULL,
        movement_kind ENUM('issue','return','adjust_in','adjust_out','scrap','cost_adjust','transfer','temp_in','temp_in_return','temp_out','temp_out_return','stocktake') NOT NULL,
        number_prefix VARCHAR(20) NOT NULL, requires_approval TINYINT(1) NOT NULL DEFAULT 1,
        allow_negative TINYINT(1) NOT NULL DEFAULT 0, is_active TINYINT(1) NOT NULL DEFAULT 1, note VARCHAR(255) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_inventory_document_type (tenant_id,company_id,source_system,type_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`INSERT IGNORE INTO inventory_document_types
        (tenant_id,company_id,source_system,type_code,type_name,movement_kind,number_prefix,requires_approval,allow_negative) VALUES
        ('default','SH','ism-sh','IS','其他領料','issue','IS',1,0),('default','SH','ism-sh','RT','其他退料','return','RT',1,0),
        ('default','SH','ism-sh','AI','庫存增加調整','adjust_in','AI',1,0),('default','SH','ism-sh','AO','庫存減少調整','adjust_out','AO',1,0),
        ('default','SH','ism-sh','SC','庫存報廢','scrap','SC',1,0),('default','SH','ism-sh','CA','庫存成本調整','cost_adjust','CA',1,0),
        ('default','SH','ism-sh','TR','庫存轉撥','transfer','TR',1,0),('default','SH','ism-sh','TI','暫入','temp_in','TI',1,0),
        ('default','SH','ism-sh','TIR','暫入歸還','temp_in_return','TIR',1,0),('default','SH','ism-sh','TO','暫出','temp_out','TO',1,0),
        ('default','SH','ism-sh','TOR','暫出歸還','temp_out_return','TOR',1,0),('default','SH','ism-sh','ST','盤點調整','stocktake','ST',1,0)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS inventory_documents (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
        document_no VARCHAR(60) NOT NULL, document_type VARCHAR(20) NOT NULL, movement_kind VARCHAR(30) NOT NULL, document_date DATE NOT NULL,
        department_code VARCHAR(30) NULL, employee_code VARCHAR(30) NULL, counterparty VARCHAR(120) NULL,
        status ENUM('draft','approved','posted','voided') NOT NULL DEFAULT 'draft', note VARCHAR(500) NULL,
        created_by BIGINT UNSIGNED NULL, approved_by BIGINT UNSIGNED NULL, approved_at DATETIME NULL, posted_by BIGINT UNSIGNED NULL, posted_at DATETIME NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_inventory_document (tenant_id,company_id,source_system,document_no), KEY ix_inventory_document_status(source_database,movement_kind,status,document_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS inventory_document_items (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, document_id BIGINT UNSIGNED NOT NULL, line_no INT UNSIGNED NOT NULL DEFAULT 1,
        item_code VARCHAR(40) NOT NULL, item_name VARCHAR(160) NULL, specification VARCHAR(160) NULL, unit VARCHAR(20) NOT NULL DEFAULT 'PCS',
        from_warehouse_code VARCHAR(30) NULL, to_warehouse_code VARCHAR(30) NULL, location_code VARCHAR(30) NOT NULL DEFAULT '', lot_no VARCHAR(80) NOT NULL DEFAULT '',
        quantity DECIMAL(24,3) NOT NULL DEFAULT 0, counted_quantity DECIMAL(24,3) NULL, unit_cost DECIMAL(24,6) NOT NULL DEFAULT 0,
        amount_delta DECIMAL(24,6) NOT NULL DEFAULT 0, reason VARCHAR(255) NULL,
        UNIQUE KEY uq_inventory_document_item(document_id,line_no), CONSTRAINT fk_inventory_document_item FOREIGN KEY(document_id) REFERENCES inventory_documents(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS inventory_movement_ledger (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
        document_id BIGINT UNSIGNED NULL, document_no VARCHAR(60) NOT NULL, document_type VARCHAR(20) NOT NULL, movement_kind VARCHAR(30) NOT NULL,
        movement_date DATE NOT NULL, item_code VARCHAR(40) NOT NULL, warehouse_code VARCHAR(30) NOT NULL, location_code VARCHAR(30) NOT NULL DEFAULT '', lot_no VARCHAR(80) NOT NULL DEFAULT '',
        quantity_delta DECIMAL(24,3) NOT NULL DEFAULT 0, unit_cost DECIMAL(24,6) NOT NULL DEFAULT 0, amount_delta DECIMAL(24,6) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_inventory_movement(document_id,warehouse_code,item_code,location_code,lot_no,quantity_delta), KEY ix_inventory_movement_item(item_code,warehouse_code,movement_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS sales_document_types (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,tenant_id VARCHAR(60) NOT NULL,company_id VARCHAR(60) NOT NULL,source_system VARCHAR(60) NOT NULL,document_kind ENUM('quotation','sales_order','shipment','sales_return') NOT NULL,type_code VARCHAR(20) NOT NULL,type_name VARCHAR(80) NOT NULL,number_prefix VARCHAR(20) NOT NULL,requires_approval TINYINT(1) NOT NULL DEFAULT 1,is_active TINYINT(1) NOT NULL DEFAULT 1,note VARCHAR(255) NULL,UNIQUE KEY uq_sales_document_type(tenant_id,company_id,source_system,document_kind,type_code)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS sales_documents (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,tenant_id VARCHAR(60) NOT NULL,company_id VARCHAR(60) NOT NULL,source_system VARCHAR(60) NOT NULL,source_database VARCHAR(60) NOT NULL,document_kind ENUM('quotation','sales_order','shipment','sales_return') NOT NULL,document_type VARCHAR(20) NOT NULL,document_no VARCHAR(60) NOT NULL,document_date DATE NOT NULL,customer_code VARCHAR(30) NOT NULL,currency_code VARCHAR(10) NOT NULL DEFAULT 'TWD',warehouse_code VARCHAR(30) NULL,salesperson_code VARCHAR(30) NULL,source_document_id BIGINT UNSIGNED NULL,return_type ENUM('return','allowance') NULL,status ENUM('draft','approved','partial','completed','posted','closed','voided') NOT NULL DEFAULT 'draft',inventory_status VARCHAR(20) NOT NULL DEFAULT 'not_applicable',note VARCHAR(500) NULL,created_by BIGINT UNSIGNED NULL,approved_by BIGINT UNSIGNED NULL,approved_at DATETIME NULL,posted_by BIGINT UNSIGNED NULL,posted_at DATETIME NULL,closed_by BIGINT UNSIGNED NULL,closed_at DATETIME NULL,close_note VARCHAR(255) NULL,reopened_by BIGINT UNSIGNED NULL,reopened_at DATETIME NULL,reopen_note VARCHAR(255) NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,UNIQUE KEY uq_sales_document(tenant_id,company_id,source_system,document_no),KEY ix_sales_document(source_database,document_kind,status,document_date)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS sales_document_items (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,document_id BIGINT UNSIGNED NOT NULL,line_no INT UNSIGNED NOT NULL DEFAULT 1,source_item_id BIGINT UNSIGNED NULL,item_code VARCHAR(40) NOT NULL,item_name VARCHAR(160) NULL,specification VARCHAR(160) NULL,unit VARCHAR(20) NOT NULL DEFAULT 'PCS',warehouse_code VARCHAR(30) NULL,quantity DECIMAL(24,3) NOT NULL,related_quantity DECIMAL(24,3) NOT NULL DEFAULT 0,unit_price DECIMAL(24,6) NOT NULL DEFAULT 0,unit_cost DECIMAL(24,6) NOT NULL DEFAULT 0,expected_date DATE NULL,allowance_amount DECIMAL(24,6) NOT NULL DEFAULT 0,price_source_kind VARCHAR(30) NULL,price_source_id BIGINT UNSIGNED NULL,price_source_no VARCHAR(80) NULL,price_source_date DATE NULL,price_rule_id BIGINT UNSIGNED NULL,price_tier_id BIGINT UNSIGNED NULL,note VARCHAR(255) NULL,UNIQUE KEY uq_sales_document_item(document_id,line_no),CONSTRAINT fk_sales_document_item FOREIGN KEY(document_id) REFERENCES sales_documents(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS sales_order_changes (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,tenant_id VARCHAR(60) NOT NULL,company_id VARCHAR(60) NOT NULL,source_system VARCHAR(60) NOT NULL,source_database VARCHAR(60) NOT NULL,change_no VARCHAR(60) NOT NULL,order_item_id BIGINT UNSIGNED NOT NULL,change_date DATE NOT NULL,new_quantity DECIMAL(24,3) NOT NULL,new_unit_price DECIMAL(24,6) NOT NULL,new_expected_date DATE NULL,reason VARCHAR(255) NOT NULL,status ENUM('draft','approved','voided') DEFAULT 'draft',approved_by BIGINT UNSIGNED NULL,approved_at DATETIME NULL,created_by BIGINT UNSIGNED NULL,UNIQUE KEY uq_sales_change(tenant_id,company_id,source_system,change_no)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS erp_master_source_mappings (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        source_database VARCHAR(60) NOT NULL,
        source_table VARCHAR(120) NOT NULL,
        source_field VARCHAR(120) NOT NULL,
        standard_entity VARCHAR(60) NOT NULL,
        standard_table VARCHAR(120) NOT NULL,
        standard_field VARCHAR(120) NOT NULL,
        mapping_type VARCHAR(30) NOT NULL DEFAULT 'master',
        transform_rule VARCHAR(255) NULL,
        is_key TINYINT(1) NOT NULL DEFAULT 0,
        mapping_status VARCHAR(30) NOT NULL DEFAULT 'active',
        evidence_status VARCHAR(30) NOT NULL DEFAULT 'needs-confirmation',
        note VARCHAR(255) NULL,
        sort_order INT NOT NULL DEFAULT 100,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_erp_master_source_mapping (source_database, source_table, source_field, standard_table, standard_field),
        KEY ix_erp_master_source_mapping_entity (source_database, standard_entity, mapping_status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`INSERT IGNORE INTO erp_master_source_mappings
        (source_database, source_table, source_field, standard_entity, standard_table, standard_field, mapping_type, is_key, mapping_status, evidence_status, note, sort_order)
        VALUES
        ('SH','cmsmc','MC001','warehouses','erp_warehouses','warehouse_code','master',1,'active','schema-confirmed','SH CMSI03 庫別代號',10),
        ('SH','cmsmc','MC002','warehouses','erp_warehouses','warehouse_name','master',0,'active','schema-confirmed','SH CMSI03 庫別名稱',20),
        ('SH','cmsmc','MC003','warehouses','erp_warehouses','site_code','master',0,'active','schema-confirmed','SH CMSI03 廠別',30),
        ('SH','cmsmc','MC004','warehouses','erp_warehouses','warehouse_type','master',0,'active','needs-confirmation','欄位用途依來源系統定義保留',40),
        ('SH','cmsmc','MC005','warehouses','erp_warehouses','allow_in','master',0,'active','needs-confirmation','欄位用途依來源系統定義保留',50),
        ('SH','cmsmc','MC006','warehouses','erp_warehouses','allow_out','master',0,'active','needs-confirmation','欄位用途依來源系統定義保留',60),
        ('SH','cmsme','ME001','departments','erp_departments','department_code','master',1,'active','schema-confirmed','SH CMSI05 部門代號',110),
        ('SH','cmsme','ME002','departments','erp_departments','department_name','master',0,'active','schema-confirmed','SH CMSI05 部門名稱',120),
        ('SH','cmsme','ME003','departments','erp_departments','note','master',0,'active','needs-confirmation','來源欄位語意待文件確認',130),
        ('SH','cmsme','ME004','departments','erp_departments','account_code','master',0,'active','schema-confirmed','SH CMSI05 會計／折舊相關代號',140),
        ('SH','cmsmv','MV001','employees','erp_employees','employee_code','master',1,'active','schema-confirmed','SH CMSI10 員工代號',210),
        ('SH','cmsmv','MV002','employees','erp_employees','employee_name','master',0,'active','schema-confirmed','SH CMSI10 員工姓名',220),
        ('SH','cmsmv','MV003','employees','erp_employees','company_code','master',0,'active','needs-confirmation','來源欄位語意待文件確認',230),
        ('SH','cmsmv','MV004','employees','erp_employees','department_code','master',0,'active','schema-confirmed','SH CMSI10 部門代號',240),
        ('SH','cmsmv','MV005','employees','erp_employees','job_title','master',0,'active','needs-confirmation','來源欄位語意待文件確認',250),
        ('SH','cmsmv','MV020','employees','erp_employees','email','master',0,'active','schema-confirmed','SH CMSI10 Email',260),
        ('SH','copma','MA001','customers','erp_customers','customer_code','master',1,'active','schema-confirmed','COP 客戶代號',310),
        ('SH','copma','MA002','customers','erp_customers','short_name','master',0,'active','needs-confirmation','來源欄位語意依 COP 文件確認',320),
        ('SH','copma','MA003','customers','erp_customers','customer_name','master',0,'active','schema-confirmed','COP 客戶名稱',330),
        ('SH','copma','MA005','customers','erp_customers','contact_name','master',0,'active','needs-confirmation','來源欄位語意依 COP 文件確認',340),
        ('SH','copma','MA006','customers','erp_customers','phone','master',0,'active','needs-confirmation','來源欄位語意依 COP 文件確認',350),
        ('SH','copma','MA009','customers','erp_customers','email','master',0,'active','needs-confirmation','來源欄位語意依 COP 文件確認',360),
        ('SH','copma','MA010','customers','erp_customers','tax_id','master',0,'active','needs-confirmation','來源欄位語意依 COP 文件確認',370),
        ('SH','purma','MA001','suppliers','erp_suppliers','supplier_code','master',1,'active','schema-confirmed','PUR 廠商代號',410),
        ('SH','purma','MA002','suppliers','erp_suppliers','short_name','master',0,'active','needs-confirmation','來源欄位語意依 PUR 文件確認',420),
        ('SH','purma','MA003','suppliers','erp_suppliers','supplier_name','master',0,'active','needs-confirmation','來源欄位語意依 PUR 文件確認',430),
        ('SH','purma','MA005','suppliers','erp_suppliers','tax_id','master',0,'needs-confirmation','needs-confirmation','來源欄位語意依 PUR 文件確認',440),
        ('SH','purma','MA008','suppliers','erp_suppliers','phone','master',0,'active','needs-confirmation','來源欄位語意依 PUR 文件確認',450),
        ('SH','purma','MA011','suppliers','erp_suppliers','email','master',0,'active','needs-confirmation','來源欄位語意依 PUR 文件確認',460),
         ('SH','purma','MA012','suppliers','erp_suppliers','contact_name','master',0,'active','needs-confirmation','來源欄位語意依 PUR 文件確認',470),
         ('SH','cmsml','ML001','companies','erp_companies','company_code','master',1,'active','schema-confirmed','公司代號',510),
         ('SH','cmsml','ML002','companies','erp_companies','short_name','master',0,'active','schema-confirmed','公司簡稱',520),
         ('SH','cmsml','ML003','companies','erp_companies','company_name','master',0,'active','schema-confirmed','公司名稱',530),
         ('SH','cmsml','ML004','companies','erp_companies','address','master',0,'active','needs-confirmation','公司地址欄位語意待文件確認',540),
         ('SH','cmsml','ML005','companies','erp_companies','phone','master',0,'active','needs-confirmation','公司電話欄位語意待文件確認',550),
         ('SH','cmsml','ML007','companies','erp_companies','tax_id','master',0,'active','needs-confirmation','稅籍欄位語意待文件確認',560),
         ('SH','cmsmh','MH001','code-rules','erp_code_rules','rule_type','master',1,'active','schema-confirmed','編碼規則類型',610),
         ('SH','cmsmh','MH002','code-rules','erp_code_rules','rule_value','master',0,'active','schema-confirmed','編碼規則內容',620),
         ('SH','cmsmh','MH003','code-rules','erp_code_rules','rule_code','master',1,'active','schema-confirmed','編碼規則代號',630),
         ('SH','cmsmh','MH004','code-rules','erp_code_rules','default_name','master',0,'active','needs-confirmation','預設名稱欄位語意待文件確認',640)`);
      await pool.query(`UPDATE erp_master_source_mappings SET mapping_status='superseded', evidence_status='PDF-defined',
        note='舊對照誤將 PURMA.MA012 當聯絡人；PURI01 文件確認 MA012 為負責人，聯絡人為 MA013'
        WHERE source_database='SH' AND source_table='purma' AND source_field='MA012' AND standard_table='erp_suppliers' AND standard_field='contact_name'`);
      await pool.query(`INSERT INTO erp_master_source_mappings
        (source_database, source_table, source_field, standard_entity, standard_table, standard_field, mapping_type, transform_rule, is_key, mapping_status, evidence_status, note, sort_order)
        VALUES
        ('SH','copma','MA002','customers','erp_customers','short_name','master',NULL,0,'active','sample-validated','COPI01 客戶簡稱；文件、欄位型態與 SH 樣本一致',320),
        ('SH','copma','MA004','customers','erp_customers','responsible_person','master',NULL,0,'active','sample-validated','COPI01 負責人',335),
        ('SH','copma','MA005','customers','erp_customers','contact_name','master',NULL,0,'active','sample-validated','COPI01 聯絡人；SH 2,316 筆中 1,819 筆有值',340),
        ('SH','copma','MA006','customers','erp_customers','phone','master',NULL,0,'active','sample-validated','COPI01 TEL NO(一)',350),
        ('SH','copma','MA008','customers','erp_customers','fax','master',NULL,0,'active','sample-validated','COPI01 FAX NO',355),
        ('SH','copma','MA009','customers','erp_customers','email','master',NULL,0,'active','sample-validated','COPI01 E-Mail',360),
        ('SH','copma','MA010','customers','erp_customers','tax_id','master',NULL,0,'active','sample-validated','COPI01 統一編號；台灣版非空白時應為 8 碼',370),
        ('SH','copma','MA014','customers','erp_customers','currency_code','master',NULL,0,'active','sample-validated','COPI01 交易幣別',375),
        ('SH','copma','MA083','customers','erp_customers','payment_term_code','master','與 CMSNF.NF001=2、NF002 對照',0,'active','sample-validated','COPI01 付款條件；SH 627 筆非空值全數對到銷售付款條件代號',380),
        ('SH','copma','MA037','customers','erp_customers','invoice_type','master',NULL,0,'active','sample-validated','COPI01 發票聯數',385),
        ('SH','copma','MA038','customers','erp_customers','tax_type','master',NULL,0,'active','sample-validated','COPI01 課稅別',390),
        ('SH','copma','MA043','customers','erp_customers','closing_day','master',NULL,0,'active','sample-validated','COPI01 結帳日期',395),
        ('SH','copma','MA138','customers','erp_customers','mobile','master',NULL,0,'active','schema-confirmed','COPI01 行動電話；來源欄位存在',400),
        ('SH','purma','MA002','suppliers','erp_suppliers','short_name','master',NULL,0,'active','sample-validated','PURI01 廠商簡稱',420),
        ('SH','purma','MA003','suppliers','erp_suppliers','supplier_name','master',NULL,0,'active','sample-validated','PURI01 公司全名',430),
        ('SH','purma','MA004','suppliers','erp_suppliers','supplier_class','master',NULL,0,'active','schema-confirmed','PURI01 廠商分類',435),
        ('SH','purma','MA005','suppliers','erp_suppliers','tax_id','master',NULL,0,'active','sample-validated','PURI01 統一編號；SH 866 筆中 557 筆有值',440),
        ('SH','purma','MA008','suppliers','erp_suppliers','phone','master',NULL,0,'active','sample-validated','PURI01 TEL',450),
        ('SH','purma','MA010','suppliers','erp_suppliers','fax','master',NULL,0,'active','sample-validated','PURI01 FAXNO',455),
        ('SH','purma','MA011','suppliers','erp_suppliers','email','master',NULL,0,'active','sample-validated','PURI01 E_MAIL',460),
        ('SH','purma','MA012','suppliers','erp_suppliers','responsible_person','master',NULL,0,'active','sample-validated','PURI01 負責人；不是聯絡人',465),
        ('SH','purma','MA013','suppliers','erp_suppliers','contact_name','master',NULL,0,'active','sample-validated','PURI01 聯絡人；SH 866 筆中 681 筆有值',470),
        ('SH','purma','MA021','suppliers','erp_suppliers','currency_code','master',NULL,0,'active','sample-validated','PURI01 交易幣別',475),
        ('SH','purma','MA024','suppliers','erp_suppliers','payment_method','master',NULL,0,'active','sample-validated','PURI01 付款方式：1現金、2電匯、3支票、4其他',480),
        ('SH','purma','MA025','suppliers','erp_suppliers','payment_term_source_value','master','保留來源原值；可依 CMSNF.NF003 嘗試正規化',0,'active','sample-validated','PURI01 付款條件；SH 為舊資料，159 筆有值但多數存放名稱或自訂文字',485),
        ('SH','purma','MA030','suppliers','erp_suppliers','invoice_type','master',NULL,0,'active','sample-validated','PURI01 發票聯數',490),
        ('SH','purma','MA044','suppliers','erp_suppliers','tax_type','master',NULL,0,'active','sample-validated','PURI01 課稅別',495),
        ('SH','purma','MA034','suppliers','erp_suppliers','closing_month_offset','master',NULL,0,'active','schema-confirmed','PURI01 結帳月數；SH 現有資料皆空白',500),
        ('SH','purma','MA035','suppliers','erp_suppliers','closing_day','master',NULL,0,'active','schema-confirmed','PURI01 結帳逢日；SH 現有資料皆空白',505),
        ('SH','purma','MA095','suppliers','erp_suppliers','mobile','master',NULL,0,'active','schema-confirmed','PURI01 行動電話',510)
        ON DUPLICATE KEY UPDATE transform_rule=VALUES(transform_rule), mapping_status=VALUES(mapping_status),
          evidence_status=VALUES(evidence_status), note=VALUES(note), sort_order=VALUES(sort_order)`);
      await pool.query(`INSERT IGNORE INTO erp_master_source_mappings
        (source_database, source_table, source_field, standard_entity, standard_table, standard_field, mapping_type, is_key, mapping_status, evidence_status, note, sort_order)
        VALUES ('SH','cmsma','MA*','common-parameters','erp_common_parameters','parameter_value','master',0,'active','needs-confirmation','cmsma 為寬表，先依實際非空 MA 欄位拆成參數列，待文件確認各欄位業務意義',710)`);
      await pool.query(`INSERT IGNORE INTO erp_master_source_mappings
        (source_database, source_table, source_field, standard_entity, standard_table, standard_field, mapping_type, is_key, mapping_status, evidence_status, note, sort_order)
        VALUES
        ('SH','invma','MA001','item-categories','erp_item_categories','category_type','master',1,'active','schema-confirmed','品號類別類型',810),
        ('SH','invma','MA002','item-categories','erp_item_categories','category_code','master',1,'active','schema-confirmed','品號類別代號',820),
        ('SH','invma','MA003','item-categories','erp_item_categories','category_name','master',0,'active','schema-confirmed','品號類別名稱',830),
        ('SH','invmb','MB001','items','erp_items','item_code','master',1,'active','schema-confirmed','品號代號',910),
        ('SH','invmb','MB002','items','erp_items','item_name','master',0,'active','schema-confirmed','品號名稱',920),
        ('SH','invmb','MB003','items','erp_items','specification','master',0,'active','schema-confirmed','規格',930),
        ('SH','invmb','MB004','items','erp_items','unit','master',0,'active','schema-confirmed','庫存單位',940),
        ('SH','invmb','MB005','items','erp_items','category_1','master',0,'needs-confirmation','needs-confirmation','第一分類欄位語意依文件確認',950),
        ('SH','invmb','MB006','items','erp_items','category_2','master',0,'needs-confirmation','needs-confirmation','第二分類欄位語意依文件確認',960),
        ('SH','invmb','MB007','items','erp_items','category_3','master',0,'needs-confirmation','needs-confirmation','第三分類欄位語意依文件確認',970)`);
      await pool.query(`INSERT IGNORE INTO erp_master_source_mappings
        (source_database, source_table, source_field, standard_entity, standard_table, standard_field, mapping_type, is_key, mapping_status, evidence_status, note, sort_order)
        VALUES
        ('SH','cmsmj','MJ001','job-categories','erp_job_categories','job_code','master',1,'active','schema-confirmed','CMSI09 職務代號',1010),
        ('SH','cmsmj','MJ002','job-categories','erp_job_categories','job_category','master',0,'active','schema-confirmed','CMSI09 職務分類',1020),
        ('SH','cmsmj','MJ003','job-categories','erp_job_categories','job_name','master',0,'active','schema-confirmed','CMSI09 職務名稱；SH 現有資料可能留白',1030),
        ('SH','cmsmj','MJ004','job-categories','erp_job_categories','note','master',0,'active','schema-confirmed','CMSI09 備註',1040),
        ('SH','cmsmk','MK002','job-category-employees','erp_job_category_employees','employee_code','detail',1,'active','schema-confirmed','CMSI09 職務所屬人員',1050),
        ('SH','cmsmf','MF001','currencies','erp_currencies','currency_code','master',1,'active','schema-confirmed','CMSI06 幣別',1110),
        ('SH','cmsmf','MF002','currencies','erp_currencies','currency_name','master',0,'active','schema-confirmed','CMSI06 幣別名稱',1120),
        ('SH','cmsmf','MF003','currencies','erp_currencies','unit_price_digits','master',0,'active','schema-confirmed','CMSI06 單價取位',1130),
        ('SH','cmsmf','MF004','currencies','erp_currencies','amount_digits','master',0,'active','schema-confirmed','CMSI06 金額取位',1140),
        ('SH','cmsmf','MF005','currencies','erp_currencies','unit_cost_digits','master',0,'active','schema-confirmed','CMSI06 單位成本取位',1150),
        ('SH','cmsmf','MF006','currencies','erp_currencies','cost_amount_digits','master',0,'active','schema-confirmed','CMSI06 成本金額取位',1160),
        ('SH','cmsmg','MG002','currency-rates','erp_currency_rates','effective_date','detail',1,'active','schema-confirmed','CMSI06 匯率生效日期',1170),
        ('SH','cmsnf','NF001','payment-terms','erp_payment_terms','term_type','master',1,'active','schema-confirmed','CMSI29 類別：採購／託工或銷售',1210),
        ('SH','cmsnf','NF002','payment-terms','erp_payment_terms','term_code','master',1,'active','schema-confirmed','CMSI29 付款條件代號',1220),
        ('SH','cmsnf','NF003','payment-terms','erp_payment_terms','term_name','master',0,'active','schema-confirmed','CMSI29 付款條件名稱',1230),
        ('SH','cmsmi','MI001','calendars','erp_calendars','industry_type','master',1,'active','schema-confirmed','CMSI08 行業別',1310),
        ('SH','cmsmi','MI002','calendars','erp_calendars','calendar_year','master',1,'active','schema-confirmed','CMSI08 年度',1320),
        ('SH','cmsmi','MI003','calendars','erp_calendars','shift_code','master',1,'active','schema-confirmed','CMSI08 班別',1330),
        ('SH','cmsmp','MP004','calendar-days','erp_calendar_days','work_date','detail',1,'active','schema-confirmed','CMSI08 行事曆日期',1340),
        ('SH','cmsmp','MP005','calendar-days','erp_calendar_days','day_type','detail',0,'active','needs-confirmation','日期屬性代碼保留，名稱待來源代碼表確認',1350)`);
      await pool.query(`INSERT IGNORE INTO erp_master_source_mappings
        (source_database, source_table, source_field, standard_entity, standard_table, standard_field, mapping_type, is_key, mapping_status, evidence_status, note, sort_order)
        VALUES
        ('SH','invmc','MC001','inventory-opening','erp_inventory_opening_lines','item_code','opening',1,'active','schema-confirmed','INVI02 品號庫別資料之品號',1410),
        ('SH','invmc','MC002','inventory-opening','erp_inventory_opening_lines','warehouse_code','opening',1,'active','schema-confirmed','INVI02 品號庫別資料之庫別',1420),
        ('SH','invmc','MC003','inventory-opening','erp_inventory_opening_lines','location_code','opening',1,'active','needs-confirmation','來源儲位欄位；SH 現有資料多為空白',1430),
        ('SH','invmc','MC007','inventory-opening','erp_inventory_opening_lines','quantity','opening',0,'active','schema-confirmed','iSM 庫存文件明定為庫存數量',1440),
        ('SH','invmc','MC008','inventory-opening','erp_inventory_opening_lines','amount','opening',0,'active','schema-confirmed','iSM 庫存文件明定為庫存金額',1450)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS erp_import_batches (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        batch_no VARCHAR(60) NOT NULL UNIQUE,
        tenant_id VARCHAR(60) NOT NULL,
        company_id VARCHAR(60) NOT NULL,
        source_system VARCHAR(60) NOT NULL,
        source_database VARCHAR(60) NOT NULL,
        status VARCHAR(30) NOT NULL DEFAULT 'pending',
        initiated_by BIGINT UNSIGNED NULL,
        started_at DATETIME NULL,
        completed_at DATETIME NULL,
        total_tables INT UNSIGNED NOT NULL DEFAULT 0,
        total_rows BIGINT UNSIGNED NOT NULL DEFAULT 0,
        imported_rows BIGINT UNSIGNED NOT NULL DEFAULT 0,
        skipped_rows BIGINT UNSIGNED NOT NULL DEFAULT 0,
        error_rows BIGINT UNSIGNED NOT NULL DEFAULT 0,
        notes VARCHAR(500) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY ix_erp_import_batches_context (tenant_id, company_id, source_system, source_database, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS erp_import_reconciliations (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        batch_id BIGINT UNSIGNED NOT NULL,
        source_table VARCHAR(120) NOT NULL,
        target_table VARCHAR(120) NOT NULL,
        source_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
        target_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
        imported_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
        skipped_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
        error_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
        status VARCHAR(30) NOT NULL DEFAULT 'pending',
        note VARCHAR(500) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_erp_import_reconciliation (batch_id, source_table, target_table),
        CONSTRAINT fk_erp_import_reconciliation_batch FOREIGN KEY (batch_id) REFERENCES erp_import_batches(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS erp_import_errors (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        batch_id BIGINT UNSIGNED NOT NULL,
        source_table VARCHAR(120) NOT NULL,
        source_key VARCHAR(255) NULL,
        error_code VARCHAR(60) NOT NULL,
        error_message VARCHAR(1000) NOT NULL,
        payload_json JSON NULL,
        status VARCHAR(30) NOT NULL DEFAULT 'open',
        resolved_by BIGINT UNSIGNED NULL,
        resolved_at DATETIME NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY ix_erp_import_errors_batch_status (batch_id, status),
        CONSTRAINT fk_erp_import_errors_batch FOREIGN KEY (batch_id) REFERENCES erp_import_batches(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS erp_import_logs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        batch_id BIGINT UNSIGNED NOT NULL,
        level VARCHAR(20) NOT NULL DEFAULT 'info',
        message VARCHAR(1000) NOT NULL,
        details_json JSON NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY ix_erp_import_logs_batch (batch_id, created_at),
        CONSTRAINT fk_erp_import_logs_batch FOREIGN KEY (batch_id) REFERENCES erp_import_batches(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS procurement_requisitions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        requisition_no VARCHAR(30) NOT NULL UNIQUE,
        requisition_date DATE NOT NULL,
        requester_code VARCHAR(20) NULL,
        department_code VARCHAR(10) NULL,
        warehouse_code VARCHAR(20) NULL,
        status ENUM('draft','approved','converted','closed','cancelled') NOT NULL DEFAULT 'draft',
        note VARCHAR(255) NULL,
        source_database VARCHAR(30) NOT NULL DEFAULT 'SH',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS procurement_requisition_items (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        requisition_id BIGINT UNSIGNED NOT NULL,
        line_no INT NOT NULL,
        item_code VARCHAR(50) NOT NULL,
        item_name VARCHAR(160) NULL,
        specification VARCHAR(255) NULL,
        warehouse_code VARCHAR(20) NULL,
        unit VARCHAR(20) NOT NULL DEFAULT 'PCS',
        qty_requested DECIMAL(18,4) NOT NULL,
        qty_ordered DECIMAL(18,4) NOT NULL DEFAULT 0,
        required_date DATE NULL,
        note VARCHAR(255) NULL,
        UNIQUE KEY uq_procurement_requisition_line (requisition_id, line_no),
        CONSTRAINT fk_procurement_requisition_item_header FOREIGN KEY (requisition_id) REFERENCES procurement_requisitions(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS procurement_orders (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        purchase_order_no VARCHAR(30) NOT NULL UNIQUE,
        supplier_code VARCHAR(20) NOT NULL,
        order_date DATE NOT NULL,
        expected_date DATE NULL,
        currency_code VARCHAR(10) NOT NULL DEFAULT 'TWD',
        status ENUM('draft','confirmed','partial_received','received','closed','cancelled') NOT NULL DEFAULT 'draft',
        note VARCHAR(255) NULL,
        source_database VARCHAR(30) NOT NULL DEFAULT 'SH',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS procurement_order_items (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        purchase_order_id BIGINT UNSIGNED NOT NULL,
        requisition_item_id BIGINT UNSIGNED NULL,
        line_no INT NOT NULL,
        item_code VARCHAR(50) NOT NULL,
        item_name VARCHAR(160) NULL,
        specification VARCHAR(255) NULL,
        warehouse_code VARCHAR(20) NULL,
        unit VARCHAR(20) NOT NULL DEFAULT 'PCS',
        qty_ordered DECIMAL(18,4) NOT NULL,
        qty_received DECIMAL(18,4) NOT NULL DEFAULT 0,
        unit_price DECIMAL(18,4) NOT NULL DEFAULT 0,
        expected_date DATE NULL,
        note VARCHAR(255) NULL,
        UNIQUE KEY uq_procurement_order_line (purchase_order_id, line_no),
        CONSTRAINT fk_procurement_order_item_header FOREIGN KEY (purchase_order_id) REFERENCES procurement_orders(id) ON DELETE CASCADE,
        CONSTRAINT fk_procurement_order_item_requisition FOREIGN KEY (requisition_item_id) REFERENCES procurement_requisition_items(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS procurement_receipts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        receipt_no VARCHAR(30) NOT NULL UNIQUE,
        supplier_code VARCHAR(20) NOT NULL,
        receipt_date DATE NOT NULL,
        warehouse_code VARCHAR(20) NULL,
        status ENUM('draft','posted','voided') NOT NULL DEFAULT 'draft',
        note VARCHAR(255) NULL,
        source_database VARCHAR(30) NOT NULL DEFAULT 'SH',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS procurement_receipt_items (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        receipt_id BIGINT UNSIGNED NOT NULL,
        purchase_order_item_id BIGINT UNSIGNED NULL,
        line_no INT NOT NULL,
        item_code VARCHAR(50) NOT NULL,
        item_name VARCHAR(160) NULL,
        specification VARCHAR(255) NULL,
        warehouse_code VARCHAR(20) NULL,
        unit VARCHAR(20) NOT NULL DEFAULT 'PCS',
        qty_received DECIMAL(18,4) NOT NULL,
        qty_accepted DECIMAL(18,4) NOT NULL,
        qty_priced DECIMAL(24,6) NOT NULL DEFAULT 0,
        qty_paid DECIMAL(24,6) NOT NULL DEFAULT 0,
        qty_returned_priced DECIMAL(24,6) NOT NULL DEFAULT 0,
        priced_at DATETIME NULL,
        priced_by BIGINT UNSIGNED NULL,
        unit_cost DECIMAL(18,4) NOT NULL DEFAULT 0,
        lot_no VARCHAR(80) NOT NULL DEFAULT '',
        note VARCHAR(255) NULL,
        UNIQUE KEY uq_procurement_receipt_line (receipt_id, line_no),
        CONSTRAINT fk_procurement_receipt_item_header FOREIGN KEY (receipt_id) REFERENCES procurement_receipts(id) ON DELETE CASCADE,
        CONSTRAINT fk_procurement_receipt_item_order FOREIGN KEY (purchase_order_item_id) REFERENCES procurement_order_items(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS procurement_document_types (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(60) NOT NULL DEFAULT 'SH', company_id VARCHAR(60) NOT NULL DEFAULT 'SH', source_system VARCHAR(60) NOT NULL DEFAULT 'iSM',
        document_kind ENUM('requisition','purchase_order','receipt','purchase_return') NOT NULL,
        type_code VARCHAR(20) NOT NULL, type_name VARCHAR(80) NOT NULL, number_prefix VARCHAR(12) NOT NULL,
        requires_approval TINYINT(1) NOT NULL DEFAULT 1, allow_overage TINYINT(1) NOT NULL DEFAULT 0,
        is_active TINYINT(1) NOT NULL DEFAULT 1, note VARCHAR(255) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_procurement_document_type (tenant_id, company_id, source_system, document_kind, type_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      // 不在共用初始化程序寫死 SH 單別。每家公司應由自己的 CMSMQ
      // 同步單據性質；只有該公司完全沒有對應性質時，API 才建立公司專屬預設值。
      await addColumnIfMissing('procurement_document_types', 'type_full_name', 'VARCHAR(120) NULL');
      await addColumnIfMissing('procurement_document_types', 'nature_code', 'VARCHAR(4) NULL');
      await addColumnIfMissing('procurement_document_types', 'numbering_method', "VARCHAR(12) NOT NULL DEFAULT 'daily'");
      await addColumnIfMissing('procurement_document_types', 'year_digits', 'TINYINT UNSIGNED NOT NULL DEFAULT 4');
      await addColumnIfMissing('procurement_document_types', 'serial_digits', 'TINYINT UNSIGNED NOT NULL DEFAULT 4');
      await addColumnIfMissing('procurement_document_types', 'item_input_method', "VARCHAR(12) NOT NULL DEFAULT 'item'");
      await addColumnIfMissing('procurement_document_types', 'auto_confirm', 'TINYINT(1) NOT NULL DEFAULT 0');
      await addColumnIfMissing('procurement_document_types', 'auto_confirm_on_edit', 'TINYINT(1) NOT NULL DEFAULT 0');
      await addColumnIfMissing('procurement_document_types', 'update_supplier_price', 'TINYINT(1) NOT NULL DEFAULT 0');
      await addColumnIfMissing('procurement_document_types', 'require_purchase_order', 'TINYINT(1) NOT NULL DEFAULT 0');
      await addColumnIfMissing('procurement_document_types', 'require_source_document', 'TINYINT(1) NOT NULL DEFAULT 0');
      await addColumnIfMissing('procurement_document_types', 'source_document_kind', 'VARCHAR(40) NULL');
      await addColumnIfMissing('procurement_document_types', 'direct_settlement', 'TINYINT(1) NOT NULL DEFAULT 0');
      await addColumnIfMissing('procurement_document_types', 'settlement_mode', "VARCHAR(12) NOT NULL DEFAULT 'batch'");
      await addColumnIfMissing('procurement_document_types', 'ap_document_type', 'VARCHAR(20) NULL');
      await addColumnIfMissing('procurement_document_types', 'is_default', 'TINYINT(1) NOT NULL DEFAULT 0');
      await addColumnIfMissing('procurement_document_types', 'source_database', 'VARCHAR(60) NULL');
      await addColumnIfMissing('procurement_document_types', 'source_table', 'VARCHAR(30) NULL');
      for (const table of ['procurement_requisitions','procurement_orders','procurement_receipts']) {
        await addColumnIfMissing(table, 'tenant_id', "VARCHAR(60) NOT NULL DEFAULT 'SH'");
        await addColumnIfMissing(table, 'company_id', "VARCHAR(60) NOT NULL DEFAULT 'SH'");
        await addColumnIfMissing(table, 'source_system', "VARCHAR(60) NOT NULL DEFAULT 'iSM'");
        await addColumnIfMissing(table, 'document_type', "VARCHAR(20) NULL");
      }
      await addColumnIfMissing('procurement_requisition_items', 'suggested_supplier_code', 'VARCHAR(20) NULL');
      await addColumnIfMissing('procurement_requisition_items', 'suggested_unit_price', 'DECIMAL(18,4) NOT NULL DEFAULT 0');
      await addColumnIfMissing('procurement_requisition_items', 'purchase_locked', 'TINYINT(1) NOT NULL DEFAULT 0');
      await addColumnIfMissing('procurement_order_items', 'qty_cancelled', 'DECIMAL(18,4) NOT NULL DEFAULT 0');
      await addColumnIfMissing('procurement_orders', 'closed_by', 'BIGINT UNSIGNED NULL');
      await addColumnIfMissing('procurement_orders', 'closed_at', 'DATETIME NULL');
      await addColumnIfMissing('procurement_orders', 'close_note', 'VARCHAR(255) NULL');
      await addColumnIfMissing('procurement_receipt_items', 'qty_rejected', 'DECIMAL(18,4) NOT NULL DEFAULT 0');
      await addColumnIfMissing('procurement_receipt_items', 'qty_returned', 'DECIMAL(18,4) NOT NULL DEFAULT 0');
      await addColumnIfMissing('procurement_receipt_items', 'inspection_status', "VARCHAR(30) NOT NULL DEFAULT 'pending'");
      await addColumnIfMissing('procurement_receipt_items', 'inspection_note', 'VARCHAR(255) NULL');
      await addColumnIfMissing('procurement_receipt_items', 'inspected_by', 'BIGINT UNSIGNED NULL');
      await addColumnIfMissing('procurement_receipt_items', 'inspected_at', 'DATETIME NULL');
      await addColumnIfMissing('procurement_receipts', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
      await addColumnIfMissing('procurement_receipts', 'inventory_status', "VARCHAR(20) NOT NULL DEFAULT 'pending'");
      await addColumnIfMissing('procurement_receipts', 'inventory_posted_by', 'BIGINT UNSIGNED NULL');
      await addColumnIfMissing('procurement_receipts', 'inventory_posted_at', 'DATETIME NULL');
      await addColumnIfMissing('procurement_receipts', 'arrival_date', 'DATE NULL');
      await addColumnIfMissing('procurement_receipts', 'delivery_note_no', 'VARCHAR(60) NULL');
      await addColumnIfMissing('procurement_receipts', 'invoice_no', 'VARCHAR(60) NULL');
      await addColumnIfMissing('procurement_receipts', 'received_by', 'VARCHAR(30) NULL');
      await pool.query("ALTER TABLE procurement_receipts MODIFY COLUMN status ENUM('draft','pending_inspection','accepted','partially_accepted','rejected','posted','voided') NOT NULL DEFAULT 'draft'");
      await pool.query(`CREATE TABLE IF NOT EXISTS procurement_order_changes (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(60) NOT NULL DEFAULT 'SH', company_id VARCHAR(60) NOT NULL DEFAULT 'SH', source_system VARCHAR(60) NOT NULL DEFAULT 'iSM',
        change_no VARCHAR(30) NOT NULL UNIQUE, purchase_order_id BIGINT UNSIGNED NOT NULL, change_date DATE NOT NULL,
        reason VARCHAR(255) NOT NULL, status ENUM('draft','approved','rejected','cancelled') NOT NULL DEFAULT 'draft',
        source_database VARCHAR(30) NOT NULL DEFAULT 'SH', created_by BIGINT UNSIGNED NULL, approved_by BIGINT UNSIGNED NULL,
        approved_at DATETIME NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_procurement_change_order FOREIGN KEY (purchase_order_id) REFERENCES procurement_orders(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS procurement_order_change_items (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, order_change_id BIGINT UNSIGNED NOT NULL,
        purchase_order_item_id BIGINT UNSIGNED NOT NULL, new_quantity DECIMAL(18,4) NOT NULL,
        new_unit_price DECIMAL(18,4) NOT NULL, new_expected_date DATE NULL, note VARCHAR(255) NULL,
        CONSTRAINT fk_procurement_change_item_header FOREIGN KEY (order_change_id) REFERENCES procurement_order_changes(id) ON DELETE CASCADE,
        CONSTRAINT fk_procurement_change_item_order FOREIGN KEY (purchase_order_item_id) REFERENCES procurement_order_items(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS procurement_returns (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(60) NOT NULL DEFAULT 'SH', company_id VARCHAR(60) NOT NULL DEFAULT 'SH', source_system VARCHAR(60) NOT NULL DEFAULT 'iSM',
        document_type VARCHAR(20) NULL, return_no VARCHAR(30) NOT NULL UNIQUE, supplier_code VARCHAR(20) NOT NULL,
        return_date DATE NOT NULL, return_type ENUM('return','allowance') NOT NULL,
        status ENUM('draft','approved','posted','voided') NOT NULL DEFAULT 'draft', inventory_status ENUM('not_applicable','pending','posted') NOT NULL DEFAULT 'pending',
        note VARCHAR(255) NULL, source_database VARCHAR(30) NOT NULL DEFAULT 'SH', created_by BIGINT UNSIGNED NULL,
        approved_by BIGINT UNSIGNED NULL, approved_at DATETIME NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS procurement_return_items (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, return_id BIGINT UNSIGNED NOT NULL,
        receipt_item_id BIGINT UNSIGNED NULL, line_no INT NOT NULL, item_code VARCHAR(50) NOT NULL,
        item_name VARCHAR(160) NULL, warehouse_code VARCHAR(20) NULL, unit VARCHAR(20) NOT NULL DEFAULT 'PCS',
        return_quantity DECIMAL(18,4) NOT NULL DEFAULT 0, allowance_amount DECIMAL(18,4) NOT NULL DEFAULT 0,
        priced_quantity DECIMAL(24,6) NOT NULL DEFAULT 0,
        unit_cost DECIMAL(18,4) NOT NULL DEFAULT 0, reason VARCHAR(255) NULL,
        UNIQUE KEY uq_procurement_return_line (return_id, line_no),
        CONSTRAINT fk_procurement_return_item_header FOREIGN KEY (return_id) REFERENCES procurement_returns(id) ON DELETE CASCADE,
        CONSTRAINT fk_procurement_return_item_receipt FOREIGN KEY (receipt_item_id) REFERENCES procurement_receipt_items(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

      // Permission data belongs to the new application, never to the legacy
      // SH schema.  This mirrors iSM's user/group/program permission model.
      await pool.query(`CREATE TABLE IF NOT EXISTS finance_open_items (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,tenant_id VARCHAR(60) NOT NULL,company_id VARCHAR(60) NOT NULL,source_system VARCHAR(60) NOT NULL,source_database VARCHAR(60) NOT NULL,account_type ENUM('AR','AP') NOT NULL,document_no VARCHAR(60) NOT NULL,document_date DATE NOT NULL,due_date DATE NULL,party_code VARCHAR(30) NOT NULL,currency_code VARCHAR(10) NOT NULL DEFAULT 'TWD',source_kind VARCHAR(30) NOT NULL,source_document_id BIGINT UNSIGNED NULL,source_document_no VARCHAR(60) NULL,original_amount DECIMAL(24,6) NOT NULL,settled_amount DECIMAL(24,6) NOT NULL DEFAULT 0,balance_amount DECIMAL(24,6) NOT NULL,status ENUM('draft','approved','open','partial','settled','voided') NOT NULL DEFAULT 'draft',note VARCHAR(500) NULL,created_by BIGINT UNSIGNED NULL,approved_by BIGINT UNSIGNED NULL,approved_at DATETIME NULL,posted_by BIGINT UNSIGNED NULL,posted_at DATETIME NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,UNIQUE KEY uq_finance_open_item(tenant_id,company_id,source_system,account_type,document_no),UNIQUE KEY uq_finance_source(tenant_id,company_id,source_system,account_type,source_kind,source_document_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS finance_settlements (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,tenant_id VARCHAR(60) NOT NULL,company_id VARCHAR(60) NOT NULL,source_system VARCHAR(60) NOT NULL,source_database VARCHAR(60) NOT NULL,account_type ENUM('AR','AP') NOT NULL,settlement_no VARCHAR(60) NOT NULL,settlement_date DATE NOT NULL,party_code VARCHAR(30) NOT NULL,payment_method VARCHAR(30) NULL,bank_code VARCHAR(30) NULL,reference_no VARCHAR(80) NULL,amount DECIMAL(24,6) NOT NULL,status ENUM('draft','approved','posted','voided') NOT NULL DEFAULT 'draft',note VARCHAR(500) NULL,created_by BIGINT UNSIGNED NULL,approved_by BIGINT UNSIGNED NULL,approved_at DATETIME NULL,posted_by BIGINT UNSIGNED NULL,posted_at DATETIME NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,UNIQUE KEY uq_finance_settlement(tenant_id,company_id,source_system,account_type,settlement_no)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS finance_allocations (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,settlement_id BIGINT UNSIGNED NOT NULL,open_item_id BIGINT UNSIGNED NOT NULL,allocated_amount DECIMAL(24,6) NOT NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,UNIQUE KEY uq_finance_allocation(settlement_id,open_item_id),CONSTRAINT fk_finance_allocation_settlement FOREIGN KEY(settlement_id) REFERENCES finance_settlements(id) ON DELETE CASCADE,CONSTRAINT fk_finance_allocation_open_item FOREIGN KEY(open_item_id) REFERENCES finance_open_items(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS finance_notes (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
        account_type ENUM('AR','AP') NOT NULL, note_no VARCHAR(60) NOT NULL, note_type VARCHAR(20) NOT NULL,
        issue_date DATE NOT NULL, due_date DATE NOT NULL, party_code VARCHAR(30) NOT NULL,
        bank_code VARCHAR(30) NULL, bank_account VARCHAR(60) NULL, amount DECIMAL(24,6) NOT NULL,
        settlement_id BIGINT UNSIGNED NULL, status ENUM('draft','received','issued','deposited','cashed','honored','dishonored','voided') NOT NULL DEFAULT 'draft',
        memo VARCHAR(500) NULL, created_by BIGINT UNSIGNED NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_finance_note(tenant_id,company_id,source_system,account_type,note_no),
        KEY ix_finance_note(source_database,account_type,due_date,status),
        CONSTRAINT fk_finance_note_settlement FOREIGN KEY(settlement_id) REFERENCES finance_settlements(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS finance_bank_accounts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
        source_database VARCHAR(60) NOT NULL, bank_code VARCHAR(30) NOT NULL, bank_name VARCHAR(120) NOT NULL,
        account_no VARCHAR(80) NOT NULL, currency_code VARCHAR(10) NOT NULL DEFAULT 'TWD',
        opening_balance DECIMAL(24,6) NOT NULL DEFAULT 0, current_balance DECIMAL(24,6) NOT NULL DEFAULT 0,
        is_active TINYINT(1) NOT NULL DEFAULT 1, note VARCHAR(500) NULL,
        created_by BIGINT UNSIGNED NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_finance_bank_account(tenant_id,company_id,source_system,source_database,bank_code,account_no),
        KEY ix_finance_bank_account(source_database,is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS finance_bank_transactions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
        source_database VARCHAR(60) NOT NULL, bank_account_id BIGINT UNSIGNED NOT NULL,
        transaction_no VARCHAR(60) NOT NULL, transaction_date DATE NOT NULL,
        transaction_type VARCHAR(30) NOT NULL, direction ENUM('in','out') NOT NULL,
        amount DECIMAL(24,6) NOT NULL, reference_type VARCHAR(40) NULL, reference_id BIGINT UNSIGNED NULL,
        reference_no VARCHAR(80) NULL, counterparty VARCHAR(80) NULL, memo VARCHAR(500) NULL,
        status ENUM('draft','posted','voided') NOT NULL DEFAULT 'draft',
        reconciled TINYINT(1) NOT NULL DEFAULT 0, reconciled_at DATETIME NULL,
        created_by BIGINT UNSIGNED NULL, posted_by BIGINT UNSIGNED NULL, posted_at DATETIME NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_finance_bank_transaction(tenant_id,company_id,source_system,source_database,transaction_no),
        KEY ix_finance_bank_transaction(bank_account_id,transaction_date,status,reconciled),
        CONSTRAINT fk_finance_bank_transaction_account FOREIGN KEY(bank_account_id) REFERENCES finance_bank_accounts(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS finance_bank_reconciliations (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
        source_database VARCHAR(60) NOT NULL, bank_account_id BIGINT UNSIGNED NOT NULL,
        reconciliation_date DATE NOT NULL, statement_balance DECIMAL(24,6) NOT NULL,
        book_balance DECIMAL(24,6) NOT NULL, difference_amount DECIMAL(24,6) NOT NULL,
        status ENUM('draft','completed','difference') NOT NULL DEFAULT 'draft', note VARCHAR(500) NULL,
        created_by BIGINT UNSIGNED NULL, completed_by BIGINT UNSIGNED NULL, completed_at DATETIME NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY ix_finance_bank_reconciliation(bank_account_id,reconciliation_date,status),
        CONSTRAINT fk_finance_bank_reconciliation_account FOREIGN KEY(bank_account_id) REFERENCES finance_bank_accounts(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS finance_opening_balances (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
        source_database VARCHAR(60) NOT NULL, account_type ENUM('AR','AP') NOT NULL,
        opening_no VARCHAR(60) NOT NULL, opening_date DATE NOT NULL, due_date DATE NULL,
        party_code VARCHAR(30) NOT NULL, source_document_no VARCHAR(80) NULL,
        currency_code VARCHAR(10) NOT NULL DEFAULT 'TWD', original_amount DECIMAL(24,6) NOT NULL,
        status ENUM('draft','approved','posted','voided') NOT NULL DEFAULT 'draft', note VARCHAR(500) NULL,
        created_by BIGINT UNSIGNED NULL, approved_by BIGINT UNSIGNED NULL, approved_at DATETIME NULL,
        posted_by BIGINT UNSIGNED NULL, posted_at DATETIME NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_finance_opening_balance(tenant_id,company_id,source_system,source_database,account_type,opening_no),
        KEY ix_finance_opening_balance(source_database,account_type,opening_date,status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS accounting_year_closings (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
        source_database VARCHAR(60) NOT NULL, fiscal_year CHAR(4) NOT NULL, closing_no VARCHAR(60) NOT NULL,
        close_date DATE NOT NULL, retained_earnings_account_code VARCHAR(30) NOT NULL DEFAULT '3201',
        retained_earnings_account_name VARCHAR(120) NOT NULL DEFAULT '保留盈餘',
        net_income DECIMAL(24,6) NOT NULL DEFAULT 0, journal_id BIGINT UNSIGNED NULL,
        status ENUM('draft','posted','voided') NOT NULL DEFAULT 'draft', note VARCHAR(500) NULL,
        created_by BIGINT UNSIGNED NULL, posted_by BIGINT UNSIGNED NULL, posted_at DATETIME NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_accounting_year_closing(tenant_id,company_id,source_system,source_database,fiscal_year),
        KEY ix_accounting_year_closing(source_database,fiscal_year,status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      const [noteColumns] = await pool.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema=DATABASE() AND table_name='finance_notes'`);
      const noteColumnSet = new Set(noteColumns.map(x => String(x.column_name || x.COLUMN_NAME || '').toLowerCase()));
      for (const [column, definition] of [
        ['bank_account_id','BIGINT UNSIGNED NULL'],['status_date','DATE NULL'],
        ['status_by','BIGINT UNSIGNED NULL'],['status_note','VARCHAR(500) NULL']
      ]) {
        if (!noteColumnSet.has(column.toLowerCase())) await pool.query(`ALTER TABLE finance_notes ADD COLUMN \`${column}\` ${definition}`);
      }
      const [noteIndexes] = await pool.query(`SELECT constraint_name FROM information_schema.table_constraints
        WHERE table_schema=DATABASE() AND table_name='finance_notes' AND constraint_type='FOREIGN KEY'`);
      if (!noteIndexes.some(x => String(x.constraint_name || x.CONSTRAINT_NAME || '').toLowerCase() === 'fk_finance_note_bank_account')) {
        await pool.query(`ALTER TABLE finance_notes ADD CONSTRAINT fk_finance_note_bank_account
          FOREIGN KEY(bank_account_id) REFERENCES finance_bank_accounts(id) ON DELETE SET NULL`);
      }
      await pool.query(`CREATE TABLE IF NOT EXISTS accounting_accounts (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
        account_code VARCHAR(30) NOT NULL, account_name VARCHAR(120) NOT NULL,
        account_type ENUM('asset','liability','equity','revenue','expense') NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_accounting_account(tenant_id,company_id,source_system,account_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS accounting_journals (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
        journal_no VARCHAR(60) NOT NULL, journal_date DATE NOT NULL, source_kind VARCHAR(30) NOT NULL,
        source_id BIGINT UNSIGNED NOT NULL, source_document_no VARCHAR(60) NULL,
        status ENUM('draft','posted','voided') NOT NULL DEFAULT 'draft', memo VARCHAR(500) NULL,
        created_by BIGINT UNSIGNED NULL, posted_by BIGINT UNSIGNED NULL, posted_at DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_accounting_journal_no(tenant_id,company_id,source_system,journal_no),
        UNIQUE KEY uq_accounting_journal_source(tenant_id,company_id,source_system,source_kind,source_id),
        KEY ix_accounting_journal(source_database,journal_date,status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS accounting_journal_lines (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, journal_id BIGINT UNSIGNED NOT NULL, line_no INT UNSIGNED NOT NULL,
        account_code VARCHAR(30) NOT NULL, account_name VARCHAR(120) NOT NULL,
        debit_amount DECIMAL(24,6) NOT NULL DEFAULT 0, credit_amount DECIMAL(24,6) NOT NULL DEFAULT 0,
        party_code VARCHAR(30) NULL, description VARCHAR(255) NULL,
        UNIQUE KEY uq_accounting_journal_line(journal_id,line_no),
        CONSTRAINT fk_accounting_journal_line FOREIGN KEY(journal_id) REFERENCES accounting_journals(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS access_roles (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        role_code VARCHAR(30) NOT NULL UNIQUE,
        role_name VARCHAR(80) NOT NULL,
        description VARCHAR(255) NULL,
        is_system TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS access_role_permissions (
        role_id BIGINT UNSIGNED NOT NULL,
        feature_code VARCHAR(80) NOT NULL,
        can_view TINYINT(1) NOT NULL DEFAULT 0,
        can_create TINYINT(1) NOT NULL DEFAULT 0,
        can_update TINYINT(1) NOT NULL DEFAULT 0,
        can_delete TINYINT(1) NOT NULL DEFAULT 0,
        can_approve TINYINT(1) NOT NULL DEFAULT 0,
        PRIMARY KEY (role_id, feature_code),
        CONSTRAINT fk_access_role_permission_role FOREIGN KEY (role_id) REFERENCES access_roles(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

      const defaultRoles = [
        ['ADMIN', '系統管理員', '可管理角色、權限與所有功能', 1],
        ['REQUESTER', '請購人員', '建立與查詢請購單', 1],
        ['PURCHASER', '採購人員', '處理請購轉採購及採購單', 1],
        ['WAREHOUSE', '倉管人員', '處理進貨、驗收與庫存查詢', 1],
        ['FINANCE', '財務人員', '查詢採購與後續應付付款資料', 1],
        ['VIEWER', '查詢人員', '僅能查詢已授權功能', 1]
      ];
      for (const role of defaultRoles) {
        await pool.query('INSERT IGNORE INTO access_roles (role_code, role_name, description, is_system) VALUES (?, ?, ?, ?)', role);
      }
      const accessFeatures = ['sales-document-types','sales-quotations','sales-orders','sales-order-changes','sales-shipments','sales-returns','sales-progress','sales-open-orders','accounting-general-ledger','accounting-financial-preview','accounting-drafts','accounting-periods','accounting-auto-rules','accounting-clearing','accounting-opening-balances','accounting-year-close','bank-ledger','finance-bookkeeping','finance-cash','finance-reconcile','operations-health','operations-reports','sales-flow-audit','purchase-flow-audit','flow-audit-recommendations','architecture-flow','access-control','import-monitor','data-quality', 'basicdata', 'warehouses', 'departments', 'employees', 'source-customers', 'source-suppliers', 'inventory-opening', 'inventory-document-types', 'inventory-transactions', 'inventory-transfers', 'inventory-temporary', 'inventory-stocktake', 'inventory-posting', 'inventory-reversals', 'inventory-new-ledger', 'inventory-new-balance', 'procurement-document-types', 'requisition-entry', 'requisition-maintenance', 'purchase-order-entry', 'purchase-order-changes', 'receipt-arrival', 'receipt-entry', 'receipt-inspection', 'receipt-rejected-return', 'receipt-posting', 'purchase-returns', 'purchase-progress', 'open-purchase-orders', 'purchase-receipts'];
      accessFeatures.push('sales-pipe','sales-customer-items','sales-customer-pricing','sales-forecast','sales-statistics','sales-analysis','sales-maintenance','sales-readonly','item-categories','items');
      await pool.query("DELETE FROM access_role_permissions WHERE feature_code IN ('inventory-detail','inventory-ledger','inventory-balance','inventory-movement-stats','department-movement-stats')");
      const [[admin]] = await pool.query("SELECT id FROM access_roles WHERE role_code='ADMIN'");
      for (const feature of accessFeatures) {
        await pool.query(`INSERT IGNORE INTO access_role_permissions
          (role_id, feature_code, can_view, can_create, can_update, can_delete, can_approve)
          VALUES (?, ?, 1, 1, 1, 1, 1)`, [admin.id, feature]);
      }
      const initialRoleFeatures = {
        REQUESTER: ['basicdata', 'requisition-entry', 'architecture-flow'],
        PURCHASER: ['basicdata', 'procurement-document-types', 'requisition-entry', 'requisition-maintenance', 'purchase-order-entry', 'purchase-order-changes', 'receipt-arrival', 'receipt-posting', 'purchase-returns', 'receipt-rejected-return', 'purchase-progress', 'open-purchase-orders', 'purchase-receipts', 'purchase-flow-audit', 'flow-audit-recommendations', 'operations-reports', 'architecture-flow'],
        WAREHOUSE: ['inventory-opening', 'inventory-document-types', 'inventory-transactions', 'inventory-transfers', 'inventory-temporary', 'inventory-stocktake', 'inventory-posting', 'inventory-reversals', 'inventory-new-ledger', 'inventory-new-balance', 'inventory-detail', 'inventory-ledger', 'inventory-balance', 'receipt-arrival', 'receipt-entry', 'receipt-inspection', 'receipt-rejected-return', 'receipt-posting', 'purchase-returns', 'purchase-progress', 'open-purchase-orders', 'purchase-receipts', 'operations-reports'],
        FINANCE: ['basicdata', 'purchase-receipts', 'accounting-drafts', 'accounting-periods', 'accounting-auto-rules', 'accounting-general-ledger', 'accounting-financial-preview', 'accounting-clearing', 'accounting-opening-balances', 'accounting-year-close', 'bank-ledger', 'finance-bookkeeping', 'finance-cash', 'finance-reconcile', 'operations-health', 'operations-reports', 'sales-flow-audit', 'sales-statistics', 'sales-analysis', 'sales-readonly', 'purchase-flow-audit', 'flow-audit-recommendations', 'architecture-flow'],
        VIEWER: ['basicdata', 'inventory-detail', 'inventory-ledger', 'inventory-balance', 'purchase-receipts', 'operations-health', 'operations-reports', 'sales-flow-audit', 'sales-statistics', 'sales-analysis', 'sales-readonly', 'purchase-flow-audit', 'flow-audit-recommendations', 'architecture-flow']
      };
      for (const [roleCode, features] of Object.entries(initialRoleFeatures)) {
        const [[role]] = await pool.query('SELECT id FROM access_roles WHERE role_code=?', [roleCode]);
        for (const feature of features) {
          await pool.query(`INSERT IGNORE INTO access_role_permissions
            (role_id, feature_code, can_view, can_create, can_update, can_delete, can_approve)
            VALUES (?, ?, 1, ?, ?, 0, ?)`, [role.id, feature, Number(feature.includes('entry')), Number(feature.includes('entry')), Number(feature === 'purchase-order-entry')]);
        }
      }
      // 新增的稽核建議權限要同步補到既有角色；不改變既有角色的其他權限。
      for (const roleCode of ['PURCHASER', 'FINANCE', 'VIEWER']) {
        const [[role]] = await pool.query('SELECT id FROM access_roles WHERE role_code=?', [roleCode]);
        if (role) await pool.query(`INSERT INTO access_role_permissions
          (role_id,feature_code,can_view,can_create,can_update,can_delete,can_approve)
          VALUES(?,'flow-audit-recommendations',1,1,1,0,?)
          ON DUPLICATE KEY UPDATE can_view=1,can_create=1,can_update=1,can_approve=VALUES(can_approve)`,
          [role.id, roleCode === 'FINANCE' ? 1 : 0]);
      }
      // 銷售統計是唯讀報表；既有財務／查詢角色也要能看到正式 COPR20，
      // 但不授予任何建立、修改、刪除或核准權限。
      for (const roleCode of ['FINANCE', 'VIEWER']) {
        const [[role]] = await pool.query('SELECT id FROM access_roles WHERE role_code=?', [roleCode]);
        if (role) await pool.query(`INSERT INTO access_role_permissions
          (role_id,feature_code,can_view,can_create,can_update,can_delete,can_approve)
          VALUES(?,'sales-statistics',1,0,0,0,0)
          ON DUPLICATE KEY UPDATE can_view=1`, [role.id]);
      }
      // 銷售分析是唯讀跨模組報表；既有財務／查詢角色也要能看到，
      // 但不授予建立、修改、刪除或核准權限。
      for (const roleCode of ['FINANCE', 'VIEWER']) {
        const [[role]] = await pool.query('SELECT id FROM access_roles WHERE role_code=?', [roleCode]);
        if (role) await pool.query(`INSERT INTO access_role_permissions
          (role_id,feature_code,can_view,can_create,can_update,can_delete,can_approve)
          VALUES(?,'sales-analysis',1,0,0,0,0)
          ON DUPLICATE KEY UPDATE can_view=1`, [role.id]);
      }
      const elevatedRoleFeatures = {
        PURCHASER: ['procurement-document-types', 'requisition-maintenance', 'purchase-order-changes', 'purchase-returns', 'receipt-rejected-return'],
        WAREHOUSE: ['receipt-arrival', 'receipt-entry', 'receipt-inspection', 'receipt-rejected-return', 'receipt-posting', 'purchase-returns', 'inventory-transactions', 'inventory-transfers', 'inventory-temporary', 'inventory-stocktake', 'inventory-posting', 'inventory-reversals']
      };
      for (const [roleCode, features] of Object.entries(elevatedRoleFeatures)) {
        const [[role]] = await pool.query('SELECT id FROM access_roles WHERE role_code=?', [roleCode]);
        for (const feature of features) {
          await pool.query(`INSERT INTO access_role_permissions
            (role_id, feature_code, can_view, can_create, can_update, can_delete, can_approve)
            VALUES (?, ?, 1, 1, 1, 0, 1)
            ON DUPLICATE KEY UPDATE can_view=1, can_create=1, can_update=1, can_approve=1`, [role.id, feature]);
        }
      }
      const [[warehouseRole]] = await pool.query("SELECT id FROM access_roles WHERE role_code='WAREHOUSE'");
      await pool.query(`INSERT INTO access_role_permissions(role_id,feature_code,can_view,can_create,can_update,can_delete,can_approve) VALUES(?,'finance-workflow',1,1,1,1,1) ON DUPLICATE KEY UPDATE can_view=1,can_create=1,can_update=1,can_approve=1`,[admin.id]);
      const [[financeRole]] = await pool.query("SELECT id FROM access_roles WHERE role_code='FINANCE'");
      await pool.query(`INSERT INTO access_role_permissions(role_id,feature_code,can_view,can_create,can_update,can_delete,can_approve) VALUES(?,'finance-workflow',1,1,1,0,1) ON DUPLICATE KEY UPDATE can_view=1,can_create=1,can_update=1,can_approve=1`,[financeRole.id]);
      await pool.query(`INSERT INTO access_role_permissions(role_id,feature_code,can_view,can_create,can_update,can_delete,can_approve)
        VALUES(?,'accounting-drafts',1,1,1,0,1)
        ON DUPLICATE KEY UPDATE can_view=1,can_create=1,can_update=1,can_approve=1`,[financeRole.id]);
      for (const [feature, canCreate, canUpdate, canApprove] of [
        ['finance-bookkeeping', 0, 0, 0],
        ['finance-cash', 1, 1, 1],
        ['finance-reconcile', 1, 0, 1]
      ]) {
        await pool.query(`INSERT INTO access_role_permissions
          (role_id,feature_code,can_view,can_create,can_update,can_delete,can_approve)
          VALUES(?,?,1,?,?,0,?)
          ON DUPLICATE KEY UPDATE can_view=1,can_create=VALUES(can_create),can_update=VALUES(can_update),can_approve=VALUES(can_approve)`,
          [financeRole.id, feature, canCreate, canUpdate, canApprove]);
      }
      await pool.query(`INSERT INTO access_role_permissions
        (role_id, feature_code, can_view, can_create, can_update, can_delete, can_approve)
        VALUES (?, 'inventory-opening', 1, 1, 1, 0, 0)
        ON DUPLICATE KEY UPDATE can_view=1, can_create=1, can_update=1`, [warehouseRole.id]);

      await pool.query(`CREATE TABLE IF NOT EXISTS access_users (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(60) NOT NULL UNIQUE,
        employee_code VARCHAR(20) NULL,
        display_name VARCHAR(80) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role_id BIGINT UNSIGNED NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        force_password_change TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT fk_access_user_role FOREIGN KEY (role_id) REFERENCES access_roles(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS access_user_companies (
        user_id BIGINT UNSIGNED NOT NULL,
        source_key VARCHAR(60) NOT NULL,
        department_scope_mode VARCHAR(12) NOT NULL DEFAULT 'all',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(user_id,source_key),
        CONSTRAINT fk_access_user_company_user FOREIGN KEY(user_id) REFERENCES access_users(id) ON DELETE CASCADE,
        CONSTRAINT fk_access_user_company_source FOREIGN KEY(source_key) REFERENCES erp_data_sources(source_key) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      // 公司可用範圍與部門可用範圍分開保存：all 代表該公司全部部門，
      // selected 則必須在 access_user_departments 找到明確授權的部門。
      await addColumnIfMissing('access_user_companies', 'department_scope_mode', "VARCHAR(12) NOT NULL DEFAULT 'all'");
      await pool.query(`UPDATE access_user_companies
        SET department_scope_mode='all'
        WHERE department_scope_mode IS NULL OR department_scope_mode NOT IN ('all','selected')`);
      await pool.query(`CREATE TABLE IF NOT EXISTS access_user_departments (
        user_id BIGINT UNSIGNED NOT NULL,
        source_key VARCHAR(60) NOT NULL,
        department_code VARCHAR(30) NOT NULL,
        created_by BIGINT UNSIGNED NULL,
        updated_by BIGINT UNSIGNED NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY(user_id,source_key,department_code),
        KEY ix_access_user_department_scope(source_key,department_code),
        CONSTRAINT fk_access_user_department_user FOREIGN KEY(user_id) REFERENCES access_users(id) ON DELETE CASCADE,
        CONSTRAINT fk_access_user_department_source FOREIGN KEY(source_key) REFERENCES erp_data_sources(source_key) ON DELETE CASCADE,
        CONSTRAINT fk_access_user_department_created_by FOREIGN KEY(created_by) REFERENCES access_users(id) ON DELETE SET NULL,
        CONSTRAINT fk_access_user_department_updated_by FOREIGN KEY(updated_by) REFERENCES access_users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS access_sessions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        token_hash CHAR(64) NOT NULL UNIQUE,
        expires_at DATETIME NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_access_session_user FOREIGN KEY (user_id) REFERENCES access_users(id) ON DELETE CASCADE,
        KEY ix_access_session_expiry (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      // 每個登入工作階段固定一個目前公司上下文；不要讓畫面傳入的來源欄位
      // 在沒有重新授權的情況下切換到另一家公司。
      await addColumnIfMissing('access_sessions', 'current_source_key', 'VARCHAR(60) NULL');
      await addColumnIfMissing('access_sessions', 'context_changed_at', 'DATETIME NULL');
      await pool.query(`CREATE TABLE IF NOT EXISTS access_audit_log (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        actor_user_id BIGINT UNSIGNED NULL,
        target_user_id BIGINT UNSIGNED NULL,
        action_code VARCHAR(60) NOT NULL,
        entity_type VARCHAR(60) NOT NULL,
        entity_id VARCHAR(100) NULL,
        source_key VARCHAR(60) NULL,
        department_code VARCHAR(30) NULL,
        before_json JSON NULL,
        after_json JSON NULL,
        reason VARCHAR(500) NULL,
        ip_address VARCHAR(64) NULL,
        user_agent VARCHAR(255) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY ix_access_audit_actor(actor_user_id,created_at),
        KEY ix_access_audit_target(target_user_id,created_at),
        KEY ix_access_audit_scope(source_key,department_code,created_at),
        KEY ix_access_audit_action(action_code,created_at),
        CONSTRAINT fk_access_audit_actor FOREIGN KEY(actor_user_id) REFERENCES access_users(id) ON DELETE SET NULL,
        CONSTRAINT fk_access_audit_target FOREIGN KEY(target_user_id) REFERENCES access_users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS access_password_reset_requests (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        status ENUM('pending','completed','cancelled') NOT NULL DEFAULT 'pending',
        requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME NULL,
        completed_by BIGINT UNSIGNED NULL,
        KEY ix_access_reset_request (user_id, status, requested_at),
        CONSTRAINT fk_access_reset_user FOREIGN KEY (user_id) REFERENCES access_users(id) ON DELETE CASCADE,
        CONSTRAINT fk_access_reset_admin FOREIGN KEY (completed_by) REFERENCES access_users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS procurement_document_approvals (
        document_kind VARCHAR(20) NOT NULL,
        document_id BIGINT UNSIGNED NOT NULL,
        approval_status ENUM('approved','rejected','cancelled') NOT NULL,
        approved_by BIGINT UNSIGNED NOT NULL,
        approved_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        note VARCHAR(255) NULL,
        PRIMARY KEY (document_kind, document_id),
        CONSTRAINT fk_procurement_approval_user FOREIGN KEY (approved_by) REFERENCES access_users(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      const seedSalt = 'inventory-erp-initial-admin';
      const seedHash = crypto.scryptSync('ChangeMe!2026', seedSalt, 64).toString('hex');
      await pool.query(`INSERT IGNORE INTO access_users
        (username, employee_code, display_name, password_hash, role_id, is_active, force_password_change)
        VALUES ('admin', 'ADMIN', '系統管理員', ?, ?, 1, 1)`, [`scrypt$${seedSalt}$${seedHash}`, admin.id]);
      await reloadSourceDatabases();
    })();
  }
  return procurementSchemaPromise;
}

// Historical import quality findings are control records.  They are kept in
// the application/control database instead of the legacy source database so
// that an audit or a correction decision can never mutate SH/SC data.
let importQualitySchemaPromise;
export function ensureImportQualitySchema() {
  if (!importQualitySchemaPromise) {
    importQualitySchemaPromise = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS erp_import_quality_issues (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        batch_id BIGINT UNSIGNED NULL,
        tenant_id VARCHAR(60) NOT NULL,
        company_id VARCHAR(60) NOT NULL,
        source_system VARCHAR(60) NOT NULL,
        source_database VARCHAR(60) NOT NULL,
        issue_code VARCHAR(80) NOT NULL,
        severity ENUM('info','warning','error') NOT NULL DEFAULT 'warning',
        status ENUM('open','acknowledged','correction_pending','resolved','ignored') NOT NULL DEFAULT 'open',
        source_table VARCHAR(120) NOT NULL,
        source_key VARCHAR(255) NOT NULL,
        target_table VARCHAR(120) NULL,
        target_id BIGINT UNSIGNED NULL,
        document_kind VARCHAR(60) NULL,
        document_type VARCHAR(30) NULL,
        document_no VARCHAR(120) NULL,
        line_no INT UNSIGNED NULL,
        item_code VARCHAR(60) NULL,
        expected_json JSON NULL,
        actual_json JSON NULL,
        rule_description VARCHAR(1000) NOT NULL,
        recommended_action VARCHAR(1000) NULL,
        resolution_type VARCHAR(40) NULL,
        resolution_note VARCHAR(1000) NULL,
        correction_no VARCHAR(60) NULL,
        decided_by BIGINT UNSIGNED NULL,
        decided_at DATETIME NULL,
        resolved_by BIGINT UNSIGNED NULL,
        resolved_at DATETIME NULL,
        last_seen_at DATETIME NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_erp_import_quality_issue (source_database, issue_code, source_key),
        KEY ix_erp_import_quality_context (tenant_id, company_id, source_system, source_database, status, severity),
        KEY ix_erp_import_quality_document (source_database, document_no, document_kind),
        KEY ix_erp_import_quality_batch (batch_id),
        CONSTRAINT fk_erp_import_quality_batch FOREIGN KEY (batch_id) REFERENCES erp_import_batches(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS erp_import_quality_events (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        issue_id BIGINT UNSIGNED NOT NULL,
        action_code VARCHAR(40) NOT NULL,
        from_status VARCHAR(30) NULL,
        to_status VARCHAR(30) NOT NULL,
        note VARCHAR(1000) NULL,
        actor_id BIGINT UNSIGNED NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY ix_erp_import_quality_event_issue (issue_id, created_at),
        CONSTRAINT fk_erp_import_quality_event_issue FOREIGN KEY (issue_id) REFERENCES erp_import_quality_issues(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    })();
  }
  return importQualitySchemaPromise;
}

export async function ensureTargetProcurementTypeSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS procurement_document_types (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL,company_id VARCHAR(60) NOT NULL,source_system VARCHAR(60) NOT NULL,
    document_kind ENUM('requisition','purchase_order','receipt','purchase_return') NOT NULL,
    type_code VARCHAR(20) NOT NULL,type_name VARCHAR(80) NOT NULL,number_prefix VARCHAR(12) NOT NULL,
    requires_approval TINYINT(1) NOT NULL DEFAULT 1,allow_overage DECIMAL(8,2) NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,note VARCHAR(255) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_procurement_document_type(tenant_id,company_id,source_system,document_kind,type_code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  const columns = [
    ['type_full_name','VARCHAR(120) NULL'],['nature_code','VARCHAR(4) NULL'],['numbering_method',"VARCHAR(12) NOT NULL DEFAULT 'daily'"],
    ['year_digits','TINYINT UNSIGNED NOT NULL DEFAULT 4'],['serial_digits','TINYINT UNSIGNED NOT NULL DEFAULT 4'],
    ['item_input_method',"VARCHAR(12) NOT NULL DEFAULT 'item'"],['auto_confirm','TINYINT(1) NOT NULL DEFAULT 0'],
    ['auto_confirm_on_edit','TINYINT(1) NOT NULL DEFAULT 0'],['update_supplier_price','TINYINT(1) NOT NULL DEFAULT 0'],
    ['require_purchase_order','TINYINT(1) NOT NULL DEFAULT 0'],['settlement_mode',"VARCHAR(12) NOT NULL DEFAULT 'batch'"],
    ['require_source_document','TINYINT(1) NOT NULL DEFAULT 0'],['source_document_kind','VARCHAR(40) NULL'],
    ['direct_settlement','TINYINT(1) NOT NULL DEFAULT 0'],
    ['ap_document_type','VARCHAR(20) NULL'],['is_default','TINYINT(1) NOT NULL DEFAULT 0'],
    ['source_database','VARCHAR(60) NULL'],['source_table','VARCHAR(30) NULL']
  ];
  for (const [column, definition] of columns) await addColumnIfMissing('procurement_document_types', column, definition);
}

export async function ensureTargetReceiptWorkflowSchema() {
  const orderColumns = [
    ['closed_by','BIGINT UNSIGNED NULL'],['closed_at','DATETIME NULL'],['close_note','VARCHAR(255) NULL']
  ];
  const receiptColumns = [
    ['updated_at','TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'],
    ['inventory_status',"VARCHAR(20) NOT NULL DEFAULT 'pending'"],
    ['inventory_posted_by','BIGINT UNSIGNED NULL'],['inventory_posted_at','DATETIME NULL'],
    ['arrival_date','DATE NULL'],['delivery_note_no','VARCHAR(60) NULL'],
    ['invoice_no','VARCHAR(60) NULL'],['received_by','VARCHAR(30) NULL']
  ];
  const itemColumns = [
    ['qty_rejected','DECIMAL(18,4) NOT NULL DEFAULT 0'],['qty_returned','DECIMAL(18,4) NOT NULL DEFAULT 0'],
    ['qty_priced','DECIMAL(24,6) NOT NULL DEFAULT 0'],['qty_paid','DECIMAL(24,6) NOT NULL DEFAULT 0'],
    ['qty_returned_priced','DECIMAL(24,6) NOT NULL DEFAULT 0'],['priced_at','DATETIME NULL'],
    ['priced_by','BIGINT UNSIGNED NULL'],
    ['freight_amount','DECIMAL(24,6) NOT NULL DEFAULT 0'],['insurance_amount','DECIMAL(24,6) NOT NULL DEFAULT 0'],
    ['other_expense_amount','DECIMAL(24,6) NOT NULL DEFAULT 0'],
    ['inspection_status',"VARCHAR(30) NOT NULL DEFAULT 'pending'"],['inspection_note','VARCHAR(255) NULL'],
    ['inspected_by','BIGINT UNSIGNED NULL'],['inspected_at','DATETIME NULL'],
    ['qty_rejected_returned','DECIMAL(18,4) NOT NULL DEFAULT 0']
  ];
  for (const [column, definition] of orderColumns) await addColumnIfMissing('procurement_orders', column, definition);
  for (const [column, definition] of receiptColumns) await addColumnIfMissing('procurement_receipts', column, definition);
  let pricedColumnAdded = false;
  for (const [column, definition] of itemColumns) {
    const added = await addColumnIfMissing('procurement_receipt_items', column, definition);
    if (column === 'qty_priced') pricedColumnAdded = added;
  }
  const returnedPricedAdded = await addColumnIfMissing('procurement_return_items', 'priced_quantity', 'DECIMAL(24,6) NOT NULL DEFAULT 0');
  // 舊匯入資料原本以驗收合格量直接作為應付來源。新增獨立計價量後，
  // 既有已驗收資料先保留原 ERP 的可追溯結果；新建立的進貨則從 0 開始，
  // 必須經「計價」作業後才可轉入應付。這裡只在欄位第一次加入時回填，
  // 不會覆蓋日後人工維護的計價／付款數量。
  if (pricedColumnAdded) {
    await pool.query(`UPDATE procurement_receipt_items
      SET qty_returned_priced=LEAST(GREATEST(COALESCE(qty_returned,0),0),GREATEST(COALESCE(qty_accepted,0),0)),
          qty_priced=GREATEST(COALESCE(qty_accepted,0),0),
          priced_at=COALESCE(inspected_at,NOW())
      WHERE qty_priced=0 AND COALESCE(qty_accepted,0)>0 AND inspection_status IN ('accepted','partially_accepted')`);
  }
  if (returnedPricedAdded) {
    await pool.query(`UPDATE procurement_return_items ri
      JOIN procurement_returns r ON r.id=ri.return_id
      JOIN procurement_receipt_items i ON i.id=ri.receipt_item_id
      SET ri.priced_quantity=CASE WHEN r.return_type='return' THEN LEAST(COALESCE(ri.return_quantity,0),GREATEST(COALESCE(i.qty_priced,0)-COALESCE(i.qty_returned_priced,0),0)) ELSE 0 END
      WHERE ri.priced_quantity=0 AND r.status IN ('approved','posted')`);
  }
  // 暫入／暫出歸還必須指回原暫入／暫出單，才能核對尚未歸還量；不與客戶原始資料庫共用。
  await addColumnIfMissing('inventory_documents', 'related_document_id', 'BIGINT UNSIGNED NULL');
  await addColumnIfMissing('inventory_documents', 'related_document_no', 'VARCHAR(60) NULL');
  await pool.query(`CREATE TABLE IF NOT EXISTS procurement_rejected_returns (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL DEFAULT 'SH', company_id VARCHAR(60) NOT NULL DEFAULT 'SH', source_system VARCHAR(60) NOT NULL DEFAULT 'iSM',
    source_database VARCHAR(30) NOT NULL DEFAULT 'SH', receipt_id BIGINT UNSIGNED NOT NULL, receipt_item_id BIGINT UNSIGNED NOT NULL,
    returned_date DATE NOT NULL, returned_quantity DECIMAL(18,4) NOT NULL,
    returned_by VARCHAR(30) NOT NULL, note VARCHAR(255) NULL, created_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_rejected_return_item(source_database,receipt_item_id,returned_date),
    CONSTRAINT fk_rejected_return_receipt FOREIGN KEY (receipt_id) REFERENCES procurement_receipts(id) ON DELETE CASCADE,
    CONSTRAINT fk_rejected_return_item FOREIGN KEY (receipt_item_id) REFERENCES procurement_receipt_items(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS procurement_receipt_pricing_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL DEFAULT 'SH', company_id VARCHAR(60) NOT NULL DEFAULT 'SH',
    source_system VARCHAR(60) NOT NULL DEFAULT 'iSM', source_database VARCHAR(30) NOT NULL DEFAULT 'SH',
    receipt_id BIGINT UNSIGNED NOT NULL, receipt_item_id BIGINT UNSIGNED NOT NULL,
    event_kind VARCHAR(30) NOT NULL, before_qty_priced DECIMAL(24,6) NOT NULL DEFAULT 0,
    after_qty_priced DECIMAL(24,6) NOT NULL DEFAULT 0, before_unit_cost DECIMAL(24,6) NOT NULL DEFAULT 0,
    after_unit_cost DECIMAL(24,6) NOT NULL DEFAULT 0, before_freight_amount DECIMAL(24,6) NOT NULL DEFAULT 0,
    after_freight_amount DECIMAL(24,6) NOT NULL DEFAULT 0, before_insurance_amount DECIMAL(24,6) NOT NULL DEFAULT 0,
    after_insurance_amount DECIMAL(24,6) NOT NULL DEFAULT 0, before_other_expense_amount DECIMAL(24,6) NOT NULL DEFAULT 0,
    after_other_expense_amount DECIMAL(24,6) NOT NULL DEFAULT 0, reason VARCHAR(500) NOT NULL,
    created_by BIGINT UNSIGNED NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_receipt_pricing_event_scope(source_database,receipt_id,receipt_item_id,created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query("ALTER TABLE procurement_receipts MODIFY COLUMN status ENUM('draft','pending_inspection','accepted','partially_accepted','rejected','posted','voided') NOT NULL DEFAULT 'draft'");
}

// A posted document is immutable.  Corrections are represented by a separate
// reversal header/detail pair and an inverse inventory ledger entry.  The
// original document and its original ledger rows are deliberately preserved.
export async function ensureTargetReversalSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS erp_reversal_documents (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL,
    company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL,
    source_database VARCHAR(60) NOT NULL,
    reversal_no VARCHAR(60) NOT NULL,
    source_kind VARCHAR(40) NOT NULL,
    source_document_id BIGINT UNSIGNED NOT NULL,
    source_document_no VARCHAR(60) NOT NULL,
    source_document_type VARCHAR(30) NULL,
    source_date DATE NOT NULL,
    reversal_date DATE NOT NULL,
    reason VARCHAR(500) NOT NULL,
    replacement_note VARCHAR(500) NULL,
    status ENUM('draft','approved','posted','voided') NOT NULL DEFAULT 'draft',
    created_by BIGINT UNSIGNED NULL,
    approved_by BIGINT UNSIGNED NULL,
    approved_at DATETIME NULL,
    posted_by BIGINT UNSIGNED NULL,
    posted_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_erp_reversal_no (tenant_id,company_id,source_system,reversal_no),
    UNIQUE KEY uq_erp_reversal_source (tenant_id,company_id,source_system,source_kind,source_document_id),
    KEY ix_erp_reversal_status (tenant_id,company_id,source_system,status,reversal_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS erp_reversal_items (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    reversal_id BIGINT UNSIGNED NOT NULL,
    source_ledger_id BIGINT UNSIGNED NOT NULL,
    item_code VARCHAR(40) NOT NULL,
    warehouse_code VARCHAR(30) NOT NULL,
    location_code VARCHAR(30) NOT NULL DEFAULT '',
    lot_no VARCHAR(80) NOT NULL DEFAULT '',
    quantity_delta DECIMAL(24,3) NOT NULL DEFAULT 0,
    unit_cost DECIMAL(24,6) NOT NULL DEFAULT 0,
    amount_delta DECIMAL(24,6) NOT NULL DEFAULT 0,
    note VARCHAR(255) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_erp_reversal_item_source (reversal_id,source_ledger_id),
    CONSTRAINT fk_erp_reversal_item_header FOREIGN KEY (reversal_id) REFERENCES erp_reversal_documents(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await addColumnIfMissing('erp_reversal_documents', 'replacement_kind', 'VARCHAR(40) NULL');
  await addColumnIfMissing('erp_reversal_documents', 'replacement_document_id', 'BIGINT UNSIGNED NULL');
  await addColumnIfMissing('erp_reversal_documents', 'replacement_document_no', 'VARCHAR(60) NULL');
}

// Sales reversal/reopen audit fields live in inventory_erp only.  They keep
// the original customer ERP documents untouched while recording the
// controlled order unlock/reopen operation in the target ERP.
export async function ensureTargetSalesWorkflowSchema() {
  for (const [column, definition] of [
    ['credit_limit', 'DECIMAL(24,6) NOT NULL DEFAULT 0'],
    ['credit_policy', "VARCHAR(20) NOT NULL DEFAULT 'warning'"],
    ['is_active', 'TINYINT(1) NOT NULL DEFAULT 1'],
    ['approved_by', 'BIGINT UNSIGNED NULL'],
    ['approved_at', 'DATETIME NULL']
  ]) await addColumnIfMissing('erp_customers', column, definition);
  await pool.query(`CREATE TABLE IF NOT EXISTS sales_customer_requests (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
    source_database VARCHAR(60) NOT NULL, request_no VARCHAR(60) NOT NULL,
    request_kind ENUM('new','change') NOT NULL, customer_code VARCHAR(30) NOT NULL,
    before_json JSON NULL, requested_json JSON NOT NULL,
    status ENUM('draft','pending','approved','rejected','voided') NOT NULL DEFAULT 'draft',
    reason VARCHAR(500) NOT NULL, review_note VARCHAR(500) NULL,
    created_by BIGINT UNSIGNED NULL, submitted_by BIGINT UNSIGNED NULL, submitted_at DATETIME NULL,
    reviewed_by BIGINT UNSIGNED NULL, reviewed_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_sales_customer_request(tenant_id,company_id,source_system,request_no),
    KEY ix_sales_customer_request(source_database,status,customer_code,created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sales_customer_request_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, request_id BIGINT UNSIGNED NOT NULL,
    event_kind VARCHAR(30) NOT NULL, before_status VARCHAR(20) NULL, after_status VARCHAR(20) NULL,
    reason VARCHAR(500) NULL, user_id BIGINT UNSIGNED NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_sales_customer_request_event(request_id,created_at),
    CONSTRAINT fk_sales_customer_request_event FOREIGN KEY(request_id) REFERENCES sales_customer_requests(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sales_credit_approval_requests (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
    source_database VARCHAR(60) NOT NULL, customer_code VARCHAR(30) NOT NULL,
    document_id BIGINT UNSIGNED NOT NULL, document_no VARCHAR(60) NOT NULL, document_kind VARCHAR(30) NOT NULL,
    credit_limit DECIMAL(24,6) NOT NULL DEFAULT 0, exposure_amount DECIMAL(24,6) NOT NULL DEFAULT 0,
    excess_amount DECIMAL(24,6) NOT NULL DEFAULT 0, status ENUM('pending','approved','rejected','used') NOT NULL DEFAULT 'pending',
    reason VARCHAR(500) NULL, requested_by BIGINT UNSIGNED NULL, requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_by BIGINT UNSIGNED NULL, reviewed_at DATETIME NULL, review_note VARCHAR(500) NULL,
    UNIQUE KEY uq_sales_credit_document(tenant_id,company_id,source_system,document_id),
    KEY ix_sales_credit_approval(source_database,status,customer_code,requested_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  const typeColumns = [
    ['type_full_name', 'VARCHAR(120) NULL'], ['nature_code', 'VARCHAR(4) NULL'],
    ['numbering_method', "VARCHAR(12) NOT NULL DEFAULT 'daily'"], ['year_digits', 'TINYINT UNSIGNED NOT NULL DEFAULT 4'],
    ['serial_digits', 'TINYINT UNSIGNED NOT NULL DEFAULT 4'], ['item_input_method', "VARCHAR(12) NOT NULL DEFAULT 'item'"],
    ['auto_confirm', 'TINYINT(1) NOT NULL DEFAULT 0'], ['auto_confirm_on_edit', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['update_customer_price', 'TINYINT(1) NOT NULL DEFAULT 0'], ['require_sales_order', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['settlement_mode', "VARCHAR(20) NOT NULL DEFAULT 'batch'"], ['ar_document_type', 'VARCHAR(20) NULL'],
    ['require_source_document', 'TINYINT(1) NOT NULL DEFAULT 0'], ['source_document_kind', 'VARCHAR(40) NULL'],
    ['direct_settlement', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['is_default', 'TINYINT(1) NOT NULL DEFAULT 0'], ['source_database', 'VARCHAR(60) NULL'], ['source_table', 'VARCHAR(60) NULL']
  ];
  for (const [column, definition] of typeColumns) await addColumnIfMissing('sales_document_types', column, definition);
  const columns = [
    ['closed_by', 'BIGINT UNSIGNED NULL'],
    ['closed_at', 'DATETIME NULL'],
    ['close_note', 'VARCHAR(255) NULL'],
    ['reopened_by', 'BIGINT UNSIGNED NULL'],
    ['reopened_at', 'DATETIME NULL'],
    ['reopen_note', 'VARCHAR(255) NULL']
  ];
  for (const [column, definition] of columns) await addColumnIfMissing('sales_documents', column, definition);
  for (const [column, definition] of [
    ['price_source_kind', 'VARCHAR(30) NULL'],
    ['price_source_id', 'BIGINT UNSIGNED NULL'],
    ['price_source_no', 'VARCHAR(80) NULL'],
    ['price_source_date', 'DATE NULL'],
    ['price_rule_id', 'BIGINT UNSIGNED NULL'],
    ['price_tier_id', 'BIGINT UNSIGNED NULL'],
    ['forecast_item_id', 'BIGINT UNSIGNED NULL'],
    ['forecast_no', 'VARCHAR(60) NULL']
  ]) await addColumnIfMissing('sales_document_items', column, definition);
  for (const [column, definition] of [
    ['version_no', 'INT UNSIGNED NULL'],
    ['old_quantity', 'DECIMAL(24,3) NULL'],
    ['old_unit_price', 'DECIMAL(24,6) NULL'],
    ['old_expected_date', 'DATE NULL'],
    ['applied_at', 'DATETIME NULL']
  ]) await addColumnIfMissing('sales_order_changes', column, definition);
  await pool.query(`CREATE TABLE IF NOT EXISTS sales_order_versions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
    source_database VARCHAR(60) NOT NULL, order_id BIGINT UNSIGNED NOT NULL, order_item_id BIGINT UNSIGNED NULL,
    version_no INT UNSIGNED NOT NULL, change_kind VARCHAR(40) NOT NULL,
    source_kind VARCHAR(40) NULL, source_document_id BIGINT UNSIGNED NULL, source_document_no VARCHAR(60) NULL,
    before_status VARCHAR(20) NULL, after_status VARCHAR(20) NULL,
    before_quantity DECIMAL(24,3) NULL, after_quantity DECIMAL(24,3) NULL,
    before_delivered_quantity DECIMAL(24,3) NULL, after_delivered_quantity DECIMAL(24,3) NULL,
    before_unit_price DECIMAL(24,6) NULL, after_unit_price DECIMAL(24,6) NULL,
    reason VARCHAR(500) NOT NULL, changed_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_sales_order_version(tenant_id,company_id,source_system,order_id,version_no),
    KEY ix_sales_order_version_lookup(source_database,order_id,order_item_id,created_at),
    KEY ix_sales_order_version_source(source_database,source_kind,source_document_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

// COPI04／COPI13／COPR06 銷售預測。預測是目標 ERP 的可核准業務資料，
// 不把空的或歷史 COPME／COPMF 寫回來源庫；每個預測標頭、明細與訂單
// 受訂量都帶完整公司／來源上下文，避免 SH／SC 混用。
export async function ensureTargetSalesForecastSchema() {
  await ensureTargetSalesWorkflowSchema();
  await ensureTargetSalesCustomerItemSchema();
  // Category-based forecasts use all four iSM classification levels.  Older
  // target databases may have been created before category_4 was introduced,
  // so upgrade the active target database idempotently for SH and SC alike.
  await addColumnIfMissing('erp_items', 'category_4', 'VARCHAR(30) NULL');
  await pool.query(`CREATE TABLE IF NOT EXISTS erp_sales_forecasts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL,
    company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL,
    source_database VARCHAR(60) NOT NULL,
    forecast_no VARCHAR(60) NOT NULL,
    forecast_version VARCHAR(40) NULL,
    forecast_basis ENUM('item','category') NOT NULL,
    period_from DATE NOT NULL,
    period_to DATE NOT NULL,
    customer_code VARCHAR(30) NULL,
    department_code VARCHAR(30) NULL,
    salesperson_code VARCHAR(30) NULL,
    channel_code VARCHAR(30) NULL,
    customer_type VARCHAR(30) NULL,
    include_production_plan TINYINT(1) NOT NULL DEFAULT 0,
    customer_description VARCHAR(500) NULL,
    status ENUM('draft','approved','closed','voided') NOT NULL DEFAULT 'draft',
    close_mode ENUM('open','auto','manual') NOT NULL DEFAULT 'open',
    source_kind VARCHAR(30) NOT NULL DEFAULT 'manual',
    source_table VARCHAR(60) NOT NULL DEFAULT 'manual',
    source_key VARCHAR(160) NULL,
    note VARCHAR(500) NULL,
    created_by BIGINT UNSIGNED NULL,
    updated_by BIGINT UNSIGNED NULL,
    approved_by BIGINT UNSIGNED NULL,
    approved_at DATETIME NULL,
    closed_by BIGINT UNSIGNED NULL,
    closed_at DATETIME NULL,
    voided_by BIGINT UNSIGNED NULL,
    voided_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_erp_sales_forecast_no (tenant_id,company_id,source_system,forecast_no),
    KEY ix_erp_sales_forecast_filter (tenant_id,company_id,source_system,source_database,forecast_basis,status,period_from,period_to),
    KEY ix_erp_sales_forecast_customer (tenant_id,company_id,source_database,customer_code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS erp_sales_forecast_items (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    forecast_id BIGINT UNSIGNED NOT NULL,
    line_no INT UNSIGNED NOT NULL,
    item_code VARCHAR(40) NULL,
    item_name VARCHAR(160) NULL,
    specification VARCHAR(160) NULL,
    category_1 VARCHAR(30) NULL,
    category_2 VARCHAR(30) NULL,
    category_3 VARCHAR(30) NULL,
    category_4 VARCHAR(30) NULL,
    forecast_date DATE NOT NULL,
    warehouse_code VARCHAR(30) NULL,
    forecast_quantity DECIMAL(24,3) NOT NULL DEFAULT 0,
    ordered_quantity DECIMAL(24,3) NOT NULL DEFAULT 0,
    unit VARCHAR(20) NOT NULL,
    currency_code VARCHAR(10) NOT NULL,
    unit_price DECIMAL(24,6) NOT NULL DEFAULT 0,
    forecast_amount DECIMAL(24,6) NOT NULL DEFAULT 0,
    ordered_amount DECIMAL(24,6) NOT NULL DEFAULT 0,
    close_mode ENUM('open','auto','manual') NOT NULL DEFAULT 'open',
    status ENUM('open','closed') NOT NULL DEFAULT 'open',
    source_table VARCHAR(60) NOT NULL DEFAULT 'manual',
    source_key VARCHAR(160) NULL,
    note VARCHAR(500) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_erp_sales_forecast_line (forecast_id,line_no),
    KEY ix_erp_sales_forecast_line_item (forecast_id,item_code,forecast_date),
    KEY ix_erp_sales_forecast_line_category (forecast_id,category_1,category_2,category_3,category_4),
    CONSTRAINT fk_erp_sales_forecast_line_header FOREIGN KEY (forecast_id) REFERENCES erp_sales_forecasts(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS erp_sales_forecast_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    forecast_id BIGINT UNSIGNED NOT NULL,
    tenant_id VARCHAR(60) NOT NULL,
    company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL,
    source_database VARCHAR(60) NOT NULL,
    event_kind VARCHAR(40) NOT NULL,
    before_json JSON NULL,
    after_json JSON NULL,
    reason VARCHAR(500) NOT NULL,
    changed_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_erp_sales_forecast_event (tenant_id,company_id,source_system,source_database,forecast_id,created_at),
    CONSTRAINT fk_erp_sales_forecast_event_header FOREIGN KEY (forecast_id) REFERENCES erp_sales_forecasts(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

// S02～S07 銷售第二階段共用結構。這些表只存在目前登入公司的目標 ERP，
// 用來保存合約訂單、交期排程、訂單後續控制、揀貨／採購需求及流程事件；
// SH／SC 原始 COP 資料仍維持唯讀，不以測試資料改寫來源狀態。
export async function ensureTargetSalesPhase2Schema() {
  await ensureTargetSalesWorkflowSchema();
  await addColumnIfMissing('sales_documents', 'contract_id', 'BIGINT UNSIGNED NULL');
  await addColumnIfMissing('sales_document_items', 'contract_item_id', 'BIGINT UNSIGNED NULL');

  await pool.query(`CREATE TABLE IF NOT EXISTS erp_sales_contracts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    contract_no VARCHAR(60) NOT NULL, contract_type VARCHAR(30) NOT NULL DEFAULT 'sales_contract',
    customer_code VARCHAR(30) NOT NULL, contract_date DATE NOT NULL,
    period_from DATE NULL, period_to DATE NULL, currency_code VARCHAR(10) NOT NULL DEFAULT 'TWD',
    status ENUM('draft','approved','partial','completed','closed','voided') NOT NULL DEFAULT 'draft',
    note VARCHAR(500) NULL, source_kind VARCHAR(30) NOT NULL DEFAULT 'manual',
    source_table VARCHAR(60) NOT NULL DEFAULT 'erp_sales_contracts', source_key VARCHAR(160) NULL,
    created_by BIGINT UNSIGNED NULL, approved_by BIGINT UNSIGNED NULL, approved_at DATETIME NULL,
    closed_by BIGINT UNSIGNED NULL, closed_at DATETIME NULL, close_note VARCHAR(255) NULL,
    voided_by BIGINT UNSIGNED NULL, voided_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_erp_sales_contract_no(tenant_id,company_id,source_system,source_database,contract_no),
    KEY ix_erp_sales_contract_filter(tenant_id,company_id,source_system,source_database,status,contract_date,customer_code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS erp_sales_contract_items (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    contract_id BIGINT UNSIGNED NOT NULL, line_no INT UNSIGNED NOT NULL,
    item_code VARCHAR(40) NOT NULL, item_name VARCHAR(160) NULL, specification VARCHAR(160) NULL,
    unit VARCHAR(20) NOT NULL DEFAULT 'PCS', warehouse_code VARCHAR(30) NULL,
    quantity DECIMAL(24,3) NOT NULL, converted_quantity DECIMAL(24,3) NOT NULL DEFAULT 0,
    unit_price DECIMAL(24,6) NOT NULL DEFAULT 0, amount DECIMAL(24,6) NOT NULL DEFAULT 0,
    expected_date DATE NULL, note VARCHAR(255) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_erp_sales_contract_line(contract_id,line_no),
    KEY ix_erp_sales_contract_line_item(contract_id,item_code),
    CONSTRAINT fk_erp_sales_contract_line_header FOREIGN KEY(contract_id) REFERENCES erp_sales_contracts(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS erp_sales_contract_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    contract_id BIGINT UNSIGNED NOT NULL, tenant_id VARCHAR(60) NOT NULL,
    company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    event_kind VARCHAR(40) NOT NULL, before_json JSON NULL, after_json JSON NULL,
    reason VARCHAR(500) NOT NULL, changed_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_erp_sales_contract_event(contract_id,created_at),
    KEY ix_erp_sales_contract_event_context(source_database,event_kind,created_at),
    CONSTRAINT fk_erp_sales_contract_event_header FOREIGN KEY(contract_id) REFERENCES erp_sales_contracts(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await pool.query(`CREATE TABLE IF NOT EXISTS erp_sales_delivery_schedules (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    schedule_no VARCHAR(60) NOT NULL, order_id BIGINT UNSIGNED NOT NULL,
    order_item_id BIGINT UNSIGNED NOT NULL, customer_code VARCHAR(30) NOT NULL,
    item_code VARCHAR(40) NOT NULL, scheduled_date DATE NOT NULL,
    quantity DECIMAL(24,3) NOT NULL, fulfilled_quantity DECIMAL(24,3) NOT NULL DEFAULT 0,
    status ENUM('draft','approved','partial','fulfilled','cancelled') NOT NULL DEFAULT 'draft',
    note VARCHAR(500) NULL, created_by BIGINT UNSIGNED NULL, approved_by BIGINT UNSIGNED NULL,
    approved_at DATETIME NULL, cancelled_by BIGINT UNSIGNED NULL, cancelled_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_erp_sales_delivery_schedule_no(tenant_id,company_id,source_system,source_database,schedule_no),
    KEY ix_erp_sales_delivery_schedule_order(source_database,order_id,order_item_id,status,scheduled_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS erp_sales_delivery_schedule_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    schedule_id BIGINT UNSIGNED NOT NULL, tenant_id VARCHAR(60) NOT NULL,
    company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    event_kind VARCHAR(40) NOT NULL, before_json JSON NULL, after_json JSON NULL,
    reason VARCHAR(500) NOT NULL, changed_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_erp_sales_delivery_schedule_event(schedule_id,created_at),
    CONSTRAINT fk_erp_sales_delivery_schedule_event_header FOREIGN KEY(schedule_id) REFERENCES erp_sales_delivery_schedules(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await pool.query(`CREATE TABLE IF NOT EXISTS erp_sales_order_control_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    order_id BIGINT UNSIGNED NOT NULL, action_code VARCHAR(40) NOT NULL,
    before_json JSON NULL, after_json JSON NULL, reason VARCHAR(500) NOT NULL,
    changed_by BIGINT UNSIGNED NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_erp_sales_order_control_event(source_database,order_id,created_at),
    KEY ix_erp_sales_order_control_action(source_database,action_code,created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS erp_sales_pick_lists (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    pick_no VARCHAR(60) NOT NULL, order_id BIGINT UNSIGNED NOT NULL,
    warehouse_code VARCHAR(30) NULL, pick_date DATE NOT NULL,
    status ENUM('draft','approved','picked','cancelled') NOT NULL DEFAULT 'draft',
    note VARCHAR(500) NULL, created_by BIGINT UNSIGNED NULL, approved_by BIGINT UNSIGNED NULL,
    approved_at DATETIME NULL, completed_by BIGINT UNSIGNED NULL, completed_at DATETIME NULL,
    cancelled_by BIGINT UNSIGNED NULL, cancelled_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_erp_sales_pick_no(tenant_id,company_id,source_system,source_database,pick_no),
    KEY ix_erp_sales_pick_order(source_database,order_id,status,pick_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS erp_sales_pick_list_items (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    pick_list_id BIGINT UNSIGNED NOT NULL, order_item_id BIGINT UNSIGNED NOT NULL,
    item_code VARCHAR(40) NOT NULL, quantity DECIMAL(24,3) NOT NULL,
    picked_quantity DECIMAL(24,3) NOT NULL DEFAULT 0, note VARCHAR(255) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_erp_sales_pick_line(pick_list_id,order_item_id),
    CONSTRAINT fk_erp_sales_pick_line_header FOREIGN KEY(pick_list_id) REFERENCES erp_sales_pick_lists(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS erp_sales_procurement_demands (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    demand_no VARCHAR(60) NOT NULL, order_id BIGINT UNSIGNED NOT NULL,
    order_item_id BIGINT UNSIGNED NOT NULL, item_code VARCHAR(40) NOT NULL,
    quantity DECIMAL(24,3) NOT NULL, status ENUM('draft','pending','converted','cancelled') NOT NULL DEFAULT 'draft',
    reason VARCHAR(500) NOT NULL, procurement_document_id BIGINT UNSIGNED NULL,
    created_by BIGINT UNSIGNED NULL, approved_by BIGINT UNSIGNED NULL, approved_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_erp_sales_procurement_demand_no(tenant_id,company_id,source_system,source_database,demand_no),
    KEY ix_erp_sales_procurement_demand_order(source_database,order_id,order_item_id,status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  // S06 正式轉採購閉環：缺料需求本身保存公司別的轉單規則與正式請購來源，
  // 請購／採購明細再各自保存 demand id，讓一筆需求可追到一筆請購明細、
  // 再由既有 requisition_item_id 展開成多筆採購單／進貨，不以單一單號欄位假設一對一。
  for (const [column, definition] of [
    ['supplier_code', 'VARCHAR(30) NULL'],
    ['requisition_document_type', 'VARCHAR(20) NULL'],
    ['purchase_document_type', 'VARCHAR(20) NULL'],
    ['currency_code', "VARCHAR(10) NOT NULL DEFAULT 'TWD'"],
    ['unit_price', 'DECIMAL(24,6) NOT NULL DEFAULT 0'],
    ['expected_date', 'DATE NULL'],
    ['warehouse_code', 'VARCHAR(30) NULL'],
    ['department_code', 'VARCHAR(30) NULL'],
    ['requester_code', 'VARCHAR(30) NULL'],
    ['procurement_requisition_id', 'BIGINT UNSIGNED NULL'],
    ['procurement_requisition_item_id', 'BIGINT UNSIGNED NULL'],
    ['formal_requisition_no', 'VARCHAR(60) NULL'],
    ['conversion_note', 'VARCHAR(500) NULL'],
    ['converted_by', 'BIGINT UNSIGNED NULL'],
    ['converted_at', 'DATETIME NULL']
  ]) await addColumnIfMissing('erp_sales_procurement_demands', column, definition);
  await addColumnIfMissing('procurement_requisition_items', 'sales_procurement_demand_id', 'BIGINT UNSIGNED NULL');
  await addColumnIfMissing('procurement_order_items', 'sales_procurement_demand_id', 'BIGINT UNSIGNED NULL');
}

// The legacy COPMB table stores the customer and the ERP item code used for
// customer pricing, but it does not provide an independent customer-facing
// item number.  This target-only structure is therefore deliberately separate
// from the source mirror: the original SH/SC databases remain read-only, while
// the new ERP can maintain an external customer item number, validity period,
// soft-disable history, and an audit trail in the selected company database.
export async function ensureTargetSalesCustomerItemSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS erp_customer_item_mappings (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL,
    company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL,
    source_database VARCHAR(60) NOT NULL,
    customer_id BIGINT UNSIGNED NULL,
    customer_code VARCHAR(30) NOT NULL,
    customer_name VARCHAR(160) NOT NULL,
    external_item_code VARCHAR(80) NOT NULL,
    external_item_name VARCHAR(160) NULL,
    external_specification VARCHAR(160) NULL,
    item_id BIGINT UNSIGNED NULL,
    item_code VARCHAR(40) NOT NULL,
    item_name VARCHAR(160) NOT NULL,
    specification VARCHAR(160) NULL,
    unit VARCHAR(20) NULL,
    effective_from DATE NOT NULL,
    effective_to DATE NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    note VARCHAR(255) NULL,
    source_table VARCHAR(60) NOT NULL DEFAULT 'manual',
    source_key VARCHAR(160) NULL,
    created_by BIGINT UNSIGNED NULL,
    updated_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_erp_customer_item_mapping_version
      (tenant_id,company_id,source_system,source_database,customer_code,external_item_code,effective_from),
    KEY ix_erp_customer_item_mapping_lookup
      (tenant_id,company_id,source_system,source_database,customer_code,external_item_code,is_active),
    KEY ix_erp_customer_item_mapping_item
      (tenant_id,company_id,source_system,source_database,item_code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS erp_customer_item_mapping_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    mapping_id BIGINT UNSIGNED NOT NULL,
    tenant_id VARCHAR(60) NOT NULL,
    company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL,
    source_database VARCHAR(60) NOT NULL,
    event_kind VARCHAR(30) NOT NULL,
    before_json JSON NULL,
    after_json JSON NULL,
    reason VARCHAR(500) NOT NULL,
    changed_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_erp_customer_item_mapping_event_lookup
      (tenant_id,company_id,source_system,source_database,mapping_id,created_at),
    CONSTRAINT fk_erp_customer_item_mapping_event
      FOREIGN KEY (mapping_id) REFERENCES erp_customer_item_mappings(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

// COPMB/COPMC are read-only historical pricing references.  The new ERP
// keeps its approved customer/item prices in a separate target structure so
// validity, approval and version history cannot alter the original SH/SC
// databases.  A price version is never physically deleted; superseding it
// creates a new effective version and voiding it preserves the audit trail.
export async function ensureTargetSalesPricingSchema() {
  await ensureTargetSalesWorkflowSchema();
  await ensureTargetSalesCustomerItemSchema();
  await pool.query(`CREATE TABLE IF NOT EXISTS erp_customer_item_prices (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    customer_id BIGINT UNSIGNED NULL, customer_code VARCHAR(30) NOT NULL,
    mapping_id BIGINT UNSIGNED NULL,
    item_id BIGINT UNSIGNED NULL, item_code VARCHAR(40) NOT NULL,
    pricing_unit VARCHAR(20) NOT NULL, currency_code VARCHAR(10) NOT NULL,
    unit_price DECIMAL(24,6) NOT NULL DEFAULT 0,
    discount_rate DECIMAL(12,8) NULL,
    tax_included TINYINT(1) NOT NULL DEFAULT 0,
    quantity_pricing_flag TINYINT(1) NOT NULL DEFAULT 0,
    trade_condition VARCHAR(10) NOT NULL DEFAULT '1',
    effective_from DATE NOT NULL, effective_to DATE NULL,
    status ENUM('draft','approved','voided') NOT NULL DEFAULT 'draft',
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    source_kind VARCHAR(30) NOT NULL DEFAULT 'manual',
    source_document_id BIGINT UNSIGNED NULL, source_document_no VARCHAR(80) NULL,
    source_document_type VARCHAR(20) NULL, source_table VARCHAR(60) NOT NULL DEFAULT 'manual',
    source_key VARCHAR(160) NULL, note VARCHAR(500) NULL,
    created_by BIGINT UNSIGNED NULL, updated_by BIGINT UNSIGNED NULL,
    approved_by BIGINT UNSIGNED NULL, approved_at DATETIME NULL,
    voided_by BIGINT UNSIGNED NULL, voided_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_erp_customer_item_price_version
      (tenant_id,company_id,source_system,source_database,customer_code,item_code,pricing_unit,currency_code,effective_from),
    KEY ix_erp_customer_item_price_lookup
      (tenant_id,company_id,source_system,source_database,customer_code,item_code,pricing_unit,currency_code,status,is_active,effective_from),
    KEY ix_erp_customer_item_price_source
      (source_database,source_kind,source_document_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS erp_customer_item_price_tiers (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    pricing_id BIGINT UNSIGNED NOT NULL, line_no INT UNSIGNED NOT NULL DEFAULT 1,
    quantity_from DECIMAL(24,6) NOT NULL DEFAULT 0,
    unit_price DECIMAL(24,6) NULL, discount_rate DECIMAL(12,8) NULL,
    note VARCHAR(500) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_erp_customer_item_price_tier(pricing_id,quantity_from),
    KEY ix_erp_customer_item_price_tier_line(pricing_id,line_no),
    CONSTRAINT fk_erp_customer_item_price_tier
      FOREIGN KEY (pricing_id) REFERENCES erp_customer_item_prices(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS erp_customer_item_price_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    pricing_id BIGINT UNSIGNED NOT NULL,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    event_kind VARCHAR(30) NOT NULL, before_json JSON NULL, after_json JSON NULL,
    reason VARCHAR(500) NOT NULL, changed_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_erp_customer_item_price_event_lookup
      (tenant_id,company_id,source_system,source_database,pricing_id,created_at),
    CONSTRAINT fk_erp_customer_item_price_event
      FOREIGN KEY (pricing_id) REFERENCES erp_customer_item_prices(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

// Unified document nature configuration.  This is the target ERP control
// table; legacy CMSMQ/ACR/ACP/ACT data is only used as a source reference and
// is never updated.  The source_database key is intentional because one
// company may import more than one ERP database with different rules.
export async function ensureTargetDocumentNatureSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS erp_document_natures (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
    source_database VARCHAR(60) NOT NULL, module_code VARCHAR(12) NOT NULL,
    document_kind VARCHAR(40) NOT NULL, nature_code VARCHAR(12) NOT NULL,
    type_code VARCHAR(20) NOT NULL, type_name VARCHAR(80) NOT NULL, type_full_name VARCHAR(120) NULL,
    number_prefix VARCHAR(20) NOT NULL, numbering_method VARCHAR(12) NOT NULL DEFAULT 'daily',
    year_digits TINYINT UNSIGNED NOT NULL DEFAULT 4, serial_digits TINYINT UNSIGNED NOT NULL DEFAULT 4,
    requires_approval TINYINT(1) NOT NULL DEFAULT 1, auto_confirm TINYINT(1) NOT NULL DEFAULT 0,
    direct_settlement TINYINT(1) NOT NULL DEFAULT 0, settlement_mode VARCHAR(20) NOT NULL DEFAULT 'batch',
    require_source_document TINYINT(1) NOT NULL DEFAULT 0, source_document_kind VARCHAR(40) NULL,
    inventory_effect VARCHAR(20) NOT NULL DEFAULT 'none',
    debit_account_code VARCHAR(30) NULL, debit_account_name VARCHAR(120) NULL,
    credit_account_code VARCHAR(30) NULL, credit_account_name VARCHAR(120) NULL,
    is_default TINYINT(1) NOT NULL DEFAULT 0, is_active TINYINT(1) NOT NULL DEFAULT 1,
    source_table VARCHAR(60) NULL, source_status VARCHAR(30) NOT NULL DEFAULT 'standard_default',
    note VARCHAR(500) NULL, created_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_erp_document_nature(tenant_id,company_id,source_system,source_database,module_code,document_kind,type_code),
    KEY ix_erp_document_nature_lookup(tenant_id,company_id,source_system,source_database,module_code,document_kind,is_active)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

// Finance vouchers are the application-side equivalent of iSM ACRTA/ACRTB
// and ACPTA/ACPTB.  They live in the selected target database only; the
// legacy source database remains read-only.  A voucher header may collect
// many source lines, while the same source line may be allocated partially
// across more than one voucher.
export async function ensureTargetFinanceWorkflowSchema() {
  // 部分既有公司目標庫是由較早版本建立，只有應收／應付基本表，
  // 尚未建立銀行三表。先以增量方式補齊核心表，避免新公司啟動時因 ALTER
  // 找不到資料表而整個服務無法啟動；不會碰觸來源 ERP 資料庫。
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_open_items (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL, account_type ENUM('AR','AP') NOT NULL,
    document_no VARCHAR(60) NOT NULL, document_date DATE NOT NULL, due_date DATE NULL, party_code VARCHAR(30) NOT NULL,
    currency_code VARCHAR(10) NOT NULL DEFAULT 'TWD', source_kind VARCHAR(30) NOT NULL, source_document_id BIGINT UNSIGNED NULL,
    source_document_no VARCHAR(60) NULL, original_amount DECIMAL(24,6) NOT NULL, settled_amount DECIMAL(24,6) NOT NULL DEFAULT 0,
    balance_amount DECIMAL(24,6) NOT NULL, status ENUM('draft','approved','open','partial','settled','voided') NOT NULL DEFAULT 'draft',
    note VARCHAR(500) NULL, created_by BIGINT UNSIGNED NULL, approved_by BIGINT UNSIGNED NULL, approved_at DATETIME NULL,
    posted_by BIGINT UNSIGNED NULL, posted_at DATETIME NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_finance_open_item(tenant_id,company_id,source_system,account_type,document_no),
    UNIQUE KEY uq_finance_source(tenant_id,company_id,source_system,account_type,source_kind,source_document_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_opening_balances (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    account_type ENUM('AR','AP') NOT NULL, opening_no VARCHAR(60) NOT NULL,
    opening_date DATE NOT NULL, due_date DATE NULL, party_code VARCHAR(30) NOT NULL,
    source_document_no VARCHAR(80) NULL, currency_code VARCHAR(10) NOT NULL DEFAULT 'TWD',
    original_amount DECIMAL(24,6) NOT NULL,
    status ENUM('draft','approved','posted','voided') NOT NULL DEFAULT 'draft',
    note VARCHAR(500) NULL, created_by BIGINT UNSIGNED NULL, approved_by BIGINT UNSIGNED NULL,
    approved_at DATETIME NULL, posted_by BIGINT UNSIGNED NULL, posted_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_finance_opening_balance(tenant_id,company_id,source_system,source_database,account_type,opening_no),
    KEY ix_finance_opening_balance(source_database,account_type,opening_date,status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_settlements (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL, account_type ENUM('AR','AP') NOT NULL,
    settlement_no VARCHAR(60) NOT NULL, settlement_date DATE NOT NULL, party_code VARCHAR(30) NOT NULL,
    payment_method VARCHAR(30) NULL, bank_code VARCHAR(30) NULL, reference_no VARCHAR(80) NULL, amount DECIMAL(24,6) NOT NULL,
    status ENUM('draft','approved','posted','voided') NOT NULL DEFAULT 'draft', note VARCHAR(500) NULL,
    created_by BIGINT UNSIGNED NULL, approved_by BIGINT UNSIGNED NULL, approved_at DATETIME NULL,
    posted_by BIGINT UNSIGNED NULL, posted_at DATETIME NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_finance_settlement(tenant_id,company_id,source_system,account_type,settlement_no)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_allocations (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, settlement_id BIGINT UNSIGNED NOT NULL, open_item_id BIGINT UNSIGNED NOT NULL,
    allocated_amount DECIMAL(24,6) NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_finance_allocation(settlement_id,open_item_id),
    CONSTRAINT fk_finance_allocation_settlement FOREIGN KEY(settlement_id) REFERENCES finance_settlements(id) ON DELETE CASCADE,
    CONSTRAINT fk_finance_allocation_open_item FOREIGN KEY(open_item_id) REFERENCES finance_open_items(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_notes (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL, account_type ENUM('AR','AP') NOT NULL,
    note_no VARCHAR(60) NOT NULL, note_type VARCHAR(20) NOT NULL, issue_date DATE NOT NULL, due_date DATE NOT NULL,
    party_code VARCHAR(30) NOT NULL, bank_code VARCHAR(30) NULL, bank_account VARCHAR(60) NULL, amount DECIMAL(24,6) NOT NULL,
    settlement_id BIGINT UNSIGNED NULL, status ENUM('draft','received','issued','deposited','cashed','honored','dishonored','voided') NOT NULL DEFAULT 'draft',
    memo VARCHAR(500) NULL, created_by BIGINT UNSIGNED NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_finance_note(tenant_id,company_id,source_system,account_type,note_no),
    KEY ix_finance_note(source_database,account_type,due_date,status),
    CONSTRAINT fk_finance_note_settlement FOREIGN KEY(settlement_id) REFERENCES finance_settlements(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_bank_accounts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL, bank_code VARCHAR(30) NOT NULL,
    bank_name VARCHAR(120) NOT NULL, account_no VARCHAR(80) NOT NULL, currency_code VARCHAR(10) NOT NULL DEFAULT 'TWD',
    opening_balance DECIMAL(24,6) NOT NULL DEFAULT 0, current_balance DECIMAL(24,6) NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1, note VARCHAR(500) NULL, created_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_finance_bank_account(tenant_id,company_id,source_system,source_database,bank_code,account_no),
    KEY ix_finance_bank_account(source_database,is_active)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_bank_transactions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL, bank_account_id BIGINT UNSIGNED NOT NULL,
    transaction_no VARCHAR(60) NOT NULL, transaction_date DATE NOT NULL, transaction_type VARCHAR(30) NOT NULL,
    direction ENUM('in','out') NOT NULL, amount DECIMAL(24,6) NOT NULL, reference_type VARCHAR(40) NULL,
    reference_id BIGINT UNSIGNED NULL, reference_no VARCHAR(80) NULL, counterparty VARCHAR(80) NULL, memo VARCHAR(500) NULL,
    status ENUM('draft','posted','voided') NOT NULL DEFAULT 'draft', reconciled TINYINT(1) NOT NULL DEFAULT 0,
    reconciled_at DATETIME NULL, created_by BIGINT UNSIGNED NULL, posted_by BIGINT UNSIGNED NULL, posted_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_finance_bank_transaction(tenant_id,company_id,source_system,source_database,transaction_no),
    KEY ix_finance_bank_transaction(bank_account_id,transaction_date,status,reconciled),
    CONSTRAINT fk_finance_bank_transaction_account FOREIGN KEY(bank_account_id) REFERENCES finance_bank_accounts(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_bank_reconciliations (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL, bank_account_id BIGINT UNSIGNED NOT NULL,
    reconciliation_date DATE NOT NULL, statement_balance DECIMAL(24,6) NOT NULL, book_balance DECIMAL(24,6) NOT NULL,
    difference_amount DECIMAL(24,6) NOT NULL, status ENUM('draft','completed','difference') NOT NULL DEFAULT 'draft',
    note VARCHAR(500) NULL, created_by BIGINT UNSIGNED NULL, completed_by BIGINT UNSIGNED NULL, completed_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, KEY ix_finance_bank_reconciliation(bank_account_id,reconciliation_date,status),
    CONSTRAINT fk_finance_bank_reconciliation_account FOREIGN KEY(bank_account_id) REFERENCES finance_bank_accounts(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await addColumnIfMissing('finance_open_items', 'adjustment_amount', 'DECIMAL(24,6) NOT NULL DEFAULT 0');
  await addColumnIfMissing('finance_open_items', 'base_adjustment_amount', 'DECIMAL(24,6) NOT NULL DEFAULT 0');
  await addColumnIfMissing('finance_open_items', 'exchange_rate', 'DECIMAL(18,8) NOT NULL DEFAULT 1');
  await addColumnIfMissing('finance_open_items', 'base_original_amount', 'DECIMAL(24,6) NOT NULL DEFAULT 0');
  await addColumnIfMissing('finance_open_items', 'base_settled_amount', 'DECIMAL(24,6) NOT NULL DEFAULT 0');
  await addColumnIfMissing('finance_open_items', 'base_balance_amount', 'DECIMAL(24,6) NOT NULL DEFAULT 0');
  await addColumnIfMissing('finance_settlements', 'currency_code', "VARCHAR(10) NOT NULL DEFAULT 'TWD'");
  await addColumnIfMissing('finance_settlements', 'exchange_rate', 'DECIMAL(18,8) NOT NULL DEFAULT 1');
  await addColumnIfMissing('finance_settlements', 'base_amount', 'DECIMAL(24,6) NOT NULL DEFAULT 0');
  await addColumnIfMissing('finance_settlements', 'exchange_difference', 'DECIMAL(24,6) NOT NULL DEFAULT 0');
  await addColumnIfMissing('finance_allocations', 'base_allocated_amount', 'DECIMAL(24,6) NOT NULL DEFAULT 0');
  await addColumnIfMissing('finance_allocations', 'exchange_difference', 'DECIMAL(24,6) NOT NULL DEFAULT 0');
  for (const [column, definition] of [
    ['bank_account_id', 'BIGINT UNSIGNED NULL'], ['status_date', 'DATE NULL'],
    ['status_by', 'BIGINT UNSIGNED NULL'], ['status_note', 'VARCHAR(500) NULL']
  ]) await addColumnIfMissing('finance_notes', column, definition);
  // R07：銀行與票據異動要保留可追溯的分錄、沖回及逐筆對帳關聯。
  // 這些增量表只存在目標 ERP，不會寫回 SH／SC 原始資料庫。
  for (const [column, definition] of [
    ['accounting_draft_id', 'BIGINT UNSIGNED NULL'],
    ['counter_account_code', 'VARCHAR(30) NULL'],
    ['counter_account_name', 'VARCHAR(120) NULL'],
    ['reversal_of_id', 'BIGINT UNSIGNED NULL'],
    ['reversal_reason', 'VARCHAR(500) NULL']
  ]) await addColumnIfMissing('finance_bank_transactions', column, definition);
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_note_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
    source_database VARCHAR(60) NOT NULL, note_id BIGINT UNSIGNED NOT NULL,
    from_status VARCHAR(20) NULL, to_status VARCHAR(20) NOT NULL, event_date DATE NOT NULL,
    bank_transaction_id BIGINT UNSIGNED NULL, accounting_draft_id BIGINT UNSIGNED NULL,
    reason VARCHAR(500) NULL, created_by BIGINT UNSIGNED NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_finance_note_event(note_id,event_date,id),
    KEY ix_finance_note_event_source(source_database,event_date),
    CONSTRAINT fk_finance_note_event_note FOREIGN KEY(note_id) REFERENCES finance_notes(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_bank_transaction_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
    source_database VARCHAR(60) NOT NULL, transaction_id BIGINT UNSIGNED NOT NULL,
    event_kind VARCHAR(30) NOT NULL, before_status VARCHAR(20) NULL, after_status VARCHAR(20) NULL,
    reversal_transaction_id BIGINT UNSIGNED NULL, accounting_draft_id BIGINT UNSIGNED NULL,
    reason VARCHAR(500) NULL, created_by BIGINT UNSIGNED NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_finance_bank_transaction_event(transaction_id,created_at,id),
    KEY ix_finance_bank_transaction_event_source(source_database,created_at),
    CONSTRAINT fk_finance_bank_transaction_event_transaction FOREIGN KEY(transaction_id) REFERENCES finance_bank_transactions(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_bank_reconciliation_items (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    reconciliation_id BIGINT UNSIGNED NOT NULL, bank_transaction_id BIGINT UNSIGNED NOT NULL,
    matched_amount DECIMAL(24,6) NOT NULL, statement_date DATE NULL, statement_reference_no VARCHAR(80) NULL,
    status ENUM('matched','unmatched') NOT NULL DEFAULT 'matched', note VARCHAR(500) NULL,
    created_by BIGINT UNSIGNED NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_finance_reconciliation_item(reconciliation_id,bank_transaction_id),
    KEY ix_finance_reconciliation_transaction(bank_transaction_id,status),
    CONSTRAINT fk_finance_reconciliation_item_header FOREIGN KEY(reconciliation_id) REFERENCES finance_bank_reconciliations(id) ON DELETE CASCADE,
    CONSTRAINT fk_finance_reconciliation_item_transaction FOREIGN KEY(bank_transaction_id) REFERENCES finance_bank_transactions(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_vouchers (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL,
    company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL,
    source_database VARCHAR(60) NOT NULL,
    account_type ENUM('AR','AP') NOT NULL,
    document_type VARCHAR(20) NOT NULL,
    voucher_no VARCHAR(60) NOT NULL,
    voucher_date DATE NOT NULL,
    due_date DATE NULL,
    party_code VARCHAR(30) NOT NULL,
    currency_code VARCHAR(10) NOT NULL DEFAULT 'TWD',
    settlement_mode ENUM('direct','manual','batch') NOT NULL DEFAULT 'direct',
    invoice_no VARCHAR(60) NULL,
    invoice_date DATE NULL,
    net_amount DECIMAL(24,6) NOT NULL DEFAULT 0,
    tax_amount DECIMAL(24,6) NOT NULL DEFAULT 0,
    total_amount DECIMAL(24,6) NOT NULL,
    status ENUM('draft','approved','posted','voided') NOT NULL DEFAULT 'draft',
    note VARCHAR(500) NULL,
    created_by BIGINT UNSIGNED NULL,
    approved_by BIGINT UNSIGNED NULL,
    approved_at DATETIME NULL,
    posted_by BIGINT UNSIGNED NULL,
    posted_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_finance_voucher(tenant_id,company_id,source_system,account_type,voucher_no),
    KEY ix_finance_voucher_source(source_database,account_type,voucher_date,status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_voucher_sources (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    voucher_id BIGINT UNSIGNED NOT NULL,
    source_kind VARCHAR(40) NOT NULL,
    source_document_id BIGINT UNSIGNED NULL,
    source_document_item_id BIGINT UNSIGNED NULL,
    source_document_type VARCHAR(20) NULL,
    source_document_no VARCHAR(60) NULL,
    source_line_no INT UNSIGNED NULL,
    source_date DATE NULL,
    item_code VARCHAR(40) NULL,
    quantity DECIMAL(24,6) NULL,
    unit_price DECIMAL(24,6) NULL,
    source_amount DECIMAL(24,6) NOT NULL DEFAULT 0,
    tax_amount DECIMAL(24,6) NOT NULL DEFAULT 0,
    allocated_amount DECIMAL(24,6) NOT NULL DEFAULT 0,
    note VARCHAR(255) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_finance_voucher_source_lookup(source_kind,source_document_id,source_document_item_id),
    KEY ix_finance_voucher_source_voucher(voucher_id),
    CONSTRAINT fk_finance_voucher_source_header FOREIGN KEY(voucher_id) REFERENCES finance_vouchers(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  for (const [column, definition] of [
    ['closing_basis',"ENUM('manual','unified','customer') NOT NULL DEFAULT 'manual'"],
    ['source_code',"VARCHAR(10) NOT NULL DEFAULT '1'"],
    ['invoice_type','VARCHAR(20) NULL'],['tax_id','VARCHAR(20) NULL'],
    ['invoice_status',"ENUM('none','pending','issued','received','voided') NOT NULL DEFAULT 'none'"],
    ['exchange_rate','DECIMAL(18,8) NOT NULL DEFAULT 1'],
    ['base_net_amount','DECIMAL(24,6) NOT NULL DEFAULT 0'],
    ['base_tax_amount','DECIMAL(24,6) NOT NULL DEFAULT 0'],
    ['base_total_amount','DECIMAL(24,6) NOT NULL DEFAULT 0']
  ]) await addColumnIfMissing('finance_vouchers', column, definition);
  // 發票補登、作廢與重開不得覆蓋歷程；保留每一次異動，讓財務稽核可以
  // 回看原發票、作廢原因與重新開立的發票資料。這張表只存在目標 ERP，
  // 不會回寫 SH／SC 原始資料庫。
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_invoice_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL,
    company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL,
    source_database VARCHAR(60) NOT NULL,
    voucher_id BIGINT UNSIGNED NOT NULL,
    event_kind ENUM('supplement','update','void','reopen') NOT NULL,
    before_invoice_no VARCHAR(60) NULL,
    before_invoice_date DATE NULL,
    before_invoice_type VARCHAR(20) NULL,
    before_tax_id VARCHAR(20) NULL,
    before_invoice_status VARCHAR(20) NULL,
    after_invoice_no VARCHAR(60) NULL,
    after_invoice_date DATE NULL,
    after_invoice_type VARCHAR(20) NULL,
    after_tax_id VARCHAR(20) NULL,
    after_invoice_status VARCHAR(20) NULL,
    reason VARCHAR(500) NULL,
    created_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_finance_invoice_event_voucher(voucher_id,created_at),
    KEY ix_finance_invoice_event_source(source_database,created_at),
    CONSTRAINT fk_finance_invoice_event_voucher FOREIGN KEY(voucher_id) REFERENCES finance_vouchers(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_closing_settings (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
    source_database VARCHAR(60) NOT NULL, account_type ENUM('AR','AP') NOT NULL,
    unified_closing_day TINYINT UNSIGNED NOT NULL DEFAULT 31, base_currency_code VARCHAR(10) NOT NULL DEFAULT 'TWD',
    exchange_gain_account_code VARCHAR(30) NOT NULL DEFAULT '7161', exchange_gain_account_name VARCHAR(120) NOT NULL DEFAULT '兌換利益',
    exchange_loss_account_code VARCHAR(30) NOT NULL DEFAULT '7162', exchange_loss_account_name VARCHAR(120) NOT NULL DEFAULT '兌換損失',
    auto_generate TINYINT(1) NOT NULL DEFAULT 0, note VARCHAR(500) NULL,
    created_by BIGINT UNSIGNED NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_finance_closing_setting(tenant_id,company_id,source_system,source_database,account_type)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_return_adjustments (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    sales_return_id BIGINT UNSIGNED NOT NULL, sales_return_item_id BIGINT UNSIGNED NOT NULL, shipment_item_id BIGINT UNSIGNED NULL,
    open_item_id BIGINT UNSIGNED NULL, adjustment_date DATE NOT NULL, return_amount DECIMAL(24,6) NOT NULL,
    receivable_offset_amount DECIMAL(24,6) NOT NULL DEFAULT 0, customer_credit_amount DECIMAL(24,6) NOT NULL DEFAULT 0,
    refund_amount DECIMAL(24,6) NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'pending', note VARCHAR(500) NULL, created_by BIGINT UNSIGNED NULL,
    processed_by BIGINT UNSIGNED NULL, processed_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_finance_return_adjustment(source_database,sales_return_item_id),
    KEY ix_finance_return_customer(source_database,adjustment_date),
    CONSTRAINT fk_finance_return_open_item FOREIGN KEY(open_item_id) REFERENCES finance_open_items(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await addColumnIfMissing('finance_return_adjustments', 'refund_amount', 'DECIMAL(24,6) NOT NULL DEFAULT 0');
  await addColumnIfMissing('finance_return_adjustments', 'processed_by', 'BIGINT UNSIGNED NULL');
  await addColumnIfMissing('finance_return_adjustments', 'processed_at', 'DATETIME NULL');
  // Older installations created this as ENUM(offset/credit/mixed).  Pending
  // means the return is already recorded but the original AR has not been
  // posted yet, so the target schema must allow it explicitly.
  await pool.query("ALTER TABLE finance_return_adjustments MODIFY COLUMN status VARCHAR(20) NOT NULL DEFAULT 'pending'");
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_return_adjustment_allocations (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    adjustment_id BIGINT UNSIGNED NOT NULL, open_item_id BIGINT UNSIGNED NOT NULL,
    allocated_amount DECIMAL(24,6) NOT NULL, base_allocated_amount DECIMAL(24,6) NOT NULL DEFAULT 0,
    created_by BIGINT UNSIGNED NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_finance_return_adjustment_allocation(adjustment_id,open_item_id),
    KEY ix_finance_return_adjustment_open_item(open_item_id),
    CONSTRAINT fk_finance_return_allocation_adjustment FOREIGN KEY(adjustment_id) REFERENCES finance_return_adjustments(id) ON DELETE CASCADE,
    CONSTRAINT fk_finance_return_allocation_open_item FOREIGN KEY(open_item_id) REFERENCES finance_open_items(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // 銷退應收沖帳不能只保留最後狀態；每次自動沖帳、形成待抵、轉抵或退款
  // 都要留下事件，讓稽核可以回答「何時、由哪一張應收、以多少金額處理」。
  // 本表只存在目標 ERP，不會回寫 SH／SC 原始唯讀資料庫。
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_return_adjustment_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    adjustment_id BIGINT UNSIGNED NOT NULL, event_kind VARCHAR(30) NOT NULL,
    before_status VARCHAR(20) NULL, after_status VARCHAR(20) NULL,
    open_item_id BIGINT UNSIGNED NULL, amount DECIMAL(24,6) NOT NULL DEFAULT 0,
    reason VARCHAR(500) NULL, created_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_finance_return_adjustment_event(adjustment_id,created_at,id),
    KEY ix_finance_return_adjustment_event_source(source_database,created_at),
    CONSTRAINT fk_finance_return_adjustment_event_adjustment FOREIGN KEY(adjustment_id) REFERENCES finance_return_adjustments(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_customer_credits (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    party_code VARCHAR(30) NOT NULL, currency_code VARCHAR(10) NOT NULL DEFAULT 'TWD', credit_date DATE NOT NULL,
    source_adjustment_id BIGINT UNSIGNED NOT NULL, original_amount DECIMAL(24,6) NOT NULL,
    applied_amount DECIMAL(24,6) NOT NULL DEFAULT 0, refunded_amount DECIMAL(24,6) NOT NULL DEFAULT 0, balance_amount DECIMAL(24,6) NOT NULL,
    status ENUM('available','partial','applied','refunded') NOT NULL DEFAULT 'available', note VARCHAR(500) NULL,
    created_by BIGINT UNSIGNED NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_finance_customer_credit(source_adjustment_id),
    KEY ix_finance_customer_credit(source_database,party_code,status,credit_date),
    CONSTRAINT fk_finance_customer_credit_adjustment FOREIGN KEY(source_adjustment_id) REFERENCES finance_return_adjustments(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_customer_credit_movements (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, credit_id BIGINT UNSIGNED NOT NULL,
    movement_date DATE NOT NULL, movement_kind ENUM('apply','refund') NOT NULL, amount DECIMAL(24,6) NOT NULL,
    open_item_id BIGINT UNSIGNED NULL, reference_no VARCHAR(80) NULL, note VARCHAR(500) NULL, created_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_finance_credit_movement(credit_id,movement_date),
    CONSTRAINT fk_finance_credit_movement_credit FOREIGN KEY(credit_id) REFERENCES finance_customer_credits(id) ON DELETE CASCADE,
    CONSTRAINT fk_finance_credit_movement_open_item FOREIGN KEY(open_item_id) REFERENCES finance_open_items(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS accounting_periods (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
    source_database VARCHAR(60) NOT NULL, period_code VARCHAR(10) NOT NULL,
    start_date DATE NOT NULL, end_date DATE NOT NULL,
    status ENUM('open','closed') NOT NULL DEFAULT 'open',
    closed_by BIGINT UNSIGNED NULL, closed_at DATETIME NULL,
    reopened_by BIGINT UNSIGNED NULL, reopened_at DATETIME NULL,
    note VARCHAR(255) NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_accounting_period(tenant_id,company_id,source_system,period_code),
    KEY ix_accounting_period_date(source_database,start_date,end_date,status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS accounting_auto_rules (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
    source_database VARCHAR(60) NOT NULL, rule_code VARCHAR(60) NOT NULL,
    module_code VARCHAR(20) NOT NULL, document_kind VARCHAR(40) NOT NULL DEFAULT '*',
    document_type VARCHAR(20) NOT NULL DEFAULT '*', entry_role VARCHAR(30) NOT NULL,
    debit_account_code VARCHAR(30) NOT NULL, debit_account_name VARCHAR(120) NOT NULL,
    credit_account_code VARCHAR(30) NOT NULL, credit_account_name VARCHAR(120) NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1, note VARCHAR(255) NULL,
    created_by BIGINT UNSIGNED NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_accounting_auto_rule(tenant_id,company_id,source_system,rule_code),
    KEY ix_accounting_auto_rule_lookup(source_database,module_code,document_kind,document_type,entry_role,is_active)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_advances (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    account_type ENUM('AR','AP') NOT NULL, advance_kind ENUM('prepayment','overpayment') NOT NULL, advance_no VARCHAR(60) NOT NULL, advance_date DATE NOT NULL, party_code VARCHAR(30) NOT NULL,
    currency_code VARCHAR(10) NOT NULL DEFAULT 'TWD', exchange_rate DECIMAL(18,8) NOT NULL DEFAULT 1, original_amount DECIMAL(24,6) NOT NULL, applied_amount DECIMAL(24,6) NOT NULL DEFAULT 0, refunded_amount DECIMAL(24,6) NOT NULL DEFAULT 0, balance_amount DECIMAL(24,6) NOT NULL,
    source_settlement_id BIGINT UNSIGNED NULL, source_document_no VARCHAR(80) NULL, status ENUM('draft','available','partial','applied','refunded','voided') NOT NULL DEFAULT 'draft', note VARCHAR(500) NULL,
    accounting_draft_id BIGINT UNSIGNED NULL,
    created_by BIGINT UNSIGNED NULL, approved_by BIGINT UNSIGNED NULL, approved_at DATETIME NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_finance_advance(tenant_id,company_id,source_system,account_type,advance_no), KEY ix_finance_advance(source_database,account_type,party_code,status,advance_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_advance_movements (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, advance_id BIGINT UNSIGNED NOT NULL, movement_date DATE NOT NULL, movement_kind ENUM('apply','refund','offset') NOT NULL, amount DECIMAL(24,6) NOT NULL, base_amount DECIMAL(24,6) NOT NULL DEFAULT 0, exchange_difference DECIMAL(24,6) NOT NULL DEFAULT 0, open_item_id BIGINT UNSIGNED NULL, related_open_item_id BIGINT UNSIGNED NULL, related_advance_id BIGINT UNSIGNED NULL, relationship_id BIGINT UNSIGNED NULL, accounting_draft_id BIGINT UNSIGNED NULL, reference_no VARCHAR(80) NULL, note VARCHAR(500) NULL, created_by BIGINT UNSIGNED NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_finance_advance_movement(advance_id,movement_date), CONSTRAINT fk_finance_advance_movement_header FOREIGN KEY(advance_id) REFERENCES finance_advances(id) ON DELETE CASCADE, CONSTRAINT fk_finance_advance_movement_open FOREIGN KEY(open_item_id) REFERENCES finance_open_items(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_party_links (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL, customer_code VARCHAR(30) NOT NULL, supplier_code VARCHAR(30) NOT NULL, relationship_type VARCHAR(30) NOT NULL DEFAULT 'customer_supplier', is_active TINYINT(1) NOT NULL DEFAULT 1, note VARCHAR(255) NULL, created_by BIGINT UNSIGNED NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_finance_party_link(tenant_id,company_id,source_system,source_database,customer_code,supplier_code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  for (const [column, definition] of [
    ['accounting_draft_id', 'BIGINT UNSIGNED NULL']
  ]) await addColumnIfMissing('finance_advances', column, definition);
  for (const [column, definition] of [
    ['base_amount', 'DECIMAL(24,6) NOT NULL DEFAULT 0'],
    ['exchange_difference', 'DECIMAL(24,6) NOT NULL DEFAULT 0'],
    ['related_open_item_id', 'BIGINT UNSIGNED NULL'],
    ['related_advance_id', 'BIGINT UNSIGNED NULL'],
    ['relationship_id', 'BIGINT UNSIGNED NULL'],
    ['accounting_draft_id', 'BIGINT UNSIGNED NULL']
  ]) await addColumnIfMissing('finance_advance_movements', column, definition);
  await pool.query(`CREATE TABLE IF NOT EXISTS finance_cross_offsets (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    offset_no VARCHAR(60) NOT NULL, offset_date DATE NOT NULL, offset_kind ENUM('open_items','advances') NOT NULL,
    customer_code VARCHAR(30) NOT NULL, supplier_code VARCHAR(30) NOT NULL, currency_code VARCHAR(10) NOT NULL DEFAULT 'TWD',
    amount DECIMAL(24,6) NOT NULL, ar_base_amount DECIMAL(24,6) NOT NULL DEFAULT 0, ap_base_amount DECIMAL(24,6) NOT NULL DEFAULT 0,
    exchange_difference DECIMAL(24,6) NOT NULL DEFAULT 0,
    ar_open_item_id BIGINT UNSIGNED NULL, ap_open_item_id BIGINT UNSIGNED NULL,
    ar_advance_id BIGINT UNSIGNED NULL, ap_advance_id BIGINT UNSIGNED NULL,
    relationship_id BIGINT UNSIGNED NULL, accounting_draft_id BIGINT UNSIGNED NULL,
    status ENUM('posted','voided') NOT NULL DEFAULT 'posted', reference_no VARCHAR(80) NULL, note VARCHAR(500) NULL,
    created_by BIGINT UNSIGNED NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_finance_cross_offset(tenant_id,company_id,source_system,source_database,offset_no),
    KEY ix_finance_cross_offset_date(source_database,offset_date,status),
    KEY ix_finance_cross_offset_party(source_database,customer_code,supplier_code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // R14：流程稽核要能把跨模組異常轉成「待核准更正建議」，但建議本身
  // 只寫入目標 ERP，不直接修改 SH／SC 原始唯讀資料。source_key 以流程、
  // 單據與明細組成，讓同一異常可重跑而不重複建立；核准後仍須由受控更正
  // 作業執行，這張表不代表已經套用更正。
  await pool.query(`CREATE TABLE IF NOT EXISTS flow_audit_recommendations (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    generation_key VARCHAR(80) NULL, flow_kind VARCHAR(30) NOT NULL,
    issue_code VARCHAR(80) NOT NULL, source_kind VARCHAR(60) NOT NULL,
    source_key VARCHAR(255) NOT NULL, source_id BIGINT UNSIGNED NULL,
    source_item_id BIGINT UNSIGNED NULL, source_document_no VARCHAR(120) NULL,
    source_date DATE NULL, expected_date DATE NULL, due_date DATE NULL,
    party_code VARCHAR(60) NULL, item_code VARCHAR(60) NULL, warehouse_code VARCHAR(60) NULL,
    currency_code VARCHAR(10) NOT NULL DEFAULT 'TWD', overdue_days INT NOT NULL DEFAULT 0,
    expected_overdue_days INT NOT NULL DEFAULT 0, aging_bucket VARCHAR(60) NULL,
    remaining_quantity DECIMAL(24,6) NOT NULL DEFAULT 0,
    remaining_amount DECIMAL(24,6) NOT NULL DEFAULT 0,
    financial_impact DECIMAL(24,6) NOT NULL DEFAULT 0,
    reason VARCHAR(1000) NOT NULL, proposed_action VARCHAR(1000) NOT NULL,
    status ENUM('pending','approved','rejected','applied','voided') NOT NULL DEFAULT 'pending',
    decision_note VARCHAR(1000) NULL, payload_json JSON NULL,
    created_by BIGINT UNSIGNED NULL, approved_by BIGINT UNSIGNED NULL,
    approved_at DATETIME NULL, applied_by BIGINT UNSIGNED NULL, applied_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_flow_audit_recommendation(tenant_id,company_id,source_system,source_database,source_key,issue_code),
    KEY ix_flow_audit_recommendation_filter(tenant_id,company_id,source_system,source_database,status,source_date),
    KEY ix_flow_audit_recommendation_flow(source_database,flow_kind,issue_code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS flow_audit_recommendation_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    recommendation_id BIGINT UNSIGNED NOT NULL,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    event_kind VARCHAR(30) NOT NULL, from_status VARCHAR(20) NULL,
    to_status VARCHAR(20) NOT NULL, note VARCHAR(1000) NULL,
    actor_id BIGINT UNSIGNED NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_flow_audit_recommendation_event(recommendation_id,created_at,id),
    KEY ix_flow_audit_recommendation_event_source(source_database,created_at),
    CONSTRAINT fk_flow_audit_recommendation_event FOREIGN KEY(recommendation_id)
      REFERENCES flow_audit_recommendations(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS accounting_drafts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    draft_no VARCHAR(60) NOT NULL, draft_date DATE NOT NULL, source_kind VARCHAR(40) NOT NULL, source_id BIGINT UNSIGNED NULL, source_document_no VARCHAR(80) NULL, account_type VARCHAR(10) NULL, party_code VARCHAR(30) NULL,
    debit_account_code VARCHAR(30) NOT NULL, debit_account_name VARCHAR(120) NOT NULL, credit_account_code VARCHAR(30) NOT NULL, credit_account_name VARCHAR(120) NOT NULL, amount DECIMAL(24,6) NOT NULL, status ENUM('draft','approved','posted','restored') NOT NULL DEFAULT 'draft', restore_reason VARCHAR(500) NULL,
    created_by BIGINT UNSIGNED NULL, approved_by BIGINT UNSIGNED NULL, approved_at DATETIME NULL, posted_by BIGINT UNSIGNED NULL, posted_at DATETIME NULL, restored_by BIGINT UNSIGNED NULL, restored_at DATETIME NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_accounting_draft(tenant_id,company_id,source_system,draft_no), KEY ix_accounting_draft_source(source_database,source_kind,source_id,status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // 會計底稿必須保留「產生、維護、核准、拋轉、還原」的可稽核鏈。
  // 舊版只有一組借貸欄位，以下欄位與明細表以增量方式補上，既有資料仍可讀取，
  // 但新底稿一律以多行明細與來源鎖定保存，不能透過修改原始來源繞過流程。
  for (const [column, definition] of [
    ['source_locked', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['source_locked_at', 'DATETIME NULL'],
    ['source_locked_by', 'BIGINT UNSIGNED NULL'],
    ['memo', 'VARCHAR(500) NULL']
  ]) await addColumnIfMissing('accounting_drafts', column, definition);
  await pool.query(`CREATE TABLE IF NOT EXISTS accounting_draft_lines (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    draft_id BIGINT UNSIGNED NOT NULL,
    line_no INT UNSIGNED NOT NULL,
    account_code VARCHAR(30) NOT NULL,
    account_name VARCHAR(120) NOT NULL,
    debit_amount DECIMAL(24,6) NOT NULL DEFAULT 0,
    credit_amount DECIMAL(24,6) NOT NULL DEFAULT 0,
    party_code VARCHAR(30) NULL,
    description VARCHAR(500) NULL,
    required_clearing TINYINT(1) NOT NULL DEFAULT 0,
    clearing_type VARCHAR(20) NULL,
    clearing_ref VARCHAR(255) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_accounting_draft_line(draft_id,line_no),
    KEY ix_accounting_draft_line_account(draft_id,account_code),
    CONSTRAINT fk_accounting_draft_line_header FOREIGN KEY(draft_id) REFERENCES accounting_drafts(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS accounting_draft_sources (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    draft_id BIGINT UNSIGNED NOT NULL,
    source_kind VARCHAR(40) NOT NULL,
    source_id BIGINT UNSIGNED NOT NULL,
    source_document_no VARCHAR(80) NULL,
    source_amount DECIMAL(24,6) NOT NULL DEFAULT 0,
    locked_amount DECIMAL(24,6) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_accounting_draft_source(draft_id,source_kind,source_id),
    KEY ix_accounting_draft_source_lock(source_kind,source_id,draft_id),
    CONSTRAINT fk_accounting_draft_source_header FOREIGN KEY(draft_id) REFERENCES accounting_drafts(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS accounting_draft_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    draft_id BIGINT UNSIGNED NOT NULL,
    event_kind VARCHAR(30) NOT NULL,
    before_status VARCHAR(20) NULL,
    after_status VARCHAR(20) NULL,
    reason VARCHAR(500) NULL,
    user_id BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_accounting_draft_event(draft_id,created_at),
    CONSTRAINT fk_accounting_draft_event_header FOREIGN KEY(draft_id) REFERENCES accounting_drafts(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // 將舊版單一借貸欄位轉成唯讀歷史明細；新流程不再只依賴 header 上的兩個科目欄位。
  await pool.query(`INSERT IGNORE INTO accounting_draft_lines
    (draft_id,line_no,account_code,account_name,debit_amount,credit_amount,party_code,description)
    SELECT d.id,1,d.debit_account_code,d.debit_account_name,d.amount,0,d.party_code,'歷史底稿借方'
    FROM accounting_drafts d
    WHERE NOT EXISTS (SELECT 1 FROM accounting_draft_lines l WHERE l.draft_id=d.id)`);
  await pool.query(`INSERT IGNORE INTO accounting_draft_lines
    (draft_id,line_no,account_code,account_name,debit_amount,credit_amount,party_code,description)
    SELECT d.id,2,d.credit_account_code,d.credit_account_name,0,d.amount,d.party_code,'歷史底稿貸方'
    FROM accounting_drafts d
    WHERE NOT EXISTS (SELECT 1 FROM accounting_draft_lines l WHERE l.draft_id=d.id AND l.line_no=2)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS accounting_month_closings (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    period_code VARCHAR(10) NOT NULL, close_date DATE NOT NULL, status ENUM('draft','closed','reopened') NOT NULL DEFAULT 'draft', note VARCHAR(500) NULL, created_by BIGINT UNSIGNED NULL, closed_by BIGINT UNSIGNED NULL, closed_at DATETIME NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_accounting_month_close(tenant_id,company_id,source_system,source_database,period_code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS accounting_year_closings (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
    source_database VARCHAR(60) NOT NULL, fiscal_year CHAR(4) NOT NULL, closing_no VARCHAR(60) NOT NULL,
    close_date DATE NOT NULL, retained_earnings_account_code VARCHAR(30) NOT NULL DEFAULT '3201',
    retained_earnings_account_name VARCHAR(120) NOT NULL DEFAULT '保留盈餘',
    net_income DECIMAL(24,6) NOT NULL DEFAULT 0, journal_id BIGINT UNSIGNED NULL,
    status ENUM('draft','posted','voided') NOT NULL DEFAULT 'draft', note VARCHAR(500) NULL,
    created_by BIGINT UNSIGNED NULL, posted_by BIGINT UNSIGNED NULL, posted_at DATETIME NULL,
    line_count INT UNSIGNED NOT NULL DEFAULT 0, carry_forward_count INT UNSIGNED NOT NULL DEFAULT 0,
    total_debit DECIMAL(24,6) NOT NULL DEFAULT 0, total_credit DECIMAL(24,6) NOT NULL DEFAULT 0,
    reconciliation_status VARCHAR(20) NOT NULL DEFAULT 'pending', next_fiscal_year CHAR(4) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_accounting_year_closing(tenant_id,company_id,source_system,source_database,fiscal_year),
    KEY ix_accounting_year_closing(source_database,fiscal_year,status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // R08：期初導入與月底／年度結轉要有獨立批次、明細及事件鏈，
  // 不把銀行、票據、應收／應付與總帳期初混成一筆不可追蹤的調整資料。
  await pool.query(`CREATE TABLE IF NOT EXISTS accounting_opening_batches (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
    source_database VARCHAR(60) NOT NULL, batch_no VARCHAR(60) NOT NULL, opening_date DATE NOT NULL,
    source_label VARCHAR(255) NULL, note VARCHAR(500) NULL,
    status ENUM('draft','validated','approved','posted','voided') NOT NULL DEFAULT 'draft',
    bank_total DECIMAL(24,6) NOT NULL DEFAULT 0, ar_total DECIMAL(24,6) NOT NULL DEFAULT 0,
    ap_total DECIMAL(24,6) NOT NULL DEFAULT 0, ar_note_total DECIMAL(24,6) NOT NULL DEFAULT 0,
    ap_note_total DECIMAL(24,6) NOT NULL DEFAULT 0, gl_debit_total DECIMAL(24,6) NOT NULL DEFAULT 0,
    gl_credit_total DECIMAL(24,6) NOT NULL DEFAULT 0, line_count INT UNSIGNED NOT NULL DEFAULT 0,
    journal_id BIGINT UNSIGNED NULL,
    created_by BIGINT UNSIGNED NULL, validated_by BIGINT UNSIGNED NULL, validated_at DATETIME NULL,
    approved_by BIGINT UNSIGNED NULL, approved_at DATETIME NULL, posted_by BIGINT UNSIGNED NULL, posted_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_accounting_opening_batch(tenant_id,company_id,source_system,source_database,batch_no),
    KEY ix_accounting_opening_batch_date(source_database,opening_date,status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS accounting_opening_lines (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    batch_id BIGINT UNSIGNED NOT NULL, line_no INT UNSIGNED NOT NULL,
    entry_kind VARCHAR(20) NOT NULL, account_type VARCHAR(10) NULL,
    account_code VARCHAR(30) NULL, account_name VARCHAR(120) NULL,
    party_code VARCHAR(30) NULL, currency_code VARCHAR(10) NOT NULL DEFAULT 'TWD',
    amount DECIMAL(24,6) NOT NULL DEFAULT 0, debit_amount DECIMAL(24,6) NOT NULL DEFAULT 0,
    credit_amount DECIMAL(24,6) NOT NULL DEFAULT 0, document_no VARCHAR(80) NULL,
    document_date DATE NULL, due_date DATE NULL, source_document_no VARCHAR(80) NULL,
    bank_code VARCHAR(30) NULL, bank_name VARCHAR(120) NULL, bank_account_no VARCHAR(80) NULL,
    note_no VARCHAR(60) NULL, note_type VARCHAR(20) NULL, note_status VARCHAR(20) NULL,
    validation_status VARCHAR(20) NOT NULL DEFAULT 'pending', validation_message VARCHAR(500) NULL,
    created_target_id BIGINT UNSIGNED NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_accounting_opening_line(batch_id,line_no),
    KEY ix_accounting_opening_line_kind(batch_id,entry_kind,validation_status),
    CONSTRAINT fk_accounting_opening_line_batch FOREIGN KEY(batch_id) REFERENCES accounting_opening_batches(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS accounting_opening_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
    source_database VARCHAR(60) NOT NULL, batch_id BIGINT UNSIGNED NOT NULL, event_kind VARCHAR(30) NOT NULL,
    before_status VARCHAR(20) NULL, after_status VARCHAR(20) NULL, reason VARCHAR(500) NULL,
    user_id BIGINT UNSIGNED NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_accounting_opening_event(batch_id,created_at,id),
    CONSTRAINT fk_accounting_opening_event_batch FOREIGN KEY(batch_id) REFERENCES accounting_opening_batches(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS accounting_month_closing_lines (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    closing_id BIGINT UNSIGNED NOT NULL, line_no INT UNSIGNED NOT NULL,
    account_code VARCHAR(30) NOT NULL, account_name VARCHAR(120) NOT NULL, account_type VARCHAR(20) NULL,
    opening_debit DECIMAL(24,6) NOT NULL DEFAULT 0, opening_credit DECIMAL(24,6) NOT NULL DEFAULT 0,
    period_debit DECIMAL(24,6) NOT NULL DEFAULT 0, period_credit DECIMAL(24,6) NOT NULL DEFAULT 0,
    ending_debit DECIMAL(24,6) NOT NULL DEFAULT 0, ending_credit DECIMAL(24,6) NOT NULL DEFAULT 0,
    ending_balance DECIMAL(24,6) NOT NULL DEFAULT 0, line_kind VARCHAR(20) NOT NULL DEFAULT 'balance',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_accounting_month_closing_line(closing_id,line_no),
    KEY ix_accounting_month_closing_account(closing_id,account_code),
    CONSTRAINT fk_accounting_month_closing_line_header FOREIGN KEY(closing_id) REFERENCES accounting_month_closings(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS accounting_year_closing_lines (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    closing_id BIGINT UNSIGNED NOT NULL, line_no INT UNSIGNED NOT NULL,
    account_code VARCHAR(30) NOT NULL, account_name VARCHAR(120) NOT NULL, account_type VARCHAR(20) NULL,
    opening_debit DECIMAL(24,6) NOT NULL DEFAULT 0, opening_credit DECIMAL(24,6) NOT NULL DEFAULT 0,
    period_debit DECIMAL(24,6) NOT NULL DEFAULT 0, period_credit DECIMAL(24,6) NOT NULL DEFAULT 0,
    ending_debit DECIMAL(24,6) NOT NULL DEFAULT 0, ending_credit DECIMAL(24,6) NOT NULL DEFAULT 0,
    carry_forward_debit DECIMAL(24,6) NOT NULL DEFAULT 0, carry_forward_credit DECIMAL(24,6) NOT NULL DEFAULT 0,
    balance_amount DECIMAL(24,6) NOT NULL DEFAULT 0, line_kind VARCHAR(20) NOT NULL DEFAULT 'balance',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_accounting_year_closing_line(closing_id,line_no),
    KEY ix_accounting_year_closing_account(closing_id,account_code),
    CONSTRAINT fk_accounting_year_closing_line_header FOREIGN KEY(closing_id) REFERENCES accounting_year_closings(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS accounting_period_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
    source_database VARCHAR(60) NOT NULL, period_id BIGINT UNSIGNED NOT NULL, event_kind VARCHAR(30) NOT NULL,
    before_status VARCHAR(20) NULL, after_status VARCHAR(20) NULL, reason VARCHAR(500) NULL,
    user_id BIGINT UNSIGNED NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_accounting_period_event(period_id,created_at,id),
    CONSTRAINT fk_accounting_period_event_period FOREIGN KEY(period_id) REFERENCES accounting_periods(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // G01～G05：會計總帳管理系統的目標端獨立作業。
  // 這些表只建立在目前的 inventory_erp 目標庫，所有資料都帶完整公司／來源上下文；
  // 不會在 SH／SC 原始資料庫建立或更新任何表。
  await pool.query(`CREATE TABLE IF NOT EXISTS accounting_system_parameters (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    parameter_code VARCHAR(60) NOT NULL, parameter_name VARCHAR(120) NOT NULL,
    parameter_value TEXT NULL, data_type VARCHAR(20) NOT NULL DEFAULT 'text',
    effective_from DATE NULL, effective_to DATE NULL, version_no INT UNSIGNED NOT NULL DEFAULT 1,
    status VARCHAR(20) NOT NULL DEFAULT 'draft', note VARCHAR(500) NULL,
    created_by BIGINT UNSIGNED NULL, approved_by BIGINT UNSIGNED NULL, approved_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_accounting_system_parameter(tenant_id,company_id,source_system,source_database,parameter_code,version_no),
    KEY ix_accounting_system_parameter_current(tenant_id,company_id,source_system,source_database,parameter_code,status,effective_from)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS accounting_system_parameter_events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, parameter_id BIGINT UNSIGNED NOT NULL,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    event_kind VARCHAR(30) NOT NULL, before_json JSON NULL, after_json JSON NULL,
    reason VARCHAR(500) NULL, user_id BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_accounting_system_parameter_event(parameter_id,created_at,id),
    CONSTRAINT fk_accounting_system_parameter_event FOREIGN KEY(parameter_id) REFERENCES accounting_system_parameters(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS accounting_account_events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, account_id BIGINT UNSIGNED NOT NULL,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    event_kind VARCHAR(30) NOT NULL, before_json JSON NULL, after_json JSON NULL,
    reason VARCHAR(500) NULL, user_id BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_accounting_account_event(account_id,created_at,id),
    CONSTRAINT fk_accounting_account_event FOREIGN KEY(account_id) REFERENCES accounting_accounts(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS accounting_budgets (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    budget_code VARCHAR(60) NOT NULL, budget_name VARCHAR(120) NOT NULL,
    fiscal_year CHAR(4) NOT NULL, version_name VARCHAR(60) NOT NULL DEFAULT 'BASE',
    period_count TINYINT UNSIGNED NOT NULL DEFAULT 12,
    currency_code VARCHAR(10) NOT NULL DEFAULT 'TWD', status VARCHAR(20) NOT NULL DEFAULT 'draft',
    total_amount DECIMAL(24,6) NOT NULL DEFAULT 0, note VARCHAR(500) NULL,
    created_by BIGINT UNSIGNED NULL, approved_by BIGINT UNSIGNED NULL, approved_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_accounting_budget(tenant_id,company_id,source_system,source_database,budget_code,version_name),
    KEY ix_accounting_budget_filter(tenant_id,company_id,source_system,source_database,fiscal_year,status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS accounting_budget_lines (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, budget_id BIGINT UNSIGNED NOT NULL,
    line_no INT UNSIGNED NOT NULL, account_code VARCHAR(30) NOT NULL,
    account_name VARCHAR(120) NULL, department_code VARCHAR(30) NULL,
    period_no TINYINT UNSIGNED NOT NULL DEFAULT 0,
    budget_amount DECIMAL(24,6) NOT NULL DEFAULT 0, note VARCHAR(500) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_accounting_budget_line(budget_id,line_no),
    KEY ix_accounting_budget_line_account(budget_id,account_code,department_code,period_no),
    CONSTRAINT fk_accounting_budget_line FOREIGN KEY(budget_id) REFERENCES accounting_budgets(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS accounting_budget_events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, budget_id BIGINT UNSIGNED NOT NULL,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    event_kind VARCHAR(30) NOT NULL, before_status VARCHAR(20) NULL,
    after_status VARCHAR(20) NULL, reason VARCHAR(500) NULL, user_id BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_accounting_budget_event(budget_id,created_at,id),
    CONSTRAINT fk_accounting_budget_event FOREIGN KEY(budget_id) REFERENCES accounting_budgets(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS accounting_fixed_assets (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    asset_no VARCHAR(60) NOT NULL, asset_name VARCHAR(120) NOT NULL,
    category_code VARCHAR(30) NULL, account_code VARCHAR(30) NOT NULL DEFAULT '1501',
    account_name VARCHAR(120) NOT NULL DEFAULT '累計折舊',
    depreciation_expense_account_code VARCHAR(30) NOT NULL DEFAULT '5101',
    depreciation_expense_account_name VARCHAR(120) NOT NULL DEFAULT '銷貨成本',
    department_code VARCHAR(30) NULL,
    location VARCHAR(120) NULL, supplier_code VARCHAR(60) NULL,
    acquisition_date DATE NULL, in_service_date DATE NOT NULL,
    original_cost DECIMAL(24,6) NOT NULL, residual_value DECIMAL(24,6) NOT NULL DEFAULT 0,
    useful_life_months INT UNSIGNED NOT NULL, depreciation_method VARCHAR(30) NOT NULL DEFAULT 'straight_line',
    currency_code VARCHAR(10) NOT NULL DEFAULT 'TWD', accumulated_depreciation DECIMAL(24,6) NOT NULL DEFAULT 0,
    net_book_value DECIMAL(24,6) NOT NULL DEFAULT 0, status VARCHAR(20) NOT NULL DEFAULT 'draft',
    note VARCHAR(500) NULL, created_by BIGINT UNSIGNED NULL, approved_by BIGINT UNSIGNED NULL,
    approved_at DATETIME NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_accounting_fixed_asset(tenant_id,company_id,source_system,source_database,asset_no),
    KEY ix_accounting_fixed_asset_status(tenant_id,company_id,source_system,source_database,status,in_service_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS accounting_fixed_asset_events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, asset_id BIGINT UNSIGNED NOT NULL,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    event_kind VARCHAR(30) NOT NULL, before_json JSON NULL, after_json JSON NULL,
    reason VARCHAR(500) NULL, user_id BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_accounting_fixed_asset_event(asset_id,created_at,id),
    CONSTRAINT fk_accounting_fixed_asset_event FOREIGN KEY(asset_id) REFERENCES accounting_fixed_assets(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS accounting_fixed_asset_depreciations (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, asset_id BIGINT UNSIGNED NOT NULL,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    depreciation_no VARCHAR(60) NOT NULL, depreciation_period CHAR(7) NOT NULL,
    depreciation_date DATE NOT NULL, depreciation_amount DECIMAL(24,6) NOT NULL,
    accumulated_depreciation DECIMAL(24,6) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'draft',
    journal_draft_id BIGINT UNSIGNED NULL, note VARCHAR(500) NULL,
    created_by BIGINT UNSIGNED NULL, approved_by BIGINT UNSIGNED NULL, posted_by BIGINT UNSIGNED NULL,
    approved_at DATETIME NULL, posted_at DATETIME NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_accounting_fixed_asset_depreciation(tenant_id,company_id,source_system,source_database,asset_id,depreciation_period),
    KEY ix_accounting_fixed_asset_depreciation_period(tenant_id,company_id,source_system,source_database,depreciation_period,status),
    CONSTRAINT fk_accounting_fixed_asset_depreciation_asset FOREIGN KEY(asset_id) REFERENCES accounting_fixed_assets(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS accounting_profit_centers (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    center_code VARCHAR(60) NOT NULL, center_name VARCHAR(120) NOT NULL,
    department_code VARCHAR(30) NULL, parent_center_code VARCHAR(60) NULL,
    allocation_basis VARCHAR(30) NOT NULL DEFAULT 'direct', status VARCHAR(20) NOT NULL DEFAULT 'draft',
    is_active TINYINT(1) NOT NULL DEFAULT 1, note VARCHAR(500) NULL,
    created_by BIGINT UNSIGNED NULL, approved_by BIGINT UNSIGNED NULL, approved_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_accounting_profit_center(tenant_id,company_id,source_system,source_database,center_code),
    KEY ix_accounting_profit_center_status(tenant_id,company_id,source_system,source_database,status,is_active)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS accounting_profit_center_allocations (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    allocation_code VARCHAR(60) NOT NULL, allocation_name VARCHAR(120) NOT NULL,
    fiscal_year CHAR(4) NOT NULL, source_account_code VARCHAR(30) NOT NULL,
    target_center_code VARCHAR(60) NOT NULL, target_department_code VARCHAR(30) NULL,
    allocation_ratio DECIMAL(9,6) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'draft',
    note VARCHAR(500) NULL, created_by BIGINT UNSIGNED NULL, approved_by BIGINT UNSIGNED NULL,
    approved_at DATETIME NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_accounting_profit_center_allocation(tenant_id,company_id,source_system,source_database,allocation_code,target_center_code,source_account_code),
    KEY ix_accounting_profit_center_allocation_filter(tenant_id,company_id,source_system,source_database,fiscal_year,status),
    KEY ix_accounting_profit_center_allocation_target(target_center_code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS accounting_profit_center_events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, entity_kind VARCHAR(30) NOT NULL,
    entity_id BIGINT UNSIGNED NOT NULL, tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL,
    source_system VARCHAR(60) NOT NULL, source_database VARCHAR(60) NOT NULL,
    event_kind VARCHAR(30) NOT NULL, before_json JSON NULL, after_json JSON NULL,
    reason VARCHAR(500) NULL, user_id BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_accounting_profit_center_event(entity_kind,entity_id,created_at,id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  for (const [table, column, definition] of [
    ['finance_opening_balances','opening_batch_id','BIGINT UNSIGNED NULL'],
    ['finance_opening_balances','opening_line_id','BIGINT UNSIGNED NULL'],
    ['finance_opening_balances','journal_id','BIGINT UNSIGNED NULL'],
    ['finance_notes','opening_batch_id','BIGINT UNSIGNED NULL'],
    ['finance_notes','opening_line_id','BIGINT UNSIGNED NULL'],
    ['finance_bank_accounts','opening_batch_id','BIGINT UNSIGNED NULL'],
    ['finance_bank_accounts','opening_date','DATE NULL'],
    ['accounting_month_closings','line_count','INT UNSIGNED NOT NULL DEFAULT 0'],
    ['accounting_month_closings','total_debit','DECIMAL(24,6) NOT NULL DEFAULT 0'],
    ['accounting_month_closings','total_credit','DECIMAL(24,6) NOT NULL DEFAULT 0'],
    ['accounting_month_closings','reconciliation_status',"VARCHAR(20) NOT NULL DEFAULT 'pending'"],
    ['accounting_month_closings','next_period_code','VARCHAR(10) NULL'],
    ['accounting_year_closings','line_count','INT UNSIGNED NOT NULL DEFAULT 0'],
    ['accounting_year_closings','carry_forward_count','INT UNSIGNED NOT NULL DEFAULT 0'],
    ['accounting_year_closings','total_debit','DECIMAL(24,6) NOT NULL DEFAULT 0'],
    ['accounting_year_closings','total_credit','DECIMAL(24,6) NOT NULL DEFAULT 0'],
    ['accounting_year_closings','reconciliation_status',"VARCHAR(20) NOT NULL DEFAULT 'pending'"],
    ['accounting_year_closings','next_fiscal_year','CHAR(4) NULL']
  ]) await addColumnIfMissing(table, column, definition);
  for (const [column, definition] of [
    ['parent_account_code','VARCHAR(30) NULL'],
    ['account_level','INT UNSIGNED NOT NULL DEFAULT 1'],
    ['normal_balance',"VARCHAR(10) NOT NULL DEFAULT 'debit'"],
    ['is_detail','TINYINT(1) NOT NULL DEFAULT 1'],
    ['effective_from','DATE NULL'],
    ['effective_to','DATE NULL'],
    ['version_no','INT UNSIGNED NOT NULL DEFAULT 1'],
    ['status',"VARCHAR(20) NOT NULL DEFAULT 'approved'"],
    ['updated_by','BIGINT UNSIGNED NULL'],
    ['approved_by','BIGINT UNSIGNED NULL'],
    ['approved_at','DATETIME NULL'],
    ['note','VARCHAR(500) NULL'],
    ['updated_at','TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP']
  ]) await addColumnIfMissing('accounting_accounts', column, definition);
  await addColumnIfMissing('accounting_journal_lines', 'department_code', 'VARCHAR(30) NULL');
  await addColumnIfMissing('accounting_journal_lines', 'profit_center_code', 'VARCHAR(60) NULL');
  await addColumnIfMissing('accounting_budgets', 'period_count', 'TINYINT UNSIGNED NOT NULL DEFAULT 12');
  await addColumnIfMissing('accounting_fixed_assets', 'depreciation_expense_account_code', "VARCHAR(30) NOT NULL DEFAULT '5101'");
  await addColumnIfMissing('accounting_fixed_assets', 'depreciation_expense_account_name', "VARCHAR(120) NOT NULL DEFAULT '銷貨成本'");
  // 同一家公司可能匯入多個來源 ERP；單別規則與會計期間必須連同來源資料庫隔離，
  // 否則 SH 建立的規則會阻擋 SC 建立同名規則。
  for (const [table,index,columns] of [
    ['accounting_periods','uq_accounting_period',['tenant_id','company_id','source_system','source_database','period_code']],
    ['accounting_auto_rules','uq_accounting_auto_rule',['tenant_id','company_id','source_system','source_database','rule_code']]
  ]) {
    const [parts] = await pool.query(`SELECT column_name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=? AND index_name=? ORDER BY seq_in_index`,[table,index]);
    const current=parts.map(x=>x.column_name);
    if (current.join('|') !== columns.join('|')) {
      await pool.query(`ALTER TABLE \`${table}\` DROP INDEX \`${index}\`, ADD UNIQUE KEY \`${index}\` (${columns.map(x=>`\`${x}\``).join(',')})`);
    }
  }
}

export async function tx(work) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}
