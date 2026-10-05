@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title Дисциплина Pro - сервер
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Не найден Node.js. Установите его с https://nodejs.org ^(версия LTS^),
  echo  затем запустите этот файл ещё раз.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo  Первый запуск: устанавливаю компоненты сервера, это займёт 1-3 минуты...
  call npm install --omit=dev
  if errorlevel 1 (
    echo.
    echo  Не удалось установить компоненты. Проверьте интернет и запустите файл ещё раз.
    pause
    exit /b 1
  )
)

set "DPDATA=%USERPROFILE%\DisciplineProData"
if not exist "%DPDATA%" mkdir "%DPDATA%"
if not exist "%DPDATA%\settings.env" (
  echo  Создаю файл настроек: %DPDATA%\settings.env
  set /p ADMINPASS= Придумайте пароль администратора ^(от 8 символов^): 
  for /f %%i in ('node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"') do set SECRET=%%i
  (
    echo PORT=3000
    echo HOST=0.0.0.0
    echo NODE_ENV=production
    echo JWT_SECRET=!SECRET!
    echo ADMIN_LOGIN=admin
    echo ADMIN_PASSWORD=!ADMINPASS!
    echo DATA_DIR=!DPDATA!
    echo BACKUP_HOUR=3
    echo BACKUP_MINUTE=0
  ) > "%DPDATA%\settings.env"
)

echo.
echo  Сервер запускается. Не закрывайте это окно, пока пользуетесь приложением.
echo  Настройки и данные хранятся отдельно от кода: %DPDATA%
echo  Приложение:    http://localhost:3000/user/
echo  Админ-панель:  http://localhost:3000/admin/   ^(логин admin^)
echo.
node server.js
echo.
echo  Сервер остановлен.
pause
