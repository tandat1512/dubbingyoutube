@echo off
echo ==========================================
echo   YouTube Dubbing Pro - Local Server
echo ==========================================
echo.

cd /d "%~dp0server"

echo Installing dependencies...
pip install -r requirements.txt

echo.
echo Starting server on http://localhost:8000
echo Press Ctrl+C to stop
echo.

python server.py

pause
