# Use only in the shell that runs this delivered copy.
$ErrorActionPreference = 'Stop'
$cleanRoot = $PSScriptRoot
function Assert-CleanEPath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith('E:\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "The local package must run on E: $full"
    }
    for ($item = $full; $item; $item = [IO.Path]::GetDirectoryName($item)) {
        if ((Test-Path -LiteralPath $item) -and ((Get-Item -LiteralPath $item -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Linked project paths are not supported: $item"
        }
    }
    return $full
}

$cleanRuntime = Assert-CleanEPath (Join-Path $cleanRoot '.runtime')
$cleanProject = Assert-CleanEPath (Join-Path $cleanRoot 'project')
$cleanArtifacts = Assert-CleanEPath (Join-Path $cleanRoot 'artifacts')
$nodeDir = Join-Path $cleanRoot 'tools\node'
if (-not (Test-Path -LiteralPath (Join-Path $nodeDir 'node.exe')) -and $env:DOOGY_NODE_DIRECTORY) {
    $nodeDir = $env:DOOGY_NODE_DIRECTORY
}
$cleanNodeDirectory = Assert-CleanEPath $nodeDir
$cleanNode = Assert-CleanEPath (Join-Path $cleanNodeDirectory 'node.exe')
$cleanNpm = Assert-CleanEPath (Join-Path $cleanNodeDirectory 'npm.cmd')
$mediaDir = Join-Path $cleanRoot 'tools\media'
if (-not (Test-Path -LiteralPath (Join-Path $mediaDir 'ffmpeg.exe')) -and $env:MEDIA_TOOLS_DIRECTORY) {
    $mediaDir = $env:MEDIA_TOOLS_DIRECTORY
}
$cleanMedia = Assert-CleanEPath $mediaDir
foreach ($file in @($cleanNode, $cleanNpm, (Join-Path $cleanMedia 'ffmpeg.exe'), (Join-Path $cleanMedia 'ffprobe.exe'))) {
    if (-not (Test-Path -LiteralPath (Assert-CleanEPath $file) -PathType Leaf)) { throw "Missing local tool: $file" }
}
$cleanDirectories = @{}
foreach ($name in @('temp','home','appdata','localappdata','npm','expo','metro','dotslash','node-gyp')) {
    $dir = Assert-CleanEPath (Join-Path $cleanRuntime $name)
    [void][IO.Directory]::CreateDirectory($dir)
    $cleanDirectories[$name] = $dir
}
foreach ($setting in @{
    TEMP=$cleanDirectories.temp; TMP=$cleanDirectories.temp; TMPDIR=$cleanDirectories.temp
    HOME=$cleanDirectories.home; USERPROFILE=$cleanDirectories.home
    LOCALAPPDATA=$cleanDirectories.localappdata; APPDATA=$cleanDirectories.appdata
    npm_config_cache=$cleanDirectories.npm
    npm_config_userconfig=(Join-Path $cleanRuntime 'npm-user.npmrc')
    npm_config_globalconfig=(Join-Path $cleanRuntime 'npm-global.npmrc')
    npm_config_update_notifier='false'; npm_config_audit='false'; npm_config_fund='false'
    npm_package_config_node_gyp_devdir=$cleanDirectories['node-gyp']
    SCARF_ANALYTICS='false'; NODE_DISABLE_COMPILE_CACHE='1'
    NODE_OPTIONS=('--report-exclude-env --report-directory="' + $cleanDirectories.temp.Replace('\', '/') + '"')
    __UNSAFE_EXPO_HOME_DIRECTORY=$cleanDirectories.expo
    EXPO_METRO_CACHE_OUTPUT_DIR=$cleanDirectories.metro; DOTSLASH_CACHE=$cleanDirectories.dotslash
    EXPO_NO_DOTENV='1'; EXPO_OFFLINE='1'; EXPO_NO_TELEMETRY='1'
    MEDIA_TOOLS_DIRECTORY=$cleanMedia
}.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($setting.Key, $setting.Value, 'Process')
}
$env:Path = $cleanNodeDirectory + ';' + $cleanMedia + ';' + $env:Path
