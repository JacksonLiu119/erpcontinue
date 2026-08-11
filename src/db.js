import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import crypto from 'node:crypto';

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

export const pool = mysql.createPool({ ...baseConfig, database: process.env.DB_NAME || 'inventory_erp' });

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

export async function reloadSourceDatabases() {
  const [rows] = await pool.query(`SELECT source_key, label, adapter_code, host, port,
      database_name, username, password_env, tenant_id, company_id, source_system,
      enabled, read_only, sort_order
    FROM erp_data_sources WHERE enabled=1 ORDER BY sort_order, source_key`);
  for (const key of Object.keys(sourceDatabases)) delete sourceDatabases[key];
  for (const row of rows) {
    const key = String(row.source_key).toUpperCase();
    sourceDatabases[key] = {
      key, label: row.label, adapter_code: row.adapter_code, host: row.host,
      port: Number(row.port), database: row.database_name, username: row.username,
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
  if (!Number(row.count)) await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
        ('SH', 'SH（鼎新營運資料）', 'ism-sh', '127.0.0.1', 3306, 'sh', 'root', NULL, 1, 1, 10),
        ('SMARTDSCSYS', 'SMARTDSCSYS（鼎新系統資料）', 'ism-smartdscsys', '127.0.0.1', 3306, 'smartdscsys', 'root', NULL, 1, 1, 20),
        ('DSCRPT', 'DSCRPT（鼎新報表資料）', 'ism-dscrpt', '127.0.0.1', 3306, 'dscrpt', 'root', NULL, 1, 1, 30)`);
      await addColumnIfMissing('erp_data_sources', 'tenant_id', "VARCHAR(60) NOT NULL DEFAULT 'SH'");
      await addColumnIfMissing('erp_data_sources', 'company_id', "VARCHAR(60) NOT NULL DEFAULT 'SH'");
      await addColumnIfMissing('erp_data_sources', 'source_system', "VARCHAR(60) NOT NULL DEFAULT 'iSM'");
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
        category_1 VARCHAR(30) NULL, category_2 VARCHAR(30) NULL, category_3 VARCHAR(30) NULL,
        source_database VARCHAR(60) NOT NULL, source_table VARCHAR(60) NULL, source_key VARCHAR(160) NULL, raw_json JSON NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_erp_item_context (tenant_id, company_id, source_system, item_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
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
      await pool.query(`CREATE TABLE IF NOT EXISTS sales_documents (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,tenant_id VARCHAR(60) NOT NULL,company_id VARCHAR(60) NOT NULL,source_system VARCHAR(60) NOT NULL,source_database VARCHAR(60) NOT NULL,document_kind ENUM('quotation','sales_order','shipment','sales_return') NOT NULL,document_type VARCHAR(20) NOT NULL,document_no VARCHAR(60) NOT NULL,document_date DATE NOT NULL,customer_code VARCHAR(30) NOT NULL,currency_code VARCHAR(10) NOT NULL DEFAULT 'TWD',warehouse_code VARCHAR(30) NULL,salesperson_code VARCHAR(30) NULL,source_document_id BIGINT UNSIGNED NULL,return_type ENUM('return','allowance') NULL,status ENUM('draft','approved','partial','completed','posted','closed','voided') NOT NULL DEFAULT 'draft',inventory_status VARCHAR(20) NOT NULL DEFAULT 'not_applicable',note VARCHAR(500) NULL,created_by BIGINT UNSIGNED NULL,approved_by BIGINT UNSIGNED NULL,approved_at DATETIME NULL,posted_by BIGINT UNSIGNED NULL,posted_at DATETIME NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,UNIQUE KEY uq_sales_document(tenant_id,company_id,source_system,document_no),KEY ix_sales_document(source_database,document_kind,status,document_date)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      await pool.query(`CREATE TABLE IF NOT EXISTS sales_document_items (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,document_id BIGINT UNSIGNED NOT NULL,line_no INT UNSIGNED NOT NULL DEFAULT 1,source_item_id BIGINT UNSIGNED NULL,item_code VARCHAR(40) NOT NULL,item_name VARCHAR(160) NULL,specification VARCHAR(160) NULL,unit VARCHAR(20) NOT NULL DEFAULT 'PCS',warehouse_code VARCHAR(30) NULL,quantity DECIMAL(24,3) NOT NULL,related_quantity DECIMAL(24,3) NOT NULL DEFAULT 0,unit_price DECIMAL(24,6) NOT NULL DEFAULT 0,unit_cost DECIMAL(24,6) NOT NULL DEFAULT 0,expected_date DATE NULL,allowance_amount DECIMAL(24,6) NOT NULL DEFAULT 0,note VARCHAR(255) NULL,UNIQUE KEY uq_sales_document_item(document_id,line_no),CONSTRAINT fk_sales_document_item FOREIGN KEY(document_id) REFERENCES sales_documents(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
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
      await pool.query(`INSERT IGNORE INTO procurement_document_types
        (tenant_id, company_id, source_system, document_kind, type_code, type_name, number_prefix, requires_approval, allow_overage)
        VALUES ('SH','SH','iSM','requisition','RQ','請購單','RQ',1,0),
          ('SH','SH','iSM','purchase_order','PO','採購單','PO',1,0),
          ('SH','SH','iSM','receipt','GR','進貨單','GR',1,0),
          ('SH','SH','iSM','purchase_return','PR','採購退貨／折讓單','PR',1,0)`);
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
      const accessFeatures = ['sales-document-types','sales-quotations','sales-orders','sales-order-changes','sales-shipments','sales-returns','sales-progress','sales-open-orders','access-control', 'basicdata', 'warehouses', 'departments', 'employees', 'source-customers', 'source-suppliers', 'inventory-opening', 'inventory-document-types', 'inventory-transactions', 'inventory-transfers', 'inventory-temporary', 'inventory-stocktake', 'inventory-posting', 'inventory-new-ledger', 'inventory-new-balance', 'inventory-detail', 'inventory-ledger', 'inventory-balance', 'inventory-movement-stats', 'department-movement-stats', 'procurement-document-types', 'requisition-entry', 'requisition-maintenance', 'purchase-order-entry', 'purchase-order-changes', 'receipt-entry', 'receipt-inspection', 'purchase-returns', 'purchase-progress', 'open-purchase-orders', 'purchase-receipts'];
      const [[admin]] = await pool.query("SELECT id FROM access_roles WHERE role_code='ADMIN'");
      for (const feature of accessFeatures) {
        await pool.query(`INSERT IGNORE INTO access_role_permissions
          (role_id, feature_code, can_view, can_create, can_update, can_delete, can_approve)
          VALUES (?, ?, 1, 1, 1, 1, 1)`, [admin.id, feature]);
      }
      const initialRoleFeatures = {
        REQUESTER: ['basicdata', 'requisition-entry'],
        PURCHASER: ['basicdata', 'requisition-entry', 'requisition-maintenance', 'purchase-order-entry', 'purchase-order-changes', 'purchase-returns', 'purchase-progress', 'open-purchase-orders', 'purchase-receipts'],
        WAREHOUSE: ['inventory-opening', 'inventory-document-types', 'inventory-transactions', 'inventory-transfers', 'inventory-temporary', 'inventory-stocktake', 'inventory-posting', 'inventory-new-ledger', 'inventory-new-balance', 'inventory-detail', 'inventory-ledger', 'inventory-balance', 'receipt-entry', 'receipt-inspection', 'purchase-returns', 'purchase-progress', 'open-purchase-orders', 'purchase-receipts'],
        FINANCE: ['basicdata', 'purchase-receipts'],
        VIEWER: ['basicdata', 'inventory-detail', 'inventory-ledger', 'inventory-balance', 'purchase-receipts']
      };
      for (const [roleCode, features] of Object.entries(initialRoleFeatures)) {
        const [[role]] = await pool.query('SELECT id FROM access_roles WHERE role_code=?', [roleCode]);
        for (const feature of features) {
          await pool.query(`INSERT IGNORE INTO access_role_permissions
            (role_id, feature_code, can_view, can_create, can_update, can_delete, can_approve)
            VALUES (?, ?, 1, ?, ?, 0, ?)`, [role.id, feature, Number(feature.includes('entry')), Number(feature.includes('entry')), Number(feature === 'purchase-order-entry')]);
        }
      }
      const elevatedRoleFeatures = {
        PURCHASER: ['requisition-maintenance', 'purchase-order-changes', 'purchase-returns'],
        WAREHOUSE: ['receipt-inspection', 'purchase-returns', 'inventory-transactions', 'inventory-transfers', 'inventory-temporary', 'inventory-stocktake', 'inventory-posting']
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
      await pool.query(`CREATE TABLE IF NOT EXISTS access_sessions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        token_hash CHAR(64) NOT NULL UNIQUE,
        expires_at DATETIME NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_access_session_user FOREIGN KEY (user_id) REFERENCES access_users(id) ON DELETE CASCADE,
        KEY ix_access_session_expiry (expires_at)
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
