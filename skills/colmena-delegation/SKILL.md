---
name: colmena-delegation
description: Use when delegating implementation work to the Colmena MCP (Codex/Luna and OpenCode/DeepSeek workers). Explains how to pick a worker, write briefs, run rounds in parallel, validate quality like a product manager, merge, and close with an HTML report and papercraft milestone presentation, while spending few orchestrator tokens.
---

# Orquestar la colmena

Tú eres el **PM y validador de calidad**; los workers (Codex, OpenCode) implementan. El agente **no ve esta conversación**: el brief debe bastar por sí solo.

## 1. Elegir worker
- `workers` → mira `available`, `remaining_usd`, `strengths` y `priority`.
- Por defecto `luna-max` (Codex, prioridad 1); cuando se agote o necesites paralelismo extra → `ds-flash` (DeepSeek V4.1 Flash en OpenCode Go, con presupuesto). Luna solo va por Codex. Si omites `worker` el router elige (usa `kind: "code"|"docs"|…` como pista).
- **`max-hive`** (`worker: "max-hive"` o `kind: "bulk"`): muchas tareas pequeñas y mecánicas en paralelo a costo ~0, con un modelo *contributor* (sin zero data retention: nada sensible) y calidad menor → **valida siempre** con `review`/`diff` y registra tu `verdict` antes de fusionar. Para cambiarle el modelo usa `scripts/opencode-models.mjs --contributor`, edita `colmena.yml` y llama `reload_config` (detalle en el README).
- Si un worker está sin presupuesto, `run` falla con alternativas: no hay cambio silencioso; decide tú.
- OpenCode carga ~50k tokens de contexto por ejecución: no lo uses para tareas triviales.

## 2. Brief (3–8 líneas)
Objetivo y *por qué* · rutas exactas (`context_files`) y qué NO tocar · criterio de aceptación con comando de prueba · restricciones. Sin código largo: apunta a archivos.

## 3. Ronda
1. `run_many` (cada tarea en su worktree `colmena/<id>`). Una tarea → `run` (`wait: true` si es corta).
2. `wait` (mode `all`; repite mientras haya `pending`). El usuario recibe toasts al lanzar, cada 10 min y al terminar.
3. `result` en `min`; solo `normal`/`full` si hace falta. Si `reportOk` es false lee `text`.
4. **Valida como PM:** `review` (rol reviewer) y/o `diff`; corre tú los tests en la rama si es crítico. Tras revisar, registra el veredicto con `verdict {job_id, verdict: "accepted"|"needs_work", note?}`: `accepted` solo si cumple el brief; `needs_work` si requiere correcciones (un job `done` no está aceptado hasta que exista veredicto). Si falta algo: `continue` con feedback concreto (mismo worker y sesión) y registra un veredicto nuevo al corregirlo.
5. Encadenar: `compact` del primero → `handoff` con `from: [id]`.
6. `merge` (manual, solo después del veredicto: sin `verdict` registrado rechaza con error y exige `force: true` para saltarse la puerta; `squash` para historial limpio) → **`report`** con los `job_ids` de la ronda (estilo `papercraft`) → **`present`** para cerrar cada feature/hito con los mismos `job_ids` (`luna-max` redacta el deck por defecto; `open: true` lo abre).
7. **Audita el deck antes de compartirlo:** abre `deck.html`, contrasta cada dato con `result`, `review`/`diff` y las pruebas; verifica objetivo, decisiones y riesgos en `notes`. Si hay errores, continúa `presenterJob` con instrucciones concretas o vuelve a llamar `present` con notas de corrección. Comparte la ruta/enlace con el dueño solo cuando la presentación pase esta revisión.
8. `cleanup` cuando corresponda; `present` crea su carpeta dentro de `reports/` y no publica el archivo.

## 4. Ahorro de tokens
Quédate en `detail: "min"`; los logs completos están en disco. No releas lo ya reportado: pide `summarize`. Si un job falla o hace timeout, lee `error` antes de relanzar y cambia algo del brief.

## 5. Agregar el widget al escritorio
- Llama `widget {action: "start"}` para iniciar la escena de Colmena y registrar el PID verificado.
- Llama `widget {action: "status"}` para confirmar que sigue corriendo; el estado comprueba la ruta del ejecutable contra el registro `widget-process.json` dentro de `COLMENA_HOME`.
- Llama `widget {action: "stop"}` para cerrar el proceso registrado y esperar su salida. La tool solo acepta `action`; no recibe rutas ni argumentos de proceso.
- El binario se toma de `COLMENA_WIDGET_BIN` o de `widget/dist/colmena-widget.exe`. Si no existe, ejecuta `cargo build --release` desde `widget/` y copia `target/release/colmena-widget.exe` a `widget/dist/`.
- La integración MCP se habilita con `plugins.widget.enabled: true` (defecto). Tras iniciar, confirma con `status` antes de dar por agregado el widget.

## 6. Cuidado
Los agentes corren sin sandbox ni aprobaciones. Prefiere `worktree`; `inplace` solo con árbol limpio y tarea acotada; `readonly` para investigar/auditar. Nunca fusiones sin revisar. `cleanup` exige `force` para descartar trabajo no fusionado.
