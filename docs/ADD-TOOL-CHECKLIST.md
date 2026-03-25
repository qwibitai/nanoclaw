# Checklist: Agregar una nueva tool/skill al agente

## 1. Crear el skill

```
container/skills/<nombre>/SKILL.md    # Metadata + docs
container/skills/<nombre>/<script>    # Script ejecutable
chmod +x container/skills/<nombre>/<script>
```

## 2. Dockerfile

Agregar en `container/Dockerfile`:
```dockerfile
COPY skills/<nombre>/<script> /usr/local/bin/<script>
RUN chmod +x /usr/local/bin/<script>
```

## 3. Env vars (si la tool necesita API keys)

**Tres lugares, ninguno es opcional:**

a) **`.env` local** — agregar la key
b) **`src/container-runner.ts`** — agregar lectura y pasaje al container:
```ts
const myKey = readEnvFile(['MY_KEY']).MY_KEY;
if (myKey) envLines.push(`MY_KEY=${myKey}`);
```
c) **`.env` en PRODUCCION** — SSH y agregar manualmente:
```bash
ssh root@134.199.239.173 "cat >> /home/nanoclaw/app/.env << 'EOF'
MY_KEY=valor
EOF"
```

## 4. Documentar en CLAUDE.md

Agregar en `groups/global/CLAUDE.md` sección "What You Can Do":
```
- **Descripcion** — use `<script> <args>` para hacer X
```

## 5. Build y deploy

```bash
# Local
npm run build
git add . && git commit && git push

# Prod (TODOS los pasos, sin excepcion)
ssh root@134.199.239.173
su - nanoclaw -c 'cd /home/nanoclaw/app && git fetch origin main && git stash && git merge origin/main --no-edit && git stash pop 2>/dev/null; true'
su - nanoclaw -c 'cd /home/nanoclaw/app && npm run build'    # NUNCA olvidar
grep <NUEVA_FUNCION> dist/<archivo>.js                        # VERIFICAR que compilo
docker builder prune -f && ./container/build.sh               # Si cambio Dockerfile
docker ps -q | xargs -r docker kill                           # Matar containers stale
systemctl restart nanoclaw
```

## 6. Verificar

- [ ] Script funciona localmente con la env var
- [ ] `dist/` tiene los cambios compilados
- [ ] `.env` de prod tiene la key
- [ ] Container tiene el script en `/usr/local/bin/`
- [ ] CLAUDE.md documenta la tool
- [ ] Probar end-to-end mandando mensaje al bot
