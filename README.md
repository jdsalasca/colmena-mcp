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

Humo real (gasta unas pocas llamadas): `npm run smoke -- luna-max,ds-flash --report`.

## Configuración: `colmena.yml`

Ubicación: `$COLMENA_CONFIG` o `~/.colmena/colmena.yml`. Sin archivo se usan los valores por defecto. Ejemplo completo en [`colmena.example.yml`](colmena.example.yml):

```yaml
workers:
  luna-max:       {provider: codex,    model: gpt-6-luna, effort: max, priority: 1, strengths: [code, refactor, tests]}
  ds-flash:       {provider: opencode, model: opencode-go/deepseek-v4.1-flash, effort: max, priority: 2, strengths: [code, docs, summary, report], budget: {monthly_usd: 10}}
  max-hive:       {provider: opencode, model: opencode-go/muse-spark-1.3-contributor, effort: high, priority: 9, strengths: [bulk], budget: {monthly_usd: 5}}
roles:    {reporter: ds-flash, summarizer: ds-flash, reviewer: luna-max}
defaults: {worker: luna-max, max_parallel: 4, timeout_min: 60}
plugins:
  notify: {enabled: true, on: [start, finish, fail], heartbeat_min: 10}
  report: {enabled: true, default_style: papercraft}
standards:
  enabled: true
  # preamble: |-
  #   Personaliza el preámbulo español integrado para tus jobs run.
providers:
  opencode:
    isolate_config: true
    # config_dir: C:/Users/tu-usuario/.colmena/opencode-config
```

Notas:
- `standards.enabled` activa el preámbulo de trabajo para `run` (TDD, código limpio/DRY, reutilización, evidencia y formato de reporte). Los helpers `summarize`, `compact`, `review` y `report` no lo reciben. Edita el YAML y llama a `reload_config` para aplicar workers, roles, defaults, plugins y proveedores sin reiniciar; `COLMENA_MAX_PARALLEL` y `COLMENA_JOB_TIMEOUT_MIN` conservan prioridad sobre el YAML.
- `stats {since_days?}` resume jobs, éxito, duración, costo, tokens, workers, tipos y fallos de la ventana indicada (30 días por defecto).
- `effort` se pasa como `model_reasoning_effort` (Codex) o `--variant` (OpenCode).
- `providers.opencode.isolate_config` está activo por defecto: OpenCode usa `$COLMENA_HOME/opencode-config` como `XDG_CONFIG_HOME`. Así no hereda los servidores MCP, plugins, agentes, `AGENTS.md` ni skills de la configuración global del usuario; los estándares de Colmena llegan por el preámbulo. La autenticación se conserva en `XDG_DATA_HOME`. Define `config_dir` para usar una configuración mínima propia (la carpeta se crea si falta), o `isolate_config: false` para volver a usar la configuración habitual.
- Evidencia de la comparación reportada para una ejecución trivial: el contexto de entrada bajó de ~47k a ~8k tokens; `opencode-go/deepseek-v4.1-flash` bajó de $0.0074 a $0.0011 por ejecución; y `opencode-go/cat-jam-free`, que fallaba globalmente con `maximum number of items is 128`, respondió con costo reportado `0`. La configuración global también hizo que un job usara `chatgpt-coordinator` durante más de 10 minutos y se observó `ProviderHeaderTimeoutError` en `step-5-preview`.
- OpenCode informa el costo en USD de cada ejecución. **Codex no**: para contabilizarlo añade `price_per_mtok: {input: …, output: …}` al worker.
- El saldo real de tus cuentas no se puede consultar por API: el presupuesto es **declarativo + conteo local** (`usage.json`).
- **Regla de reparto:** Luna va **solo por Codex** (`luna-max`). En OpenCode Go el worker principal es **DeepSeek V4.1 Flash** (`ds-flash`, $0.15 entrada / $0.60 salida por Mtok, revisado 2026-10-16), con presupuesto mensual. No se usa Luna a través de OpenCode.
- OpenCode carga mucho contexto propio (~30-50k tokens por ejecución): conviene delegarle tareas con cierto peso.

### max-hive: maximizar tareas en paralelo a costo ~0
`max-hive` es el worker para **maximizar muchas tareas pequeñas en paralelo con costo cercano a cero** (tests masivos, generación repetitiva, migraciones mecánicas, auditorías por archivo, borradores). Usa un modelo **"contributor"** del plan Go: sin *zero data retention* (no le mandes secretos ni código sensible) y con calidad menor que `luna-max`, así que **lo que produce lo valida el orquestador** (`review`/`diff`) antes de fusionar. Tiene prioridad 9 y fortaleza `bulk`: el router solo lo elige si lo pides (`worker: "max-hive"` o `kind: "bulk"`) o si no queda otro disponible.
- **Evita los modelos `-free`:** traen cuota; `max-hive` busca modelos *contributor* del plan Go.
- **Costo ~0 no es verificable desde aquí:** OpenCode reporta un costo nominal por ejecución (≈ $0.004 con `muse-spark-1.3-contributor`; `gemini-4-argon-contributor` ≈ $0.16, ¡caro!). Si tu plan Go lo cubre es cosa de tu cuenta; por eso `max-hive` lleva un tope de seguridad (`budget.monthly_usd`) que el contador local respeta.
- **Cómo buscarle otro modelo (para Claude):** `node scripts/opencode-models.mjs --contributor` lista los *contributor* del más barato al más caro; `--max-out 0.6 --json` filtra por precio. Elige el más barato con ventana de contexto suficiente, cambia `model`/`effort` en `colmena.yml` (si no ofrece `max`, usa su mejor variante), llama `reload_config`, y valídalo con una ejecución real (`run` con `worker: "max-hive"`, `isolation: "readonly"`) revisando `cost_usd` y que el reporte salga en formato RESULT/FILES/TESTS/RISKS.

### Variables de entorno
`COLMENA_HOME`, `COLMENA_CONFIG`, `COLMENA_CODEX_BIN`, `COLMENA_OPENCODE_BIN`, `COLMENA_MAX_PARALLEL`, `COLMENA_JOB_TIMEOUT_MIN`, `COLMENA_NOTIFIER` (`toast`|`log`|`none`). Los nombres `LUNA_*` de la v0.1 se siguen aceptando.

## Herramientas

| Tool | Para qué |
|---|---|
| `workers` | Workers con prioridad, fortalezas, gasto del mes, restante y disponibilidad |
| `stats` | Resumen histórico por estado, worker y tipo (`since_days`, defecto 30) |
| `reload_config` | Relee y valida `colmena.yml`; jobs posteriores usan los cambios sin reiniciar |
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
Los agentes tienen internet por defecto: Codex con `--search` y OpenCode con `webfetch`; el preámbulo les pide consultar documentación y versiones actuales cuando dependan de una API o dato externo y citar la fuente. También corren **sin sandbox ni aprobaciones** (Codex: `--dangerously-bypass-approvals-and-sandbox`; OpenCode: `--auto`). Con `inplace` un agente puede modificar o borrar cualquier archivo accesible a tu usuario. Por eso `worktree` es el valor por defecto en repos git, `merge` nunca se ejecuta solo, `cleanup` solo toca `colmena/*` bajo `COLMENA_HOME/worktrees`, el YAML no admite flags arbitrarios y cada lanzamiento queda en `audit.log`. `readonly` es real: `-s read-only` en Codex y `--agent plan` en OpenCode (verificado). Úsalo solo en repos y máquinas de confianza.

## Desarrollo
`npm test` usa proveedores falsos (`test/fake-codex.js`, `test/fake-opencode.js`) y repos git temporales; no gasta llamadas reales.
Diseño: `docs/superpowers/specs/` · Planes: `docs/superpowers/plans/`.

Licencia MIT.
