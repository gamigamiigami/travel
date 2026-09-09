@echo off
chcp 65001 > nul
cd /d "%~dp0"
echo === Yahoo!トラベル クーポンウォッチャー セットアップ ===

where python >nul 2>nul
if errorlevel 1 (
  echo [エラー] Python が見つかりません。
  echo https://www.python.org/downloads/windows/ から Python 3.11 以上を入れ、
  echo インストール時に "Add python.exe to PATH" にチェックを入れてください。
  pause
  exit /b 1
)

if not exist .venv (
  echo 仮想環境を作成しています...
  python -m venv .venv
)

call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

echo Playwright の実行基盤を確認しています...
python -m playwright install-deps 2>nul

if not exist config.yaml (
  copy config.example.yaml config.yaml
  echo.
  echo config.yaml を作成しました。メモ帳で開いて通知先を設定してください。
  notepad config.yaml
)

echo.
echo セットアップ完了です。次は login.bat を実行してください。
pause
