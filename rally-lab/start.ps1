$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath ".venv/Scripts/python.exe")) { throw "Run ./setup.ps1 first." }
& .venv/Scripts/python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8765 --ws-max-size 2097152
