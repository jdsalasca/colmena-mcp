# codex-mcp-juanda

Servidor MCP (stdio) para que **Claude Code actúe como orquestador** y delegue la implementación a agentes **`gpt-6-luna` con esfuerzo `max`** a través de Codex CLI. Los agentes corren sin aprobaciones, con búsqueda web en vivo, y devuelven un reporte de ≤15 líneas para gastar pocos tokens del orquestador.

- El modelo y el esfuerzo están **fijos** (no existen parámetros para cambiarlos).
- Aislamiento por llamada: `worktree` (rama `luna/<id>`, por defecto en repos git), `inplace`, `readonly`.
- Paralelismo con cola (`LUNA_MAX_PARALLEL`, 4 por defecto).
- Sesiones reanudables, resúmenes, compactación y relevo entre agentes.
- Sin base de datos: estado en `~/.luna-mcp/` (`jobs/`, `worktrees/`, `audit.log`).

## Requisitos

Node ≥ 22, git, Codex CLI autenticado (app de escritorio de Codex o `codex` en PATH). Si tu `config.toml` usa `model_reasoning_effort = "max"` necesitas un Codex reciente (0.162 funciona; 0.130 rechaza `max`). El servidor elige por defecto el `codex.exe` más reciente de `%LOCALAPPDATA%\OpenAI\Codex\bin`.

## Instalación

```bash
git clone https://github.com/jdsalasca/codex-mcp-juanda.git
cd codex-mcp-juanda
npm install
npm test
claude mcp add -s user luna -- node "<ruta-absoluta>/codex-mcp-juanda/src/server.js"
```

Humo real (gasta una llamada a Luna): `npm run smoke`.

### Variables de entorno

| Variable | Defecto | Uso |
|---|---|---|
| `LUNA_CODEX_BIN` | `codex.exe` más reciente | Ruta al binario (un `.js` se ejecuta con node; útil para tests) |
| `LUNA_HOME` | `~/.luna-mcp` | Estado, worktrees y auditoría |
| `LUNA_MAX_PARALLEL` | `4` | Agentes simultáneos |
| `LUNA_JOB_TIMEOUT_MIN` | `60` | Tiempo máximo por job |

## Herramientas

| Tool | Para qué |
|---|---|
| `luna_run` / `luna_run_many` | Lanza uno o varios agentes (`wait: true` espera el reporte) |
| `luna_wait`, `luna_status`, `luna_list` | Seguimiento (`wait` máx. 600 s, `mode: any|all`) |
| `luna_result` | Reporte `RESULT/FILES/TESTS/RISKS`, archivos, diffstat, rama (`detail: min|normal|full`) |
| `luna_diff` | Diff truncado; el completo queda en disco |
| `luna_continue` | Reanuda la sesión (`codex exec resume`) en el mismo workdir |
| `luna_summarize`, `luna_compact` | Luna resume/comprime una sesión (`summary.md`) |
| `luna_handoff` | Agente nuevo con los resúmenes de otros como contexto |
| `luna_review` | Revisión solo lectura de un job o cwd |
| `luna_cancel` | Cancela (mata el árbol de procesos) |
| `luna_merge` | Fusiona `luna/<id>` (manual; se niega con destino sucio; restaura ante conflictos) |
| `luna_cleanup` | Borra worktrees y ramas `luna/*` propios (exige `force` para descartar trabajo no fusionado) |

Flujo recomendado: `luna_run_many` → `luna_wait` → `luna_result` → `luna_review`/`luna_diff` → `luna_merge` → `luna_cleanup`. La skill `skills/luna-delegation/SKILL.md` explica cómo redactar los briefs.

## Seguridad

Los agentes corren **sin sandbox ni aprobaciones** (`--dangerously-bypass-approvals-and-sandbox`). Con `inplace` un agente puede modificar o borrar cualquier archivo accesible a tu usuario. Por eso `worktree` es el valor por defecto en repos git, `luna_merge` nunca se ejecuta solo, `luna_cleanup` solo toca `luna/*` bajo `LUNA_HOME/worktrees`, y cada lanzamiento queda en `audit.log`. Úsalo solo en repos y máquinas de confianza.

## Desarrollo

`npm test` usa un `codex` falso (`test/fake-codex.js`) y repos git temporales; no gasta llamadas reales.

Diseño: `docs/superpowers/specs/2026-10-15-luna-mcp-design.md` · Plan: `docs/superpowers/plans/2026-10-15-luna-mcp.md`.
