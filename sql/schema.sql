SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS erp_data_sources (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO erp_data_sources (source_key, label, adapter_code, database_name, username, read_only, sort_order)
VALUES
  ('SH', 'SH（鼎新營運資料）', 'ism-sh', 'sh', 'root', 1, 10)
ON DUPLICATE KEY UPDATE label = VALUES(label), adapter_code = VALUES(adapter_code);

UPDATE erp_data_sources SET tenant_id = source_key, company_id = source_key, source_system = 'iSM';

CREATE TABLE IF NOT EXISTS erp_master_source_mappings (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS erp_companies (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(60) NOT NULL DEFAULT 'SH', company_id VARCHAR(60) NOT NULL DEFAULT 'SH', source_system VARCHAR(60) NOT NULL DEFAULT 'iSM',
  company_code VARCHAR(30) NOT NULL, short_name VARCHAR(60) NULL, company_name VARCHAR(160) NOT NULL,
  address VARCHAR(255) NULL, phone VARCHAR(40) NULL, tax_id VARCHAR(30) NULL,
  source_database VARCHAR(60) NOT NULL, source_table VARCHAR(60) NULL, source_key VARCHAR(160) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_erp_company_context (tenant_id, company_id, source_system, company_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS erp_code_rules (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(60) NOT NULL DEFAULT 'SH', company_id VARCHAR(60) NOT NULL DEFAULT 'SH', source_system VARCHAR(60) NOT NULL DEFAULT 'iSM',
  rule_type VARCHAR(20) NOT NULL, rule_value VARCHAR(120) NULL, rule_code VARCHAR(30) NULL, default_name VARCHAR(120) NULL,
  source_database VARCHAR(60) NOT NULL, source_table VARCHAR(60) NULL, source_key VARCHAR(160) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_erp_code_rule_context (tenant_id, company_id, source_system, rule_type, rule_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS erp_common_parameters (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(60) NOT NULL DEFAULT 'SH', company_id VARCHAR(60) NOT NULL DEFAULT 'SH', source_system VARCHAR(60) NOT NULL DEFAULT 'iSM',
  parameter_code VARCHAR(30) NOT NULL, parameter_value TEXT NULL, data_type VARCHAR(20) NULL, source_field VARCHAR(30) NOT NULL,
  source_database VARCHAR(60) NOT NULL, source_table VARCHAR(60) NULL, source_key VARCHAR(160) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_erp_common_parameter_context (tenant_id, company_id, source_system, parameter_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS erp_customers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
  customer_code VARCHAR(30) NOT NULL, short_name VARCHAR(30) NULL, customer_name VARCHAR(160) NOT NULL,
  responsible_person VARCHAR(80) NULL, contact_name VARCHAR(80) NULL, phone VARCHAR(40) NULL, fax VARCHAR(40) NULL,
  email VARCHAR(120) NULL, mobile VARCHAR(40) NULL, tax_id VARCHAR(30) NULL, currency_code VARCHAR(10) NULL,
  payment_term_code VARCHAR(30) NULL, payment_term_source_value VARCHAR(80) NULL,
  invoice_type VARCHAR(10) NULL, tax_type VARCHAR(10) NULL, closing_day VARCHAR(10) NULL,
  source_database VARCHAR(60) NOT NULL, source_table VARCHAR(60) NULL, source_key VARCHAR(160) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_erp_customer_tenant_company (tenant_id, company_id, source_system, customer_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS erp_suppliers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
  supplier_code VARCHAR(30) NOT NULL, short_name VARCHAR(30) NULL, supplier_name VARCHAR(160) NOT NULL,
  supplier_class VARCHAR(30) NULL, responsible_person VARCHAR(80) NULL, contact_name VARCHAR(80) NULL,
  phone VARCHAR(40) NULL, fax VARCHAR(40) NULL, email VARCHAR(120) NULL, mobile VARCHAR(40) NULL, tax_id VARCHAR(30) NULL,
  currency_code VARCHAR(10) NULL, payment_method VARCHAR(10) NULL, payment_term_code VARCHAR(30) NULL,
  payment_term_source_value VARCHAR(80) NULL, invoice_type VARCHAR(10) NULL, tax_type VARCHAR(10) NULL,
  closing_month_offset VARCHAR(10) NULL, closing_day VARCHAR(10) NULL,
  source_database VARCHAR(60) NOT NULL, source_table VARCHAR(60) NULL, source_key VARCHAR(160) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_erp_supplier_tenant_company (tenant_id, company_id, source_system, supplier_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS erp_item_categories (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(60) NOT NULL DEFAULT 'SH', company_id VARCHAR(60) NOT NULL DEFAULT 'SH', source_system VARCHAR(60) NOT NULL DEFAULT 'iSM',
  category_type VARCHAR(10) NOT NULL, category_code VARCHAR(30) NOT NULL, category_name VARCHAR(120) NOT NULL,
  source_database VARCHAR(60) NOT NULL, source_table VARCHAR(60) NULL, source_key VARCHAR(160) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_erp_item_category_context (tenant_id, company_id, source_system, category_type, category_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS erp_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(60) NOT NULL DEFAULT 'SH', company_id VARCHAR(60) NOT NULL DEFAULT 'SH', source_system VARCHAR(60) NOT NULL DEFAULT 'iSM',
  item_code VARCHAR(40) NOT NULL, item_name VARCHAR(160) NOT NULL, specification VARCHAR(160) NULL, unit VARCHAR(20) NULL,
  category_1 VARCHAR(30) NULL, category_2 VARCHAR(30) NULL, category_3 VARCHAR(30) NULL,
  source_database VARCHAR(60) NOT NULL, source_table VARCHAR(60) NULL, source_key VARCHAR(160) NULL, raw_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_erp_item_context (tenant_id, company_id, source_system, item_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- COPMB.MB002 is the legacy ERP item code used for customer pricing.  The
-- legacy SH/SC source does not have an independent customer-facing item code;
-- this target-only table is created only after approval for the new structure.
CREATE TABLE IF NOT EXISTS erp_customer_item_mappings (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS erp_customer_item_mapping_events (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS erp_job_categories (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
  job_code VARCHAR(30) NOT NULL, job_category VARCHAR(10) NULL, job_name VARCHAR(120) NULL, note VARCHAR(255) NULL,
  source_database VARCHAR(60) NOT NULL, source_table VARCHAR(60) NULL, source_key VARCHAR(160) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_erp_job_category_context (tenant_id, company_id, source_system, job_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS erp_job_category_employees (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
  assignment_code VARCHAR(80) NOT NULL, job_code VARCHAR(30) NOT NULL, employee_code VARCHAR(30) NOT NULL,
  assignment_type VARCHAR(10) NULL, assignment_name VARCHAR(120) NULL, note VARCHAR(255) NULL,
  source_database VARCHAR(60) NOT NULL, source_table VARCHAR(60) NULL, source_key VARCHAR(160) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_erp_job_employee_context (tenant_id, company_id, source_system, job_code, employee_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS erp_currencies (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
  currency_code VARCHAR(10) NOT NULL, currency_name VARCHAR(120) NOT NULL,
  unit_price_digits TINYINT UNSIGNED NULL, amount_digits TINYINT UNSIGNED NULL, unit_cost_digits TINYINT UNSIGNED NULL, cost_amount_digits TINYINT UNSIGNED NULL, note VARCHAR(255) NULL,
  source_database VARCHAR(60) NOT NULL, source_table VARCHAR(60) NULL, source_key VARCHAR(160) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_erp_currency_context (tenant_id, company_id, source_system, currency_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS erp_currency_rates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
  rate_code VARCHAR(40) NOT NULL, currency_code VARCHAR(10) NOT NULL, effective_date CHAR(8) NOT NULL,
  bank_buy_rate DECIMAL(18,6) NULL, bank_sell_rate DECIMAL(18,6) NULL, customs_buy_rate DECIMAL(18,6) NULL, customs_sell_rate DECIMAL(18,6) NULL,
  source_database VARCHAR(60) NOT NULL, source_table VARCHAR(60) NULL, source_key VARCHAR(160) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_erp_currency_rate_context (tenant_id, company_id, source_system, currency_code, effective_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS erp_payment_terms (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
  term_type VARCHAR(10) NOT NULL, term_code VARCHAR(30) NOT NULL, term_name VARCHAR(120) NOT NULL,
  due_rule_type VARCHAR(10) NULL, due_offset DECIMAL(10,2) NULL, due_base_type VARCHAR(10) NULL, due_base_day VARCHAR(10) NULL,
  realization_rule_type VARCHAR(10) NULL, realization_offset DECIMAL(10,2) NULL, realization_base_type VARCHAR(10) NULL, realization_base_day VARCHAR(10) NULL,
  is_enabled VARCHAR(5) NULL, due_months DECIMAL(10,2) NULL, due_day DECIMAL(10,2) NULL, realization_months DECIMAL(10,2) NULL, realization_day DECIMAL(10,2) NULL, note VARCHAR(255) NULL,
  source_database VARCHAR(60) NOT NULL, source_table VARCHAR(60) NULL, source_key VARCHAR(160) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_erp_payment_term_context (tenant_id, company_id, source_system, term_type, term_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS erp_calendars (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
  calendar_code VARCHAR(60) NOT NULL, industry_type VARCHAR(10) NOT NULL, calendar_year CHAR(4) NOT NULL, shift_code VARCHAR(20) NOT NULL,
  shift_name VARCHAR(120) NULL, note VARCHAR(255) NULL,
  source_database VARCHAR(60) NOT NULL, source_table VARCHAR(60) NULL, source_key VARCHAR(160) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_erp_calendar_context (tenant_id, company_id, source_system, industry_type, calendar_year, shift_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS erp_calendar_days (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
  calendar_day_code VARCHAR(80) NOT NULL, calendar_code VARCHAR(60) NOT NULL, industry_type VARCHAR(10) NOT NULL,
  calendar_year CHAR(4) NOT NULL, shift_code VARCHAR(20) NOT NULL, work_date CHAR(8) NOT NULL,
  day_type VARCHAR(10) NULL, work_hours DECIMAL(10,2) NULL, note VARCHAR(255) NULL, closed_flag VARCHAR(5) NULL,
  source_database VARCHAR(60) NOT NULL, source_table VARCHAR(60) NULL, source_key VARCHAR(160) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_erp_calendar_day_context (tenant_id, company_id, source_system, industry_type, calendar_year, shift_code, work_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS erp_inventory_opening_batches (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  opening_no VARCHAR(60) NOT NULL,
  tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
  source_database VARCHAR(60) NOT NULL, source_table VARCHAR(60) NOT NULL DEFAULT 'invmc', opening_date CHAR(8) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'draft', source_rows INT UNSIGNED NOT NULL DEFAULT 0, imported_rows INT UNSIGNED NOT NULL DEFAULT 0,
  error_rows INT UNSIGNED NOT NULL DEFAULT 0, warning_rows INT UNSIGNED NOT NULL DEFAULT 0,
  total_quantity DECIMAL(24,3) NOT NULL DEFAULT 0, total_amount DECIMAL(24,6) NOT NULL DEFAULT 0,
  import_batch_id BIGINT UNSIGNED NULL, note VARCHAR(500) NULL,
  created_by BIGINT UNSIGNED NULL, validated_by BIGINT UNSIGNED NULL, validated_at DATETIME NULL,
  approved_by BIGINT UNSIGNED NULL, approved_at DATETIME NULL, posted_by BIGINT UNSIGNED NULL, posted_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_erp_inventory_opening_no (tenant_id, company_id, source_system, opening_no),
  KEY ix_erp_inventory_opening_status (tenant_id, company_id, source_system, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS erp_inventory_opening_lines (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  batch_id BIGINT UNSIGNED NOT NULL, line_no INT UNSIGNED NOT NULL,
  item_code VARCHAR(40) NOT NULL, item_name VARCHAR(160) NULL, specification VARCHAR(160) NULL, unit VARCHAR(20) NULL,
  warehouse_code VARCHAR(30) NOT NULL, warehouse_name VARCHAR(120) NULL, location_code VARCHAR(30) NULL,
  quantity DECIMAL(24,3) NOT NULL DEFAULT 0, unit_cost DECIMAL(24,6) NOT NULL DEFAULT 0, amount DECIMAL(24,6) NOT NULL DEFAULT 0,
  validation_status VARCHAR(20) NOT NULL DEFAULT 'ok', validation_message VARCHAR(500) NULL, note VARCHAR(255) NULL,
  source_table VARCHAR(60) NOT NULL DEFAULT 'invmc', source_key VARCHAR(160) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_erp_inventory_opening_line (batch_id, line_no), UNIQUE KEY uq_erp_inventory_opening_source (batch_id, source_key),
  KEY ix_erp_inventory_opening_item (batch_id, item_code, warehouse_code),
  CONSTRAINT fk_erp_inventory_opening_line_batch FOREIGN KEY (batch_id) REFERENCES erp_inventory_opening_batches(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS erp_inventory_balances (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(60) NOT NULL, company_id VARCHAR(60) NOT NULL, source_system VARCHAR(60) NOT NULL,
  item_code VARCHAR(40) NOT NULL, warehouse_code VARCHAR(30) NOT NULL, location_code VARCHAR(30) NOT NULL DEFAULT '',
  quantity_on_hand DECIMAL(24,3) NOT NULL DEFAULT 0, unit_cost DECIMAL(24,6) NOT NULL DEFAULT 0,
  inventory_amount DECIMAL(24,6) NOT NULL DEFAULT 0, opening_batch_id BIGINT UNSIGNED NULL, last_movement_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_erp_inventory_balance (tenant_id, company_id, source_system, item_code, warehouse_code, location_code),
  KEY ix_erp_inventory_balance_warehouse (tenant_id, company_id, warehouse_code, item_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS erp_import_batches (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS erp_import_reconciliations (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS erp_import_errors (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS erp_import_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  batch_id BIGINT UNSIGNED NOT NULL,
  level VARCHAR(20) NOT NULL DEFAULT 'info',
  message VARCHAR(1000) NOT NULL,
  details_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_erp_import_logs_batch (batch_id, created_at),
  CONSTRAINT fk_erp_import_logs_batch FOREIGN KEY (batch_id) REFERENCES erp_import_batches(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Import quality findings belong to the application/control database.  They
-- preserve the source key and target reference while keeping SH/SC read-only.
CREATE TABLE IF NOT EXISTS erp_import_quality_issues (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS erp_import_quality_events (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS customers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(30) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  tax_id VARCHAR(20) NULL,
  contact_name VARCHAR(80) NULL,
  phone VARCHAR(40) NULL,
  email VARCHAR(120) NULL,
  address VARCHAR(255) NULL,
  credit_limit DECIMAL(18,2) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS suppliers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(30) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  tax_id VARCHAR(20) NULL,
  contact_name VARCHAR(80) NULL,
  phone VARCHAR(40) NULL,
  email VARCHAR(120) NULL,
  address VARCHAR(255) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS products (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  sku VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  spec VARCHAR(255) NULL,
  unit VARCHAR(20) NOT NULL DEFAULT 'PCS',
  standard_cost DECIMAL(18,4) NOT NULL DEFAULT 0,
  sale_price DECIMAL(18,4) NOT NULL DEFAULT 0,
  safety_stock DECIMAL(18,4) NOT NULL DEFAULT 0,
  is_lot_tracked TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS warehouses (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(30) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inventory_stock (
  product_id BIGINT UNSIGNED NOT NULL,
  warehouse_id BIGINT UNSIGNED NOT NULL,
  lot_no VARCHAR(80) NOT NULL DEFAULT '',
  qty_on_hand DECIMAL(18,4) NOT NULL DEFAULT 0,
  qty_reserved DECIMAL(18,4) NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (product_id, warehouse_id, lot_no),
  CONSTRAINT fk_stock_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_stock_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inventory_moves (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  move_type ENUM('purchase_receipt','sales_shipment','adjustment') NOT NULL,
  ref_table VARCHAR(40) NULL,
  ref_id BIGINT UNSIGNED NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  warehouse_id BIGINT UNSIGNED NOT NULL,
  lot_no VARCHAR(80) NOT NULL DEFAULT '',
  qty_delta DECIMAL(18,4) NOT NULL,
  unit_cost DECIMAL(18,4) NOT NULL DEFAULT 0,
  moved_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  note VARCHAR(255) NULL,
  CONSTRAINT fk_move_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_move_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  INDEX idx_moves_product_date (product_id, moved_at),
  INDEX idx_moves_ref (ref_table, ref_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS purchase_orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_no VARCHAR(30) NOT NULL UNIQUE,
  supplier_id BIGINT UNSIGNED NOT NULL,
  order_date DATE NOT NULL,
  expected_date DATE NULL,
  status ENUM('draft','confirmed','partial_received','received','closed','cancelled') NOT NULL DEFAULT 'draft',
  note VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_po_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  purchase_order_id BIGINT UNSIGNED NOT NULL,
  line_no INT NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  qty_ordered DECIMAL(18,4) NOT NULL,
  qty_received DECIMAL(18,4) NOT NULL DEFAULT 0,
  unit_price DECIMAL(18,4) NOT NULL DEFAULT 0,
  note VARCHAR(255) NULL,
  UNIQUE KEY uq_po_line (purchase_order_id, line_no),
  CONSTRAINT fk_poi_po FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_poi_product FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS purchase_receipts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  receipt_no VARCHAR(30) NOT NULL UNIQUE,
  purchase_order_id BIGINT UNSIGNED NULL,
  supplier_id BIGINT UNSIGNED NOT NULL,
  warehouse_id BIGINT UNSIGNED NOT NULL,
  receipt_date DATE NOT NULL,
  status ENUM('posted','voided') NOT NULL DEFAULT 'posted',
  note VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pr_po FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id),
  CONSTRAINT fk_pr_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  CONSTRAINT fk_pr_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS purchase_receipt_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  purchase_receipt_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  lot_no VARCHAR(80) NOT NULL DEFAULT '',
  qty_received DECIMAL(18,4) NOT NULL,
  unit_cost DECIMAL(18,4) NOT NULL DEFAULT 0,
  CONSTRAINT fk_pri_pr FOREIGN KEY (purchase_receipt_id) REFERENCES purchase_receipts(id) ON DELETE CASCADE,
  CONSTRAINT fk_pri_product FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sales_orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_no VARCHAR(30) NOT NULL UNIQUE,
  customer_id BIGINT UNSIGNED NOT NULL,
  order_date DATE NOT NULL,
  required_date DATE NULL,
  status ENUM('draft','confirmed','partial_shipped','shipped','closed','cancelled') NOT NULL DEFAULT 'draft',
  note VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_so_customer FOREIGN KEY (customer_id) REFERENCES customers(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sales_order_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  sales_order_id BIGINT UNSIGNED NOT NULL,
  line_no INT NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  qty_ordered DECIMAL(18,4) NOT NULL,
  qty_shipped DECIMAL(18,4) NOT NULL DEFAULT 0,
  unit_price DECIMAL(18,4) NOT NULL DEFAULT 0,
  note VARCHAR(255) NULL,
  UNIQUE KEY uq_so_line (sales_order_id, line_no),
  CONSTRAINT fk_soi_so FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_soi_product FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sales_shipments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shipment_no VARCHAR(30) NOT NULL UNIQUE,
  sales_order_id BIGINT UNSIGNED NULL,
  customer_id BIGINT UNSIGNED NOT NULL,
  warehouse_id BIGINT UNSIGNED NOT NULL,
  shipment_date DATE NOT NULL,
  status ENUM('posted','voided') NOT NULL DEFAULT 'posted',
  note VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ss_so FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id),
  CONSTRAINT fk_ss_customer FOREIGN KEY (customer_id) REFERENCES customers(id),
  CONSTRAINT fk_ss_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sales_shipment_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  sales_shipment_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  lot_no VARCHAR(80) NOT NULL DEFAULT '',
  qty_shipped DECIMAL(18,4) NOT NULL,
  unit_price DECIMAL(18,4) NOT NULL DEFAULT 0,
  CONSTRAINT fk_ssi_ss FOREIGN KEY (sales_shipment_id) REFERENCES sales_shipments(id) ON DELETE CASCADE,
  CONSTRAINT fk_ssi_product FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor VARCHAR(80) NOT NULL DEFAULT 'system',
  action VARCHAR(40) NOT NULL,
  entity_type VARCHAR(60) NOT NULL,
  entity_id BIGINT UNSIGNED NULL,
  payload JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_entity (entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO warehouses (code, name)
VALUES ('MAIN', '主倉')
ON DUPLICATE KEY UPDATE name = VALUES(name);
