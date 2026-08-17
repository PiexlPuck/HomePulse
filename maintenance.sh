#!/bin/bash

# --- Color Definitions ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;36m'
NC='\033[0m'

# Backup Directories
AUTO_BACKUP_DIR="./db_backups/auto"
MANUAL_BACKUP_DIR="./db_backups/manual"

# Create directories
mkdir -p "$AUTO_BACKUP_DIR" "$MANUAL_BACKUP_DIR"

# Print Header Banner
print_header() {
    echo -e "${BLUE}===============================================${NC}"
    echo -e "${BLUE}        HomePulse Stack Maintenance Utility    ${NC}"
    echo -e "${BLUE}===============================================${NC}"
}

# Ensure .env file exists and contains secure configurations
init_env_file() {
    if [ ! -f ".env" ]; then
        echo -e "${YELLOW}Creating secure .env file with auto-generated passwords...${NC}"
        local db_pass jwt_secret
        if command -v python3 &>/dev/null; then
            db_pass=$(python3 -c "import secrets; print(secrets.token_urlsafe(16))")
            jwt_secret=$(python3 -c "import secrets; print(secrets.token_hex(32))")
        else
            db_pass=$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 20)
            jwt_secret=$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 48)
        fi

        cat <<EOF > .env
# HomePulse stack environment configurations
DB_PASSWORD=${db_pass}
JWT_SECRET_KEY=${jwt_secret}
# Optional path override for plugins directory persistence
PLUGINS_DIR=./plugins
EOF
        echo -e "${GREEN}Created .env file successfully.${NC}"
    fi
}

# Check main system requirements
check_dependencies() {
    if ! command -v git &> /dev/null; then
        echo -e "${RED}Error: Git is not installed. Please install Git first.${NC}"
        exit 1
    fi
    if ! command -v docker &> /dev/null; then
        echo -e "${RED}Error: Docker is not installed. Please install Docker first.${NC}"
        exit 1
    fi
    init_env_file
}

# Check for updates by fetching and comparing commit hashes
check_version() {
    echo -e "${YELLOW}Checking repository version status...${NC}"
    git fetch origin &>/dev/null
    if [ $? -ne 0 ]; then
        echo -e "${RED}Warning: Could not fetch updates from origin repository.${NC}"
        return 1
    fi

    local current_branch
    current_branch=$(git rev-parse --abbrev-ref HEAD)
    local local_ver
    local_ver=$(git rev-parse --short HEAD)
    local remote_ver
    remote_ver=$(git rev-parse --short origin/"$current_branch" 2>/dev/null)

    if [ -z "$remote_ver" ]; then
        echo -e "${YELLOW}Warning: Remote branch counterpart not found. Skipping version check.${NC}"
        return 1
    fi

    echo -e "${BLUE}Local Version:  $local_ver${NC}"
    echo -e "${BLUE}Remote Version: $remote_ver${NC}"

    if [ "$local_ver" != "$remote_ver" ]; then
        echo -e "${YELLOW}A new update is available on branch $current_branch!${NC}"
        read -p "Do you want to pull the update and rebuild the containers? (y/n): " choice
        if [[ "$choice" =~ ^[Yy]$ ]]; then
            perform_update "$current_branch"
        else
            echo -e "${YELLOW}Update skipped by user.${NC}"
        fi
    else
        echo -e "${GREEN}HomePulse is already up-to-date (Version: $local_ver).${NC}"
    fi
}

# Create a manual database backup (keeps unlimited files)
create_manual_backup() {
    echo -e "${YELLOW}Creating manual database backup...${NC}"
    local timestamp
    timestamp=$(date +%F_%H%M%S)
    local backup_file="${MANUAL_BACKUP_DIR}/homepulse_backup_manual_${timestamp}.sql"

    if docker compose ps | grep -q -E "homepulse-db.*Up|db.*Up"; then
        docker compose exec -T homepulse-db pg_dump -U hp_admin -d homepulse > "$backup_file"
        if [ $? -eq 0 ]; then
            echo -e "${GREEN}Manual backup successfully saved to: $backup_file${NC}"
        else
            echo -e "${RED}Error: Manual database backup failed.${NC}"
            rm -f "$backup_file"
        fi
    else
        echo -e "${RED}Error: homepulse-db container is not running. Start the stack first.${NC}"
    fi
}

# Create an automated database backup (prunes directory to keep only latest 3)
create_auto_backup() {
    echo -e "${YELLOW}Creating automated database backup...${NC}"
    local timestamp
    timestamp=$(date +%F_%H%M%S)
    local backup_file="${AUTO_BACKUP_DIR}/homepulse_backup_auto_${timestamp}.sql"

    if docker compose ps | grep -q -E "homepulse-db.*Up|db.*Up"; then
        docker compose exec -T homepulse-db pg_dump -U hp_admin -d homepulse > "$backup_file"
        if [ $? -eq 0 ]; then
            echo -e "${GREEN}Automated backup successfully saved to: $backup_file${NC}"
            prune_auto_backups
        else
            echo -e "${RED}Error: Automated database backup failed.${NC}"
            rm -f "$backup_file"
        fi
    else
        echo -e "${YELLOW}Warning: homepulse-db container is not running. Skipping database backup...${NC}"
    fi
}

# Prune automated backups, leaving only the 3 most recent
prune_auto_backups() {
    echo -e "${YELLOW}Rotating automated backups (keeping last 3)...${NC}"
    # Read files sorted by modification time (newest first)
    local files=()
    while IFS= read -r -d '' file; do
        files+=("$file")
    done < <(find "$AUTO_BACKUP_DIR" -maxdepth 1 -name "homepulse_backup_auto_*.sql" -type f -print0 | xargs -0 -r ls -t 2>/dev/null)

    local count=${#files[@]}
    if [ "$count" -gt 3 ]; then
        for ((i=3; i<count; i++)); do
            echo -e "${BLUE}Pruning old auto backup: ${files[i]}${NC}"
            rm -f "${files[i]}"
        done
    fi
}

# List all manual/auto backups and restore the selected index
list_and_restore_backup() {
    echo -e "${YELLOW}Scanning for database backups...${NC}"
    local backups=()
    while IFS= read -r -d '' file; do
        backups+=("$file")
    done < <(find "$AUTO_BACKUP_DIR" "$MANUAL_BACKUP_DIR" -maxdepth 1 -name "homepulse_backup_*.sql" -type f -print0 | xargs -0 -r ls -t 2>/dev/null)

    local count=${#backups[@]}
    if [ "$count" -eq 0 ]; then
        echo -e "${RED}No backups found in $AUTO_BACKUP_DIR or $MANUAL_BACKUP_DIR.${NC}"
        return 1
    fi

    echo ""
    echo -e "${BLUE}Available backups for restoration (Newest First):${NC}"
    for ((i=0; i<count; i++)); do
        local file="${backups[i]}"
        local label="[Manual]"
        if [[ "$file" =~ /auto/ ]]; then
            label="[Auto]  "
        fi
        local filename
        filename=$(basename "$file")
        local mtime
        mtime=$(date -r "$file" "+%Y-%m-%d %H:%M:%S")
        echo -e "  $((i+1))) $label $filename ($mtime)"
    done
    echo ""

    read -p "Select a backup index to restore (1-$count) or 'q' to cancel: " sel
    if [[ "$sel" =~ ^[Qq]$ ]]; then
        echo -e "${YELLOW}Restoration cancelled.${NC}"
        return 0
    fi

    if ! [[ "$sel" =~ ^[0-9]+$ ]] || [ "$sel" -lt 1 ] || [ "$sel" -gt "$count" ]; then
        echo -e "${RED}Invalid selection.${NC}"
        return 1
    fi

    local selected_file="${backups[$((sel-1))]}"
    echo -e "${YELLOW}Selected backup file: $selected_file${NC}"
    read -p "WARNING: Restoring will overwrite the current database state. Proceed? (y/n): " confirm
    if ! [[ "$confirm" =~ ^[Yy]$ ]]; then
        echo -e "${YELLOW}Restoration aborted.${NC}"
        return 0
    fi

    if docker compose ps | grep -q -E "homepulse-db.*Up|db.*Up"; then
        echo -e "${YELLOW}Restoring database...${NC}"
        # Stop app container to prevent write locks during restore
        docker compose stop homepulse-app &>/dev/null
        
        # Perform restore
        docker compose exec -T homepulse-db psql -U hp_admin -d homepulse < "$selected_file"
        if [ $? -eq 0 ]; then
            echo -e "${GREEN}Database restore completed successfully!${NC}"
        else
            echo -e "${RED}Error: Database restore failed.${NC}"
        fi

        # Start app container again
        docker compose start homepulse-app &>/dev/null
    else
        echo -e "${RED}Error: homepulse-db container is not running.${NC}"
    fi
}

# List manual backups and delete the selected file
delete_manual_backup() {
    echo -e "${YELLOW}Scanning for manual backups...${NC}"
    local backups=()
    while IFS= read -r -d '' file; do
        backups+=("$file")
    done < <(find "$MANUAL_BACKUP_DIR" -maxdepth 1 -name "homepulse_backup_manual_*.sql" -type f -print0 | xargs -0 -r ls -t 2>/dev/null)

    local count=${#backups[@]}
    if [ "$count" -eq 0 ]; then
        echo -e "${RED}No manual backups found in $MANUAL_BACKUP_DIR.${NC}"
        return 1
    fi

    echo ""
    echo -e "${BLUE}Manual backups available for deletion:${NC}"
    for ((i=0; i<count; i++)); do
        local file="${backups[i]}"
        local filename
        filename=$(basename "$file")
        local mtime
        mtime=$(date -r "$file" "+%Y-%m-%d %H:%M:%S")
        echo -e "  $((i+1))) $filename ($mtime)"
    done
    echo ""

    read -p "Select a backup index to delete permanently (1-$count) or 'q' to cancel: " sel
    if [[ "$sel" =~ ^[Qq]$ ]]; then
        echo -e "${YELLOW}Deletion cancelled.${NC}"
        return 0
    fi

    if ! [[ "$sel" =~ ^[0-9]+$ ]] || [ "$sel" -lt 1 ] || [ "$sel" -gt "$count" ]; then
        echo -e "${RED}Invalid selection.${NC}"
        return 1
    fi

    local selected_file="${backups[$((sel-1))]}"
    read -p "Are you sure you want to permanently delete $(basename "$selected_file")? (y/n): " confirm
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
        rm -f "$selected_file"
        echo -e "${GREEN}Manual backup deleted successfully.${NC}"
    else
        echo -e "${YELLOW}Deletion aborted.${NC}"
    fi
}

# Rebuild and restart docker compose stack
rebuild_stack() {
    echo -e "${YELLOW}Rebuilding and starting HomePulse stack...${NC}"
    docker compose down
    docker compose up -d --build
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}HomePulse stack successfully rebuilt and started online!${NC}"
    else
        echo -e "${RED}Error: Stack rebuild failed.${NC}"
    fi
}

# Force regenerate environment credentials in .env file
force_regenerate_env() {
    echo ""
    echo -e "${RED}WARNING: Regenerating credentials will overwrite the existing .env file.${NC}"
    echo -e "${RED}Containers must be restarted to apply newly generated passwords.${NC}"
    read -p "Are you sure you want to regenerate secure keys? (y/n): " confirm
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
        if [ -f ".env" ]; then
            cp .env .env.bak
            echo -e "${YELLOW}Backup of current .env saved as .env.bak${NC}"
            rm -f .env
        fi
        
        init_env_file
        
        echo ""
        echo -e "${GREEN}Fresh credentials successfully generated:${NC}"
        grep -E "DB_PASSWORD|JWT_SECRET_KEY" .env
        echo ""
        
        read -p "Would you like to rebuild and restart containers now to apply changes? (y/n): " rebuild_choice
        if [[ "$rebuild_choice" =~ ^[Yy]$ ]]; then
            rebuild_stack
        else
            echo -e "${YELLOW}Please remember to rebuild/restart the stack later to apply changes.${NC}"
        fi
    else
        echo -e "${YELLOW}Credential regeneration aborted.${NC}"
    fi
}

# Perform repository update
perform_update() {
    local branch="$1"
    echo -e "${YELLOW}Proceeding with automated update on branch $branch...${NC}"
    create_auto_backup
    
    echo -e "${YELLOW}Pulling repository modifications...${NC}"
    git pull origin "$branch"
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}Latest modifications successfully pulled.${NC}"
        rebuild_stack
    else
        echo -e "${RED}Error: Pulling modifications failed.${NC}"
    fi
}

# Perform a fresh install (wipes database volume and rebuilds)
fresh_install() {
    echo ""
    echo -e "${RED}WARNING: Performing a fresh install is highly destructive!${NC}"
    echo -e "${RED}This will completely WIPE the PostgreSQL database volume, deleting all custom settings, Lovelace cards, and historic logs.${NC}"
    read -p "Are you absolutely sure you want to proceed? Type 'CONFIRM' to wipe and rebuild: " confirm
    if [ "$confirm" = "CONFIRM" ]; then
        echo -e "${YELLOW}Stopping containers and destroying volume 'postgres_data'...${NC}"
        docker compose down -v
        if [ $? -eq 0 ]; then
            echo -e "${GREEN}Volume successfully destroyed.${NC}"
            echo -e "${YELLOW}Initiating fresh recreation and build...${NC}"
            docker compose up -d --build --force-recreate
            if [ $? -eq 0 ]; then
                echo -e "${GREEN}Success: HomePulse containers rebuilt and initialized with fresh default settings!${NC}"
            else
                echo -e "${RED}Error: Rebuilding stack failed.${NC}"
            fi
        else
            echo -e "${RED}Error: Could not shut down containers or destroy volumes.${NC}"
        fi
    else
        echo -e "${YELLOW}Fresh install aborted by user.${NC}"
    fi
}

# Main Application Menu Loop
show_menu() {
    while true; do
        echo ""
        echo -e "${BLUE}=== HomePulse Utility Operations Menu ===${NC}"
        echo -e "1) Run Manual Database Backup"
        echo -e "2) Restore Database from Backup (Auto or Manual)"
        echo -e "3) Delete a Manual Backup"
        echo -e "4) Force Rebuild and Restart Stack"
        echo -e "5) Check for Updates"
        echo -e "6) Perform Fresh Install (Wipe Database & Rebuild)"
        echo -e "7) Force Regenerate/Over-write Environment Credentials"
        echo -e "8) Exit"
        echo -e "${BLUE}=========================================${NC}"
        read -p "Select options (1-8): " opt
        case "$opt" in
            1) create_manual_backup ;;
            2) list_and_restore_backup ;;
            3) delete_manual_backup ;;
            4) rebuild_stack ;;
            5) check_version ;;
            6) fresh_install ;;
            7) force_regenerate_env ;;
            8) echo -e "${BLUE}Exiting maintenance utility. Goodbye!${NC}"; exit 0 ;;
            *) echo -e "${RED}Invalid option selected. Please specify (1-8).${NC}" ;;
        esac
    done
}

# Main entry point
main() {
    print_header
    check_dependencies
    check_version
    show_menu
}

main "$@"
