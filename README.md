# colmena-mcp 🐝

Servidor MCP (stdio) para que **Claude Code orqueste y valide, como un product manager**, mientras una colmena de agentes obreros —**Codex** (Luna) y **OpenCode** (DeepSeek, etc.)— hace el trabajo pesado. Tú gastas pocos tokens: briefs cortos de ida, reportes de ≤15 líneas de vuelta.

- **Workers por alias** en un `colmena.yml`: proveedor + modelo + esfuerzo + prioridad + presupuesto y, opcionalmente, `free: true` para registrar costo cero. Las herramientas solo aceptan un alias, nunca un modelo o flag libre.
- **Presupuesto y ruteo:** el servidor cuenta el gasto por worker y por mes; cada job puede reservar un costo estimado (`reserve_usd`) al encolar, de modo que N jobs concurrentes descuentan gasto + reservas y no agotan el mismo saldo. Un worker `free` conserva el costo nominal aparte, no reserva y no queda bloqueado por presupuesto. Sin `worker` explícito, elige el proveedor preferido disponible y luego aplica `kind` y prioridad.
- **Aislamiento por llamada:** `worktree` (rama `colmena/<id>`, por defecto en repos git), `inplace` o `readonly`.
- **Paralelismo con cola**, sesiones reanudables, resúmenes, compactación y relevo entre agentes.
- **Plugin `notify`:** toast de Windows al lanzar agentes, latido cada 10 min mientras haya trabajo, aviso al terminar o fallar, y aviso de presupuesto cuando un worker cruza el umbral o agota su saldo.
- **Plugins `report` y `present`:** crean un reporte HTML de la ronda y una presentación papercraft de cierre del hito, respectivamente.
- **Widget de escritorio:** la tool `widget` inicia, consulta y cierra la escena animada de Colmena.
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

Humo real (gasta unas pocas llamadas): `npm run smoke -- luna-max,ds-flash --report`. Opcional y **nunca en CI**: por proveedor ejecuta una tarea mínima y comprueba, reportando cada una, la selección del worker y los metadatos persistidos (`provider`/`model`/`effort`) frente a `colmena.yml`, el formato `RESULT/FILES/TESTS/RISKS`, la señal final del proveedor cuando la emite (Codex: `turn.completed`; OpenCode no emite señal final) y que el modelo expuesto en sus eventos coincida con el configurado — si el proveedor no lo expone, el smoke **no afirma** el modelo ejecutado. Devuelve código distinto de cero si alguna comprobación falla y elimina sus temporales incluso en fallo.

## Configuración: `colmena.yml`

Ubicación: `$COLMENA_CONFIG` o `~/.colmena/colmena.yml`. Sin archivo se usan los valores por defecto. Ejemplo completo en [`colmena.example.yml`](colmena.example.yml):

```yaml
workers:
  luna-max:       {provider: codex,    model: gpt-6-luna, effort: max, priority: 1, strengths: [code, refactor, tests]}
  ds-flash:       {provider: opencode, model: opencode-go/deepseek-v4.1-flash, effort: max, priority: 2, strengths: [code, docs, summary, report], budget: {monthly_usd: 10}}
  max-hive:       {provider: opencode, model: opencode-go/muse-spark-1.3-contributor, effort: high, priority: 9, strengths: [bulk], budget: {monthly_usd: 5}}
roles:    {reporter: ds-flash, summarizer: ds-flash, reviewer: luna-max, presenter: luna-max}
defaults: {worker: luna-max, max_parallel: 4, timeout_min: 60, exit_grace_s: 20, retry_transient: 1, wait_max_s: 600, stall_timeout_min: 15, cancel_jobs_on_shutdown: false, reserve_usd: 0}
preferences: {provider: auto} # codex | opencode para priorizar un proveedor sin reiniciar
plugins:
  notify: {enabled: true, on: [start, finish, fail], heartbeat_min: 10, budget_pct: 80}
  report: {enabled: true, default_style: papercraft}
  present: {enabled: true, default_style: papercraft-deck}
  improve: {enabled: true, hints: true}
  widget: {enabled: true}
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
- `defaults.exit_grace_s` (20 s) da tiempo al proceso de Codex para salir después de entregar su mensaje final y emitir `turn.completed`. Si sigue activo al vencer, Colmena mata el árbol del proceso y termina el job como `done`, con `finishedByGrace: true` y un mensaje en el resultado. Si llega antes el timeout general pero Codex ya entregó, también queda `done`; OpenCode no usa esta gracia porque `step_finish` puede ser solo un paso intermedio. Edita el YAML y llama a `reload_config` para aplicar workers, roles, defaults, plugins y proveedores sin reiniciar.
- `defaults.cancel_jobs_on_shutdown` es `false` por defecto: al cerrar el servidor MCP se detienen sus lectores y temporizadores, pero los procesos desacoplados siguen trabajando y escriben `events.jsonl` / `stderr.log` en su job. La siguiente instancia adopta los procesos vivos, recupera los terminados desde su offset guardado y reencola los pendientes (su prompt queda en `prompt.txt` hasta que arrancan o se cancelan). Usa `true` para volver a cancelar los jobs en cola o en ejecución al cerrar; `reload_config` aplica el ajuste.
- Cada job publica su prompt completo en `brief.md` (escritura atómica) al crearse y no lo borra al arrancar, a diferencia de `prompt.txt`. `retry {job_id, task?}` exige un job terminal, rechaza los vivos (nada de duplicar trabajo) y lanza un job nuevo con `parentId`, el worker, el cwd y el workspace originales (worktree y rama incluidos); sin `task` reutiliza `brief.md` íntegro y con `task` usa ese brief nuevo. Un job sin `brief.md` (creado antes de esta versión) se puede relanzar pasando `task`. El alta pasa por el mismo camino que `run`, así que reserva presupuesto y queda en `list`/`stats`.
- Los errores del proveedor que OpenCode escribe en `events.jsonl` (`{"type":"error", error:{name, data:{message, isRetryable}}}`) ya no se pierden: `result.error` nombra al proveedor real (`opencode salió con código 1: <stderr o mensaje del evento>`) y, cuando un job falla en menos de 30 s con un error reintentable (`isRetryable: true` o mensaje con `Unexpected server error`), Colmena lo reintenta automáticamente una vez en el mismo worktree y worker. `defaults.retry_transient` (entero ≥ 0, defecto 1; `0` desactiva el reintento) lo controla y `reload_config` lo recoge. El reintento es del mismo job: suma el uso de ambos intentos y lo registra una sola vez en el ledger, emite `job.started`/`job.finished` una sola vez y guarda `meta.retries`.
- `defaults.stall_timeout_min` (15 min; `0` lo desactiva) es el vigilante de inactividad: si `events.jsonl` no crece ni cambia su mtime durante ese tiempo, Colmena mata el proceso y falla el job con `sin actividad durante N min; el proveedor no respondió`, sin esperar al timeout general. La actividad se mide por tamaño/mtime del log, así que el proveedor cuenta como vivo mientras escriba, aunque su salida no sea parseable. El cuelgue cuenta como error transitorio para `defaults.retry_transient` (una vez); un job que ya entregó su respuesta (o está en su gracia) nunca se marca failed por esto. `reload_config` lo recoge.
- `COLMENA_MAX_PARALLEL`, `COLMENA_JOB_TIMEOUT_MIN`, `COLMENA_EXIT_GRACE_S`, `COLMENA_RETRY_TRANSIENT`, `COLMENA_STALL_TIMEOUT_MIN` y `COLMENA_WAIT_MAX_S` conservan prioridad sobre los valores YAML.
- `preferences.provider` acepta `auto` (ruteo actual), `codex` u `opencode`. La tool `preferences` consulta la preferencia y el worker elegido ahora, o la cambia en memoria y en el YAML efectivo (`COLMENA_CONFIG` o `$COLMENA_HOME/colmena.yml`) para el siguiente `run`; no requiere reinicio. Si no hay workers disponibles de ese proveedor, el router usa otro y devuelve un `note`. `worker` explícito siempre manda; las tools auxiliares continúan usando sus roles.
- `workers` muestra `free` por worker; `stats {since_days?}` resume jobs, éxito, duración, costo registrado y `nominalCostUsd` por worker, tokens, tipos y fallos de la ventana indicada (30 días por defecto). Por worker también separa la calidad observada: `reviewed`, `accepted`, `needsWork`, `reviewCoverage` y `acceptanceRate` cuentan solo veredictos explícitos de `verdict`, así que un job sin veredicto no cuenta como rechazado.
- `verdict {job_id, verdict: accepted|needs_work, note?}` registra la aceptación humana del orquestador sobre un job ya revisado con `review`/`diff`. Es la única vía que fija el veredicto (nunca se infiere del estado `done`) y exige un `job_id` válido; `meta.json` conserva `verdict`, `verdictNote` y `verdictAt`. Regístralo antes de `merge`.
- `cleanup {older_than_days, force: true}` acota el crecimiento de `$COLMENA_HOME/jobs/`: además de los worktrees y ramas `colmena/*`, borra las carpetas de jobs ya terminados (`done`, `failed`, `cancelled`, `orphaned`) cuyo fin (`endedAt`, o `createdAt` si falta) sea anterior al umbral, y devuelve sus ids en `jobsRemoved`. Los jobs en curso, en cola o vivos nunca se tocan; `list` y `stats` dejan de ver los purgados. Sin `older_than_days` el comportamiento es el de siempre (solo worktrees y ramas).
- `workers.<alias>.free: true` declara que el modelo de ese worker está cubierto a costo cero: el ledger registra `cost_usd: 0`, `meta.json` conserva `nominalCostUsd` y `result` muestra `cost_usd: 0` junto con `nominal_cost_usd`. El flag exime al worker de su presupuesto mensual. Úsalo solo si tu plan garantiza el costo cero; el costo nominal sigue visible para auditar lo que reportó el proveedor.
- `reserve_usd` (por worker, o `defaults.reserve_usd` como valor global; defecto `0`) es el costo estimado que cada job reserva al encolar. El router y la tool `workers` descuentan `spent_usd + reserved_usd`: un worker no acepta un job nuevo si su reserva no cabe en el presupuesto, así N jobs simultáneos no consumen el mismo saldo. Al terminar o cancelar, la reserva se libera y el ledger registra el costo real, aunque haya superado la estimación. Los jobs adoptados tras un reinicio conservan su reserva (`meta.reservedUsd`) y los huérfanos la liberan. Solo los workers con `budget` y sin `free` reservan.
- `meta.json`, `status` y `result` conservan `model`, `provider` y `effort` del worker seleccionados al crear cada job, aunque la configuración se recargue después.
- `effort` se pasa como `model_reasoning_effort` (Codex) o `--variant` (OpenCode).
- `providers.opencode.isolate_config` está activo por defecto: OpenCode usa `$COLMENA_HOME/opencode-config` como `XDG_CONFIG_HOME`. Así no hereda los servidores MCP, plugins, agentes, `AGENTS.md` ni skills de la configuración global del usuario; los estándares de Colmena llegan por el preámbulo. La autenticación se conserva en `XDG_DATA_HOME`. Define `config_dir` para usar una configuración mínima propia (la carpeta se crea si falta), o `isolate_config: false` para volver a usar la configuración habitual.
- Evidencia de la comparación reportada para una ejecución trivial: el contexto de entrada bajó de ~47k a ~8k tokens; `opencode-go/deepseek-v4.1-flash` bajó de $0.0074 a $0.0011 por ejecución; y `opencode-go/cat-jam-free`, que fallaba globalmente con `maximum number of items is 128`, respondió con costo reportado `0`. La configuración global también hizo que un job usara `chatgpt-coordinator` durante más de 10 minutos y se observó `ProviderHeaderTimeoutError` en `step-5-preview`.
- OpenCode informa el costo en USD de cada ejecución. **Codex no**: para contabilizarlo añade `price_per_mtok: {input: …, output: …}` al worker.
- El saldo real de tus cuentas no se puede consultar por API: el presupuesto es **declarativo + conteo local** (`usage.json`, que además guarda las reservas de los jobs vivos). Dos servidores sobre el mismo `COLMENA_HOME` no pierden actualizaciones: `record`, `reserve`, `release` y `reconcile` se serializan con un lock advisory (`usage.json.lock`) que se recupera solo si es viejo (> 10 s) o su dueño murió. Si el lock no se obtiene en 2 s la mutación se aplica igual (fail-soft): la contabilidad nunca bloquea ni rompe un job.
- **Regla de reparto:** Luna va **solo por Codex** (`luna-max`). En OpenCode Go el worker principal es **DeepSeek V4.1 Flash** (`ds-flash`, $0.15 entrada / $0.60 salida por Mtok, revisado 2026-10-16), con presupuesto mensual. No se usa Luna a través de OpenCode.
- OpenCode carga mucho contexto propio (~30-50k tokens por ejecución): conviene delegarle tareas con cierto peso.

### max-hive: maximizar tareas en paralelo a costo ~0
`max-hive` es el worker para **maximizar muchas tareas pequeñas en paralelo con costo cercano a cero** (tests masivos, generación repetitiva, migraciones mecánicas, auditorías por archivo, borradores). Usa un modelo **"contributor"** del plan Go: sin *zero data retention* (no le mandes secretos ni código sensible) y con calidad menor que `luna-max`, así que **lo que produce lo valida el orquestador** (`review`/`diff`) antes de fusionar. Tiene prioridad 9 y fortaleza `bulk`: el router solo lo elige si lo pides (`worker: "max-hive"` o `kind: "bulk"`) o si no queda otro disponible.
- **Evita los modelos `-free`:** traen cuota; `max-hive` busca modelos *contributor* del plan Go.
- **Costo ~0 no es verificable desde aquí:** OpenCode reporta un costo nominal por ejecución (≈ $0.004 con `muse-spark-1.3-contributor`; `gemini-4-argon-contributor` ≈ $0.16, ¡caro!). Si tu plan Go cubre un modelo a costo cero, añade `free: true` a ese worker: Colmena registrará costo `0`, preservará el nominal reportado y no lo bloqueará por presupuesto. Esto refleja tu declaración local, no verifica la factura real de tu cuenta. `max-hive` mantiene su tope de seguridad mientras no se marque `free`.
- **Cómo buscarle otro modelo (para Claude):** `node scripts/opencode-models.mjs --contributor` lista los *contributor* del más barato al más caro; `--max-out 0.6 --json` filtra por precio. Elige el más barato con ventana de contexto suficiente, cambia `model`/`effort` en `colmena.yml` (si no ofrece `max`, usa su mejor variante), llama `reload_config`, y valídalo con una ejecución real (`run` con `worker: "max-hive"`, `isolation: "readonly"`) revisando `cost_usd` y que el reporte salga en formato RESULT/FILES/TESTS/RISKS.

### Variables de entorno
`COLMENA_HOME`, `COLMENA_CONFIG`, `COLMENA_CODEX_BIN`, `COLMENA_OPENCODE_BIN`, `COLMENA_MAX_PARALLEL`, `COLMENA_JOB_TIMEOUT_MIN`, `COLMENA_EXIT_GRACE_S`, `COLMENA_RETRY_TRANSIENT`, `COLMENA_STALL_TIMEOUT_MIN`, `COLMENA_WAIT_MAX_S`, `COLMENA_NOTIFIER` (`toast`|`log`|`none`). Los nombres `LUNA_*` de la v0.1 se siguen aceptando.

## Herramientas

| Tool | Para qué |
|---|---|
| `workers` | Workers con prioridad, fortalezas, preferencia (`preferred`), gasto del mes, reservado, restante y disponibilidad |
| `preferences` | Consulta o cambia en caliente `auto` / `codex` / `opencode`; muestra también el worker que elegiría el router |
| `stats` | Resumen histórico por estado, worker y tipo (`since_days`, defecto 30) |
| `reload_config` | Relee y valida `colmena.yml`; jobs posteriores usan los cambios sin reiniciar |
| `run` / `run_many` | Lanza uno o varios agentes (`worker?`, `kind?`, `isolation?`, `wait: true` espera el reporte; `run_many` con `wait: true` cierra la ronda en una llamada y devuelve `{ done, pending }` como `wait`, con `timeout_s` recortado a `defaults.wait_max_s`) |
| `wait`, `status`, `list` | Seguimiento (`wait` hasta `defaults.wait_max_s`, defecto 600 s, tope 1800 s; `timeout_s` entre 1 y 1800; al vencer devuelve `pending` con estado y `elapsedS` sin cancelar; `mode: any/all`; añade `hint` de mejora continua al cerrar una ronda) |
| `result` | Reporte `RESULT/FILES/TESTS/RISKS`, archivos, diffstat, rama, worker, modelo, proveedor, esfuerzo y costos registrado/nominal |
| `diff` | Diff truncado; el completo queda en disco |
| `continue` | Reanuda la sesión (mismo worker y workdir) |
| `retry` | Relanza un job terminal con su brief original íntegro (`brief.md`) o uno nuevo (`task`), conservando worker, cwd y workspace |
| `summarize`, `compact` | Resumen / brief de relevo de una sesión (rol `summarizer`) |
| `handoff` | Agente nuevo con los resúmenes de otros como contexto |
| `review` | Revisión solo lectura de un job o cwd (rol `reviewer`) |
| `verdict` | Registra la aceptación humana (`accepted`/`needs_work`, `note?`) de un job revisado; `stats` la agrega por worker |
| `cancel` | Cancela y mata el árbol de procesos |
| `merge` | Fusiona `colmena/<id>` (manual; se niega con destino sucio; restaura ante conflictos) |
| `cleanup` | Borra worktrees y ramas `colmena/*` propios (`force` para descartar trabajo no fusionado); con `older_than_days`+`force` purga además carpetas de jobs terminales antiguos (`jobsRemoved`) |
| `report` | HTML de cierre de ronda (`job_ids`, `style?`, `title?`, `open?`); `next` sugiere `present` e indica lo que falta de `improve` |
| `present` | Presentación HTML papercraft de un hito (`job_ids`, `title?`, `subtitle?`, `notes?`, `style?`, `open?`) |
| `improve` | Mejora continua: agente en worktree que escribe `docs/backlog/<fecha>-<focus>.md` (backlog/features/debt/all) con briefs listos para delegar |
| `widget` | `action: start \| status \| stop`: agrega el widget al escritorio, consulta su PID verificado o lo cierra |

Flujo recomendado: `workers` → `run_many` → `wait` → `result` → `review`/`diff` → `verdict` → `merge` → `report` → `present` → auditar el deck → `improve`. Para cerrar la ronda en una llamada, `run_many` con `wait: true` espera los jobs y devuelve `{ done, pending }` sin cancelar al vencer. La skill [`skills/colmena-delegation`](skills/colmena-delegation/SKILL.md) explica cómo redactar los briefs y validar la presentación antes de compartirla.

### Widget de escritorio
Usa `widget {action: start}` para abrir la escena; `status` informa `running` solo cuando el PID del registro coincide con la ruta real del proceso, y `stop` cierra ese proceso y espera su salida. El servidor hereda `COLMENA_HOME`; el registro Rust está en `$COLMENA_HOME/widget-process.json`. `plugins.widget.enabled` (defecto `true`) habilita la tool. El ejecutable se busca primero en `COLMENA_WIDGET_BIN` y luego en `widget/dist/colmena-widget.exe`. Si falta, compílalo dentro de `widget/` con `cargo build --release` y copia `target/release/colmena-widget.exe` a `dist/`.

## Notificaciones
Con `plugins.notify` activo recibes un toast de Windows agrupado al lanzar agentes, con el proveedor visible (`luna-max (codex)`), y un latido cada `heartbeat_min` mientras haya trabajos corriendo o en cola. Los avisos de término y fallo identifican el proveedor (`[codex] luna-max`). Todas las notificaciones terminan con un overview actualizado por proveedor, por ejemplo `En curso: codex 2 · opencode 1 · +1 en cola`, o `En curso: ninguno` cuando no queda trabajo. Sin trabajo no hay latido. El cuerpo del toast respeta el límite de 300 caracteres y acorta la tarea para conservar el overview. Todo queda también en `~/.colmena/activity.log`.

`plugins.notify.budget_pct` (entero 0-100, defecto `80`; `0` lo desactiva) avisa cuando el compromiso (`spent + reserved`) de un worker con `budget` cruza ese porcentaje o agota su saldo, revisándolo al terminar o liberar cada job. Es un aviso por worker y cruce dentro del proceso (no se repite): primero el umbral, luego la extenuación. Los workers `free` o sin `budget` nunca avisan. `reload_config` recoge el knob sin reiniciar.

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
Los agentes tienen internet por defecto: Codex con `--search` y OpenCode con `webfetch`; el preámbulo les pide consultar documentación y versiones actuales cuando dependan de una API o dato externo y citar la fuente. También corren **sin sandbox ni aprobaciones** (Codex: `--dangerously-bypass-approvals-and-sandbox`; OpenCode: `--auto`). Con `inplace` un agente puede modificar o borrar cualquier archivo accesible a tu usuario. Por eso `worktree` es el valor por defecto en repos git, `merge` nunca se ejecuta solo, `cleanup` solo toca worktrees/ramas `colmena/*` propios y, con `older_than_days`+`force`, carpetas de jobs ya terminados (nunca en curso, en cola o vivos), el YAML no admite flags arbitrarios y cada lanzamiento queda en `audit.log`. `readonly` es real: `-s read-only` en Codex y `--agent plan` en OpenCode (verificado). Úsalo solo en repos y máquinas de confianza.

## Desarrollo
`npm test` usa proveedores falsos (`test/fake-codex.js`, `test/fake-opencode.js`) y repos git temporales; no gasta llamadas reales. Los fakes aceptan knobs de error de contrato sin red (`FAKE_NO_FINAL`, `FAKE_EXPOSE_MODEL`, `FAKE_RAW`) y `test/runner.test.js` ejecuta `scripts/smoke.js` contra ellos para validar las comprobaciones del humo real (`npm run smoke`, que no forma parte de `npm test` ni de CI).
Diseño: `docs/superpowers/specs/` · Planes: `docs/superpowers/plans/`.

Licencia MIT.
