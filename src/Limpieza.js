// =====================================================================
// LIMPIEZA DE DATOS ANTIGUOS (botón del admin)
// ---------------------------------------------------------------------
// Pedido: la app trabaja solo con HOY y AYER. Lo anterior se borra de DATOS;
// queda el historial de etiquetas (HISTORIAL_ETIQUETAS) y un RESPALDO en Drive.
// Orden seguro: 1) copiar al respaldo, 2) verificar que la copia está completa,
// 3) recién entonces borrar. Si el respaldo falla, no se borra nada.
// La numeración ETQ continúa desde el mayor número borrado (ETQ_MAX_HISTORICO),
// así nunca se repite un número de una etiqueta anterior.
// =====================================================================

const LIMPIEZA_CARPETA = 'Packing List - Respaldos';
const PROP_ETQ_MAX = 'ETQ_MAX_HISTORICO';

/** Mayor número ETQ de líneas ya borradas (para no repetir numeración). */
function etqMaxHistorico_() {
  return Number(PropertiesService.getScriptProperties().getProperty(PROP_ETQ_MAX)) || 0;
}

function numeroEtq_(v) {
  v = String(v || '');
  if (v.indexOf('ETQ-') !== 0) return 0;
  const n = parseInt(v.substring(4), 10);
  return isNaN(n) ? 0 : n;
}

/** Inicio de AYER (00:00, zona del script): lo que se tocó desde ahí se conserva. */
function inicioAyer_() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 1);
  return d;
}

/** Una línea se conserva si se cargó o se actualizó desde ayer. Sin fecha = antigua. */
function seConserva_(fila, iFc, iAc, desde) {
  return [fila[iFc], fila[iAc]].some(function (v) { return v instanceof Date && v >= desde; });
}

function analizarLimpieza_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ws = ss.getSheetByName(SH_DATOS);
  if (!ws || ws.getLastRow() < 2) return { ws: ws, headers: [], conservar: [], borrar: [] };
  const lastCol = ws.getLastColumn();
  const headers = ws.getRange(1, 1, 1, lastCol).getValues()[0];
  const iFc = headers.indexOf('fechaCarga'), iAc = headers.indexOf('actualizadoEn');
  if (iFc < 0 || iAc < 0) throw new Error('La hoja DATOS no tiene las columnas fechaCarga / actualizadoEn: no se puede limpiar con seguridad.');
  const vals = ws.getRange(2, 1, ws.getLastRow() - 1, lastCol).getValues();
  const desde = inicioAyer_();
  const conservar = [], borrar = [];
  vals.forEach(function (f) { (seConserva_(f, iFc, iAc, desde) ? conservar : borrar).push(f); });
  return { ws: ws, headers: headers, conservar: conservar, borrar: borrar, desde: desde };
}

/** Paso 1: solo cuenta (no cambia nada). */
function api_limpiezaResumen_() {
  const a = analizarLimpieza_();
  const iEtq = a.headers.indexOf('nroEtiqueta'), iImp = a.headers.indexOf('fechaImpresion');
  const conEtq = a.borrar.filter(function (f) { return iEtq >= 0 && String(f[iEtq] || '').trim(); });
  const sinImprimir = conEtq.filter(function (f) { return iImp < 0 || !f[iImp]; });
  return {
    borrar: a.borrar.length,
    conservar: a.conservar.length,
    conEtiqueta: conEtq.length,
    etiquetasSinImprimir: Array.from(new Set(sinImprimir.map(function (f) { return String(f[iEtq]).trim(); }))).slice(0, 30),
    desde: a.desde ? Utilities.formatDate(a.desde, TZ, 'dd/MM/yyyy') : ''
  };
}

function hojaRespaldoMes_(headers) {
  const mes = Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
  const props = PropertiesService.getScriptProperties();
  const clave = 'RESPALDO_DATOS_' + mes;
  let libro = null;
  const id = props.getProperty(clave);
  if (id) {
    try {
      libro = SpreadsheetApp.openById(id);
      if (DriveApp.getFileById(id).isTrashed()) libro = null;
    } catch (e) { libro = null; }
  }
  if (!libro) {
    libro = SpreadsheetApp.create('Respaldo DATOS Packing List ' + mes);
    DriveApp.getFileById(libro.getId()).moveTo(getOrCreateDriveFolder_(LIMPIEZA_CARPETA));
    props.setProperty(clave, libro.getId());
  }
  let ws = libro.getSheetByName('DATOS');
  if (!ws) {
    ws = libro.getSheets()[0];
    ws.setName('DATOS');
  }
  if (ws.getLastRow() < 1) {
    ws.getRange(1, 1, 1, headers.length + 1).setValues([headers.concat(['respaldadoEn'])]).setFontWeight('bold');
    ws.setFrozenRows(1);
  }
  return { libro: libro, ws: ws };
}

/** Paso 2 (solo admin): respaldo verificado y luego borrado. */
function api_limpiarDatosAntiguos_() {
  return conLock_(function () {
    const a = analizarLimpieza_();
    if (!a.borrar.length) return { borradas: 0, conservadas: a.conservar.length, respaldoUrl: '', mensaje: 'No hay líneas antiguas para borrar.' };

    // 1) Respaldo en Drive (en tramos, para archivos grandes)
    const r = hojaRespaldoMes_(a.headers);
    const ahora = new Date();
    const antes = r.ws.getLastRow();
    const filas = a.borrar.map(function (f) { return f.concat([ahora]); });
    const TRAMO = 4000;
    for (let i = 0; i < filas.length; i += TRAMO) {
      const parte = filas.slice(i, i + TRAMO);
      r.ws.getRange(r.ws.getLastRow() + 1, 1, parte.length, parte[0].length).setValues(parte);
    }
    SpreadsheetApp.flush();
    // 2) Verificar que la copia está completa antes de borrar nada
    if (r.ws.getLastRow() - antes !== filas.length) {
      throw new Error('El respaldo no quedó completo (' + (r.ws.getLastRow() - antes) + ' de ' + filas.length + ' líneas). No se borró nada.');
    }

    // 3) Numeración ETQ: guardar el mayor número que se va a borrar
    const iEtq = a.headers.indexOf('nroEtiqueta');
    let maxBorrado = etqMaxHistorico_();
    if (iEtq >= 0) a.borrar.forEach(function (f) { maxBorrado = Math.max(maxBorrado, numeroEtq_(f[iEtq])); });
    PropertiesService.getScriptProperties().setProperty(PROP_ETQ_MAX, String(maxBorrado));

    // 4) Dejar en DATOS solo hoy y ayer (se reescribe de una vez; conserva formatos)
    const ws = a.ws, lastCol = a.headers.length, lastRow = ws.getLastRow();
    ws.getRange(2, 1, lastRow - 1, lastCol).clearContent();
    if (a.conservar.length) ws.getRange(2, 1, a.conservar.length, lastCol).setValues(a.conservar);
    SpreadsheetApp.flush();

    const url = r.libro.getUrl();
    registrarHistorial_('LIMPIEZA_DATOS', a.borrar.length + ' línea(s) anteriores al ' + Utilities.formatDate(a.desde, TZ, 'dd/MM/yyyy') +
      ' movidas al respaldo "' + r.libro.getName() + '"; quedan ' + a.conservar.length + '. ETQ continúa desde ' + maxBorrado + '.', r.libro.getId());
    return { borradas: a.borrar.length, conservadas: a.conservar.length, respaldoUrl: url, respaldoNombre: r.libro.getName(), etqDesde: maxBorrado };
  });
}
