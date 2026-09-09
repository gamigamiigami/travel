@echo off
chcp 65001 > nul
cd /d "%~dp0"
echo === Yahoo!トラベル クーポンウォッチャー v2 セットアップ ===

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

if not exist config.yaml copy config.example.yaml config.yaml >nul
if not exist .env (
  copy .env.example .env >nul
  echo.
  echo .env を作成しました。NTFY_TOPIC に好きな文字列を書いて保存してください。
  notepad .env
)

echo.
echo 設定を確認します...
python -m yahoo_coupon_watcher doctor

echo.
echo セットアップ完了です。次は test-notify.bat → login.bat の順に実行してください。
pause
