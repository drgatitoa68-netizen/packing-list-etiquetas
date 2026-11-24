// =====================================================================
// DISEÑADOR DE ETIQUETAS: plantillas libres, códigos de barras e importación ZPL/EPL
// ---------------------------------------------------------------------
// - Un diseño = { ancho, alto, papel, elementos: [...] } en puntos (203 dpi).
// - Elementos: texto, barras (Code 128 / EAN-13 / Code 39), qr, linea, recuadro.
// - Se convierte a las mismas operaciones que el resto de la app (A / LO / X) y de
//   ahí a EPL con opsAEpl_, así la vista previa es exactamente lo que se imprime.
//   Los códigos de barras se dibujan como barras (LO), igual que el QR.
// - Plantillas en la hoja PLANTILLAS. Solo el admin crea/edita/borra; todos imprimen.
// - Campos variables {nombre} en textos y datos; {fecha}, {hora} y {usuario} se
//   llenan solos.
// =====================================================================

const SH_PLANTILLAS = 'PLANTILLAS';
const PLANTILLA_COLS = ['id', 'nombre', 'diseno', 'actualizadoEn', 'actualizadoPor'];
const DIS_MAX_ANCHO = 832;   // la PC43t imprime hasta 10,4 cm de ancho
const DIS_MAX_ALTO = 2400;   // 30 cm
const DIS_MAX_ELEM = 150;
const DIS_TIPOS = { texto: 1, barras: 1, qr: 1, linea: 1, recuadro: 1 };

// ---------------------------------------------------------------------
// Códigos de barras → módulos (1 = barra, 0 = espacio)
// ---------------------------------------------------------------------
const C128_ = ['212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112'];

function anchosAModulos_(anchos) {
  let s = '';
  for (let i = 0; i < anchos.length; i++) s += (i % 2 === 0 ? '1' : '0').repeat(Number(anchos[i]));
  return s;
}

/** Code 128 con cambio automático B / C (C para tramos de 4+ dígitos). */
function code128Modulos_(datos) {
  datos = String(datos);
  for (let i = 0; i < datos.length; i++) {
    const c = datos.charCodeAt(i);
    if (c < 32 || c > 126) throw new Error('Code 128 solo admite letras, números y signos comunes (sin tildes): "' + datos.charAt(i) + '"');
  }
  if (!datos) throw new Error('El código de barras está vacío.');
  const codigos = [];
  const esDig = function (i, n) { return /^\d+$/.test(datos.substr(i, n)) && datos.substr(i, n).length === n; };
  let i = 0, set = '';
  const inicioC = esDig(0, 4) || (datos.length >= 2 && /^\d+$/.test(datos) && datos.length % 2 === 0);
  if (inicioC) { codigos.push(105); set = 'C'; } else { codigos.push(104); set = 'B'; }
  while (i < datos.length) {
    if (set === 'C') {
      if (esDig(i, 2)) { codigos.push(Number(datos.substr(i, 2))); i += 2; continue; }
      codigos.push(100); set = 'B'; continue;
    }
    // en B: pasar a C si vienen 4+ dígitos (o el resto son dígitos pares, al menos 4)
    let run = 0;
    while (i + run < datos.length && /\d/.test(datos.charAt(i + run))) run++;
    if (run >= 4) { // 4+ dígitos seguidos: más corto en C (si es impar, el primero va en B)
      if (run % 2 === 1) { codigos.push(datos.charCodeAt(i) - 32); i++; }
      codigos.push(99); set = 'C'; continue;
    }
    codigos.push(datos.charCodeAt(i) - 32); i++;
  }
  let suma = codigos[0];
  for (let k = 1; k < codigos.length; k++) suma += codigos[k] * k;
  codigos.push(suma % 103, 106);
  return codigos.map(function (c) { return anchosAModulos_(C128_[c]); }).join('');
}

const EAN_L_ = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const EAN_PARIDAD_ = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

function eanDigitoControl_(doce) {
  let s = 0;
  for (let i = 0; i < 12; i++) s += Number(doce.charAt(i)) * (i % 2 ? 3 : 1);
  return String((10 - (s % 10)) % 10);
}

/** EAN-13: 12 dígitos (se calcula el control) o 13 (se verifica). */
function ean13Normalizar_(datos) {
  datos = String(datos).replace(/\s/g, '');
  if (!/^\d{12,13}$/.test(datos)) throw new Error('EAN-13 necesita 12 o 13 dígitos (tiene "' + datos + '").');
  const ctrl = eanDigitoControl_(datos.substring(0, 12));
  if (datos.length === 13 && datos.charAt(12) !== ctrl) throw new Error('EAN-13 "' + datos + '": el dígito de control debería ser ' + ctrl + '.');
  return datos.substring(0, 12) + ctrl;
}

function ean13Modulos_(datos) {
  const d = ean13Normalizar_(datos);
  const par = EAN_PARIDAD_[Number(d.charAt(0))];
  const R = function (n) { return EAN_L_[n].replace(/./g, function (b) { return b === '1' ? '0' : '1'; }); };
  let s = '101';
  for (let i = 1; i <= 6; i++) {
    const n = Number(d.charAt(i));
    s += par.charAt(i - 1) === 'L' ? EAN_L_[n] : R(n).split('').reverse().join('');
  }
  s += '01010';
  for (let i = 7; i <= 12; i++) s += R(Number(d.charAt(i)));
  return s + '101';
}

const C39_ = {
  '0': '101001101101', '1': '110100101011', '2': '101100101011', '3': '110110010101', '4': '101001101011',
  '5': '110100110101', '6': '101100110101', '7': '101001011011', '8': '110100101101', '9': '101100101101',
  'A': '110101001011', 'B': '101101001011', 'C': '110110100101', 'D': '101011001011', 'E': '110101100101',
  'F': '101101100101', 'G': '101010011011', 'H': '110101001101', 'I': '101101001101', 'J': '101011001101',
  'K': '110101010011', 'L': '101101010011', 'M': '110110101001', 'N': '101011010011', 'O': '110101101001',
  'P': '101101101001', 'Q': '101010110011', 'R': '110101011001', 'S': '101101011001', 'T': '101011011001',
  'U': '110010101011', 'V': '100110101011', 'W': '110011010101', 'X': '100101101011', 'Y': '110010110101',
  'Z': '100110110101', '-': '100101011011', '.': '110010101101', ' ': '100110101101', '$': '100100100101',
  '/': '100100101001', '+': '100101001001', '%': '101001001001', '*': '100101101101',
};

function code39Modulos_(datos) {
  datos = String(datos).toUpperCase();
  if (!datos) throw new Error('El código de barras está vacío.');
  if (datos.indexOf('*') !== -1) throw new Error('Code 39 no admite "*" dentro del código.');
  const partes = ['*'].concat(datos.split(''), ['*']).map(function (c) {
    if (!C39_[c]) throw new Error('Code 39 no admite el carácter "' + c + '".');
    return C39_[c];
  });
  return partes.join('0');
}

function modulosBarras_(simbologia, datos) {
  if (simbologia === 'ean13') return ean13Modulos_(datos);
  if (simbologia === 'code39') return code39Modulos_(datos);
  return code128Modulos_(datos);
}

/** Texto legible bajo el código (EAN-13 con su dígito de control). */
function textoLegible_(simbologia, datos) {
  return simbologia === 'ean13' ? ean13Normalizar_(datos) : String(datos);
}

// ---------------------------------------------------------------------
// Diseño → operaciones (A / LO / X) + caja de cada elemento
// ---------------------------------------------------------------------
const DIS_FECHA_ = function () { return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/Guayaquil', 'dd/MM/yyyy'); };
const DIS_HORA_ = function () { return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/Guayaquil', 'HH:mm'); };

function camposDiseno_(diseno) {
  const vistos = {}, lista = [];
  if (diseno.juego && diseno.juego.length) vistos.copia = true;   // lo llena el juego de copias
  (diseno.elementos || []).forEach(function (e) {
    String((e.tipo === 'texto' ? e.texto : e.datos) || '').replace(/\{([a-zA-Z0-9_]{1,30})\}/g, function (m, n) {
      if (!vistos[n] && ['fecha', 'hora', 'usuario'].indexOf(n) === -1) { vistos[n] = true; lista.push(n); }
      return m;
    });
  });
  return lista;
}

// En vista previa, un campo sin valor se muestra como {campo} para ver el diseño completo;
// al imprimir queda vacío (la página avisa antes si falta alguno).
function reemplazarCampos_(texto, valores, vista) {
  return String(texto || '').replace(/\{([a-zA-Z0-9_]{1,30})\}/g, function (m, n) {
    if (n === 'fecha') return DIS_FECHA_();
    if (n === 'hora') return DIS_HORA_();
    if (n === 'usuario') return USUARIO_ACTUAL_ || '';
    const v = valores && valores[n] !== undefined ? String(valores[n]) : '';
    return v === '' && vista ? m : v;
  });
}

const entero_ = function (v, min, max, def) {
  const n = Math.round(Number(v));
  return isNaN(n) ? def : Math.max(min, Math.min(max, n));
};

/** Valida y normaliza un diseño recibido del navegador (nunca confiar en él). */
function normalizarDiseno_(d) {
  d = d || {};
  const ancho = entero_(d.ancho, 80, DIS_MAX_ANCHO, ZEBRA_ANCHO);
  const alto = entero_(d.alto, 80, DIS_MAX_ALTO, ZEBRA_ALTO);
  const papel = entero_(d.papel || alto, alto, DIS_MAX_ALTO + 100, alto);
  const elementos = (Array.isArray(d.elementos) ? d.elementos : []).slice(0, DIS_MAX_ELEM)
    .filter(function (e) { return e && DIS_TIPOS[e.tipo]; })
    .map(function (e, i) {
      const base = { id: String(e.id || ('e' + i)).substring(0, 20), tipo: e.tipo,
        x: entero_(e.x, 0, ancho, 0), y: entero_(e.y, 0, papel, 0) };
      if (e.tipo === 'texto') {
        const lado = Math.max(ancho, papel);
        return Object.assign(base, { texto: String(e.texto || '').substring(0, 600), fuente: entero_(e.fuente, 1, 4, 3),
          mh: entero_(e.mh, 1, 8, 1), mv: entero_(e.mv, 1, 9, 1), invertido: !!e.invertido,
          // Giro 0/90/180/270 y "Ajustar al recuadro" (como Zebra Designer): w x h es el
          // recuadro tal como se ve en la etiqueta; el texto se reparte y elige su tamaño.
          rot: [0, 90, 180, 270].indexOf(Number(e.rot)) !== -1 ? Number(e.rot) : 0,
          ajustar: !!e.ajustar,
          w: entero_(e.w, 16, lado, 400), h: entero_(e.h, 12, lado, 80),
          alinear: ['izq', 'centro', 'der'].indexOf(e.alinear) !== -1 ? e.alinear : 'izq' });
      }
      if (e.tipo === 'barras') {
        const sim = ['code128', 'ean13', 'code39'].indexOf(e.simbologia) !== -1 ? e.simbologia : 'code128';
        return Object.assign(base, { datos: String(e.datos || '').substring(0, 120), simbologia: sim,
          modulo: entero_(e.modulo, 1, 6, 2), alto: entero_(e.alto, 20, 600, 100), legible: e.legible !== false });
      }
      if (e.tipo === 'qr') return Object.assign(base, { datos: String(e.datos || '').substring(0, 300), modulo: entero_(e.modulo, 2, 12, 4) });
      if (e.tipo === 'linea') return Object.assign(base, { w: entero_(e.w, 1, ancho, 200), h: entero_(e.h, 1, papel, 3) });
      return Object.assign(base, { w: entero_(e.w, 4, ancho, 200), h: entero_(e.h, 4, papel, 100), grosor: entero_(e.grosor, 1, 20, 2) });
    });
  // Juego de copias: la misma etiqueta se imprime una vez por leyenda (ej. ORIGINAL, COPIA) y la
  // leyenda llena el campo {copia}. Así se escriben los datos una sola vez y salen todas juntas.
  const juego = (Array.isArray(d.juego) ? d.juego : []).map(function (x) { return String(x || '').trim().substring(0, 40); })
    .filter(function (x) { return x; }).slice(0, 6);
  return { ancho: ancho, alto: alto, papel: papel, elementos: elementos, juego: juego };
}

// ---------------------------------------------------------------------
// Texto: varias líneas, "Ajustar al recuadro" y giro 0/90/180/270
// ---------------------------------------------------------------------
/** Reparte líneas en palabras para que ninguna pase de maxChars (corta palabras largas). */
function envolverTexto_(lineas, maxChars) {
  const out = [];
  lineas.forEach(function (l) {
    if (!l) { out.push(''); return; }
    let cur = '';
    l.split(' ').forEach(function (p) {
      while (p.length > maxChars) {
        if (cur) { out.push(cur); cur = ''; }
        out.push(p.substring(0, maxChars));
        p = p.substring(maxChars);
      }
      if (!p) return;
      if (!cur) cur = p;
      else if ((cur + ' ' + p).length <= maxChars) cur += ' ' + p;
      else { out.push(cur); cur = p; }
    });
    out.push(cur);
  });
  return out;
}

const DIS_INTERLINEA = 0.15; // espacio entre líneas (fracción del alto de la letra)

/**
 * Elige la letra más grande (fuente 1-4 y multiplicadores) con la que el texto, repartido
 * en líneas, entra en W x H. Proporción de la letra entre angosta (0,3) y ancha (1,1).
 */
function ajustarTexto_(lineas, W, H) {
  let mejor = null;
  [1, 2, 3, 4].forEach(function (f) {
    for (let mv = 1; mv <= 9; mv++) {
      const lh = EPL_ALTO[f] * mv;
      for (let mh = 1; mh <= 8; mh++) {
        const cw = EPL_PASO[f] * mh;
        const prop = cw / lh;
        if (prop < 0.3 || prop > 1.1) continue;
        const maxChars = Math.floor(W / cw);
        if (maxChars < 1) continue;
        const ls = envolverTexto_(lineas, maxChars);
        const alto = ls.length * lh + (ls.length - 1) * Math.round(lh * DIS_INTERLINEA);
        if (alto > H) continue;
        const puntaje = lh * cw; // tamaño de cada letra
        if (!mejor || puntaje > mejor.puntaje) mejor = { f: f, mh: mh, mv: mv, lineas: ls, puntaje: puntaje };
      }
    }
  });
  return mejor;
}

/**
 * Texto → operaciones A. La caja (x, y, w, h) es lo que se ve en la etiqueta. El texto se
 * arma "derecho" en su propio marco y luego se gira alrededor del punto de inicio, igual
 * que la impresora: 90° empieza arriba a la derecha (comprobado en la PC43t con la
 * etiqueta de pallet), 180° abajo a la derecha y 270° abajo a la izquierda.
 */
function textoAOps_(e, texto) {
  const r = Number(e.rot) || 0, giro = r / 90, vertical = giro % 2 === 1;
  let lineas = String(texto || '').split(/\r?\n/).map(function (l) { return eplTexto_(l); });
  while (lineas.length > 1 && !lineas[lineas.length - 1]) lineas.pop();
  let f = e.fuente, mh = e.mh, mv = e.mv, aviso = '';
  // Marco propio del texto (sin girar)
  let W, H;
  if (e.ajustar) {
    W = vertical ? e.h : e.w;
    H = vertical ? e.w : e.h;
    const a = lineas.join('') ? ajustarTexto_(lineas, W, H) : null;
    if (a) { f = a.f; mh = a.mh; mv = a.mv; lineas = a.lineas; }
    else if (lineas.join('')) {
      f = 1; mh = 1; mv = 1;
      const maxChars = Math.max(1, Math.floor(W / EPL_PASO[1]));
      lineas = envolverTexto_(lineas, maxChars);
      const caben = Math.max(1, Math.floor((H + Math.round(EPL_ALTO[1] * DIS_INTERLINEA)) / (EPL_ALTO[1] * (1 + DIS_INTERLINEA))));
      if (lineas.length > caben) { lineas = lineas.slice(0, caben); aviso = 'El texto no cabe en su recuadro: agrándalo (se cortaron líneas).'; }
    }
  }
  const lh = EPL_ALTO[f] * mv, cw = EPL_PASO[f] * mh, gap = Math.round(lh * DIS_INTERLINEA);
  const anchoMax = lineas.reduce(function (m, l) { return Math.max(m, l.length * cw); }, 0);
  if (!e.ajustar) { W = Math.max(anchoMax, 20); H = lineas.length * lh + (lineas.length - 1) * gap; }
  const altoTexto = lineas.length * lh + (lineas.length - 1) * gap;
  const y0 = e.ajustar ? Math.max(0, Math.floor((H - altoTexto) / 2)) : 0; // centrado vertical en el recuadro
  // Caja en la etiqueta (girada si es vertical)
  const cw2 = vertical ? H : W, ch2 = vertical ? W : H;
  const ops = [];
  lineas.forEach(function (l, i) {
    if (!l) return;
    const ancho = l.length * cw;
    const lx = e.alinear === 'centro' ? Math.floor((W - ancho) / 2) : e.alinear === 'der' ? W - ancho : 0;
    const ly = y0 + i * (lh + gap);
    // Punto de inicio del texto en la etiqueta según el giro
    let x, y;
    if (giro === 0) { x = e.x + lx; y = e.y + ly; }
    else if (giro === 1) { x = e.x + cw2 - ly; y = e.y + lx; }
    else if (giro === 2) { x = e.x + W - lx; y = e.y + H - ly; }
    else { x = e.x + ly; y = e.y + ch2 - lx; }
    ops.push({ t: 'A', x: Math.round(x), y: Math.round(y), f: f, mh: mh, mv: mv, s: l, rev: e.invertido, rot: giro });
  });
  return { ops: ops, caja: { id: e.id, x: e.x, y: e.y, w: cw2, h: ch2, ajuste: { fuente: f, mh: mh, mv: mv } }, aviso: aviso };
}

/**
 * La PC43t aplica los multiplicadores de un texto girado 90/270° sobre los ejes del PAPEL
 * (comprobado con la etiqueta de pallet): hay que intercambiarlos solo para imprimir.
 * La vista previa usa los de la letra (como se ve).
 */
function opsParaImpresora_(ops) {
  return ops.map(function (o) {
    if (o.t === 'A' && (o.rot === 1 || o.rot === 3)) return Object.assign({}, o, { mh: o.mv, mv: o.mh });
    return o;
  });
}

/**
 * Convierte el diseño en operaciones de impresión. Devuelve también la caja de
 * cada elemento (para seleccionarlo y moverlo en el lienzo) y los avisos.
 */
function disenoAOps_(diseno, valores, vista) {
  const d = normalizarDiseno_(diseno);
  const ops = [], cajas = [], avisos = [];
  d.elementos.forEach(function (e) {
    try {
      if (e.tipo === 'texto') {
        const t = textoAOps_(e, reemplazarCampos_(e.texto, valores, vista));
        t.ops.forEach(function (o) { ops.push(o); });
        cajas.push(t.caja);
        if (t.aviso) avisos.push(t.aviso);
      } else if (e.tipo === 'barras') {
        const datos = reemplazarCampos_(e.datos, valores, vista);
        const mods = modulosBarras_(e.simbologia, datos);
        let k = 0;
        while (k < mods.length) {
          if (mods.charAt(k) !== '1') { k++; continue; }
          let fin = k;
          while (fin + 1 < mods.length && mods.charAt(fin + 1) === '1') fin++;
          ops.push({ t: 'LO', x: e.x + k * e.modulo, y: e.y, w: (fin - k + 1) * e.modulo, h: e.alto });
          k = fin + 1;
        }
        const ancho = mods.length * e.modulo;
        let alto = e.alto;
        if (e.legible) {
          const leg = eplTexto_(textoLegible_(e.simbologia, datos));
          const f = e.modulo >= 3 ? 3 : 2;
          const wl = leg.length * EPL_PASO[f];
          ops.push({ t: 'A', x: e.x + Math.max(0, Math.floor((ancho - wl) / 2)), y: e.y + e.alto + 4, f: f, mh: 1, mv: 1, s: leg });
          alto += 4 + EPL_ALTO[f];
        }
        cajas.push({ id: e.id, x: e.x, y: e.y, w: ancho, h: alto });
        if (e.x + ancho > d.ancho) avisos.push('El código de barras "' + datos + '" se sale por la derecha: achica el módulo o muévelo.');
        if (e.x < 10 || d.ancho - (e.x + ancho) < 10) avisos.push('Deja margen blanco a los lados del código "' + datos + '" para que el lector lo tome bien.');
      } else if (e.tipo === 'qr') {
        const datos = reemplazarCampos_(e.datos, valores, vista);
        if (!datos) throw new Error('El QR está vacío.');
        const q = qrOps_(datos, e.x, e.y, e.modulo);
        q.ops.forEach(function (o) { ops.push(o); });
        cajas.push({ id: e.id, x: e.x, y: e.y, w: q.lado, h: q.lado });
      } else if (e.tipo === 'linea') {
        ops.push({ t: 'LO', x: e.x, y: e.y, w: e.w, h: e.h });
        cajas.push({ id: e.id, x: e.x, y: e.y, w: e.w, h: Math.max(e.h, 6) });
      } else {
        ops.push({ t: 'X', x: e.x, y: e.y, w: e.grosor, x2: e.x + e.w, y2: e.y + e.h });
        cajas.push({ id: e.id, x: e.x, y: e.y, w: e.w, h: e.h });
      }
      const c = cajas[cajas.length - 1];
      if (c.y < EPL_TOP) avisos.push('Un elemento empieza en la zona de corte de arriba (~2 mm): puede salir cortado.');
      if (c.x + c.w > d.ancho || c.y + c.h > d.papel) avisos.push('Un elemento se sale de la etiqueta.');
    } catch (err) {
      avisos.push(err.message);
      cajas.push({ id: e.id, x: e.x, y: e.y, w: 120, h: 40, error: true });
    }
  });
  return { diseno: d, ops: ops, cajas: cajas, avisos: avisos.filter(function (a, i, arr) { return arr.indexOf(a) === i; }) };
}

/** Vista previa / impresión de una etiqueta libre. */
function api_etiquetaLibre_(diseno, valores, copias, imprimir, nombre) {
  valores = valores || {};
  const juego = normalizarDiseno_(diseno).juego;
  const conCopia = function (l) { return l ? Object.assign({}, valores, { copia: l }) : valores; };
  // Vista previa: la primera leyenda del juego. Impresión: una etiqueta por leyenda, en orden.
  const r = disenoAOps_(diseno, conCopia(juego[0]), !imprimir);
  copias = entero_(copias, 1, 100, 1);
  const eplLista = (juego.length ? juego : [null]).map(function (l, i) {
    const ops = i === 0 ? r.ops : disenoAOps_(diseno, conCopia(l), !imprimir).ops;
    return opsAEpl_(opsParaImpresora_(ops), copias, r.diseno.ancho, r.diseno.papel);
  });
  const epl = eplLista.join('');
  if (imprimir) {
    const titulo = String(nombre || 'Etiqueta libre').substring(0, 60);
    registrarHistorial_('IMPRIMIR_LIBRE', titulo + ' · ' + (juego.length ? 'juego ' + juego.join(' + ') + ' · ' : '') + copias + ' copia(s)', titulo);
    const resumen = (r.diseno.elementos || []).filter(function (e) { return e.tipo === 'texto'; })
      .map(function (e) { return reemplazarCampos_(e.texto, valores); }).join(' | ').substring(0, 500);
    registrarEtiquetasGeneradas_([[new Date(), USUARIO_ACTUAL_ || '', 'LIBRE', titulo, copias + ' copia(s)', '', '', '',
      Math.round(r.diseno.ancho / 8) + 'x' + Math.round(r.diseno.alto / 8) + 'mm', r.diseno.elementos.length, '', '', '', resumen]]);
  }
  return { epl: epl, eplLista: eplLista, juego: juego, ops: r.ops, cajas: r.cajas, avisos: r.avisos, campos: camposDiseno_(r.diseno),
    ancho: r.diseno.ancho, alto: r.diseno.papel, diseno: r.diseno };
}

// ---------------------------------------------------------------------
// Plantillas (hoja PLANTILLAS)
// ---------------------------------------------------------------------
function hojaPlantillas_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let ws = ss.getSheetByName(SH_PLANTILLAS);
  if (!ws) {
    ws = ss.insertSheet(SH_PLANTILLAS);
    ws.getRange(1, 1, 1, PLANTILLA_COLS.length).setValues([PLANTILLA_COLS]).setFontWeight('bold');
    ws.setFrozenRows(1);
  }
  return ws;
}

// ---------------------------------------------------------------------
// Plantillas ya definidas: se agregan solas una vez a la hoja PLANTILLAS (si alguien la borra,
// no vuelve). Quedan como cualquier otra: el admin puede editarlas.
// ---------------------------------------------------------------------
/**
 * Transferencia entre CEDIs: rollo 10,4 x 15,4 cm, juego ORIGINAL + COPIA (cada una a página completa).
 * Formato de casillas: cada dato en su recuadro, con su título arriba; el valor se ajusta solo a su casilla
 * (corto = grande, largo = más chico o en 2 líneas), así datos de distinto largo no se amontonan.
 */
function plantillaTransferenciaCedis_() {
  let n = 0;
  const id = function () { return 't' + (n++); };
  const e = [];
  const T = function (x, y, w, h, texto, o) {
    e.push(Object.assign({ id: id(), tipo: 'texto', x: x, y: y, w: w, h: h, texto: texto, ajustar: true, alinear: 'izq', rot: 0 }, o || {}));
  };
  const caja = function (x, y, w, h) { e.push({ id: id(), tipo: 'recuadro', x: x, y: y, w: w, h: h, grosor: 2 }); };
  const TITULO = { ajustar: false, fuente: 2, mh: 1, mv: 1 };   // título de casilla: siempre el mismo tamaño (12 x 16 pt)
  // Casilla: recuadro + título + valor ajustado al espacio que queda
  const celda = function (x, y, w, h, titulo, valor, alinear) {
    caja(x, y, w, h);
    T(x + 10, y + 8, w - 20, 16, titulo, TITULO);
    T(x + 10, y + 30, w - 20, h - 38, valor, { alinear: alinear || 'izq' });
  };
  const X = 16, W = 800;
  // Encabezado
  e.push({ id: id(), tipo: 'linea', x: X, y: 24, w: W, h: 72 });
  T(X + 12, 28, W - 24, 64, '{copia}', { alinear: 'centro', invertido: true });
  T(X, 104, W, 34, 'TRANSFERENCIA ENTRE CEDIS', { alinear: 'centro' });
  // Casillas (ancho total 800)
  let y = 146;
  celda(X, y, 400, 112, 'CEDI ORIGEN', '{cediOrigen}'); celda(X + 400, y, 400, 112, 'CEDI DESTINO', '{cediDestino}'); y += 112;
  celda(X, y, 300, 88, 'N. TRANSFERENCIA', '{nroTransferencia}'); celda(X + 300, y, 300, 88, 'N. ENVIO', '{nroEnvio}');
  celda(X + 600, y, 200, 88, 'FECHA', '{fecha} {hora}', 'centro'); y += 88;
  celda(X, y, 300, 88, 'ARTICULO', '{articulo}'); celda(X + 300, y, 300, 88, 'LOTE', '{lote}'); celda(X + 600, y, 200, 88, 'UNIDAD', '{um}', 'centro'); y += 88;
  celda(X, y, W, 120, 'DESCRIPCION', '{descripcion}'); y += 120;
  celda(X, y, 400, 100, 'PALLETS', '{nroPallets}', 'centro'); celda(X + 400, y, 400, 100, 'CAJAS', '{cajas}', 'centro'); y += 100;
  celda(X, y, 400, 96, 'CHOFER', '{chofer}'); celda(X + 400, y, 200, 96, 'CEDULA', '{cedula}', 'centro');
  celda(X + 600, y, 200, 96, 'PLACA', '{placa}', 'centro'); y += 96;
  celda(X, y, W, 140, 'OBSERVACIONES', '{observaciones}'); y += 140;
  // Firmas: entrega la bodega y el chofer recibe la carga
  const fw = W / 2, firmas = [['ENTREGA (BODEGA)', '{usuario}'], ['CHOFER', 'C.I. {cedula}']];
  firmas.forEach(function (f, i) {
    const fx = X + i * fw;
    caja(fx, y, fw, 240);
    T(fx + 10, y + 8, fw - 20, 16, f[0], TITULO);
    e.push({ id: id(), tipo: 'linea', x: fx + 20, y: y + 186, w: fw - 40, h: 2 });
    T(fx + 10, y + 194, fw - 20, 36, f[1], { alinear: 'centro' });
  });
  y += 240;
  return { ancho: 832, alto: 1232, papel: 1232, elementos: e,
    juego: ['ORIGINAL', 'COPIA - RESPALDO DE BODEGA'] };
}
// clave nueva = versión nueva del diseño: reemplaza la anterior en la hoja solo si nadie la editó (actualizadoPor = 'App').
const PLANTILLAS_DEFINIDAS_ = [{ clave: 'transferenciaCedis_v4', id: 'PTRANSCEDI', nombre: 'Transferencia entre CEDIs (original + copia)', diseno: plantillaTransferenciaCedis_ }];
function sembrarPlantillasDefinidas_() {
  const props = PropertiesService.getScriptProperties();
  const faltan = PLANTILLAS_DEFINIDAS_.filter(function (p) { return !props.getProperty('plantilla_' + p.clave); });
  if (!faltan.length) return;
  conLock_(function () {
    const ws = hojaPlantillas_();
    const n = Math.max(ws.getLastRow() - 1, 0);
    const filas = n ? ws.getRange(2, 1, n, PLANTILLA_COLS.length).getValues() : [];
    faltan.forEach(function (p) {
      if (props.getProperty('plantilla_' + p.clave)) return;
      const fila = [p.id, p.nombre, JSON.stringify(normalizarDiseno_(p.diseno())), new Date(), 'App'];
      const i = filas.findIndex(function (r) { return String(r[0]) === p.id; });
      if (i >= 0) { if (String(filas[i][4]) === 'App') ws.getRange(i + 2, 1, 1, PLANTILLA_COLS.length).setValues([fila]); }   // versión anterior sin editar: se actualiza
      else if (!filas.some(function (r) { return String(r[1]).toLowerCase() === p.nombre.toLowerCase(); }))
        ws.getRange(ws.getLastRow() + 1, 1, 1, PLANTILLA_COLS.length).setValues([fila]);
      props.setProperty('plantilla_' + p.clave, 'SI');
    });
  });
}

function api_plantillasListar_() {
  try { sembrarPlantillasDefinidas_(); } catch (e) { console.error('Plantillas definidas: ' + e); }
  const ws = hojaPlantillas_();
  if (ws.getLastRow() < 2) return [];
  return ws.getRange(2, 1, ws.getLastRow() - 1, PLANTILLA_COLS.length).getValues()
    .filter(function (r) { return r[0]; })
    .map(function (r) {
      let diseno = null;
      try { diseno = normalizarDiseno_(JSON.parse(String(r[2]))); } catch (e) { diseno = null; }
      return { id: String(r[0]), nombre: String(r[1]), diseno: diseno, actualizadoEn: textoCelda_(r[3], 'fecha'), actualizadoPor: String(r[4] || '') };
    })
    .filter(function (p) { return p.diseno; })
    .sort(function (a, b) { return a.nombre.localeCompare(b.nombre); });
}

function api_plantillaGuardar_(datos) {
  datos = datos || {};
  const nombre = String(datos.nombre || '').trim().substring(0, 60);
  if (!nombre) throw new Error('Ponle un nombre a la plantilla.');
  const diseno = normalizarDiseno_(datos.diseno);
  if (!diseno.elementos.length) throw new Error('La plantilla no tiene elementos.');
  const json = JSON.stringify(diseno);
  if (json.length > 45000) throw new Error('La plantilla es demasiado grande.');
  return conLock_(function () {
    const ws = hojaPlantillas_();
    const n = Math.max(ws.getLastRow() - 1, 0);
    const filas = n ? ws.getRange(2, 1, n, 2).getValues() : [];
    let id = String(datos.id || '');
    let fila = -1;
    filas.forEach(function (r, i) {
      if (id && String(r[0]) === id) fila = i;
      else if (!id && String(r[1]).toLowerCase() === nombre.toLowerCase()) throw new Error('Ya existe una plantilla llamada "' + nombre + '".');
    });
    if (id && fila === -1) throw new Error('La plantilla ya no existe (recarga la lista).');
    if (!id) id = 'P' + Utilities.getUuid().replace(/-/g, '').substring(0, 10);
    const valores = [[id, nombre, json, new Date(), USUARIO_ACTUAL_ || '']];
    ws.getRange(fila === -1 ? ws.getLastRow() + 1 : fila + 2, 1, 1, PLANTILLA_COLS.length).setValues(valores);
    registrarHistorial_(fila === -1 ? 'PLANTILLA_CREADA' : 'PLANTILLA_EDITADA', nombre + ' · ' + diseno.elementos.length + ' elemento(s)', id);
    return { id: id, nombre: nombre };
  });
}

function api_plantillaEliminar_(id) {
  id = String(id || '');
  return conLock_(function () {
    const ws = hojaPlantillas_();
    const n = Math.max(ws.getLastRow() - 1, 0);
    const filas = n ? ws.getRange(2, 1, n, 2).getValues() : [];
    for (let i = 0; i < filas.length; i++) {
      if (String(filas[i][0]) === id) {
        ws.deleteRow(i + 2);
        registrarHistorial_('PLANTILLA_ELIMINADA', String(filas[i][1]), id);
        return { ok: true };
      }
    }
    throw new Error('La plantilla ya no existe.');
  });
}

// ---------------------------------------------------------------------
// Importar formatos ZPL / EPL → diseño editable
// ---------------------------------------------------------------------
/** Elige la fuente EPL (1-4) y los multiplicadores más parecidos a un alto/ancho de carácter. */
function fuenteParecida_(altoPts, anchoCaracter) {
  let mejor = { f: 3, mv: 1, err: 1e9 };
  [1, 2, 3, 4].forEach(function (f) {
    const mv = Math.max(1, Math.min(9, Math.round(altoPts / EPL_ALTO[f])));
    const err = Math.abs(EPL_ALTO[f] * mv - altoPts);
    if (err < mejor.err) mejor = { f: f, mv: mv, err: err };
  });
  const anchoObj = anchoCaracter || altoPts * 0.6;
  const mh = Math.max(1, Math.min(8, Math.round(anchoObj / EPL_PASO[mejor.f])));
  return { fuente: mejor.f, mv: mejor.mv, mh: mh };
}

function api_importarFormato_(codigo) {
  codigo = String(codigo || '').substring(0, 60000);
  if (!codigo.trim()) throw new Error('Pega el código ZPL o EPL de la etiqueta.');
  const esZpl = /\^XA/i.test(codigo) || /\^FO|\^FD/i.test(codigo);
  const r = esZpl ? importarZpl_(codigo) : importarEpl_(codigo);
  r.diseno = normalizarDiseno_(r.diseno);
  r.formato = esZpl ? 'ZPL' : 'EPL';
  r.campos = camposDiseno_(r.diseno);
  return r;
}

function importarZpl_(codigo) {
  const avisos = [];
  const partes = codigo.split(/\^XZ/i);
  if (partes.filter(function (p) { return /\^XA/i.test(p); }).length > 1) avisos.push('El archivo trae varias etiquetas: se importó la primera.');
  const zpl = partes[0];
  const el = [];
  let ancho = ZEBRA_ANCHO, alto = 0, lhX = 0, lhY = 0, x = 0, y = 0, base = false;
  let fuenteAlto = 30, fuenteAncho = 0, porDefecto = { h: 30, w: 0 }, giroTxt = 0;
  const GIROS_ZPL = { N: 0, R: 90, I: 180, B: 270 };
  let by = { modulo: 2, alto: 100 }, barra = null, reverso = false, hex = false, bloque = null, copias = 1;
  const ignorados = {};
  const cmdRe = /[\^~]([A-Z@][A-Z0-9@]?)([^\^~]*)/gi;
  let m;
  const nuevoId = function () { return 'z' + el.length; };
  while ((m = cmdRe.exec(zpl))) {
    let cmd = m[1].toUpperCase(), arg = m[2];
    // ^A<fuente><orientación>,alto,ancho  (ej. ^A0N,30,25)
    if (cmd.charAt(0) === 'A' && cmd !== 'A@' && cmd.length === 2 && cmd !== 'AB') {
      const p = (cmd.substring(1) + arg).split(',');
      const orient = (p[0].charAt(1) || 'N').toUpperCase();
      giroTxt = GIROS_ZPL[orient] || 0; // R = 90°, I = 180°, B = 270°
      fuenteAlto = Number(p[1]) || porDefecto.h; fuenteAncho = Number(p[2]) || 0;
      continue;
    }
    const p = arg.split(',');
    switch (cmd) {
      case 'XA': case 'FS': case 'CI': case 'PR': case 'MD': case 'PO': case 'PM': case 'LR': case 'MN': case 'MT': case 'JM': case 'FX': case 'MM': case 'LT': case 'PF':
        if (cmd === 'FS') { barra = null; reverso = false; hex = false; bloque = null; giroTxt = 0; }
        break;
      case 'PW': ancho = Number(p[0]) || ancho; break;
      case 'LL': alto = Number(p[0]) || alto; break;
      case 'LH': lhX = Number(p[0]) || 0; lhY = Number(p[1]) || 0; break;
      case 'PQ': copias = Number(p[0]) || 1; break;
      case 'CF': porDefecto = { h: Number(p[1]) || porDefecto.h, w: Number(p[2]) || 0 }; fuenteAlto = porDefecto.h; fuenteAncho = porDefecto.w; break;
      case 'FO': x = (Number(p[0]) || 0) + lhX; y = (Number(p[1]) || 0) + lhY; base = false; break;
      case 'FT': x = (Number(p[0]) || 0) + lhX; y = (Number(p[1]) || 0) + lhY; base = true; break;
      case 'BY': by = { modulo: Number(p[0]) || by.modulo, alto: Number(p[2]) || by.alto }; break;
      case 'FR': reverso = true; break;
      case 'FH': hex = true; break;
      case 'FB': bloque = { ancho: Number(p[0]) || 0, alineacion: (p[3] || 'L').toUpperCase() }; break;
      case 'BC': case 'BE': case 'B3': case 'BQ': {
        const sim = cmd === 'BE' ? 'ean13' : cmd === 'B3' ? 'code39' : cmd === 'BQ' ? 'qr' : 'code128';
        if ((p[0] || 'N').toUpperCase().charAt(0) !== 'N' && sim !== 'qr') avisos.push('Hay códigos de barras girados: se importaron horizontales.');
        if (sim === 'qr') barra = { sim: 'qr', modulo: Number(p[2]) || 4 };
        else {
          const idxAlto = cmd === 'B3' ? 2 : 1, idxLeg = cmd === 'B3' ? 3 : 2;
          barra = { sim: sim, alto: Number(p[idxAlto]) || by.alto, legible: (p[idxLeg] || 'Y').toUpperCase() !== 'N' };
        }
        break;
      }
      case 'GB': {
        const w = Number(p[0]) || 1, h = Number(p[1]) || 1, t = Number(p[2]) || 1;
        if (t >= Math.min(w, h)) el.push({ id: nuevoId(), tipo: 'linea', x: x, y: y, w: w, h: h });
        else el.push({ id: nuevoId(), tipo: 'recuadro', x: x, y: y, w: w, h: h, grosor: t });
        break;
      }
      case 'FD': case 'FV': {
        let dato = arg;
        if (hex) dato = dato.replace(/_([0-9A-Fa-f]{2})/g, function (s, h) { return String.fromCharCode(parseInt(h, 16)); });
        if (barra && barra.sim === 'qr') {
          dato = dato.replace(/^[LMQH][AM],/i, '');
          el.push({ id: nuevoId(), tipo: 'qr', x: x, y: y, datos: dato, modulo: Math.max(2, Math.min(12, barra.modulo)) });
        } else if (barra) {
          el.push({ id: nuevoId(), tipo: 'barras', x: x, y: base ? Math.max(0, y - barra.alto) : y, datos: dato, simbologia: barra.sim,
            modulo: Math.max(1, Math.min(6, by.modulo)), alto: barra.alto, legible: barra.legible });
        } else {
          const f = fuenteParecida_(fuenteAlto, fuenteAncho ? fuenteAncho * 0.6 : 0);
          let tx = x;
          const anchoTxt = eplTexto_(dato).length * EPL_PASO[f.fuente] * f.mh;
          if (bloque && bloque.ancho) {
            if (bloque.alineacion === 'C') tx = x + Math.max(0, Math.floor((bloque.ancho - anchoTxt) / 2));
            else if (bloque.alineacion === 'R') tx = x + Math.max(0, bloque.ancho - anchoTxt);
          }
          el.push({ id: nuevoId(), tipo: 'texto', x: tx, y: base ? Math.max(0, y - EPL_ALTO[f.fuente] * f.mv) : y, texto: dato,
            fuente: f.fuente, mh: f.mh, mv: f.mv, invertido: reverso, rot: giroTxt });
        }
        break;
      }
      case 'GF': case 'XG': case 'IM': avisos.push('El formato tiene una imagen o logo (^' + cmd + '): no se importa; agrégala como texto o pide el logo aparte.'); break;
      default: ignorados[cmd] = true;
    }
  }
  const lista = Object.keys(ignorados);
  if (lista.length) avisos.push('Comandos no usados: ' + lista.map(function (c) { return '^' + c; }).join(' ') + '.');
  avisos.push('Revisa tamaños y posiciones: la PC43t usa sus propias fuentes (EPL), los textos pueden quedar un poco distintos.');
  if (!alto) alto = Math.max(ZEBRA_ALTO, el.reduce(function (mx, e) { return Math.max(mx, e.y + (e.h || e.alto || 60)); }, 0) + 20);
  return { diseno: { ancho: Math.min(ancho, DIS_MAX_ANCHO), alto: alto, papel: alto, elementos: el }, avisos: avisos, copias: copias };
}

function importarEpl_(codigo) {
  const avisos = [], el = [];
  let ancho = ZEBRA_ANCHO, alto = ZEBRA_ALTO, papel = 0, copias = 1;
  const ignorados = {};
  const texto = function (s) { const m = s.match(/"((?:[^"\\]|\\.)*)"/); return m ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : ''; };
  String(codigo).split(/\r?\n/).forEach(function (linea) {
    const l = linea.trim();
    if (!l || l.charAt(0) === ';') return;
    const cmd = (l.match(/^([A-Za-z]{1,2})/) || ['', ''])[1];
    const p = l.substring(cmd.length).split(',');
    const id = 'p' + el.length;
    if (cmd === 'N' || cmd === 'O' || cmd === 'D' || cmd === 'S' || cmd === 'ZT' || cmd === 'ZB' || cmd === 'I') return;
    if (cmd === 'JF' || cmd === 'JB') { avisos.push('Se quitó ' + cmd + ': el avance lo controla la impresora.'); return; }
    if (cmd === 'q') { ancho = Number(p[0]) || ancho; return; }
    if (cmd === 'Q') { papel = Number(p[0]) || papel; return; }
    if (cmd === 'P') { copias = Number(p[0]) || 1; return; }
    if (cmd === 'A') {
      const fuente = Number(p[3]);
      const fu = fuente >= 1 && fuente <= 4 ? fuente : 3;
      const giro = [0, 1, 2, 3].indexOf(Number(p[2])) !== -1 ? Number(p[2]) : 0;
      // En EPL girado 90/270° los multiplicadores van en ejes del papel: se pasan a los de la letra
      const gmh = giro % 2 ? (Number(p[5]) || 1) : (Number(p[4]) || 1);
      const gmv = giro % 2 ? (Number(p[4]) || 1) : (Number(p[5]) || 1);
      const s = texto(l);
      const wT = eplTexto_(s).length * EPL_PASO[fu] * gmh, hT = EPL_ALTO[fu] * gmv;
      const ax = Number(p[0]) || 0, ay = Number(p[1]) || 0;
      // Punto de inicio EPL -> esquina superior izquierda del recuadro en la etiqueta
      const xy = giro === 1 ? [ax - hT, ay] : giro === 2 ? [ax - wT, ay - hT] : giro === 3 ? [ax, ay - wT] : [ax, ay];
      el.push({ id: id, tipo: 'texto', x: Math.max(0, xy[0]), y: Math.max(0, xy[1]), texto: s,
        fuente: fu, mh: gmh, mv: gmv, invertido: String(p[6]).trim() === 'R', rot: giro * 90 });
      if (!(fuente >= 1 && fuente <= 4)) avisos.push('Fuente EPL ' + p[3] + ' no disponible: se usó la 3.');
      return;
    }
    if (cmd === 'LO' || cmd === 'LE' || cmd === 'LW') {
      el.push({ id: id, tipo: 'linea', x: Number(p[0]) || 0, y: Number(p[1]) || 0, w: Number(p[2]) || 1, h: Number(p[3]) || 1 });
      return;
    }
    if (cmd === 'X') {
      el.push({ id: id, tipo: 'recuadro', x: Number(p[0]) || 0, y: Number(p[1]) || 0, grosor: Number(p[2]) || 1,
        w: (Number(p[3]) || 0) - (Number(p[0]) || 0), h: (Number(p[4]) || 0) - (Number(p[1]) || 0) });
      return;
    }
    if (cmd === 'B') {
      const sel = String(p[3] || '1').trim().toUpperCase();
      const sim = sel.indexOf('E30') === 0 ? 'ean13' : sel === '3' || sel === '3C' ? 'code39' : 'code128';
      if (sim === 'code128' && sel.charAt(0) !== '1') avisos.push('Código de barras tipo ' + sel + ' importado como Code 128.');
      el.push({ id: id, tipo: 'barras', x: Number(p[0]) || 0, y: Number(p[1]) || 0, datos: texto(l), simbologia: sim,
        modulo: Number(p[4]) || 2, alto: Number(p[6]) || 100, legible: String(p[7] || 'B').trim().toUpperCase() === 'B' });
      return;
    }
    if (cmd === 'b') {
      const s = (l.match(/,s(\d+)/) || [])[1];
      el.push({ id: id, tipo: 'qr', x: Number(p[0]) || 0, y: Number(p[1]) || 0, datos: texto(l), modulo: Number(s) || 4 });
      return;
    }
    if (cmd === 'GW') { avisos.push('El formato tiene una imagen o logo (GW): no se importa.'); return; }
    ignorados[cmd] = true;
  });
  const lista = Object.keys(ignorados);
  if (lista.length) avisos.push('Comandos no usados: ' + lista.join(' ') + '.');
  return { diseno: { ancho: Math.min(ancho, DIS_MAX_ANCHO), alto: papel ? papel - 24 : alto, papel: papel || alto, elementos: el }, avisos: avisos, copias: copias };
}

/** EPL recibido para imprimir tal cual (sin JF/JB, que chocan con el avance de la impresora). */
function api_eplOriginal_(codigo) {
  const lineas = String(codigo || '').substring(0, 60000).split(/\r?\n/);
  const quitadas = lineas.filter(function (l) { return /^\s*J[FB]\s*$/.test(l); }).length;
  const limpio = lineas.filter(function (l) { return !/^\s*J[FB]\s*$/.test(l); }).join('\r\n');
  if (/\^XA/i.test(limpio)) throw new Error('Es ZPL: la PC43t (modo EPL) no lo imprime. Usa "Importar" para convertirlo.');
  registrarHistorial_('IMPRIMIR_EPL', 'EPL recibido impreso tal cual' + (quitadas ? ' (sin JF/JB)' : ''), '');
  registrarEtiquetasGeneradas_([[new Date(), USUARIO_ACTUAL_ || '', 'LIBRE', 'EPL original', '', '', '', '', 'EPL', '', '', '', '', limpio.substring(0, 300)]]);
  return { epl: limpio.replace(/\s*$/, '') + '\r\n', quitadas: quitadas };
}
