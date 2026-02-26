# NanoClaw Backup System

Sistema de backup automático para bases de datos, grupos y configuración de NanoClaw.

## Componentes

### Scripts

1. **backup-create.sh** - Crea backup encriptado
   - Copia bases de datos, groups, config, logs
   - Genera manifest + checksums
   - Crea TAR.GZ encriptado con OpenSSL (AES-256)
   - Sube a Google Drive via google-workspace skill
   - Limpia backups antiguos (mantiene últimos 21)

2. **backup-restore.sh** - Restaura backup
   - Modos: --list, --preview, --restore, --force
   - Descarga de Google Drive
   - Desencripta y valida integridad
   - Restaura archivos a ubicaciones originales

3. **backup-drill.sh** - Validación de integridad
   - Valida último backup sin modificar filesystem
   - Prueba download, decrypt, extract, checksums
   - Logs a drill.log

### Tareas Programadas

- **06:00 diario** - Backup automático
- **14:00 diario** - Backup automático
- **22:00 diario** - Backup automático
- **23:00 domingos** - Integrity drill

Retención: 21 backups (7 días × 3/día)

## Configuración

Añadir a `/Users/danielmunoz/.nanoclaw/.env`:

```bash
# Passphrase para encriptar backups
NANOCLAW_BACKUP_PASSPHRASE="tu-passphrase-seguro-aqui"

# ID de carpeta en Google Drive donde guardar backups
NANOCLAW_BACKUP_DRIVE_FOLDER="id-de-carpeta-drive"
```

## Setup Inicial

1. **Crear carpeta en Google Drive:**
   ```bash
   # Desde NanoClaw container:
   node /home/node/.claude/skills/google-workspace/google-workspace.js drive create-folder \
     --account google \
     --name "NanoClaw Backups"
   ```
   Anota el ID de la carpeta creada.

2. **Configurar variables de entorno** (en host Mac):
   ```bash
   echo 'NANOCLAW_BACKUP_PASSPHRASE="mi-passphrase-super-seguro"' >> ~/.nanoclaw/.env
   echo 'NANOCLAW_BACKUP_DRIVE_FOLDER="id-carpeta-drive"' >> ~/.nanoclaw/.env
   ```

3. **Reiniciar NanoClaw** para cargar las variables.

4. **Probar backup manual:**
   ```bash
   /workspace/group/tasks/nanoclaw-backup/backup-create.sh
   ```

## Uso

### Listar backups disponibles
```bash
/workspace/group/tasks/nanoclaw-backup/backup-restore.sh --list
```

### Ver qué contiene un backup
```bash
/workspace/group/tasks/nanoclaw-backup/backup-restore.sh --preview nanoclaw-backup-20260225-060000
```

### Restaurar backup (con confirmación)
```bash
/workspace/group/tasks/nanoclaw-backup/backup-restore.sh --restore nanoclaw-backup-20260225-060000
```

### Restaurar backup (sin confirmación)
```bash
/workspace/group/tasks/nanoclaw-backup/backup-restore.sh --force nanoclaw-backup-20260225-060000
```

### Probar integridad
```bash
/workspace/group/tasks/nanoclaw-backup/backup-drill.sh
cat /workspace/group/tasks/nanoclaw-backup/drill.log
```

## Estructura del Backup

```
nanoclaw-backup-YYYYMMDD-HHMMSS.zip.gpg
└── nanoclaw-backup-YYYYMMDD-HHMMSS/
    ├── manifest.json          # Metadata del backup
    ├── checksums.sha256       # Para validar integridad
    ├── databases/             # Archivos .db y .sqlite
    │   └── messages.db
    ├── groups/                # Todo /workspace/project/groups/
    │   ├── main/
    │   └── global/
    ├── config/                # Configuración
    │   ├── registered_groups.json
    │   └── accounts/
    └── *.jsonl               # Event logs (si existen)
```

## Pendiente

- [ ] Implementar download desde Google Drive en restore/drill scripts
- [ ] Añadir notificaciones en caso de fallo de backup
- [ ] Dashboard con status último backup
- [ ] Backup incremental (actualmente siempre full)

## Notas

- Backups encriptados con GPG AES256
- Passphrase debe ser fuerte (20+ caracteres)
- Mantiene últimos 21 backups (auto-cleanup)
- Drill semanal valida que restore funcione
- **IMPORTANTE**: Guardar passphrase en lugar seguro (password manager)
