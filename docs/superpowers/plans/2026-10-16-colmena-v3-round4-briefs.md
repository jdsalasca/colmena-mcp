# colmena-mcp v0.3 — Ronda 4 (automejora basada en datos reales): briefs J, K y L

> Base: `develop` con todo lo anterior (A–I, preferencias, presentaciones, widget). Contexto común y estándares: ver `2026-10-16-colmena-v3-briefs.md` ("Contexto común" y "Estándares obligatorios": TDD primero, código limpio, sin duplicación, suite verde, commits pequeños, reporte RESULT/FILES/TESTS/RISKS). No crees archivos de plan/notas ni dejes capturas o temporales dentro del repo. Implementa solo tu brief; otros agentes trabajan los demás en paralelo (conflictos menores en `src/jobs.js`, `src/settings.js` y `README.md` los resuelve el orquestador).

## Brief J — Terminar el job cuando el agente ya entregó (proceso colgado)

**Evidencia (2026-10-16):** el job `89815e43` (Codex) emitió su mensaje final y `turn.completed` a las 23:27, pero el proceso de `codex` no salió; colmena lo marcó `failed: timeout tras 60 min` al día siguiente (el temporizador se retrasó por la suspensión del equipo), aunque el trabajo estaba entregado y commiteado.

**Requisitos**
- Los adaptadores declaran si tienen una señal fiable de fin de turno: añade `completesOn(event)` (o similar, mínimo y claro) — Codex: el evento `usage` (turn.completed) cuando ya hubo mensaje final; OpenCode: ninguna (emite `step_finish` por paso).
- `src/jobs.js`: tras la señal de fin, arranca un temporizador de gracia (`defaults.exit_grace_s` en `colmena.yml`, zod, defecto 20; `COLMENA_EXIT_GRACE_S` lo sobrescribe). Si el proceso no salió al vencer, mata el árbol y finaliza el job como `done` (con `finishedByGrace: true` en meta y mensaje claro) en lugar de `failed`. Si el proceso sale por sí solo antes, el comportamiento actual no cambia.
- Si el job llega al timeout general pero ya había entregado (mensaje final + señal de fin), el estado debe ser `done` (con `finishedByGrace`), no `failed`.
- Documenta la opción en README y `colmena.example.yml`; `reload_config` la recoge (diff incluido).

**Tests primero:** añade al fake de Codex un modo `LINGER` (emite todo y luego se queda colgado): el job termina `done` dentro de la gracia (usa una gracia de décimas de segundo en el test), el proceso queda muerto, `finishedByGrace` true; sin señal de fin (SLEEP) sigue el flujo de timeout `failed`; entrega + timeout → `done`; salida normal intacta; OpenCode no usa la gracia; validación zod; `reload_config` diff.

## Brief K — Datos de modelo y costo cero garantizado

**Evidencia:** para confirmar con qué modelo arrancó un agente del hive hubo que inspeccionar la línea de comandos del proceso y el log de OpenCode; además `step-5-preview` aparece "Free" en el selector del dueño pero OpenCode le reporta costo nominal, mientras `cat-jam-free` y `longcat-2.5-preview-free` reportan 0. El dueño exige costo 0 en el hive.

**Requisitos**
- `meta.json`, `status` y `result` incluyen `model`, `provider` y `effort` del worker con el que corrió el job (guardados al crear el job, no recalculados).
- Campo de worker `free: true` (zod; documentado en `colmena.example.yml` y README): el ledger registra costo 0 para ese worker, `meta` conserva `nominalCostUsd` con lo que reportó el proveedor, `result` muestra `cost_usd: 0` y `nominal_cost_usd`, `workers` muestra `free` por fila y `stats` agrega `nominalCostUsd` por worker. Un worker `free` nunca bloquea por presupuesto aunque tenga `budget`.
- Preámbulo de estándares por defecto (`DEFAULT_STANDARDS_PREAMBLE`): añade la línea "No crees archivos de plan, notas, capturas ni temporales dentro del repositorio fuera de los entregables pedidos; usa una carpeta temporal fuera del repo para capturas".

**Tests primero:** meta/result/status con model/provider/effort (fake de Codex y de OpenCode); `free: true` en ledger, result, workers, stats y budget; `reload_config` refleja `free`; el preámbulo contiene la nueva regla. Actualiza README y el ejemplo.

## Brief L — `cleanup` reconoce ramas ya fusionadas por git

**Evidencia:** tras fusionar a mano ramas de jobs (resolviendo conflictos) `cleanup` exigió `force` porque solo la tool `merge` marcaba `merged`.

**Requisitos:** `cleanup` (src/tools.js) calcula "fusionado" también con `git merge-base --is-ancestor <rama> HEAD` ejecutado en el `cwd` del job (función pura y testeable en `src/isolation.js`, p. ej. `isMerged(cwd, branch)`); una rama fusionada por git no exige `force`; una rama con commits no fusionados sigue exigiéndolo; `merge` squash (que no deja ancestro) sigue marcando `merged` por flag. Cubre además el caso de rama inexistente (ya borrada) sin lanzar error.

**Tests primero:** repos git temporales: rama fusionada con merge manual (sin force), rama con commits sin fusionar (rechaza sin force, acepta con force), squash vía tool, rama inexistente, `cwd` que ya no es repo.
