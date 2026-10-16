# Colmena Widget para Windows — diseño

Fecha de elaboración: 2026-10-15
Estado: propuesta implementable; pendiente de ejecución
Plan de implementación: docs/superpowers/plans/2026-10-16-colmena-widget.md

## 1. Propósito y alcance

Colmena Widget es una ventana compacta de escritorio para Windows que convierte los jobs de colmena-mcp en una escena pixel art: una colmena sobre un pastizal y una abeja por job activo. Permite ver qué agentes esperan, trabajan o terminan sin abrir el servidor MCP ni las carpetas de jobs.

Cada abeja representa un subagente. Los estados visibles principales son queued, running, done, failed e idle. idle corresponde a abejas dormidas de ambiente cuando no hay jobs activos. También se conservan los estados reales cancelled y orphaned: cancelled vuelve a la colmena en tono neutro y orphaned se presenta como fallo.

El widget es un consumidor local de metadatos. Lee <COLMENA_HOME>/jobs/<id>/meta.json, no lanza agentes y no modifica ni elimina archivos de jobs. Usa la variable COLMENA_HOME cuando existe; si no, usa %USERPROFILE%\.colmena, igual que el servidor.

## 2. Contrato real de los jobs

La inspección de src/store.js confirma que hay una carpeta por id y que meta.json se escribe como archivo temporal con sufijo del PID y luego se publica con rename. El lector examina carpetas hijas inmediatas, omite metadatos que no puede leer o parsear y no depende de los campos desconocidos. Una lectura parcial o transitoria no bloquea el hilo gráfico.

src/jobs.js crea jobs queued con createdAt, kind, task, worker y provider; al comenzar asigna startedAt; al finalizar asigna endedAt, estado y normalmente costUsd. La recuperación del servidor puede convertir jobs activos en orphaned. Los timestamps son milisegundos Unix.

| Estado persistido | Presentación |
|---|---|
| queued | Abeja esperando cerca de la entrada; su tiempo se calcula desde createdAt. |
| running | Abeja volando entre flores, con alas animadas; su tiempo se calcula desde startedAt. |
| done | Al observar la transición desde queued o running, la abeja vuelve, brilla y desaparece. |
| failed / orphaned | Al observar la transición desde un estado activo, cae y parpadea brevemente en rojo antes de desaparecer. |
| cancelled | Vuelve a la colmena sin brillo y se retira en tono neutro. |
| idle | Abejas dormidas junto a la colmena, con Zz; no representan jobs y no muestran tooltip. |

Los metadatos incluyen id, state, kind, task, worker, provider, branch, createdAt, startedAt, endedAt y costUsd, entre otros. El lector acepta campos desconocidos y trata como ausentes los opcionales. Un estado desconocido no crea una abeja activa. Los jobs terminales presentes al iniciar no reproducen animaciones históricas. Solo se anima una transición que el widget haya observado entre snapshots.

Si el directorio jobs no existe, el snapshot es una lista vacía. Un error de lectura o enumeración se informa de forma no fatal y la aplicación conserva el último snapshot válido. Un meta.json inválido o que cambie durante la lectura se omite en ese snapshot; el siguiente polling vuelve a intentarlo.

## 3. Escena, arte y movimiento

La escena base contiene pasto, flores, una colmena y un hongo. Todo el arte se dibuja desde matrices de píxeles y una paleta declaradas en código. No se descargan ni se incluyen PNG, GIF, spritesheets, fuentes o recursos externos. El tooltip usa una fuente bitmap definida en código, con letras españolas acentuadas, símbolos de costo y un glifo de reemplazo.

El estilo de abeja depende de forma determinista del alias del worker y no cambia entre lecturas:

| Worker | Apariencia |
|---|---|
| Alias que contiene luna, por ejemplo luna-max | Dorada, tamaño base. |
| Alias que contiene ds o deepseek, por ejemplo ds-flash | Azulada, tamaño base. |
| Alias que contiene hive, por ejemplo max-hive | Verde y pequeña. |
| Cualquier otro alias | Paleta neutra y tamaño intermedio. |

La comparación ignora mayúsculas. Las abejas queued se ubican separadas cerca de la entrada. Las running recorren rutas deterministas por las flores y alternan las alas. done, failed/orphaned y cancelled usan las animaciones de salida descritas arriba. Si todos los jobs están ausentes o terminados, se muestran abejas idle. Cada job activo conserva una abeja identificable por id; el layout reduce separación o tamaño dentro de límites legibles antes de omitir una abeja.

Las posiciones, rutas, fases de aleteo y desempates de hit-testing son deterministas para iguales snapshots, límites, id y tiempo recibidos como parámetros. Las funciones de dominio no leen la hora ni usan aleatoriedad global.

## 4. Tooltip e interacción

Al pasar el puntero sobre una abeja de job, el tooltip presenta worker, kind, task, duración viva mm:ss y costo. La tarea se limita a 60 caracteres Unicode sin cortar UTF-8. Para queued se muestra el tiempo en cola desde createdAt; para running se muestra el tiempo desde startedAt y se recalcula en cada frame. Un tiempo negativo se representa como cero; los minutos acumulados no vuelven a cero después de una hora. El costo usa cuatro decimales y punto decimal; si costUsd todavía no existe, se indica pendiente. El tooltip de una abeja terminal en salida usa el último metadato válido y su duración final.

La ventana es de tamaño fijo, sin bordes ni botón de barra de tareas. Se puede arrastrar con el botón izquierdo, recuerda su posición y se mantiene al fondo de las ventanas normales: nunca usa topmost. Clic derecho sobre una zona opaca del widget abre un menú pixel art dentro de la ventana; clic izquierdo en Salir cierra el proceso y clic fuera cierra el menú. Los píxeles totalmente transparentes permiten ver e interactuar con el escritorio que hay detrás.

La posición guardada vive en <COLMENA_HOME>/widget-position.json. Al iniciar se clampa al área de trabajo de un monitor; si falta el archivo se usa una posición inicial abajo a la derecha. Un archivo corrupto produce un aviso no fatal y conserva el fallback. Guardar usa un temporal hermano y rename para no dejar posiciones parciales. No se instala autoarranque.

## 5. Decisión técnica

### Ventana y composición

Se usa una ventana Win32 nativa mediante el crate windows de windows-rs, con funciones y tipos limitados a la capa de plataforma. La ventana superior se crea sin decoración con WS_POPUP y WS_EX_LAYERED | WS_EX_TOOLWINDOW. No se aplica WS_EX_APPWINDOW ni WS_EX_TOPMOST. Se configura orden inferior mediante SetWindowPos con HWND_BOTTOM y sin activar la ventana.

La transparencia por píxel se presenta con UpdateLayeredWindow y ULW_ALPHA. El búfer fuente es 32 bits BGRA con alfa premultiplicado, respaldado por un DIB de GDI. El render de la escena se hace en CPU sobre un búfer de píxeles propio; no usa GPU, Direct2D, WebView, motor de juego, winit ni softbuffer. La alpha cero deja pasar el mouse; no se usa WS_EX_TRANSPARENT para toda la ventana porque impediría interactuar con el widget. Un adaptador encapsula el puntero DIB, el HDC y todas las llamadas Win32 inseguras.

Esta ruta es la más corta para las condiciones del producto: UpdateLayeredWindow proporciona la transparencia por píxel, mientras que las mismas APIs Win32 controlan los estilos, el área de trabajo y HWND_BOTTOM. winit y softbuffer agregarían capas para ventana y framebuffer, pero no eliminan la integración Win32 que aquí se necesita para alpha por píxel y orden Z. La documentación de Microsoft también recomienda UpdateLayeredWindow cuando la aplicación proporciona directamente contenido con alpha por píxel. El costo de esta decisión es mantener una capa pequeña de llamadas nativas; queda aislada y se prueba su configuración con adaptadores falsos.

### Rust, dependencias y binario

El proyecto vive en widget/ como un crate independiente llamado colmena-widget, con library para lógica y un binario Windows del mismo nombre. Requiere Rust 1.99 disponible globalmente y edición 2024. Cargo.toml declara serde con derive, serde_json y windows solo para el target Windows con features Win32 acotadas. Cargo.lock fija el grafo de dependencias. No se agrega runtime asíncrono, biblioteca gráfica, framework de ventana ni dependencia de imágenes.

El build release habilita LTO, un codegen unit, strip y panic abort. Para x86_64-pc-windows-msvc habilita CRT estático. El resultado es widget/target/x86_64-pc-windows-msvc/release/colmena-widget.exe, sin empaquetador ni archivos de runtime propios. La tabla de imports se revisa para confirmar que no se requiere un runtime externo de Rust o C; las DLL del sistema Windows siguen siendo dependencias normales del sistema operativo. Se mide y reporta el tamaño producido, sin prometer una cifra antes del build.

Rust es la elección del dueño y sirve una entrega nativa de un solo ejecutable. Sus tipos y ownership mantienen el acceso inseguro de Win32 en una frontera visible y su suite estándar de pruebas corre con cargo test. C++ puede llamar las mismas APIs, pero en este proyecto exigiría otro flujo de build y más disciplina manual alrededor de punteros; no se elige un framework C++ para un render de sprites pequeño.

### Separación testeable

La library contiene módulos para datos y lector de jobs, dominio de escena, trayectorias/layout, tooltip y tiempo, persistencia y clamp de posición, sprites/matrices y render de software. Pueden compilarse y probarse con cargo test sin crear una ventana ni ejecutar una llamada Win32.

El binario y src/platform/windows.rs contienen el ciclo de mensajes, creación de HWND, DIB/GDI, transparencia, orden Z, monitor/DPI y entrada de mouse. src/app.rs coordina polling, dominio, render y eventos. El lector corre fuera del hilo de presentación y manda snapshots completos; un error conserva la última escena válida. Las pruebas de dominio usan reloj, geometría y fixtures inyectados. La capa Win32 prueba flags y secuencias con un backend falso; la visibilidad, alpha y orden Z requieren una verificación manual real en Windows.

## 6. Fuera de alcance

- Crear, cancelar o editar jobs desde el widget.
- Mostrar historial, resultados, ramas, errores completos o logs.
- Conectarse al servidor MCP por red, abrir puertos o instalar un servicio.
- Login, nube, imágenes externas, sonido, autoarranque, instalador o configuración visual extensa.
- Cambiar el esquema de jobs en Node o escribir metadatos dentro de sus carpetas.

La integración MCP se implementa después y por separado: la herramienta Node widget acepta action start, stop o status y administra este ejecutable.

## 7. Criterios de aceptación

1. En Windows aparece una ventana sin bordes, con transparencia por píxel, sin botón de taskbar y cubierta por aplicaciones normales; nunca queda topmost.
2. Lee COLMENA_HOME o el fallback %USERPROFILE%\.colmena; los archivos transitorios o inválidos no congelan la presentación ni borran el último snapshot válido.
3. queued y running muestran una abeja por job activo; done, failed/orphaned y cancelled completan su animación; sin jobs activos aparecen abejas idle.
4. Colores y tamaños son estables por alias; hover muestra los datos actuales, tarea limitada a 60 caracteres, duración viva mm:ss y costo o pendiente.
5. Drag, menú contextual Salir y persistencia de posición sobreviven al cierre y nuevo inicio.
6. cargo test pasa para la lógica; el build release produce colmena-widget.exe sin runtime externo y se registra su tamaño/imports.
7. Se conserva y examina una captura de Windows en widget/docs/verification/desktop-widget.png. La prueba manual también confirma drag, hover, menú, taskbar y orden Z; la captura por sí sola no demuestra esas interacciones.
8. widget/README.md permite a otra persona compilar, probar, ejecutar y repetir la inspección visual con fixtures sintéticos.

## 8. Riesgos

- HWND_BOTTOM puede quedar detrás de capas del escritorio de Explorer o no recibir interacciones según la activación de ventana. Una prueba temprana confirma visibilidad, hover, clic derecho y que una aplicación normal la cubre. Si falla, documentar y probar una alternativa de desktop layer antes de depender de APIs internas no verificadas.
- La alpha cero deja pasar el mouse. Las pruebas manuales deben usar zonas visibles y confirmar que no se pierde la interacción al actualizar el DIB.
- El render de UpdateLayeredWindow exige formato BGRA y alpha premultiplicado correctos; un error suele mostrarse como halo oscuro o color incorrecto.
- Escala DPI y monitores con coordenadas negativas deben usar un solo sistema de coordenadas para escena, Win32, clamp y archivo persistido.
- Un job puede terminar entre dos polls; solo se animan transiciones observadas y no se reconstruye historial.
- El exe conserva imports a DLL normales de Windows; “sin runtime” significa sin runtime de lenguaje adicional que haya que distribuir, no independencia del sistema operativo.

## 9. Referencias técnicas

- Microsoft, ventanas en capas y alpha por píxel: https://learn.microsoft.com/en-us/windows/win32/winmsg/window-features
- Microsoft, UpdateLayeredWindow: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-updatelayeredwindow
- Microsoft, Rust for Windows y windows-rs: https://learn.microsoft.com/en-us/windows/dev-environment/rust/rust-for-windows
- windows-rs, crate windows para aplicaciones binarias: https://github.com/microsoft/windows-rs/tree/master/crates/libs/windows
- Rust Reference, enlace estático y crt-static: https://doc.rust-lang.org/reference/linkage.html
