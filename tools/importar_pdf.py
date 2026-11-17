#!/usr/bin/env python3
"""
Importa muros y detalle (aberturas, escaleras, artefactos dibujados) desde el
plano en PDF exportado por ArchiCAD y genera un SVG por planta en planos/.

Uso (requiere poppler: `brew install poppler`):
    python3 tools/importar_pdf.py privado/obra.pdf

Sistema de coordenadas de salida: centímetros, origen (0,0) en el eje
medianero izquierdo y el eje medianero del fondo; x crece hacia la medianera
derecha, y crece hacia la Calle (línea municipal en y = 1830).

El plano está a escala 1:100. Cada dibujo de la hoja tiene su propio origen
en puntos PDF; están medidos a mano a partir de los muros medianeros.
"""
import json
import math
import re
import subprocess
import sys
import tempfile
from pathlib import Path

K = 3.5313  # cm reales por punto PDF (1:100; 1 pt = 0.35278 mm → ×100, ajustado a cotas)

# (origen_x, origen_y) en puntos PDF y caja de recorte (x0, y0, x1, y1) por dibujo
DIBUJOS = {
    "planta-baja": {"origen": (286.457, 240.235), "caja": (281.0, 234.0, 603.5, 700.5)},
    "entrepiso": {"origen": (147.397, 240.235), "caja": (142.0, 433.0, 230.5, 660.5)},
    "planta-alta": {"origen": (638.077, 240.235), "caja": (821.0, 433.0, 955.0, 700.5)},
}

NEGRO = "rgb(0%, 0%, 0%)"
BLANCO = "rgb(100%, 100%, 100%)"
NUM = r"-?\d+(?:\.\d+)?(?:e-?\d+)?"


def leer_paths(svg_text):
    cuerpo = svg_text[svg_text.index("</defs>"):]
    paths = []
    for m in re.finditer(r"<path ([^>]*)/>", cuerpo):
        a = m.group(1)
        get = lambda k: (re.search(rf' {k}="([^"]*)"', " " + a) or [None, None])[1]
        tr = get("transform")
        A = [float(v) for v in re.search(r"matrix\(([^)]*)\)", tr).group(1).split(",")] if tr else [1, 0, 0, 1, 0, 0]
        sw = float(get("stroke-width")) * A[0] if get("stroke-width") else None
        paths.append({"fill": get("fill"), "stroke": get("stroke"), "sw": sw, "d": get("d"), "A": A})
    return paths


def tokens(d):
    return re.findall(r"[MLCZ]|" + NUM, d)


def puntos_pagina(p):
    """Devuelve lista de subtrazos en coordenadas de página (pt), solo extremos."""
    A = p["A"]
    toks = tokens(p["d"])
    subs, cur, i, cmd = [], [], 0, None
    nums = []
    while i < len(toks):
        t = toks[i]
        if t in "MLCZ":
            cmd = t
            i += 1
            if cmd == "Z":
                if cur:
                    subs.append(cur)
                cur = []
            continue
        n = 6 if cmd == "C" else 2
        vals = [float(v) for v in toks[i:i + n]]
        i += n
        x, y = vals[-2], vals[-1]
        pt = (A[0] * x + A[2] * y + A[4], A[1] * x + A[3] * y + A[5])
        if cmd == "M" and cur:
            subs.append(cur)
            cur = []
        cur.append(pt)
    if cur:
        subs.append(cur)
    return subs


def caja(p):
    pts = [q for s in puntos_pagina(p) for q in s]
    xs = [q[0] for q in pts]
    ys = [q[1] for q in pts]
    return min(xs), min(ys), max(xs), max(ys), pts


def d_a_cm(p, origen):
    """Reescribe el atributo d en centímetros de la casa."""
    A = p["A"]
    ox, oy = origen
    toks = tokens(p["d"])
    out, i, cmd = [], 0, None
    while i < len(toks):
        t = toks[i]
        if t in "MLCZ":
            cmd = t
            out.append(t)
            i += 1
            continue
        x, y = float(toks[i]), float(toks[i + 1])
        i += 2
        px = A[0] * x + A[2] * y + A[4]
        py = A[1] * x + A[3] * y + A[5]
        out.append(f"{(px - ox) * K:.1f},{(py - oy) * K:.1f}")
    return " ".join(out).replace(" Z", "Z")


def es_curva(p):
    return " C " in p["d"]


def marcadores(paths_curvos):
    """Detecta círculos chicos (cotas de nivel, número de local) armados con
    varios arcos que comparten extremos. Devuelve índices a descartar."""
    n = len(paths_curvos)
    padre = list(range(n))

    def raiz(a):
        while padre[a] != a:
            padre[a] = padre[padre[a]]
            a = padre[a]
        return a

    extremos = []
    for idx, (p, b) in enumerate(paths_curvos):
        pts = b[4]
        extremos.append((pts[0], pts[-1]))
    for a in range(n):
        for c in range(a + 1, n):
            for u in extremos[a]:
                for v in extremos[c]:
                    if abs(u[0] - v[0]) < 0.05 and abs(u[1] - v[1]) < 0.05:
                        padre[raiz(a)] = raiz(c)
    grupos = {}
    for a in range(n):
        grupos.setdefault(raiz(a), []).append(a)
    descartar = set()
    for miembros in grupos.values():
        if len(miembros) < 4:
            continue
        x0 = min(paths_curvos[m][1][0] for m in miembros)
        y0 = min(paths_curvos[m][1][1] for m in miembros)
        x1 = max(paths_curvos[m][1][2] for m in miembros)
        y1 = max(paths_curvos[m][1][3] for m in miembros)
        w, h = x1 - x0, y1 - y0
        if 3.5 <= w <= 8.2 and abs(w - h) < 0.8:
            descartar.update(miembros)
    return descartar


def sin_cruces(lineas):
    """Quita las cruces de las cotas de nivel: pares de segmentos cortos,
    uno horizontal y otro vertical, que se cortan en su punto medio."""
    cortos = []
    for idx, p in enumerate(lineas):
        subs = puntos_pagina(p)
        if len(subs) != 1 or len(subs[0]) != 2 or es_curva(p):
            continue
        (ax, ay), (bx, by) = subs[0]
        largo = math.hypot(bx - ax, by - ay)
        if 5 <= largo <= 14:
            horiz = abs(ay - by) < 0.05
            vert = abs(ax - bx) < 0.05
            if horiz or vert:
                cortos.append((idx, "h" if horiz else "v", ((ax + bx) / 2, (ay + by) / 2)))
    quitar = set()
    # cruces armadas con medios segmentos que salen del centro
    radios = {}
    for idx, p in enumerate(lineas):
        subs = puntos_pagina(p)
        if len(subs) != 1 or len(subs[0]) != 2 or es_curva(p):
            continue
        (ax, ay), (bx, by) = subs[0]
        if (abs(ax - bx) < 0.05 or abs(ay - by) < 0.05) and 3 <= math.hypot(bx - ax, by - ay) <= 4.5:
            for x, y in subs[0]:
                radios.setdefault((round(x, 1), round(y, 1)), []).append(idx)
    for centro, idxs in radios.items():
        if len(idxs) >= 4:
            quitar.update(idxs)
    for i, ti, mi in cortos:
        for j, tj, mj in cortos:
            if ti == "h" and tj == "v" and abs(mi[0] - mj[0]) < 0.3 and abs(mi[1] - mj[1]) < 0.3:
                quitar.update((i, j))
    return [p for idx, p in enumerate(lineas) if idx not in quitar]


def es_cota_o_tilde(p, b):
    x0, y0, x1, y1, pts = b
    if len(pts) != 2 or es_curva(p):
        return False
    (ax, ay), (bx, by) = pts
    largo = math.hypot(bx - ax, by - ay)
    eje = abs(ax - bx) < 0.05 or abs(ay - by) < 0.05
    if not eje and largo < 4.5:
        return True  # tildes de cota
    if eje and largo > 30:
        return True  # líneas de cota largas
    return False


def generar(paths, nombre, cfg):
    ox, oy = cfg["origen"]
    cx0, cy0, cx1, cy1 = cfg["caja"]
    dentro = lambda b: b[0] >= cx0 and b[2] <= cx1 and b[1] >= cy0 and b[3] <= cy1

    muros, rellenos, lineas, curvas = [], [], [], []
    for p in paths:
        b = caja(p)
        if not dentro(b):
            continue
        if p["fill"] == NEGRO:
            if len(b[4]) == 7 and (b[2] - b[0]) < 4:
                continue  # cuartos negros de la cota de nivel
            muros.append(p)
        elif p["fill"] == BLANCO and (b[2] - b[0]) * (b[3] - b[1]) < 900:
            w, h = b[2] - b[0], b[3] - b[1]
            if max(w, h) < 8.5 and abs(w - h) < 1.0:
                continue  # fondo blanco de cotas de nivel y números de local
            rellenos.append(p)
        elif p["stroke"] == NEGRO and p["sw"] and abs(p["sw"] - 0.368) < 0.01:
            if es_cota_o_tilde(p, b):
                continue
            if es_curva(p) and max(b[2] - b[0], b[3] - b[1]) <= 5.2:
                curvas.append((p, b))
            else:
                lineas.append(p)
    fuera = marcadores(curvas)
    lineas += [p for i, (p, b) in enumerate(curvas) if i not in fuera]
    lineas = sin_cruces(lineas)

    def bloque(lista):
        return "\n".join(f'    <path d="{d_a_cm(p, (ox, oy))}"/>' for p in lista)

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" data-generado-por="tools/importar_pdf.py" data-unidad="cm">
  <g id="muros" class="muros">
{bloque(muros)}
  </g>
  <g id="artefactos-plano" class="detalle-relleno">
{bloque(rellenos)}
  </g>
  <g id="detalle" class="detalle">
{bloque(lineas)}
  </g>
</svg>
"""
    return svg, len(muros), len(rellenos), len(lineas)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    pdf = Path(sys.argv[1])
    raiz = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory() as tmp:
        svg_path = Path(tmp) / "plano.svg"
        subprocess.run(["pdftocairo", "-svg", str(pdf), str(svg_path)], check=True)
        paths = leer_paths(svg_path.read_text())
    for nombre, cfg in DIBUJOS.items():
        svg, nm, nr, nl = generar(paths, nombre, cfg)
        destino = raiz / "planos" / f"{nombre}.svg"
        destino.write_text(svg)
        print(f"{destino.relative_to(raiz)}: {nm} muros, {nr} rellenos, {nl} líneas")


if __name__ == "__main__":
    main()
