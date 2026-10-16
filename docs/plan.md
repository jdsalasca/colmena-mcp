# Plan de correcciones

## Ronda 1: agregación de estadísticas
- Entregables: conservar errores completos al agrupar; promediar solo duraciones válidas; manejar claves `__proto__`; compartir las métricas por job con el reporte.
- Criterios: pruebas unitarias que reproduzcan cada caso; totales de stats y reporte coincidentes en duración y costo con el redondeo común.

## Ronda 2: mejora continua y configuración
- Entregables: excluir mejoras fechadas en el futuro de la ventana reciente; mostrar cambios de plugins en `reload_config`; verificar `since_days` desde el cliente MCP.
- Criterios: pruebas enfocadas para fecha futura, diff de plugins y exclusión de un job antiguo.

## Cierre
- Ejecutar `npm test`, revisar el diff y dejar commits pequeños en la rama de trabajo actual.
