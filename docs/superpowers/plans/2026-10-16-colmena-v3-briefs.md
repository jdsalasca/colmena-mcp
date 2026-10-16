# colmena-mcp v0.3 — briefs para delegar (mejora continua + control de costos)

> Pensado para ejecutarse **con colmena mismo** (dogfooding): Claude orquesta con `run_many`, valida con `review`/`diff`, fusiona y cierra con `report`. Cada brief es autocontenido. Spec base: `docs/superpowers/specs/2026-10-16-colmena-v2-design.md`.

## Contexto común (pégalo al inicio de cada brief)
Repo `colmena-mcp` (Node 24 ESM, `node --test`, zod, `@modelcontextprotocol/sdk`, `yaml`). Código en `src/` (config.js, settings.js, jobs.js, tools.js, router.js, ledger.js, providers/, plugins/notify.js, plugins/report.js). Tests en `test/` usan proveedores falsos (`test/fake-codex.js`, `test/fake-opencode.js`, helpers en `test/helpers.js`); **nunca lances agentes reales en tests**. Suite actual: 97 tests verdes (`npm test`).

### Estándares obligatorios (aplican a todo)
1. **TDD desde el inicio:** primero el test, míralo fallar por la razón correcta, luego el código mínimo, luego refactor. Sin código de producción sin un test rojo previo.
2. **Código limpio y no repetido:** reutiliza lo que existe (busca antes de escribir), extrae helpers en vez de copiar, nombres claros, funciones cortas, sin comentarios que expliquen lo obvio, sin código muerto.
3. No toques lo que no pide el brief. Suite completa verde antes de terminar. Commits pequeños (`feat:`/`fix:`/`refactor:`).
4. Si tienes el skill `superpowers` (using-superpowers → test-driven-development / verification-before-completion), úsalo.
5. Mensaje final en formato RESULT / FILES / TESTS / RISKS.

---

## Brief A — Estándares por YAML + `reload_config` (ramas: settings/jobs/tools)

**Objetivo:** (1) que todo agente de tipo `run` reciba un preámbulo de estándares configurable (TDD, código limpio, sin duplicación, superpowers) para lograr calidad de forma nativa; (2) tool `reload_config` para cambiar modelos/presupuestos/plugins **sin reiniciar**, de modo que los modelos vivan solo en `colmena.yml`.

**Requisitos**
- `colmena.yml` nueva sección `standards: {enabled: true, preamble: "<texto>"}` validada en `src/settings.js` (zod). Default embebido en español: pide TDD red→green→refactor, código limpio y DRY, reutilizar antes de escribir, verificación con evidencia, usar los skills de superpowers si existen, y el formato de reporte. `enabled: false` lo desactiva.
- `buildPrompt` (`src/report.js`) antepone el preámbulo **solo** a jobs `kind: 'run'` (no a summarize/compact/review/report). El preámbulo llega por parámetro (no lo leas de global).
- Nueva tool `reload_config` (sin args): relee `colmena.yml` (misma validación). Si es válido, reemplaza `config.settings` en caliente: `jobs.js` debe leer la config **dinámicamente** (hoy captura `settings`/`workers` al crear el manager), el router/ledger usan la nueva, y `notify` actualiza `on` y reinicia su temporizador de latido con el nuevo `heartbeat_min` (agrega `update(cfg)` al plugin). Si es inválido: **conserva la config anterior** y devuelve el error con la ruta del campo. Devuelve un diff compacto: `{added:[], removed:[], changed:[{alias, fields}], roles, defaults}`. Los jobs ya en curso no cambian; los siguientes usan lo nuevo. Variables de entorno (`COLMENA_MAX_PARALLEL`, etc.) siguen mandando sobre el YAML.
- Un worker eliminado o deshabilitado en el reload hace que `continue` de un job suyo falle con mensaje claro.

**Tests a escribir primero:** settings (standards default/override/disabled/invalid); `buildPrompt` con y sin preámbulo; que helpers no reciben preámbulo; `reload_config`: cambia un alias de modelo → el siguiente `run` lo usa (verifícalo en el log del fake); YAML inválido → config intacta + error; cambio de `heartbeat_min` reinicia el timer (relojes inyectables); diff correcto; servidor MCP expone la tool (actualiza `NAMES` en `test/server.test.js`).

## Brief B — Agente de mejora continua: tool `improve` + invitación

**Objetivo:** cerrar el ciclo de mejora continua: tras una ronda, colmena **invita** a lanzar un agente que levante backlog, nuevas features y deuda técnica del repo, dejando todo listo para delegar.

**Requisitos**
- Nueva tool `improve {cwd?, focus: 'backlog'|'features'|'debt'|'all', worker?}`: lanza un agente (worker por parámetro o router con `kind: 'docs'`) en **worktree** que analiza el repo y escribe `docs/backlog/<YYYY-MM-DD>-<focus>.md` con ítems priorizados (id, título, impacto, esfuerzo, riesgo y **un brief autocontenido listo para delegar, con enfoque TDD/código limpio/DRY**), más un resumen de ≤15 líneas en el reporte final. Prompts de cada `focus` en un módulo nuevo `src/plugins/improve.js` (puro y testeable: `buildImprovePrompt(focus, {date})`). Devuelve `{job_id}` como `run`.
- Invitación: (a) el resultado de `report` incluye `next: [...]` con la sugerencia "ronda cerrada: considera `improve` (debt/backlog/features)" y qué focus aún no se lanzó para ese `cwd` en las últimas 24 h (usa `audit.log` o el store; sin estado global nuevo si puedes evitarlo); (b) registra un **prompt MCP** `continuous-improvement` (`server.registerPrompt`) que guía al orquestador: workers → run_many → wait → review → merge → report → improve. (c) `wait` devuelve `hint` cuando todos los jobs de la lista terminaron y no hay `improve` reciente.
- Plugin configurable: `plugins.improve: {enabled: true, hints: true}` en el YAML (zod); `enabled:false` oculta la tool y las invitaciones.

**Tests a escribir primero:** `buildImprovePrompt` por focus (contiene ruta de salida con fecha, pide briefs con TDD/DRY); `improve` lanza job en worktree con el worker correcto (fake) y el prompt esperado; `report` devuelve `next` y deja de sugerir un focus ya lanzado; `wait` con hint; prompt MCP listado (`listPrompts`); plugin deshabilitado → tool ausente y sin `next`/`hint`.

---

## Orden y validación (lo hace el orquestador)
1. `workers` → `run_many` con A y B (worktrees distintos). 2. `wait` → `result` → `review` de cada rama. 3. Merge de A y luego B (puede haber conflicto en `src/tools.js`/`test/server.test.js`: resolver manteniendo ambas tools; correr `npm test`). 4. `report` de la ronda (papercraft) y `improve all` sobre `colmena-mcp` como primer backlog real. 5. Actualizar README/skill (hecho por Luna dentro de cada brief si aplica).

---

## Ronda 1 (automejora): briefs C, D y E

> Estado: el Brief A ya está integrado en `develop`. El Brief B (`improve`) sigue pendiente. Los agentes parten de `develop`.

### Brief C — `stats`: datos para automejorar + internet explícito

**Objetivo:** que colmena **recolecte y resuma datos de uso** (para que el orquestador y el agente `improve` decidan qué mejorar) y que los agentes sepan que tienen internet.

**Requisitos**
- Módulo puro nuevo `src/stats.js` con `computeStats(metas, {sinceMs, now})` → `{range, totals:{jobs, done, failed, cancelled, orphaned, successRate, costUsd, durationS}, byWorker:{[alias]:{runs, done, failed, successRate, avgDurationS, costUsd, inputTokens, outputTokens}}, byKind:{...}, topFailures:[{error, count}] (máx 5, mensajes truncados y agrupados)}`. Lee metas del store (`jm.list` no basta: añade un método mínimo al JobManager o al store para obtener las metas completas, sin duplicar lógica de lectura).
- Nueva tool MCP `stats {since_days?: number}` (defecto 30) que devuelve ese objeto, compacto. Gateada por nada (siempre disponible).
- `DEFAULT_STANDARDS_PREAMBLE` (en `src/settings.js`) añade una línea: tienen **internet** (búsqueda web en vivo / webfetch): consultar documentación y versiones actuales cuando dependan de una API o dato externo, citando la fuente. Actualiza README (sección de seguridad/agentes: "los agentes tienen internet por defecto: Codex con `--search`, OpenCode con webfetch").
- Gestión de datos faltantes: jobs sin `startedAt/endedAt` o sin `costUsd` cuentan 0 sin lanzar excepción; lista vacía → totales en cero y `successRate: null`.

**Tests primero:** `computeStats` con un conjunto fabricado (varios workers/kinds/estados, agrupación de errores, ventana `sinceMs`, metas incompletas, lista vacía); la tool `stats` por el servidor MCP (actualiza `NAMES` en `test/server.test.js`); settings: el preámbulo por defecto menciona internet.

### Brief D — Prueba de `max-hive`: dedupe de escrituras de sesión (tarea pequeña y mecánica)

**Objetivo:** en `src/jobs.js`, `onEvent` llama `store.update(id, {sessionId})` en **cada** evento `session` (OpenCode emite uno por paso, Codex uno). Debe escribir solo cuando el `sessionId` cambia.

**Requisitos:** cambio mínimo y limpio (una variable local por job); sin tocar nada más. **Tests primero** (en `test/opencode.test.js` o `test/jobs.test.js`): con el fake de OpenCode emitiendo varios `step_start` con el mismo sessionID, `store.update` con `sessionId` se invoca una sola vez (espía `createStore` o cuenta escrituras de `meta.json` con un wrapper inyectable; elige lo más simple y estable) y el sessionId final es correcto. `npm test` verde.

### Brief E — Ronda de brainstorming (solo lectura, sin código)

**Objetivo:** aplicar el skill `superpowers:brainstorming` (si lo tienes) para proponer mejoras a colmena-mcp basadas en **datos reales**. Lee: `README.md`, `src/`, `test/`, los specs/planes en `docs/superpowers/`, y los datos de uso en `~/.colmena/` (`audit.log`, `usage.json`, `jobs/*/meta.json`; ignora jobs de prueba con home temporal). Identifica problemas observados (p. ej. un agente de Codex fusionó a `develop` y borró su worktree por instrucciones globales; cleanup falló al borrar una carpeta en Windows; Codex no reporta costo; wait máximo 10 min vs jobs de 10+ min).

**Entrega (en el mensaje final, ≤15 líneas; no modifiques archivos):** top 8 mejoras priorizadas por (impacto / esfuerzo), cada una con: título, evidencia (dato o archivo concreto), y un brief de 2 líneas listo para delegar con enfoque TDD / código limpio / DRY. Incluye al menos 2 ideas de *nuevas features* y 2 de *deuda técnica*.
