---
name: colmena-delegation
description: Use when delegating implementation work to the Colmena MCP (Codex/Luna and OpenCode/DeepSeek workers). Explains how to pick a worker, write briefs, run rounds in parallel, validate quality like a product manager, merge, and close with an HTML report, while spending few orchestrator tokens.
---

# Orquestar la colmena

Tú eres el **PM y validador de calidad**; los workers (Codex, OpenCode) implementan. El agente **no ve esta conversación**: el brief debe bastar por sí solo.

## 1. Elegir worker
- `workers` → mira `available`, `remaining_usd`, `strengths` y `priority`.
- Por defecto `luna-max` (Codex, prioridad 1); cuando se agote o necesites paralelismo extra → `ds-flash` (DeepSeek V4.1 Flash en OpenCode Go, con presupuesto). Luna solo va por Codex. Si omites `worker` el router elige (usa `kind: "code"|"docs"|…` como pista).
- **`max-hive`** (`worker: "max-hive"` o `kind: "bulk"`): muchas tareas pequeñas y mecánicas en paralelo a costo ~0, con un modelo *contributor* (sin zero data retention: nada sensible) y calidad menor → **valida siempre** con `review`/`diff`. Para cambiarle el modelo usa `scripts/opencode-models.mjs --contributor`, edita `colmena.yml` y llama `reload_config` (detalle en el README).
- Si un worker está sin presupuesto, `run` falla con alternativas: no hay cambio silencioso; decide tú.
- OpenCode carga ~50k tokens de contexto por ejecución: no lo uses para tareas triviales.

## 2. Brief (3–8 líneas)
Objetivo y *por qué* · rutas exactas (`context_files`) y qué NO tocar · criterio de aceptación con comando de prueba · restricciones. Sin código largo: apunta a archivos.

## 3. Ronda
1. `run_many` (cada tarea en su worktree `colmena/<id>`). Una tarea → `run` (`wait: true` si es corta).
2. `wait` (mode `all`; repite mientras haya `pending`). El usuario recibe toasts al lanzar, cada 10 min y al terminar.
3. `result` en `min`; solo `normal`/`full` si hace falta. Si `reportOk` es false lee `text`.
4. **Valida como PM:** `review` (rol reviewer) y/o `diff`; corre tú los tests en la rama si es crítico. Si falta algo: `continue` con feedback concreto (mismo worker y sesión).
5. Encadenar: `compact` del primero → `handoff` con `from: [id]`.
6. `merge` (manual; `squash` para historial limpio) → **`report`** con los `job_ids` de la ronda (estilo `papercraft`; `open: true` para abrirlo) → `cleanup`.

## 4. Ahorro de tokens
Quédate en `detail: "min"`; los logs completos están en disco. No releas lo ya reportado: pide `summarize`. Si un job falla o hace timeout, lee `error` antes de relanzar y cambia algo del brief.

## 5. Cuidado
Los agentes corren sin sandbox ni aprobaciones. Prefiere `worktree`; `inplace` solo con árbol limpio y tarea acotada; `readonly` para investigar/auditar. Nunca fusiones sin revisar. `cleanup` exige `force` para descartar trabajo no fusionado.
