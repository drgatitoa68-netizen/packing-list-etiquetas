# Packing List · Etiquetas — Google Apps Script

Web app sobre Google Sheets para el packing list de bodega: subir el archivo de despacho, confirmar líneas,
asignar etiquetas e imprimir en impresoras Zebra por USB (WebUSB) desde el navegador.
El código se edita aquí y se sincroniza con Apps Script mediante [clasp](https://github.com/google/clasp).

## Estructura
```
src/
  Código.js        Servidor: doGet, lectura de las hojas DATOS, base y ANDENES
  Index.html       Pantalla de la app
  Disenador.js     Diseñador de etiquetas: códigos de barras EAN-13, Code128, Code39
  QR.js            Generador de códigos QR (Kazuhiko Arase, licencia MIT)
  Seguridad.js     Contraseñas con PBKDF2/HMAC
  Limpieza.js      Limpieza de datos antiguos con respaldo mensual
  Velocidad.js     Caché del catálogo
  Publicas.js      Funciones que llama la pantalla (estado, cola de impresión, clave)
  appsscript.json  Manifiesto: V8, zona America/Guayaquil
.clasp.json        scriptId del proyecto y rootDir=src (solo src/ se sube a Apps Script)
bin/clasp-login.sh Login de clasp en contenedores sin navegador (p. ej. desde el celular)
```

## Uso con clasp
```bash
npm install -g @google/clasp
clasp login            # o: bin/clasp-login.sh start / finish '<url localhost>'
clasp pull             # traer cambios hechos en el editor web
clasp push             # subir cambios locales a Apps Script (versión de prueba /dev)
clasp deploy -i <id> -d "vX"   # publicar en la implementación de producción (misma URL /exec)
```
Requiere la **Google Apps Script API** activa en https://script.google.com/home/usersettings.

## Flujo recomendado
1. `clasp pull` antes de empezar, por si se editó desde el editor web.
2. Cambios → `clasp push` → probar en `/dev`.
3. `git commit` + `git push`.
4. Validado: publicar con `clasp deploy -i` sobre la implementación de producción.

## Seguridad
La web app se ejecuta como el propietario (`USER_DEPLOYING`) con acceso `ANYONE_ANONYMOUS`:
cualquiera con la URL puede llamarla. No subir credenciales (`.clasprc.json` está en `.gitignore`).

## Versión en producción
| Fecha | Implementación | Contenido |
|---|---|---|
| 2026-11-24 | @46 (`9541335`) | Plantilla Transferencia entre CEDIs (original + copia), juego de copias, importar ZPL con varias etiquetas |
| (antes de este repo) | @45 | Diseñador: rollo completo 10,5 x 15,4 |

Volver a la versión anterior si hiciera falta: Implementar → Gestionar implementaciones → ✏️ → versión 45.
