@echo off
cd /d "D:\Work\Personal\Sources\autobot"
echo Starting NanoClaw...
start "" /B "C:\Program Files\nodejs\node.exe" "D:\Work\Personal\Sources\autobot\dist\index.js" >> "D:\Work\Personal\Sources\autobot\logs\nanoclaw.log" 2>> "D:\Work\Personal\Sources\autobot\logs\nanoclaw.error.log"
echo NanoClaw started.
echo Logs: D:\Work\Personal\Sources\autobot\logs\nanoclaw.log
