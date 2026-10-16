# colmena-mcp 🐝

Servidor MCP (stdio) para que **Claude Code orqueste y valide, como un product manager**, mientras una colmena de agentes obreros —**Codex** (Luna) y **OpenCode** (DeepSeek, etc.)— hace el trabajo pesado. Tú gastas pocos tokens: briefs cortos de ida, reportes de ≤15 líneas de vuelta.

- **Workers por alias** en un `colmena.yml`: proveedor + modelo + esfuerzo + prioridad + presupuesto. Las herramientas solo aceptan un alias, nunca un modelo o flag libre.
- **Presupuesto y ruteo:** el servidor cuenta el gasto por worker y por mes; sin `worker` explícito, elige el siguiente disponible por prioridad (y por `kind`).
- **Aislamiento por llamada:** `worktree` (rama `colmena/<id>`, por defecto en repos git), `inplace` o `readonly`.
- **Paralelismo con cola**, sesiones reanudables, resúmenes, compactación y relevo entre agentes.
- **Plugin `notify`:** toast de Windows al lanzar agentes, latido cada 10 min mientras haya trabajo, y aviso al terminar o fallar.
- **Plugin `report`:** al cerrar una ronda, un agente barato redacta un HTML bonito (estilo **papercraft**, extensible) de lo logrado.
- Sin base de datos: estado en `~/.colmena/` (`jobs/`, `worktrees/`, `reports/`, `usage.json`, `activity.log`, `audit.log`).

## Requisitos

Node ≥ 22, git, y al menos uno de: **Codex CLI** autenticado (necesitas una versión reciente si usas esfuerzo `max`; 0.162 funciona, 0.130 lo rechaza) y/o **OpenCode** (≥ 1.18). Los binarios se detectan solos (`codex.exe` más reciente de `%LOCALAPPDATA%\OpenAI\Codex\bin`; el `opencode.exe` real detrás del shim npm).

## Instalación

```bash
git clone https://github.com/jdsalasca/colmena-mcp.git
cd colmena-mcp
npm install
npm test
claude mcp add -s user colmena -- node "<ruta-absoluta>/colmena-mcp/src/server.js"
```

Humo real (gasta unas pocas llamadas): `npm run smoke -- luna-max,deepseek-flash --report`.

## Configuración: `colmena.yml`

Ubicación: `$COLMENA_CONFIG` o `~/.colmena/colmena.yml`. Sin archivo se usan los valores por defecto. Ejemplo completo en [`colmena.example.yml`](colmena.example.yml):

```yaml
workers:
  luna-max:       {provider: codex,    model: gpt-6-luna, effort: max, priority: 1, strengths: [code, refactor, tests]}
  deepseek-pro:   {provider: opencode, model: opencode-go/deepseek-v4-pro, effort: max, priority: 2, strengths: [code], budget: {monthly_usd: 10}}
  deepseek-flash: {provider: opencode, model: opencode-go/deepseek-v4.1-flash, priority: 3, strengths: [docs, summary, report]}
roles:    {reporter: deepseek-flash, summarizer: deepseek-flash, reviewer: luna-max}
defaults: {worker: luna-max, max_parallel: 4, timeout_min: 60}
plugins:
  notify: {enabled: true, on: [start, finish, fail], heartbeat_min: 10}
  report: {enabled: true, default_style: papercraft}
```

Notas:
- `effort` se pasa como `model_reasoning_effort` (Codex) o `--variant` (OpenCode).
- OpenCode informa el costo en USD de cada ejecución. **Codex no**: para contabilizarlo añade `price_per_mtok: {input: …, output: …}` al worker.
- El saldo real de tus cuentas no se puede consultar por API: el presupuesto es **declarativo + conteo local** (`usage.json`).
- OpenCode carga mucho contexto propio (~50k tokens de entrada por ejecución, ≈ $0.007 en flash y ≈ $0.034 en pro): conviene delegarle tareas con cierto peso.

### Variables de entorno
`COLMENA_HOME`, `COLMENA_CONFIG`, `COLMENA_CODEX_BIN`, `COLMENA_OPENCODE_BIN`, `COLMENA_MAX_PARALLEL`, `COLMENA_JOB_TIMEOUT_MIN`, `COLMENA_NOTIFIER` (`toast`|`log`|`none`). Los nombres `LUNA_*` de la v0.1 se siguen aceptando.

## Herramientas

| Tool | Para qué |
|---|---|
| `workers` | Workers con prioridad, fortalezas, gasto del mes, restante y disponibilidad |
| `run` / `run_many` | Lanza uno o varios agentes (`worker?`, `kind?`, `isolation?`, `wait: true` espera el reporte) |
| `wait`, `status`, `list` | Seguimiento (`wait` máx. 600 s, `mode: any|all`) |
| `result` | Reporte `RESULT/FILES/TESTS/RISKS`, archivos, diffstat, rama, worker y costo |
| `diff` | Diff truncado; el completo queda en disco |
| `continue` | Reanuda la sesión (mismo worker y workdir) |
| `summarize`, `compact` | Resumen / brief de relevo de una sesión (rol `summarizer`) |
| `handoff` | Agente nuevo con los resúmenes de otros como contexto |
| `review` | Revisión solo lectura de un job o cwd (rol `reviewer`) |
| `cancel` | Cancela y mata el árbol de procesos |
| `merge` | Fusiona `colmena/<id>` (manual; se niega con destino sucio; restaura ante conflictos) |
| `cleanup` | Borra worktrees y ramas `colmena/*` propios (`force` para descartar trabajo no fusionado) |
| `report` | HTML de cierre de ronda (`job_ids`, `style?`, `title?`, `open?`) |

Flujo recomendado: `workers` → `run_many` → `wait` → `result` → `review`/`diff` → `merge` → `report` → `cleanup`. La skill [`skills/colmena-delegation`](skills/colmena-delegation/SKILL.md) explica cómo redactar los briefs.

## Notificaciones
Con `plugins.notify` activo recibes un toast de Windows agrupado al lanzar agentes, un latido (`N corriendo · M en cola · X min · $Y`) cada `heartbeat_min` mientras haya algo corriendo (nunca en silencio inútil: sin trabajo no hay latido), y un aviso al terminar o fallar. Todo queda también en `~/.colmena/activity.log`.

## Estilos de reporte
Un estilo es una carpeta `styles/<nombre>/` con `style.md` (instrucciones para el agente reportero) y `template.html` (plantilla con marcadores `{{title}}`, `{{jobs}}`… y `<!--COLMENA:CARDS-->`). Se buscan primero en `~/.colmena/styles/` y luego en el repo. Si el reportero falla, un renderizador determinista rellena la plantilla (`usedFallback: true`). Incluido: **papercraft**.

## Seguridad
Los agentes corren **sin sandbox ni aprobaciones** (Codex: `--dangerously-bypass-approvals-and-sandbox`; OpenCode: `--auto`). Con `inplace` un agente puede modificar o borrar cualquier archivo accesible a tu usuario. Por eso `worktree` es el valor por defecto en repos git, `merge` nunca se ejecuta solo, `cleanup` solo toca `colmena/*` bajo `COLMENA_HOME/worktrees`, el YAML no admite flags arbitrarios y cada lanzamiento queda en `audit.log`. `readonly` es real: `-s read-only` en Codex y `--agent plan` en OpenCode (verificado). Úsalo solo en repos y máquinas de confianza.

## Desarrollo
`npm test` usa proveedores falsos (`test/fake-codex.js`, `test/fake-opencode.js`) y repos git temporales; no gasta llamadas reales.
Diseño: `docs/superpowers/specs/` · Planes: `docs/superpowers/plans/`.

Licencia MIT.
