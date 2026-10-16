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
