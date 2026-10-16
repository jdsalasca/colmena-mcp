# Colmena Widget para Windows — plan de implementación

> Plan delegable: cada tarea incluye archivos, contratos, pruebas y resultado verificable. Ejecutar las tareas en orden; usar agentes distintos solo en tareas sin dependencias activas y sin editar los mismos archivos.

**Objetivo:** construir en `widget/` un widget de escritorio Windows en Go + Ebitengine que representa jobs de colmena-mcp como abejas pixel art.
**Spec:** `docs/superpowers/specs/2026-10-16-colmena-widget-design.md`.
**Alcance:** los cambios de producto se limitan a `widget/`. La integración Node MCP es una tarea posterior separada, documentada al final.

## Contexto que cada agente necesita

Lee primero el spec anterior y el contrato real del repo: `src/store.js` escribe `<COLMENA_HOME>/jobs/<id>/meta.json` como JSON temporal más rename; `src/jobs.js` crea jobs en cola con `createdAt`, los marca en ejecución con `startedAt`, y al finalizar asigna `endedAt`, estado y `costUsd` cuando corresponde. Al recuperar el servidor puede marcar un job activo como `orphaned`. La aplicación Go solo lee estos datos.

El home es `COLMENA_HOME` cuando existe y, en otro caso, `%USERPROFILE%\.colmena`. La aplicación no ejecuta agentes ni modifica los metadatos. Usa Go 1.23 como mínimo, módulo independiente en `widget/go.mod`, Ebitengine v2 y `golang.org/x/sys/windows`. Fija versiones compatibles con el Go mínimo: Ebitengine 2.9 requiere Go 1.24 y Ebitengine 2.10 requiere Go 1.25; con Go 1.23 usa una versión compatible, por ejemplo la línea 2.8.x. Confirma constraints de dependencias antes de fijarlas.

No hay un `docs/plan.md` preexistente. Este documento es el plan autorizado para el widget. No crees archivos de plan adicionales ni cambies el repo Node por fuera de la tarea futura de Integración MCP.

## Reglas de implementación

- Trabaja con TDD en cada unidad: define API mínima, escribe la prueba, ejecuta y observa una falla de aserción que corresponda al comportamiento faltante; implementa lo mínimo para pasar; refactoriza duplicación y vuelve a ejecutar. No aceptes como “rojo” un fallo de entorno o una prueba que ni compila. En un paquete nuevo, pueden crearse primero las declaraciones de tipos/firmas sin comportamiento para que las pruebas compilen.
- Al cerrar cada tarea ejecuta `cd widget; go test ./...` y conserva la salida real. Usa `gofmt` en los archivos Go. No dupliques formatos/lectores/reglas de colores; comparte los helpers del paquete correspondiente.
- La lógica de dominio debe aceptar reloj, snapshots y límites por parámetro. No debe llamar a Ebitengine, Win32, `time.Now()` o filesystem.
- Mantén acceso a HWND en la capa Windows; la app gráfica no debe dispersar llamadas Win32.
- No cargues imágenes ni sprites desde disco o internet.
- Cada agente recibe el brief completo de su tarea aquí, el spec y su lista exacta de archivos. No necesita esta conversación.
- No tocar código Node hasta la tarea 8. Cada ejecución usa commits pequeños solo en la rama de trabajo que le asigne el orquestador; no cambiar ramas, mover worktrees ni hacer push/merge.

## Contratos comunes

Tipos de datos de jobs en `widget/internal/jobs/model.go`:

- `State`: cadenas `queued`, `running`, `done`, `failed`, `cancelled`, `orphaned`.
- `Job`: `ID, Task, Worker, Provider, Branch string`; `State`; `Kind string`; `CreatedAt, StartedAt, EndedAt int64` en milisegundos Unix; `CostUSD *float64`.
- Decodificación JSON con nombres del Node: `id`, `state`, `kind`, `task`, `worker`, `provider`, `branch`, `createdAt`, `startedAt`, `endedAt`, `costUsd`.

Tipos de geometría del dominio en `widget/internal/scene/types.go`:

- `Point{X, Y float64}`, `Rect{X, Y, W, H float64}`.
- `Motion`: `sleeping`, `queued`, `flying`, `returning`, `falling`.
- `Bee`: `Job`, `Motion`, `From, Target Point`, `MotionStarted time.Time`, `MotionDuration time.Duration`, `Phase float64`, `Radius float64`, `WorkerStyle`, `MissingPolls int`.
- `Scene{Bees []Bee, Effects []Effect, Menu Menu}`; abejas ambientales sin job pueden tener `Job.ID == ""`.
- `Menu{Open bool, Bounds, ExitBounds Rect}`; `Action` distingue al menos ninguna acción y Salir. `Effect` incluye tipo, punto, instante inicial y duración.
- Los contratos pueden ampliarse si el mismo agente actualiza todas las pruebas y consumidores afectados; no dupliques tipos paralelos.

## Tarea 1 — Módulo y lector de jobs

**Brief para el agente:** implementa un paquete Go puro que traduzca los metadatos reales de colmena en snapshots deterministas. No inicialices Ebitengine ni uses APIs Windows.

**Archivos:** crear `widget/go.mod`, `widget/internal/jobs/model.go`, `widget/internal/jobs/reader.go`, `widget/internal/jobs/reader_test.go`.

**API:**

- `func ResolveHome(envHome, userProfile string) string`: usa `envHome` no vacío; si está vacío, devuelve `filepath.Join(userProfile, ".colmena")`.
- `func ReadSnapshot(home string) ([]Job, error)`: lee solo carpetas hijas inmediatas de `home/jobs`, no sigue enlaces ni escribe; decodifica `meta.json`, omite un metadato ilegible/malformado o estado desconocido sin abortar otros jobs, devuelve error para un error al enumerar `jobs` distinto de “no existe”, y ordena por ID para resultado estable. Directorio inexistente equivale a lista vacía.
- Mapear timestamps en milisegundos sin convertirlos prematuramente a segundos; el costo ausente queda como nil.

**Pruebas primero:** resolución con variable/fallback; directorio jobs ausente; estados conocidos y campos opcionales; varias carpetas ordenadas; JSON inválido junto a JSON válido no cancela el snapshot; estado desconocido se omite; costo ausente frente a costo cero; directorio raíz ilegible devuelve error.

**Ciclo:** escribe tests y verifica que fallan por aserciones de resultado; agrega firmas/tipos vacíos solo para que compile; implementa lectura mínima; refactoriza validación y errores sin repetir lógica. Ejecuta `go test ./...`.

**Aceptación:** el test usa solo directorios temporales, lee JSON con el mismo casing y valores que `src/store.js`, y demuestra que no se modifica ningún archivo fixture.

## Tarea 2 — Dominio puro: estilos, escena, trayectorias e interacción

**Brief para el agente:** implementa la máquina de estados visual pura. Debe representar jobs como abejas y ser testeable sin GPU ni reloj real. Consume `internal/jobs.Job`; no importa Ebitengine, filesystem ni x/sys.

**Archivos:** crear `widget/internal/scene/types.go`, `worker.go`, `time.go`, `layout.go`, `trajectory.go`, `hit_test.go`, y sus pruebas `*_test.go`.

**Firmas compartidas:**

- `func StyleForWorker(alias string) WorkerStyle`.
- `func FormatElapsed(d time.Duration) string`.
- `func TooltipFor(job jobs.Job, now time.Time) Tooltip`.
- `func Reconcile(previous Scene, snapshot []jobs.Job, now time.Time, bounds Rect) Scene`.
- `func PositionAt(bee Bee, now time.Time) Point`.
- `func HitTestBee(scene Scene, point Point, now time.Time) (jobs.Job, bool)`.
- `func HitTestMenu(menu Menu, point Point) Action`.
- `func DragPosition(origin, pointerStart, pointerNow Point) Point`.
- Si hace falta, `func PlaceTooltip(anchor Point, size, bounds Rect) Point` para mantener el tooltip dentro del área.

**Pruebas primero:**

- Tabla de alias: luna dorada, ds/deepseek azul, hive pequeño verde, desconocido neutral; mayúsculas no cambian el resultado.
- Duración: cero, 9 segundos, cruce de minuto, más de una hora sin reiniciar minutos, y duración negativa.
- Tooltip: queued usa createdAt y etiqueta espera; running usa startedAt y se recalcula con now; tarea multibyte se limita a 60 runas sin romper UTF-8; costo ausente dice pendiente y cero se muestra como costo cero.
- Reconcile: un job queued genera una abeja junto a la entrada; queued→running conserva ID y cambia a vuelo; running→done produce retorno y brillo; failed/orphaned producen caída roja; cancelled vuelve neutra; un snapshot terminal inicial no revive historial; job activo ausente durante una lectura se conserva por hasta dos polls y se descarta después del tercero; no hay jobs ni salidas → abejas dormidas.
- Geometría: mismo ID y tiempo producen el mismo layout; todos los jobs activos tienen abeja; trayectorias respetan límites; hit-test encuentra un hover, resuelve solapes con regla estable, ignora abejas dormidas; menú distingue Salir/fuera; drag mantiene el offset; tooltip se recoloca en los bordes.

**Ciclo:** tests con timestamps y bounds fijos; comprobar rojo semántico; implementación mínima; refactor para compartir límites, easing y resolución de solapes. Ejecuta `go test ./...`.

**Aceptación:** repetir `Reconcile` con iguales entradas produce igualdad estable; no se usa estado global; todas las transiciones de la spec tienen cobertura de tests.

## Tarea 3 — Persistencia y clamp de posición

**Brief para el agente:** implementa el almacenamiento local de la posición inicial/final de la ventana sin acoplarlo a Win32 ni a Ebitengine. No guardes nada en las carpetas de jobs.

**Archivos:** crear `widget/internal/position/store.go`, `widget/internal/position/store_test.go`.

**API:**

- `type Position struct { X, Y int }`.
- `type Rect struct { X, Y, Width, Height int }`: área de trabajo en coordenadas de pantalla, con origen que puede ser negativo.
- `func Load(path string, fallback Position) (Position, error)`: archivo ausente devuelve fallback sin error; JSON corrupto devuelve fallback y error; estructura válida devuelve posición.
- `func Save(path string, position Position) error`: crea el directorio padre y escribe JSON en temporal más rename.
- `func Clamp(position Position, widgetWidth, widgetHeight int, workArea Rect) Position`: devuelve la posición más cercana que deja visible la ventana en el área de trabajo.

**Pruebas primero:** ausencia y fallback; archivo correcto; JSON corrupto; escritura crea el directorio y se puede leer de vuelta; error de escritura propagado; coordenadas normales, cada borde, ventana más grande que el monitor y work area con origen negativo.

**Ciclo:** tests en `t.TempDir()`; observar fallas de valores/clamp; implementar; refactorizar el reemplazo atómico y validación; ejecutar `go test ./...`.

**Aceptación:** guardar posición existente no deja archivos temporales residuales y un archivo inválido nunca impide arrancar.

## Tarea 4 — Adaptador de ventana Win32

**Brief para el agente:** encapsula comportamiento nativo requerido por el widget y evita activar o elevar la ventana sobre otras aplicaciones. No dibujes la escena en este paquete.

**Archivos:** crear `widget/internal/platform/windows/window_windows.go`, `window_windows_test.go` y, si se requiere para que otros GOOS compilen, un archivo stub `window_other.go` con la misma interfaz y error explícito de “solo Windows”.

**API:**

- `func FindWidgetWindow(pid uint32, title string, timeout time.Duration) (windows.HWND, error)`: enumera ventanas hasta timeout y elige la ventana del PID con título exacto.
- `type WindowAPI interface` con `GetWindowLongPtr(hwnd windows.HWND, index int32) (uintptr, error)`, `SetWindowLongPtr(hwnd windows.HWND, index int32, value uintptr) error` y `SetWindowPos(hwnd, after windows.HWND, x, y, cx, cy int32, flags uint32) error`.
- `func ConfigureWidgetWindow(api WindowAPI, hwnd windows.HWND) error`: aplica estilo de ventana de herramienta, elimina estilo de ventana de aplicación de taskbar y refresca el marco. No activa ni aplica estilo topmost.
- `func KeepAtBottom(api WindowAPI, hwnd windows.HWND) error`: usa SetWindowPos con HWND_BOTTOM y flags equivalentes a SWP_NOACTIVATE/SWP_NOMOVE/SWP_NOSIZE.
- `func MonitorWorkAreas() ([]position.Rect, error)`: devuelve áreas de trabajo de monitores en coordenadas coherentes con el movimiento de Ebitengine.
- `WindowAPI` abstrae lecturas/escrituras de estilo y SetWindowPos con firma propia, para probar los flags sin llamar a Win32 real.

**Pruebas primero:** con un API falso, conserva bits no relacionados, activa WS_EX_TOOLWINDOW, elimina WS_EX_APPWINDOW, no activa topmost, pasa HWND_BOTTOM y NOACTIVATE, y devuelve errores de Win32. Prueba selección por PID/título y timeout mediante un enumerador aislado si es viable.

**Ciclo:** define interfaz mínima; tests de flags fallan; implementación Win32; refactor de constantes y errores; `go test ./...` en Windows. Un build cruzado verifica que los build tags no rompen el módulo.

**Spike visual obligatorio:** al crear la ventana Ebitengine, encuentra su HWND dentro de un timeout, aplica estilos, y confirma que aparece en escritorio, no figura en taskbar, recibe hover y clic derecho, y una ventana normal la cubre. Si HWND_BOTTOM la oculta detrás de Explorer o el estilo no permite entrada, documenta la observación y prueba una alternativa de desktop layer antes de continuar; no introduzcas dependencias en APIs privadas de Ebitengine sin registrar el riesgo en el README.

## Tarea 5 — Arte pixelado y vista Ebitengine

**Brief para el agente:** dibuja la escena desde matrices de píxeles codificadas en Go. No uses imágenes externas ni mezcles acceso a jobs en Draw.

**Archivos:** crear `widget/internal/art/sprite.go`, `palette.go`, `sprites.go`, tests puros; crear `widget/internal/view/game.go` y pruebas unitarias que no inicialicen la ventana.

**API del arte:**

- `type Sprite struct { Rows []string; Palette map[rune]color.NRGBA }`.
- `func DrawSprite(dst *ebiten.Image, sprite Sprite, x, y, scale int)`.
- `func BeeSprite(motion scene.Motion, style scene.WorkerStyle, frame int) Sprite`.
- `func SceneSprites() []Sprite` o composiciones equivalentes para colmena, suelo, flores y hongo.
- `func TooltipSpriteData(tooltip scene.Tooltip) []Sprite` solo si ayuda a separar layout del dibujo; no dupliques truncado ni formato de costo.

Los frames de vuelo deben alternar alas al ritmo previsto; fallar usa una versión roja; dormir incluye Zz; done incluye destello. El fondo transparente debe rodear el pastizal y permitir identificar la ventana sin assets.

**Pruebas primero:** sprites no vacíos y rectangulares; cada símbolo usado existe en la paleta; paleta worker correcta; frames de alas diferentes; frame dormido/fallido/destello seleccionado para cada Motion; tamaño de salida esperado de escala entera.

**Ciclo:** tests de matrices/paleta; rojo por frame o color ausente; implementación; refactor de dibujo común; `go test ./...`. Ebitengine no debe inicializarse desde tests unitarios.

**Aceptación:** cada píxel procede de matrices/paleta o figuras dibujadas por código; no hay rutas a PNG/GIF ni archivos de recursos.

## Tarea 6 — Aplicación, polling, mouse, menú y tooltip

**Brief para el agente:** conecta el lector, escena, persistencia, capa Windows y vista. Mantén lectura de archivos fuera del Update/Draw y conserva la última escena válida ante un error de lectura.

**Archivos:** crear `widget/cmd/colmena-widget/main_windows.go`, `widget/internal/app/app.go`, `app_test.go`, `poller.go`, `poller_test.go`; modificar solo paquetes de widget previos cuando haga falta.

**Firmas del app:**

- `func New(home string, platform Platform, clock func() time.Time) (*App, error)`.
- `func (a *App) Update() error`, `func (a *App) Draw(screen *ebiten.Image)`, `func (a *App) Layout(outsideWidth, outsideHeight int) (int, int)`.
- `type Platform interface` con `CurrentPosition() (position.Position, error)`, `MoveTo(position.Position) error`, `WorkAreas() ([]position.Rect, error)` y `ConfigureAndDock(title string, pid uint32, timeout time.Duration) error`; se inyecta para pruebas.
- `type SnapshotResult struct { Jobs []jobs.Job; Err error }`, `type SnapshotReader func(home string) ([]jobs.Job, error)` y `func StartPolling(ctx context.Context, home string, interval time.Duration, read SnapshotReader) <-chan SnapshotResult`. El poller emite una lectura inmediata, luego cada intervalo y cierra su canal al cancelar el contexto.
- El poller lee el snapshot al iniciar y luego cada segundo. En error, reporta una advertencia y mantiene el último snapshot. Publica al hilo gráfico solo snapshots completos.
- Configura ventana con título Colmena Widget, tamaño inicial fijo, sin decoración, no redimensionable, transparencia si la versión fijada lo soporta; nunca usa Ebitengine floating/topmost.
- Mouse izquierdo arrastra y al soltar persiste; hover actualiza tooltip usando el clock; clic derecho abre el menú de Salir; la opción Salir detiene el poller y termina limpiamente. Luego de cada drag/click, restablece el nivel inferior sin robar foco.

**Pruebas primero:** inyectar platform y clock; error inicial de posición usa fallback; error de lector mantiene última escena; actualización del tooltip avanza mm:ss; drag llama a Move con coordenadas esperadas y guarda al soltar; menú abre/descarta y Salir cierra; el goroutine del poller termina por cancelación. Si Update se prueba con una interfaz del dominio, no cree ebiten.Image ni inicialice GLFW.

**Ciclo:** pruebas de app con fakes; rojo de callback/estado; conexión mínima; refactor de ciclo de vida y canales; `go test ./...`.

**Aceptación:** no hay I/O de disco ni llamada Win32 dentro de Draw; una lectura lenta nunca bloquea render; detener la app deja de hacer polling.

## Tarea 7 — Build, verificación visual y README

**Brief para el agente:** prepara la entrega instalable para desarrollo local y deja evidencia que otro agente pueda revisar.

**Archivos:** crear `widget/README.md`, `widget/.gitignore` (ignora `/dist/`), `widget/docs/verification/desktop-widget.png` como evidencia; compilar a `widget/dist/colmena-widget.exe` sin versionar el binario.

**Verificación automatizada:**

1. Ejecutar `cd widget; go test ./...` con el resultado completo.
2. Ejecutar `cd widget; go vet ./...`.
3. En Windows amd64 crear `dist/`, ejecutar `go build -o dist/colmena-widget.exe ./cmd/colmena-widget` y comprobar que el archivo existe y tiene tamaño mayor que cero.
4. Ejecutar en modo local con home temporal y fixtures de los seis estados, nunca con agentes reales. Confirmar que no se escriben jobs ni se accede a credenciales.
5. Repetir build después de los cambios de README, captura o ajustes visuales.

**Verificación visual real:** arrancar el exe en un escritorio Windows disponible, producir una captura PNG con el widget visible, y conservarla en la ruta indicada. Inspeccionar la captura a escala 100% y verificar pastizal, colmena, flores, hongo, estados queued/running/done/failed, tooltip legible, menú contextual y fondo transparente. Probar además drag + reinicio para posición, hover/right click, taskbar y orden Z con otra ventana normal; la captura por sí sola no prueba orden Z. Si el escritorio no tiene una app normal abierta, abrir una ventana inocua y confirmar que cubre el widget. No declarar visual aprobado si solo compila.

**README:** documenta requisitos/versiones Go, cómo leer COLMENA_HOME, instalar dependencias con `go mod download`, test/build/run, estructura por paquetes, interacciones, límites de datos, screenshot y troubleshooting de HWND/Explorer. No incluyas datos reales de jobs ni secretos. Explica que se puede crear un acceso directo de Windows a `dist/colmena-widget.exe`.

**Aceptación:** `go test ./...`, `go vet ./...` y build pasan en la máquina Windows; captura examinada y README permite repetir el procedimiento. Reporta cualquier comportamiento parcial como pendiente, con evidencia.

## Tarea 8 — Integración MCP (posterior e independiente)

**No ejecutar en la primera entrega del widget.** Después de integrar y verificar el ejecutable, agregar al servidor Node una tool MCP `widget {action: start|stop|status}` que gestione el binario en segundo plano, evite duplicados y reporte el PID. Esta tarea tiene ownership explícito del servidor y sus tests:

**Archivos candidatos:** crear `src/widget.js`, `test/widget.test.js`; modificar `src/config.js`, `src/tools.js`, `test/server.test.js`, `README.md` raíz solo si se aprueba actualizar el catálogo de tools.

**Interfaz:** `createWidgetController({home, executable, spawn, processControl, mutex, logger}) → {start(), stop(), status()}`. `start()` resuelve el exe conocido del repo (sin aceptar path o flags libres desde MCP), hereda entorno con `COLMENA_HOME`, lo lanza detached y oculto, desacopla el stdio y devuelve `{state:"running", pid}`; `status()` devuelve running/stopped y PID si es propio; `stop()` detiene solo el proceso verificado por ruta/PID y confirma salida antes de borrar registro. Una ejecución duplicada devuelve el PID existente.

**Diseño de proceso:** serializar acciones concurrentes del controlador; guardar un registro de proceso atómico bajo `<COLMENA_HOME>` para sobrevivir reinicios del servidor; comprobar proceso vivo y ruta del ejecutable antes de actuar; manejar PID obsoleto/reutilizado sin matar un proceso ajeno. La app Go debe adquirir un mutex nombrado por home para cerrar la carrera entre dos servidores MCP; si ya existe una instancia, devuelve o publica su PID de forma verificable. No confiar solo en que un `spawn` tuvo éxito como prueba de que la ventana arrancó.

**TDD:** pruebas de schema MCP con las tres acciones; start crea una única instancia y entrega PID; dos starts simultáneos no duplican procesos; PID obsoleto permite iniciar; estado detecta salida inesperada; stop mata solo exe propio y conserva registros si no confirma salida; ruta/binary ausente devuelve error útil; el tool status funciona después de reconstruir el controlador. Fakes inyectables, sin lanzar un widget real en tests. Ejecutar `npm test` y validar las tools con el harness MCP.

**Cierre separado:** build Go y tests Go siguen verdes después de integrar; suite Node verde; comprobación manual start/status/stop por MCP observa la ventana y el PID; actualizar documentación MCP. No fusionar esta tarea con una primera implementación sin autorización separada.

## Secuencia resumida

1. Lector de jobs y tipos.
2. Máquina visual pura, trayectorias e interacción.
3. Persistencia y clamp de posición.
4. Adaptador Win32 + spike temprano de orden Z y mouse.
5. Arte y vista Ebitengine.
6. App/poller e interacción integrada.
7. Test + vet + build Windows, captura revisada y README.
8. En una ronda posterior, integración MCP Node con pruebas propias.
