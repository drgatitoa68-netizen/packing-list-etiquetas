// =====================================================================
// SEGURIDAD: usuarios individuales, sesiones y control de acceso
// ---------------------------------------------------------------------
// - La app web es pública (ANYONE_ANONYMOUS) para que los operadores no
//   necesiten cuenta de Google, así que CADA función pública api_* pasa por
//   llamadaProtegida_(): exige una sesión válida, revisa el rol y limpia la
//   entrada antes de ejecutar la función real (api_*_).
// - Usuarios en las Propiedades del script (no se ven en la hoja), claves
//   con PBKDF2-HMAC-SHA256 + sal por usuario. Sesiones en la caché del
//   script (6 h sin uso). Cambiar la clave o desactivar a alguien cierra
//   sus sesiones (versión de sesión).
// - El primer admin solo se crea ejecutando crearAdminInicial() desde el
//   editor de Apps Script (dueño del proyecto).
// =====================================================================

const SEG_ITERACIONES = 80000;          // PBKDF2: ~0,5 s en Apps Script (medido 125 ms con 20000). Va dentro del hash
const SEG_SESION_SEG = 6 * 60 * 60;     // máximo de CacheService (6 h)
const SEG_MAX_FALLOS = 5;
const SEG_BLOQUEO_MS = 15 * 60 * 1000;
const SEG_CLAVE_MIN = 10;
const SEG_USUARIO_RE = /^[a-z0-9._-]{3,32}$/;
const SEG_PREFIJO_USR = 'USR_';
const SEG_PREFIJO_SES = 'SES_';

// Funciones públicas que solo puede usar un admin
const SEG_SOLO_ADMIN = {
  api_cambiarClave: true,
  // Diseñador: solo el admin crea, edita, borra e importa formatos; todos imprimen
  api_plantillaGuardar: true, api_plantillaEliminar: true, api_importarFormato: true, api_eplOriginal: true,
  // Limpieza de datos antiguos: solo admin
  api_limpiezaResumen: true, api_limpiarDatosAntiguos: true,
};

// Usuario de la ejecución actual (cada llamada del navegador es una ejecución aparte)
var USUARIO_ACTUAL_ = '';

// ---------------------------------------------------------------------
// SHA-256 / HMAC / PBKDF2 en JavaScript puro (más rápido que miles de
// llamadas a Utilities). Verificado contra crypto.pbkdf2Sync de Node.
// ---------------------------------------------------------------------
const SEG_K_ = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** SHA-256 de un arreglo de bytes (0-255). Devuelve arreglo de 32 bytes. */
function segSha256_(bytes) {
  const n = bytes.length;
  const bloques = ((n + 9 + 63) >> 6) << 4; // palabras de 32 bits
  const w = new Array(bloques).fill(0);
  for (let i = 0; i < n; i++) w[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
  w[n >> 2] |= 0x80 << (24 - (n % 4) * 8);
  w[bloques - 1] = n * 8; // mensajes < 512 MB
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const m = new Array(64);
  for (let off = 0; off < bloques; off += 16) {
    for (let t = 0; t < 16; t++) m[t] = w[off + t] | 0;
    for (let t = 16; t < 64; t++) {
      const x = m[t - 15], y = m[t - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      m[t] = (m[t - 16] + s0 + m[t - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SEG_K_[t] + m[t]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  const out = [];
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach(function (v) {
    out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  });
  return out;
}

function segHmac_(clave, msg) {
  let k = clave.length > 64 ? segSha256_(clave) : clave.slice();
  while (k.length < 64) k.push(0);
  const ipad = k.map(function (b) { return b ^ 0x36; });
  const opad = k.map(function (b) { return b ^ 0x5c; });
  return segSha256_(opad.concat(segSha256_(ipad.concat(msg))));
}

/** PBKDF2-HMAC-SHA256 con salida de 32 bytes (un bloque). */
function segPbkdf2_(claveBytes, salBytes, iteraciones) {
  let u = segHmac_(claveBytes, salBytes.concat([0, 0, 0, 1]));
  const t = u.slice();
  for (let i = 1; i < iteraciones; i++) {
    u = segHmac_(claveBytes, u);
    for (let j = 0; j < 32; j++) t[j] ^= u[j];
  }
  return t;
}

function segUtf8_(s) {
  const bin = unescape(encodeURIComponent(String(s)));
  const out = new Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function segHex_(bytes) {
  return bytes.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

function segDeHex_(hex) {
  const out = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
  return out;
}

/** Comparación en tiempo constante de dos textos. */
function segIgual_(a, b) {
  a = String(a); b = String(b);
  let dif = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) dif |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return dif === 0;
}

function segAleatorioHex_(nUuids) {
  let s = '';
  for (let i = 0; i < nUuids; i++) s += Utilities.getUuid().replace(/-/g, '');
  return s;
}

/** Hash de clave: "pbkdf2$<iteraciones>$<sal hex>$<hash hex>". */
function segCrearHash_(clave) {
  const sal = segAleatorioHex_(1);
  const h = segPbkdf2_(segUtf8_(clave), segDeHex_(sal), SEG_ITERACIONES);
  return 'pbkdf2$' + SEG_ITERACIONES + '$' + sal + '$' + segHex_(h);
}

/** Verifica PBKDF2 y, para la clave de carga, el formato antiguo "sal:sha256". */
function segVerificarHash_(clave, guardado) {
  guardado = String(guardado || '');
  if (guardado.indexOf('pbkdf2$') === 0) {
    const p = guardado.split('$');
    const iter = Number(p[1]);
    if (!(iter >= 1000 && iter <= 1000000) || !p[2] || !p[3]) return false;
    return segIgual_(segHex_(segPbkdf2_(segUtf8_(clave), segDeHex_(p[2]), iter)), p[3]);
  }
  const partes = guardado.split(':');
  if (partes.length !== 2 || !partes[0] || !partes[1]) return false;
  return segIgual_(hashClave_(String(clave || ''), partes[0]), partes[1]);
}

function segNecesitaRehash_(guardado) {
  return String(guardado || '').indexOf('pbkdf2$' + SEG_ITERACIONES + '$') !== 0;
}

// ---------------------------------------------------------------------
// Almacenamiento de usuarios (Propiedades del script, una por usuario)
// ---------------------------------------------------------------------
function segNormUsuario_(v) { return String(v || '').trim().toLowerCase(); }

function segLeerUsuario_(usuario) {
  const u = segNormUsuario_(usuario);
  if (!SEG_USUARIO_RE.test(u)) return null;
  const raw = PropertiesService.getScriptProperties().getProperty(SEG_PREFIJO_USR + u);
  return raw ? JSON.parse(raw) : null;
}

function segGuardarUsuario_(u) {
  u.actualizadoEn = new Date().toISOString();
  PropertiesService.getScriptProperties().setProperty(SEG_PREFIJO_USR + u.usuario, JSON.stringify(u));
}

function segListarUsuarios_() {
  const props = PropertiesService.getScriptProperties().getProperties();
  return Object.keys(props)
    .filter(function (k) { return k.indexOf(SEG_PREFIJO_USR) === 0; })
    .map(function (k) { return JSON.parse(props[k]); })
    .sort(function (a, b) { return a.usuario < b.usuario ? -1 : 1; });
}

/** Lo que se envía al navegador: nunca el hash ni contadores internos. */
function segPublico_(u) {
  return {
    usuario: u.usuario, nombre: u.nombre, rol: u.rol, activo: u.activo !== false,
    debeCambiarClave: !!u.debeCambiarClave, bloqueado: Number(u.bloqueoHasta || 0) > Date.now(),
  };
}

function segValidarClaveNueva_(clave, usuario) {
  clave = String(clave || '');
  if (clave.length < SEG_CLAVE_MIN) return 'La clave debe tener al menos ' + SEG_CLAVE_MIN + ' caracteres.';
  if (clave.length > 200) return 'La clave es demasiado larga.';
  if (clave.toLowerCase().indexOf(segNormUsuario_(usuario)) !== -1) return 'La clave no puede contener el usuario.';
  return '';
}

// ---------------------------------------------------------------------
// Sesiones (caché del script)
// ---------------------------------------------------------------------
function segCrearSesion_(u) {
  const token = segAleatorioHex_(2);
  CacheService.getScriptCache().put(SEG_PREFIJO_SES + token,
    JSON.stringify({ u: u.usuario, v: Number(u.sesionVersion || 1), r: Date.now() }), SEG_SESION_SEG);
  return token;
}

/** Devuelve el usuario de una sesión válida o null. Renueva las 6 h. */
function segUsuarioDeSesion_(token) {
  token = String(token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const cache = CacheService.getScriptCache();
  const raw = cache.get(SEG_PREFIJO_SES + token);
  if (!raw) return null;
  const s = JSON.parse(raw);
  const u = segLeerUsuario_(s.u);
  if (!u || u.activo === false || Number(u.sesionVersion || 1) !== Number(s.v)) {
    cache.remove(SEG_PREFIJO_SES + token);
    return null;
  }
  // Renovar las 6 h solo cada 30 min (una escritura menos en casi todas las llamadas)
  const ahora = Date.now();
  if (!s.r || ahora - s.r > 30 * 60 * 1000) {
    s.r = ahora;
    cache.put(SEG_PREFIJO_SES + token, JSON.stringify(s), SEG_SESION_SEG);
  }
  return u;
}

// ---------------------------------------------------------------------
// Limpieza de entradas: ningún texto que llegue del navegador puede
// convertirse en HTML/JS al mostrarse (< y > pasan a ‹ ›).
// ---------------------------------------------------------------------
function segLimpiar_(v, prof) {
  prof = prof || 0;
  if (typeof v === 'string') return v.replace(/</g, '‹').replace(/>/g, '›');
  if (v === null || typeof v !== 'object' || prof > 8) return v;
  if (Array.isArray(v)) return v.map(function (x) { return segLimpiar_(x, prof + 1); });
  if (Object.prototype.toString.call(v) === '[object Date]') return v;
  const o = {};
  Object.keys(v).forEach(function (k) { o[k] = segLimpiar_(v[k], prof + 1); });
  return o;
}

/** Punto de control único de todas las funciones públicas api_*. */
function llamadaProtegida_(token, nombre, fn, args) {
  const u = segUsuarioDeSesion_(token);
  if (!u) throw new Error('NO_AUTH: Tu sesión terminó. Vuelve a ingresar.');
  if (u.debeCambiarClave) throw new Error('CAMBIAR_CLAVE: Debes cambiar tu clave antes de continuar.');
  if (SEG_SOLO_ADMIN[nombre] && u.rol !== 'admin') throw new Error('Solo un administrador puede hacer esto.');
  USUARIO_ACTUAL_ = u.usuario;
  try {
    return fn.apply(null, segLimpiar_(args));
  } finally {
    USUARIO_ACTUAL_ = '';
  }
}

function segAuditar_(accion, detalle, ref) {
  registrarHistorial_(accion, detalle, ref);
}

function segConBloqueo_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// =====================================================================
// FUNCIONES PÚBLICAS DE ACCESO (las llama la página)
// =====================================================================
function auth_login(usuario, clave) {
  const generico = 'Usuario o clave incorrectos.';
  const un = segNormUsuario_(usuario);
  clave = String(clave || '');
  if (!un || !clave) throw new Error('Escribe tu usuario y tu clave.');
  if (!segListarUsuarios_().length) {
    throw new Error('Aún no hay usuarios. El dueño del proyecto debe ejecutar crearAdminInicial en el editor de Apps Script.');
  }
  // Formato inválido o clave desmedida: misma respuesta, sin tocar datos
  const u = SEG_USUARIO_RE.test(un) && clave.length <= 200 ? segLeerUsuario_(un) : null;
  if (!u || u.activo === false) {
    segPbkdf2_(segUtf8_(clave.slice(0, 200)), segDeHex_('00'), SEG_ITERACIONES); // mismo tiempo
    throw new Error(generico);
  }
  const ahora = Date.now();
  if (Number(u.bloqueoHasta || 0) > ahora) {
    throw new Error('Usuario bloqueado por intentos fallidos. Espera ' +
      Math.ceil((u.bloqueoHasta - ahora) / 60000) + ' minuto(s) o pide al admin que lo desbloquee.');
  }
  if (!segVerificarHash_(clave, u.claveHash)) {
    return segConBloqueo_(function () {
      const x = segLeerUsuario_(un);
      x.fallos = Number(x.fallos || 0) + 1;
      if (x.fallos >= SEG_MAX_FALLOS) {
        x.fallos = 0;
        x.bloqueoHasta = ahora + SEG_BLOQUEO_MS;
        segGuardarUsuario_(x);
        segAuditar_('USUARIO_BLOQUEADO', un + ' bloqueado 15 min por intentos fallidos', un);
      } else {
        segGuardarUsuario_(x);
      }
      throw new Error(generico);
    });
  }
  if (u.fallos || u.bloqueoHasta || segNecesitaRehash_(u.claveHash)) {
    segConBloqueo_(function () {
      const x = segLeerUsuario_(un);
      x.fallos = 0;
      x.bloqueoHasta = 0;
      if (segNecesitaRehash_(x.claveHash)) x.claveHash = segCrearHash_(clave);
      segGuardarUsuario_(x);
    });
  }
  return { token: segCrearSesion_(u), usuario: segPublico_(u) };
}

function auth_sesion(token) {
  const u = segUsuarioDeSesion_(token);
  return u ? segPublico_(u) : null;
}

function auth_logout(token) {
  token = String(token || '');
  if (/^[a-f0-9]{64}$/.test(token)) CacheService.getScriptCache().remove(SEG_PREFIJO_SES + token);
  return { ok: true };
}

function auth_cambiarClave(token, actual, nueva) {
  const u = segUsuarioDeSesion_(token);
  if (!u) throw new Error('NO_AUTH: Tu sesión terminó. Vuelve a ingresar.');
  if (!segVerificarHash_(String(actual || ''), u.claveHash)) throw new Error('La clave actual no es correcta.');
  const problema = segValidarClaveNueva_(nueva, u.usuario);
  if (problema) throw new Error(problema);
  if (String(nueva) === String(actual)) throw new Error('La clave nueva debe ser distinta de la actual.');
  return segConBloqueo_(function () {
    const x = segLeerUsuario_(u.usuario);
    x.claveHash = segCrearHash_(String(nueva));
    x.debeCambiarClave = false;
    x.sesionVersion = Number(x.sesionVersion || 1) + 1; // cierra las demás sesiones
    segGuardarUsuario_(x);
    USUARIO_ACTUAL_ = x.usuario;
    segAuditar_('CLAVE_CAMBIADA', x.usuario + ' cambió su clave', x.usuario);
    USUARIO_ACTUAL_ = '';
    return { token: segCrearSesion_(x), usuario: segPublico_(x) };
  });
}

// --- Administración de usuarios (solo admin) -------------------------
function segExigirAdmin_(token) {
  const u = segUsuarioDeSesion_(token);
  if (!u) throw new Error('NO_AUTH: Tu sesión terminó. Vuelve a ingresar.');
  if (u.debeCambiarClave) throw new Error('CAMBIAR_CLAVE: Debes cambiar tu clave antes de continuar.');
  if (u.rol !== 'admin') throw new Error('Solo un administrador puede hacer esto.');
  return u;
}

function usr_listar(token) {
  segExigirAdmin_(token);
  return segListarUsuarios_().map(segPublico_);
}

function usr_crear(token, datos) {
  const admin = segExigirAdmin_(token);
  datos = segLimpiar_(datos || {});
  const usuario = segNormUsuario_(datos.usuario);
  const nombre = String(datos.nombre || '').trim().substring(0, 80);
  const rol = datos.rol === 'admin' ? 'admin' : 'operador';
  const clave = String(datos.claveTemporal || '');
  if (!SEG_USUARIO_RE.test(usuario)) throw new Error('Usuario inválido: 3 a 32 caracteres (a-z, 0-9, punto, guion).');
  if (!nombre) throw new Error('Escribe el nombre de la persona.');
  const problema = segValidarClaveNueva_(clave, usuario);
  if (problema) throw new Error(problema);
  return segConBloqueo_(function () {
    if (segLeerUsuario_(usuario)) throw new Error('El usuario "' + usuario + '" ya existe.');
    const nuevo = {
      usuario: usuario, nombre: nombre, rol: rol, claveHash: segCrearHash_(clave), activo: true,
      debeCambiarClave: true, fallos: 0, bloqueoHasta: 0, sesionVersion: 1, creadoEn: new Date().toISOString(),
    };
    segGuardarUsuario_(nuevo);
    USUARIO_ACTUAL_ = admin.usuario;
    segAuditar_('USUARIO_CREADO', admin.usuario + ' creó a ' + usuario + ' (' + rol + ')', usuario);
    USUARIO_ACTUAL_ = '';
    return segPublico_(nuevo);
  });
}

function usr_actualizar(token, datos) {
  const admin = segExigirAdmin_(token);
  datos = segLimpiar_(datos || {});
  return segConBloqueo_(function () {
    const u = segLeerUsuario_(datos.usuario);
    if (!u) throw new Error('Usuario no encontrado.');
    const antes = JSON.stringify(u);
    const cambios = [];
    const next = JSON.parse(antes);
    if (typeof datos.nombre === 'string' && datos.nombre.trim()) next.nombre = datos.nombre.trim().substring(0, 80);
    if (next.nombre !== u.nombre) cambios.push('nombre');
    if (datos.rol === 'admin' || datos.rol === 'operador') next.rol = datos.rol;
    if (next.rol !== u.rol) cambios.push('rol ' + u.rol + '→' + next.rol);
    if (typeof datos.activo === 'boolean') next.activo = datos.activo;
    if ((next.activo !== false) !== (u.activo !== false)) cambios.push(next.activo ? 'activado' : 'desactivado');
    if (datos.desbloquear === true && (u.bloqueoHasta || u.fallos)) {
      next.bloqueoHasta = 0; next.fallos = 0; cambios.push('desbloqueado');
    }
    if (typeof datos.claveTemporal === 'string' && datos.claveTemporal) {
      const problema = segValidarClaveNueva_(datos.claveTemporal, u.usuario);
      if (problema) throw new Error(problema);
      next.claveHash = segCrearHash_(datos.claveTemporal);
      next.debeCambiarClave = true; next.fallos = 0; next.bloqueoHasta = 0;
      cambios.push('clave restablecida');
    }
    if (u.usuario === admin.usuario && (next.activo === false || next.rol !== 'admin')) {
      throw new Error('No puedes quitarte el rol de admin ni desactivarte a ti mismo.');
    }
    const eraAdminActivo = u.rol === 'admin' && u.activo !== false;
    if (eraAdminActivo && (next.rol !== 'admin' || next.activo === false)) {
      const otros = segListarUsuarios_().filter(function (x) {
        return x.rol === 'admin' && x.activo !== false && x.usuario !== u.usuario;
      });
      if (!otros.length) throw new Error('Debe quedar al menos un administrador activo.');
    }
    if (!cambios.length) return segPublico_(u);
    if (next.activo === false || next.rol !== u.rol || next.claveHash !== u.claveHash) {
      next.sesionVersion = Number(u.sesionVersion || 1) + 1; // cierra sus sesiones
    }
    segGuardarUsuario_(next);
    USUARIO_ACTUAL_ = admin.usuario;
    segAuditar_('USUARIO_ACTUALIZADO', admin.usuario + ' → ' + u.usuario + ': ' + cambios.join(', '), u.usuario);
    USUARIO_ACTUAL_ = '';
    return segPublico_(next);
  });
}

// =====================================================================
// PRIMER ADMIN: ejecutar UNA vez desde el editor de Apps Script
// (Ejecutar → crearAdminInicial). La clave temporal aparece en el
// registro de ejecución; solo el dueño la ve. Desde la página web no
// funciona: exige que quien ejecuta sea el dueño con su cuenta Google.
// =====================================================================
function crearAdminInicial() {
  const activo = Session.getActiveUser().getEmail();
  const dueno = Session.getEffectiveUser().getEmail();
  if (!activo || activo !== dueno) {
    throw new Error('Solo el dueño del proyecto puede ejecutar esto desde el editor de Apps Script.');
  }
  return segConBloqueo_(function () {
    if (segListarUsuarios_().some(function (u) { return u.rol === 'admin' && u.activo !== false; })) {
      Logger.log('Ya existe un administrador activo. Usa la pantalla Usuarios de la app.');
      return;
    }
    const letras = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const hex = segAleatorioHex_(1);
    let temporal = '';
    for (let i = 0; i < 14; i++) temporal += letras[parseInt(hex.substr(i * 2, 2), 16) % letras.length];
    segGuardarUsuario_({
      usuario: 'admin', nombre: 'Administrador', rol: 'admin', claveHash: segCrearHash_(temporal),
      activo: true, debeCambiarClave: true, fallos: 0, bloqueoHasta: 0, sesionVersion: 1,
      creadoEn: new Date().toISOString(),
    });
    USUARIO_ACTUAL_ = 'admin';
    segAuditar_('USUARIO_CREADO', 'Admin inicial creado desde el editor por ' + dueno, 'admin');
    USUARIO_ACTUAL_ = '';
    Logger.log('Usuario: admin   Clave temporal: ' + temporal + '   (la app pedirá cambiarla al entrar)');
  });
}

/** Diagnóstico opcional desde el editor: cuánto tarda cifrar una clave. */
function diagnosticoVelocidadClave() {
  const t0 = Date.now();
  segCrearHash_('prueba-de-velocidad');
  Logger.log('Cifrar una clave tarda ' + (Date.now() - t0) + ' ms con ' + SEG_ITERACIONES + ' iteraciones.');
}
