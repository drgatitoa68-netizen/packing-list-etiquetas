// =====================================================================
// VELOCIDAD: caché de la hoja "base" (conversiones y catálogo)
// ---------------------------------------------------------------------
// La conversión de un producto se pedía leyendo TODA la hoja base en cada
// vista previa de etiqueta. Ahora se guarda en la caché del script con una
// "versión de la base": cualquier cambio en la base (subir productos, guardar
// una conversión, editar la hoja a mano) sube la versión y la caché vieja deja
// de usarse sola. Por seguridad la caché además vence a los 10 minutos.
// =====================================================================

const VEL_PROP_BASE = 'BASE_VER';
const VEL_TTL = 600; // 10 min

function baseVersion_() {
  return PropertiesService.getScriptProperties().getProperty(VEL_PROP_BASE) || '1';
}

/** Llamar después de cualquier cambio en la hoja base. */
function baseCambio_() {
  PropertiesService.getScriptProperties().setProperty(VEL_PROP_BASE, String(Date.now()));
}

/** Lee un objeto de la caché (admite valores partidos en trozos de ~90 KB). */
function cacheLeer_(clave) {
  try {
    const cache = CacheService.getScriptCache();
    const cab = cache.get(clave);
    if (cab === null) return null;
    if (cab.indexOf('#trozos:') !== 0) return JSON.parse(cab);
    const n = Number(cab.substring(8));
    const claves = [];
    for (let i = 0; i < n; i++) claves.push(clave + '#' + i);
    const partes = cache.getAll(claves);
    let s = '';
    for (let i = 0; i < n; i++) {
      if (partes[claves[i]] === undefined) return null; // se perdió un trozo: leer de la hoja
      s += partes[claves[i]];
    }
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

function cacheGuardar_(clave, valor, seg) {
  try {
    const s = JSON.stringify(valor);
    const cache = CacheService.getScriptCache();
    const TROZO = 90000;
    if (s.length <= TROZO) { cache.put(clave, s, seg || VEL_TTL); return; }
    const trozos = {};
    let n = 0;
    for (let i = 0; i < s.length; i += TROZO) trozos[clave + '#' + (n++)] = s.substring(i, i + TROZO);
    if (n > 50) return; // demasiado grande para la caché: se seguirá leyendo de la hoja
    cache.putAll(trozos, seg || VEL_TTL);
    cache.put(clave, '#trozos:' + n, seg || VEL_TTL);
  } catch (e) {
    // sin caché la app funciona igual, solo más lenta
  }
}

/** Conversión de un código con caché (misma respuesta que leerla de la hoja). */
function conversionBase_(codigo) {
  const clave = 'CB' + baseVersion_() + '_' + normCodigo_(codigo);
  const enCache = cacheLeer_(clave);
  if (enCache) return enCache;
  const r = conversionBaseHoja_(codigo);
  cacheGuardar_(clave, r);
  return r;
}

/** Catálogo de conversiones con caché (se usa en cada carga de la pantalla). */
function leerCatalogo_(wsB) {
  const clave = 'CAT' + baseVersion_();
  const enCache = cacheLeer_(clave);
  if (enCache) return enCache;
  const r = leerCatalogoHoja_(wsB);
  cacheGuardar_(clave, r);
  return r;
}
