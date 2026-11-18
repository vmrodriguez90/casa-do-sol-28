#!/usr/bin/env python3
"""
Servidor local para ver el sitio y guardar marcas de revisión.

    python3 tools/servidor.py          # http://localhost:8765

Sirve la carpeta del repo igual que `python3 -m http.server`, y además expone
una API mínima para las marcas de revisión que se dibujan en el plano:

    GET    /api/revision          → lista de marcas
    POST   /api/revision          → crea una marca (JSON en el cuerpo)
    PUT    /api/revision/<id>     → actualiza campos de una marca
    DELETE /api/revision/<id>     → borra una marca

Las marcas se guardan en revision/notas.json, que está en .gitignore: es solo
para iterar en local, no se publica. Solo escucha en 127.0.0.1.
"""
import json
import sys
import threading
import uuid
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
ARCHIVO = RAIZ / "revision" / "notas.json"
CANDADO = threading.Lock()
CAMPOS_EDITABLES = {"texto", "estado", "respuesta", "rect", "nivel"}


def leer():
    if not ARCHIVO.exists():
        return {"_ayuda": "Marcas de revisión dibujadas en el plano. Solo local (no se sube a git).", "notas": []}
    return json.loads(ARCHIVO.read_text(encoding="utf-8"))


def guardar(datos):
    ARCHIVO.parent.mkdir(exist_ok=True)
    tmp = ARCHIVO.with_suffix(".tmp")
    tmp.write_text(json.dumps(datos, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(ARCHIVO)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(RAIZ), **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, codigo, cuerpo):
        datos = json.dumps(cuerpo, ensure_ascii=False).encode("utf-8")
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(datos)))
        self.end_headers()
        self.wfile.write(datos)

    def _cuerpo(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 200_000:
            raise ValueError("cuerpo demasiado grande")
        return json.loads(self.rfile.read(n) or b"{}")

    def _id(self):
        partes = self.path.split("?")[0].rstrip("/").split("/")
        return partes[3] if len(partes) == 4 else None

    def do_GET(self):
        if self.path.split("?")[0].rstrip("/") == "/api/revision":
            with CANDADO:
                return self._json(200, leer())
        return super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0].rstrip("/") != "/api/revision":
            return self._json(404, {"error": "no existe"})
        try:
            nueva = self._cuerpo()
        except ValueError as e:
            return self._json(400, {"error": str(e)})
        if not str(nueva.get("texto", "")).strip() or not isinstance(nueva.get("rect"), list):
            return self._json(400, {"error": "falta texto o rect"})
        ahora = datetime.now().isoformat(timespec="seconds")
        nota = {
            "id": uuid.uuid4().hex[:8],
            "creada": ahora,
            "actualizada": ahora,
            "estado": "abierta",
            "nivel": nueva.get("nivel"),
            "rect": nueva["rect"],
            "texto": nueva["texto"].strip(),
            "contexto": nueva.get("contexto", {}),
            "respuesta": None,
        }
        with CANDADO:
            datos = leer()
            nota["n"] = max([x.get("n", 0) for x in datos["notas"]] + [0]) + 1
            datos["notas"].append(nota)
            guardar(datos)
        return self._json(201, nota)

    def do_PUT(self):
        nid = self._id()
        try:
            cambios = self._cuerpo()
        except ValueError as e:
            return self._json(400, {"error": str(e)})
        with CANDADO:
            datos = leer()
            for nota in datos["notas"]:
                if nota["id"] == nid:
                    nota.update({k: v for k, v in cambios.items() if k in CAMPOS_EDITABLES})
                    nota["actualizada"] = datetime.now().isoformat(timespec="seconds")
                    guardar(datos)
                    return self._json(200, nota)
        return self._json(404, {"error": "no existe"})

    def do_DELETE(self):
        nid = self._id()
        with CANDADO:
            datos = leer()
            antes = len(datos["notas"])
            datos["notas"] = [x for x in datos["notas"] if x["id"] != nid]
            if len(datos["notas"]) == antes:
                return self._json(404, {"error": "no existe"})
            guardar(datos)
        return self._json(200, {"ok": True})


def main():
    puerto = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    srv = ThreadingHTTPServer(("127.0.0.1", puerto), Handler)
    print(f"Casa do Sol en http://localhost:{puerto}  ·  marcas en {ARCHIVO.relative_to(RAIZ)}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
