# Colmena Widget para Windows — plan de implementación

> **Para agentes de ejecución:** usar la skill superpowers:executing-plans para trabajar tarea por tarea. Cada tarea termina en un commit pequeño en la rama de trabajo asignada; no cambiar ramas, no hacer merge ni push, y no mover ni borrar el worktree. Las tareas se pueden entregar a agentes nuevos: cada brief indica rutas, contratos, pruebas y aceptación.

**Objetivo:** construir en widget/ un widget nativo de escritorio Windows en Rust que representa cada job de colmena-mcp como una abeja pixel art.

**Spec:** docs/superpowers/specs/2026-10-16-colmena-widget-design.md

**Stack:** Rust 1.99, edición 2024, Cargo, serde/serde_json, windows-rs crate windows para Win32, render de software en framebuffer BGRA premultiplicado. Solo APIs Win32 para ventana y capa GDI/DIB para UpdateLayeredWindow; sin winit, softbuffer, GPU, runtime asíncrono ni recursos de imagen externos.

## Restricciones globales

- El módulo Cargo independiente vive en widget/ y produce colmena-widget.exe para Windows x64 MSVC.
- El ejecutable no requiere runtime de lenguaje externo; el CRT MSVC se enlaza estático. DLL estándar de Windows siguen siendo dependencias del sistema.
- El manifest limita windows a target Windows y activa solo las features Win32 necesarias. serde con derive y serde_json son las únicas dependencias directas de datos/render.
- Cargo.lock se versiona; target/ y dist/ se ignoran. No se versionan el exe ni jobs o credenciales reales.
- El dominio, el lector, el render de píxeles, hit-testing, tiempo y reglas de posición se prueban sin crear HWND ni llamar Win32.
- Toda unidad de comportamiento sigue TDD: test primero, correrlo y observar un fallo de aserción por el comportamiento ausente, implementar el mínimo, refactorizar y volver a correr la suite. Un error de compilación o de entorno no cuenta como rojo.
- Evitar helpers duplicados. El reloj, snapshots, bounds, filesystem y APIs de plataforma se inyectan donde corresponda.
- No modificar el servidor Node hasta la sección final Integración MCP, que es posterior e independiente.

## Estructura común

Crear una library con módulos puros y un binario delgado:

- widget/src/lib.rs: exporta jobs, scene, position, art, framebuffer, render, app, poller y la fachada platform.
- widget/src/main.rs: entrada Windows y ciclo de vida.
- widget/src/jobs/: tipos JSON y lector de snapshots.
- widget/src/scene/: estados, estilo worker, layout, trayectorias, formato de tiempo, tooltip y hit-testing.
- widget/src/position.rs: archivo de posición y clamp.
- widget/src/art.rs y widget/src/framebuffer.rs: paleta, matrices de sprites y operaciones de píxel.
- widget/src/render.rs: composición determinista de escena y tooltip en el framebuffer.
- widget/src/platform/mod.rs: contratos testeables Platform, PlatformEvent y WindowBackend.
- widget/src/platform/windows.rs: implementación Windows de HWND, DIB/GDI, UpdateLayeredWindow, mensajes, orden Z, monitores y mouse.
- widget/src/app.rs y widget/src/poller.rs: coordinación de ventana, canal de snapshots y polling fuera del hilo de presentación.
- widget/tests/: pruebas de integración puras agrupadas por jobs, scene, position, art/render, app y poller.

## Contratos comunes

### Jobs

Definir JobState como enum de queued, running, done, failed, cancelled y orphaned, serializable con los valores minúsculos exactos de Node. Metadatos desconocidos o inválidos se omiten sin abortar el resto del snapshot.

Definir Job con id: String, state: JobState, kind/task/worker/provider/branch: Option<String>, created_at/started_at/ended_at: Option<i64> en milisegundos Unix y cost_usd: Option<f64>. Aplicar serde rename_all camelCase para los campos Node. Campos opcionales ausentes no rompen deserialización; campos JSON desconocidos se ignoran.

- resolve_home(env_home: Option<&OsStr>, user_profile: Option<&OsStr>) -> Result<PathBuf, HomeError>: prioriza COLMENA_HOME no vacío; si no, añade .colmena a USERPROFILE; error claro si faltan ambos.
- read_snapshot(home: &Path) -> io::Result<Vec<Job>>: examina solo directorios inmediatos de home/jobs, omite enlaces simbólicos, lee meta.json, omite archivo ilegible/JSON inválido/estado desconocido, ordena por id y no escribe.
- Directorio jobs inexistente significa snapshot vacío. Error enumerando un directorio existente se propaga para que la app conserve la última lectura válida.

### Escena e interacción

Definir Point { x: f32, y: f32 }, Rect { x: f32, y: f32, width: f32, height: f32 }, Motion { Idle, Queued, Flying, Returning, Falling }, Bee con job opcional, posición/ruta, fase, radio y edad de salida, y Scene con abejas, efectos y menú. Una abeja ambiental no lleva Job.

- style_for_worker(alias: &str) -> WorkerStyle.
- format_elapsed_ms(milliseconds: i64) -> String: limita valores negativos a cero y conserva minutos sobre 59.
- tooltip_for(job: &Job, now_ms: i64) -> Tooltip: tiempo queued desde created_at, running desde started_at, terminal desde ended_at; tarea hasta 60 caracteres Unicode; costo a cuatro decimales o pendiente.
- reconcile(previous: &Scene, jobs: &[Job], now_ms: i64, bounds: Rect) -> Scene.
- position_at(bee: &Bee, now_ms: i64) -> Point.
- hit_test_bee(scene: &Scene, point: Point, now_ms: i64) -> Option<&Job>; resolver solapes de forma determinista e ignorar Idle.
- hit_test_menu(menu: &Menu, point: Point) -> MenuAction.
- drag_position(origin: Point, pointer_start: Point, pointer_now: Point) -> Point.
- place_tooltip(anchor: Point, size: Rect, bounds: Rect) -> Point para mantenerlo en la escena.

### Posición y render

- Position { x: i32, y: i32 } son coordenadas de pantalla.
- Size { width: u32, height: u32 } es el tamaño en píxeles de la escena/ventana.
- WorkArea { x: i32, y: i32, width: i32, height: i32 } admite origen negativo.
- load_position(path: &Path, fallback: Position) -> Result<Position, PositionWarning>; archivo ausente retorna fallback, JSON corrupto retorna fallback con aviso.
- save_position(path: &Path, position: Position) -> io::Result<()>; crea padre, serializa a temporal hermano y reemplaza por rename.
- clamp_position(position: Position, widget_size: Size, work_area: WorkArea) -> Position mantiene visible la ventana, también si excede el monitor.
- FrameBuffer { width: u32, height: u32, pixels: Vec<u32> } guarda BGRA premultiplicado. clear, draw_pixel, fill_rect, draw_sprite y draw_bitmap_text no llaman a Win32.
- Los sprites tienen filas rectangulares y símbolos cubiertos por una paleta en código. La fuente bitmap incluye letras españolas y glifo de reemplazo.

### Plataforma y proceso

Todas las llamadas windows::Win32 quedan dentro de platform/windows.rs. La capa ofrece una interfaz WindowBackend injectable para probar flags, posición inferior, alpha y errores con un backend falso. El backend real crea WS_POPUP y WS_EX_LAYERED | WS_EX_TOOLWINDOW; no aplica WS_EX_APPWINDOW, WS_EX_TOPMOST ni WS_EX_TRANSPARENT. Presenta el DIB con UpdateLayeredWindow + ULW_ALPHA, SourceConstantAlpha 255 y BGRA premultiplicado.

La fachada Platform que usa app.rs define current_position(&self) -> Result<Position, PlatformError>, work_areas(&self) -> Result<Vec<WorkArea>, PlatformError>, move_to(&mut self, position: Position) -> Result<(), PlatformError>, present(&mut self, frame: &FrameBuffer) -> Result<(), PlatformError> y close(&mut self) -> Result<(), PlatformError>. PlatformEvent representa Tick, MouseMove, LeftDown, LeftUp, RightUp y Close con coordenadas de escena cuando aplican. El fake de app entrega estos eventos sin abrir HWND.

La ventana usa HWND_BOTTOM y SWP_NOACTIVATE después de crearla, moverla o presentar frames. Tiene ciclo de mensajes propio y WM_TIMER/WM_MOUSEMOVE/WM_LBUTTONDOWN/WM_LBUTTONUP/WM_RBUTTONUP/WM_CLOSE. Áreas con alpha cero dejan pasar clics; zonas opacas reciben hover/click. El menú de Salir se dibuja en píxeles y es operable con clic izquierdo.

Aplicar awareness per-monitor antes de crear HWND. Enumerar work areas en coordenadas coherentes con APIs de monitor y persistencia. El arrastre captura posición de pantalla inicial y origen del widget; mueve sin activar y persiste al soltar.

Para impedir dos widgets del mismo home, el binario adquiere mutex Win32 cuyo nombre usa hash estable FNV-1a del path absoluto normalizado. Tras adquirirlo, publica <COLMENA_HOME>/widget-process.json con PID y path absoluto del ejecutable mediante temporal más rename. Al cerrar, elimina el registro solo si aún corresponde a su PID y libera el mutex.

## Review Focus

1. Un meta.json temporal, inválido o con estado desconocido debe omitirse sin tumbar los demás jobs: prueba jobs reader.
2. Tarea multibyte de 60 caracteres, startedAt/endedAt ausentes, timestamps futuros/negativos y costUsd cero deben mostrar valores válidos: pruebas scene/tooltip.
3. Posición de monitor con origen negativo, posición fuera de todos los monitores y widget más grande que el área deben clamplearse de forma determinista: pruebas position.
4. Alpha cero debe mostrar el escritorio y pasar clics; zona opaca debe recibirlos; una ventana normal debe cubrir el widget: pruebas del backend falso y verificación manual del spike.
5. Dos instancias con el mismo home, registro PID obsoleto y PID válido con ruta ejecutable distinta nunca deben duplicar ni terminar un proceso ajeno: pruebas de mutex y de Integración MCP.

---

## Tarea 1 — Crate, modelos y lector de jobs

**Brief delegable:** crea el crate Rust, los modelos serde y un lector puro del formato real. No abras una ventana, no llames Win32 y no cambies código Node.

**Archivos:** widget/Cargo.toml, widget/Cargo.lock, widget/src/lib.rs, widget/src/jobs/mod.rs, widget/src/jobs/model.rs, widget/src/jobs/reader.rs, widget/tests/jobs_reader.rs.

**Manifest:** package colmena-widget, edition 2024, rust-version 1.99, lib colmena_widget, bin colmena-widget. Dependencias directas serde con derive y serde_json. Declara windows como dependencia target Windows con features Win32_Foundation, Win32_Graphics_Gdi, Win32_System_LibraryLoader, Win32_System_Threading, Win32_UI_HiDpi y Win32_UI_WindowsAndMessaging; afina features al compilar. Guarda el lockfile. No agregues dependencias de test.

**TDD, en este orden:**

1. Escribe tests para home por variable y fallback, jobs ausente, seis estados conocidos, opciones ausentes, costo ausente frente a cero, campos desconocidos, orden estable, JSON inválido junto a válido y fixture sin escrituras.
2. Ejecuta cargo test jobs_reader y observa fallos de aserción por la API faltante. Si no compila, corrige el test hasta obtener un rojo semántico.
3. Declara los tipos y firmas anteriores; implementa resolve_home y read_snapshot con std::fs y serde_json, omitiendo enlaces y entradas inválidas sin repetir validación.
4. Refactoriza nombres/errores comunes y vuelve a correr cargo test.
5. Ejecuta cargo test; registra salida completa y commit pequeño de la tarea.

**Aceptación:** las fixtures coinciden en nombres, casing y milisegundos con src/store.js y src/jobs.js; ningún test altera su archivo fuente.

---

## Tarea 2 — Dominio de escena y tooltip

**Brief delegable:** implementa la lógica de abejas con datos Jobs. Todas las funciones reciben reloj, snapshots y bounds; no usan reloj global, aleatoriedad, filesystem, framebuffer ni Win32.

**Archivos:** widget/src/scene/mod.rs, types.rs, worker.rs, time.rs, layout.rs, trajectory.rs, hit_test.rs, tooltip.rs, widget/tests/scene.rs.

**TDD, en este orden:**

1. Escribe tests tabulares de estilo: luna dorada; ds/deepseek azul; hive verde y pequeño; alias desconocido neutral; mayúsculas no cambian el estilo.
2. Escribe pruebas de tiempo y tooltip: cero, 9 segundos, cruce de minuto, 73:09, negativo a cero, queued desde created_at, running recalculado con now, terminal con ended_at, costo ausente pendiente y costo cero mostrado como 0.0000.
3. Prueba tarea de 60 caracteres Unicode, sin cortar caracteres y con una letra acentuada.
4. Escribe pruebas de reconcile: queued junto a entrada; queued→running mantiene id; running→done retorno/brillo; failed y orphaned caída roja; cancelled retorno neutro; terminal inicial no anima; job ausente se conserva dos polls y se quita al tercero; sin activos ni salida hay abejas Idle; todos los activos se mantienen representados.
5. Corre cargo test scene y verifica rojo semántico. Implementa tipos y funciones mínimas, refactoriza helpers comunes de easing/límites y repite la suite.
6. Ejecuta cargo test y crea commit de esta unidad.

**Aceptación:** las mismas entradas generan iguales rutas, fases, layouts y desempates; los tests no pueden crear HWND ni leer metadatos reales.

---

## Tarea 3 — Persistencia y límites de posición

**Brief delegable:** guarda/restaura la ubicación del widget sin importar módulos de plataforma. La ruta de datos es <COLMENA_HOME>/widget-position.json.

**Archivos:** widget/src/position.rs, widget/tests/position.rs.

**TDD, en este orden:**

1. Escribe pruebas para archivo ausente/fallback, posición correcta, JSON corrupto/fallback con aviso, guardar y volver a leer, reemplazar una posición previa sin residuo temporal y error de escritura.
2. Prueba clamp en centro y cuatro bordes, área con origen negativo, posición lejos del monitor y ventana más grande que el área.
3. Corre cargo test position y confirma fallos de valores/assertions. Implementa con std::fs, serde_json y rename en temporal hermano.
4. Refactoriza construcción de temporal y cálculo de límites sin duplicación; repite las pruebas y luego cargo test.
5. Crea un commit pequeño.

**Aceptación:** la lógica de clamp no llama a APIs Windows y se ejecuta con áreas de trabajo inyectadas.

---

## Tarea 4 — Sprites y compositor de software

**Brief delegable:** crea el arte pixel y compone el frame en un buffer CPU. Nada se carga desde disco y las pruebas no inicializan GDI.

**Archivos:** widget/src/art.rs, widget/src/framebuffer.rs, widget/src/render.rs, widget/tests/art_render.rs.

**TDD, en este orden:**

1. Prueba sprites no vacíos y rectangulares; cada símbolo tiene color; estilos worker usan las paletas definidas; frames de ala son distintos; las variantes Idle, queued, failed y done seleccionan el arte correcto.
2. Prueba framebuffer con dimensiones conocidas, clipping, escalado entero, pixel transparente, combinación alpha y conversión BGRA premultiplicada.
3. Prueba texto ASCII, costo, acentos y glifo de reemplazo; ancho de tooltip y composición de escena dentro de bounds.
4. Corre cargo test art_render y verifica rojos semánticos. Implementa matrices/paleta/fuente en código y funciones puras sobre &mut FrameBuffer.
5. Refactoriza el dibujo repetido de píxel/sprite/texto y vuelve a correr cargo test.
6. Crea commit pequeño de arte y compositor.

**Aceptación:** no hay dependencia de imagen o fuente; dos frames con la misma Scene y tiempo tienen píxeles idénticos.

---

## Tarea 5 — Ventana Win32 y spike visual temprano

**Brief delegable:** crea la única frontera insegura del programa. Antes de integrar polling, demuestra con un spike que la ventana layered funciona en un escritorio Windows real.

**Archivos:** widget/src/platform/mod.rs, widget/src/platform/windows.rs, widget/examples/layered_window_spike.rs, widget/tests/platform_contract.rs.

**TDD, en este orden:**

1. Define WindowBackend y un fake que registre operaciones. Escribe primero tests que exijan WS_POPUP, WS_EX_LAYERED y WS_EX_TOOLWINDOW; ausencia de WS_EX_APPWINDOW/WS_EX_TOPMOST/WS_EX_TRANSPARENT; HWND_BOTTOM con SWP_NOACTIVATE; alpha por píxel y propagación de errores.
2. Corre cargo test platform_contract y observa fallos semánticos. Añade una abstracción mínima para creación/presentación/posicionamiento que permita pruebas sin llamar a Windows.
3. Implementa WindowBackend real exclusivamente con crate windows. Aísla unsafe, cierre de HDC/bitmap, registro de clase y errores Win32. Usa DIB de 32 bits y UpdateLayeredWindow con ULW_ALPHA.
4. El ejemplo construye una escena sintética y permite verificar transparencia, entrada, drag básico y orden Z. Ejecuta cargo test y cargo run --example layered_window_spike.
5. Captura temporalmente la ventana en Windows y confirma que una ventana normal la cubre, que no aparece en taskbar y que se reciben mouse y clic derecho en zonas opacas. Si falla, corrige flags/mensajes antes de seguir; no introduzcas WorkerW sin documentar una API pública verificada.
6. Refactoriza recursos y secuencia de configuración; vuelve a ejecutar cargo test. Crea commit pequeño con el spike reproducible.

**Aceptación:** ninguna prueba unitaria ejecuta una API Win32 real. Toda llamada insegura queda en platform/windows.rs.

---

## Tarea 6 — Poller y aplicación integrada

**Brief delegable:** integra snapshot, dominio, renderer y ventana. El acceso a disco corre fuera del hilo que procesa mensajes y presenta frames.

**Archivos:** widget/src/app.rs, widget/src/poller.rs, widget/src/main.rs, widget/tests/app.rs, widget/tests/poller.rs; toca módulos anteriores solo si agregas el contrato usado por todos sus consumidores.

**Interfaces:**

- Poller inicia con lectura inmediata y luego cada segundo en std::thread.
- SnapshotReader: Fn(&Path) -> io::Result<Vec<Job>> + Send + 'static.
- El poller envía snapshots completos por std::sync::mpsc; error de lectura informa aviso y conserva snapshot previo.
- WidgetApp recibe home, Platform, reader y clock inyectables para tests.
- Platform separa current_position, move_to, work_areas, present y close de las llamadas Win32.
- El hilo de ventana consume mensajes/canal, llama reconcile/render con reloj inyectado y actualiza DIB. No hace I/O de jobs en Update/render.

**TDD, en este orden:**

1. Escribe pruebas con Platform/reader/clock falsos: error inicial usa fallback; reader lento no bloquea el hilo de ventana; error posterior mantiene snapshot válido; tooltip avanza mm:ss; drag mantiene offset, mueve y guarda al soltar; menú abre/cierra; Salir cierra; cerrar app detiene poller.
2. Escribe pruebas de polling para lectura inmediata, lectura cada segundo, envío de error y terminación al cancelar.
3. Corre cargo test --test app y cargo test --test poller; confirma rojos semánticos. Implementa coordinación mínima sin dependencias asíncronas.
4. Conecta mensajes de mouse: hover, arrastre, right-click, click en Salir; al mover/presentar conserva HWND_BOTTOM sin robar activación.
5. Conecta mutex y widget-process.json según Contratos comunes. Prueba que dos instancias con el mismo home no abren dos ventanas y que el registro de proceso ajeno no se borra.
6. Refactoriza el ciclo de vida y canales; corre cargo test y cargo build --target x86_64-pc-windows-msvc. Commit pequeño.

**Aceptación:** lectura lenta no congela animación; app conserva último snapshot; shutdown termina el hilo y libera mutex; toda lógica sobre snapshots tiene prueba sin HWND.

---

## Tarea 7 — Release, verificación visual y README

**Brief delegable:** deja un binario release reproducible, evidencia visual real de Windows y pasos para otro agente.

**Archivos:** widget/README.md, widget/.gitignore, widget/.cargo/config.toml, widget/docs/verification/desktop-widget.png. Modifica Cargo.toml para perfil release si aún no está definido. Ignora widget/target/ y widget/dist/.

**TDD/verificación, en este orden:**

1. Escribe cualquier prueba pendiente de configuración/perfil antes de tocarla; para documentación, define primero la lista de aceptación de abajo.
2. Configura release con LTO, codegen-units=1, strip=true, panic=abort. Solo para x86_64-pc-windows-msvc establece -C target-feature=+crt-static; no fuerces esa opción para otras plataformas.
3. Ejecuta cargo test y cargo clippy --all-targets -- -D warnings. En Windows x64 compila cargo build --release --target x86_64-pc-windows-msvc.
4. Copia el resultado a widget/dist/colmena-widget.exe para consumo MCP. Comprueba existencia, tamaño, imports de runtime y que target/dist no se versionen. Si dumpbin o llvm-readobj están instalados globalmente, inspecciona dependencias; no instales herramientas en el proyecto.
5. Prepara un COLMENA_HOME temporal con jobs JSON sintéticos, solo para esta sesión. Arranca el exe con COLMENA_HOME apuntando a ese home; crea estados queued/running y cambia jobs a done/failed durante la sesión para observar sus transiciones. No uses jobs reales ni credenciales.
6. Captura la ventana visible con Recortes de Windows (Win+Shift+S), selecciona widget y menú en capturas separadas solo si una imagen no puede mostrar ambos; conserva la captura principal en widget/docs/verification/desktop-widget.png. Inspecciónala al 100% en un visor o con herramienta de imagen.
7. Comprueba en pantalla el pastizal, flores, hongo, colmena, abejas de paletas distintas, tooltip legible, tarea truncada, mm:ss/costo, menú pixel art y transparencia sin rectángulo opaco. Además prueba hover, clic derecho/Salir, drag + reinicio, ausencia de botón taskbar y que una aplicación normal cubre el widget. La captura no sustituye esas pruebas de interacción.
8. Repite cargo test y el build release después de los últimos cambios; redacta README con requisitos, test/build/run, home, interacciones, módulos, evidencia, imports/limitaciones y solución de problemas.
9. Inspecciona diff y captura, confirma que no incluyes home temporal ni exe; commit atómico en la rama asignada.

**Aceptación:** cargo test y build release terminan en código 0; el exe se llama colmena-widget.exe y no necesita runtime externo; captura inspeccionada existe en el path previsto; resultado visual/orden Z se reporta con lo realmente comprobado.

---

## Integración MCP

**Fase posterior e independiente. No ejecutar dentro de la primera entrega del widget.** Esta tarea añade al servidor Node la tool MCP widget con action start, stop o status y administra widget/dist/colmena-widget.exe. No cambia el esquema JSON de jobs.

**Ownership y archivos:** crear src/widget.js y test/widget.test.js; modificar src/config.js, src/tools.js, test/server.test.js y README.md raíz solo si hace falta actualizar el catálogo de tools. El binario Rust permanece en widget/.

**API Node:** createWidgetController({home, executable, spawn, processControl, logger}) retorna start(), stop() y status(). El schema MCP admite solamente action: start | stop | status; no acepta rutas ni argumentos arbitrarios. start resuelve el ejecutable conocido del repo, hereda entorno con COLMENA_HOME, inicia detached/oculto y desacopla stdio. Devuelve state y PID verificado. Una llamada duplicada retorna PID existente.

**Proceso y exclusión mutua:** serializar acciones concurrentes del controlador. El widget Rust ya adquiere mutex nombrado por home y publica widget-process.json con PID y ejecutable después de adquirirlo; Node espera ese registro con timeout y verifica PID/ruta antes de reportar running. status compara registro, vida del proceso, ruta del ejecutable y mutex/ventana cuando sea posible. stop pide cierre solo al PID cuyo ejecutable verificado coincide, espera confirmación de salida y elimina registro solo si todavía pertenece a ese PID. No terminar procesos por PID sin verificar ruta. Un registro obsoleto no bloquea una nueva instancia.

**TDD:** probar schema de las tres acciones; start lanza exactamente una copia; dos starts concurrentes devuelven el mismo PID; espera de handshake timeout da error útil; status tras reconstruir controlador; PID muerto o reutilizado; ruta ajena nunca se termina; stop confirma salida antes de limpiar registro; exe ausente produce error explícito. Usar fakes inyectables y no lanzar la ventana en tests. Ejecutar npm test y validar el catálogo con harness MCP.

**Aceptación/cierre separado:** cargo test y build release siguen pasando; suite Node pasa; start/status/stop manual por MCP muestran la ventana correcta y PID verificado; la documentación raíz enumera la herramienta. No fusionar esta fase con la primera implementación del widget.
