

# Run the dev server (simple)

This file explains the minimal helpers included to run the dev server on Windows.

Files of interest:

- `run-app.bat` — simple double-click launcher: changes to the repository directory, runs `npm install` if `node_modules` are missing, then opens a new Command Prompt running `npm start`.
- `run-app.ps1` — PowerShell runner that will change to the script directory and run `npm install` (if necessary) and `npm start`. Use this if you prefer PowerShell.

Usage

1) Double-click `run-app.bat` in the repository root. A new Command Prompt window will open and the app will start.

OR

2) Run from PowerShell (in the repository root):

    .\run-app.ps1

Requirements and notes

- Node.js and npm must be installed and on your PATH.
- If the project is on a network drive and you encounter watcher or permission issues, run the project from a local clone instead.
- If you see errors about `npm` not being found, ensure Node.js is installed and restart your terminal.

If you'd like the original advanced behavior (automatic local copy for network drives, shortcut creation, custom icon), tell me and I can re-add a simpler, well-tested version.

