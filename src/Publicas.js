// =====================================================================
// FUNCIONES PÚBLICAS (las llama la página con google.script.run)
// ---------------------------------------------------------------------
// Cada una exige sesión (token) y delega en la versión privada api_*_ de
// Código.js a través de llamadaProtegida_ (Seguridad.js).
// Para agregar una función nueva: créala como api_nombre_ y agrégala aquí.
// =====================================================================

function api_getState(token) { return llamadaProtegida_(token, 'api_getState', api_getState_, Array.prototype.slice.call(arguments, 1)); }
function api_cargarFilas(token) { return llamadaProtegida_(token, 'api_cargarFilas', api_cargarFilas_, Array.prototype.slice.call(arguments, 1)); }
function api_cambiarClave(token) { return llamadaProtegida_(token, 'api_cambiarClave', api_cambiarClave_, Array.prototype.slice.call(arguments, 1)); }
function api_encolarImpresion(token) { return llamadaProtegida_(token, 'api_encolarImpresion', api_encolarImpresion_, Array.prototype.slice.call(arguments, 1)); }
function api_listarCola(token) { return llamadaProtegida_(token, 'api_listarCola', api_listarCola_, Array.prototype.slice.call(arguments, 1)); }
function api_contarCola(token) { return llamadaProtegida_(token, 'api_contarCola', api_contarCola_, Array.prototype.slice.call(arguments, 1)); }
function api_datosCola(token) { return llamadaProtegida_(token, 'api_datosCola', api_datosCola_, Array.prototype.slice.call(arguments, 1)); }
function api_marcarCola(token) { return llamadaProtegida_(token, 'api_marcarCola', api_marcarCola_, Array.prototype.slice.call(arguments, 1)); }
function api_descartarCola(token) { return llamadaProtegida_(token, 'api_descartarCola', api_descartarCola_, Array.prototype.slice.call(arguments, 1)); }
function api_getHistorial(token) { return llamadaProtegida_(token, 'api_getHistorial', api_getHistorial_, Array.prototype.slice.call(arguments, 1)); }
function api_cargarAndenes(token) { return llamadaProtegida_(token, 'api_cargarAndenes', api_cargarAndenes_, Array.prototype.slice.call(arguments, 1)); }
function api_validarPedidos(token) { return llamadaProtegida_(token, 'api_validarPedidos', api_validarPedidos_, Array.prototype.slice.call(arguments, 1)); }
function api_validarAndenes(token) { return llamadaProtegida_(token, 'api_validarAndenes', api_validarAndenes_, Array.prototype.slice.call(arguments, 1)); }
function api_confirmarLinea(token) { return llamadaProtegida_(token, 'api_confirmarLinea', api_confirmarLinea_, Array.prototype.slice.call(arguments, 1)); }
function api_confirmarMasivo(token) { return llamadaProtegida_(token, 'api_confirmarMasivo', api_confirmarMasivo_, Array.prototype.slice.call(arguments, 1)); }
function api_editarEtiqueta(token) { return llamadaProtegida_(token, 'api_editarEtiqueta', api_editarEtiqueta_, Array.prototype.slice.call(arguments, 1)); }
function api_autoAsignarEtiqueta(token) { return llamadaProtegida_(token, 'api_autoAsignarEtiqueta', api_autoAsignarEtiqueta_, Array.prototype.slice.call(arguments, 1)); }
function api_generarZpl(token) { return llamadaProtegida_(token, 'api_generarZpl', api_generarZpl_, Array.prototype.slice.call(arguments, 1)); }
function api_vistaPackingList(token) { return llamadaProtegida_(token, 'api_vistaPackingList', api_vistaPackingList_, Array.prototype.slice.call(arguments, 1)); }
function api_generarTicketsA4(token) { return llamadaProtegida_(token, 'api_generarTicketsA4', api_generarTicketsA4_, Array.prototype.slice.call(arguments, 1)); }
function api_contarSeleccion(token) { return llamadaProtegida_(token, 'api_contarSeleccion', api_contarSeleccion_, Array.prototype.slice.call(arguments, 1)); }
function api_cargarStock(token) { return llamadaProtegida_(token, 'api_cargarStock', api_cargarStock_, Array.prototype.slice.call(arguments, 1)); }
function api_infoStock(token) { return llamadaProtegida_(token, 'api_infoStock', api_infoStock_, Array.prototype.slice.call(arguments, 1)); }
function api_buscarProducto(token) { return llamadaProtegida_(token, 'api_buscarProducto', api_buscarProducto_, Array.prototype.slice.call(arguments, 1)); }
function api_etiquetaProducto(token) { return llamadaProtegida_(token, 'api_etiquetaProducto', api_etiquetaProducto_, Array.prototype.slice.call(arguments, 1)); }
function api_validarProductosBase(token) { return llamadaProtegida_(token, 'api_validarProductosBase', api_validarProductosBase_, Array.prototype.slice.call(arguments, 1)); }
function api_cargarProductosBase(token) { return llamadaProtegida_(token, 'api_cargarProductosBase', api_cargarProductosBase_, Array.prototype.slice.call(arguments, 1)); }
function api_guardarConversion(token) { return llamadaProtegida_(token, 'api_guardarConversion', api_guardarConversion_, Array.prototype.slice.call(arguments, 1)); }
function api_getHistorialEtiquetas(token) { return llamadaProtegida_(token, 'api_getHistorialEtiquetas', api_getHistorialEtiquetas_, Array.prototype.slice.call(arguments, 1)); }

// Diseñador de etiquetas (Disenador.js)
function api_plantillasListar(token) { return llamadaProtegida_(token, 'api_plantillasListar', api_plantillasListar_, Array.prototype.slice.call(arguments, 1)); }
function api_plantillaGuardar(token) { return llamadaProtegida_(token, 'api_plantillaGuardar', api_plantillaGuardar_, Array.prototype.slice.call(arguments, 1)); }
function api_plantillaEliminar(token) { return llamadaProtegida_(token, 'api_plantillaEliminar', api_plantillaEliminar_, Array.prototype.slice.call(arguments, 1)); }
function api_etiquetaLibre(token) { return llamadaProtegida_(token, 'api_etiquetaLibre', api_etiquetaLibre_, Array.prototype.slice.call(arguments, 1)); }
function api_importarFormato(token) { return llamadaProtegida_(token, 'api_importarFormato', api_importarFormato_, Array.prototype.slice.call(arguments, 1)); }
function api_eplOriginal(token) { return llamadaProtegida_(token, 'api_eplOriginal', api_eplOriginal_, Array.prototype.slice.call(arguments, 1)); }
function api_limpiezaResumen(token) { return llamadaProtegida_(token, 'api_limpiezaResumen', api_limpiezaResumen_, Array.prototype.slice.call(arguments, 1)); }
function api_limpiarDatosAntiguos(token) { return llamadaProtegida_(token, 'api_limpiarDatosAntiguos', api_limpiarDatosAntiguos_, Array.prototype.slice.call(arguments, 1)); }
function api_completarAnden(token) { return llamadaProtegida_(token, 'api_completarAnden', api_completarAnden_, Array.prototype.slice.call(arguments, 1)); }
