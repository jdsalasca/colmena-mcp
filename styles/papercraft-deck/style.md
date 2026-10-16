# Papercraft deck

Redacta una narración breve del hito a partir de `data.json`, la única fuente de verdad. Cuenta qué cambió, por qué importa, qué evidencia respalda el resultado y qué queda pendiente. No inventes fechas, impactos, decisiones, métricas ni riesgos; las notas del orquestador son contexto, no prueba de que algo se haya implementado.

## Relato

- Una idea principal por diapositiva y frases claras en español.
- Abre con el nombre y el propósito del hito; continúa con el contexto, los resultados y la evidencia; termina con métricas registradas y pendientes concretos.
- Usa una diapositiva por job para explicar su `RESULT`, `FILES`, `TESTS` y `RISKS`. Si un dato falta, dilo de forma explícita.
- Ordena los trabajos por su aporte al objetivo. Conserva los nombres de archivos, cifras, estados y costos tal como aparecen en los datos.
- Distingue resultados comprobados de objetivos, decisiones y riesgos incluidos en `notes`.

## Estructura HTML

1. Lee `template.html` y conserva su CSS, controles, navegación por teclado, indicadores y metadatos.
2. Reemplaza `{{title}}`, `{{subtitle}}`, `{{generated}}` y `{{slides_count}}` con valores escapados. Sustituye `<!--COLMENA:SLIDES-->` con el contenido de las diapositivas.
3. Cada diapositiva es un `<section class="slide" aria-label="…">` completo. Dentro usa una `.paper-stack` con un `<article class="paper">`, una cinta `<span class="washi">`, un título y contenido legible. Mantén una idea por sección.
4. Produce al menos tres secciones. Conserva enlaces y recursos locales solo si ya existen en los datos; no añadas recursos externos.
5. Escribe el archivo `deck.html` solicitado por el prompt. No modifiques `data.json`, la plantilla ni otros archivos.

## Tono y acabado

Cálido, sobrio y artesanal. Los títulos pueden usar la familia manuscrita local que ofrece la plantilla; el cuerpo debe privilegiar la lectura. Reparte el espacio, deja aire alrededor de cada idea y conserva la paleta kraft/crema, las sombras de papel y los sellos de estado. Evita adornos que compitan con la evidencia.
