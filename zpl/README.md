# ZPL · Transferencia entre CEDIs

Rollo **10,4 x 15,4 cm** (832 x 1232 puntos, 203 dpi). Un archivo imprime el **juego de 2 etiquetas**:
**ORIGINAL** y **COPIA - RESPALDO DE BODEGA** (dos bloques `^XA … ^XZ`).

| Archivo | Para qué |
|---|---|
| `transferencia-cedis.zpl` | Plantilla con `{campos}` para reemplazar por los datos de cada envío |
| `transferencia-cedis-ejemplo.zpl` | Lista para probar: ya tiene datos de ejemplo |
| `generar-zpl.js` | Vuelve a generar los dos archivos si cambia el diseño (`node zpl/generar-zpl.js` y `node zpl/generar-zpl.js ejemplo`) |

## Campos
Cada casilla usa `^FB` (bloque de texto): parte las líneas sola dentro de su recuadro. Largo aproximado que entra:

| Campo | Casilla | Líneas | Caracteres aprox. |
|---|---|---|---|
| `{cediOrigen}`, `{cediDestino}` | CEDI ORIGEN / DESTINO | 2 | 50 |
| `{nroTransferencia}`, `{nroEnvio}` | N. TRANSFERENCIA / N. ENVIO | 1 | 20 |
| `{fecha}`, `{hora}` | FECHA | 2 | 10 + 5 |
| `{articulo}`, `{lote}` | ARTICULO / LOTE | 1 | 20 |
| `{um}` | UNIDAD | 1 | 8 |
| `{descripcion}` | DESCRIPCION | 2 | 110 |
| `{nroPallets}`, `{cajas}` | PALLETS / CAJAS | 1 | 10 |
| `{chofer}` | CHOFER | 2 | 50 |
| `{cedula}`, `{placa}` | CEDULA / PLACA | 1 | 12 |
| `{observaciones}` | OBSERVACIONES | 3 | 190 |
| `{usuario}` | Pie de la firma de bodega | 1 | 25 |

Si un dato es más largo, Zebra encima el sobrante en la última línea: conviene abreviarlo.

## Notas
- `^CI28`: acepta tildes y Ñ en los datos (UTF-8).
- Si un dato trae `^` o `~`, rompe el ZPL: quítalos antes de imprimir.
- Fuente `^A0` (la escalable de Zebra). La app imprime en EPL con fuentes propias, por eso entre la app y este ZPL
  el tamaño de letra puede variar un poco; las casillas y posiciones son las mismas.
- Probar sin impresora: pegar el contenido en el visor de https://labelary.com/viewer.html (8 dpmm, 4.1 x 6.1 in).
