---
name: luna-delegation
description: Use when delegating implementation work to Luna agents through the luna_* MCP tools (gpt-6-luna max). Explains how to write briefs, when to use run/run_many/handoff, and the run → wait → result → review → merge flow while spending few orchestrator tokens.
---

# Delegar a agentes Luna

Tú orquestas y das lineamientos; Luna implementa. Luna **no ve esta conversación**: el brief debe bastar por sí solo.

## Brief (3–8 líneas)
1. **Objetivo** en una frase y el *por qué*.
2. **Dónde**: rutas exactas (`context_files`) y qué NO tocar.
3. **Criterio de aceptación**: comando de prueba que debe pasar (`npm test`, etc.).
4. **Restricciones**: estilo, dependencias prohibidas, compatibilidad.
No pegues código largo; apunta a archivos.

## Qué herramienta
- Una tarea → `luna_run` (`wait: true` si es corta).
- Varias independientes → `luna_run_many` (cada una en su worktree) y luego `luna_wait`.
- Tarea que depende del resultado de otra → `luna_compact` del primero y `luna_handoff` con `from: [id]`.
- Ajustes sobre lo mismo → `luna_continue` (conserva el contexto de la sesión).
- Investigar o auditar sin editar → `isolation: "readonly"`.

## Flujo
1. `luna_run_many` → `job_id`s.
2. `luna_wait` (mode `all`; repite si quedan `pending`).
3. `luna_result` (min). Si `reportOk` es false, lee `text`; pide `detail: "normal"` solo si hace falta.
4. Verifica: `luna_review` y/o `luna_diff`. Corre tú los tests del repo en la rama `luna/<id>` si es crítico.
5. `luna_merge` (manual, `squash` para historial limpio) → `luna_cleanup`.

## Ahorro de tokens
- Quédate con `detail: "min"`; los logs completos están en disco (`eventsLog`).
- No releas lo que Luna ya reportó; pide un `luna_summarize` si necesitas contexto de una sesión larga.
- Si un job falla o hace timeout, lee `error` antes de relanzar y cambia algo del brief.

## Cuidado
Luna corre sin sandbox ni aprobaciones. Prefiere `worktree`; usa `inplace` solo con árbol limpio y tarea acotada. Nunca fusiones sin revisar.
