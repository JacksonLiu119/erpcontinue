param(
    [string]$Message = "Backup ERP project"
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

$expectedRemote = 'https://github.com/JacksonLiu119/erpcontinue.git'
$remote = (git remote get-url origin 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($remote)) {
    throw 'origin remote is missing; backup stopped.'
}
if ($remote.TrimEnd('/') -ne $expectedRemote.TrimEnd('/')) {
    throw "origin remote is not the approved repository: $remote"
}

$branch = (git branch --show-current).Trim()
if ([string]::IsNullOrWhiteSpace($branch)) {
    throw 'The current checkout is not on a normal branch; backup stopped.'
}

function Get-UnsafePaths([object[]]$Paths) {
    @($Paths | Where-Object {
        (($_ -match '(^|/)(\.env($|\.)|openai_key\.txt$|output/|n8n-data/)') -and
            ($_ -notmatch '(^|/)\.env\.example$')) -or
        $_ -match '\.(bak|mdf|ldf|trn|dump|pem|key|p12)$'
    })
}

$alreadyStaged = @(git diff --cached --name-only)
$unsafeAlreadyStaged = Get-UnsafePaths $alreadyStaged
if ($unsafeAlreadyStaged.Count -gt 0) {
    throw "Sensitive files are already staged; commit stopped: $($unsafeAlreadyStaged -join ', ')"
}

# Stage only source, rebuildable documentation, and schema files.
$candidates = @(
    '.env.example', '.gitignore', 'README.md', 'package.json', 'package-lock.json',
    'sql/schema.sql', 'docs', 'public', 'src', 'scripts'
)
$existing = @($candidates | Where-Object { Test-Path -LiteralPath $_ })
if ($existing.Count -eq 0) {
    throw 'No backup-eligible project files were found.'
}

git add -- $existing
if ($LASTEXITCODE -ne 0) {
    throw 'Failed to stage project files.'
}

$staged = @(git diff --cached --name-only)
$unsafe = Get-UnsafePaths $staged
if ($unsafe.Count -gt 0) {
    throw "Staged content contains sensitive files; commit stopped: $($unsafe -join ', ')"
}
if ($staged.Count -eq 0) {
    Write-Host 'There are no new project changes to back up.'
    exit 0
}

git diff --cached --check
if ($LASTEXITCODE -ne 0) {
    throw 'The staged content has a formatting error; commit stopped.'
}

Write-Host "Backing up branch $branch with $($staged.Count) files:"
$staged | ForEach-Object { Write-Host "  $_" }

git commit -m $Message
if ($LASTEXITCODE -ne 0) {
    throw 'Failed to create the Git commit.'
}

git push --set-upstream origin $branch
if ($LASTEXITCODE -ne 0) {
    throw 'GitHub push failed; no force push was used.'
}

Write-Host "GitHub backup complete: $expectedRemote ($branch)"
