// Genera el ZPL de la etiqueta "Transferencia entre CEDIs" (rollo 10,4 x 15,4 cm, 203 dpi = 8 puntos/mm).
// Mismo diseño de casillas que la plantilla de la app (src/Disenador.js · plantillaTransferenciaCedis_).
// Uso: node zpl/generar-zpl.js            → zpl/transferencia-cedis.zpl (con {campos})
//      node zpl/generar-zpl.js ejemplo    → zpl/transferencia-cedis-ejemplo.zpl (con datos de prueba)
const fs = require('fs'), path = require('path');
const X = 16, W = 800;
// ZPL: cada casilla = recuadro (^GB) + título fijo + valor en bloque (^FB: parte líneas y alinea dentro de la casilla).
// fuente: [alto, ancho] de ^A0 en puntos · lineas: máximo de líneas del valor · max: caracteres aproximados que entran.
const CELDAS = [
  [X, 146, 400, 112, 'CEDI ORIGEN', '{cediOrigen}', 'L', [32, 28], 2],
  [X + 400, 146, 400, 112, 'CEDI DESTINO', '{cediDestino}', 'L', [32, 28], 2],
  [X, 258, 300, 88, 'N. TRANSFERENCIA', '{nroTransferencia}', 'L', [40, 24], 1],
  [X + 300, 258, 300, 88, 'N. ENVIO', '{nroEnvio}', 'L', [40, 24], 1],
  [X + 600, 258, 200, 88, 'FECHA', '{fecha}\\&{hora}', 'C', [24, 22], 2],
  [X, 346, 300, 88, 'ARTICULO', '{articulo}', 'L', [40, 24], 1],
  [X + 300, 346, 300, 88, 'LOTE', '{lote}', 'L', [40, 24], 1],
  [X + 600, 346, 200, 88, 'UNIDAD', '{um}', 'C', [40, 28], 1],
  [X, 434, W, 120, 'DESCRIPCION', '{descripcion}', 'L', [36, 26], 2],
  [X, 554, 400, 100, 'PALLETS', '{nroPallets}', 'C', [60, 50], 1],
  [X + 400, 554, 400, 100, 'CAJAS', '{cajas}', 'C', [60, 50], 1],
  [X, 654, 400, 96, 'CHOFER', '{chofer}', 'L', [26, 22], 2],
  [X + 400, 654, 200, 96, 'CEDULA', '{cedula}', 'C', [40, 24], 1],
  [X + 600, 654, 200, 96, 'PLACA', '{placa}', 'C', [40, 24], 1],
  [X, 750, W, 140, 'OBSERVACIONES', '{observaciones}', 'L', [30, 22], 3]
];
const FIRMAS = [[X, 'ENTREGA (BODEGA)', '{usuario}'], [X + 400, 'CHOFER', 'C.I. {cedula}']];
const JUEGO = ['ORIGINAL', 'COPIA - RESPALDO DE BODEGA'];

function etiqueta(copia) {
  const z = ['^XA', '^CI28', '^PW832', '^LL1232', '^LH0,0'];
  z.push('^FX ===== ' + copia + ' =====');
  z.push('^FO' + X + ',24^GB' + W + ',72,72^FS');                                   // banda negra
  z.push('^FO' + X + ',32^A0N,60,44^FR^FB' + W + ',1,0,C^FD' + copia + '^FS');      // encabezado en blanco sobre negro
  z.push('^FO' + X + ',106^A0N,34,30^FB' + W + ',1,0,C^FDTRANSFERENCIA ENTRE CEDIS^FS');
  CELDAS.forEach(([x, y, w, h, titulo, valor, just, f, lineas]) => {
    z.push('^FX ' + titulo);
    z.push('^FO' + x + ',' + y + '^GB' + w + ',' + h + ',2^FS');
    z.push('^FO' + (x + 10) + ',' + (y + 8) + '^A0N,18,16^FD' + titulo + '^FS');
    z.push('^FO' + (x + 10) + ',' + (y + 32) + '^A0N,' + f[0] + ',' + f[1] + '^FB' + (w - 20) + ',' + lineas + ',2,' + just + '^FD' + valor + '^FS');
  });
  FIRMAS.forEach(([x, titulo, pie]) => {
    z.push('^FX FIRMA ' + titulo);
    z.push('^FO' + x + ',890^GB400,240,2^FS');
    z.push('^FO' + (x + 10) + ',898^A0N,18,16^FD' + titulo + '^FS');
    z.push('^FO' + (x + 20) + ',1076^GB360,2,2^FS');                                  // línea para firmar
    z.push('^FO' + (x + 10) + ',1086^A0N,32,26^FB380,1,0,C^FD' + pie + '^FS');
  });
  z.push('^PQ1', '^XZ');
  return z.join('\n');
}
const EJEMPLO = { cediOrigen: 'CEDI CUENCA', cediDestino: 'CEDI QUITO', nroTransferencia: 'TR-24581', nroEnvio: 'ENV-889120', fecha: '24/11/2026', hora: '09:40',
  articulo: '84ER6202E', lote: 'T673N', um: 'M2', descripcion: 'PISO CONCEPT GRIS 60X60 PRIMERA', nroPallets: '2', cajas: '60',
  chofer: 'LUIS MORA', cedula: '0102030400', placa: 'ABC-1234', observaciones: 'PALLETS CON ESQUINEROS', usuario: 'jperez' };
const ejemplo = process.argv[2] === 'ejemplo';
let zpl = '^FX Transferencia entre CEDIs · rollo 10,4 x 15,4 cm · 203 dpi · juego ORIGINAL + COPIA (2 etiquetas)\n' + JUEGO.map(etiqueta).join('\n') + '\n';
if (ejemplo) zpl = zpl.replace(/\{(\w+)\}/g, (m, k) => EJEMPLO[k] !== undefined ? EJEMPLO[k] : m);
const destino = path.join(__dirname, ejemplo ? 'transferencia-cedis-ejemplo.zpl' : 'transferencia-cedis.zpl');
fs.writeFileSync(destino, zpl);
console.log(path.basename(destino), '·', zpl.length, 'caracteres ·', (zpl.match(/\^XA/g) || []).length, 'etiquetas');
