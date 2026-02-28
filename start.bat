@echo off
echo Installing Python dependencies...
cd /d "%~dp0backend"
python -m pip install -r requirements.txt

echo.
echo Starting CollegeFinder server...
echo.
echo Access at: http://localhost:4567
echo.
python main.py
