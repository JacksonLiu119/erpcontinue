param(
    [string]$SqlServerInstance = 'JACKSON',
    [string]$SqlDatabase = 'stg_SC_20260819',
    [string]$MySqlDatabase = 'raw_sc_20260819',
    [string]$MySqlExe = 'C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe',
    [string]$MySqlUser = 'root',
    [string]$ReportPath = ''
)

$ErrorActionPreference = 'Stop'
if (-not $env:MYSQL_PASSWORD) { throw 'MYSQL_PASSWORD is required.' }
if (-not $ReportPath) {
    $ReportPath = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'output\migration_stg_SC_20260819\row-count-comparison.csv'
}

$connection = New-Object System.Data.SqlClient.SqlConnection ('Server={0};Database={1};Integrated Security=True;Encrypt=False;TrustServerCertificate=True' -f $SqlServerInstance, $SqlDatabase)
$connection.Open()
try {
    $command = $connection.CreateCommand()
    $command.CommandTimeout = 0
    $command.CommandText = "SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' ORDER BY TABLE_SCHEMA, TABLE_NAME"
    $reader = $command.ExecuteReader()
    $tables = @()
    while ($reader.Read()) { $tables += [pscustomobject]@{ Schema = [string]$reader[0]; Table = [string]$reader[1] } }
    $reader.Close()

    $sourceCounts = @{}
    foreach ($entry in $tables) {
        $schema = $entry.Schema.Replace(']', ']]')
        $table = $entry.Table.Replace(']', ']]')
        $command.CommandText = "SELECT COUNT_BIG(*) FROM [$schema].[$table]"
        $sourceCounts[$entry.Table] = [long]$command.ExecuteScalar()
    }
}
finally { $connection.Close() }

$sqlFile = [System.IO.Path]::GetTempFileName()
try {
    $lines = @("USE ``$MySqlDatabase``;")
    foreach ($entry in $tables) {
        $label = $entry.Table.Replace("'", "''")
        $name = $entry.Table.Replace('`', '``')
        $lines += "SELECT '$label', COUNT(*) FROM ``$name``;"
    }
    [System.IO.File]::WriteAllLines($sqlFile, $lines, (New-Object System.Text.UTF8Encoding($false)))
    $targetOutput = Get-Content -LiteralPath $sqlFile -Raw | & $MySqlExe --host=127.0.0.1 --port=3306 --user=$MySqlUser "--password=$env:MYSQL_PASSWORD" --batch --skip-column-names
    if ($LASTEXITCODE -ne 0) { throw 'MySQL row-count query failed.' }
}
finally { Remove-Item -LiteralPath $sqlFile -Force -ErrorAction SilentlyContinue }

$targetCounts = @{}
foreach ($line in $targetOutput) {
    $parts = $line -split "`t", 2
    if ($parts.Count -eq 2) { $targetCounts[$parts[0]] = [long]$parts[1] }
}

$report = foreach ($entry in $tables) {
    $source = $sourceCounts[$entry.Table]
    $target = if ($targetCounts.ContainsKey($entry.Table)) { $targetCounts[$entry.Table] } else { $null }
    [pscustomobject]@{
        schema_name = $entry.Schema
        table_name = $entry.Table
        sqlserver_count = $source
        mysql_count = $target
        difference = if ($null -eq $target) { $null } else { $target - $source }
        status = if ($null -eq $target) { 'MISSING' } elseif ($target -eq $source) { 'MATCH' } else { 'MISMATCH' }
    }
}

$report | Export-Csv -LiteralPath $ReportPath -NoTypeInformation -Encoding UTF8
$mismatches = @($report | Where-Object status -ne 'MATCH')
Write-Output ('TABLES={0}' -f $report.Count)
Write-Output ('MATCH={0}' -f ($report.Count - $mismatches.Count))
Write-Output ('MISMATCH={0}' -f $mismatches.Count)
Write-Output ('REPORT={0}' -f $ReportPath)
if ($mismatches.Count -gt 0) { $mismatches | Format-Table -AutoSize; exit 2 }
