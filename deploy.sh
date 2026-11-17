#!/usr/bin/env bash
# deploy.sh — быстрый деплой на Render.com через GitHub
# Запуск: ./deploy.sh

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  Matiz Squad Chat — Деплой на Render.com                      ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"
echo

# Проверяем git
if ! command -v git &> /dev/null; then
    echo -e "${RED}❌ Git не установлен${NC}"
    exit 1
fi

# Проверяем, что мы в репозитории
if [ ! -d .git ]; then
    echo -e "${YELLOW}⚠️  Не в git репозитории. Инициализирую...${NC}"
    git init
    git add .
    git commit -m "Initial commit: Matiz Squad Chat"
    echo -e "${GREEN}✅ Локальный коммит создан${NC}"
fi

# Проверяем remote
if ! git remote get-url origin &> /dev/null; then
    echo -e "${YELLOW}⚠️  Нет remote origin.${NC}"
    echo -e "Создай пустой репозиторий на GitHub: ${BLUE}https://github.com/new${NC}"
    echo -e "Название: ${GREEN}matiz-chat${NC}, Public, без README/license/gitignore"
    read -rp "Введи URL твоего репозитория (https://github.com/USER/matiz-chat.git): " REPO_URL
    
    if [[ -z "$REPO_URL" ]]; then
        echo -e "${RED}❌ URL не введён${NC}"
        exit 1
    fi
    
    git remote add origin "$REPO_URL"
    echo -e "${GREEN}✅ Remote добавлен${NC}"
fi

# Пушим
echo -e "${BLUE}📤 Пушим в GitHub...${NC}"
git add .
git commit -m "Update: $(date '+%Y-%m-%d %H:%M')" 2>/dev/null || echo "Нет изменений для коммита"
git push -u origin main 2>/dev/null || git push -u origin master

echo
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  ✅ Код на GitHub!                                           ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo
echo -e "${BLUE}🔗 Следующий шаг — деплой на Render:${NC}"
echo -e "1. Зайди на ${YELLOW}https://dashboard.render.com${NC}"
echo -e "2. ${YELLOW}New +${NC} → ${YELLOW}Blueprint${NC}"
echo -e "3. Выбери репозиторий ${YELLOW}matiz-chat${NC} → ${YELLOW}Apply${NC}"
echo -e "4. Подожди 2-3 минуты билда"
echo -e "5. Получишь ссылку: ${GREEN}https://matiz-chat-xxxx.onrender.com${NC}"
echo
echo -e "${BLUE}📖 Полная инструкция в ${YELLOW}README.md${NC}"