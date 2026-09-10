# Manhua pipeline smoke test (no API tokens required)
# Run from repo root:  .\scripts\smoke.ps1
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$env:PYTHONIOENCODING = "utf-8"
$base = "http://127.0.0.1:3780"
$failed = 0

function Pass([string]$msg) { Write-Host "[PASS] $msg" -ForegroundColor Green }
function Fail([string]$msg) { Write-Host "[FAIL] $msg" -ForegroundColor Red; $script:failed++ }

Write-Host "==== 1) Python story validate ===="
$py = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
  Fail "missing .venv - run: python -m venv .venv && pip install -r requirements.txt"
  exit 1
}
foreach ($sid in @("manhua_demo", "overtime_system", "shandong_1994")) {
  & $py src/run_pipeline.py --story $sid --validate-only
  if ($LASTEXITCODE -eq 0) { Pass "validate $sid" } else { Fail "validate $sid exit=$LASTEXITCODE" }
}
& $py src/run_pipeline.py --story manhua_demo --expand-only
if ($LASTEXITCODE -eq 0) { Pass "expand manhua_demo" } else { Fail "expand manhua_demo" }

Write-Host "==== 2) Workbench API ===="
try {
  $health = Invoke-RestMethod "$base/api/health" -TimeoutSec 5
  if ($health.ok) { Pass "GET /api/health" } else { Fail "health.ok=false" }
} catch {
  Fail "workbench not running - start dsh-manhua\workbench.cmd first ($($_.Exception.Message))"
  Write-Host "SMOKE STOPPED: $failed failed"
  exit 1
}

$stories = Invoke-RestMethod "$base/api/stories" -TimeoutSec 10
$ids = @($stories.stories | ForEach-Object { $_.story_id })
if ($ids.Count -ge 3) { Pass "GET /api/stories count=$($ids.Count)" } else { Fail "stories too few: $($ids -join ',')" }

$gate = Invoke-RestMethod "$base/api/gate/manhua_demo" -TimeoutSec 15
if ($null -ne $gate.ok) { Pass "GET /api/gate/manhua_demo ok=$($gate.ok)" } else { Fail "gate bad response" }

$board = Invoke-RestMethod "$base/api/board/manhua_demo" -TimeoutSec 15
if ($board.shots.Count -gt 0) { Pass "GET /api/board/manhua_demo shots=$($board.shots.Count)" } else { Fail "board has no shots" }

$shotId = $board.shots[0].shot_id
if (-not $shotId) { $shotId = "E01_S01_SH01" }
$previewBody = @{ story_id = "manhua_demo"; shot_id = $shotId } | ConvertTo-Json
$prev = Invoke-RestMethod -Method POST -Uri "$base/api/prompt-preview" -ContentType "application/json" -Body $previewBody -TimeoutSec 20
if ($prev.assembled) { Pass "POST /api/prompt-preview" } else { Fail "prompt-preview missing assembled" }

$zipBody = @{ story_id = "manhua_demo" } | ConvertTo-Json
$zip = Invoke-RestMethod -Method POST -Uri "$base/api/zip-export" -ContentType "application/json" -Body $zipBody -TimeoutSec 90
if ($zip.ok -and (Test-Path $zip.zip_path)) {
  Pass "POST /api/zip-export bytes=$((Get-Item $zip.zip_path).Length)"
} else {
  Fail "zip-export failed"
}

Invoke-RestMethod "$base/api/keys" -TimeoutSec 10 | Out-Null
Pass "GET /api/keys"

Write-Host "==== result ===="
if ($failed -eq 0) {
  Write-Host "ALL PASSED. Configure AUTODL/OpenAI/Gemini in .env or workbench for real generation." -ForegroundColor Green
  exit 0
}
Write-Host "FAILED: $failed" -ForegroundColor Red
exit 1
