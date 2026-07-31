#!/bin/bash

# --- Color Definitions ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;36m'
NC='\033[0m'

echo -e "${BLUE}===============================================${NC}"
echo -e "${BLUE}        HomePulse Linux Update Utility         ${NC}"
echo -e "${BLUE}===============================================${NC}"

# Check dependencies
if ! command -v git &> /dev/null; then
    echo -e "${RED}Error: Git is not installed. Please install Git first.${NC}"
    exit 1
fi

if ! command -v docker &> /dev/null; then
    echo -e "${RED}Error: Docker is not installed. Please install Docker first.${NC}"
    exit 1
fi

# 1. Database Backup (Settings & Probes Safety Guard)
echo -e "${YELLOW}[1/4] Running PostgreSQL database backup...${NC}"
BACKUP_DIR="./db_backups"
mkdir -p "$BACKUP_DIR"
BACKUP_FILE="${BACKUP_DIR}/homepulse_backup_$(date +%F_%H%M%S).sql"

if docker compose ps | grep -q "homepulse-db.*Up"; then
    docker compose exec -T homepulse-db pg_dump -U hp_admin -d homepulse > "$BACKUP_FILE"
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}Database successfully backed up to $BACKUP_FILE${NC}"
    else
        echo -e "${RED}Warning: Database backup failed. Proceeding with caution...${NC}"
    fi
else
    echo -e "${YELLOW}Warning: homepulse-db container is not running. Skipping backup...${NC}"
fi

# 2. Fetch and Pull Updates
echo -e "${YELLOW}[2/4] Pulling latest repository updates from GitHub...${NC}"

# Stash local configurations/edits to prevent merge conflicts
CHANGES_STASHED=false
if ! git diff-index --quiet HEAD --; then
    echo -e "${YELLOW}Local edits detected. Stashing local changes temporarily...${NC}"
    git stash
    CHANGES_STASHED=true
fi

# Determine current branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo -e "${BLUE}Active branch: $CURRENT_BRANCH${NC}"

# Pull from origin
git fetch origin
git pull origin "$CURRENT_BRANCH"

if [ $? -eq 0 ]; then
    echo -e "${GREEN}GitHub updates successfully fetched and merged.${NC}"
else
    echo -e "${RED}Error: Failed to pull updates from GitHub origin.${NC}"
    if [ "$CHANGES_STASHED" = true ]; then
        git stash pop
    fi
    exit 1
fi

if [ "$CHANGES_STASHED" = true ]; then
    echo -e "${YELLOW}Re-applying local changes...${NC}"
    git stash pop
fi

# 3. Rebuild Containers
echo -e "${YELLOW}[3/4] Rebuilding and restarting HomePulse containers...${NC}"
docker compose down
docker compose up -d --build

if [ $? -eq 0 ]; then
    echo -e "${GREEN}Docker containers successfully rebuilt and started.${NC}"
else
    echo -e "${RED}Error: Docker rebuild failed.${NC}"
    exit 1
fi

# 4. Status Verification
echo -e "${YELLOW}[4/4] Confirming update success...${NC}"
sleep 3
if docker compose ps | grep -q "homepulse-app.*Up"; then
    echo -e "${GREEN}HomePulse App container is running online!${NC}"
    echo -e "${GREEN}SUCCESS: Update completed. All settings and probes are preserved inside the postgres_data volume.${NC}"
else
    echo -e "${RED}Warning: homepulse-app container failed to start up. Run: docker compose logs${NC}"
fi
echo -e "${BLUE}===============================================${NC}"
