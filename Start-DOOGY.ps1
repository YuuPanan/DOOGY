param([ValidateRange(1024, 65535)][int]$Port = 54017)
. (Join-Path $PSScriptRoot 'Use-LocalEnvironment.ps1')

$version = & $cleanNode --version
if ($LASTEXITCODE -ne 0 -or ($version -notmatch '^v24\.')) { throw 'Node.js 24 is required.' }
foreach ($dependencies in @('node_modules\typescript\package.json','mobile\node_modules\expo\package.json')) {
    if (-not (Test-Path -LiteralPath (Assert-CleanEPath (Join-Path $cleanProject $dependencies)) -PathType Leaf)) {
        throw 'Locked dependencies are missing. See README-先读.md.'
    }
}
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
    throw "Port $Port is already in use. Use the running DOOGY window or specify an unused -Port."
}

$data = Assert-CleanEPath (Join-Path $cleanProject 'data')
$demos = @(Get-ChildItem -LiteralPath $data -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -cmatch '^app-demo-[a-f0-9]{32}$' })
if ($demos.Count -gt 1) { throw 'More than one demo library exists. Keep this package assigned to one demo library.' }
$demoDb = $null
if ($demos.Count -eq 1) {
    $demoDir = Assert-CleanEPath $demos[0].FullName
    $demoDb = Assert-CleanEPath (Join-Path $demoDir 'doogy.db')
    if (-not (Test-Path -LiteralPath $demoDb -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Assert-CleanEPath (Join-Path $demoDir 'manifest.json')) -PathType Leaf)) {
        throw 'Existing demo seed is incomplete. Its files were preserved.'
    }
    foreach ($sidecar in @('-wal','-shm')) { [void](Assert-CleanEPath ($demoDb + $sidecar)) }
}

foreach ($name in @('DATABASE_URL','PUSH_WEBHOOK_URL','PUSH_WEBHOOK_TOKEN','VENDOR_WEBHOOK_SECRET',
    'SUPPORT_ADMIN_USER_IDS','DEVICE_ADMIN_USER_IDS','MANAGED_BACKUP_DIRECTORY',
    'EXPO_PUBLIC_CN_API_URL','EXPO_PUBLIC_GLOBAL_API_URL','EXPO_PUBLIC_API_URL')) {
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}
$env:CI = '1'
$env:APP_VARIANT = 'preview'
$webOutput = Assert-CleanEPath (Join-Path $cleanArtifacts ('web-' + [guid]::NewGuid().ToString('N')))

Push-Location -LiteralPath $cleanProject
try {
    & $cleanNpm run build
    if ($LASTEXITCODE -ne 0) { throw "Backend build failed ($LASTEXITCODE)." }
    Push-Location -LiteralPath (Join-Path $cleanProject 'mobile')
    try {
        & $cleanNpm run check
        if ($LASTEXITCODE -ne 0) { throw "Mobile type check failed ($LASTEXITCODE)." }
        & $cleanNode scripts/expo.cjs export --platform web --output-dir $webOutput --max-workers 2
        if ($LASTEXITCODE -ne 0) { throw "Mobile Web export failed ($LASTEXITCODE)." }
    } finally { Pop-Location }
    $env:DOOGY_MOBILE_WEB_PREVIEW_DIRECTORY = $webOutput
    Write-Host "Web: http://127.0.0.1:$Port/"
    Write-Host "Android emulator server root: http://10.0.2.2:$Port"
    if ($demoDb) {
        foreach ($setting in @{
            HOST='127.0.0.1'; PORT=[string]$Port; DB_DRIVER='sqlite'; DB_PATH=$demoDb
            DATA_MODE='offline'; DOOGY_DEMO='1'; MANAGED_BACKUP_ENABLED='false'
            FRESH_SECONDS='1800'; OFFLINE_SECONDS='1800'
        }.GetEnumerator()) {
            [Environment]::SetEnvironmentVariable($setting.Key, $setting.Value, 'Process')
        }
        & $cleanNode dist/scripts/start.js
    } else {
        & $cleanNode dist/scripts/app-demo.js $Port --loopback
    }
    exit $LASTEXITCODE
} finally { Pop-Location }
