# Casa do Sol

Planos digitales de la casa en una web simple: plantas, desagües, fases de obra, proyectos, tareas y presupuestos.
El repositorio es también la página (GitHub Pages, sin build).

## Ver en local

```bash
python3 tools/servidor.py
```

Después abrí <http://localhost:8765>. Si abrís `index.html` con doble click no funciona, porque el navegador bloquea la lectura de los JSON.

## Marcar errores en el plano (solo local)

Con `tools/servidor.py` corriendo aparece el botón **✎ Marcar un error** en el plano:

1. Tocás el botón y arrastrás un recuadro sobre la zona que está mal.
2. Escribís qué está mal y guardás.
3. La marca queda en `revision/notas.json`, junto con lo que hay dentro del recuadro (ambientes, artefactos, caños). Esa carpeta está en `.gitignore`: no se publica.
4. Le pedís a Claude "tomá las marcas". Corrige los datos y deja cada marca como `resuelta`, con una respuesta.

En GitHub Pages el botón no aparece.

## Qué hay en cada archivo

| Archivo | Para qué |
|---|---|
| `data/casa.json` | Ambientes, aberturas (puertas y ventanas), escaleras, equipamiento, correcciones al plano importado, zonas exteriores y techos |
| `data/fases.json` | Etapas de la casa: superficie aprobada original, cerramientos, ampliación, estado actual. Acá se suman las fases futuras |
| `data/desagues.json` | Artefactos, ventilaciones, cámaras y tramos de cañería (cloacal, pluvial, ventilación, agua) |
| `data/proyectos.json` | Proyectos con tareas, ambientes afectados, presupuesto y dibujo opcional del cambio |
| `data/config.json` | Tipo de cambio ARS/USD de referencia |
| `planos/*.svg` | Muros de cada planta, importados del plano en PDF (el detalle original queda como capa opcional) |
| `planos/cotas.json` | Cotas extraídas del PDF; solo se guardan las que coinciden con el número escrito |
| `tools/importar_pdf.py` | Script que generó los SVG a partir del PDF de ArchiCAD |

Cada JSON tiene un campo `_ayuda` con lo que acepta. El historial de git queda como registro de cambios.

## Coordenadas

Todo va en **centímetros**. El origen (0,0) está en el eje medianero izquierdo y el del fondo: `x` crece hacia la medianera derecha y `y` crece hacia la calle. La línea municipal está en `y = 1830`.
Para ubicar algo, medí desde la medianera izquierda y desde el fondo.

## Ejemplos

**Agregar un caño cloacal estimado** (en `data/desagues.json` → `tramos`):

```json
{ "id": "cloaca-principal", "red": "cloacal", "diametro": "110 mm", "estado": "estimado",
  "nivel": "pb", "puntos": [[1048, 1193], [1048, 1700], [600, 1820]] }
```

**Agregar una cámara de inspección** (`camaras`):

```json
{ "id": "ci-frente", "nombre": "Cámara de inspección", "nivel": "pb", "pos": [600, 1700], "estado": "verificado" }
```

**Agregar un ítem de presupuesto** (en un proyecto de `data/proyectos.json` → `presupuesto`):

```json
{ "concepto": "Cámara nueva", "proveedor": "Plomero", "monto": 350000, "moneda": "ARS", "estado": "cotizado", "fecha": "2026-12-01" }
```

**Dibujar un cambio propuesto** (en un proyecto → `overlay`):

```json
{ "nivel": "pb", "tipo": "poligono", "etiqueta": "Nueva parrilla", "puntos": [[400, 100], [600, 100], [600, 200], [400, 200]] }
```

## Volver a importar el PDF

El PDF original no se sube al repositorio: va en `privado/`, que está en `.gitignore`.

```bash
brew install poppler
python3 tools/importar_pdf.py privado/obra.pdf
python3 tools/extraer_cotas.py privado/obra.pdf
```

El plano se dibuja así: los muros salen del PDF y todo lo demás (puertas, ventanas, escaleras, artefactos, cotas, rótulos) se dibuja desde los datos. Para cambiar una puerta o una ventana se edita `aberturas` en `data/casa.json`.

## Publicar en GitHub Pages

Settings → Pages → Source: *Deploy from a branch* → `main` / `(root)`.
