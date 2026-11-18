#!/usr/bin/env python3
"""
Extrae las cotas (líneas de cota + su texto) del plano en PDF y las guarda en
planos/cotas.json, en centímetros de la casa. Solo se queda con las cotas cuyo
largo medido coincide con el número escrito (±4 cm), así no entra basura.

    python3 tools/extraer_cotas.py privado/obra.pdf
"""
import html
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from importar_pdf import DIBUJOS, K, NEGRO, leer_paths, puntos_pagina  # noqa: E402

MARGEN = 30  # pt alrededor de cada dibujo, para cotas exteriores


def palabras(pdf):
    out = subprocess.run(["pdftotext", "-bbox", str(pdf), "-"], capture_output=True, text=True, check=True).stdout
    res = []
    for m in re.finditer(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)</word>', out):
        x0, y0, x1, y1 = map(float, m.groups()[:4])
        t = html.unescape(m.group(5))
        if re.fullmatch(r"\d{1,2},\d{2}", t):
            res.append({"t": t, "v": float(t.replace(",", ".")), "cx": (x0 + x1) / 2, "cy": (y0 + y1) / 2,
                        "vertical": (y1 - y0) > (x1 - x0)})
    return res


def main():
    pdf = Path(sys.argv[1])
    raiz = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory() as tmp:
        svg = Path(tmp) / "p.svg"
        subprocess.run(["pdftocairo", "-svg", str(pdf), str(svg)], check=True)
        paths = leer_paths(svg.read_text())
    lineas = []
    for p in paths:
        if p["stroke"] != NEGRO or not p["sw"] or abs(p["sw"] - 0.368) > 0.01 or " C " in p["d"]:
            continue
        subs = puntos_pagina(p)
        if len(subs) != 1 or len(subs[0]) != 2:
            continue
        (ax, ay), (bx, by) = subs[0]
        if abs(ay - by) < 0.05:
            lineas.append(("h", min(ax, bx), max(ax, bx), ay))
        elif abs(ax - bx) < 0.05:
            lineas.append(("v", min(ay, by), max(ay, by), ax))
    words = palabras(pdf)
    salida = {}
    for nombre, cfg in DIBUJOS.items():
        ox, oy = cfg["origen"]
        cx0, cy0, cx1, cy1 = cfg["caja"]
        cotas = []
        for w in words:
            if not (cx0 - MARGEN <= w["cx"] <= cx1 + MARGEN and cy0 - MARGEN <= w["cy"] <= cy1 + MARGEN):
                continue
            mejor = None
            for o, a, b, c in lineas:
                if (o == "v") != w["vertical"]:
                    continue
                largo_cm = (b - a) * K
                if abs(largo_cm - w["v"] * 100) > 4:
                    continue
                if o == "h":
                    dist = abs(c - w["cy"]); dentro = a - 1 <= w["cx"] <= b + 1
                else:
                    dist = abs(c - w["cx"]); dentro = a - 1 <= w["cy"] <= b + 1
                if dentro and dist < 7 and (mejor is None or dist < mejor[0]):
                    mejor = (dist, o, a, b, c)
            if not mejor:
                continue
            _, o, a, b, c = mejor
            if o == "h":
                p1 = [(a - ox) * K, (c - oy) * K]; p2 = [(b - ox) * K, (c - oy) * K]
                lado = -1 if w["cy"] < c else 1
            else:
                p1 = [(c - ox) * K, (a - oy) * K]; p2 = [(c - ox) * K, (b - oy) * K]
                lado = -1 if w["cx"] < c else 1
            cota = {"p1": [round(v) for v in p1], "p2": [round(v) for v in p2], "texto": w["t"], "lado": lado}
            if cota not in cotas:
                cotas.append(cota)
        salida[nombre] = cotas
        print(f"{nombre}: {len(cotas)} cotas")
    (raiz / "planos" / "cotas.json").write_text(json.dumps(salida, ensure_ascii=False, indent=1) + "\n")


if __name__ == "__main__":
    main()
