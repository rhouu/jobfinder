@echo off
REM Start Job & Internship Finder on http://localhost:8000
python -m uvicorn backend.app:app --reload --port 8000
