# colmena-mcp v0.2 — Diseño (multi-proveedor, YAML, plugins)

Fecha: 2026-10-16 · Estado: aprobado por el usuario en conversación · Extiende `2026-10-15-luna-mcp-design.md` (v0.1: solo Codex/Luna).

## 1. Propósito

Claude Code orquesta y valida (rol de PM); **Codex** y **OpenCode** son los obreros. El servidor MCP `colmena` lanza agentes, elige worker según prioridad y presupuesto, avisa al usuario por toast de Windows y genera reportes HTML de cierre. Éxito = Claude delega casi todo con briefs cortos, el usuario ve qué corre, y al final recibe un HTML bonito (papercraft) con lo logrado.

No-objetivos: consultar saldos reales de las cuentas (no hay API; el presupuesto es declarativo + conteo local), UI web propia, modelos libres por llamada.

## 2. Cambios respecto a v0.1

- Proyecto `colmena-mcp`, servidor MCP `colmena`, herramientas **sin prefijo** (`run`, `run_many`, `wait`, …). Variables `COLMENA_*` (las `LUNA_*` siguen aceptándose como alias legado). Home por defecto `~/.colmena`.
- El modelo ya no es constante: se elige un **alias de worker** definido en `colmena.yml`. Las herramientas jamás aceptan un modelo o flag libres.
- Proveedores = adaptadores. Codex (existente) y OpenCode (nuevo).

## 3. `colmena.yml`

Ubicación: `$COLMENA_CONFIG` o `<home>/colmena.yml`; si no existe se usa el default embebido (no se escribe solo; `colmena_config` no existe, el README documenta el ejemplo). Validado con zod; error claro con la ruta del campo.

```yaml
workers:
  luna-max:       {provider: codex,    model: gpt-6-luna, effort: max, priority: 1, strengths: [code, refactor, tests]}
  deepseek-pro:   {provider: opencode, model: opencode-go/deepseek-v4-pro, effort: max, priority: 2, strengths: [code], budget: {monthly_usd: 10}}
  deepseek-flash: {provider: opencode, model: opencode-go/deepseek-v4.1-flash, priority: 3, strengths: [docs, summary, report]}
roles:    {reporter: deepseek-flash, summarizer: deepseek-flash, reviewer: luna-max}
defaults: {worker: luna-max, max_parallel: 4, timeout_min: 60}
plugins:
  notify: {enabled: true, on: [start, finish, fail], heartbeat_min: 10}
  report: {enabled: true, default_style: papercraft}
```
Campos opcionales por worker: `price_per_mtok: {input, output}` (USD, para estimar costo de Codex), `budget.monthly_usd`, `enabled` (true). `effort` se pasa tal cual al proveedor (`model_reasoning_effort` en Codex, `--variant` en OpenCode).

Default embebido (sin yml): `luna-max` (codex/gpt-6-luna/max), `deepseek-pro`, `deepseek-flash` como arriba, plugins activos.

## 4. Adaptadores

Interfaz `Adapter`: `id`, `resolveBin(config) → {bin, prefixArgs}`, `buildArgs({prompt, workdir, lastMessagePath, readonly, resumeSessionId, ephemeral, worker}) → string[]`, `parseLine(line) → evento`, `lastMessageFromFile: boolean`.

Eventos normalizados: `{kind:'session', sessionId}`, `{kind:'message', text}`, `{kind:'usage', usage:{input_tokens, output_tokens, cost_usd?}}`, `{kind:'other'}`.

- **codex**: como v0.1, con `-m worker.model` y `-c model_reasoning_effort="<effort>"` (si hay effort). Mensaje final desde `-o`.
- **opencode**: `opencode run --format json -m <provider/model> [--variant <effort>] --auto --dir <workdir> [-s <session>] "<prompt>"`. Eventos verificados: `{"type":"text","sessionID","part":{"text"}}` y `{"type":"step_finish","part":{"tokens":{input,output,reasoning},"cost"}}`. Sesión = `sessionID`; mensaje final = último `text`; `cost` en USD. Binario: `COLMENA_OPENCODE_BIN` o `opencode` del PATH (`opencode.ps1` en Windows: se invoca vía `powershell.exe -NoProfile -File` o `cmd /c opencode`, a fijar en el spike H2).
- **Solo lectura en OpenCode**: no hay flag de sandbox. Se decide en el spike H2 (configuración de permisos deny por `OPENCODE_CONFIG_CONTENT` o agente dedicado); si no es aplicable, `readonly` en OpenCode se aplica por instrucción en el prompt y el resultado lleva `readonly_enforced:false`.

## 5. Presupuesto y ruteo

- `ledger`: `<home>/usage.json` acumulado por worker y mes `YYYY-MM`: `{runs, input_tokens, output_tokens, cost_usd}`. Costo = `cost_usd` del proveedor, o estimado con `price_per_mtok` si existe, o 0.
- `worker.budget.monthly_usd`: si el gasto del mes ≥ presupuesto, el worker se considera **agotado**.
- Herramienta `workers`: lista alias, proveedor, modelo, strengths, prioridad, gasto/presupuesto, `available`.
- Ruteo: `run` sin `worker` → `defaults.worker` si disponible; si no, el de menor `priority` disponible (opcional `kind` coincide con `strengths` y prioriza). Con `worker` explícito agotado → error que sugiere alternativas (no fallback silencioso).

## 6. Plugins

Bus de eventos interno: `job.started`, `job.finished`, `job.failed`, `job.cancelled` con `{id, worker, task, state, costUsd?}`.

### notify
- Toast de Windows vía `powershell.exe` 5.1 (WinRT `ToastNotificationManager`, AppId de PowerShell). Interfaz inyectable `Notifier.send({title, body})`; `COLMENA_NOTIFIER=none|log` para tests/CI.
- `start`: agrupa lanzamientos dentro de una ventana de 2 s en un toast ("Colmena: 3 agentes lanzados · luna-max×2, deepseek-flash×1").
- Latido cada `heartbeat_min` mientras `running+queued > 0` ("N corriendo · M en cola · X min · $Y"); sin trabajos no hay toast; timer `unref`.
- `finish`/`fail`: un toast por job (agrupado igual que start).
- Siempre añade línea a `<home>/activity.log`.

### report
- Herramienta `report {job_ids, style?, title?, open?}`: recopila reportes de los jobs (RESULT/FILES/TESTS/RISKS, worker, duración, costo, diffstat), escribe `<home>/reports/<fecha>-<slug>/data.json`, lanza un job con el worker del rol `reporter` (isolation inplace en esa carpeta) con el prompt: llenar `template.html` del estilo según `style.md` y guardar `report.html` autocontenido. Si el job falla o `report.html` no existe/no contiene `<html`, **renderizador de respaldo** determinista (sustituye marcadores en `template.html`). Devuelve `{path, usedFallback}`; `open:true` abre el archivo con el navegador predeterminado.
- Estilos = carpetas `styles/<nombre>/{style.md,template.html}` (en el repo y en `<home>/styles/`, esta última pisa). Primer estilo: **papercraft** (papel recortado en capas, sombras suaves, colores kraft/crema/pastel, cinta washi, ligeras rotaciones, tipografía manuscrita + serif, responsive, modo oscuro).

## 7. Herramientas MCP (v0.2)

`run`, `run_many`, `handoff`, `status`, `list`, `wait`, `result`, `diff`, `continue`, `summarize`, `compact`, `review`, `cancel`, `merge`, `cleanup` (semántica de v0.1; `run`/`run_many`/`handoff` aceptan `worker?`; `summarize`/`compact`/`review` usan los roles), más **`workers`** y **`report`**: 17 en total.

`continue` reutiliza el worker original del job. El resultado de `result`/`wait` incluye `worker` y `cost_usd`.

## 8. Seguridad
Sin cambios de postura: worktree por defecto, merge manual, cleanup con `force` para trabajo no fusionado, auditoría (ahora con worker). El YAML no permite flags arbitrarios; solo los campos del esquema.

## 9. Pruebas
Adaptadores y proveedores falsos (`fake-codex.js`, `fake-opencode.js`), notificador/relojes inyectables, validación de YAML (válido/ inválido/ default), ledger y router, plugin report con worker falso y con fallback, servidor MCP de extremo a extremo. Pruebas reales mínimas contra Luna y DeepSeek (`npm run smoke`).

## 10. Hitos
H1 renombre + YAML + adaptadores (Codex refactor) + registro del MCP · H2 OpenCode · H3 notify · H4 ledger/router/`workers` · H5 report + papercraft.
