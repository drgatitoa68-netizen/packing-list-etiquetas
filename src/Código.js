/**
 * PACKING LIST - BODEGA (Apps Script Web App)
 * Replica la app Etiquetas-main (React) usando Google Sheets como base de
 * datos en vez de localStorage/Firebase, e impresión Zebra directa por USB
 * (WebUSB) desde el navegador, igual que esa app.
 *
 * ALCANCE DE ESTE INCREMENTO: Subir archivo, Datos (tabla + filtros +
 * confirmación de línea + auto-asignar etiqueta), Etiquetas (vista agrupada
 * + vista previa + impresión USB).
 * FUERA DE ALCANCE por ahora (se suma después): login con Google, módulo de
 * Jornada/turnos, auditoría en Drive, vista de Base de datos del catálogo.
 */

const SH_DATOS = 'DATOS';
const SH_BASE = 'base';
const SH_ANDENES = 'ANDENES';
const ZEBRA_LINES_PER_BLOCK = 10;

// Etiqueta Zebra: 800 x 600 puntos (203 dpi, 8 puntos = 1 mm -> 100 x 75 mm).
// ZEBRA_MARGEN es el margen de seguridad por lado, en puntos: 24 = 3 mm. Las
// impresoras Zebra no imprimen en el borde físico de la etiqueta (y el rollo se
// puede correr un poco), por eso todo el diseño queda dentro de este margen.
const ZEBRA_ANCHO = 800;
const ZEBRA_ALTO = 600;
const ZEBRA_MARGEN = 8; // 1 mm: el diseño ocupa toda la etiqueta de 10 x 7.5 cm

const SH_CARGAS = 'CARGAS';
const SH_HISTORIAL = 'HISTORIAL';

const FIELDS = [
  'id', 'lineaNum', 'ordenVenta', 'articulo', 'descripcion', 'lote', 'localizador',
  'subInven', 'cantidadSolicitada', 'um', 'nroPallets', 'cajas', 'peso',
  'nroEnvio', 'instrEnvio', 'andenPicking', 'horaCarga', 'checkOut', 'cliente',
  'selected', 'nroEtiqueta', 'fechaImpresion',
  'cantidadConfirmada', 'palletsConfirmados', 'cajasConfirmados',
  // Historial: a qué carga pertenece la línea y cuándo se tocó por última vez.
  'cargaId', 'fechaCarga', 'archivo', 'actualizadoEn'
];

// Campos que vienen del archivo de origen. Al volver a subir un archivo, una
// línea que ya existe solo actualiza estos campos: la etiqueta y la
// confirmación hechas en bodega se conservan.
const CAMPOS_ORIGEN = [
  'ordenVenta', 'articulo', 'descripcion', 'lote', 'localizador', 'subInven',
  'cantidadSolicitada', 'um', 'nroPallets', 'cajas', 'peso', 'nroEnvio',
  'instrEnvio', 'andenPicking', 'horaCarga', 'checkOut', 'cliente'
];

// Columnas que se guardan como texto para que la hoja no las convierta en
// fechas u horas (ej. "8:30 AM") ni quite ceros a la izquierda.
const CAMPOS_TEXTO = ['nroEnvio', 'ordenVenta', 'lote', 'horaCarga', 'nroEtiqueta', 'andenPicking'];

const TZ = 'America/Guayaquil';

// ======================
// WEB APP ENTRY POINT
// ======================
function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Packing List - Bodega')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ======================
// ESTADO / CARGA DE DATOS
// ======================
// filtro: { periodo: 'hoy' | '7' | '30' | 'todo' } o { cargaId: '...' }.
// Por defecto últimos 7 días, para que la app siga rápida con el historial.
function api_getState_(filtro) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  asegurarTutorial_(ss);
  aplicarClaveDesdeHoja_();
  const wsD = asegurarDatos_(ss);
  const wsB = getOrCreateSheet_(ss, SH_BASE);
  filtro = filtro || {};
  const lectura = leerDatosPeriodo_(wsD, filtro);
  // Número ETQ más alto de TODO el historial: el botón "Auto" no debe repetir uno viejo.
  // Incluye el mayor número de las líneas ya borradas por la limpieza (Limpieza.js)
  const maxEtq = Math.max(lectura.maxEtq, etqMaxHistorico_());
  const mapaA = mapaAndenes_(ss);
  const orders = lectura.filas.map(serializarFila_).map(function (o) {
    const da = datosAndenEnvio_(mapaA, o.nroEnvio);
    o.cliente = da.cliente; o.andenPicking = da.anden; o.horaCarga = da.horaCarga;
    return o;
  });
  return {
    orders: orders,
    maxEtiqueta: maxEtq,
    catalog: leerCatalogo_(wsB),
    cargas: listarCargas_(ss, 60),
    claveConfigurada: !!PropertiesService.getScriptProperties().getProperty('CLAVE_CARGA'),
    colaPendientes: api_contarCola_()
  };
}

function filtroCarga_(filtro) {
  if (filtro.cargaId) return function (r) { return String(r.cargaId) === String(filtro.cargaId); };
  const periodo = filtro.periodo || '2'; // por defecto: hoy y ayer
  if (periodo === 'todo') return function () { return true; };
  const desde = new Date();
  desde.setHours(0, 0, 0, 0);
  if (periodo !== 'hoy') desde.setDate(desde.getDate() - (Number(periodo) - 1));
  return function (r) {
    // Una línea entra si se cargó o se tocó (confirmó/actualizó) dentro del período.
    const f = [r.fechaCarga, r.actualizadoEn].filter(function (v) { return v instanceof Date; });
    return !f.length || f.some(function (d) { return d >= desde; });
  };
}

// Rendimiento: antes se leía la hoja DATOS completa (toda la historia) en cada carga
// de la pantalla. Ahora se leen solo las columnas necesarias para decidir qué filas
// entran en el período (fechaCarga, actualizadoEn, cargaId) y el Nº de etiqueta, y
// después SOLO esas filas. Mismo resultado y mismo orden que filtrar la hoja entera.
// Devuelve { filas: [obj por fila], maxEtq }.
function leerDatosPeriodo_(wsD, filtro) {
  const lastRow = wsD.getLastRow();
  const lastCol = wsD.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return { filas: [], maxEtq: 0 };
  const headers = wsD.getRange(1, 1, 1, lastCol).getValues()[0];
  const col = function (h) { return headers.indexOf(h); };
  const iEtq = col('nroEtiqueta'), iFc = col('fechaCarga'), iAc = col('actualizadoEn'), iCa = col('cargaId');
  const maxDe = function (valores) {
    let m = 0;
    valores.forEach(function (v) {
      v = String(v || '');
      if (v.indexOf('ETQ-') === 0) { const n = parseInt(v.substring(4), 10); if (n > m) m = n; }
    });
    return m;
  };
  const aObjetos = function (vals) {
    return vals.map(function (row) {
      const obj = {};
      headers.forEach(function (h, i) { obj[h] = row[i]; });
      return obj;
    });
  };
  // Hoja antigua sin alguna columna, o "todo el historial": lectura completa (como antes).
  if (iEtq < 0 || iFc < 0 || iAc < 0 || iCa < 0 || (!filtro.cargaId && filtro.periodo === 'todo')) {
    const todas = leerFilas_(wsD);
    return { filas: todas.filter(filtroCarga_(filtro)), maxEtq: maxDe(todas.map(function (r) { return r.nroEtiqueta; })) };
  }
  const n = lastRow - 1;
  const columna = function (i) { return wsD.getRange(2, i + 1, n, 1).getValues().map(function (r) { return r[0]; }); };
  const etq = columna(iEtq), fc = columna(iFc), ac = columna(iAc), ca = columna(iCa);
  const entra = filtroCarga_(filtro);
  const posiciones = [];
  for (let k = 0; k < n; k++) {
    if (entra({ fechaCarga: fc[k], actualizadoEn: ac[k], cargaId: ca[k] })) posiciones.push(k);
  }
  const filas = leerFilasDatos_(wsD, posiciones, lastCol).map(function (x) { return x.row; });
  return { filas: aObjetos(filas), maxEtq: maxDe(etq) };
}

function leerFilas_(wsD) {
  const lastRow = wsD.getLastRow();
  const lastCol = wsD.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  const headers = wsD.getRange(1, 1, 1, lastCol).getValues()[0];
  const vals = wsD.getRange(2, 1, lastRow - 1, lastCol).getValues();
  return vals.map(function (row) {
    const obj = {};
    headers.forEach(function (h, i) { obj[h] = row[i]; });
    return obj;
  });
}

// google.script.run no puede devolver objetos Date: si una sola celda es una
// fecha (fechaImpresion, o una hora que la hoja convirtió sola), la respuesta
// completa llega vacía y la app parece no tener datos. Se pasan a texto.
function serializarFila_(r) {
  const o = {};
  Object.keys(r).forEach(function (k) { o[k] = textoCelda_(r[k], k); });
  return o;
}

function textoCelda_(v, campo) {
  if (!(v instanceof Date)) return v;
  if (campo === 'horaCarga') return Utilities.formatDate(v, TZ, 'h:mm a');
  return Utilities.formatDate(v, TZ, 'dd/MM/yyyy HH:mm');
}

// Crea DATOS si no existe y agrega las columnas nuevas a una hoja antigua
// (las líneas anteriores quedan en la carga "INICIAL").
function asegurarDatos_(ss) {
  let ws = ss.getSheetByName(SH_DATOS);
  if (!ws) {
    ws = ss.insertSheet(SH_DATOS);
    ws.getRange(1, 1, 1, FIELDS.length).setValues([FIELDS]).setFontWeight('bold');
    ws.setFrozenRows(1);
    formatoTexto_(ws, FIELDS);
    return ws;
  }
  const lastCol = Math.max(ws.getLastColumn(), 1);
  const headers = ws.getRange(1, 1, 1, lastCol).getValues()[0];
  const faltan = FIELDS.filter(function (f) { return headers.indexOf(f) === -1; });
  if (!faltan.length || headers[0] === '') {
    if (headers[0] === '') ws.getRange(1, 1, 1, FIELDS.length).setValues([FIELDS]).setFontWeight('bold');
    return ws;
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const actual = ws.getRange(1, 1, 1, ws.getLastColumn()).getValues()[0];
    const nuevas = FIELDS.filter(function (f) { return actual.indexOf(f) === -1; });
    if (!nuevas.length) return ws;
    const col0 = actual.length + 1;
    ws.getRange(1, col0, 1, nuevas.length).setValues([nuevas]).setFontWeight('bold');
    const lastRow = ws.getLastRow();
    if (lastRow >= 2) {
      const ahora = new Date();
      const fill = nuevas.map(function (f) {
        return f === 'cargaId' ? 'INICIAL' : f === 'fechaCarga' ? ahora : f === 'archivo' ? '(antes del historial)' : '';
      });
      ws.getRange(2, col0, lastRow - 1, nuevas.length).setValues(
        Array.from({ length: lastRow - 1 }, function () { return fill.slice(); }));
      registrarCarga_(ss, { cargaId: 'INICIAL', tipo: 'PEDIDOS', archivo: '(antes del historial)', nuevas: lastRow - 1, actualizadas: 0 });
    }
    return ws;
  } finally {
    lock.releaseLock();
  }
}

function formatoTexto_(ws, headers) {
  CAMPOS_TEXTO.forEach(function (f) {
    const i = headers.indexOf(f);
    if (i >= 0) ws.getRange(1, i + 1, ws.getMaxRows(), 1).setNumberFormat('@');
  });
}

function leerCatalogoHoja_(wsB) {
  const lastRow = wsB.getLastRow();
  if (lastRow < 2) return [];
  const headers = wsB.getRange(1, 1, 1, wsB.getLastColumn()).getValues()[0]
    .map(function (h) { return normalizeText_(h); });
  const colCodigo = headers.indexOf('codigo');
  const colM2CJ = headers.indexOf('m2 x cj');
  const colM2PE = headers.indexOf('m2 x pe');
  const colCjPE = headers.indexOf('cj x pe');
  if (colCodigo === -1) return [];
  const vals = wsB.getRange(2, 1, lastRow - 1, wsB.getLastColumn()).getValues();
  return vals
    .filter(function (r) { return String(r[colCodigo]).trim() !== ''; })
    .map(function (r) {
      const m2PorCaja = colM2CJ !== -1 ? Number(r[colM2CJ]) || 0 : 0;
      const m2PorPallet = colM2PE !== -1 ? Number(r[colM2PE]) || 0 : 0;
      const cjPe = colCjPE !== -1 ? Number(r[colCjPE]) || 0 : 0;
      return {
        codigo: normCodigo_(r[colCodigo]),
        m2PorCaja: m2PorCaja,
        m2PorPallet: m2PorPallet,
        // Mismo criterio que conversionBase_: el CJ x PE guardado o M2 x PE / M2 x CJ.
        cjPorPallet: cjPe || (m2PorCaja > 0 && m2PorPallet > 0 ? Math.round(m2PorPallet / m2PorCaja) : 0)
      };
    });
}

// ======================
// CARGAR ARCHIVO (filas ya parseadas en el navegador con SheetJS)
// ======================
// Ya NO borra la hoja: cada carga se suma al historial. Una línea que ya existe
// (mismo envío, orden, artículo, lote y localizador) se actualiza con los datos
// del archivo y conserva su etiqueta y confirmación; las demás se agregan.
function api_cargarFilas_(rows, clave, archivo) {
  verificarClave_(clave);
  if (!rows || !rows.length) throw new Error('El archivo no tiene líneas.');
  // Misma validación que api_validarPedidos: las líneas con error NO se guardan.
  const total = rows.length;
  rows = rows.filter(function (r) { return !errorFilaPedido_(r); });
  if (!rows.length) throw new Error('Ninguna de las ' + total + ' líneas es válida (revisa Nro. Envío, Artículo y Cantidad).');
  rows.forEach(function (r) { r.cantidadSolicitada = numero_(r.cantidadSolicitada); });
  const omitidas = total - rows.length;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const wsD = asegurarDatos_(ss);

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const headers = wsD.getRange(1, 1, 1, wsD.getLastColumn()).getValues()[0];
    const idx = indice_(headers);
    const lastRow = wsD.getLastRow();
    const existentes = lastRow >= 2 ? wsD.getRange(2, 1, lastRow - 1, headers.length).getValues() : [];

    // Clave de línea + n° de aparición (un reporte puede repetir la misma combinación).
    const porClave = {};
    const vistosExist = {};
    existentes.forEach(function (r, i) {
      const k = claveLinea_(function (f) { return r[idx[f]]; });
      vistosExist[k] = (vistosExist[k] || 0) + 1;
      porClave[k + '#' + vistosExist[k]] = i;
    });

    const cargaId = 'C' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd-HHmmss');
    const ahora = new Date();
    const vistosNuevo = {};
    const nuevas = [];
    let actualizadas = 0;

    rows.forEach(function (r, n) {
      const k = claveLinea_(function (f) { return r[f]; });
      vistosNuevo[k] = (vistosNuevo[k] || 0) + 1;
      const i = porClave[k + '#' + vistosNuevo[k]];
      if (i !== undefined) {
        const fila = existentes[i];
        let cambio = false;
        CAMPOS_ORIGEN.forEach(function (f) {
          if (idx[f] === undefined || r[f] === undefined || r[f] === null || r[f] === '') return;
          if (String(fila[idx[f]]) !== String(r[f])) { fila[idx[f]] = r[f]; cambio = true; }
        });
        if (cambio) { fila[idx.actualizadoEn] = ahora; actualizadas++; }
        return;
      }
      const fila = headers.map(function (f) {
        if (f === 'id') return Utilities.getUuid();
        if (f === 'lineaNum') return n + 1;
        if (f === 'selected') return false;
        if (f === 'cargaId') return cargaId;
        if (f === 'fechaCarga') return ahora;
        if (f === 'archivo') return String(archivo || '');
        if (CAMPOS_ORIGEN.indexOf(f) !== -1) return (r[f] !== undefined && r[f] !== null) ? r[f] : '';
        return '';
      });
      nuevas.push(fila);
    });

    formatoTexto_(wsD, headers);
    if (actualizadas) wsD.getRange(2, 1, existentes.length, headers.length).setValues(existentes);
    if (nuevas.length) wsD.getRange(lastRow + 1, 1, nuevas.length, headers.length).setValues(nuevas);

    const cruzadas = cruzarAndenesEnDatos_(ss);
    registrarCarga_(ss, { cargaId: cargaId, tipo: 'PEDIDOS', archivo: archivo, nuevas: nuevas.length, actualizadas: actualizadas });
    registrarHistorial_('CARGA_PEDIDOS', (archivo || '-') + ': ' + nuevas.length + ' nuevas, ' + actualizadas + ' actualizadas' + (omitidas ? ', ' + omitidas + ' omitidas por error' : '') + ', ' + cruzadas.sinCruce + ' líneas sin andén', cargaId);
    return { count: rows.length, nuevas: nuevas.length, actualizadasLineas: actualizadas, actualizadas: cruzadas.cruzadas, sinCruce: cruzadas.sinCruce, enviosSinCruce: cruzadas.enviosSinCruce.slice(0, 50), omitidas: omitidas, cargaId: cargaId };
  } finally {
    lock.releaseLock();
  }
}

function claveLinea_(get) {
  return ['nroEnvio', 'ordenVenta', 'articulo', 'lote', 'localizador']
    .map(function (f) { const v = get(f); return String(v === undefined || v === null ? '' : v).trim().toUpperCase(); })
    .join('|');
}

function indice_(headers) {
  const idx = {};
  headers.forEach(function (h, i) { idx[h] = i; });
  return idx;
}

// ======================
// CONTRASEÑA DE CARGA
// Se guarda solo el hash (SHA-256 con sal) en las Propiedades del script, nunca
// el texto. 5 intentos fallidos bloquean la carga 15 minutos.
// ======================
const CLAVE_MAX_INTENTOS = 5;
const CLAVE_BLOQUEO_SEG = 15 * 60;

function hashClave_(clave, sal) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, sal + '|' + clave, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function verificarClave_(clave) {
  aplicarClaveDesdeHoja_();
  const props = PropertiesService.getScriptProperties();
  const guardada = props.getProperty('CLAVE_CARGA');
  if (!guardada) throw new Error('Todavía no hay contraseña de carga. Créala primero con "Cambiar contraseña".');
  const cache = CacheService.getScriptCache();
  const fallos = Number(cache.get('CLAVE_FALLOS') || 0);
  if (fallos >= CLAVE_MAX_INTENTOS) throw new Error('Demasiados intentos fallidos. Espera 15 minutos e intenta de nuevo.');
  if (!segVerificarHash_(String(clave || ''), guardada)) {
    cache.put('CLAVE_FALLOS', String(fallos + 1), CLAVE_BLOQUEO_SEG);
    registrarHistorial_('CLAVE_INCORRECTA', 'Intento ' + (fallos + 1) + ' de ' + CLAVE_MAX_INTENTOS, '');
    throw new Error('Contraseña incorrecta.');
  }
  cache.remove('CLAVE_FALLOS');
  // Formato antiguo (sal:sha256) o iteraciones viejas: se re-cifra con PBKDF2
  if (segNecesitaRehash_(guardada)) props.setProperty('CLAVE_CARGA', segCrearHash_(String(clave)));
}

// Crea la contraseña (si aún no existe) o la cambia (pidiendo la actual).
function api_cambiarClave_(actual, nueva) {
  nueva = String(nueva || '');
  if (nueva.length < 10) throw new Error('La contraseña nueva debe tener al menos 10 caracteres.');
  const props = PropertiesService.getScriptProperties();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const existe = !!props.getProperty('CLAVE_CARGA');
    // La primera contraseña solo se crea desde la hoja TUTORIAL (la ve solo quien
    // tiene acceso al Spreadsheet), así nadie con el link de la app puede crearla.
    if (!existe) throw new Error('La primera contraseña se crea en el Spreadsheet: hoja TUTORIAL, celda amarilla B5.');
    verificarClave_(actual);
    props.setProperty('CLAVE_CARGA', segCrearHash_(nueva));
    registrarHistorial_(existe ? 'CLAVE_CARGA_CAMBIADA' : 'CLAVE_CARGA_CREADA', '', '');
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// ======================
// HOJA TUTORIAL (instructivo + celda para poner la contraseña)
// La contraseña escrita en TUTORIAL!B5 se guarda cifrada y la celda se borra
// sola (por onEdit al escribirla, o al siguiente uso de la app como respaldo).
// Así nunca queda en texto visible en la hoja.
// ======================
const SH_TUTORIAL = 'TUTORIAL';
const TUTORIAL_VERSION = '2026-10-29.1';
const CELDA_CLAVE = 'B5', CELDA_CLAVE_ESTADO = 'C5';

function onEdit(e) {
  try {
    // Edición a mano en la hoja base: la caché de conversiones se renueva
    if (e && e.range && e.range.getSheet().getName() === SH_BASE) baseCambio_();
    if (e && e.range && e.range.getSheet().getName() === SH_TUTORIAL && e.range.getA1Notation() === CELDA_CLAVE) {
      aplicarClaveDesdeHoja_();
    }
  } catch (err) {
    console.error(err);
  }
}

function aplicarClaveDesdeHoja_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ws = ss.getSheetByName(SH_TUTORIAL);
  if (!ws) return;
  const celda = ws.getRange(CELDA_CLAVE);
  const nueva = String(celda.getDisplayValue() || '').trim();
  if (!nueva) return;
  celda.clearContent(); // nunca dejar la contraseña escrita
  if (nueva.length < 10) {
    ws.getRange(CELDA_CLAVE_ESTADO).setValue('✗ No se guardó: mínimo 10 caracteres. Escríbela de nuevo.').setFontColor('#b91c1c');
    return;
  }
  const props = PropertiesService.getScriptProperties();
  const existia = !!props.getProperty('CLAVE_CARGA');
  props.setProperty('CLAVE_CARGA', segCrearHash_(nueva));
  CacheService.getScriptCache().remove('CLAVE_FALLOS');
  ws.getRange(CELDA_CLAVE_ESTADO)
    .setValue('✓ Contraseña guardada (cifrada) el ' + Utilities.formatDate(new Date(), TZ, 'dd/MM/yyyy HH:mm') + '. La celda se borró por seguridad.')
    .setFontColor('#047857');
  registrarHistorial_(existia ? 'CLAVE_CAMBIADA' : 'CLAVE_CREADA', 'Desde la hoja TUTORIAL', '');
}

function asegurarTutorial_(ss) {
  let ws = ss.getSheetByName(SH_TUTORIAL);
  if (ws && ws.getRange('F1').getValue() === TUTORIAL_VERSION) return;
  const nueva = !ws;
  if (!ws) ws = ss.insertSheet(SH_TUTORIAL, 0);
  // Respeta lo que haya en la celda de contraseña (se procesa aparte).
  const estado = ws.getRange(CELDA_CLAVE_ESTADO).getValue();
  ws.getRange(7, 1, Math.max(ws.getMaxRows() - 6, 1), 3).clearContent().setFontWeight('normal').setBackground(null);

  ws.getRange('A1').setValue('PACKING LIST BODEGA · TUTORIAL').setFontSize(16).setFontWeight('bold');
  ws.getRange('A2').setValue('Guía rápida de la app. Esta hoja la crea la app; no borres las demás hojas (DATOS, base, STOCK, CARGAS, HISTORIAL...).').setFontColor('#475569');
  ws.getRange('F1').setValue(TUTORIAL_VERSION).setFontColor('#ffffff');
  ws.getRange('A4').setValue('CONTRASEÑA DE CARGA').setFontWeight('bold').setFontSize(12);
  ws.getRange('A5').setValue('Escribe aquí la contraseña nueva →').setFontWeight('bold');
  ws.getRange(CELDA_CLAVE).setBackground('#fef08a').setBorder(true, true, true, true, null, null, '#a16207', SpreadsheetApp.BorderStyle.SOLID_MEDIUM).setNumberFormat('@');
  if (!estado) ws.getRange(CELDA_CLAVE_ESTADO).setValue(PropertiesService.getScriptProperties().getProperty('CLAVE_CARGA')
    ? 'Ya hay una contraseña guardada. Escribe una nueva en la celda amarilla para cambiarla.'
    : 'Todavía no hay contraseña: escribe una (mín. 6 caracteres) en la celda amarilla.').setFontColor('#475569');

  const T = [
    ['1. PARA QUÉ SIRVE', ''],
    ['', 'Arma los Packing List de despacho, imprime sus etiquetas en la impresora de bodega e imprime etiquetas de producto.'],
    ['', 'Todo queda guardado como historial: subir un archivo nuevo NO borra lo anterior.'],
    ['2. CONTRASEÑA', ''],
    ['', 'Se pide para subir archivos (pedidos, andenes, stock) y para agregar o editar conversiones de la hoja base.'],
    ['', 'Para crearla o cambiarla: escribe la nueva en la celda amarilla de arriba (B5) y presiona Enter. La celda se borra sola y queda guardada cifrada.'],
    ['', 'También se puede cambiar desde la app: pestaña "Subir archivo" → "Cambiar contraseña" (pide la actual).'],
    ['', 'Si alguien se equivoca 5 veces, la carga se bloquea 15 minutos. Los intentos fallidos quedan en la hoja HISTORIAL.'],
    ['3. SUBIR ARCHIVOS', ''],
    ['', 'Pestaña "Subir archivo": el Excel de Alistamiento (pedidos) y la hoja de Andenes. Elige el archivo y escribe la contraseña.'],
    ['', 'Si una línea ya existía (mismo envío, orden, artículo, lote y localizador) se actualiza y conserva su etiqueta y confirmación; las demás se agregan.'],
    ['', 'ANTES de guardar, la app valida todo el archivo y muestra: líneas válidas, errores con su n° de fila del Excel (esas NO se guardan) y avisos. Recién al confirmar pide la contraseña.'],
    ['', 'Errores en pedidos: falta Nro. Envío, falta Artículo o la cantidad no es un número. Errores en Andenes: falta el Nro. Envío.'],
    ['', 'El Cliente, el Andén y la Hora de Carga salen SOLO de la hoja de Andenes. Si un envío no está ahí, quedan EN BLANCO (en la tabla dice Sin andén) hasta que subas la hoja de Andenes con ese envío.'],
    ['4. DATOS Y CONFIRMACIÓN', ''],
    ['', 'Pestaña "Datos": arriba a la izquierda elige el período (Hoy, 7 días, 30 días, Todo) o una carga en particular.'],
    ['', 'Botón "Confirmar" en cada línea: corrige cantidad, cajas y pallets y elige la etiqueta en la lista (o "+ Nueva etiqueta"). Enter confirma.'],
    ['', 'La lista propone la última etiqueta usada en el mismo envío, para sumar varias líneas seguidas. Máximo 10 líneas por etiqueta física.'],
    ['', 'VARIAS LÍNEAS DE UNA VEZ: filtra (envío, Subinventario) y ordena por Localizador para recorrer la bodega; marca las casillas (o la de arriba para todas) y usa "✓ Confirmar y generar etiquetas". Se confirman con la cantidad solicitada (las ya confirmadas se respetan), se pone UNA etiqueta por envío y se abre la vista previa para imprimir.'],
    ['5. IMPRIMIR PACKING LIST', ''],
    ['', 'Selecciona las líneas → "Generar Etiquetas Zebra" → revisa la vista previa → "Imprimir en Zebra".'],
    ['', 'La etiqueta es de 10 x 7,5 cm: cabecera con envío, cliente, etiqueta y andén en grande; tabla con cuadrícula y totales.'],
    ['6. ETIQUETAS DE PRODUCTO', ''],
    ['', 'Pestaña "Etiquetas producto". Sube primero el archivo de stock (reemplaza el stock anterior; la carga queda en el historial).'],
    ['', 'Escribe o escanea el código y presiona Enter. Elige la ubicación/lote del stock y ajusta la CANTIDAD que va en la etiqueta (botones 1, 10 o Stock).'],
    ['', '"Copias" es cuántas etiquetas iguales se imprimen. Elige el tamaño: Grande (10 x 7,5 cm), Pequeña (5 x 2,2 cm) o Pallet (15 x 10 cm).'],
    ['', 'PALLET 15 x 10 cm: rollo de 10 cm de ancho x 15 cm de largo (sale girada). Lleva descripción, código, lote, M2, CJ, Reportado por, Operador, Fecha (en blanco para escribir a mano si no se llenan) y el QR "(02)código(10)lote" igual al de bodega. Al cambiar de rollo: Calibrar papel.'],
    ['', 'La conversión (M2 x CJ y CJ x Pallet) sale de la hoja base. Si un código no la tiene, usa "Agregar conversión" (pide contraseña).'],
    ['', 'PRODUCTO NUEVO que no aparece: sube el reporte "Ingresos de transferencias" con "Subir Ingresos de transferencias". Copia a la base el Nombre de artículo (código) y la Descripción de artículo de los códigos que faltan; los que ya existen no se tocan. Pide contraseña.'],
    ['7. IMPRESORA', ''],
    ['', 'La impresora de bodega es una Honeywell/Intermec PC43t en modo EPL (instalada en Windows como "ZDesigner ZD220-203dpi EPL").'],
    ['', 'Para que la app imprima, en el PC debe estar abierto ZebraPuente: C:\\Users\\arodriguez\\ZebraPuente\\Iniciar ZebraPuente.cmd (ventana negra; no cerrarla).'],
    ['', 'Al cambiar de rollo (10 x 7,5 ↔ 5 x 2,2 cm) usa "Calibrar papel" (menú lateral o pantalla de producto): la impresora avanza unas etiquetas y mide el papel.'],
    ['', 'Si no imprime: revisa que ZebraPuente esté abierto, que la impresora tenga papel y luz verde, y calibra el papel.'],
    ['8. IMPRIMIR DESDE CELULAR O TABLET', ''],
    ['', 'La app se puede abrir en el celular o la tablet con el mismo link. La impresora está conectada por USB al PC de bodega, así que desde otro equipo la etiqueta NO sale al momento: queda GUARDADA.'],
    ['', 'En el PC de la impresora (con ZebraPuente abierto) presiona "Imprimir trabajos guardados" (menú lateral o botón 🖨 arriba; el número amarillo indica cuántos hay). Elige cuáles imprimir o descártalos.'],
    ['', 'Desde el PC de la impresora se imprime directo, igual que siempre. Si ZebraPuente está cerrado, el trabajo también queda guardado. Los trabajos quedan en la hoja COLA_IMPRESION.'],
    ['9. HISTORIAL', ''],
    ['', 'Pestaña "Historial": todas las cargas de archivos y los movimientos (confirmaciones, cambios de etiqueta, impresiones, conversiones, contraseñas).'],
    ['', 'Las hojas CARGAS e HISTORIAL del Spreadsheet guardan lo mismo, con fecha y hora.']
  ];
  ws.getRange(7, 1, T.length, 2).setValues(T).setVerticalAlignment('top').setWrap(true);
  T.forEach(function (r, i) {
    if (r[0]) ws.getRange(7 + i, 1, 1, 2).setFontWeight('bold').setBackground('#e2e8f0');
  });
  ws.setColumnWidth(1, 230);
  ws.setColumnWidth(2, 720);
  ws.setColumnWidth(3, 520);
  if (nueva) ws.setFrozenRows(0);
  ws.getRange('F1').setValue(TUTORIAL_VERSION);
}

// ======================================================================
// COLA DE IMPRESIÓN (trabajos guardados)
// La impresora está conectada por USB al PC de bodega (sin internet propio).
// Desde un celular/tablet (o un PC sin impresora) el trabajo se GUARDA aquí;
// en el PC de la impresora el botón "Imprimir trabajos guardados" los manda a
// ZebraPuente y los marca como impresos. Estados: PENDIENTE, IMPRESO, ERROR, DESCARTADO.
// ======================================================================
const SH_COLA = 'COLA_IMPRESION';
const COLA_COLS = ['id', 'fecha', 'estado', 'tipo', 'descripcion', 'etiquetas', 'origen', 'datos', 'impresoEn', 'detalle'];
const COLA_MAX_CHARS = 40000;   // una celda admite 50.000 caracteres
const COLA_MAX_PENDIENTES = 300;

function hojaCola_(ss) {
  let ws = ss.getSheetByName(SH_COLA);
  if (!ws) {
    ws = ss.insertSheet(SH_COLA);
    ws.getRange(1, 1, 1, COLA_COLS.length).setValues([COLA_COLS]).setFontWeight('bold');
    ws.setFrozenRows(1);
    ws.getRange(1, 8, ws.getMaxRows(), 1).setNumberFormat('@'); // datos (EPL) como texto
  }
  return ws;
}

function leerCola_(ws) {
  if (ws.getLastRow() < 2) return [];
  return ws.getRange(2, 1, ws.getLastRow() - 1, COLA_COLS.length).getValues().map(function (r, i) {
    const o = { _fila: i + 2 };
    COLA_COLS.forEach(function (c, j) { o[c] = r[j]; });
    return o;
  });
}

function resumenTrabajo_(t) {
  return {
    id: String(t.id), fecha: textoCelda_(t.fecha, 'fecha'), estado: String(t.estado), tipo: String(t.tipo),
    descripcion: String(t.descripcion), etiquetas: Number(t.etiquetas) || 0, origen: String(t.origen),
    impresoEn: textoCelda_(t.impresoEn, 'fecha'), detalle: String(t.detalle || '')
  };
}

// bloques: lista de etiquetas EPL (una por elemento). Si no caben en una celda se
// guardan en varios trabajos ("parte 1/2"...). Devuelve { ids, pendientes }.
function api_encolarImpresion_(bloques, tipo, descripcion, origen) {
  bloques = (bloques || []).map(String).filter(function (b) { return b.trim(); });
  if (!bloques.length) throw new Error('No hay etiquetas para guardar.');
  if (bloques.some(function (b) { return b.length > COLA_MAX_CHARS; })) throw new Error('Una etiqueta es demasiado grande para guardarla.');
  tipo = ['PACKING', 'PRODUCTO', 'CALIBRAR', 'LIBRE'].indexOf(String(tipo)) !== -1 ? String(tipo) : 'OTRO';
  return conLock_(function () {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const ws = hojaCola_(ss);
    const pendientes = leerCola_(ws).filter(function (t) { return t.estado === 'PENDIENTE'; }).length;
    if (pendientes >= COLA_MAX_PENDIENTES) throw new Error('Hay ' + pendientes + ' trabajos pendientes. Imprime o descarta algunos desde el PC de la impresora.');

    // Arma partes de hasta COLA_MAX_CHARS sin cortar una etiqueta.
    const partes = [];
    let actual = [], largo = 0;
    bloques.forEach(function (b) {
      if (actual.length && largo + b.length > COLA_MAX_CHARS) { partes.push(actual); actual = []; largo = 0; }
      actual.push(b); largo += b.length;
    });
    if (actual.length) partes.push(actual);

    const ahora = new Date();
    const ids = [];
    const filas = partes.map(function (p, i) {
      const id = 'T' + Utilities.formatDate(ahora, TZ, 'yyMMddHHmmss') + '-' + Utilities.getUuid().substring(0, 4);
      ids.push(id);
      const desc = String(descripcion || '').substring(0, 300) + (partes.length > 1 ? ' (parte ' + (i + 1) + '/' + partes.length + ')' : '');
      return [id, ahora, 'PENDIENTE', tipo, desc, p.length, String(origen || '').substring(0, 80), p.join(''), '', ''];
    });
    ws.getRange(ws.getLastRow() + 1, 1, filas.length, COLA_COLS.length).setValues(filas);
    registrarHistorial_('COLA_GUARDADO', tipo + ' · ' + descripcion + ' · ' + bloques.length + ' etiqueta(s) · desde ' + (origen || '-'), ids.join(', '));
    return { ids: ids, pendientes: pendientes + filas.length };
  });
}

// Lista de trabajos (sin el EPL) para la ventana "Trabajos guardados".
function api_listarCola_(incluirHechos) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ws = ss.getSheetByName(SH_COLA);
  if (!ws) return { pendientes: [], recientes: [] };
  const todos = leerCola_(ws);
  const pendientes = todos.filter(function (t) { return t.estado === 'PENDIENTE'; }).map(resumenTrabajo_);
  const recientes = incluirHechos
    ? todos.filter(function (t) { return t.estado !== 'PENDIENTE'; }).slice(-30).reverse().map(resumenTrabajo_)
    : [];
  return { pendientes: pendientes, recientes: recientes };
}

function api_contarCola_() {
  const ws = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_COLA);
  if (!ws || ws.getLastRow() < 2) return 0;
  return ws.getRange(2, 3, ws.getLastRow() - 1, 1).getValues().filter(function (r) { return r[0] === 'PENDIENTE'; }).length;
}

// EPL de los trabajos pedidos (solo los que siguen PENDIENTES o con ERROR).
function api_datosCola_(ids) {
  const ws = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_COLA);
  if (!ws) return [];
  const pedidos = (ids || []).map(String);
  return leerCola_(ws)
    .filter(function (t) { return pedidos.indexOf(String(t.id)) !== -1 && (t.estado === 'PENDIENTE' || t.estado === 'ERROR'); })
    .map(function (t) { return { id: String(t.id), datos: String(t.datos), etiquetas: Number(t.etiquetas) || 0, descripcion: String(t.descripcion) }; });
}

// resultados: [{ id, ok, error }] tras mandarlos a la impresora desde el PC.
function api_marcarCola_(resultados, impresora) {
  return conLock_(function () {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const ws = hojaCola_(ss);
    const todos = leerCola_(ws);
    const ahora = new Date();
    let ok = 0, err = 0;
    (resultados || []).forEach(function (r) {
      const t = todos.find(function (x) { return String(x.id) === String(r.id); });
      if (!t) return;
      const estado = r.ok ? 'IMPRESO' : 'ERROR';
      ws.getRange(t._fila, 3).setValue(estado);
      ws.getRange(t._fila, 9).setValue(ahora);
      ws.getRange(t._fila, 10).setValue(r.ok ? 'Impreso en ' + (impresora || '-') : String(r.error || 'Error').substring(0, 300));
      if (r.ok) ok++; else err++;
    });
    registrarHistorial_('COLA_IMPRESO', ok + ' trabajo(s) impreso(s)' + (err ? ', ' + err + ' con error' : '') + ' en ' + (impresora || '-'), '');
    return { impresos: ok, errores: err, pendientes: api_contarCola_() };
  });
}

function api_descartarCola_(ids) {
  return conLock_(function () {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const ws = hojaCola_(ss);
    const pedidos = (ids || []).map(String);
    let n = 0;
    leerCola_(ws).forEach(function (t) {
      if (pedidos.indexOf(String(t.id)) === -1 || t.estado === 'IMPRESO') return;
      ws.getRange(t._fila, 3).setValue('DESCARTADO');
      ws.getRange(t._fila, 9).setValue(new Date());
      n++;
    });
    registrarHistorial_('COLA_DESCARTADO', n + ' trabajo(s) descartado(s)', pedidos.join(', '));
    return { descartados: n, pendientes: api_contarCola_() };
  });
}

// ======================
// HISTORIAL Y REGISTRO DE CARGAS
// ======================
function registrarCarga_(ss, c) {
  const ws = ss.getSheetByName(SH_CARGAS) || (function () {
    const w = ss.insertSheet(SH_CARGAS);
    w.getRange(1, 1, 1, 6).setValues([['cargaId', 'fecha', 'tipo', 'archivo', 'lineasNuevas', 'lineasActualizadas']]).setFontWeight('bold');
    w.setFrozenRows(1);
    return w;
  })();
  ws.appendRow([c.cargaId, new Date(), c.tipo, String(c.archivo || ''), c.nuevas || 0, c.actualizadas || 0]);
}

function listarCargas_(ss, max) {
  const ws = ss.getSheetByName(SH_CARGAS);
  if (!ws || ws.getLastRow() < 2) return [];
  const n = Math.min(max, ws.getLastRow() - 1);
  const vals = ws.getRange(ws.getLastRow() - n + 1, 1, n, 6).getValues();
  return vals.reverse()
    .filter(function (r) { return r[2] === 'PEDIDOS'; })
    .map(function (r) {
      return { cargaId: String(r[0]), fecha: textoCelda_(r[1], 'fecha'), archivo: String(r[3]), nuevas: r[4], actualizadas: r[5] };
    });
}

function registrarHistorial_(accion, detalle, ref) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let ws = ss.getSheetByName(SH_HISTORIAL);
    if (!ws) {
      ws = ss.insertSheet(SH_HISTORIAL);
      ws.getRange(1, 1, 1, 5).setValues([['fecha', 'accion', 'detalle', 'referencia', 'usuario']]).setFontWeight('bold');
      ws.setFrozenRows(1);
    } else if (!ws.getRange(1, 5).getValue()) {
      ws.getRange(1, 5).setValue('usuario').setFontWeight('bold'); // hojas anteriores a los usuarios
    }
    ws.appendRow([new Date(), accion, String(detalle || ''), String(ref || ''), USUARIO_ACTUAL_ || '']);
  } catch (e) {
    console.error('No se pudo registrar el historial: ' + e.message);
  }
}

function api_getHistorial_(max) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ws = ss.getSheetByName(SH_HISTORIAL);
  const cargas = listarCargasTodas_(ss, 100);
  if (!ws || ws.getLastRow() < 2) return { eventos: [], cargas: cargas };
  const n = Math.min(max || 300, ws.getLastRow() - 1);
  const vals = ws.getRange(ws.getLastRow() - n + 1, 1, n, 5).getValues().reverse();
  return {
    eventos: vals.map(function (r) { return { fecha: textoCelda_(r[0], 'fecha'), accion: String(r[1]), detalle: String(r[2]), ref: String(r[3]), usuario: String(r[4] || '') }; }),
    cargas: cargas
  };
}

function listarCargasTodas_(ss, max) {
  const ws = ss.getSheetByName(SH_CARGAS);
  if (!ws || ws.getLastRow() < 2) return [];
  const n = Math.min(max, ws.getLastRow() - 1);
  return ws.getRange(ws.getLastRow() - n + 1, 1, n, 6).getValues().reverse().map(function (r) {
    return { cargaId: String(r[0]), fecha: textoCelda_(r[1], 'fecha'), tipo: String(r[2]), archivo: String(r[3]), nuevas: r[4], actualizadas: r[5] };
  });
}

// ======================
// HOJA DE ANDENES (cruce por Nro. Envío: Cliente, Hora de Carga, Andén)
// ======================
// Ya NO borra la hoja: actualiza los envíos que ya estaban y agrega los nuevos,
// así se conservan los andenes de días anteriores.
function api_cargarAndenes_(rows, clave, archivo) {
  verificarClave_(clave);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // Las 4 primeras columnas no cambian de lugar (las usa el cruce); el resto es del reporte de despacho.
  const cols = ['envio', 'cliente', 'horaCarga', 'anden', 'actualizadoEn', 'fechaDespacho', 'orden', 'peso', 'pedido', 'tipoDespacho', 'corte', 'archivo'];
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    let wsA = ss.getSheetByName(SH_ANDENES);
    if (!wsA) wsA = ss.insertSheet(SH_ANDENES);
    wsA.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    wsA.getRange(1, 1, wsA.getMaxRows(), 3).setNumberFormat('@');
    wsA.getRange(1, 6, wsA.getMaxRows(), 2).setNumberFormat('@');   // fechaDespacho, orden
    wsA.getRange(1, 9, wsA.getMaxRows(), 4).setNumberFormat('@');   // pedido, tipoDespacho, corte, archivo

    const lastRow = wsA.getLastRow();
    const existentes = lastRow >= 2 ? wsA.getRange(2, 1, lastRow - 1, cols.length).getValues() : [];
    // Dónde está cada envío: en la hoja (existentes) o agregado en esta carga (nuevas).
    // Ojo: son dos listas distintas; un envío nuevo que se repite en el archivo (un envío
    // con varias órdenes) se actualiza dentro de "nuevas", no de "existentes".
    const pos = {};
    existentes.forEach(function (r, i) { pos[String(r[0]).trim()] = { lista: existentes, i: i }; });

    const ahora = new Date();
    const nuevas = [];
    const vistosEnArchivo = {};
    let actualizadosEnv = 0;
    const COL_ORDEN = cols.indexOf('orden'), COL_PEDIDO = cols.indexOf('pedido');
    const unir = function (a, b) {
      const l = String(a || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      String(b || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean)
        .forEach(function (s) { if (l.indexOf(s) === -1) l.push(s); });
      return l.join(', ');
    };
    (rows || []).forEach(function (r) {
      const envio = String(r.envio === undefined || r.envio === null ? '' : r.envio).trim();
      if (!envio) return;
      const v = function (k) { return r[k] === undefined || r[k] === null ? '' : r[k]; };
      const fila = [envio, v('cliente'), v('horaCarga'), v('anden'), ahora,
        v('fechaDespacho'), v('orden'), v('peso'), v('pedido'), v('tipoDespacho'), v('corte'), String(archivo || '')];
      const p = pos[envio];
      if (p && vistosEnArchivo[envio]) {
        // Mismo envío otra vez en este archivo (otra orden): se juntan órdenes y pedidos.
        fila[COL_ORDEN] = unir(p.lista[p.i][COL_ORDEN], fila[COL_ORDEN]);
        fila[COL_PEDIDO] = unir(p.lista[p.i][COL_PEDIDO], fila[COL_PEDIDO]);
        p.lista[p.i] = fila;
      } else if (p) {
        p.lista[p.i] = fila;          // envío que ya estaba en la hoja: se actualiza
        actualizadosEnv++;
      } else {
        pos[envio] = { lista: nuevas, i: nuevas.length };
        nuevas.push(fila);
      }
      vistosEnArchivo[envio] = true;
    });
    if (existentes.length) wsA.getRange(2, 1, existentes.length, cols.length).setValues(existentes);
    if (nuevas.length) wsA.getRange(lastRow + 1, 1, nuevas.length, cols.length).setValues(nuevas);

    const cruce = cruzarAndenesEnDatos_(ss);
    const cargaId = 'A' + Utilities.formatDate(ahora, TZ, 'yyyyMMdd-HHmmss');
    registrarCarga_(ss, { cargaId: cargaId, tipo: 'ANDENES', archivo: archivo, nuevas: nuevas.length, actualizadas: actualizadosEnv });
    registrarHistorial_('CARGA_ANDENES', (archivo || '-') + ': ' + nuevas.length + ' envíos nuevos, ' + actualizadosEnv + ' actualizados, ' + cruce.cruzadas + ' líneas cruzadas, ' + cruce.sinCruce + ' sin andén', cargaId);
    return { count: rows ? rows.length : 0, actualizadas: cruce.cruzadas, sinCruce: cruce.sinCruce, enviosSinCruce: cruce.enviosSinCruce.slice(0, 50) };
  } finally {
    lock.releaseLock();
  }
}

// ======================
// VALIDACIÓN PREVIA DE ARCHIVOS (no guarda nada)
// Se llama antes de pedir la contraseña: muestra qué se va a guardar, qué
// líneas tienen error (no se guardan) y qué datos van a quedar en blanco.
// ======================
function vacio_(v) { return v === undefined || v === null || String(v).trim() === ''; }

function numero_(v) {
  if (typeof v === 'number') return v;
  const s = String(v === undefined || v === null ? '' : v).trim().replace(/\s/g, '');
  if (!s) return NaN;
  // "1.234,5" o "35,53" -> 1234.5 / 35.53
  const n = s.indexOf(',') !== -1 ? s.replace(/\./g, '').replace(',', '.') : s;
  return Number(n);
}

// Motivo por el que una línea de pedidos NO se puede guardar ('' = válida).
function errorFilaPedido_(r) {
  const faltan = [];
  if (vacio_(r.nroEnvio)) faltan.push('Nro. Envío');
  if (vacio_(r.articulo)) faltan.push('Artículo');
  if (faltan.length) return 'Falta ' + faltan.join(' y ');
  const cant = numero_(r.cantidadSolicitada);
  if (isNaN(cant)) return 'Cantidad solicitada no es un número ("' + String(r.cantidadSolicitada) + '")';
  if (cant < 0) return 'Cantidad solicitada negativa (' + cant + ')';
  return '';
}

function api_validarPedidos_(rows) {
  rows = rows || [];
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const errores = [], avisos = [];
  const validas = [];
  rows.forEach(function (r, i) {
    const e = errorFilaPedido_(r);
    if (e) errores.push({ fila: r._fila || i + 1, motivo: e, detalle: [r.ordenVenta, r.articulo].filter(Boolean).join(' · ') });
    else validas.push(r);
  });

  // Nuevas vs. ya existentes (misma clave que usa la carga).
  const wsD = ss.getSheetByName(SH_DATOS);
  const existentes = {};
  if (wsD && wsD.getLastRow() >= 2) {
    const headers = wsD.getRange(1, 1, 1, wsD.getLastColumn()).getValues()[0];
    const idx = indice_(headers);
    const vistos = {};
    wsD.getRange(2, 1, wsD.getLastRow() - 1, headers.length).getValues().forEach(function (r) {
      const k = claveLinea_(function (f) { return r[idx[f]]; });
      vistos[k] = (vistos[k] || 0) + 1;
      existentes[k + '#' + vistos[k]] = true;
    });
  }
  const vistosNuevo = {};
  let nuevas = 0, actualizar = 0, repetidas = 0, sinLote = 0, cantCero = 0;
  const envios = {};
  validas.forEach(function (r) {
    const k = claveLinea_(function (f) { return r[f]; });
    vistosNuevo[k] = (vistosNuevo[k] || 0) + 1;
    if (vistosNuevo[k] > 1) repetidas++;
    if (existentes[k + '#' + vistosNuevo[k]]) actualizar++; else nuevas++;
    if (vacio_(r.lote)) sinLote++;
    if (numero_(r.cantidadSolicitada) === 0) cantCero++;
    envios[String(r.nroEnvio).trim()] = true;
  });

  const mapa = mapaAndenes_(ss);
  const listaEnvios = Object.keys(envios).sort();
  const sinAnden = listaEnvios.filter(function (e) { return !mapa[e]; });
  if (sinAnden.length) avisos.push(sinAnden.length + ' envío(s) no están en la hoja de Andenes: su Cliente, Andén y Hora de Carga quedarán EN BLANCO hasta que subas la hoja de Andenes con esos envíos.');
  if (actualizar) avisos.push(actualizar + ' línea(s) ya existían: se actualizan con los datos del archivo y conservan su etiqueta y confirmación.');
  if (repetidas) avisos.push(repetidas + ' línea(s) están repetidas dentro del archivo (mismo envío, orden, artículo, lote y localizador): se guardan como líneas separadas.');
  if (sinLote) avisos.push(sinLote + ' línea(s) sin lote.');
  if (cantCero) avisos.push(cantCero + ' línea(s) con cantidad solicitada 0.');

  return {
    total: rows.length, validas: validas.length, errores: errores.slice(0, 200), totalErrores: errores.length,
    avisos: avisos, nuevas: nuevas, actualizar: actualizar,
    envios: listaEnvios.length, enviosSinAnden: sinAnden.slice(0, 100)
  };
}

function api_validarAndenes_(rows) {
  rows = rows || [];
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const errores = [], avisos = [];
  const porEnvio = {};
  const contradicen = {};
  let sinAnden = 0, sinHora = 0, sinCliente = 0;
  const horaRara = [];
  const clave = function (r) { return [r.anden, r.horaCarga, r.cliente].map(function (v) { return String(v || '').trim().toUpperCase(); }).join('|'); };
  rows.forEach(function (r, i) {
    const envio = String(vacio_(r.envio) ? '' : r.envio).trim();
    if (!envio) { errores.push({ fila: r._fila || i + 1, motivo: 'Falta Nro. Envío', detalle: [r.cliente, r.anden].filter(Boolean).join(' · ') }); return; }
    // Un envío con varias órdenes viene en varias filas: es normal. Solo se avisa si se contradicen.
    if (porEnvio[envio] && clave(porEnvio[envio]) !== clave(r)) contradicen[envio] = true;
    porEnvio[envio] = r;
  });
  Object.keys(porEnvio).forEach(function (e) {
    const r = porEnvio[e];
    if (vacio_(r.anden)) sinAnden++;
    if (vacio_(r.horaCarga)) sinHora++;
    else if (!/^\d{1,2}:\d{2} (AM|PM)$/.test(String(r.horaCarga).trim())) horaRara.push(e + ' ("' + r.horaCarga + '")');
    if (vacio_(r.cliente)) sinCliente++;
  });
  const repetidos = Object.keys(contradicen);

  // Envíos de pedidos que siguen sin andén aunque se suba este archivo.
  const mapa = mapaAndenes_(ss);
  const wsD = ss.getSheetByName(SH_DATOS);
  const enPedidos = {};
  if (wsD && wsD.getLastRow() >= 2) {
    const headers = wsD.getRange(1, 1, 1, wsD.getLastColumn()).getValues()[0];
    const iE = headers.indexOf('nroEnvio');
    if (iE >= 0) wsD.getRange(2, iE + 1, wsD.getLastRow() - 1, 1).getValues().forEach(function (r) {
      const e = String(r[0]).trim(); if (e) enPedidos[e] = true;
    });
  }
  const archivo = Object.keys(porEnvio);
  const cruzan = archivo.filter(function (e) { return enPedidos[e]; }).length;
  const siguenSin = Object.keys(enPedidos).filter(function (e) { return !porEnvio[e] && !mapa[e]; }).sort();

  if (repetidos.length) avisos.push(repetidos.length + ' envío(s) aparecen en varias filas con Andén, Hora o Cliente DISTINTOS: se usa la última fila de cada uno (' + repetidos.slice(0, 10).join(', ') + (repetidos.length > 10 ? '...' : '') + ').');
  if (horaRara.length) avisos.push(horaRara.length + ' envío(s) con HORA PLANIFICADA no reconocida (se guarda tal cual): ' + horaRara.slice(0, 10).join(', ') + (horaRara.length > 10 ? '...' : '') + '.');
  if (sinAnden) avisos.push(sinAnden + ' envío(s) sin Andén en el archivo: quedarán con el andén EN BLANCO.');
  if (sinHora) avisos.push(sinHora + ' envío(s) sin Hora de Carga: quedará EN BLANCO.');
  if (sinCliente) avisos.push(sinCliente + ' envío(s) sin Cliente en el archivo: el cliente quedará EN BLANCO.');
  if (archivo.length - cruzan) avisos.push((archivo.length - cruzan) + ' envío(s) del archivo todavía no están en los pedidos: se guardan y se cruzarán cuando subas esos pedidos.');
  if (siguenSin.length) avisos.push(siguenSin.length + ' envío(s) de los pedidos siguen sin andén (no están en este archivo ni en cargas anteriores): quedarán EN BLANCO.');

  return {
    total: rows.length, validas: archivo.length, errores: errores.slice(0, 200), totalErrores: errores.length,
    avisos: avisos, envios: archivo.length, cruzan: cruzan, enviosSinAnden: siguenSin.slice(0, 100)
  };
}

// Cliente / Andén / Hora de Carga de un envío según la hoja de Andenes; en blanco si no está.
function datosAndenEnvio_(mapa, envio) {
  const m = mapa[String(envio === undefined || envio === null ? '' : envio).trim()];
  return m ? { cliente: m.cliente, anden: m.anden, horaCarga: m.horaCarga } : { cliente: '', anden: '', horaCarga: '' };
}

// Lee la hoja ANDENES como mapa { envío: { cliente, horaCarga, anden } }.
function mapaAndenes_(ss) {
  const wsA = ss.getSheetByName(SH_ANDENES);
  const mapa = {};
  if (!wsA || wsA.getLastRow() < 2) return mapa;
  wsA.getRange(2, 1, wsA.getLastRow() - 1, 4).getValues().forEach(function (r) { // envio, cliente, horaCarga, anden
    const envio = String(r[0]).trim();
    if (envio) mapa[envio] = { cliente: String(r[1] || '').trim(), horaCarga: String(textoCelda_(r[2], 'horaCarga') || '').trim(), anden: String(r[3] || '').trim() };
  });
  return mapa;
}

// Cruza ANDENES contra DATOS por Nro. Envío. El Andén y la Hora de Carga salen
// SOLO de la hoja de Andenes: si el envío no está ahí, quedan EN BLANCO (no se
// conserva lo que traía el archivo de pedidos ni un valor viejo). Lo mismo el
// Cliente: sale SOLO de Andenes; si el envío no está, queda en blanco.
// Se usa al subir cualquiera de los dos archivos, así el orden no importa.
// Devuelve { cruzadas, sinCruce, enviosSinCruce }.
function cruzarAndenesEnDatos_(ss) {
  const res = { cruzadas: 0, sinCruce: 0, enviosSinCruce: [] };
  const wsD = ss.getSheetByName(SH_DATOS);
  if (!wsD || wsD.getLastRow() < 2) return res;
  const mapa = mapaAndenes_(ss);

  const headers = wsD.getRange(1, 1, 1, wsD.getLastColumn()).getValues()[0];
  const idx = indice_(headers);
  if (idx.nroEnvio === undefined) return res;

  const rango = wsD.getRange(2, 1, wsD.getLastRow() - 1, headers.length);
  const valsD = rango.getValues();
  const sinCruce = {};
  let cambios = 0;
  const poner = function (row, campo, valor) {
    if (idx[campo] === undefined) return false;
    if (String(textoCelda_(row[idx[campo]], campo) || '').trim() === valor) return false;
    row[idx[campo]] = valor;
    return true;
  };

  valsD.forEach(function (row) {
    const envio = String(row[idx.nroEnvio]).trim();
    const match = envio ? mapa[envio] : null;
    let cambio = false;
    if (match) {
      cambio = poner(row, 'cliente', match.cliente) || cambio;
      cambio = poner(row, 'horaCarga', match.horaCarga) || cambio;
      cambio = poner(row, 'andenPicking', match.anden) || cambio;
      res.cruzadas++;
    } else {
      cambio = poner(row, 'cliente', '') || cambio;
      cambio = poner(row, 'horaCarga', '') || cambio;
      cambio = poner(row, 'andenPicking', '') || cambio;
      res.sinCruce++;
      sinCruce[envio || '(sin envío)'] = true;
    }
    if (cambio) cambios++;
  });

  if (cambios > 0) rango.setValues(valsD);
  res.enviosSinCruce = Object.keys(sinCruce).sort();
  return res;
}

// ======================
// CONFIRMAR LÍNEA
// ======================
function api_confirmarLinea_(payload) {
  return conLock_(function () {
    const res = confirmarLinea_(payload);
    registrarHistorial_('CONFIRMAR', 'Línea ' + res.lineaNum + ' (' + res.articulo + ') -> ' + res.etiqueta +
      ' · cant ' + payload.cantidadConfirmada + ', cj ' + payload.cajasConfirmados + ', plt ' + payload.palletsConfirmados, payload.id);
    return { etiqueta: res.etiqueta };
  });
}

// ======================
// CONFIRMAR VARIAS LÍNEAS DE UNA VEZ (y dejarlas listas para la etiqueta)
// - Cantidad / cajas / pallets: si la línea no estaba confirmada, se toma lo
//   solicitado del archivo; si ya estaba confirmada, se respeta lo que tenía.
// - Etiqueta: las líneas que ya tienen la conservan. Las que no, reciben UNA
//   etiqueta por envío: si entre las seleccionadas de ese envío ya hay una sola
//   etiqueta, se suman a esa; si no, se crea una nueva (ETQ-xxxxx).
//   Más de 10 líneas en una etiqueta se imprimen en varias páginas (PAG 1/2...).
// ======================
// opciones (opcional): { etiqueta: 'ETQ-00012' } -> todas las líneas sin etiqueta van a ESA
//   etiqueta existente (en vez de una nueva por envío); { mover: true } -> también se pasan
//   a esa etiqueta las seleccionadas que tenían otra.
function api_confirmarMasivo_(ids, opciones) {
  ids = (ids || []).map(String);
  if (!ids.length) throw new Error('Selecciona al menos una línea.');
  opciones = opciones || {};
  const destino = String(opciones.etiqueta || '').toUpperCase().replace(/[^A-Z0-9_\- ]/g, '').trim().substring(0, 12);
  const mover = !!opciones.mover && !!destino;
  return conLock_(function () {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const wsD = ss.getSheetByName(SH_DATOS);
    const headers = wsD.getRange(1, 1, 1, wsD.getLastColumn()).getValues()[0];
    const ix = indice_(headers);
    const rango = wsD.getRange(2, 1, wsD.getLastRow() - 1, headers.length);
    const vals = rango.getValues();

    let maxEtq = etqMaxHistorico_(); // no repetir números de líneas ya borradas
    vals.forEach(function (r) {
      const v = String(r[ix.nroEtiqueta] || '');
      if (v.indexOf('ETQ-') === 0) { const n = parseInt(v.substring(4), 10); if (n > maxEtq) maxEtq = n; }
    });

    const sel = vals.filter(function (r) { return ids.indexOf(String(r[ix.id])) !== -1; });
    if (!sel.length) throw new Error('No se encontraron las líneas (recarga los datos).');

    // TODAS las líneas seleccionadas sin etiqueta van a UNA misma etiqueta, aunque sean
    // de envíos distintos (pedido del usuario). Si entre las seleccionadas ya hay
    // exactamente una etiqueta, se suman a esa; si no, se crea un número nuevo.
    const grupo = { existentes: {}, nueva: '' };
    sel.forEach(function (r) {
      const etq = String(r[ix.nroEtiqueta] || '').trim();
      if (etq) grupo.existentes[etq] = true;
    });

    const ahora = new Date();
    const vacio = function (v) { return v === '' || v === null || v === undefined; };
    let confirmadas = 0, conEtiqueta = 0, nuevas = 0;
    const asignadas = {};
    sel.forEach(function (r) {
      if (vacio(r[ix.cantidadConfirmada])) { r[ix.cantidadConfirmada] = Number(r[ix.cantidadSolicitada]) || 0; confirmadas++; }
      if (vacio(r[ix.cajasConfirmados])) r[ix.cajasConfirmados] = Number(r[ix.cajas]) || 0;
      if (vacio(r[ix.palletsConfirmados])) r[ix.palletsConfirmados] = Number(r[ix.nroPallets]) || 0;
      const actual = String(r[ix.nroEtiqueta] || '').trim();
      if (destino && (!actual || (mover && actual !== destino))) {
        // Etiqueta existente elegida por el usuario.
        r[ix.nroEtiqueta] = destino;
        asignadas[destino] = (asignadas[destino] || 0) + 1;
      } else if (actual) {
        conEtiqueta++;
      } else {
        const g = grupo;
        if (!g.nueva) {
          const ex = Object.keys(g.existentes);
          if (ex.length === 1) g.nueva = ex[0];
          else { maxEtq++; g.nueva = 'ETQ-' + String(maxEtq).padStart(5, '0'); nuevas++; }
        }
        r[ix.nroEtiqueta] = g.nueva;
        asignadas[g.nueva] = (asignadas[g.nueva] || 0) + 1;
      }
      if (ix.selected !== undefined) r[ix.selected] = true;
      if (ix.actualizadoEn !== undefined) r[ix.actualizadoEn] = ahora;
    });
    rango.setValues(vals);

    const resumen = Object.keys(asignadas).map(function (e) { return e + ' (' + asignadas[e] + ')'; }).join(', ');
    registrarHistorial_('CONFIRMAR_MASIVO', sel.length + ' línea(s): ' + confirmadas + ' confirmadas con lo solicitado, ' +
      conEtiqueta + ' conservaron su etiqueta' + (destino ? ' · a etiqueta existente ' + destino + (mover ? ' (moviendo las que tenían otra)' : '') : '') +
      (resumen ? ' · etiquetas: ' + resumen : ''), destino);
    return { lineas: sel.length, confirmadas: confirmadas, conservadas: conEtiqueta, etiquetasNuevas: nuevas,
      asignadas: Object.keys(asignadas).map(function (e) { return { etiqueta: e, lineas: asignadas[e] }; }) };
  });
}

function conLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function confirmarLinea_(payload) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const wsD = ss.getSheetByName(SH_DATOS);
  const headers = wsD.getRange(1, 1, 1, wsD.getLastColumn()).getValues()[0];
  const lastRow = wsD.getLastRow();
  const idCol = headers.indexOf('id') + 1;
  const ids = wsD.getRange(2, idCol, lastRow - 1, 1).getValues().map(function (r) { return r[0]; });
  const rowIndex = ids.indexOf(payload.id);
  if (rowIndex === -1) throw new Error('Línea no encontrada (recarga los datos).');
  const sheetRow = rowIndex + 2;

  let etiqueta = String(payload.etiquetaValor || '').toUpperCase().replace(/[^A-Z0-9_\- ]/g, '').trim().substring(0, 12);
  if (payload.etiquetaAuto || (payload.modoEtiqueta === 'nueva' && !etiqueta)) {
    etiqueta = siguienteNumeroEtiqueta_(wsD, headers);
  }
  if (!etiqueta) throw new Error('Falta el número de etiqueta.');

  // Una sola lectura y una sola escritura de la fila (más rápido que celda por celda).
  const rango = wsD.getRange(sheetRow, 1, 1, headers.length);
  const fila = rango.getValues()[0];
  const set = function (field, value) { const i = headers.indexOf(field); if (i >= 0) fila[i] = value; };
  set('nroEtiqueta', etiqueta);
  set('cantidadConfirmada', Number(payload.cantidadConfirmada) || 0);
  set('palletsConfirmados', Number(payload.palletsConfirmados) || 0);
  set('cajasConfirmados', Number(payload.cajasConfirmados) || 0);
  set('selected', true);
  set('actualizadoEn', new Date());
  rango.setValues([fila]);

  return { etiqueta: etiqueta, lineaNum: fila[headers.indexOf('lineaNum')], articulo: fila[headers.indexOf('articulo')] };
}

function setCell_(ws, row, headers, field, value) {
  const col = headers.indexOf(field) + 1;
  if (col > 0) ws.getRange(row, col).setValue(value);
}

function siguienteNumeroEtiqueta_(wsD, headers) {
  const col = headers.indexOf('nroEtiqueta') + 1;
  const lastRow = wsD.getLastRow();
  let maxNum = etqMaxHistorico_(); // no repetir números de líneas ya borradas
  if (lastRow >= 2 && col > 0) {
    const vals = wsD.getRange(2, col, lastRow - 1, 1).getValues();
    vals.forEach(function (r) {
      const v = String(r[0]);
      if (v.indexOf('ETQ-') === 0) {
        const n = parseInt(v.substring(4), 10);
        if (!isNaN(n) && n > maxNum) maxNum = n;
      }
    });
  }
  return 'ETQ-' + String(maxNum + 1).padStart(5, '0');
}

// ======================
// EDITAR NÚMERO DE ETIQUETA
// payload: { nuevo, actual }  -> renombra TODAS las líneas que tengan la etiqueta "actual"
//       o { nuevo, ids }      -> asigna "nuevo" solo a esas líneas (ids de DATOS)
// ======================
function api_editarEtiqueta_(payload) {
  return conLock_(function () {
    const res = editarEtiqueta_(payload);
    registrarHistorial_('EDITAR_ETIQUETA', (payload.actual ? payload.actual + ' -> ' : '') + res.etiqueta + ' en ' + res.actualizadas + ' línea(s)', payload.actual || '');
    return res;
  });
}

function editarEtiqueta_(payload) {
  const nuevo = String(payload.nuevo || '').toUpperCase().replace(/[^A-Z0-9_\- ]/g, '').trim().substring(0, 12);
  if (!nuevo) throw new Error('Escribe un número de etiqueta (letras, números, guion; máx. 12 caracteres).');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const wsD = ss.getSheetByName(SH_DATOS);
  const lastRow = wsD.getLastRow();
  if (lastRow < 2) throw new Error('No hay datos.');
  const headers = wsD.getRange(1, 1, 1, wsD.getLastColumn()).getValues()[0];
  const idCol = headers.indexOf('id');
  const etqCol = headers.indexOf('nroEtiqueta');
  const selCol = headers.indexOf('selected');
  const actCol = headers.indexOf('actualizadoEn');
  if (idCol < 0 || etqCol < 0) throw new Error('Faltan columnas en DATOS.');

  const rango = wsD.getRange(2, 1, lastRow - 1, headers.length);
  const vals = rango.getValues();
  const actual = String(payload.actual || '').trim();
  const ids = payload.ids || [];
  const ahora = new Date();
  let n = 0;
  vals.forEach(function (r) {
    const coincide = actual
      ? String(r[etqCol]).trim() === actual
      : ids.indexOf(r[idCol]) !== -1;
    if (!coincide) return;
    r[etqCol] = nuevo;
    if (selCol >= 0) r[selCol] = true;
    if (actCol >= 0) r[actCol] = ahora;
    n++;
  });
  if (!n) throw new Error('No se encontraron líneas para actualizar (recarga los datos).');
  rango.setValues(vals);
  return { etiqueta: nuevo, actualizadas: n };
}

// ======================
// AUTO-ASIGNAR ETIQUETA (masivo, filas sin etiqueta aún)
// ======================
function api_autoAsignarEtiqueta_(ids) {
  return conLock_(function () {
    const res = autoAsignarEtiqueta_(ids);
    if (res.asignadas) registrarHistorial_('AUTO_ASIGNAR', res.asignadas + ' línea(s) con etiqueta nueva', '');
    return res;
  });
}

function autoAsignarEtiqueta_(ids) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const wsD = ss.getSheetByName(SH_DATOS);
  const headers = wsD.getRange(1, 1, 1, wsD.getLastColumn()).getValues()[0];
  const idCol = headers.indexOf('id') + 1;
  const etqCol = headers.indexOf('nroEtiqueta') + 1;
  const selCol = headers.indexOf('selected') + 1;
  const lastRow = wsD.getLastRow();
  const allIds = wsD.getRange(2, idCol, lastRow - 1, 1).getValues().map(function (r) { return r[0]; });

  let asignadas = 0;
  ids.forEach(function (id) {
    const idx = allIds.indexOf(id);
    if (idx === -1) return;
    const row = idx + 2;
    const actual = String(wsD.getRange(row, etqCol).getValue()).trim();
    if (actual === '') {
      wsD.getRange(row, etqCol).setValue(siguienteNumeroEtiqueta_(wsD, headers));
      wsD.getRange(row, selCol).setValue(true);
      asignadas++;
    }
  });
  return { asignadas: asignadas };
}

// ======================
// GENERAR ZPL (agrupado por etiqueta, bloques de 10 líneas)
// ======================
function api_generarZpl_(ids, formato) {
  return conLock_(function () {
    // Las líneas elegidas que aún no tienen etiqueta reciben una (1 por envío) antes
    // de imprimir: antes salía un Packing List con "ETIQUETA:" en blanco.
    const asignadas = asignarEtiquetaSeleccion_(ids);
    const res = generarZpl_(ids, formato, true);
    res.asignadas = asignadas;
    if (res.previewBlocks.length) {
      registrarHistorial_('IMPRIMIR', res.previewBlocks.length + ' etiqueta(s): ' +
        res.previewBlocks.map(function (b) { return b.etiquetaId + (b.totalPaginas > 1 ? ' ' + b.paginaActual + '/' + b.totalPaginas : ''); }).join(', '), '');
    }
    return res;
  });
}

// Asigna número a las líneas elegidas SIN etiqueta: TODAS reciben el mismo, aunque sean
// de envíos distintos (pedido: "todo debe generarse en la etiqueta"). Si entre las
// elegidas ya hay exactamente una etiqueta, se suman a esa; si no, número nuevo (sin
// repetir: incluye los de líneas ya limpiadas). Las que ya tenían etiqueta la conservan.
// No confirma cantidades (eso lo hace "Confirmar y generar"). Debe llamarse con el bloqueo.
// Devuelve { id: etiqueta } de las líneas que recibieron número.
function asignarEtiquetaSeleccion_(ids) {
  const ws = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_DATOS);
  const lastRow = ws.getLastRow();
  const out = {};
  if (lastRow < 2 || !ids || !ids.length) return out;
  const headers = ws.getRange(1, 1, 1, ws.getLastColumn()).getValues()[0];
  const iId = headers.indexOf('id'), iEtq = headers.indexOf('nroEtiqueta'), iEnv = headers.indexOf('nroEnvio'), iSel = headers.indexOf('selected');
  if (iId < 0 || iEtq < 0 || iEnv < 0) return out;
  const n = lastRow - 1;
  const colId = ws.getRange(2, iId + 1, n, 1).getValues();
  const colEtq = ws.getRange(2, iEtq + 1, n, 1).getValues();
  const colEnv = ws.getRange(2, iEnv + 1, n, 1).getValues();
  const pedidos = {};
  ids.forEach(function (id) { pedidos[String(id)] = true; });
  let max = etqMaxHistorico_();
  const sin = [], etqs = {}, envios = {};
  for (let k = 0; k < n; k++) {
    max = Math.max(max, numeroEtq_(colEtq[k][0]));
    if (!pedidos[String(colId[k][0])]) continue;
    const etq = String(colEtq[k][0]).trim();
    if (etq) etqs[etq] = true;
    else { sin.push(k); envios[String(colEnv[k][0]).trim()] = true; }
  }
  if (!sin.length) return out;
  const existentes = Object.keys(etqs);
  const etq = existentes.length === 1 ? existentes[0] : 'ETQ-' + String(max + 1).padStart(5, '0');
  sin.forEach(function (k) {
    ws.getRange(k + 2, iEtq + 1).setValue(etq);
    if (iSel >= 0) ws.getRange(k + 2, iSel + 1).setValue(true);
    out[String(colId[k][0])] = etq;
  });
  registrarHistorial_('ASIGNAR_ETIQUETA', 'Al generar etiquetas: ' + etq + ' a ' + sin.length + ' línea(s) de ' +
    Object.keys(envios).length + ' envío(s): ' + Object.keys(envios).join(', '), etq);
  return out;
}

// Completa a mano Cliente / Andén / Hora de un envío que no está (o está incompleto) en la
// hoja ANDENES. Se guarda ahí: la etiqueta, la tabla de Datos y las reimpresiones lo usan.
// Solo escribe lo que se llenó (no borra lo que ya había). Queda en el historial con el usuario.
const ANDENES_COLS = ['envio', 'cliente', 'horaCarga', 'anden', 'actualizadoEn', 'fechaDespacho', 'orden', 'peso', 'pedido', 'tipoDespacho', 'corte', 'archivo'];
function api_completarAnden_(envio, datos) {
  envio = String(envio || '').trim();
  if (!envio || envio.indexOf(' / ') !== -1) throw new Error('Envío no válido.');
  datos = datos || {};
  const cliente = String(datos.cliente || '').trim().substring(0, 60);
  const anden = String(datos.anden || '').trim().toUpperCase().substring(0, 16);
  const hora = String(datos.horaCarga || '').trim().substring(0, 12);
  if (!cliente && !anden && !hora) throw new Error('Escribe al menos el cliente, el andén o la hora.');
  return conLock_(function () {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let ws = ss.getSheetByName(SH_ANDENES);
    if (!ws) ws = ss.insertSheet(SH_ANDENES);
    if (ws.getLastRow() < 1) ws.getRange(1, 1, 1, ANDENES_COLS.length).setValues([ANDENES_COLS]).setFontWeight('bold');
    const n = Math.max(ws.getLastRow() - 1, 0);
    const envios = n ? ws.getRange(2, 1, n, 1).getValues() : [];
    let fila = -1;
    for (let k = 0; k < envios.length; k++) { if (String(envios[k][0]).trim() === envio) { fila = k + 2; break; } }
    if (fila === -1) {
      fila = ws.getLastRow() + 1;
      ws.getRange(fila, 1).setNumberFormat('@'); // el envío como texto (no como número)
      ws.getRange(fila, 1, 1, ANDENES_COLS.length).setValues([[envio, cliente, hora, anden, new Date(), '', '', '', '', '', '', 'MANUAL']]);
    } else {
      if (cliente) ws.getRange(fila, 2).setValue(cliente);
      if (hora) ws.getRange(fila, 3).setValue(hora);
      if (anden) ws.getRange(fila, 4).setValue(anden);
      ws.getRange(fila, 5).setValue(new Date());
    }
    registrarHistorial_('ANDEN_MANUAL', 'Envío ' + envio + ': ' + [cliente && 'cliente ' + cliente, anden && 'andén ' + anden, hora && 'hora ' + hora]
      .filter(Boolean).join(', '), envio);
    return datosAndenEnvio_(mapaAndenes_(ss), envio);
  });
}

// Solo vista previa (al cambiar de tamaño en la ventana): no marca impresión ni registra historial.
function api_vistaPackingList_(ids, formato) {
  return generarZpl_(ids, formato, false);
}

function generarZpl_(ids, formato, marcar) {
  formato = formatoPl_(formato);
  const F = PL_FORMATOS[formato];
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const wsD = ss.getSheetByName(SH_DATOS);
  const headers = wsD.getRange(1, 1, 1, wsD.getLastColumn()).getValues()[0];
  const lastRow = wsD.getLastRow();
  if (lastRow < 2) return { zplBlocks: [], previewBlocks: [] };

  const idx = {};
  headers.forEach(function (h, i) { idx[h] = i; });

  // Rendimiento: antes se leía la hoja DATOS completa (todas las filas y columnas)
  // para una etiqueta de pocas líneas. Ahora se leen solo las columnas id y
  // nroEtiqueta para ubicar las filas, y después SOLO esas filas.
  const nFilas = lastRow - 1;
  const colId = wsD.getRange(2, idx.id + 1, nFilas, 1).getValues();
  const colEtq = wsD.getRange(2, idx.nroEtiqueta + 1, nFilas, 1).getValues();
  const pedidos = {};
  (ids || []).forEach(function (id) { pedidos[String(id)] = true; });

  // Una etiqueta se imprime SIEMPRE completa: si se eligió una sola línea (confirmar,
  // confirmación masiva, imprimir desde Datos) entran también las demás líneas con
  // ese mismo Nº de etiqueta; si no, el Packing List sale incompleto y con totales errados.
  const etqElegidas = {};
  for (let i = 0; i < nFilas; i++) {
    const etq = String(colEtq[i][0]).trim();
    if (etq && pedidos[String(colId[i][0])]) etqElegidas[etq] = true;
  }
  const posiciones = [];
  for (let i = 0; i < nFilas; i++) {
    if (pedidos[String(colId[i][0])] || etqElegidas[String(colEtq[i][0]).trim()]) posiciones.push(i);
  }
  const seleccion = leerFilasDatos_(wsD, posiciones, headers.length);

  const grupos = {};
  const orden = [];
  seleccion.forEach(function (item) {
    const etq = String(item.row[idx.nroEtiqueta]).trim();
    if (!etq) return; // nunca un Packing List con "ETIQUETA:" en blanco
    if (!grupos[etq]) { grupos[etq] = []; orden.push(etq); }
    grupos[etq].push(item);
  });

  const fecha = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/Guayaquil', 'dd/MM/yyyy HH:mm');
  const mapaA = mapaAndenes_(ss);
  const zplBlocks = [];
  const eplBlocks = [];
  const previewBlocks = [];
  const filasImpresas = [];

  orden.forEach(function (etq) {
    const items = grupos[etq];

    // Primero se arma cada línea (sin efectos) para poder medir su alto: un código
    // o descripción largo pasa a una 2da línea y ocupa más espacio en la etiqueta.
    items.forEach(function (item) {
      const r = item.row;
      const cantConf = r[idx.cantidadConfirmada];
      const palletsConf = r[idx.palletsConfirmados];
      const cajasConf = r[idx.cajasConfirmados];
      item.linea = {
        articulo: String(r[idx.articulo]),
        descripcion: String(r[idx.descripcion]),
        lote: String(r[idx.lote]),
        cantidad: Number(cantConf !== '' ? cantConf : r[idx.cantidadSolicitada]) || 0,
        um: String(r[idx.um]),
        pallets: Number(palletsConf !== '' ? palletsConf : r[idx.nroPallets]) || 0,
        cajas: Number(cajasConf !== '' ? cajasConf : r[idx.cajas]) || 0
      };
    });

    // Reparte en páginas por altura disponible (máx. ZEBRA_LINES_PER_BLOCK filas).
    const paginas = paginarItems_(items, F);
    const totalPaginas = paginas.length;

    // Envíos de TODA la etiqueta (todas sus páginas), en el orden en que aparecen.
    const enviosEtq = [];
    items.forEach(function (it) {
      const e = String(it.row[idx.nroEnvio]).trim();
      if (enviosEtq.indexOf(e) === -1) enviosEtq.push(e);
    });
    const cab = cabeceraVariosEnvios_(enviosEtq, mapaA, formato);

    paginas.forEach(function (bloque, pagina) {
      // Con un solo envío, todo igual que antes; con varios, el encabezado los resume.
      const envio = cab.envio;
      // Cliente, Andén y Hora de Carga: directo de la hoja de Andenes (en blanco si el envío no está).
      const cliente = cab.cliente, anden = cab.anden, horaCarga = cab.horaCarga;

      const lineas = bloque.map(function (item) {
        if (marcar) filasImpresas.push(item.sheetRow);
        return item.linea;
      });

      const block = {
        etiquetaId: etq, envio: envio, cliente: cliente, anden: anden, horaCarga: horaCarga,
        // Cada envío con sus datos de Andenes (la vista previa pide a mano lo que falte)
        datosEnvios: enviosEtq.map(function (e) { const d = datosAndenEnvio_(mapaA, e); return { envio: e, cliente: d.cliente, anden: d.anden, horaCarga: d.horaCarga }; }),
        paginaActual: pagina + 1, totalPaginas: totalPaginas, fecha: fecha, lineas: lineas,
        formato: formato, alto: F.alto,
        // Celdas ya partidas en 1-2 líneas (mismo criterio que la Zebra) para imprimir por el driver de Windows.
        celdas: lineas.map(function (l) { return celdasLinea_(l, F); })
      };
      if (formato === 'grande') {
        // Un solo diseño (lista de elementos) para la impresora, la vista previa y el driver Windows.
        block.ops = layoutPackingGrande_(block);
        zplBlocks.push(opsAZpl_(block.ops, ZEBRA_ANCHO, F.alto));
        eplBlocks.push(opsAEpl_(block.ops, 1, ZEBRA_ANCHO, F.papel || F.alto));
      } else {
        zplBlocks.push(construirZpl_(block));
        eplBlocks.push(construirEpl_(block));
      }
      previewBlocks.push(block);
    });
  });

  if (marcar && filasImpresas.length) {
    escribirFechaTramos_(wsD, idx.fechaImpresion + 1, filasImpresas, new Date());
    registrarEtiquetasGeneradas_(previewBlocks.map(function (b) {
      return filaHistorialPacking_(b);
    }));
  }
  return { zplBlocks: zplBlocks, eplBlocks: eplBlocks, previewBlocks: previewBlocks, fechaImpresion: fecha };
}

// Encabezado de una etiqueta con líneas de uno o varios envíos.
//   1 envío  -> exactamente como siempre.
//   varios   -> ENVIO "6082975 / 6082977" si cabe en el tamaño; si no, "6082975 +2";
//               CLIENTE "PRIMERO (+N)" y ANDÉN "AND_21 +N" si hay más de uno distinto.
function cabeceraVariosEnvios_(envios, mapaA, formato) {
  const datos = envios.map(function (e) { return datosAndenEnvio_(mapaA, e); });
  const primero = datos[0] || { cliente: '', anden: '', horaCarga: '' };
  if (envios.length <= 1) {
    return { envio: envios[0] || '', cliente: primero.cliente, anden: primero.anden, horaCarga: primero.horaCarga };
  }
  const distintos = function (campo) {
    const vistos = [];
    datos.forEach(function (d) { const v = String(d[campo] || '').trim(); if (v && vistos.indexOf(v) === -1) vistos.push(v); });
    return vistos;
  };
  // Espacio disponible para el número de envío: 10x7,5 = 12 caracteres; 10x15 = 21
  const maxEnvio = formato === 'grande' ? 21 : 12;
  const juntos = envios.join(' / ');
  const envio = juntos.length <= maxEnvio ? juntos : envios[0] + ' +' + (envios.length - 1);
  const clientes = distintos('cliente'), andenes = distintos('anden'), horas = distintos('horaCarga');
  return {
    envio: envio,
    cliente: clientes.length > 1 ? clientes[0] + ' (+' + (clientes.length - 1) + ')' : (clientes[0] || ''),
    anden: andenes.length > 1 ? andenes[0] + ' +' + (andenes.length - 1) : (andenes[0] || ''),
    horaCarga: horas[0] || ''
  };
}

// Agrupa posiciones (0 = fila 2) en tramos y lee cada tramo de una vez. Dos filas
// separadas por pocas filas se leen juntas (una lectura grande es más rápida que
// muchas chicas). Devuelve [{ row, sheetRow }] en el orden de la hoja.
function leerFilasDatos_(ws, posiciones, nCols) {
  const out = [];
  if (!posiciones.length) return out;
  const HUECO_MAX = 30;
  let ini = posiciones[0], fin = posiciones[0];
  const tramos = [];
  for (let k = 1; k < posiciones.length; k++) {
    if (posiciones[k] - fin <= HUECO_MAX) fin = posiciones[k];
    else { tramos.push([ini, fin]); ini = fin = posiciones[k]; }
  }
  tramos.push([ini, fin]);
  const quiero = {};
  posiciones.forEach(function (p) { quiero[p] = true; });
  tramos.forEach(function (tr) {
    const vals = ws.getRange(tr[0] + 2, 1, tr[1] - tr[0] + 1, nCols).getValues();
    for (let i = 0; i < vals.length; i++) {
      const p = tr[0] + i;
      if (quiero[p]) out.push({ row: vals[i], sheetRow: p + 2 });
    }
  });
  return out;
}

// Escribe el mismo valor en una columna para varias filas, un bloque por tramo contiguo.
function escribirFechaTramos_(ws, col, filas, valor) {
  const orden = filas.slice().sort(function (a, b) { return a - b; })
    .filter(function (f, i, arr) { return i === 0 || f !== arr[i - 1]; });
  let ini = orden[0], prev = orden[0];
  const escribir = function (desde, hasta) {
    const vals = [];
    for (let f = desde; f <= hasta; f++) vals.push([valor]);
    ws.getRange(desde, col, vals.length, 1).setValues(vals);
  };
  for (let k = 1; k < orden.length; k++) {
    if (orden[k] === prev + 1) { prev = orden[k]; continue; }
    escribir(ini, prev);
    ini = prev = orden[k];
  }
  escribir(ini, prev);
}

// ======================
// HISTORIAL DE ETIQUETAS GENERADAS (una fila por etiqueta/página impresa)
// ======================
const SH_HIST_ETQ = 'HISTORIAL_ETIQUETAS';
const HIST_ETQ_COLS = ['fecha', 'usuario', 'tipo', 'etiqueta', 'pagina', 'envio', 'cliente', 'anden', 'formato',
  'lineas', 'cantidad', 'cajas', 'pallets', 'detalle'];

function filaHistorialPacking_(b) {
  let m2 = 0, un = 0, cj = 0, plt = 0;
  (b.lineas || []).forEach(function (l) {
    const um = String(l.um || '').trim().toUpperCase().replace('²', '2');
    if (um === 'M2') m2 += Number(l.cantidad) || 0; else un += Number(l.cantidad) || 0;
    cj += Number(l.cajas) || 0;
    plt += Number(l.pallets) || 0;
  });
  return [new Date(), USUARIO_ACTUAL_ || '', 'PACKING LIST', b.etiquetaId, b.paginaActual + '/' + b.totalPaginas,
    b.envio || '', b.cliente || '', b.anden || '', b.formato || '', (b.lineas || []).length,
    fmtNumCorto_(m2) + ' M2 · ' + fmtNumCorto_(un) + ' UN', cj, plt,
    (b.lineas || []).map(function (l) { return l.articulo; }).join(', ').substring(0, 500)];
}

function registrarEtiquetasGeneradas_(filas) {
  if (!filas || !filas.length) return;
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let ws = ss.getSheetByName(SH_HIST_ETQ);
    if (!ws) {
      ws = ss.insertSheet(SH_HIST_ETQ);
      ws.getRange(1, 1, 1, HIST_ETQ_COLS.length).setValues([HIST_ETQ_COLS]).setFontWeight('bold');
      ws.setFrozenRows(1);
    }
    // Una sola escritura para todas las etiquetas de la impresión
    ws.getRange(ws.getLastRow() + 1, 1, filas.length, HIST_ETQ_COLS.length).setValues(filas);
  } catch (e) {
    console.error('No se pudo registrar el historial de etiquetas: ' + e.message);
  }
}

// Últimas etiquetas generadas (las más recientes primero).
function api_getHistorialEtiquetas_(max) {
  const ws = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_HIST_ETQ);
  if (!ws || ws.getLastRow() < 2) return [];
  const n = Math.min(Math.max(Number(max) || 500, 1), 2000, ws.getLastRow() - 1);
  return ws.getRange(ws.getLastRow() - n + 1, 1, n, HIST_ETQ_COLS.length).getValues().reverse().map(function (r) {
    const o = {};
    HIST_ETQ_COLS.forEach(function (c, i) { o[c] = c === 'fecha' ? textoCelda_(r[i], 'fecha') : String(r[i] === null ? '' : r[i]); });
    return o;
  });
}

function sanitizeZpl_(texto) {
  return String(texto || '')
    .replace(/[\^~]/g, '')
    .replace(/[áàäâ]/gi, 'a').replace(/[éèëê]/gi, 'e').replace(/[íìïî]/gi, 'i')
    .replace(/[óòöô]/gi, 'o').replace(/[úùüû]/gi, 'u').replace(/[ñ]/gi, 'N')
    .trim();
}

// ----------------------------------------------------------------------
// Texto largo -> segunda línea. Cada fila de la tabla es de 1 línea; si el
// artículo, la descripción o el lote no caben en su columna, se parte en 2
// líneas y la fila crece ZEBRA_FILA_EXTRA puntos. Como la altura de la
// etiqueta es fija, el reparto en páginas se hace por altura disponible.
// ----------------------------------------------------------------------
const ZEBRA_FILA_H = 25;       // alto de una fila de 1 línea
const ZEBRA_FILA_EXTRA = 17;   // alto extra si la fila lleva una 2da línea
const ZEBRA_MAX_ART = 11;      // caracteres por línea en la columna Artículo
const ZEBRA_MAX_DESC = 20;     // ... Descripción (en EPL, fuente 2 = 12 puntos por carácter)
const ZEBRA_MAX_LOTE = 8;      // ... Lote
const ZEBRA_RESERVADO_V = 194; // espacio vertical que ocupan cabecera y totales (incluye EPL_TOP)

function partirTexto_(texto, maxChars, maxLineas) {
  let resto = sanitizeZpl_(texto);
  const lineas = [];
  while (resto.length > 0 && lineas.length < maxLineas) {
    if (resto.length <= maxChars) { lineas.push(resto); resto = ''; break; }
    const ultima = lineas.length === maxLineas - 1;
    let corte = -1;
    if (!ultima) {
      // 1) preferir cortar en un espacio; 2) si no hay (códigos), después de un guion o barra
      corte = resto.lastIndexOf(' ', maxChars);
      if (corte < Math.floor(maxChars / 2)) {
        const g = Math.max(resto.lastIndexOf('-', maxChars - 1), resto.lastIndexOf('/', maxChars - 1));
        corte = g >= Math.floor(maxChars / 2) ? g + 1 : -1;
      }
      // 3) sin separador útil: partir parejo (mitades) en vez de dejar 1-2 caracteres sueltos
      if (corte < 0) corte = resto.length <= 2 * maxChars ? Math.ceil(resto.length / 2) : maxChars;
    } else {
      corte = maxChars; // última línea permitida: se trunca lo que sobre
    }
    lineas.push(resto.substring(0, corte).trim());
    resto = resto.substring(corte).trim();
  }
  return lineas.length ? lineas : [''];
}

// Tamaños del Packing List. "chica" es el diseño original de 10 x 7,5 cm; "grande" es
// 10 cm de ancho x 15 cm de alto (mismo rollo que la etiqueta de pallet), con letra
// más grande y más filas por etiqueta.
const PL_FORMATOS = {
  chica: { nombre: '10 x 7,5 cm', alto: ZEBRA_ALTO, maxLineas: ZEBRA_LINES_PER_BLOCK, reservado: ZEBRA_RESERVADO_V,
    lim: { art: ZEBRA_MAX_ART, desc: ZEBRA_MAX_DESC, lote: ZEBRA_MAX_LOTE }, renglones: 2, filaH: ZEBRA_FILA_H, filaExtra: ZEBRA_FILA_EXTRA },
  // reservado: cabecera (hasta y=246) + pie (desde 1200-60-58) = alto útil de filas 836 puntos.
  // papel: largo REAL del rollo medido (15,4 cm = 1232 puntos) que se manda en Q; el diseño usa 1200.
  grande: { nombre: '10 x 15 cm', alto: 1200, papel: 1232, maxLineas: 25, reservado: 348,
    lim: { art: 12, desc: 15, lote: 7 }, renglones: 3, filaH: 30, filaExtra: 22 }
};
function formatoPl_(f) { return PL_FORMATOS[f] ? f : 'chica'; }

function celdasLinea_(l, F) {
  F = F || PL_FORMATOS.chica;
  return {
    art: partirTexto_(l.articulo, F.lim.art, 2),
    desc: partirTexto_(l.descripcion, F.lim.desc, F.renglones),
    lote: partirTexto_(l.lote, F.lim.lote, 2)
  };
}

function alturaLinea_(l, F) {
  F = F || PL_FORMATOS.chica;
  const c = celdasLinea_(l, F);
  const n = Math.max(c.art.length, c.desc.length, c.lote.length);
  return F.filaH + (n - 1) * F.filaExtra;
}

// items: [{ linea: {...}, ... }] -> [[item, item, ...], ...] (una lista por etiqueta física)
function paginarItems_(items, F) {
  F = F || PL_FORMATOS.chica;
  const alturaMax = F.alto - 2 * ZEBRA_MARGEN - F.reservado;
  const paginas = [];
  let actual = [], usado = 0;
  items.forEach(function (item) {
    const h = alturaLinea_(item.linea, F);
    if (actual.length && (actual.length >= F.maxLineas || usado + h > alturaMax)) {
      paginas.push(actual); actual = []; usado = 0;
    }
    actual.push(item); usado += h;
  });
  if (actual.length) paginas.push(actual);
  return paginas.length ? paginas : [[]];
}

// Totales por unidad de medida: los M2 y las UN no se pueden sumar entre sí.
// Solo se suman las líneas cuya UM es M2 o UN.
function totalesPorUm_(lineas) {
  let m2 = 0, un = 0;
  lineas.forEach(function (l) {
    const um = String(l.um || '').trim().toUpperCase().replace('²', '2');
    if (um === 'M2') m2 += l.cantidad;
    else if (um === 'UN') un += l.cantidad;
  });
  return { m2: m2, un: un };
}

function fmtUn_(n) { return Number.isInteger(n) ? String(n) : n.toFixed(2); }

function construirZpl_(block) {
  const cliente = sanitizeZpl_(block.cliente).substring(0, 34);
  const envio = sanitizeZpl_(block.envio);
  const etq = sanitizeZpl_(block.etiquetaId);
  const pag = block.paginaActual + '/' + block.totalPaginas;
  const fecha = sanitizeZpl_(block.fecha);
  const anden = sanitizeZpl_(block.anden || '').substring(0, 16);
  const horaCarga = sanitizeZpl_(block.horaCarga || '').substring(0, 10);

  let totalPlts = 0, totalCajas = 0;
  block.lineas.forEach(function (l) { totalPlts += l.pallets; totalCajas += l.cajas; });
  const tot = totalesPorUm_(block.lineas);

  // El diseño original tenía el borde a 8 puntos del filo de la etiqueta. Se
  // desplaza todo (dx, dy) para que el borde quede a ZEBRA_MARGEN, y los
  // elementos de ancho completo se acortan para no pasar del margen derecho.
  const M = ZEBRA_MARGEN;
  const PAD_X = 6; // aire extra entre el borde del recuadro y el texto
  const dx = M - 8 + PAD_X, dy = M - 8;
  const X = function (n) { return n + dx; };
  const Y = function (n) { return n + dy; };
  const B = ZEBRA_ALTO - M;                       // borde inferior del recuadro
  const bordeW = ZEBRA_ANCHO - 2 * M;
  const bordeH = ZEBRA_ALTO - 2 * M;
  const sepX = M + 2;
  const sepW = ZEBRA_ANCHO - 2 * sepX;
  const fechaX = ZEBRA_ANCHO - M - 160;
  // Número de etiqueta en grande (reemplaza al código de barras), alineado a la derecha.
  const etqX = ZEBRA_ANCHO - M - 10 - etq.length * 19;

  // Tabla: filas de 1 línea, o de 2 si algún campo es largo.
  const linesZpl = [];
  let y = M + 130;
  block.lineas.slice(0, ZEBRA_LINES_PER_BLOCK).forEach(function (l) {
    const c = celdasLinea_(l);
    const cant = l.cantidad.toFixed(2);
    const um = sanitizeZpl_(l.um).substring(0, 4);
    linesZpl.push(
      '^FO' + X(16) + ',' + y + '^A0N,18,18^FD' + c.art[0] + '^FS',
      '^FO' + X(145) + ',' + y + '^A0N,16,16^FD' + c.desc[0] + '^FS',
      '^FO' + X(395) + ',' + y + '^A0N,16,16^FD' + c.lote[0] + '^FS',
      '^FO' + X(485) + ',' + y + '^A0N,18,18^FD' + cant + '^FS',
      '^FO' + X(580) + ',' + y + '^A0N,16,16^FD' + um + '^FS',
      '^FO' + X(628) + ',' + y + '^A0N,18,18^FD' + l.pallets + '^FS',
      '^FO' + X(690) + ',' + y + '^A0N,18,18^FD' + l.cajas + '^FS'
    );
    if (c.art[1]) linesZpl.push('^FO' + X(16) + ',' + (y + 19) + '^A0N,15,15^FD' + c.art[1] + '^FS');
    if (c.desc[1]) linesZpl.push('^FO' + X(145) + ',' + (y + 19) + '^A0N,15,15^FD' + c.desc[1] + '^FS');
    if (c.lote[1]) linesZpl.push('^FO' + X(395) + ',' + (y + 19) + '^A0N,15,15^FD' + c.lote[1] + '^FS');
    y += alturaLinea_(l);
  });

  return [
    '^XA', '^PW' + ZEBRA_ANCHO, '^LL' + ZEBRA_ALTO, '^LH0,0',
    '^FO' + M + ',' + M + '^GB' + bordeW + ',' + bordeH + ',2^FS',
    '^FO' + X(14) + ',' + Y(14) + '^A0N,22,22^FDPACKING LIST DESPACHO^FS',
    '^FO' + fechaX + ',' + Y(16) + '^A0N,17,17^FD' + fecha + '^FS',
    '^FO' + sepX + ',' + Y(38) + '^GB' + sepW + ',1,1^FS',
    '^FO' + X(16) + ',' + Y(44) + '^A0N,18,18^FDENVIO: ' + envio + '^FS',
    '^FO' + X(200) + ',' + Y(44) + '^A0N,18,18^FDPAG: ' + pag + '^FS',
    '^FO' + X(16) + ',' + Y(66) + '^A0N,18,18^FDCLIENTE: ' + cliente + '^FS',
    '^FO' + X(16) + ',' + Y(88) + '^A0N,16,16^FDANDEN: ' + anden + '   HORA CARGA: ' + horaCarga + '^FS',
    '^FO' + etqX + ',' + Y(42) + '^A0N,16,16^FDETIQUETA^FS',
    '^FO' + etqX + ',' + Y(60) + '^A0N,32,32^FD' + etq + '^FS',
    '^FO' + sepX + ',' + Y(105) + '^GB' + sepW + ',2,2^FS',
    '^FO' + sepX + ',' + Y(109) + '^GB' + sepW + ',24,24^FS',
    '^FO' + X(16) + ',' + Y(113) + '^A0N,17,17^FR^FDARTICULO^FS',
    '^FO' + X(145) + ',' + Y(113) + '^A0N,17,17^FR^FDDESCRIPCION^FS',
    '^FO' + X(395) + ',' + Y(113) + '^A0N,17,17^FR^FDLOTE^FS',
    '^FO' + X(485) + ',' + Y(113) + '^A0N,17,17^FR^FDCANT (M2)^FS',
    '^FO' + X(580) + ',' + Y(113) + '^A0N,17,17^FR^FDUM^FS',
    '^FO' + X(628) + ',' + Y(113) + '^A0N,17,17^FR^FDPLT^FS',
    '^FO' + X(690) + ',' + Y(113) + '^A0N,17,17^FR^FDCJ^FS',
    linesZpl.join('\n'),
    '^FO' + sepX + ',' + (B - 46) + '^GB' + sepW + ',2,2^FS',
    '^FO' + X(16) + ',' + (B - 38) + '^A0N,22,22^FDTOTAL M2: ' + tot.m2.toFixed(2) + '    TOTAL UN: ' + fmtUn_(tot.un) + '^FS',
    '^FO' + X(628) + ',' + (B - 38) + '^A0N,22,22^FD' + totalPlts + '^FS',
    '^FO' + X(690) + ',' + (B - 38) + '^A0N,22,22^FD' + totalCajas + '^FS',
    '^XZ'
  ].join('\n');
}

// ----------------------------------------------------------------------
// MISMA ETIQUETA EN EPL2. La impresora de bodega es una Honeywell/Intermec
// PC43t en modo ESim (emulación EPL): ignora el ZPL, solo entiende EPL.
// EPL no tiene fuentes escalables; se usan las fuentes fijas de 203 dpi
// (ancho por carácter, con espacio): 1 = 10, 2 = 12, 3 = 14, 4 = 16 puntos.
// ----------------------------------------------------------------------
const EPL_PASO = { 1: 10, 2: 12, 3: 14, 4: 16 };
const EPL_ALTO = { 1: 12, 2: 16, 3: 20, 4: 24 };
// La PC43t no imprime los primeros ~2 mm de arriba: el contenido baja 16 puntos.
const EPL_TOP = 16;
// Columnas de la tabla en EPL (x de diseño, sin el desplazamiento del margen),
// calculadas para la fuente 2: art 11, desc 20, lote 8 caracteres.
const EPL_COL = { art: 16, desc: 158, lote: 408, cant: 514, um: 616, plt: 662, cj: 710 };

function eplTexto_(s) {
  return sanitizeZpl_(s === undefined || s === null ? '' : String(s)).replace(/\\/g, '/').replace(/"/g, "'");
}

function construirEpl_(block) {
  const M = ZEBRA_MARGEN, PAD_X = 6;
  const dx = M - 8 + PAD_X, dy = M - 8;
  const X = function (n) { return n + dx; };
  const Y = function (n) { return n + dy + EPL_TOP; };
  const B = ZEBRA_ALTO - M;
  const der = ZEBRA_ANCHO - M - 10; // límite derecho del texto
  const C = EPL_COL;
  const sepX = M + 2, sepW = ZEBRA_ANCHO - 2 * sepX;
  const out = [];
  // A x,y,rotación,fuente,mult. horizontal,mult. vertical,N|R,"texto"
  const A = function (x, y, f, txt, rev, mh, mv) {
    const s = eplTexto_(txt);
    if (!s) return; // dato en blanco: no se manda un texto vacío a la impresora
    out.push('A' + x + ',' + y + ',0,' + f + ',' + (mh || 1) + ',' + (mv || 1) + ',' + (rev ? 'R' : 'N') + ',"' + s + '"');
  };
  const LO = function (x, y, w, h) { out.push('LO' + x + ',' + y + ',' + w + ',' + h); };
  const cabe = function (txt, x, f) { return String(txt).substring(0, Math.max(0, Math.floor((der - x) / EPL_PASO[f]))); };

  let totalPlts = 0, totalCajas = 0;
  block.lineas.forEach(function (l) { totalPlts += l.pallets; totalCajas += l.cajas; });
  const tot = totalesPorUm_(block.lineas);

  const etq = eplTexto_(block.etiquetaId);
  // El ANDÉN va en grande arriba a la derecha (fuente 3 al doble; si es muy largo,
  // solo al doble de alto para que no tape al cliente). El Nº de etiqueta y la hora
  // de carga van en la línea de la izquierda. Igual que la vista previa y el driver Windows.
  const anden = eplTexto_(block.anden || '').substring(0, 16);
  const andenMh = anden.length * EPL_PASO[3] * 2 <= 300 ? 2 : 1;
  const etqX = der - anden.length * EPL_PASO[3] * andenMh;
  const fecha = eplTexto_(block.fecha);

  // Etiqueta de 10 x 7.5 cm = 800 x 600 puntos; gap de 3 mm entre etiquetas.
  out.push('', 'N', 'q' + ZEBRA_ANCHO, 'Q' + ZEBRA_ALTO + ',24');
  out.push('X' + M + ',' + M + ',2,' + (ZEBRA_ANCHO - M) + ',' + B);
  A(X(14), Y(12), 4, 'PACKING LIST DESPACHO');
  A(der - fecha.length * EPL_PASO[1], Y(16), 1, fecha);
  LO(sepX, Y(38), sepW, 1);
  A(X(16), Y(44), 3, 'ENVIO: ' + block.envio);
  A(X(300), Y(44), 3, 'PAG: ' + block.paginaActual + '/' + block.totalPaginas);
  const cliente = 'CLIENTE: ' + eplTexto_(block.cliente);
  A(X(16), Y(66), 2, cliente.substring(0, Math.floor((etqX - 10 - X(16)) / EPL_PASO[2])));
  A(X(16), Y(88), 2, ('ETIQUETA: ' + etq + '   HORA CARGA: ' + eplTexto_(block.horaCarga || ''))
    .substring(0, Math.floor((etqX - 10 - X(16)) / EPL_PASO[2])));
  A(der - 5 * EPL_PASO[1], Y(44), 1, 'ANDEN');
  A(etqX, Y(58), 3, anden, false, andenMh, 2);

  // Barra negra de encabezado: textos en reverso (blanco sobre negro).
  LO(sepX, Y(105), sepW, 2);
  LO(sepX, Y(109), sepW, 24);
  [[C.art, 'ARTICULO'], [C.desc, 'DESCRIPCION'], [C.lote, 'LOTE'], [C.cant, 'CANT (M2)'], [C.um, 'UM'], [C.plt, 'PLT'], [C.cj, 'CJ']]
    .forEach(function (h) { A(X(h[0]), Y(115), 1, h[1], true); });

  let y = M + 132 + EPL_TOP;
  const tablaTop = Y(133); // borde inferior de la barra negra
  const lineasFila = [];
  block.lineas.slice(0, ZEBRA_LINES_PER_BLOCK).forEach(function (l) {
    const c = celdasLinea_(l);
    A(X(C.art), y, 2, c.art[0]);
    A(X(C.desc), y, 2, c.desc[0]);
    A(X(C.lote), y, 2, c.lote[0]);
    A(X(C.cant), y, 2, l.cantidad.toFixed(2));
    A(X(C.um), y, 2, sanitizeZpl_(l.um).substring(0, 3));
    A(X(C.plt), y, 2, l.pallets);
    A(X(C.cj), y, 2, l.cajas);
    if (c.art[1]) A(X(C.art), y + 19, 2, c.art[1]);
    if (c.desc[1]) A(X(C.desc), y + 19, 2, c.desc[1]);
    if (c.lote[1]) A(X(C.lote), y + 19, 2, c.lote[1]);
    y += alturaLinea_(l);
    lineasFila.push(y - 4); // línea bajo la fila, 4 puntos antes de la siguiente
  });

  // Cuadrícula: una línea bajo cada fila, separadores entre columnas y bordes laterales.
  if (lineasFila.length) {
    const tablaFin = lineasFila[lineasFila.length - 1] + 2;
    lineasFila.forEach(function (ly) { LO(sepX, ly, sepW, 2); });
    LO(sepX, tablaTop, 2, tablaFin - tablaTop);
    LO(sepX + sepW - 2, tablaTop, 2, tablaFin - tablaTop);
    [C.desc, C.lote, C.cant, C.um, C.plt, C.cj].forEach(function (cx) {
      LO(X(cx) - 5, tablaTop, 2, tablaFin - tablaTop);
    });
  }

  LO(sepX, B - 46, sepW, 2);
  A(X(16), B - 38, 3, 'TOTAL M2: ' + tot.m2.toFixed(2) + '    TOTAL UN: ' + fmtUn_(tot.un));
  A(X(C.plt), B - 38, 3, totalPlts);
  A(X(C.cj), B - 38, 3, totalCajas);
  out.push('P1', '');
  return out.join('\r\n');
}

// ----------------------------------------------------------------------
// PACKING LIST 10 x 15 cm (800 x 1200 puntos, vertical). Mismo contenido que la
// de 10 x 7,5 pero con letra más grande: título y envío al doble de alto, ANDÉN
// gigante, tabla en fuente 3 (14 x 20) y hasta 25 filas por etiqueta.
// Devuelve elementos { t: 'A'|'LO'|'X' } (ver opsAEpl_).
// ----------------------------------------------------------------------
const PLG_COL = { art: 16, desc: 200, lote: 416, cant: 524, um: 630, plt: 680, cj: 728 };
const PLG_PIE = 60; // distancia del borde inferior del recuadro al filo de la etiqueta

function layoutPackingGrande_(block) {
  const W = ZEBRA_ANCHO, H = PL_FORMATOS.grande.alto, M = ZEBRA_MARGEN;
  const X = function (n) { return n + 6; };
  const Y = function (n) { return n + EPL_TOP; };
  // La PC43t pierde ~5 mm al final de la etiqueta de 15 cm (los totales salían cortados):
  // el borde inferior va a 60 puntos (7,5 mm) del filo.
  const B = H - PLG_PIE, der = W - M - 10, sepX = M + 2, sepW = W - 2 * sepX;
  const C = PLG_COL, F = PL_FORMATOS.grande;
  const ops = [{ t: 'X', x: M, y: M + EPL_TOP, w: 2, x2: W - M, y2: B }];
  const A = function (x, y, f, txt, o) {
    o = o || {};
    const s = eplTexto_(txt);
    if (s) ops.push({ t: 'A', x: x, y: y, f: f, mh: o.mh || 1, mv: o.mv || 1, s: s, rev: !!o.rev, negrita: !!o.negrita });
  };
  const LO = function (x, y, w, h) { ops.push({ t: 'LO', x: x, y: y, w: w, h: h }); };
  const ancho = function (s, f, mh) { return eplTexto_(s).length * EPL_PASO[f] * (mh || 1); };

  let totalPlts = 0, totalCajas = 0;
  block.lineas.forEach(function (l) { totalPlts += l.pallets; totalCajas += l.cajas; });
  const tot = totalesPorUm_(block.lineas);

  // Cabecera
  A(X(14), Y(14), 4, 'PACKING LIST DESPACHO', { mv: 2, negrita: true });
  const fecha = eplTexto_(block.fecha);
  A(der - ancho(fecha, 2), Y(14), 2, fecha);
  const pag = 'PAG: ' + block.paginaActual + '/' + block.totalPaginas;
  LO(der - ancho(pag, 3) - 8, Y(36), ancho(pag, 3) + 8, 26);
  A(der - ancho(pag, 3) - 4, Y(39), 3, pag, { rev: true });
  LO(sepX, Y(68), sepW, 2);

  // ANDÉN gigante a la derecha (más angosto si el nombre es largo).
  const anden = eplTexto_(block.anden || '').substring(0, 16);
  const andenMh = [3, 2, 1].filter(function (m) { return ancho(anden, 4, m) <= 400; })[0] || 1;
  const andenX = der - ancho(anden, 4, andenMh);
  A(der - ancho('ANDEN', 2), Y(78), 2, 'ANDEN');
  A(andenX, Y(98), 4, anden, { mh: andenMh, mv: 3, negrita: true });

  // Envío, cliente, etiqueta y hora (cortados para no tapar el andén).
  const hasta = function (s, x, f) { return eplTexto_(s).substring(0, Math.floor(((anden ? andenX - 12 : der) - x) / EPL_PASO[f])); };
  A(X(16), Y(80), 4, hasta('ENVIO: ' + block.envio, X(16), 4), { mv: 2, negrita: true });
  A(X(16), Y(136), 3, hasta('CLIENTE: ' + (block.cliente || ''), X(16), 3));
  A(X(16), Y(162), 3, hasta('ETIQUETA: ' + block.etiquetaId + '  HORA: ' + (block.horaCarga || ''), X(16), 3));

  // Barra negra de encabezado de la tabla.
  LO(sepX, Y(190), sepW, 2);
  LO(sepX, Y(194), sepW, 30);
  [[C.art, 'ARTICULO'], [C.desc, 'DESCRIPCION'], [C.lote, 'LOTE'], [C.cant, 'CANTIDAD'], [C.um, 'UM'], [C.plt, 'PLT'], [C.cj, 'CJ']]
    .forEach(function (h) { A(X(h[0]), Y(201), 2, h[1], { rev: true }); });

  const tablaTop = Y(224);
  let y = Y(230);
  const lineasFila = [];
  block.lineas.slice(0, F.maxLineas).forEach(function (l) {
    const c = celdasLinea_(l, F);
    A(X(C.art), y, 3, c.art[0], { negrita: true });
    A(X(C.desc), y, 3, c.desc[0]);
    A(X(C.lote), y, 3, c.lote[0]);
    A(X(C.cant), y, 3, l.cantidad.toFixed(2), { negrita: true });
    A(X(C.um), y, 3, sanitizeZpl_(l.um).substring(0, 3));
    A(X(C.plt), y, 3, l.pallets);
    A(X(C.cj), y, 3, l.cajas);
    if (c.art[1]) A(X(C.art), y + 23, 3, c.art[1], { negrita: true });
    if (c.desc[1]) A(X(C.desc), y + 23, 3, c.desc[1]);
    if (c.desc[2]) A(X(C.desc), y + 45, 3, c.desc[2]);
    if (c.lote[1]) A(X(C.lote), y + 23, 3, c.lote[1]);
    y += alturaLinea_(l, F);
    lineasFila.push(y - 4);
  });
  if (lineasFila.length) {
    const tablaFin = lineasFila[lineasFila.length - 1] + 2;
    lineasFila.forEach(function (ly) { LO(sepX, ly, sepW, 2); });
    LO(sepX, tablaTop, 2, tablaFin - tablaTop);
    LO(sepX + sepW - 2, tablaTop, 2, tablaFin - tablaTop);
    [C.desc, C.lote, C.cant, C.um, C.plt, C.cj].forEach(function (cx) { LO(X(cx) - 5, tablaTop, 2, tablaFin - tablaTop); });
  }

  // Totales al pie.
  LO(sepX, B - 58, sepW, 3);
  A(X(16), B - 46, 4, 'TOTAL M2: ' + tot.m2.toFixed(2) + '   TOTAL UN: ' + fmtUn_(tot.un), { negrita: true });
  A(X(C.plt), B - 46, 4, totalPlts, { negrita: true });
  A(X(C.cj), B - 46, 4, totalCajas, { negrita: true });
  return ops;
}

// Los mismos elementos en ZPL (solo para "Imprimir Directo en Zebra USB" con impresoras ZPL).
function opsAZpl_(ops, ancho, alto) {
  const out = ['^XA', '^PW' + ancho, '^LL' + alto, '^LH0,0'];
  ops.forEach(function (o) {
    if (o.t === 'A' && o.s) {
      out.push('^FO' + o.x + ',' + o.y + '^A0N,' + (EPL_ALTO[o.f] * o.mv) + ',' + (EPL_PASO[o.f] * o.mh) + (o.rev ? '^FR' : '') + '^FD' + o.s + '^FS');
    } else if (o.t === 'LO') {
      out.push('^FO' + o.x + ',' + o.y + '^GB' + o.w + ',' + o.h + ',' + Math.min(o.w, o.h) + '^FS');
    } else if (o.t === 'X') {
      out.push('^FO' + o.x + ',' + o.y + '^GB' + (o.x2 - o.x) + ',' + (o.y2 - o.y) + ',' + o.w + '^FS');
    }
  });
  out.push('^PQ1', '^XZ');
  return out.join('\n');
}

// ======================
// TICKETS A4 (PDF) - MISMO MODELO QUE LA ETIQUETA ZEBRA
// Un ticket por cada Nro. de Etiqueta de la selección (igual que la Zebra),
// con el mismo diseño: recuadro, título + fecha, ENVIO, CLIENTE, ANDEN / HORA
// CARGA, ETIQUETA en grande arriba a la derecha, tabla con barra negra de
// encabezado y totales (M2, UN, PLT, CJ) al pie. Sin código de barras ni pie.
// ======================
function api_generarTicketsA4_(ids) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const wsD = ss.getSheetByName(SH_DATOS);
  const headers = wsD.getRange(1, 1, 1, wsD.getLastColumn()).getValues()[0];
  const idx = {};
  headers.forEach(function (h, i) { idx[h] = i; });
  const lastRow = wsD.getLastRow();
  if (lastRow < 2) return { tickets: [] };

  const allRows = wsD.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const seleccion = allRows.filter(function (r) { return ids.indexOf(r[idx.id]) !== -1; });
  if (!seleccion.length) throw new Error('No hay líneas seleccionadas.');

  // Agrupa por etiqueta (como la Zebra); las líneas sin etiqueta salen juntas por envío.
  const grupos = {};
  const orden = [];
  seleccion.forEach(function (r) {
    const etq = String(r[idx.nroEtiqueta]).trim();
    const key = etq || ('SIN-ETIQUETA|' + (String(r[idx.nroEnvio]).trim() || '-'));
    if (!grupos[key]) { grupos[key] = []; orden.push(key); }
    grupos[key].push(r);
  });

  const folder = getOrCreateDriveFolder_('PackingList - PDFs generados');
  const mapaA = mapaAndenes_(ss);
  const fecha = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/Guayaquil', 'dd/MM/yyyy HH:mm');
  const tickets = [];

  orden.forEach(function (key) {
    const filas = grupos[key];
    const etq = key.indexOf('SIN-ETIQUETA|') === 0 ? '' : key;
    const envio = String(filas[0][idx.nroEnvio]).trim();
    const da = datosAndenEnvio_(mapaA, envio);
    const cliente = da.cliente, anden = da.anden, horaCarga = da.horaCarga;
    const url = generarTicketA4Pdf_(ss, folder, envio, etq, cliente, anden, horaCarga, fecha, filas, idx);
    tickets.push({ envio: envio, etiqueta: etq, url: url });
  });

  return { tickets: tickets };
}

function generarTicketA4Pdf_(ss, folder, envio, etq, cliente, anden, horaCarga, fecha, filas, idx) {
  let tmp = ss.getSheetByName('TMP_TICKET_A4');
  if (tmp) ss.deleteSheet(tmp);
  tmp = ss.insertSheet('TMP_TICKET_A4');

  // 7 columnas = las mismas de la etiqueta. Ancho fijo (~525pt) para que el PDF
  // salga siempre igual en A4 vertical.
  const NC = 7;
  [90, 190, 75, 70, 40, 30, 30].forEach(function (w, i) { tmp.setColumnWidth(i + 1, w); });

  const lineas = filas.map(function (r) {
    const cc = r[idx.cantidadConfirmada], pc = r[idx.palletsConfirmados], jc = r[idx.cajasConfirmados];
    return {
      articulo: String(r[idx.articulo]),
      descripcion: String(r[idx.descripcion]),
      lote: String(r[idx.lote]),
      cantidad: Number(cc !== '' ? cc : r[idx.cantidadSolicitada]) || 0,
      um: String(r[idx.um] || ''),
      pallets: Number(pc !== '' ? pc : r[idx.nroPallets]) || 0,
      cajas: Number(jc !== '' ? jc : r[idx.cajas]) || 0
    };
  });
  let totalPlt = 0, totalCj = 0;
  lineas.forEach(function (l) { totalPlt += l.pallets; totalCj += l.cajas; });
  const tot = totalesPorUm_(lineas);

  const all = tmp.getRange(1, 1, 60 + lineas.length, NC);
  all.setFontFamily('Arial').setVerticalAlignment('middle');

  // --- Encabezado (igual que la etiqueta) ---
  tmp.getRange(1, 1, 1, 3).merge();
  tmp.getRange(1, 1).setValue('PACKING LIST DESPACHO').setFontSize(14).setFontWeight('bold');
  tmp.getRange(1, 4, 1, 4).merge();
  tmp.getRange(1, 4).setValue(fecha).setFontSize(9).setHorizontalAlignment('right');
  tmp.setRowHeight(1, 26);
  tmp.getRange(1, 1, 1, NC).setBorder(null, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID);

  tmp.getRange(2, 1, 1, 3).merge();
  tmp.getRange(2, 1).setValue('ENVIO: ' + envio).setFontSize(11).setFontWeight('bold');
  tmp.getRange(2, 4, 1, 4).merge();
  tmp.getRange(2, 4).setValue('ETIQUETA').setFontSize(8).setHorizontalAlignment('right').setVerticalAlignment('bottom');
  tmp.setRowHeight(2, 20);

  tmp.getRange(3, 1, 1, 3).merge();
  tmp.getRange(3, 1).setValue('CLIENTE: ' + cliente).setFontSize(10).setFontWeight('bold').setWrap(true);
  tmp.getRange(3, 4, 2, 4).merge();
  tmp.getRange(3, 4).setValue(etq || '-').setFontSize(24).setFontWeight('bold')
    .setHorizontalAlignment('right').setVerticalAlignment('top');
  tmp.setRowHeight(3, 34);

  tmp.getRange(4, 1, 1, 3).merge();
  tmp.getRange(4, 1).setValue('ANDEN: ' + (anden || '') + '     HORA CARGA: ' + (horaCarga || '')).setFontSize(9);
  tmp.setRowHeight(4, 20);

  // --- Barra negra de encabezado de la tabla ---
  const headerRow = 5;
  tmp.getRange(headerRow, 1, 1, NC)
    .setValues([['ARTICULO', 'DESCRIPCION', 'LOTE', 'CANT (M2)', 'UM', 'PLT', 'CJ']])
    .setFontWeight('bold').setFontSize(9).setBackground('#000000').setFontColor('#ffffff');
  tmp.getRange(headerRow, 4).setHorizontalAlignment('right');
  tmp.getRange(headerRow, 5, 1, 3).setHorizontalAlignment('center');
  tmp.setRowHeight(headerRow, 22);

  // --- Filas (los textos largos pasan a una 2da línea dentro de la misma fila) ---
  const data = lineas.map(function (l) { return [l.articulo, l.descripcion, l.lote, l.cantidad, l.um, l.pallets, l.cajas]; });
  const first = headerRow + 1;
  const dataRange = tmp.getRange(first, 1, data.length, NC);
  dataRange.setValues(data).setFontSize(9).setWrap(true);
  tmp.getRange(first, 4, data.length, 1).setNumberFormat('#,##0.00').setHorizontalAlignment('right');
  tmp.getRange(first, 5, data.length, 3).setHorizontalAlignment('center');
  dataRange.setBorder(null, null, true, null, null, true, '#cccccc', SpreadsheetApp.BorderStyle.SOLID);
  for (let i = 0; i < data.length; i++) tmp.setRowHeight(first + i, 28);

  // --- Totales al pie ---
  const rowT = first + data.length;
  tmp.getRange(rowT, 1, 1, 5).merge();
  tmp.getRange(rowT, 1).setValue('TOTAL M2: ' + tot.m2.toFixed(2) + '      TOTAL UN: ' + fmtUn_(tot.un))
    .setFontSize(11).setFontWeight('bold');
  tmp.getRange(rowT, 6).setValue(totalPlt).setFontSize(11).setFontWeight('bold').setHorizontalAlignment('center');
  tmp.getRange(rowT, 7).setValue(totalCj).setFontSize(11).setFontWeight('bold').setHorizontalAlignment('center');
  tmp.getRange(rowT, 1, 1, NC).setBorder(true, null, null, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  tmp.setRowHeight(rowT, 30);

  // Recuadro exterior (el borde de la etiqueta).
  tmp.getRange(1, 1, rowT, NC).setBorder(true, true, true, true, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);

  // Área de impresión exacta: evita páginas en blanco.
  const lastRow = rowT;
  const lastCol = NC;

  SpreadsheetApp.flush();

  const exportUrl = exportarHojaComoPdf_(ss, tmp, lastRow, lastCol);
  const blob = UrlFetchApp.fetch(exportUrl, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }
  }).getBlob();
  const safe = function (s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '_'); };
  const file = folder.createFile(blob.setName('Ticket_A4_' + safe(envio) + (etq ? '_' + safe(etq) : '') + '.pdf'));

  ss.deleteSheet(tmp);
  return file.getUrl();
}

// Exporta una hoja como PDF, forzada a tamaño A4 vertical, ajustada al ancho de
// página, sin líneas de cuadrícula ni encabezados de fila/columna, y acotada
// exactamente al rango con contenido (evita páginas en blanco extra).
function exportarHojaComoPdf_(ss, sheet, lastRow, lastCol) {
  const base = ss.getUrl().replace(/edit$/, '');
  let url = base + 'export?format=pdf&gid=' + sheet.getSheetId() +
    '&size=A4&portrait=true&scale=2&fitw=true' +
    '&gridlines=false&printtitle=false&sheetnames=false' +
    '&pagenum=UNDEFINED&horizontal_alignment=CENTER&vertical_alignment=TOP' +
    '&top_margin=0.4&bottom_margin=0.4&left_margin=0.4&right_margin=0.4';
  if (lastRow && lastCol) {
    url += '&r1=0&c1=0&r2=' + lastRow + '&c2=' + lastCol;
  }
  return url;
}

function getOrCreateDriveFolder_(name) {
  const it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

// ======================
// CONTAR SELECCIÓN
// ======================
function api_contarSeleccion_(ids) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const wsD = ss.getSheetByName(SH_DATOS);
  const headers = wsD.getRange(1, 1, 1, wsD.getLastColumn()).getValues()[0];
  const lastRow = wsD.getLastRow();
  if (lastRow < 2) return { lineas: 0, envios: 0, etiquetas: 0 };

  const allRows = wsD.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const idCol = headers.indexOf('id'), envCol = headers.indexOf('nroEnvio'), etqCol = headers.indexOf('nroEtiqueta');
  const sel = allRows.filter(function (r) {
    return ids.indexOf(r[idCol]) !== -1 && String(r[etqCol]).trim() !== '';
  });
  const envios = {}, etiquetas = {};
  sel.forEach(function (r) { envios[r[envCol]] = true; etiquetas[r[etqCol]] = true; });
  return { lineas: sel.length, envios: Object.keys(envios).length, etiquetas: Object.keys(etiquetas).length };
}

// ======================
// UTILIDADES
// ======================
function normalizeText_(s) {
  return String(s).trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

// ======================================================================
// ETIQUETAS DE PRODUCTO (stock + conversión de la hoja "base")
// Se sube el reporte de stock (foto del inventario: cada carga reemplaza a la
// anterior y queda registrada en CARGAS/HISTORIAL). Para imprimir se busca por
// código; la conversión (M2 x CJ, M2 x Pallet) sale siempre de "base".
// ======================================================================
const SH_STOCK = 'STOCK';
const STOCK_CAMPOS = ['codigo', 'descripcion', 'subinventario', 'nombreSubinv', 'localizador', 'lote',
  'canFisica', 'um', 'pallets', 'cajas', 'peso', 'tipoInventario', 'formato', 'calidad', 'marca',
  'estado', 'm2xCaja', 'dispoReservar', 'umSec', 'canFisicaSec'];

function api_cargarStock_(rows, clave, archivo) {
  verificarClave_(clave);
  if (!rows || !rows.length) throw new Error('El archivo de stock no tiene líneas.');
  return conLock_(function () {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const ws = getOrCreateSheet_(ss, SH_STOCK);
    ws.clearContents();
    const cols = STOCK_CAMPOS.concat(['fechaCarga']);
    ws.getRange(1, 1, Math.max(ws.getMaxRows(), rows.length + 1), 1).setNumberFormat('@');           // código
    ws.getRange(1, 5, Math.max(ws.getMaxRows(), rows.length + 1), 2).setNumberFormat('@');           // localizador, lote
    ws.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    ws.setFrozenRows(1);
    const ahora = new Date();
    const data = rows
      .filter(function (r) { return String(r.codigo === undefined || r.codigo === null ? '' : r.codigo).trim() !== ''; })
      .map(function (r) {
        return STOCK_CAMPOS.map(function (f) {
          const v = r[f];
          if (f === 'codigo') return String(v).trim();
          return v === undefined || v === null ? '' : v;
        }).concat([ahora]);
      });
    if (data.length) ws.getRange(2, 1, data.length, cols.length).setValues(data);
    const cargaId = 'S' + Utilities.formatDate(ahora, TZ, 'yyyyMMdd-HHmmss');
    registrarCarga_(ss, { cargaId: cargaId, tipo: 'STOCK', archivo: archivo, nuevas: data.length, actualizadas: 0 });
    registrarHistorial_('CARGA_STOCK', (archivo || '-') + ': ' + data.length + ' líneas de stock', cargaId);
    return { count: data.length };
  });
}

function api_infoStock_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ws = ss.getSheetByName(SH_STOCK);
  if (!ws || ws.getLastRow() < 2) return { lineas: 0, fecha: '' };
  return { lineas: ws.getLastRow() - 1, fecha: textoCelda_(ws.getRange(2, STOCK_CAMPOS.length + 1).getValue(), 'fecha') };
}

// Conversión del producto desde la hoja "base" (la fuente oficial).
// Lectura real desde la hoja (la versión con caché es conversionBase_, en Velocidad.js).
function conversionBaseHoja_(codigo) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ws = ss.getSheetByName(SH_BASE);
  const vacio = { encontrado: false, descripcion: '', m2PorCaja: 0, m2PorPallet: 0, cjPorPallet: 0 };
  if (!ws || ws.getLastRow() < 2) return vacio;
  const lastCol = ws.getLastColumn();
  const headers = ws.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return normalizeText_(h); });
  const cCod = headers.indexOf('codigo');
  if (cCod === -1) return vacio;
  const cDesc = headers.indexOf('descripcion');
  const cCj = headers.indexOf('m2 x cj');
  const cPe = headers.indexOf('m2 x pe');
  const cCjPe = headers.indexOf('cj x pe');
  const buscado = normCodigo_(codigo);
  // Rendimiento: solo la columna de códigos; después, solo la fila encontrada.
  const codigos = ws.getRange(2, cCod + 1, ws.getLastRow() - 1, 1).getValues();
  let fila = -1;
  for (let k = 0; k < codigos.length; k++) { if (normCodigo_(codigos[k][0]) === buscado) { fila = k; break; } }
  const vals = fila === -1 ? [] : [ws.getRange(fila + 2, 1, 1, lastCol).getValues()[0]];
  for (let i = 0; i < vals.length; i++) {
    const m2PorCaja = cCj !== -1 ? Number(vals[i][cCj]) || 0 : 0;
    const m2PorPallet = cPe !== -1 ? Number(vals[i][cPe]) || 0 : 0;
    const cjPe = cCjPe !== -1 ? Number(vals[i][cCjPe]) || 0 : 0;
    return {
      encontrado: true,
      descripcion: cDesc !== -1 ? String(vals[i][cDesc] || '').trim() : '',
      m2PorCaja: m2PorCaja,
      m2PorPallet: m2PorPallet,
      // CJ x Pallet: el valor guardado si existe; si no, se calcula de M2 x PE / M2 x CJ.
      cjPorPallet: cjPe || (m2PorCaja > 0 && m2PorPallet > 0 ? Math.round(m2PorPallet / m2PorCaja) : 0)
    };
  }
  return vacio;
}

function normCodigo_(v) { return String(v === undefined || v === null ? '' : v).trim().toUpperCase(); }

// Busca un código en el stock y en "base". Si no hay coincidencia exacta,
// devuelve sugerencias de códigos que contienen el texto.
function api_buscarProducto_(codigo) {
  const buscado = normCodigo_(codigo);
  if (!buscado) throw new Error('Escribe un código.');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ws = ss.getSheetByName(SH_STOCK);
  let filas = [], sugerencias = {};
  if (ws && ws.getLastRow() >= 2) {
    // Rendimiento: solo código y descripción para buscar; luego las filas completas
    // únicamente del código encontrado (antes se leía todo el stock en cada búsqueda).
    const cortas = ws.getRange(2, 1, ws.getLastRow() - 1, 2).getValues();
    const exactas = [];
    cortas.forEach(function (r, k) {
      const c = normCodigo_(r[0]);
      if (c === buscado) exactas.push(k);
      else if (c.indexOf(buscado) !== -1 && Object.keys(sugerencias).length < 15) sugerencias[c] = String(r[1] || '');
    });
    leerFilasDatos_(ws, exactas, STOCK_CAMPOS.length).forEach(function (x) {
      const o = {};
      STOCK_CAMPOS.forEach(function (f, i) { o[f] = textoCelda_(x.row[i], f); });
      filas.push(o);
    });
  }
  const conv = conversionBase_(buscado);
  if (!filas.length && !conv.encontrado) {
    return { encontrado: false, sugerencias: Object.keys(sugerencias).map(function (k) { return { codigo: k, descripcion: sugerencias[k] }; }) };
  }
  return {
    encontrado: true,
    codigo: filas.length ? String(filas[0].codigo) : buscado,
    descripcion: (filas.length && filas[0].descripcion) || conv.descripcion,
    um: filas.length ? String(filas[0].um || '') : '',
    filas: filas,
    conv: conv,
    stock: api_infoStock_()
  };
}

// p: { codigo, descripcion, um, lote, cantidad, copias, tamano: 'grande' | 'pequena' }
// Devuelve el EPL y la misma etiqueta como lista de elementos (para la vista previa).
function api_etiquetaProducto_(p, imprimir) {
  const conv = conversionBase_(p.codigo);
  const d = {
    codigo: normCodigo_(p.codigo),
    descripcion: String(p.descripcion || conv.descripcion || '').trim(),
    um: String(p.um || '').trim().toUpperCase().replace('²', '2'),
    lote: String(p.lote === undefined || p.lote === null || p.lote === '' ? '-' : p.lote),
    cantidad: Number(p.cantidad) || 0,
    copias: Math.max(1, Math.min(100, Math.floor(Number(p.copias) || 1))),
    conv: conv,
    // Solo etiqueta de pallet: en blanco si no se escriben (se completan a mano).
    reportado: String(p.reportado || '').trim().substring(0, 30),
    operador: String(p.operador || '').trim().substring(0, 30),
    fecha: String(p.fecha || '').trim().substring(0, 12),
    qr: true, // todas las etiquetas de producto llevan QR
    // Imprimir el texto de la conversión (M2 x CJ, CJ x Pallet...). Por defecto sí.
    // Solo oculta el texto: las cajas se siguen calculando con la conversión.
    mostrarConv: p.conversion !== false
  };
  const t = TAMANOS_PRODUCTO[p.tamano] || TAMANOS_PRODUCTO.grande;
  const ops = t.layout(d);
  // La de pallet se diseña acostada y se imprime girada: papel de "alto" de ancho y "ancho" de largo.
  const epl = t.rotar ? opsAEpl_(rotarOps90_(ops, t.alto), d.copias, t.alto, t.papel || t.ancho) : opsAEpl_(ops, d.copias, t.ancho, t.alto);
  if (imprimir) {
    registrarHistorial_('IMPRIMIR_PRODUCTO', d.codigo + ' · ' + fmtNumCorto_(d.cantidad) + ' ' + d.um +
      ' · lote ' + d.lote + ' · ' + t.nombre + ' · ' + d.copias + ' copia(s)', d.codigo);
    registrarEtiquetasGeneradas_([[new Date(), USUARIO_ACTUAL_ || '', 'PRODUCTO', d.codigo, d.copias + ' copia(s)',
      '', '', '', t.nombre, 1, fmtNumCorto_(d.cantidad) + ' ' + d.um, '', '',
      'Lote ' + d.lote + (d.mostrarConv ? '' : ' · sin conversión')]]);
  }
  return { epl: epl, ops: ops, conv: conv, ancho: t.ancho, alto: t.alto, sinCorteArriba: !!t.sinCorteArriba,
    qrTexto: contenidoQr_(d) };
}

function fmtNumCorto_(n) {
  n = Number(n) || 0;
  return String(Math.round(n * 100) / 100);
}

// --- Diseño (puntos de 203 dpi; la PC43t corta ~2 mm arriba: se usa EPL_TOP) ---
const PROD_F = 4;           // fuente EPL 4: 16 x 24 puntos por carácter
const PROD_X = 24;          // margen izquierdo del texto
const PROD_DER = ZEBRA_ANCHO - 18;

function opTexto_(x, y, txt, mh, mv) {
  return { t: 'A', x: x, y: y + EPL_TOP, f: PROD_F, mh: mh, mv: mv, s: eplTexto_(txt) };
}

// Multiplicador horizontal más grande (1..max) con el que el texto cabe en el ancho.
function ajustarMh_(txt, ancho, max) {
  const n = Math.max(1, eplTexto_(txt).length);
  return Math.max(1, Math.min(max, Math.floor(ancho / (n * EPL_PASO[PROD_F]))));
}

function cabeEn_(txt, ancho, mh) { return eplTexto_(txt).length * EPL_PASO[PROD_F] * mh <= ancho; }

// Parte un texto en 2 líneas por el espacio más cercano a la mitad.
function partirEnDos_(txt) {
  const s = eplTexto_(txt);
  const mitad = Math.floor(s.length / 2);
  let corte = -1;
  for (let d = 0; d <= mitad; d++) {
    if (s[mitad - d] === ' ') { corte = mitad - d; break; }
    if (s[mitad + d] === ' ') { corte = mitad + d; break; }
  }
  if (corte < 0) corte = mitad;
  return [s.substring(0, corte).trim(), s.substring(corte).trim()];
}

function bloqueCodigo_(ops, codigo, y, mvCodigo) {
  const etiqueta = 'Codigo:';
  const xCod = PROD_X + etiqueta.length * EPL_PASO[PROD_F] + 18;
  const mhCod = ajustarMh_(codigo, PROD_DER - xCod, 3);
  const altoCod = EPL_ALTO[PROD_F] * mvCodigo;
  ops.push(opTexto_(PROD_X, y + altoCod - EPL_ALTO[PROD_F] * 2, etiqueta, 1, 2));
  ops.push(opTexto_(xCod, y, eplTexto_(codigo).substring(0, Math.floor((PROD_DER - xCod) / EPL_PASO[PROD_F])), mhCod, mvCodigo));
  return y + altoCod;
}

// FORMATO ÚNICO para todos los productos (M2, UN, etc.), 10 x 7,5 cm:
//   CODIGO       (ocupa todo el ancho)
//   DESCRIPCION  (lo más grande que quepa, 1 o 2 líneas)
//   LOTE ...                          M2 x CJ / CJ x PALLET
//   CANTIDAD 21.6 M2                  [ CAJAS 15 ]   (total cj = cantidad / M2 x CJ)
// Todo el texto usa el MISMO multiplicador horizontal y vertical (no se deforma) y
// se autoajusta: el mayor tamaño que cabe en su espacio. Las filas y datos que el
// producto no tiene (sin conversión, sin lote, UN) no se imprimen y el espacio
// lo aprovechan la descripción y la cantidad. Solo usa texto y líneas/recuadros
// (sin rellenos), que es lo que ya imprime bien la impresora en modo EPL.
function layoutProducto_(d) {
  const F = PROD_F, P = EPL_PASO[F], H = EPL_ALTO[F];       // fuente 4: 16 x 24 por carácter
  const ops = [{ t: 'X', x: 8, y: 8 + EPL_TOP, w: 2, x2: ZEBRA_ANCHO - 8, y2: ZEBRA_ALTO - 8 }];
  const c = d.conv;
  const um = d.um === 'UN' || !d.um ? 'UND' : d.um;
  const tieneLote = true; // siempre se imprime el lote ("-" si no tiene)
  // PLACA (porcelanato de gran formato, p. ej. 100x300): cada "caja" es 1 placa suelta, o sea
  // CJ x Pallet = 1. Se rotula PLACAS / M2 x PLACA y se omite "1 CJ x PALLET" (no aporta).
  const esPlaca = c.m2PorCaja > 0 && c.cjPorPallet === 1;
  // Izquierda siempre METROS (M2) y derecha siempre CAJAS cuando hay conversión (M2 x CJ):
  //   UM = M2 -> metros = cantidad, cajas = cantidad / M2 x CJ
  //   UM = CJ -> cajas = cantidad, metros = cantidad x M2 x CJ
  // Sin conversión (o UM UN, KG, ML) se imprime la cantidad tal cual y sin recuadro.
  let cantMostrar = d.cantidad, umMostrar = um, recuadro = null;
  if (c.m2PorCaja > 0 && d.um === 'M2') recuadro = { rotulo: esPlaca ? 'PLACAS' : 'CAJAS', valor: d.cantidad / c.m2PorCaja };
  else if (c.m2PorCaja > 0 && d.um === 'CJ') {
    cantMostrar = d.cantidad * c.m2PorCaja; umMostrar = 'M2';
    recuadro = { rotulo: esPlaca ? 'PLACAS' : 'CAJAS', valor: d.cantidad };
  }
  const X0 = PROD_X, ANCHO = PROD_DER - PROD_X;

  const largo = function (t) { return eplTexto_(t).length; };
  // Mayor multiplicador (máx. `max`) con el que el texto cabe en `ancho`; 0 si ni con 1.
  const mejorM = function (t, ancho, max) {
    for (let m = max; m >= 1; m--) if (largo(t) * P * m <= ancho) return m;
    return 0;
  };
  const lab = function (t, x, y) { ops.push(opTextoF_(x, y, t, 2, 1, 1, 200)); };         // etiqueta chica
  const txt = function (x, y, t, m, anchoMax) { ops.push(opTextoF_(x, y, t, F, m, m, anchoMax)); }; // mh = mv
  const linea = function (y) { ops.push({ t: 'LO', x: 8, y: y + EPL_TOP, w: ZEBRA_ANCHO - 16, h: 3 }); };

  // 1) CODIGO (izquierda) y QR (derecha) en la franja de arriba
  const qrTmp = qrOps_(contenidoQr_(d), 0, 0, 1);
  const qrMod = Math.max(3, Math.min(5, Math.floor(124 / qrTmp.modulos)));
  const qrLado = qrTmp.modulos * qrMod;
  const qr = qrOps_(contenidoQr_(d), PROD_DER - qrLado, 14 + EPL_TOP, qrMod);
  qr.ops.forEach(function (o) { ops.push(o); });
  const anchoCod = PROD_DER - qrLado - 16 - X0;
  const codigo = eplTexto_(d.codigo);
  lab('CODIGO', X0, 18);
  txt(X0, 36, codigo, Math.max(1, mejorM(codigo, anchoCod, 4)), anchoCod);
  linea(144);

  // 2) DESCRIPCION (1 línea o 2, la opción que permita letra más grande)
  const derFilas = [];
  if (d.mostrarConv !== false) {
    if (c.m2PorCaja) derFilas.push(fmtNumCorto_(c.m2PorCaja) + (esPlaca ? ' M2 x PLACA' : ' M2 x CJ'));
    if (c.cjPorPallet && !esPlaca) derFilas.push(c.cjPorPallet + ' CJ x PALLET');
  }
  const tieneFila3 = tieneLote || derFilas.length > 0;
  const dTop = 154, dBot = tieneFila3 ? 262 : 346, hD = dBot - dTop;
  if (d.descripcion) {
    const ds = eplTexto_(d.descripcion);
    const l = partirEnDos_(ds);
    const m1 = Math.min(Math.floor(hD / H), mejorM(ds, ANCHO, 4));
    const m2 = Math.min(Math.floor((hD - 8) / (2 * H)), mejorM(largo(l[0]) >= largo(l[1]) ? l[0] : l[1], ANCHO, 3));
    if (m1 >= 1 && m1 >= m2) {
      txt(X0, dTop + Math.floor((hD - H * m1) / 2), ds, m1, ANCHO);
    } else {
      const m = Math.max(1, m2), alto = H * m;
      const y0 = dTop + Math.max(0, Math.floor((hD - 2 * alto - 8) / 2));
      txt(X0, y0, l[0], m, ANCHO);
      txt(X0, y0 + alto + 8, l[1], m, ANCHO);
    }
  }

  // 3) LOTE (izquierda) y conversión (derecha, alineada a la derecha)
  if (tieneFila3) {
    linea(270);
    if (tieneLote) {
      const lt = eplTexto_(d.lote || '-');
      lab('LOTE', X0, 282);
      txt(X0, 300, lt, Math.max(1, mejorM(lt, 390, 2)), 390);
    }
    const base = derFilas.length === 1 ? 300 : 286;
    derFilas.forEach(function (t, i) {
      const w = largo(t) * P;
      txt(PROD_DER - w, base + i * 34, t, 1, 340);
    });
  }
  linea(356);

  // 4) CANTIDAD (izquierda, grande) y CAJAS (derecha, recuadro)
  const bTop = 368, bBot = 566;
  const cantTxt = fmtNumCorto_(cantMostrar);
  const cajasTxt = recuadro ? fmtNumCorto_(recuadro.valor) : '';
  const bx1 = 474, bx2 = 776;
  const anchoIzq = cajasTxt ? bx1 - 16 - X0 : ANCHO;
  const yAvail0 = bTop + 26, hAvail = bBot - yAvail0;
  lab('CANTIDAD', X0, bTop + 2);
  let m = 1;
  for (let k = 6; k >= 1; k--) {
    const mu = Math.max(1, Math.floor(k / 2));
    if (largo(cantTxt) * P * k + 14 + largo(umMostrar) * P * mu <= anchoIzq && H * k <= hAvail) { m = k; break; }
  }
  const mu = Math.max(1, Math.floor(m / 2));
  const yNum = yAvail0 + Math.floor((hAvail - H * m) / 2);
  txt(X0, yNum, cantTxt, m, anchoIzq);
  txt(X0 + largo(cantTxt) * P * m + 14, yNum + H * m - H * mu, umMostrar, mu, anchoIzq);

  if (cajasTxt) {
    ops.push({ t: 'X', x: bx1, y: bTop + EPL_TOP, w: 3, x2: bx2, y2: bBot + EPL_TOP });
    lab(recuadro.rotulo, bx1 + Math.floor((bx2 - bx1 - recuadro.rotulo.length * EPL_PASO[2]) / 2), bTop + 10);
    const yC0 = bTop + 34, hC = (bBot - 8) - yC0;
    let kc = 1;
    for (let k = 6; k >= 1; k--) if (largo(cajasTxt) * P * k <= bx2 - bx1 - 24 && H * k <= hC) { kc = k; break; }
    const wC = largo(cajasTxt) * P * kc;
    txt(bx1 + Math.floor((bx2 - bx1 - wC) / 2), yC0 + Math.floor((hC - H * kc) / 2), cajasTxt, kc, bx2 - bx1);
  }
  return ops;
}

// ETIQUETA PEQUEÑA 5 x 2,2 cm (400 x 176 puntos), como el diseño de bodega:
//   Codigo: DVC22C
//   CENEFA COCINA ELEGANT        (1 o 2 líneas)
//   20X60 20X60
//   Cant: 10 UND
const PEQ_ANCHO = 400, PEQ_ALTO = 176;

function opTextoF_(x, y, txt, f, mh, mv, anchoMax) {
  let s = eplTexto_(txt);
  if (anchoMax) s = s.substring(0, Math.floor(anchoMax / (EPL_PASO[f] * mh)));
  return { t: 'A', x: x, y: y + EPL_TOP, f: f, mh: mh, mv: mv, s: s };
}

function layoutProductoPequena_(d) {
  const ops = [{ t: 'X', x: 4, y: 4 + EPL_TOP, w: 2, x2: PEQ_ANCHO - 4, y2: PEQ_ALTO - 4 }];
  // QR a la derecha, centrado en el alto útil (dentro del borde: y 24..168 con EPL_TOP).
  const tmp = qrOps_(contenidoQr_(d), 0, 0, 1);
  const modulo = Math.max(2, Math.min(4, Math.floor(130 / tmp.modulos)));
  const lado = tmp.modulos * modulo;
  const qr = qrOps_(contenidoQr_(d), PEQ_ANCHO - 10 - lado, 4 + EPL_TOP + Math.floor((PEQ_ALTO - 8 - EPL_TOP - lado) / 2), modulo);
  qr.ops.forEach(function (o) { ops.push(o); });
  // Texto a la izquierda del QR. La PC43t corta ~2 mm arriba (EPL_TOP): alto útil
  // ~150 puntos = código (40) + descripción (16 o 32) + lote (20) + cantidad (40).
  const x = 12, ancho = PEQ_ANCHO - 10 - lado - 8 - x;
  const mhAjuste = function (txt, f, max) { return Math.max(1, Math.min(max || 2, Math.floor(ancho / (Math.max(1, eplTexto_(txt).length) * EPL_PASO[f])))); };
  const cod = 'Codigo: ' + eplTexto_(d.codigo);
  ops.push(opTextoF_(x, 6, cod, 3, mhAjuste(cod, 3), 2, ancho));            // 40 puntos de alto
  const desc = eplTexto_(d.descripcion);
  if (desc.length * EPL_PASO[2] <= ancho) {
    ops.push(opTextoF_(x, 55, desc, 2, mhAjuste(desc, 2), 1, ancho));       // 1 línea
  } else {
    const l = partirEnDos_(desc);
    ops.push(opTextoF_(x, 48, l[0], 2, 1, 1, ancho));                       // 2 líneas de 16 puntos
    ops.push(opTextoF_(x, 65, l[1], 2, 1, 1, ancho));
  }
  const lote = 'Lote: ' + eplTexto_(d.lote || '-');
  ops.push(opTextoF_(x, 85, lote, 3, mhAjuste(lote, 3), 1, ancho));        // 20 puntos
  const um = d.um === 'UN' || !d.um ? 'UND' : d.um;
  const cant = 'Cant: ' + fmtNumCorto_(d.cantidad) + ' ' + um;
  ops.push(opTextoF_(x, 110, cant, 3, mhAjuste(cant, 3), 2, ancho));       // 40 puntos (termina en 150)
  return ops;
}

// ======================================================================
// ETIQUETA DE PALLET 15 x 10 cm (como la etiqueta de bodega):
//   UPTOWN 51.2 X 51.2 BEIGE THIN        (descripción, grande, centrada)
//              110502E                   (código, grande)
//               T671C                    (lote)
//   M2:  110.04
//   CJ:  84
//   Reportado por: ______                       [QR]
//   Operador:      ______
//   Fecha:         ______
// Reportado por / Operador / Fecha: en blanco para escribir a mano (o lo que se
// escriba en la app). QR igual al de bodega: "(02)<código>(10)<lote>" (GS1: 02 =
// código del producto, 10 = lote).
// Se diseña ACOSTADA (1200 x 800 puntos) y se imprime GIRADA 90° en el rollo de
// 10 cm de ancho x 15 cm de largo (la impresora mide 10,4 cm de ancho como máximo).
// ======================================================================
const PALLET_ANCHO = 1200, PALLET_ALTO = 800;     // diseño acostado: 15 x 10 cm
// En EPL, un texto girado 90° (rotación 1) usa como punto de inicio su esquina
// superior DERECHA. Si una prueba mostrara los textos corridos, cambiar a false.
const EPL_ROT_ANCLA_DERECHA = true;

function textoPalletOp_(x, y, txt, mh, mv, normal) {
  // negrita: la fuente EPL es delgada; se imprime 2 veces corrida 2 puntos (ver opsAEpl_).
  return { t: 'A', x: x, y: y, f: 4, mh: mh, mv: mv, s: eplTexto_(txt), negrita: !normal };
}
function anchoTxt_(s, mh) { return eplTexto_(s).length * EPL_PASO[4] * mh; }

// Texto centrado en [x0, x0+ancho], con el multiplicador más grande (<= maxMh) que cabe.
function centradoPallet_(ops, s, y, x0, ancho, maxMh, mvDe) {
  s = eplTexto_(s);
  if (!s) return 0;
  let mh = Math.max(1, Math.min(maxMh, Math.floor(ancho / (s.length * EPL_PASO[4]))));
  const mv = mvDe(mh);
  const recorte = Math.floor(ancho / (EPL_PASO[4] * mh));
  s = s.substring(0, recorte);
  ops.push(textoPalletOp_(x0 + Math.floor((ancho - anchoTxt_(s, mh)) / 2), y, s, mh, mv));
  return EPL_ALTO[4] * mv;
}

function contenidoQr_(d) {
  const lote = d.lote && d.lote !== '-' ? '(10)' + d.lote : '';
  return '(02)' + d.codigo + lote;
}

// Dibuja el QR con rectángulos negros (LO), uniendo los módulos seguidos de cada fila.
function qrOps_(texto, x0, y0, modulo) {
  const qr = qrcode(0, 'M');
  qr.addData(texto);
  qr.make();
  const n = qr.getModuleCount();
  const ops = [];
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!qr.isDark(r, c)) { c++; continue; }
      let fin = c;
      while (fin + 1 < n && qr.isDark(r, fin + 1)) fin++;
      ops.push({ t: 'LO', x: x0 + c * modulo, y: y0 + r * modulo, w: (fin - c + 1) * modulo, h: modulo });
      c = fin + 1;
    }
  }
  return { ops: ops, lado: n * modulo, modulos: n };
}

function layoutProductoPallet_(d) {
  const ops = [];
  const M = 40, ANCHO = PALLET_ANCHO - 2 * M;      // margen de 5 mm
  const c = d.conv;
  const fmt = fmtNumCorto_;

  // 1) Descripción: 1 línea si cabe en grande; si no, 2 líneas.
  let y = 30;
  const desc = eplTexto_(d.descripcion);
  const mvDesc = function (mh) { return Math.min(5, mh * 2 + 1); };   // alta y angosta, como la de bodega
  if (desc && desc.length * EPL_PASO[4] * 2 <= ANCHO) {
    y += centradoPallet_(ops, desc, y, M, ANCHO, 3, mvDesc) + 14;
  } else if (desc) {
    const l = partirEnDos_(desc);
    y += centradoPallet_(ops, l[0], y, M, ANCHO, 2, function () { return 3; }) + 6;
    y += centradoPallet_(ops, l[1], y, M, ANCHO, 2, function () { return 3; }) + 14;
  }

  // 2) Código y 3) Lote, centrados.
  y += centradoPallet_(ops, d.codigo, y, M, ANCHO, 3, function (mh) { return mh + 1; }) + 8;
  y += centradoPallet_(ops, d.lote && d.lote !== '-' ? d.lote : 'LOTE: -', y, M, ANCHO, 3, function (mh) { return mh + 1; }) + 8;

  // 4) Cantidades (M2 / CJ, o la UM que tenga).
  const lineas = lineasCantidadPallet_(d).map(function (l) { return l[0] + ':  ' + l[1]; });

  // 7) Pie: conversión de la base (M2 x CJ, CJ x pallet, M2 x pallet), a todo el ancho.
  //    Si el producto no tiene conversión no se reserva el espacio.
  const conv = d.mostrarConv !== false ? textoConversionPallet_(c) : '';
  const pie = conv ? 72 : 0;

  // 5) QR abajo a la derecha (opcional), encima del pie.
  let qr = null;
  if (d.qr) {
    const tmp = qrOps_(contenidoQr_(d), 0, 0, 1);
    const modulo = Math.max(4, Math.min(9, Math.floor(260 / tmp.modulos)));
    const lado = tmp.modulos * modulo;
    qr = qrOps_(contenidoQr_(d), PALLET_ANCHO - M - lado, PALLET_ALTO - M - pie - lado, modulo);
  }
  const anchoIzq = (qr ? PALLET_ANCHO - M - qr.lado - 30 : PALLET_ANCHO - M) - M;

  // Lo que queda de alto se reparte entre cantidades (grandes) y los 3 datos de abajo.
  const yDatos = PALLET_ALTO - M - pie - 3 * 52;   // 3 filas de 52 puntos sobre el pie
  let yc = Math.max(y + 6, 300);
  const altoCant = Math.max(48, Math.min(72, Math.floor((yDatos - 12 - yc) / Math.max(1, lineas.length))));
  const mvCant = Math.max(2, Math.floor(altoCant / EPL_ALTO[4]));
  lineas.forEach(function (t) {
    const mh = Math.max(1, Math.min(2, Math.floor(anchoIzq / (t.length * EPL_PASO[4]))));
    ops.push(textoPalletOp_(M + 20, yc, t, mh, mvCant));
    yc += EPL_ALTO[4] * mvCant + 8;
  });

  // 6) Reportado por / Operador / Fecha: título + dato (o línea en blanco para escribir).
  const xValor = M + 20 + 15 * EPL_PASO[4];
  [['Reportado por:', d.reportado], ['Operador:', d.operador], ['Fecha:', d.fecha]].forEach(function (f, i) {
    const yy = yDatos + i * 52;
    ops.push(textoPalletOp_(M + 20, yy, f[0], 1, 2));
    if (f[1]) ops.push(textoPalletOp_(xValor, yy, String(f[1]).substring(0, Math.floor((anchoIzq - xValor + M) / EPL_PASO[4])), 1, 2));
    else ops.push({ t: 'LO', x: xValor, y: yy + 44, w: Math.min(360, anchoIzq + M - xValor), h: 2 });
  });

  if (conv) {
    const yPie = PALLET_ALTO - M - 48;
    ops.push({ t: 'LO', x: M, y: yPie - 12, w: ANCHO, h: 3 });
    centradoPallet_(ops, conv, yPie, M, ANCHO, 1, function () { return 2; });
  }

  if (qr) qr.ops.forEach(function (o) { ops.push(o); });
  return ops;
}

// "M2 X CJ: 2.23   CJ X PALLET: 46   M2 X PALLET: 102.58" (solo los datos que tenga la base).
function textoConversionPallet_(c) {
  const fmt = fmtNumCorto_, partes = [];
  if (c.m2PorCaja > 0) partes.push('M2 X CJ: ' + fmt(c.m2PorCaja));
  if (c.cjPorPallet > 0) partes.push('CJ X PALLET: ' + fmt(c.cjPorPallet));
  if (c.m2PorPallet > 0) partes.push('M2 X PALLET: ' + fmt(c.m2PorPallet));
  return partes.join('   ');
}

// [["M2", "110.04"], ["CJ", "84"]] según la UM y la conversión de la base.
function lineasCantidadPallet_(d) {
  const c = d.conv, fmt = fmtNumCorto_, l = [];
  if (d.um === 'M2') {
    l.push(['M2', fmt(d.cantidad)]);
    if (c.m2PorCaja > 0) l.push(['CJ', fmt(d.cantidad / c.m2PorCaja)]);
  } else if (d.um === 'CJ') {
    if (c.m2PorCaja > 0) l.push(['M2', fmt(d.cantidad * c.m2PorCaja)]);
    l.push(['CJ', fmt(d.cantidad)]);
  } else {
    l.push([d.um === 'UN' || !d.um ? 'UND' : d.um, fmt(d.cantidad)]);
  }
  return l;
}

// Gira 90° las operaciones del diseño acostado (ancho x alto) para el rollo de
// "alto" puntos de ancho físico. Coordenadas físicas: x' = alto - y, y' = x.
function rotarOps90_(ops, alto) {
  return ops.map(function (o) {
    if (o.t === 'A') {
      const hText = EPL_ALTO[o.f] * o.mv;
      // Con el texto girado la impresora aplica los multiplicadores en los ejes del PAPEL:
      // el 1º (horizontal) agranda el alto de la letra y el 2º (vertical) el largo del
      // texto. Por eso se intercambian (comprobado en la PC43t: sin esto la descripción
      // salía 2 veces más larga y se cortaba).
      return { t: 'A', rot: 1, x: EPL_ROT_ANCLA_DERECHA ? alto - o.y : alto - o.y - hText, y: o.x, f: o.f, mh: o.mv, mv: o.mh, s: o.s, negrita: o.negrita };
    }
    if (o.t === 'LO') return { t: 'LO', x: alto - (o.y + o.h), y: o.x, w: o.h, h: o.w };
    if (o.t === 'X') return { t: 'X', x: alto - o.y2, y: o.x, w: o.w, x2: alto - o.y, y2: o.x2 };
    return o;
  });
}

const TAMANOS_PRODUCTO = {
  grande: { nombre: '10x7.5cm', ancho: ZEBRA_ANCHO, alto: ZEBRA_ALTO, layout: function (d) { return layoutProducto_(d); } },
  pequena: { nombre: '5x2.2cm', ancho: PEQ_ANCHO, alto: PEQ_ALTO, layout: function (d) { return layoutProductoPequena_(d); } },
  // Diseño 1200 x 800 (acostado); se imprime girado en papel de 800 de ancho x 1200 de largo.
  pallet: { nombre: '15x10cm', ancho: PALLET_ANCHO, alto: PALLET_ALTO, papel: PL_FORMATOS.grande.papel, rotar: true, sinCorteArriba: true,
    layout: function (d) { return layoutProductoPallet_(d); } }
};

// ======================================================================
// PRODUCTOS NUEVOS A LA BASE (reporte "Ingresos de transferencias")
// Solo COPIA a la hoja "base": Nombre de artículo -> Codigo y Descripción de
// artículo -> Descripcion. Un código que ya existe NO se toca (ni descripción ni
// conversión); solo se completa su descripción si estaba vacía. Los nuevos quedan
// sin conversión (se agrega luego con "Agregar conversión").
// rows: [{ codigo, descripcion, _fila }]
// ======================================================================
function leerCodigosBase_(ws) {
  const res = { headers: [], porCodigo: {} };
  if (!ws || ws.getLastRow() < 1 || ws.getLastColumn() < 1) return res;
  res.headers = ws.getRange(1, 1, 1, ws.getLastColumn()).getValues()[0];
  const n = res.headers.map(function (h) { return normalizeText_(h); });
  const cCod = n.indexOf('codigo'), cDesc = n.indexOf('descripcion');
  if (cCod === -1 || ws.getLastRow() < 2) return res;
  ws.getRange(2, 1, ws.getLastRow() - 1, res.headers.length).getValues().forEach(function (r, i) {
    const c = normCodigo_(r[cCod]);
    if (c && !res.porCodigo[c]) res.porCodigo[c] = { fila: i + 2, descripcion: cDesc === -1 ? '' : String(r[cDesc] || '').trim() };
  });
  return res;
}

// Agrupa el archivo por código (un ingreso trae el mismo artículo en varias filas).
function analizarProductosBase_(rows) {
  const errores = [], porCodigo = {}, orden = [];
  let repetidas = 0, descDistinta = 0;
  (rows || []).forEach(function (r, i) {
    const cod = normCodigo_(r.codigo);
    const desc = String(r.descripcion === undefined || r.descripcion === null ? '' : r.descripcion).replace(/\s+/g, ' ').trim();
    if (!cod) { errores.push({ fila: r._fila || i + 1, motivo: 'Falta Nombre de artículo (código)', detalle: desc }); return; }
    if (porCodigo[cod]) {
      repetidas++;
      if (desc && porCodigo[cod].descripcion && desc.toUpperCase() !== porCodigo[cod].descripcion.toUpperCase()) descDistinta++;
      if (!porCodigo[cod].descripcion && desc) porCodigo[cod].descripcion = desc;
      return;
    }
    porCodigo[cod] = { codigo: cod, descripcion: desc, fila: r._fila || i + 1 };
    orden.push(cod);
  });
  return { errores: errores, porCodigo: porCodigo, orden: orden, repetidas: repetidas, descDistinta: descDistinta };
}

function api_validarProductosBase_(rows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const a = analizarProductosBase_(rows);
  const base = leerCodigosBase_(ss.getSheetByName(SH_BASE));
  const nuevos = [], completar = [];
  let existentes = 0, sinDesc = 0;
  a.orden.forEach(function (cod) {
    const p = a.porCodigo[cod], b = base.porCodigo[cod];
    if (!b) { nuevos.push(p); if (!p.descripcion) sinDesc++; }
    else if (!b.descripcion && p.descripcion) completar.push(p);
    else existentes++;
  });
  const avisos = [];
  if (existentes) avisos.push(existentes + ' código(s) ya están en la base: NO se modifican (se conserva su descripción y conversión).');
  if (completar.length) avisos.push(completar.length + ' código(s) ya están en la base pero sin descripción: se completa la descripción.');
  if (a.repetidas) avisos.push(a.repetidas + ' fila(s) repiten un código del mismo archivo: se agrega una sola vez.');
  if (a.descDistinta) avisos.push(a.descDistinta + ' código(s) aparecen con descripciones distintas: se usa la primera.');
  if (sinDesc) avisos.push(sinDesc + ' código(s) nuevos sin descripción: se agregan solo con el código.');
  if (nuevos.length) avisos.push('Los ' + nuevos.length + ' código(s) nuevos quedan SIN conversión: agrégala con "Agregar conversión" al imprimir o al confirmar.');
  return {
    total: (rows || []).length, validas: nuevos.length + completar.length,
    errores: a.errores.slice(0, 200), totalErrores: a.errores.length, avisos: avisos,
    lista: { titulo: 'Códigos nuevos que se agregan a la base', items: nuevos.slice(0, 300).map(function (p) { return p.codigo + (p.descripcion ? ' · ' + p.descripcion : ''); }), total: nuevos.length },
    nuevos: nuevos.length, completar: completar.length, existentes: existentes
  };
}

function api_cargarProductosBase_(rows, clave, archivo) {
  verificarClave_(clave);
  return conLock_(function () {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const ws = getOrCreateSheet_(ss, SH_BASE);
    if (ws.getLastRow() < 1 || ws.getLastColumn() < 1) {
      ws.getRange(1, 1, 1, 5).setValues([['Codigo', 'Descripcion', 'M2 x CJ', 'M2 x PE', 'CJ x PE']]).setFontWeight('bold');
    }
    // Asegura las columnas Codigo y Descripcion (sin mover las demás).
    let headers = ws.getRange(1, 1, 1, ws.getLastColumn()).getValues()[0];
    const col = function (nombre, titulo) {
      let i = headers.map(function (h) { return normalizeText_(h); }).indexOf(nombre);
      if (i === -1) { i = headers.length; ws.getRange(1, i + 1).setValue(titulo).setFontWeight('bold'); headers = headers.concat([titulo]); }
      return i;
    };
    const cCod = col('codigo', 'Codigo'), cDesc = col('descripcion', 'Descripcion');

    const a = analizarProductosBase_(rows);
    const base = leerCodigosBase_(ws);
    const nuevas = [];
    let completadas = 0, existentes = 0;
    a.orden.forEach(function (cod) {
      const p = a.porCodigo[cod], b = base.porCodigo[cod];
      if (!b) {
        const fila = headers.map(function () { return ''; });
        fila[cCod] = p.codigo;
        fila[cDesc] = p.descripcion;
        nuevas.push(fila);
      } else if (!b.descripcion && p.descripcion) {
        ws.getRange(b.fila, cDesc + 1).setValue(p.descripcion);
        completadas++;
      } else {
        existentes++;
      }
    });
    if (nuevas.length) {
      const fila0 = Math.max(ws.getLastRow(), 1) + 1;
      ws.getRange(fila0, cCod + 1, nuevas.length, 1).setNumberFormat('@'); // códigos como texto (ceros, letras)
      ws.getRange(fila0, 1, nuevas.length, headers.length).setValues(nuevas);
    }
    const cargaId = 'B' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd-HHmmss');
    registrarCarga_(ss, { cargaId: cargaId, tipo: 'BASE', archivo: archivo, nuevas: nuevas.length, actualizadas: completadas });
    registrarHistorial_('CARGA_BASE', (archivo || '-') + ': ' + nuevas.length + ' código(s) nuevos, ' + completadas + ' descripción(es) completadas, ' +
      existentes + ' ya existían (sin cambios)' + (a.errores.length ? ', ' + a.errores.length + ' fila(s) con error omitidas' : ''), cargaId);
    baseCambio_(); // la caché de conversiones/catálogo deja de usarse
    return { nuevos: nuevas.length, completadas: completadas, existentes: existentes, omitidas: a.errores.length };
  });
}

// Agrega o corrige la conversión de un código en la hoja "base" (pide contraseña).
// c: { codigo, descripcion, m2PorCaja, cjPorPallet }
function api_guardarConversion_(c, clave) {
  verificarClave_(clave);
  const codigo = normCodigo_(c && c.codigo);
  if (!codigo) throw new Error('Falta el código.');
  const m2PorCaja = Number(c.m2PorCaja) || 0;
  const cjPorPallet = Number(c.cjPorPallet) || 0;
  if (m2PorCaja < 0 || cjPorPallet < 0) throw new Error('La conversión no puede ser negativa.');
  return conLock_(function () {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const ws = getOrCreateSheet_(ss, SH_BASE);
    if (ws.getLastRow() < 1 || ws.getLastColumn() < 1) {
      ws.getRange(1, 1, 1, 5).setValues([['Codigo', 'Descripcion', 'M2 x CJ', 'M2 x PE', 'CJ x PE']]).setFontWeight('bold');
    }
    let headers = ws.getRange(1, 1, 1, ws.getLastColumn()).getValues()[0];
    const col = function (nombre, titulo) {
      let i = headers.map(function (h) { return normalizeText_(h); }).indexOf(nombre);
      if (i === -1) {
        i = headers.length;
        ws.getRange(1, i + 1).setValue(titulo).setFontWeight('bold');
        headers = headers.concat([titulo]);
      }
      return i;
    };
    const cCod = col('codigo', 'Codigo'), cDesc = col('descripcion', 'Descripcion');
    const cCj = col('m2 x cj', 'M2 x CJ'), cPe = col('m2 x pe', 'M2 x PE'), cCjPe = col('cj x pe', 'CJ x PE');
    const n = Math.max(ws.getLastRow() - 1, 0);
    const vals = n ? ws.getRange(2, 1, n, headers.length).getValues() : [];
    let i = vals.findIndex(function (r) { return normCodigo_(r[cCod]) === codigo; });
    const antes = i >= 0 ? { cj: vals[i][cCj], pe: vals[i][cPe] } : null;
    const fila = i >= 0 ? vals[i] : headers.map(function () { return ''; });
    fila[cCod] = codigo;
    if (c.descripcion && !String(fila[cDesc] || '').trim()) fila[cDesc] = String(c.descripcion);
    fila[cCj] = m2PorCaja || '';
    fila[cPe] = m2PorCaja && cjPorPallet ? Math.round(m2PorCaja * cjPorPallet * 10000) / 10000 : '';
    fila[cCjPe] = cjPorPallet || '';
    ws.getRange(i >= 0 ? i + 2 : n + 2, 1, 1, headers.length).setValues([fila]);
    registrarHistorial_('CONVERSION', codigo + ': M2 x CJ ' + (m2PorCaja || '-') + ', CJ x Pallet ' + (cjPorPallet || '-') +
      (antes ? ' (antes M2 x CJ ' + (antes.cj || '-') + ', M2 x PE ' + (antes.pe || '-') + ')' : ' (nuevo en base)'), codigo);
    baseCambio_(); // la caché de conversiones/catálogo deja de usarse
    return conversionBase_(codigo);
  });
}

// q = ancho de la etiqueta (la impresora centra la imagen si el rollo es más
// angosto que el cabezal); Q = alto + gap de 3 mm.
// El avance al terminar lo controla la impresora (Papel > Iniciar ajuste / Interrumpir ajuste);
// no se manda JF/JB para que no choque con esa configuración.
function opsAEpl_(ops, copias, ancho, alto) {
  const out = ['', 'N', 'q' + (ancho || ZEBRA_ANCHO), 'Q' + (alto || ZEBRA_ALTO) + ',24'];
  ops.forEach(function (o) {
    if (o.t === 'A') {
      if (!o.s) return;
      const linea = function (x, y) { return 'A' + x + ',' + y + ',' + (o.rot || 0) + ',' + o.f + ',' + o.mh + ',' + o.mv + ',' + (o.rev ? 'R' : 'N') + ',"' + o.s + '"'; };
      out.push(linea(o.x, o.y));
      // Negrita: se repite el texto corrido 2 puntos (en el papel, a lo largo del texto).
      if (o.negrita) out.push(o.rot === 1 ? linea(o.x, o.y + 2) : linea(o.x + 2, o.y));
    }
    else if (o.t === 'X') out.push('X' + o.x + ',' + o.y + ',' + o.w + ',' + o.x2 + ',' + o.y2);
    else if (o.t === 'LO') out.push('LO' + o.x + ',' + o.y + ',' + o.w + ',' + o.h);
  });
  out.push('P' + (copias || 1), '');
  return out.join('\r\n');
}