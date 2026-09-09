# 웹스토어 업로드용 zip을 만든다.
# manifest.json이 참조하는 파일과, 그 HTML이 부르는 로컬 자원만 담는다.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content (Join-Path $root "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json

$files = New-Object 'System.Collections.Generic.HashSet[string]'
function Add-Ref([string]$ref, [string]$base = "") {
  if ([string]::IsNullOrWhiteSpace($ref)) { return }
  if ($ref -match '^(https?:|data:|//|#)') { return }
  $clean = ($ref -split '\?')[0]
  $joined = if ($base) { "$base/$clean" } else { $clean }
  # ../ 같은 상대 조각을 정리한다
  $parts = New-Object 'System.Collections.Generic.List[string]'
  foreach ($piece in ($joined -replace '\\', '/' -split '/')) {
    if ($piece -eq "" -or $piece -eq ".") { continue }
    if ($piece -eq "..") { if ($parts.Count -gt 0) { $parts.RemoveAt($parts.Count - 1) }; continue }
    $parts.Add($piece)
  }
  if ($parts.Count -gt 0) { [void]$files.Add(($parts -join '/')) }
}

Add-Ref "manifest.json"
Add-Ref $manifest.background.service_worker
foreach ($entry in $manifest.content_scripts) {
  foreach ($js in $entry.js) { Add-Ref $js }
  foreach ($css in $entry.css) { Add-Ref $css }
}
foreach ($p in $manifest.icons.PSObject.Properties) { Add-Ref $p.Value }
Add-Ref $manifest.action.default_popup
foreach ($p in $manifest.action.default_icon.PSObject.Properties) { Add-Ref $p.Value }
Add-Ref $manifest.options_page
foreach ($war in $manifest.web_accessible_resources) {
  foreach ($res in $war.resources) { Add-Ref $res }
}

# HTML이 부르는 로컬 스크립트/스타일도 담는다
foreach ($html in @($files | Where-Object { $_ -like "*.html" })) {
  $full = Join-Path $root ($html -replace '/', [IO.Path]::DirectorySeparatorChar)
  if (-not (Test-Path $full)) { continue }
  $base = Split-Path -Parent $html
  foreach ($m in [regex]::Matches((Get-Content $full -Raw -Encoding UTF8), '(?:src|href)\s*=\s*["'']([^"'']+)["'']')) {
    Add-Ref $m.Groups[1].Value $base
  }
}

# GPL 배포 조건상 라이선스 전문을 함께 담는다
if (Test-Path (Join-Path $root "LICENSE")) { [void]$files.Add("LICENSE") }

$missing = @($files | Where-Object { -not (Test-Path (Join-Path $root ($_ -replace '/', [IO.Path]::DirectorySeparatorChar))) })
if ($missing.Count -gt 0) { Write-Error "참조된 파일이 없습니다: $($missing -join ', ')" }

$zipPath = Join-Path $root "$(Split-Path -Leaf $root)-$($manifest.version).zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

# Compress-Archive는 PowerShell 판마다 경로 구분자 처리가 달라서
# .NET ZipArchive로 직접 쓴다.
$archive = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
  foreach ($file in ($files | Sort-Object)) {
    $full = Join-Path $root ($file -replace '/', [IO.Path]::DirectorySeparatorChar)
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $full, $file)
  }
} finally {
  $archive.Dispose()
}

Write-Host ""
Write-Host "만들었습니다: $zipPath" -ForegroundColor Green
Write-Host "  버전 $($manifest.version) / 파일 $($files.Count)개 / $((Get-Item $zipPath).Length) bytes"
Write-Host ""
foreach ($file in ($files | Sort-Object)) { Write-Host "  $file" }
