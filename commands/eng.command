#!/bin/zsh

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CHROME_APP="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CHROME_PROFILE="$HOME/gemini-real-chrome-profile"
CDP_PORT="9222"
START_URL="about:blank"

BOLD="\033[1m"
DIM="\033[2m"
GREEN="\033[32m"
CYAN="\033[36m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

print_header() {
  clear
  printf "${BOLD}Режим:${RESET} Английский перевод через ChatGPT\n"
  printf "${DIM}Проект: %s${RESET}\n" "$PROJECT_DIR"
  echo ""
}

print_step() {
  printf "${YELLOW}> %s${RESET}\n" "$1"
}

print_ok() {
  printf "${GREEN}✓ %s${RESET}\n" "$1"
}

print_error() {
  printf "${RED}${BOLD}ОШИБКА:${RESET} %s\n" "$1"
}

print_header

cd "$PROJECT_DIR"

print_step "Проверяю окружение..."

if [ ! -f "$CHROME_APP" ]; then
  print_error "Google Chrome не найден."
  printf "${DIM}Ожидался путь: %s${RESET}\n" "$CHROME_APP"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  print_error "Node.js не установлен."
  echo "Сначала установи Node.js, потом запусти снова."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  print_error "npm не найден."
  echo "Проверь установку Node.js."
  exit 1
fi

print_ok "Окружение готово"
echo ""

if lsof -i TCP:$CDP_PORT >/dev/null 2>&1; then
  print_ok "Chrome с CDP уже запущен на порту $CDP_PORT"
else
  print_step "Запускаю Chrome с CDP..."
  open -na "Google Chrome" --args \
    --remote-debugging-port=$CDP_PORT \
    --user-data-dir="$CHROME_PROFILE" \
    "$START_URL"

  print_step "Жду запуск Chrome..."

  for i in {1..30}; do
    if lsof -i TCP:$CDP_PORT >/dev/null 2>&1; then
      print_ok "Chrome запущен"
      break
    fi
    sleep 1
  done

  if ! lsof -i TCP:$CDP_PORT >/dev/null 2>&1; then
    print_error "Chrome не запустился на порту $CDP_PORT."
    exit 1
  fi
fi

echo ""

if [ ! -d "node_modules" ]; then
  print_step "node_modules не найден. Выполняю npm install один раз..."
  npm install
  echo ""
fi

printf "${GREEN}${BOLD}Запускаю английский перевод через ChatGPT...${RESET}\n"
echo "------------------------------------------------------------"
echo ""
node translator-chatgpt-english.js
