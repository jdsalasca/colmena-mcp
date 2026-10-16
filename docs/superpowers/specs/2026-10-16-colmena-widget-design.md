# Colmena Widget para Windows — diseño

Fecha de elaboración: 2026-10-15
Estado: propuesta implementable; pendiente de ejecución
Plan de implementación: `docs/superpowers/plans/2026-10-16-colmena-widget.md`

## 1. Propósito

Colmena Widget es una ventana compacta de escritorio para Windows que convierte los jobs de colmena-mcp en una escena pixel art: una colmena en un pastizal y una abeja por job activo. Su finalidad es permitir ver de un vistazo qué agentes están esperando, trabajando o terminando, sin abrir el servidor MCP ni las carpetas de jobs.

El widget es un consumidor local de metadatos. Lee `<COLMENA_HOME>/jobs/<id>/meta.json`, no lanza agentes y no modifica esos archivos. Si `COLMENA_HOME` no está definida, usa `%USERPROFILE%\.colmena`, igual que el servidor.

## 2. Evidencia del formato de jobs

La inspección de `src/store.js` confirma que el store crea una carpeta por id, escribe `meta.json` mediante un archivo temporal con sufijo del PID y lo publica con rename. `list()` lee los metadatos de las carpetas y omite los que no se pueden parsear. El lector del widget debe ser tolerante con una carpeta que cambie mientras se lee y no debe bloquear el hilo gráfico con operaciones de disco.

La inspección de `src/jobs.js` confirma estas transiciones y datos:

| Estado persistido | Momento y datos disponibles | Presentación |
|---|---|---|
| `queued` | Se crea al enviar el job; incluye `createdAt`, `kind`, `task`, `worker` y `provider`. | Abeja esperando en la entrada. |
| `running` | Al arrancar se fija `startedAt`. | Abeja volando entre flores, con alas animadas. |
| `done` | Al terminar se fijan `endedAt` y normalmente `costUsd`. | Al detectar la transición desde activo, vuelve a la colmena, brilla y desaparece. |
| `failed` / `orphaned` | Al terminar o recuperar un job abandonado se fijan `endedAt`; puede haber `error` y `costUsd`. | Cae, parpadea en rojo brevemente y desaparece. |
| `cancelled` | Puede cancelarse en cola o durante la ejecución; puede no tener `costUsd`. | Vuelve sin brillo y se retira en tono neutro. |

El objeto JSON también puede contener `id`, `branch`, `createdAt`, `startedAt`, `endedAt`, `costUsd`, `kind`, `task`, `worker` y `provider`. El lector debe tolerar campos desconocidos y ausentes. Un estado desconocido no debe convertirse en una abeja activa.

El store no conserva eventos históricos separados: el widget observa snapshots. Por eso, las animaciones terminales se activan solo cuando el snapshot anterior tenía el job en cola o ejecución y el nuevo snapshot muestra su terminación. Un job terminal que ya existía al arrancar no genera una abeja ni reproduce una animación vieja.

## 3. Experiencia y reglas visuales

La escena base muestra pasto, flores, una colmena y algún hongo. Todas las imágenes se dibujan con código: matrices de píxeles y una paleta limitada, sin PNG, GIF, spritesheets ni recursos descargados. El texto del tooltip usa una fuente bitmap embebida en código; admite como mínimo ASCII, signos de costo y letras españolas acentuadas, con un glifo de reemplazo para caracteres fuera del repertorio.

| Worker | Apariencia determinista |
|---|---|
| Alias que contiene `luna`, por ejemplo `luna-max` | Dorada, tamaño base. |
| Alias que contiene `ds` o `deepseek`, por ejemplo `ds-flash` | Azulada, tamaño base. |
| Alias que contiene `hive`, por ejemplo `max-hive` | Verde y pequeña. |
| Cualquier otro alias | Paleta neutra y tamaño intermedio. |

La comparación del alias no distingue mayúsculas. El estilo se calcula desde el alias y nunca usa aleatoriedad, para que una misma abeja conserve color y tamaño entre lecturas.

### Escena por estado

- Cada job activo representa exactamente una abeja identificable por `id`.
- Las abejas `queued` ocupan posiciones separadas cerca de la entrada. Las `running` recorren trayectorias deterministas sobre las flores, con aleteo cíclico.
- El paso a `done` crea una trayectoria de regreso y un destello corto al entrar a la colmena. El paso a `failed` o `orphaned` crea caída roja breve. `cancelled` vuelve sin destello.
- La trayectoria y la fase de aleteo dependen de `id`, estado y tiempo recibido por parámetro. No se usa `math/rand` global ni la hora del sistema dentro de funciones puras.
- Si no hay jobs activos ni animaciones de salida, aparecen abejas dormidas junto a la colmena, con `Zz`. No llevan tooltip de job.
- Todos los jobs activos deben seguir representados si hay muchos: se reduce el espaciado o el tamaño dentro de límites legibles; no se descartan jobs silenciosamente.

### Tooltip

Al pasar el puntero sobre una abeja de job se presenta alias del worker, tipo (`kind`), tarea truncada a un máximo de 60 runas, duración y costo. La duración en ejecución se calcula desde `startedAt`; para cola se calcula desde `createdAt` y se etiqueta como tiempo en cola. Se vuelve a calcular con el reloj del frame para que cambie en vivo. Duraciones superiores a una hora conservan minutos acumulados, por ejemplo `73:09`; valores negativos se muestran como cero. El costo usa cuatro decimales y punto decimal. Si todavía no existe `costUsd`, el tooltip dice “pendiente”.

Si una abeja terminal está en su animación de salida, el tooltip puede usar el último metadato válido del job y su duración final. Las cadenas se recortan por runas, no por bytes, para no cortar UTF-8 a mitad de carácter.

## 4. Ventana e interacción

- Ventana Ebitengine sin decoración, tamaño inicial fijo, fondo transparente alrededor de la escena y sin botón en la barra de tareas.
- La ventana permanece en el nivel inferior del orden Z normal y no debe quedar por encima de otras aplicaciones. No se habilita el modo flotante/topmost de Ebitengine.
- El usuario puede arrastrarla con el botón izquierdo. El movimiento se calcula desde el punto inicial del puntero y el origen de ventana; el final del arrastre guarda la posición.
- El hover usa hit-testing de rectángulos/círculos en coordenadas de escena, con desempate determinista cuando se superponen abejas.
- Clic derecho abre un pequeño menú pixel art dentro de la ventana con la acción `Salir`. Clic izquierdo en Salir cierra el proceso; clic fuera lo cierra sin salir.
- El tamaño y la posición se limitan al área de trabajo de un monitor. Al iniciar, carga la posición guardada; si es inválida o quedó fuera de pantalla, se clampa al monitor disponible o se usa una ubicación inicial abajo a la derecha.
- La posición se guarda en `<COLMENA_HOME>/widget-position.json` con coordenadas de ventana. La escritura usa temporal más rename. El archivo ausente significa primera ejecución; un archivo corrupto conserva el fallback y produce un aviso no fatal.
- No se instala inicio automático. El README explicará cómo ejecutar el binario y, de forma opcional, crear un acceso directo de Windows.

## 5. Límites de arquitectura

La separación es obligatoria para que la lógica se pruebe sin GPU ni ventana:

1. **Datos:** tipos de job, resolución de home, lectura de snapshots y tolerancia a archivos transitorios.
2. **Dominio de escena:** selección de worker, estados visuales, transiciones, layout, rutas, tiempo, tooltip, hit-testing, menú y cálculo de arrastre. Funciones deterministas reciben `now`, límites y snapshots como parámetros.
3. **Persistencia:** lectura/escritura del archivo de posición y cálculo puro de clamp.
4. **Plataforma Windows:** localizar el HWND de este proceso, estilos de ventana, orden Z, área de trabajo y movimiento de ventana. Encapsula `golang.org/x/sys/windows`.
5. **Vista Ebitengine:** matrices de píxeles y paleta, composición y lectura de entrada; consume el dominio y no conoce rutas de archivos de jobs.
6. **Aplicación:** polling fuera del hilo de render, composición de snapshots, tooltip, menú, drag, cierre y guardado de posición.

La ventana se identifica por PID del widget y título propio, no mediante búsqueda global por texto solamente. El acceso al HWND y llamadas Win32 se encapsulan para que los paquetes de lógica y pruebas no importen Windows.

## 6. Compatibilidad de herramientas

El módulo vive en `widget/` con `go.mod` propio, directiva de lenguaje mínima Go 1.23 y objetivo Windows amd64. En la fecha de elaboración, las notas oficiales indican que Ebitengine 2.9 requiere Go 1.24 y Ebitengine 2.10 requiere Go 1.25. Por tanto, para cumplir la base Go 1.23, se debe fijar una versión de Ebitengine compatible con 1.23 (línea 2.8.x si el instalador entrega exactamente Go 1.23); nunca se debe fijar “latest” sin verificar el go.mod de la dependencia. Fijar también una versión compatible de `golang.org/x/sys`.

Referencias primarias para quien implemente:

- [Notas de Ebitengine 2.9](https://ebitengine.org/en/documents/2.9.html) — requisito Go 1.24.
- [Notas de Ebitengine 2.10](https://ebitengine.org/en/documents/2.10.html) — requisito Go 1.25.
- [API de Ebitengine v2](https://pkg.go.dev/github.com/hajimehoshi/ebiten/v2) — ventana, posición, transparencia y ciclo de dibujo.
- [Paquete golang.org/x/sys/windows](https://pkg.go.dev/golang.org/x/sys/windows) — llamadas Win32.
- [SetWindowPos, Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos) — orden Z, HWND_BOTTOM y SWP_NOACTIVATE.

## 7. Fuera de alcance de esta primera versión

- Crear o cancelar jobs desde el widget.
- Mostrar historial de jobs terminados, contenido de resultados, ramas, errores completos o logs.
- Conectarse al servidor MCP por red, abrir puertos o instalar un servicio.
- Login, sincronización en nube, iconos/imagenes externas, sonido, configuración visual extensa, autoarranque o instalador.
- Cambiar el esquema Node de jobs o escribir metadatos dentro de las carpetas de jobs.

## 8. Criterios de aceptación del producto

1. Ejecuta en Windows como ventana sin bordes, sin botón de barra de tareas y sin colocarse por encima de otras ventanas.
2. Lee jobs desde el home configurado o el default, y una escritura atómica en curso no congela ni rompe la escena.
3. Una abeja por job activo refleja cola/ejecución; las transiciones de éxito y error se animan y terminan; el estado inactivo muestra abejas dormidas.
4. Color y tamaño son estables por alias de worker; hover muestra datos actuales y duración actualizada.
5. Drag, clic derecho/Salir y persistencia de posición funcionan después de cerrar y volver a abrir.
6. La suite de lógica pasa con `go test ./...`; la compilación produce `colmena-widget.exe`; una captura real de Windows demuestra la presentación, además de una comprobación visual de orden Z e interacción.
7. El README permite a un agente nuevo compilar, ejecutar, probar y encontrar la captura sin contexto de esta conversación.

## 9. Riesgos que el plan debe resolver

- Un HWND_BOTTOM simple puede quedar detrás de capas del escritorio de Explorer o dejar de recibir clics si la ventana no se activa. La primera prueba manual debe confirmar visibilidad, hover, clic derecho y que una app normal sigue cubriéndolo; si falla, investigar la integración con WorkerW sin depender de APIs internas no verificadas.
- Ebitengine no entrega el HWND como parte de una interfaz pública estable. Localizarlo por PID/título debe tener timeout, manejar recreación de ventana y fallar con mensaje claro.
- Desactivar activación para evitar que la ventana salte al frente puede interferir con eventos del mouse. No se considera resuelto por tests unitarios: se necesita la verificación visual en Windows.
- Monitores con DPI y coordenadas negativas requieren usar el mismo sistema de coordenadas en Ebitengine, Win32 y el archivo persistido; clamp y restauración deben probarse con casos de varios monitores.
- El job que termina entre dos polls puede saltar su animación. El widget muestra el snapshot actual y anima las transiciones que observa; el contrato no promete reconstruir estados que nunca quedaron persistidos.
