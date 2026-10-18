# Estilo: papercraft

Reporte final que parece hecho de **papel recortado en capas**: fondo kraft, tarjetas crema con borde inferior rasgado, cinta washi, sombras apiladas, sellos de estado y ligeras rotaciones. Cálido, artesanal, legible.

## Tu trabajo (agente reportero)
1. Lee `data.json` (única fuente de verdad) y `template.html` (en esta misma carpeta de estilo).
2. Escribe `report.html` en el directorio de trabajo: es `template.html` con los marcadores `{{...}}` ya reemplazados, el comentario `<!--COLMENA:CARDS-->` sustituido por una `<article class="card">` por cada job y el comentario `<!--COLMENA:NOTES-->` sustituido por la sección «Decisiones del orquestador» si `data.notes` no está vacío (si está vacío, elimina el comentario sin dejar sección).
3. Autocontenido: nada de scripts, fuentes o imágenes externas; conserva el `<style>` del template (puedes añadir CSS propio al final, sin quitar el existente).
4. No inventes hechos. Si un dato falta, di que falta. Escapa el HTML del contenido (`&lt;`, `&gt;`, `&amp;`).

## Marcadores
`{{title}}`, `{{subtitle}}` (una frase que resuma el conjunto de lo logrado), `{{generated}}`, `{{jobs}}`, `{{done}}`, `{{failed}}`, `{{cost}}` (USD con 2 decimales), `{{duration}}` (p. ej. `12 min`), `<!--COLMENA:NOTES-->` (sección de decisiones del orquestador) y `<!--COLMENA:CARDS-->` (tarjetas).

## Notas y commits en data.json
- `notes` (string, puede faltar): objetivo del hito, decisiones y riesgos del orquestador. Si no está vacío, sustituye `<!--COLMENA:NOTES-->` por:
  `<section class="notes"><h2 class="hand">Decisiones del orquestador</h2><p>…notas escapadas con <br>…</p></section>`.
- Cada job puede traer `commits: [{hash, subject, url?}]` (máximo 10, de su rama respecto a la base). Si `url` existe, enlaza el hash corto; si no, muéstralo como texto (`<code>`). Omite la sección si no hay commits.

## Estructura de cada tarjeta
```html
<article class="card" data-state="done">
  <span class="washi"></span>
  <header><h3>Título corto de lo logrado</h3><span class="stamp done">done</span></header>
  <p class="meta"><span class="chip">worker</span><span class="chip">3 min</span><span class="chip">$0.02</span><span class="chip">rama colmena/ab12</span></p>
  <section><h4>Resultado</h4><p>…</p></section>
  <section><h4>Archivos</h4><p>…</p></section>
  <section><h4>Pruebas</h4><p>…</p></section>
  <section class="risks"><h4>Riesgos</h4><p>…</p></section>
  <section class="commits"><h4>Commits</h4><ul><li><a href="https://github.com/acme/repo/commit/abc1234">abc1234</a> asunto del commit</li></ul></section>
</article>
```
Clase del sello: `done`, `failed`, `cancelled` u `other` (según el estado del job). Omite `section.risks` si no hay riesgos reales y `section.commits` si no hay commits.

## Tono
Español claro y cálido, frases cortas, sin jerga innecesaria; el título de cada tarjeta dice *qué se logró* (no el id del job). Ordena las tarjetas de lo más importante a lo menos. Todo debe verse bien en móvil y en modo oscuro (el template ya lo resuelve; no lo rompas).
