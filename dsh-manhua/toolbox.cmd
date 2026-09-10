@echo off
REM Manhua toolbox CLI launcher (no DeepSeek Harness required)
cd /d "%~dp0"
if "%~1"=="" (
  call pnpm cli -- keys.status
  echo.
  echo Usage examples:
  echo   toolbox.cmd keys.set --provider openai --value YOUR_KEY
  echo   toolbox.cmd story.load --story overtime_system
  exit /b 0
)
call pnpm cli -- %*
