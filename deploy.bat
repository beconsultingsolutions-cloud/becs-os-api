@echo off
setlocal

cd /d "%USERPROFILE%\Downloads\becs-os-api"
if not exist wrangler.jsonc (
  echo ERROR: wrangler.jsonc not found. Check the folder path.
  pause
  exit /b 1
)

node -v || (echo Install Node LTS from nodejs.org, reopen this window, run again. & pause & exit /b 1)

call npm install || (echo npm install failed & pause & exit /b 1)

call npx wrangler login
pause

call npx wrangler d1 execute becs-os-core --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
call npx wrangler d1 execute becs-os-core --remote --command "SELECT COUNT(*) AS ventures FROM ventures"
echo If tables are missing, run: npx wrangler d1 execute becs-os-core --remote --file=schema.sql
pause

call npx wrangler deploy || (echo deploy failed - copy the error to Claude & pause & exit /b 1)

call npx wrangler secret put API_KEY

set /p API_URL=Paste your live URL (https://...workers.dev, no trailing slash): 
set /p API_KEY=Paste your API key to test (it stays in this window only): 
curl.exe -i "%API_URL%/health"
echo.
curl.exe -s "%API_URL%/dashboard" -H "Authorization: Bearer %API_KEY%"
echo.

set API_KEY=
echo Finished.
pause
endlocal