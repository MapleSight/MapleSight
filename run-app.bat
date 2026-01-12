@echo off
REM Start the app in a new cmd window from the repository root

REM Move to the script directory
pushd %~dp0
REM Simple launcher: change to the script directory and start the dev server
REM This keeps behavior minimal so it works from network or local drives (assuming Node/npm are on PATH)
cd /d "%~dp0"

if not exist package.json (
	echo package.json not found in %~dp0
	popd
	pause
	exit /b 1
)

if not exist node_modules (
	echo Installing dependencies...
	npm install || (
		echo npm install failed. Check npm/node installation.
		popd
		pause
		exit /b 1
	)
)

echo Starting app...
start "" cmd /k "cd /d "%~dp0" && npm start"

popd
