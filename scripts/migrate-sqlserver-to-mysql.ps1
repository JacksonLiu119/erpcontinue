param(
    [string]$SqlServerInstance = 'JACKSON',
    [string]$SqlDatabase = 'SMARTDSCSYS',
    [string]$SqlUser = 'sa',
    [string]$MySqlExe = 'C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe',
    [string]$MySqlHost = '127.0.0.1',
    [int]$MySqlPort = 3306,
    [string]$MySqlDatabase = 'smartdscsys',
    [string]$MySqlUser = 'root',
    [switch]$RecreateTarget,
    [switch]$UseIntegratedSecurity
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8

function Quote-MySqlName([string]$Name) {
    return ('`' + $Name.Replace('`', '``') + '`')
}

function Get-MySqlType($Column) {
    $type = [string]$Column.DATA_TYPE
    $length = if ($null -eq $Column.CHARACTER_MAXIMUM_LENGTH -or $Column.CHARACTER_MAXIMUM_LENGTH -is [DBNull]) { 0 } else { [int]$Column.CHARACTER_MAXIMUM_LENGTH }
    $precision = if ($null -eq $Column.NUMERIC_PRECISION -or $Column.NUMERIC_PRECISION -is [DBNull]) { 0 } else { [int]$Column.NUMERIC_PRECISION }
    $scale = if ($null -eq $Column.NUMERIC_SCALE -or $Column.NUMERIC_SCALE -is [DBNull]) { 0 } else { [int]$Column.NUMERIC_SCALE }
    switch ($type.ToLowerInvariant()) {
        'bigint' { return 'BIGINT' }
        'int' { return 'INT' }
        'smallint' { return 'SMALLINT' }
        'tinyint' { return 'TINYINT' }
        'bit' { return 'TINYINT(1)' }
        'decimal' { return ('DECIMAL({0},{1})' -f $precision, $scale) }
        'numeric' { return ('DECIMAL({0},{1})' -f $precision, $scale) }
        'money' { return 'DECIMAL(19,4)' }
        'smallmoney' { return 'DECIMAL(10,4)' }
        'float' { return 'DOUBLE' }
        'real' { return 'FLOAT' }
        'date' { return 'DATE' }
        'datetime' { return 'DATETIME' }
        'datetime2' { return 'DATETIME' }
        'smalldatetime' { return 'DATETIME' }
        'time' { return 'TIME' }
        'char' { if ($length -eq -1) { return 'LONGTEXT' }; return ('CHAR({0})' -f $length) }
        'nchar' { if ($length -eq -1) { return 'LONGTEXT' }; return ('CHAR({0})' -f $length) }
        'varchar' { if ($length -eq -1) { return 'LONGTEXT' }; return ('VARCHAR({0})' -f $length) }
        'nvarchar' { if ($length -eq -1) { return 'LONGTEXT' }; return ('VARCHAR({0})' -f $length) }
        'text' { return 'LONGTEXT' }
        'ntext' { return 'LONGTEXT' }
        'uniqueidentifier' { return 'CHAR(36)' }
        'hierarchyid' { return 'LONGTEXT' }
        'xml' { return 'LONGTEXT' }
        'geography' { return 'LONGTEXT' }
        'geometry' { return 'LONGTEXT' }
        'sql_variant' { return 'LONGTEXT' }
        'rowversion' { return 'LONGTEXT' }
        'timestamp' { return 'LONGTEXT' }
        'binary' { return ('BINARY({0})' -f $length) }
        'varbinary' { if ($length -eq -1) { return 'LONGBLOB' }; return ('VARBINARY({0})' -f $length) }
        'image' { return 'LONGBLOB' }
        default { return 'TEXT' }
    }
}

function Invoke-SqlTable($Connection, [string]$Sql) {
    $command = $Connection.CreateCommand()
    $command.CommandTimeout = 0
    $command.CommandText = $Sql
    $reader = $command.ExecuteReader()
    try {
        $table = New-Object System.Data.DataTable
        $table.Load($reader)
        return ,$table
    }
    finally {
        $reader.Close()
    }
}

function Invoke-MySqlFile([string]$File, [string]$Password) {
    $arguments = @(
        "--host=$MySqlHost",
        "--port=$MySqlPort",
        "--user=$MySqlUser",
        "--password=$Password",
        '--default-character-set=utf8mb4',
        '--local-infile=1'
    )
    $sql = [System.IO.File]::ReadAllText($File)
    $sql | & $MySqlExe @arguments
    if ($LASTEXITCODE -ne 0) { throw "mysql.exe failed while running $File" }
}

if (-not (Test-Path -LiteralPath $MySqlExe)) { throw "mysql.exe not found: $MySqlExe" }

$sqlCredential = if ($UseIntegratedSecurity -or $env:SQLSERVER_PASSWORD) { $null } else { Get-Credential -UserName $SqlUser -Message "SQL Server password" }
$mysqlCredential = if ($env:MYSQL_PASSWORD) { $null } else { Get-Credential -UserName $MySqlUser -Message "MySQL password" }
$sqlPassword = if ($UseIntegratedSecurity) { '' } elseif ($env:SQLSERVER_PASSWORD) { $env:SQLSERVER_PASSWORD } else { $sqlCredential.GetNetworkCredential().Password }
$mysqlPassword = if ($env:MYSQL_PASSWORD) { $env:MYSQL_PASSWORD } else { $mysqlCredential.GetNetworkCredential().Password }

$workDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Split-Path -Parent $workDir
$exportDir = Join-Path (Join-Path $projectDir 'output') ('migration_{0}' -f $SqlDatabase)
New-Item -ItemType Directory -Force -Path $exportDir | Out-Null

$connectionString = if ($UseIntegratedSecurity) {
    'Server={0};Database={1};Integrated Security=True;Encrypt=False;TrustServerCertificate=True' -f $SqlServerInstance, $SqlDatabase
} else {
    'Server={0};Database={1};User ID={2};Password={3};Encrypt=False;TrustServerCertificate=True' -f $SqlServerInstance, $SqlDatabase, $SqlUser, $sqlPassword
}
$sqlConnection = New-Object System.Data.SqlClient.SqlConnection $connectionString
$sqlConnection.Open()

try {
    $tablesSql = @(
        'SELECT TABLE_SCHEMA, TABLE_NAME',
        'FROM INFORMATION_SCHEMA.TABLES',
        "WHERE TABLE_TYPE = 'BASE TABLE'",
        'ORDER BY TABLE_SCHEMA, TABLE_NAME'
    ) -join [Environment]::NewLine
    $tables = Invoke-SqlTable $sqlConnection $tablesSql
    if ($tables.Rows.Count -eq 0) { throw "No base tables found in $SqlDatabase" }

    $schemaLines = New-Object System.Collections.Generic.List[string]
    $loadLines = New-Object System.Collections.Generic.List[string]
    $verifyLines = New-Object System.Collections.Generic.List[string]
    $mysqlDbName = Quote-MySqlName $MySqlDatabase
    if ($RecreateTarget) { $schemaLines.Add(('DROP DATABASE IF EXISTS {0};' -f $mysqlDbName)) }
    $schemaLines.Add(('CREATE DATABASE IF NOT EXISTS {0} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;' -f $mysqlDbName))
    $schemaLines.Add(('USE {0};' -f $mysqlDbName))
    $loadLines.Add(('USE {0};' -f $mysqlDbName))
    $verifyLines.Add(('USE {0};' -f $mysqlDbName))

    foreach ($tableRow in $tables.Rows) {
        $schema = [string]$tableRow.TABLE_SCHEMA
        $table = [string]$tableRow.TABLE_NAME
        $targetTable = $table
        if ($schema -ne 'dbo') { $targetTable = '{0}_{1}' -f $schema, $table }
        $mysqlTableName = Quote-MySqlName $targetTable
        Write-Host ('Exporting {0}.{1} -> {2}' -f $schema, $table, $targetTable)

        $safeSchema = $schema.Replace("'", "''")
        $safeTable = $table.Replace("'", "''")
        $columnsSql = @(
            'SELECT c.COLUMN_NAME, c.IS_NULLABLE, c.DATA_TYPE,',
            '       c.CHARACTER_MAXIMUM_LENGTH, c.NUMERIC_PRECISION, c.NUMERIC_SCALE,',
            "       COLUMNPROPERTY(OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)), c.COLUMN_NAME, 'IsIdentity') AS IS_IDENTITY",
            'FROM INFORMATION_SCHEMA.COLUMNS c',
            "WHERE c.TABLE_SCHEMA = '$safeSchema' AND c.TABLE_NAME = '$safeTable'",
            'ORDER BY c.ORDINAL_POSITION'
        ) -join [Environment]::NewLine
        $columns = Invoke-SqlTable $sqlConnection $columnsSql

        $pkSql = @(
            'SELECT k.COLUMN_NAME',
            'FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc',
            'JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k ON tc.CONSTRAINT_NAME = k.CONSTRAINT_NAME',
            ' AND tc.TABLE_SCHEMA = k.TABLE_SCHEMA AND tc.TABLE_NAME = k.TABLE_NAME',
            "WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'",
            " AND tc.TABLE_SCHEMA = '$safeSchema' AND tc.TABLE_NAME = '$safeTable'",
            'ORDER BY k.ORDINAL_POSITION'
        ) -join [Environment]::NewLine
        $pk = Invoke-SqlTable $sqlConnection $pkSql

        $schemaLines.Add(('DROP TABLE IF EXISTS {0};' -f $mysqlTableName))
        $schemaLines.Add(('CREATE TABLE {0} (' -f $mysqlTableName))
        $definitions = New-Object System.Collections.Generic.List[string]
        $firstPrimaryKeyColumn = $null
        if ($pk.Rows.Count -gt 0) {
            $firstPrimaryKeyColumn = [string]$pk.Rows[0].COLUMN_NAME
        }
        foreach ($column in $columns.Rows) {
            $columnName = Quote-MySqlName ([string]$column.COLUMN_NAME)
            $definition = '  {0} {1}' -f $columnName, (Get-MySqlType $column)
            if ([string]$column.IS_NULLABLE -eq 'NO') { $definition += ' NOT NULL' }
            if ([int]$column.IS_IDENTITY -eq 1 -and [string]$column.COLUMN_NAME -eq $firstPrimaryKeyColumn) {
                $definition += ' AUTO_INCREMENT'
            }
            $definitions.Add($definition)
        }
        if ($pk.Rows.Count -gt 0) {
            $pkColumns = @($pk.Rows | ForEach-Object { Quote-MySqlName ([string]$_.COLUMN_NAME) }) -join ', '
            $definitions.Add(('  PRIMARY KEY ({0})' -f $pkColumns))
        }
        $schemaLines.Add(($definitions -join (',' + [Environment]::NewLine)))
        $schemaLines.Add(') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;')

        $dataExpressions = New-Object System.Collections.Generic.List[string]
        foreach ($column in $columns.Rows) {
            $columnName = [string]$column.COLUMN_NAME
            $quotedColumn = '[' + $columnName.Replace(']', ']]') + ']'
            $dataType = ([string]$column.DATA_TYPE).ToLowerInvariant()
            if ($dataType -eq 'hierarchyid') {
                $dataExpressions.Add(('{0}.ToString() AS {1}' -f $quotedColumn, $quotedColumn))
            }
            elseif ($dataType -in @('geography', 'geometry')) {
                $dataExpressions.Add(('{0}.STAsText() AS {1}' -f $quotedColumn, $quotedColumn))
            }
            elseif ($dataType -in @('xml', 'sql_variant')) {
                $dataExpressions.Add(('CONVERT(nvarchar(max), {0}) AS {0}' -f $quotedColumn))
            }
            elseif ($dataType -in @('rowversion', 'timestamp', 'image', 'binary', 'varbinary')) {
                $dataExpressions.Add(('CONVERT(varchar(max), CONVERT(varbinary(max), {0}), 1) AS {0}' -f $quotedColumn))
            }
            else {
                $dataExpressions.Add($quotedColumn)
            }
        }
        $selectList = $dataExpressions -join ', '
        $dataSql = 'SELECT {0} FROM [{1}].[{2}]' -f $selectList, $schema.Replace(']', ']]'), $table.Replace(']', ']]')
        $data = Invoke-SqlTable $sqlConnection $dataSql
        $csvPath = Join-Path $exportDir ('{0}.csv' -f $targetTable)
        $data | Export-Csv -LiteralPath $csvPath -NoTypeInformation -Encoding UTF8
        $csvForMySql = $csvPath.Replace('\', '/').Replace("'", "''")
        $sq = [char]39
        $dq = [char]34
        $loadStatement = 'LOAD DATA LOCAL INFILE ' + $sq + $csvForMySql + $sq + ' INTO TABLE ' + $mysqlTableName + ' CHARACTER SET utf8mb4 FIELDS TERMINATED BY ' + $sq + ',' + $sq + ' ENCLOSED BY ' + $sq + $dq + $sq + ' LINES TERMINATED BY ' + $sq + '\r\n' + $sq + ' IGNORE 1 LINES;'
        $loadLines.Add($loadStatement)
        $verifyLines.Add("SELECT '$targetTable' AS table_name, COUNT(*) AS mysql_count FROM $mysqlTableName;")
    }

    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines((Join-Path $exportDir '01_schema.sql'), $schemaLines, $utf8)
    [System.IO.File]::WriteAllLines((Join-Path $exportDir '02_load_data.sql'), $loadLines, $utf8)
    [System.IO.File]::WriteAllLines((Join-Path $exportDir '03_verify.sql'), $verifyLines, $utf8)

    Invoke-MySqlFile (Join-Path $exportDir '01_schema.sql') $mysqlPassword
    Invoke-MySqlFile (Join-Path $exportDir '02_load_data.sql') $mysqlPassword
    Invoke-MySqlFile (Join-Path $exportDir '03_verify.sql') $mysqlPassword
    Write-Host ('Migration completed. Output: {0}' -f $exportDir)
}
finally {
    $sqlConnection.Close()
}
