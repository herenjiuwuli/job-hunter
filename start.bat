@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ==========================================
echo   job-hunter  本地一键启动
echo ==========================================
echo.

REM 检查 DeepSeek key 是否已填（必须以 sk- 开头）
findstr /r /c:"^DEEPSEEK_API_KEY=sk-" .env >nul
if errorlevel 1 (
  echo [X] 还没填 DeepSeek key，AI 功能会用不了。
  echo.
  echo     请打开 .env，把 sk- 开头的 key 填到这一行后面：
  echo         DEEPSEEK_API_KEY=你的key
  echo.
  echo     顺便帮你打开 .env 了，填完保存，再双击本文件。
  echo.
  start "" notepad "%~dp0.env"
  pause
  exit /b
)

echo [OK] DeepSeek key 已配置
echo.
echo     前端  http://localhost:5173
echo     后端  http://localhost:3100
echo.
echo     关闭此窗口 = 停止服务
echo ==========================================
echo.

REM 延迟 5 秒自动开浏览器（等服务起来）
start "" cmd /c "timeout /t 5 >nul & start http://localhost:5173"

npm run dev
pause
