# colmena-mcp 🐝

Servidor MCP (stdio) para que **Claude Code orqueste y valide, como un product manager**, mientras una colmena de agentes obreros —**Codex** (Luna) y **OpenCode** (DeepSeek, etc.)— hace el trabajo pesado. Tú gastas pocos tokens: briefs cortos de ida, reportes de ≤15 líneas de vuelta.

- **Workers por alias** en un `colmena.yml`: proveedor + modelo + esfuerzo + prioridad + presupuesto y, opcionalmente, `free: true` para registrar costo cero. Las herramientas solo aceptan un alias, nunca un modelo o flag libre.
- **Presupuesto y ruteo:** el servidor cuenta el gasto por worker y por mes; un worker `free` conserva el costo nominal aparte y no queda bloqueado por presupuesto. Sin `worker` explícito, elige el proveedor preferido disponible y luego aplica `kind` y prioridad.
- **Aislamiento por llamada:** `worktree` (rama `colmena/<id>`, por defecto en repos git), `inplace` o `readonly`.
- **Paralelismo con cola**, sesiones reanudables, resúmenes, compactación y relevo entre agentes.
- **Plugin `notify`:** toast de Windows al lanzar agentes, latido cada 10 min mientras haya trabajo, y aviso al terminar o fallar.
- **Plugins `report` y `present`:** crean un reporte HTML de la ronda y una presentación papercraft de cierre del hito, respectivamente.
- **Mejora continua:** `improve` lanza un agente que deja en `docs/backlog/` ítems priorizados con briefs listos para delegar; `report` y `wait` te invitan cuando toca.
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
roles:    {reporter: ds-flash, summarizer: ds-flash, reviewer: luna-max, presenter: luna-max}
defaults: {worker: luna-max, max_parallel: 4, timeout_min: 60}
preferences: {provider: auto} # codex | opencode para priorizar un proveedor sin reiniciar
plugins:
  notify: {enabled: true, on: [start, finish, fail], heartbeat_min: 10}
  report: {enabled: true, default_style: papercraft}
  present: {enabled: true, default_style: papercraft-deck}
  improve: {enabled: true, hints: true}
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
- `standards.enabled` activa el preámbulo de trabajo para `run` (TDD, código limpio/DRY, reutilización, evidencia y formato de reporte). Los helpers `summarize`, `compact`, `review`, `report` y `present` no lo reciben. Edita el YAML y llama a `reload_config` para aplicar workers, roles, defaults, plugins y proveedores sin reiniciar; `COLMENA_MAX_PARALLEL` y `COLMENA_JOB_TIMEOUT_MIN` conservan prioridad sobre el YAML.
- `preferences.provider` acepta `auto` (ruteo actual), `codex` u `opencode`. La tool `preferences` consulta la preferencia y el worker elegido ahora, o la cambia en memoria y en el YAML efectivo (`COLMENA_CONFIG` o `$COLMENA_HOME/colmena.yml`) para el siguiente `run`; no requiere reinicio. Si no hay workers disponibles de ese proveedor, el router usa otro y devuelve un `note`. `worker` explícito siempre manda; las tools auxiliares continúan usando sus roles.
- `workers` muestra `free` por worker; `stats {since_days?}` resume jobs, éxito, duración, costo registrado y `nominalCostUsd` por worker, tokens, tipos y fallos de la ventana indicada (30 días por defecto).
- `workers.<alias>.free: true` declara que el modelo de ese worker está cubierto a costo cero: el ledger registra `cost_usd: 0`, `meta.json` conserva `nominalCostUsd` y `result` muestra `cost_usd: 0` junto con `nominal_cost_usd`. El flag exime al worker de su presupuesto mensual. Úsalo solo si tu plan garantiza el costo cero; el costo nominal sigue visible para auditar lo que reportó el proveedor.
- `meta.json`, `status` y `result` conservan `model`, `provider` y `effort` del worker seleccionados al crear cada job, aunque la configuración se recargue después.
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
- **Costo ~0 no es verificable desde aquí:** OpenCode reporta un costo nominal por ejecución (≈ $0.004 con `muse-spark-1.3-contributor`; `gemini-4-argon-contributor` ≈ $0.16, ¡caro!). Si tu plan Go cubre un modelo a costo cero, añade `free: true` a ese worker: Colmena registrará costo `0`, preservará el nominal reportado y no lo bloqueará por presupuesto. Esto refleja tu declaración local, no verifica la factura real de tu cuenta. `max-hive` mantiene su tope de seguridad mientras no se marque `free`.
- **Cómo buscarle otro modelo (para Claude):** `node scripts/opencode-models.mjs --contributor` lista los *contributor* del más barato al más caro; `--max-out 0.6 --json` filtra por precio. Elige el más barato con ventana de contexto suficiente, cambia `model`/`effort` en `colmena.yml` (si no ofrece `max`, usa su mejor variante), llama `reload_config`, y valídalo con una ejecución real (`run` con `worker: "max-hive"`, `isolation: "readonly"`) revisando `cost_usd` y que el reporte salga en formato RESULT/FILES/TESTS/RISKS.

### Variables de entorno
`COLMENA_HOME`, `COLMENA_CONFIG`, `COLMENA_CODEX_BIN`, `COLMENA_OPENCODE_BIN`, `COLMENA_MAX_PARALLEL`, `COLMENA_JOB_TIMEOUT_MIN`, `COLMENA_NOTIFIER` (`toast`|`log`|`none`). Los nombres `LUNA_*` de la v0.1 se siguen aceptando.

## Herramientas

| Tool | Para qué |
|---|---|
| `workers` | Workers con prioridad, fortalezas, preferencia (`preferred`), gasto del mes, restante y disponibilidad |
| `preferences` | Consulta o cambia en caliente `auto` / `codex` / `opencode`; muestra también el worker que elegiría el router |
| `stats` | Resumen histórico por estado, worker y tipo (`since_days`, defecto 30) |
| `reload_config` | Relee y valida `colmena.yml`; jobs posteriores usan los cambios sin reiniciar |
| `run` / `run_many` | Lanza uno o varios agentes (`worker?`, `kind?`, `isolation?`, `wait: true` espera el reporte) |
| `wait`, `status`, `list` | Seguimiento (`wait` máx. 600 s, `mode: any/all`; añade `hint` de mejora continua al cerrar una ronda) |
| `result` | Reporte `RESULT/FILES/TESTS/RISKS`, archivos, diffstat, rama, worker, modelo, proveedor, esfuerzo y costos registrado/nominal |
| `diff` | Diff truncado; el completo queda en disco |
| `continue` | Reanuda la sesión (mismo worker y workdir) |
| `summarize`, `compact` | Resumen / brief de relevo de una sesión (rol `summarizer`) |
| `handoff` | Agente nuevo con los resúmenes de otros como contexto |
| `review` | Revisión solo lectura de un job o cwd (rol `reviewer`) |
| `cancel` | Cancela y mata el árbol de procesos |
| `merge` | Fusiona `colmena/<id>` (manual; se niega con destino sucio; restaura ante conflictos) |
| `cleanup` | Borra worktrees y ramas `colmena/*` propios (`force` para descartar trabajo no fusionado) |
| `report` | HTML de cierre de ronda (`job_ids`, `style?`, `title?`, `open?`); `next` sugiere `present` e indica lo que falta de `improve` |
| `present` | Presentación HTML papercraft de un hito (`job_ids`, `title?`, `subtitle?`, `notes?`, `style?`, `open?`) |
| `improve` | Mejora continua: agente en worktree que escribe `docs/backlog/<fecha>-<focus>.md` (backlog/features/debt/all) con briefs listos para delegar |

Flujo recomendado: `workers` → `run_many` → `wait` → `result` → `review`/`diff` → `merge` → `report` → `present` → auditar el deck → `improve`. La skill [`skills/colmena-delegation`](skills/colmena-delegation/SKILL.md) explica cómo redactar los briefs y validar la presentación antes de compartirla.

## Notificaciones
Con `plugins.notify` activo recibes un toast de Windows agrupado al lanzar agentes, con el proveedor visible (`luna-max (codex)`), y un latido cada `heartbeat_min` mientras haya trabajos corriendo o en cola. Los avisos de término y fallo identifican el proveedor (`[codex] luna-max`). Todas las notificaciones terminan con un overview actualizado por proveedor, por ejemplo `En curso: codex 2 · opencode 1 · +1 en cola`, o `En curso: ninguno` cuando no queda trabajo. Sin trabajo no hay latido. El cuerpo del toast respeta el límite de 300 caracteres y acorta la tarea para conservar el overview. Todo queda también en `~/.colmena/activity.log`.

## Estilos HTML
Cada estilo es una carpeta `styles/<nombre>/` con `style.md` y `template.html`; se buscan primero en `~/.colmena/styles/` y luego en el repo. **`papercraft`** genera reportes de ronda con tarjetas y **`papercraft-deck`** genera presentaciones por diapositivas. Si el agente de cualquiera de las tools falla o produce HTML inválido, se rellena la plantilla con un renderizador determinista (`usedFallback: true`).

## Presentaciones de hitos
`present {job_ids, title?, subtitle?, notes?, style?, open?}` delega la redacción al rol `presenter` (por defecto `luna-max`, Codex) y crea `<COLMENA_HOME>/reports/<fecha>-<slug>-deck/deck.html`, junto con `data.json` con los jobs, métricas y notas del orquestador. `plugins.present.enabled` habilita la tool y `plugins.present.default_style` elige su estilo inicial (`papercraft-deck`). El HTML incluido funciona sin red ni frameworks, navega con flechas, espacio, Home y End, y tiene modo de impresión.

Al cerrar una feature o un hito, genera el deck y ábrelo para auditar cada afirmación frente a `result`, los archivos y las pruebas reales. Usa `continue` sobre `presenterJob` o vuelve a generar la presentación con correcciones concretas si hace falta. Comparte la ruta/enlace con el dueño solo después de aprobar la revisión; `present` no lo entrega ni lo publica automáticamente.

## Mejora continua (plugin `improve`)
`improve {cwd?, focus?, worker?}` lanza un agente (el router usa `kind: docs`) en un **worktree**: analiza el repositorio y escribe `docs/backlog/<YYYY-MM-DD>-<focus>.md` con ítems priorizados (id, título, impacto, esfuerzo, riesgo y evidencia) y un brief autocontenido por ítem, listo para delegar con TDD/código limpio/DRY. `focus`: `backlog`, `features`, `debt` o `all` (defecto). Fusiona su rama como cualquier job (`diff`/`review`/`merge`).

Con `plugins.improve: {enabled: true, hints: true}` hay invitaciones (nunca asedio):
- `report` añade `next` con la sugerencia de generar y auditar el deck, además de los foci de `improve` que **no** se lanzaron en las últimas 24 h para ese repositorio.
- `wait` añade `hint` cuando todos los jobs terminaron y no hay `improve` reciente.
- El prompt MCP **`continuous-improvement`** describe la ronda completa: `workers → run_many → wait → review → merge → report → improve`.

`enabled: false` oculta la tool, el prompt y las invitaciones; `hints: false` silencia solo las invitaciones. `reload_config` aplica el cambio en caliente.

## Seguridad
Los agentes tienen internet por defecto: Codex con `--search` y OpenCode con `webfetch`; el preámbulo les pide consultar documentación y versiones actuales cuando dependan de una API o dato externo y citar la fuente. También corren **sin sandbox ni aprobaciones** (Codex: `--dangerously-bypass-approvals-and-sandbox`; OpenCode: `--auto`). Con `inplace` un agente puede modificar o borrar cualquier archivo accesible a tu usuario. Por eso `worktree` es el valor por defecto en repos git, `merge` nunca se ejecuta solo, `cleanup` solo toca `colmena/*` bajo `COLMENA_HOME/worktrees`, el YAML no admite flags arbitrarios y cada lanzamiento queda en `audit.log`. `readonly` es real: `-s read-only` en Codex y `--agent plan` en OpenCode (verificado). Úsalo solo en repos y máquinas de confianza.

## Desarrollo
`npm test` usa proveedores falsos (`test/fake-codex.js`, `test/fake-opencode.js`) y repos git temporales; no gasta llamadas reales.
Diseño: `docs/superpowers/specs/` · Planes: `docs/superpowers/plans/`.

Licencia MIT.
