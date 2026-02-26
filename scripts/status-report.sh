#!/bin/bash
# NanoClaw Status Report Generator

TZ=Europe/Madrid

now() {
    date '+%d %b %H:%M'
}

check_backups() {
    echo "✅ *Backups*"

    # Find last backup based on logs or files
    local last_backup_log=$(grep "Backup complete" /tmp/*.log 2>/dev/null | tail -1 | grep -oP '\d{8}-\d{6}' | head -1)
    if [ -n "$last_backup_log" ]; then
        echo "Último: Hoy $(echo $last_backup_log | cut -c10-11):$(echo $last_backup_log | cut -c12-13)"
    else
        echo "Último: Nunca (sin env vars)"
    fi

    if [ -n "${BACKUP_GDRIVE_FOLDER:-}" ]; then
        echo "Drive: ✅ Configurado"
    else
        echo "Drive: ⚠️ No configurado"
    fi

    echo "Próximo: Hoy 14:00"
}

check_tasks() {
    echo ""
    echo "✅ *Tareas programadas*"
    echo "Backup: 06:00, 14:00, 22:00"
    echo "Read Later: 02:00 diaria"
    echo "Ideas: 08:00 diaria"
}

check_gtasks() {
    echo ""
    if [ ! -d "/home/node/.gtasks" ]; then
        echo "⚠️ *Google Tasks*: No configurado"
        return
    fi

    echo "✅ *Google Tasks*"

    # Count tasks per list (safer approach)
    local p_count=$(source ~/.gtasks/env 2>/dev/null && gtasks tasks view -l "Personal" 2>/dev/null | grep "^-" | wc -l)
    local j_count=$(source ~/.gtasks/env 2>/dev/null && gtasks tasks view -l "JW" 2>/dev/null | grep "^-" | wc -l)
    local t_count=$(source ~/.gtasks/env 2>/dev/null && gtasks tasks view -l "Trabajo" 2>/dev/null | grep "^-" | wc -l)

    echo "Personal: ${p_count:-0} | JW: ${j_count:-0} | Trabajo: ${t_count:-0}"
}

check_readlater() {
    echo ""
    echo "✅ *Read Later*"

    local pending=$(grep -c "^##" "/workspace/extra/obsidian/00 Inbox/00 Read Later Links.md" 2>/dev/null || echo "0")
    local today=$(date +%Y%m%d)
    local processed=$(ls -1 "/workspace/extra/obsidian/00 Inbox/01 Read Later/${today}"*.md 2>/dev/null | wc -l)

    echo "$pending pendientes, $processed procesados hoy"
}

check_resources() {
    echo ""
    echo "💾 *Recursos*"

    local db_size=$(du -h /workspace/project/store/messages.db 2>/dev/null | cut -f1)
    local groups=$(grep -c '"folder"' /workspace/project/data/registered_groups.json 2>/dev/null || echo "0")

    echo "DB: ${db_size:-?} | Grupos: ${groups} activos"
}

check_alerts() {
    local has_alerts=false

    if [ -z "${BACKUP_GDRIVE_FOLDER:-}" ] || [ -z "${BACKUP_PASSPHRASE:-}" ]; then
        if [ "$has_alerts" = false ]; then
            echo ""
            echo "⚠️ *Alertas*"
            has_alerts=true
        fi
        echo "• Backup no sube a Drive (falta config)"
    fi
}

# MAIN
echo "📊 *Estado de NanoClaw* ($(now))"
echo ""
check_backups
check_tasks
check_gtasks
check_readlater
check_resources
check_alerts
