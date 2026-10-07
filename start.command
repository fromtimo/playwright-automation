#!/bin/zsh

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
NOTIFICATION_SOUND="$PROJECT_DIR/assets/notification/notification.mp3"

BOLD="\033[1m"
DIM="\033[2m"
GREEN="\033[32m"
CYAN="\033[36m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

play_notification() {
  if [ -f "$NOTIFICATION_SOUND" ] && command -v afplay >/dev/null 2>&1; then
    afplay "$NOTIFICATION_SOUND" >/dev/null 2>&1 &
  fi
}

print_header() {
  clear
  echo "Translation Toolkit"
  printf "${DIM}Project: %s${RESET}\n" "$PROJECT_DIR"
  echo ""
}

run_script() {
  local script_path="$1"
  local title="$2"

  print_header
  printf "${BOLD}${YELLOW}Запуск:${RESET} %s\n" "$title"
  printf "${DIM}%s${RESET}\n" "$script_path"
  echo "------------------------------------------------------------"
  echo ""

  zsh "$script_path"
  local exit_status=$?

  echo ""
  echo "------------------------------------------------------------"
  if [ "$exit_status" -eq 0 ]; then
    play_notification
    printf "${GREEN}${BOLD}Готово.${RESET} Возвращаюсь в главное меню...\n"
  else
    printf "${RED}${BOLD}Error:${RESET} скрипт завершился с кодом %s\n" "$exit_status"
    printf "${DIM}Возвращаюсь в главное меню...${RESET}\n"
  fi
  sleep 2
}

print_menu() {
  print_header
  printf "${BOLD}Главное меню${RESET}\n"
  echo ""
  echo "  1 перевод Gemini; 2 английский ChatGPT; 3 подсчёт символов; 4 Посчитать сокр."
  echo ""
  printf "  ${RED}${BOLD}5 Выйти - Enter${RESET}\n"
  echo ""
  printf "${CYAN}Выбор:${RESET} "
}

while true; do
  print_menu
  read choice

  case "$choice" in
    "")
      clear
      exit 0
      ;;
    "1")
      run_script "$PROJECT_DIR/commands/main.command" "Перевод Gemini"
      ;;
    "2")
      run_script "$PROJECT_DIR/commands/eng.command" "Английский ChatGPT"
      ;;
    "3")
      run_script "$PROJECT_DIR/commands/count.command" "Подсчёт символов"
      ;;
    "4")
      run_script "$PROJECT_DIR/commands/short-counts.command" "Посчитать сокр."
      ;;
    "5")
      clear
      exit 0
      ;;
    *)
      echo ""
      echo "Не понял выбор: $choice"
      sleep 1
      ;;
  esac
done
