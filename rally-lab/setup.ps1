param([string]$PythonPath = "python")
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath ".venv/Scripts/python.exe")) {
    & $PythonPath -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw "Python 3.12 is recommended. Pass -PythonPath with its executable path." }
}
& .venv/Scripts/python.exe -m pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed" }
& .venv/Scripts/python.exe scripts/download_model.py
if ($LASTEXITCODE -ne 0) { throw "Model download failed" }
Write-Host "Ready. Run ./start.ps1"
