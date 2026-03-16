@echo off
taskkill /f /fi "WINDOWTITLE eq NanoClaw" /im node.exe 2>nul
echo NanoClaw stopped.
