# Colmena Widget para Windows

Colmena Widget muestra un pastizal pixel art con una abeja por job activo. Lee los archivos `jobs/<id>/meta.json` de Colmena; no inicia jobs ni modifica sus metadatos. La ventana mide 520 × 240 px (260 × 120 píxeles lógicos a 2×), muestra hasta 12 abejas y señala el excedente con `+N`.

## Requisitos

- Windows x64 y Rust 1.99 o posterior con el target `x86_64-pc-windows-msvc`.
- ImageMagick (`magick`) solo para regenerar la preview PNG. No es una dependencia del ejecutable.
- El ejecutable usa las DLL que forman parte de Windows. El perfil enlaza estáticamente el CRT de MSVC para este target.

## Compilar y verificar

Desde esta carpeta (`widget/`):

```powershell
cargo test
cargo clippy --all-targets -- -D warnings
cargo build --release --target x86_64-pc-windows-msvc
New-Item -ItemType Directory -Force dist | Out-Null
Copy-Item target/x86_64-pc-windows-msvc/release/colmena-widget.exe dist/colmena-widget.exe
```

La configuración de Cargo aplica `+crt-static` solo al target Windows x64 MSVC. El perfil release activa LTO, una unidad de código, `strip` y `panic = "abort"`. `target/` y `dist/` están excluidos de Git; el binario no se distribuye en este repositorio.

Para regenerar la vista previa determinista (izquierda: escena; derecha: hover con tooltip):

```powershell
$previewPpm = Join-Path $env:TEMP 'colmena-widget-scene-preview.ppm'
cargo run --example preview -- $previewPpm
magick $previewPpm docs/verification/scene-preview.png
Remove-Item -LiteralPath $previewPpm
```

## Ejecutar

```powershell
$env:COLMENA_HOME = 'C:\ruta\a\un\home\de\colmena'
.\dist\colmena-widget.exe
```

Si `COLMENA_HOME` no está definida o está vacía, el programa usa `%USERPROFILE%\.colmena`. La carpeta debe contener `jobs/`; cada job se lee desde `jobs/<id>/meta.json`. Las lecturas inválidas se omiten y un error de lectura conserva la última escena válida. El mutex permite una instancia por cada `COLMENA_HOME`; `widget-process.json` registra el PID y la ruta del ejecutable.

Para comprobarlo manualmente, crea un home temporal y copia únicamente jobs sintéticos con estados `queued` y `running`. Mientras el widget está abierto, cambia uno a `done` y otro a `failed`; los cambios observados se animan en los polls siguientes. No apuntes la prueba a datos reales si quieres evitar mostrar nombres de tareas locales.

## Interacción

- Hover sobre una abeja activa: worker, tipo, tarea, duración `mm:ss` y costo (o `pendiente`).
- Arrastrar con botón izquierdo: mueve el widget; la posición se guarda al soltar en `widget-position.json` dentro de `COLMENA_HOME`.
- Clic derecho: abre el menú pixel art; clic en **Salir** cierra el widget.
- La ventana es layered, no activa, no topmost y usa estilo tool-window para no crear un botón propio en la barra de tareas. Las aplicaciones normales visibles se dibujan por encima.

Windows coloca la ventana en el fondo con `HWND_BOTTOM` cuando hay una aplicación normal visible. Si el escritorio/shell está al frente, usa `HWND_TOP` dentro de la banda no topmost: en esta máquina `HWND_BOTTOM` quedaba oculto bajo el escritorio. Si la ventana activa es topmost, se usa `HWND_NOTOPMOST`. Es una decisión de orden Z comprobada en el escritorio; no usa APIs internas `WorkerW`.

## Accesos directos

El script crea un acceso directo en el Escritorio del usuario y, opcionalmente, en el menú Inicio. `-WhatIf` muestra los destinos sin escribirlos:

```powershell
.\scripts\install-desktop-shortcut.ps1 -WhatIf
.\scripts\install-desktop-shortcut.ps1 -IncludeStartMenu
```

Se pueden pasar `-ExecutablePath`, `-DesktopPath` y `-StartMenuPath` para usar otras rutas.

## Evidencia y límites

- [Preview determinista](docs/verification/scene-preview.png): escena sintética renderizada por el compositor; no demuestra transparencia de la ventana de Windows.
- [Captura del escritorio](docs/verification/desktop-widget.png): captura real alrededor de la ventana, tomada con `System.Drawing.Graphics.CopyFromScreen`.

La preview mide 1040 × 240 px porque compara dos escenas de 520 × 240 px. La preview muestra el hover sintético; la captura de escritorio usa jobs sintéticos dentro de un `COLMENA_HOME` temporal y muestra la escena sobre el wallpaper, no el estado de una instalación real.

El binario debe compilarse localmente; `dist/colmena-widget.exe` no se versiona. `dumpbin` y `llvm-readobj` no estaban disponibles durante esta verificación, así que no se afirma haber inspeccionado la tabla PE de imports. El flag `+crt-static` configura el enlace estático del CRT, mientras DLL de sistema como User32 y GDI siguen siendo dependencias normales de Windows.

### Comprobación en escritorio — 15 de octubre de 2026

Se ejecutó el release con un `COLMENA_HOME` temporal y jobs sintéticos. La captura conserva transparencia de escritorio y el hover físico muestra worker, tarea, contador `mm:ss` que avanza y costo. Se observaron las transiciones sintéticas a `done` y `failed`; Notepad maximizado cubrió el widget y, al cerrarlo, volvió al escritorio. El HWND reportó `WS_EX_TOOLWINDOW` (`0x80`) sin `WS_EX_APPWINDOW` (`0x40000`) ni `WS_EX_TOPMOST` (`0x8`), por lo que no solicita botón de barra de tareas ni topmost. El arrastre y la salida por menú se ejercitaron con mensajes Win32 publicados a la ventana; la posición guardada sobrevivió al reinicio y el registro de proceso desapareció al salir.

La entrada del cursor físico se verificó para hover. En esta sesión, la entrada física de botones no produjo mensajes observables; el arrastre, menú y salida se verificaron con mensajes Win32 publicados y también tienen pruebas automatizadas sin HWND. La captura no afirma una verificación de clic físico.

### Comprobación visual ronda 5 — 16 de octubre de 2026

Se recompiló `target/release/colmena-widget.exe` y arrancó con un `COLMENA_HOME` temporal; `widget-process.json` registró el PID y la ruta del ejecutable de este worktree. `desktop-widget.png` es una captura `CopyFromScreen` de 640 × 360 px: se ve la ventana de 520 × 240 px sobre el wallpaper, con jobs sintéticos en cola y en ejecución y las transiciones `done`/`failed` activadas durante la toma. `scene-preview.png` muestra estados sintéticos y el tooltip ampliado con worker, tipo, tarea, tiempo y costo. La captura del escritorio no alcanzó a mostrar el tooltip físico.

## Solución de problemas

- **No aparece el widget:** verifica el home, que exista `jobs/`, y que no haya otra instancia para el mismo home. Un segundo inicio termina con aviso.
- **No hay jobs visibles:** el widget solo representa jobs `queued`/`running` del snapshot; jobs terminales que ya estaban terminados al iniciar no reproducen una transición pasada.
- **No se puede iniciar:** al fallar la lectura del home, el mutex o la plataforma, aparece un diálogo con el error.
- **Se tapa con una aplicación:** el comportamiento es intencional; una app normal visible queda por encima. Al volver al escritorio el widget se muestra en la banda normal de ventanas.

La integración con MCP pertenece a una fase posterior y no forma parte de este ejecutable.
