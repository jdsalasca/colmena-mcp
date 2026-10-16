# Backlog de mejora continua — hallazgos reales de la ronda 1 (2026-10-16)

Fuente: dogfooding de colmena (jobs A–F, widget, revisiones, pruebas reales con Codex y OpenCode). Cada ítem lleva evidencia y un brief listo para delegar (TDD, código limpio, sin duplicación).

## Ya corregido en esta ronda
| Hallazgo | Evidencia | Arreglo |
|---|---|---|
| `continue` con Codex real fallaba | `codex exec resume` rechaza `-C` y `-s` (`unexpected argument '-C'`); el fake no lo detectaba | adaptador sin `-C`/`-s` en resume + fake estricto |
| Agente de Codex fusionó a `develop` y borró su worktree | `~/.codex/AGENTS.md` global ordena integrar y limpiar | reglas de git en el prompt de jobs worktree (prevalecen sobre AGENTS.md) |
| OpenCode heredaba la config global del usuario | ~47k tokens por ejecución trivial, `cat-jam-free` fallaba (`tools` > 128), agente `chatgpt-coordinator` alargaba jobs 10+ min, `ProviderHeaderTimeoutError` | `XDG_CONFIG_HOME` aislado (`providers.opencode.isolate_config`): ~8k tokens, costo 5-6× menor, `cat-jam-free` funciona |
| `stats`: errores truncados antes de agrupar, promedio con jobs sin duración, `__proto__`, totales distintos a `report` | revisión independiente | helper compartido `job-metrics.js` + tests |

## Pendiente (priorizado por impacto / esfuerzo)

### 1. Reiniciar el servidor MCP no debe cancelar jobs en curso — impacto alto / esfuerzo medio
Evidencia: `src/server.js` cancela todo `running/queued` al cerrar stdin; reiniciar la sesión mata las abejas activas. Brief: con TDD, al cerrar el servidor los jobs deben seguir (procesos independientes) o quedar `orphaned` recuperables con `recoverOrphans`; añade una opción `shutdown.cancel_jobs` (defecto false) y prueba que un job `SLEEP` sobrevive al cierre del servidor y que el servidor nuevo lo reconoce/espera.

### 2. Resultado con `model` y contrato real↔fake — impacto alto / esfuerzo bajo
Evidencia: para confirmar que el hive arrancó como `step-5-preview` hubo que inspeccionar la línea de comandos del proceso y el log de OpenCode. Brief: guardar `model`, `provider` y `effort` en `meta.json`/`result` (con TDD) y añadir `scripts/contract-check.mjs` que ejecuta una ejecución real mínima por proveedor (opcional, no en CI) verificando flags de resume/readonly y que el modelo reportado coincide.

### 3. Worker `free: true` para costo cero garantizado (hive) — impacto alto / esfuerzo bajo
Evidencia: `step-5-preview` aparece "Free" en el selector pero OpenCode reporta costo nominal ($0.0088/run con config aislada, $0.047 con la global); `cat-jam-free` y `longcat-2.5-preview-free` reportan 0. Brief: campo `free: true` en `colmena.yml` (zod) que registra el costo en 0 en el ledger y guarda `nominal_cost_usd` aparte; `workers`/`stats` muestran ambos; test de ledger y de `reload_config`.

### 4. `cleanup` detecta ramas ya fusionadas por git — impacto medio / esfuerzo bajo
Evidencia: tras fusionar a mano ramas de jobs, `cleanup` exigió `force` porque solo `merge` marca `merged`. Brief: calcular `merged` con `git merge-base --is-ancestor <rama> HEAD` además del flag; test con fusión manual y con squash.

### 5. Estándares: no crear archivos de planificación fuera de lo pedido — impacto medio / esfuerzo bajo
Evidencia: el agente de las correcciones dejó `docs/plan.md` por costumbre de superpowers. Brief: añadir al preámbulo por defecto "No crees archivos de plan ni notas fuera de los entregables pedidos"; test del preámbulo.

### 6. `wait` y trabajos largos — impacto medio / esfuerzo bajo
Evidencia: `wait` tiene tope de 600 s y los jobs de Codex tardan 4-15 min. Brief: devolver `pending` con estimación y permitir `timeout_s` hasta 1800 con latidos intermedios; test con relojes inyectados.

### 7. Presupuesto con reservas concurrentes — impacto medio / esfuerzo medio
Evidencia: el router mira gasto ya registrado; varias tareas simultáneas pueden exceder un presupuesto. Brief: reservar un estimado al encolar y reconciliar al terminar; test con N jobs simultáneos.

### 8. Modelos con `max-hive`: validar calidad antes de confiar — impacto medio / esfuerzo bajo
Evidencia: el job D (max-hive, muse-spark) cumplió TDD y quedó bien, pero parchea `fs.writeFileSync` global en el test (frágil). Brief: tarea de calidad: reemplazar ese espía por inyección de dependencias y registrar en `stats` la tasa de aprobación de cada worker tras revisión del orquestador.
