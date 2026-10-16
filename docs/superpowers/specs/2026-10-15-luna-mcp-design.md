# luna-mcp — Diseño

Fecha: 2026-10-15 · Estado: pendiente de revisión del usuario

## 1. Propósito y criterio de éxito

Un servidor MCP global (stdio) que permite a Claude Code actuar como **orquestador** y delegar la implementación a agentes **`gpt-6-luna` con `model_reasoning_effort="max"`** vía Codex CLI, gastando pocos tokens del orquestador.

Éxito =
1. Claude lanza uno o varios agentes Luna con un brief corto y recibe de vuelta un reporte de ≤ ~300 tokens por defecto.
2. Los agentes editan código de forma aislada (worktree) y en paralelo sin pisarse.
3. Se pueden reanudar, resumir, compactar y encadenar sesiones (relevo de resumen de un agente a otro).
4. Los agentes corren sin aprobaciones y con acceso a internet.
5. Se instala una vez, globalmente, y funciona desde cualquier proyecto.

No-objetivos (YAGNI): UI, base de datos, soporte multi-modelo (el modelo es fijo), reimplementar un agente, autenticación propia.

## 2. Hechos verificados del entorno

- Codex CLI `0.130.0-alpha.5` en `C:\Users\jdsal\AppData\Local\OpenAI\Codex\bin\codex.exe` (no está en PATH; el servidor lo resuelve por variable `LUNA_CODEX_BIN` con ese valor por defecto).
- `~/.codex/config.toml` ya fija `model = "gpt-6-luna"`, `model_reasoning_effort = "max"`, `sandbox_mode = "danger-full-access"`, `approval_policy = "on-request"`. `models_cache.json` lista `gpt-6-luna`.
- `codex exec` soporta `--json`, `-m`, `-c k=v`, `-s <sandbox>`, `-C <dir>`, `-o <archivo>`, `--output-schema`, `--ephemeral`, `--dangerously-bypass-approvals-and-sandbox` y el subcomando `exec resume`.
- La autenticación ya existe (`~/.codex/auth.json`); el servidor no maneja credenciales.

**Por verificar en la Tarea 0 del plan** (spike de 15 min, no se asume): forma exacta de los eventos de `exec --json` (id de sesión, mensaje final, uso de tokens), nombre del flag/config de búsqueda web en esta versión, y comportamiento de `exec resume` con `-C`/`-o`.

## 3. Arquitectura

```
Claude Code ──stdio MCP──► luna-mcp (Node 24, ESM, @modelcontextprotocol/sdk, zod)
                              ├─ runner      spawn codex exec, parsea JSONL, mata árbol de procesos
                              ├─ jobs        ciclo de vida + estado en disco
                              ├─ isolation   worktree | inplace | readonly
                              ├─ briefing    sufijo de reporte compacto, handoff, compact
                              └─ tools       capa MCP delgada sobre lo anterior
```

Ubicación: repo `Programming-personal/luna-mcp`. Datos en `~/.luna-mcp/` (`jobs/`, `worktrees/`, `audit.log`). Registro único con `claude mcp add -s user luna -- node <repo>/src/server.js`.

Unidades (una responsabilidad cada una, probables por separado):
- **runner**: `start(spec) → handle`, emite eventos, `cancel()`. Depende solo de `child_process` y del binario codex.
- **jobs**: crea/lee/actualiza `~/.luna-mcp/jobs/<id>/{meta.json,events.jsonl,last_message.md,summary.md}`. Máquina de estados: `queued → running → done | failed | cancelled | orphaned`. Cola con tope de concurrencia (4 por defecto, `LUNA_MAX_PARALLEL`).
- **isolation**: prepara el directorio de trabajo y calcula diff/archivos tocados.
- **briefing**: construye el prompt final (brief + contexto + sufijo de formato) y los prompts de resumen/compactación.

## 4. Lanzamiento de un agente

Comando base (el modelo y esfuerzo se **fijan siempre**, ningún parámetro de tool los cambia):

```
codex exec --json -m gpt-6-luna -c model_reasoning_effort="max"
  --dangerously-bypass-approvals-and-sandbox   (omitido en readonly: -s read-only)
  <búsqueda web en vivo, flag a fijar en Tarea 0>
  -C <dir de trabajo> -o <jobdir>/last_message.md   "<prompt>"
```

El `session id` salido de los eventos se guarda en `meta.json` para `luna_continue`.

## 5. Aislamiento (`isolation`, por llamada)

- `worktree` (por defecto si `cwd` es repo git): `git worktree add ~/.luna-mcp/worktrees/<repo>-<id> -b luna/<id>` desde HEAD. Si el árbol tiene cambios sin commitear, se avisa en el resultado (el worktree parte de HEAD; no se copian cambios sin commitear).
- `inplace`: trabaja en `cwd`.
- `readonly`: `-s read-only` en `cwd`; para investigar/revisar.
- Fuera de un repo git, `worktree` falla con error claro y se sugiere `inplace` o `readonly`.

## 6. Herramientas MCP

Todas devuelven JSON compacto. `detail: "min" | "normal" | "full"` (por defecto `min`); lo pesado queda en disco y se devuelve la ruta.

| Tool | Entrada principal | Salida (min) |
|---|---|---|
| `luna_run` | `task`, `cwd?`, `isolation?`, `context_files?`, `handoff_from?: id[]`, `wait?` | `job_id` (o reporte si `wait`) |
| `luna_run_many` | `tasks: [{task, cwd?, isolation?, ...}]` | `job_ids[]` |
| `luna_status` | `job_id` | estado, tiempo, última actividad |
| `luna_list` | `state?`, `limit?` | tabla corta |
| `luna_wait` | `job_ids[]`, `timeout_s?`, `mode: "any"|"all"` | estados + reportes ≤15 líneas |
| `luna_result` | `job_id`, `detail?` | RESULT/FILES/TESTS/RISKS, rama, diffstat |
| `luna_diff` | `job_id`, `max_chars?` | diff truncado + ruta al diff completo |
| `luna_continue` | `job_id`, `message` | nuevo `job_id` (reanuda sesión con `exec resume`) |
| `luna_summarize` | `job_id`, `focus?` | resumen corto generado por Luna (`readonly`, `--ephemeral`) |
| `luna_compact` | `job_id` | brief persistido en `summary.md` y su ruta; reduce el transcript para handoff |
| `luna_handoff` | `from: id[]`, `task`, ... | como `luna_run`, con los `summary.md` de `from` inyectados |
| `luna_review` | `job_id` o `cwd`, `focus?` | hallazgos cortos (`codex review`, read-only) |
| `luna_cancel` | `job_id` | estado final |
| `luna_merge` | `job_id`, `strategy?: "merge"|"squash"` | resultado del merge de `luna/<id>` a la rama actual de `cwd` |
| `luna_cleanup` | `job_id?` / `older_than_days?` | worktrees y ramas eliminados |

`luna_merge` jamás se invoca automáticamente; aborta si el árbol de destino tiene cambios sin commitear y reporta conflictos sin resolverlos. `luna_cleanup` solo borra worktrees/ramas creados por este servidor (`luna/*` bajo `~/.luna-mcp/worktrees/`).

## 7. Economía de tokens

- Sufijo fijo en cada prompt: el último mensaje del agente debe ser un reporte de ≤15 líneas con secciones `RESULT`, `FILES`, `TESTS`, `RISKS`. `luna_result` devuelve ese reporte tal cual (con validación mínima de que las secciones existan; si faltan, se devuelve el último mensaje truncado).
- Logs completos, diffs y transcripts solo en disco; el orquestador pide detalle explícitamente.
- Ejecución en segundo plano: `luna_run` retorna el `job_id` de inmediato; `luna_wait` bloquea con timeout acotado (por defecto 120 s, máximo 600 s) para encajar con los límites de llamada MCP.

## 8. Errores y robustez

- Timeout por trabajo (`LUNA_JOB_TIMEOUT_MIN`, por defecto 60); al vencer se cancela y queda `failed` con motivo.
- `cancel` y timeout matan el árbol de procesos (`taskkill /PID <pid> /T /F`).
- Al iniciar el servidor, los trabajos `running` sin proceso vivo pasan a `orphaned`.
- Errores de codex (auth, modelo no disponible, exit != 0) se reflejan en `meta.json` con las últimas 20 líneas de stderr; el tool devuelve mensaje corto accionable.
- Salida JSONL malformada: se ignora la línea, se registra, no se aborta.
- `audit.log`: una línea JSON por lanzamiento (id, cwd, isolation, hash del brief, timestamps).

## 9. Seguridad

Los agentes corren **sin sandbox ni aprobaciones** (decisión del usuario). Mitigaciones: `worktree` por defecto en repos git; `luna_merge` siempre manual; cleanup limitado a rutas propias; auditoría; `readonly` disponible. Riesgo residual aceptado: en `inplace` un agente puede modificar o borrar cualquier archivo accesible al usuario.

## 10. Pruebas

- **Unitarias** (runner de pruebas nativo de Node) contra un `codex` falso (script que emite JSONL controlable): ciclo de vida, cola y concurrencia, cancelación, timeout, orphaned, formateo del reporte, construcción de prompts.
- **Integración con git temporal**: creación/limpieza de worktrees, diff, merge y rechazo con árbol sucio.
- **Humo real** (manual, marcado): un `luna_run` readonly trivial contra `gpt-6-luna` verificando modelo y esfuerzo en los eventos.
- Verificación antes de dar por terminado: salida real de los comandos.

## 11. Entregables extra

- Skill `luna-delegation` (global) para el orquestador: cómo redactar briefs cortos, cuándo usar `run` / `run_many` / `handoff`, y el flujo run → wait → result → review → merge.
- README corto con instalación y variables de entorno (`LUNA_CODEX_BIN`, `LUNA_MAX_PARALLEL`, `LUNA_JOB_TIMEOUT_MIN`, `LUNA_HOME`).

## 12. Decisiones registradas

Nombre `luna-mcp`; Node 24 en vez de Python; modelo/esfuerzo fijos; aislamiento configurable por llamada con `worktree` por defecto; merge manual; sin base de datos.

## 13. Resultados de la Tarea 0 (verificados 2026-10-15)

- `codex.exe` 0.130 (`bin\codex.exe`) **rechaza** `model_reasoning_effort = "max"`; 0.162 (`bin\<hash>\codex.exe`) lo acepta. El servidor elige el `codex.exe` más reciente por mtime.
- Eventos reales de `exec --json`: `thread.started{thread_id}`, `turn.started`, `item.completed{item:{type:"agent_message",text}}`, `turn.completed{usage}`.
- Búsqueda web: flag global `--search` (va **antes** de `exec`).
- `exec` espera stdin si no se cierra: el runner lo lanza con stdin ignorado.
- Humo real con `gpt-6-luna`: OK (`scripts/smoke.js`).
