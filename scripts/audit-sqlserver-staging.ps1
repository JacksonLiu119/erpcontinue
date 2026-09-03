param(
    [string]$SqlServerInstance = 'JACKSON',
    [string]$SqlDatabase = 'stg_SC_20260819',
    [string]$SqlUser = 'sa',
    [string]$OutputDirectory = '',
    [switch]$UseIntegratedSecurity,
    [switch]$IncludeAllCompanyTables
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
    $OutputDirectory = Join-Path $PSScriptRoot ("..\tmp\sqlserver-audit\{0}_{1}" -f $SqlDatabase, $stamp)
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

function Quote-SqlIdentifier([string]$Value) {
    return '[' + $Value.Replace(']', ']]') + ']'
}

function Quote-SqlLiteral([string]$Value) {
    return "N'" + $Value.Replace("'", "''") + "'"
}

function Convert-DataTableToObjects($Table) {
    foreach ($row in $Table.Rows) {
        $record = [ordered]@{}
        foreach ($column in $Table.Columns) {
            $value = $row[$column.ColumnName]
            if ($value -is [System.DBNull]) { $value = $null }
            $record[$column.ColumnName] = $value
        }
        [pscustomobject]$record
    }
}

function Export-DataTable($Table, [string]$Path) {
    $objects = @(Convert-DataTableToObjects $Table)
    if ($objects.Count -gt 0) {
        $objects | Export-Csv -LiteralPath $Path -NoTypeInformation -Encoding UTF8
    }
    else {
        Set-Content -LiteralPath $Path -Value '' -Encoding UTF8
    }
    return $objects
}

function Invoke-Query($Connection, [string]$Sql) {
    $command = $Connection.CreateCommand()
    $command.CommandTimeout = 0
    $command.CommandText = $Sql
    $adapter = New-Object System.Data.SqlClient.SqlDataAdapter $command
    $table = New-Object System.Data.DataTable
    [void]$adapter.Fill($table)
    return $table
}

$builder = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
$builder['Data Source'] = $SqlServerInstance
$builder['Initial Catalog'] = $SqlDatabase
$builder['Encrypt'] = $false
$builder['TrustServerCertificate'] = $true
$builder['Connect Timeout'] = 30

if ($UseIntegratedSecurity) {
    $builder['Integrated Security'] = $true
}
else {
    Write-Host ''
    Write-Host 'SQL Server login is required. The password will not be saved.' -ForegroundColor Yellow
    $loginUser = Read-Host ("User name [{0}]" -f $SqlUser)
    if ([string]::IsNullOrWhiteSpace($loginUser)) { $loginUser = $SqlUser }
    $securePassword = Read-Host 'Password' -AsSecureString
    $credential = New-Object System.Management.Automation.PSCredential($loginUser, $securePassword)
    $builder['User ID'] = $credential.UserName
    $builder['Password'] = $credential.GetNetworkCredential().Password
}

$connection = New-Object System.Data.SqlClient.SqlConnection $builder.ConnectionString
$errors = New-Object System.Collections.Generic.List[string]
$startedAt = Get-Date

try {
    $connection.Open()

    $statusSql = @"
SELECT
    DB_NAME() AS database_name,
    DB_ID() AS database_id,
    d.state_desc,
    d.user_access_desc,
    d.recovery_model_desc,
    d.is_read_only,
    d.create_date,
    CAST(SUM(mf.size) * 8.0 / 1024 AS decimal(18,2)) AS size_mb
FROM sys.databases AS d
LEFT JOIN sys.master_files AS mf
    ON mf.database_id = d.database_id
WHERE d.name = $(Quote-SqlLiteral $SqlDatabase)
GROUP BY
    d.name,
    d.state_desc,
    d.user_access_desc,
    d.recovery_model_desc,
    d.is_read_only,
    d.create_date,
    d.database_id;
"@
    $status = Invoke-Query $connection $statusSql
    $statusObjects = Export-DataTable $status (Join-Path $OutputDirectory '01_database_status.csv')
    if ($status.Rows.Count -ne 1) { throw "找不到資料庫或無法讀取資料庫狀態：$SqlDatabase" }
    if ([int]$status.Rows[0].is_read_only -ne 1) {
        throw "安全停止：$SqlDatabase 不是唯讀資料庫，未繼續盤點。請先在 SSMS 設為 READ_ONLY。"
    }

    $tableSql = @"
SELECT
    s.name AS schema_name,
    t.name AS table_name,
    SUM(ps.row_count) AS row_count,
    CASE WHEN EXISTS (
        SELECT 1
        FROM sys.columns AS cc
        WHERE cc.object_id = t.object_id
          AND (
              UPPER(cc.name) LIKE '%COMPANY%'
              OR UPPER(cc.name) IN ('COMP', 'COMPANY_ID', 'COMPANY_CODE')
          )
    ) THEN 1 ELSE 0 END AS has_company_column
FROM sys.tables AS t
JOIN sys.schemas AS s
    ON s.schema_id = t.schema_id
JOIN sys.dm_db_partition_stats AS ps
    ON ps.object_id = t.object_id
   AND ps.index_id IN (0, 1)
WHERE t.is_ms_shipped = 0
GROUP BY s.name, t.name, t.object_id
ORDER BY row_count DESC, s.name, t.name;
"@
    $tables = Invoke-Query $connection $tableSql
    $tableObjects = Export-DataTable $tables (Join-Path $OutputDirectory '02_table_inventory.csv')

    $moduleSql = @"
SELECT
    CASE
        WHEN UPPER(t.name) LIKE 'AJST%' THEN 'AJST'
        WHEN UPPER(t.name) LIKE 'AJS%' THEN 'AJS'
        WHEN UPPER(t.name) LIKE 'CMS%' THEN 'CMS'
        WHEN UPPER(t.name) LIKE 'COP%' THEN 'COP'
        WHEN UPPER(t.name) LIKE 'PUR%' THEN 'PUR'
        WHEN UPPER(t.name) LIKE 'INV%' THEN 'INV'
        WHEN UPPER(t.name) LIKE 'ACR%' THEN 'ACR'
        WHEN UPPER(t.name) LIKE 'ACP%' THEN 'ACP'
        WHEN UPPER(t.name) LIKE 'ACT%' THEN 'ACT'
        WHEN UPPER(t.name) LIKE 'AST%' THEN 'AST'
    END AS module_prefix,
    s.name AS schema_name,
    t.name AS table_name,
    SUM(ps.row_count) AS row_count
FROM sys.tables AS t
JOIN sys.schemas AS s
    ON s.schema_id = t.schema_id
JOIN sys.dm_db_partition_stats AS ps
    ON ps.object_id = t.object_id
   AND ps.index_id IN (0, 1)
WHERE t.is_ms_shipped = 0
  AND (
       UPPER(t.name) LIKE 'CMS%'
    OR UPPER(t.name) LIKE 'COP%'
    OR UPPER(t.name) LIKE 'PUR%'
    OR UPPER(t.name) LIKE 'INV%'
    OR UPPER(t.name) LIKE 'ACR%'
    OR UPPER(t.name) LIKE 'ACP%'
    OR UPPER(t.name) LIKE 'ACT%'
    OR UPPER(t.name) LIKE 'AST%'
    OR UPPER(t.name) LIKE 'AJS%'
  )
GROUP BY s.name, t.name
ORDER BY module_prefix, t.name;
"@
    $modules = Invoke-Query $connection $moduleSql
    $moduleObjects = Export-DataTable $modules (Join-Path $OutputDirectory '03_module_tables.csv')

    $companyColumnsSql = @"
SELECT
    s.name AS schema_name,
    t.name AS table_name,
    c.name AS column_name,
    ty.name AS data_type,
    c.max_length,
    c.is_nullable
FROM sys.tables AS t
JOIN sys.schemas AS s
    ON s.schema_id = t.schema_id
JOIN sys.columns AS c
    ON c.object_id = t.object_id
JOIN sys.types AS ty
    ON ty.user_type_id = c.user_type_id
WHERE t.is_ms_shipped = 0
  AND (
       UPPER(c.name) LIKE '%COMPANY%'
    OR UPPER(c.name) IN ('COMP', 'COMPANY_ID', 'COMPANY_CODE')
  )
ORDER BY s.name, t.name, c.column_id;
"@
    $companyColumns = Invoke-Query $connection $companyColumnsSql
    $companyColumnObjects = Export-DataTable $companyColumns (Join-Path $OutputDirectory '04_company_columns.csv')

    $dateColumnsSql = @"
SELECT
    s.name AS schema_name,
    t.name AS table_name,
    c.name AS column_name,
    ty.name AS data_type,
    c.is_nullable
FROM sys.tables AS t
JOIN sys.schemas AS s
    ON s.schema_id = t.schema_id
JOIN sys.columns AS c
    ON c.object_id = t.object_id
JOIN sys.types AS ty
    ON ty.user_type_id = c.user_type_id
WHERE t.is_ms_shipped = 0
  AND (
       ty.name IN ('date', 'datetime', 'datetime2', 'smalldatetime', 'time', 'datetimeoffset')
    OR UPPER(c.name) LIKE '%DATE%'
    OR UPPER(c.name) LIKE '%CREATE%'
    OR UPPER(c.name) LIKE '%MODIFY%'
  )
ORDER BY s.name, t.name, c.column_id;
"@
    $dateColumns = Invoke-Query $connection $dateColumnsSql
    $dateColumnObjects = Export-DataTable $dateColumns (Join-Path $OutputDirectory '06_date_columns.csv')

    $companyTableRows = @($companyColumnObjects | Where-Object {
        $IncludeAllCompanyTables -or $_.table_name -match '^(CMS|COP|PUR|INV|ACR|ACP|ACT|AST|AJS)'
    })
    $companyDistribution = New-Object System.Collections.Generic.List[object]
    foreach ($tableRow in $companyTableRows) {
        $tableRef = (Quote-SqlIdentifier ([string]$tableRow.schema_name)) + '.' + (Quote-SqlIdentifier ([string]$tableRow.table_name))
        $columnRef = Quote-SqlIdentifier ([string]$tableRow.column_name)
        $tableLiteral = ([string]$tableRow.table_name).Replace("'", "''")
        $sql = "SELECT N'$tableLiteral' AS table_name, CONVERT(nvarchar(100), $columnRef) AS company_code, COUNT_BIG(*) AS row_count FROM $tableRef GROUP BY $columnRef;"
        try {
            $distribution = Invoke-Query $connection $sql
            foreach ($row in $distribution.Rows) {
                $companyDistribution.Add([pscustomobject]@{
                    schema_name = $tableRow.schema_name
                    table_name = $row.table_name
                    company_code = if ($row.company_code -is [System.DBNull]) { $null } else { ([string]$row.company_code).Trim() }
                    row_count = [long]$row.row_count
                })
            }
        }
        catch {
            $errors.Add(("公司分布查詢失敗 {0}: {1}" -f $tableRef, $_.Exception.Message))
        }
    }
    if ($companyDistribution.Count -gt 0) {
        $companyDistribution | Sort-Object table_name, company_code | Export-Csv -LiteralPath (Join-Path $OutputDirectory '05_company_distribution.csv') -NoTypeInformation -Encoding UTF8
    }
    else {
        Set-Content -LiteralPath (Join-Path $OutputDirectory '05_company_distribution.csv') -Value '' -Encoding UTF8
    }

    $finishedAt = Get-Date
    $summary = @"
SQL Server 暫存資料庫唯讀盤點報告
================================
執行時間：$startedAt - $finishedAt
SQL Server：$SqlServerInstance
資料庫：$SqlDatabase
資料表總數：$($tableObjects.Count)
模組資料表數：$($moduleObjects.Count)
COMPANY 欄位數：$($companyColumnObjects.Count)
公司分布資料列：$($companyDistribution.Count)
日期欄位數：$($dateColumnObjects.Count)

輸出檔案：
01_database_status.csv
02_table_inventory.csv
03_module_tables.csv
04_company_columns.csv
05_company_distribution.csv
06_date_columns.csv
audit-errors.txt

安全條件：本腳本只執行 SELECT／系統目錄查詢；資料庫必須先是 READ_ONLY，否則會停止。
"@
    Set-Content -LiteralPath (Join-Path $OutputDirectory 'audit-summary.txt') -Value $summary -Encoding UTF8
}
catch {
    $errors.Add($_.Exception.Message)
    throw
}
finally {
    if ($errors.Count -gt 0) {
        $errors | Set-Content -LiteralPath (Join-Path $OutputDirectory 'audit-errors.txt') -Encoding UTF8
    }
    else {
        Set-Content -LiteralPath (Join-Path $OutputDirectory 'audit-errors.txt') -Value '無錯誤' -Encoding UTF8
    }
    if ($connection.State -ne [System.Data.ConnectionState]::Closed) { $connection.Close() }
}

Write-Host ("盤點完成，報告位於：{0}" -f $OutputDirectory)
