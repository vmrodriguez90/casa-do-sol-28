/* Casa do Sol: visor de planos, desagües, fases, proyectos y presupuestos.
   Sin dependencias ni build. Todos los datos salen de data/*.json y planos/*.svg. */
(() => {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const $ = (s, r = document) => r.querySelector(s);
  const S = {
    casa: null, fases: null, desagues: null, proyectos: null, config: null,
    svgs: {},            // nivel -> {muros, rellenos, detalle} (nodos importados)
    nivel: "pb",
    capas: { etiquetas: true, desagues: true, proyectos: true, cotas: false, exterior: true },
    sel: null,           // {tipo:'amb'|'art'|'vent', id}
    resaltar: null,      // id de ambiente pedido por URL
    fase: "actual",
    view: { x: 0, y: 0, w: 0, h: 0 },
  };

  // ---------- utilidades ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem("cds:" + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("cds:" + k, JSON.stringify(v)); } catch { /* sin storage */ } },
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function el(tag, attrs = {}, parent, text) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, v);
    if (text !== undefined) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }
  const pts = (arr) => arr.map((p) => p.join(",")).join(" ");
  function bbox(poly) {
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
    const x0 = Math.min(...xs), y0 = Math.min(...ys), x1 = Math.max(...xs), y1 = Math.max(...ys);
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  }
  const fmtM = (n) => n == null ? "–" : n.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtMoney = (n, cur) => (cur === "USD" ? "US$ " : "$ ") + Math.round(n).toLocaleString("es-AR");
  const tc = () => (S.config?.tipo_cambio?.ars_por_usd) || 1;
  const toARS = (m, cur) => cur === "USD" ? m * tc() : m;
  const toUSD = (m, cur) => cur === "USD" ? m : m / tc();
  const ambiente = (id) => S.casa.ambientes.find((a) => a.id === id);
  const nivelNombre = (id) => S.casa.niveles.find((n) => n.id === id)?.nombre || id;

  function mostrarError(msg) {
    const e = $("#error");
    e.innerHTML = msg;
    e.hidden = false;
  }

  // ---------- carga ----------
  async function cargarJSON(path) {
    let r;
    try { r = await fetch(path, { cache: "no-cache" }); }
    catch { throw new Error(`No se pudo leer <code>${path}</code>. Si abriste el archivo con doble click, levantá un servidor local (ver README).`); }
    if (!r.ok) throw new Error(`No se encontró <code>${path}</code> (${r.status}).`);
    const txt = await r.text();
    try { return JSON.parse(txt); }
    catch (err) { throw new Error(`<code>${path}</code> tiene un error de formato JSON: ${esc(err.message)}`); }
  }
  async function cargarSVG(path) {
    const r = await fetch(path, { cache: "no-cache" });
    if (!r.ok) throw new Error(`No se encontró <code>${path}</code>.`);
    const doc = new DOMParser().parseFromString(await r.text(), "image/svg+xml");
    if (doc.querySelector("parsererror")) throw new Error(`<code>${path}</code> no es un SVG válido.`);
    const g = (id) => doc.getElementById(id);
    return { muros: g("muros"), rellenos: g("artefactos-plano"), detalle: g("detalle") };
  }

  async function init() {
    try {
      const [casa, fases, desagues, proyectos, config] = await Promise.all(
        ["casa", "fases", "desagues", "proyectos", "config"].map((n) => cargarJSON(`data/${n}.json`)));
      Object.assign(S, { casa, fases, desagues, proyectos, config });
      for (const n of casa.niveles) if (n.svg) S.svgs[n.id] = await cargarSVG(n.svg);
    } catch (err) {
      mostrarError(err.message);
      return;
    }
    S.capas = Object.assign(S.capas, store.get("capas", {}));
    S.nivel = store.get("nivel", "pb");
    if (!S.casa.niveles.some((n) => n.id === S.nivel)) S.nivel = "pb";
    armarControles();
    armarZoom();
    window.addEventListener("hashchange", ruta);
    ruta();
  }

  // ---------- ruteo ----------
  function ruta() {
    const h = location.hash.replace(/^#/, "") || "plano";
    const [vista, query] = h.split("?");
    const [view, sub] = vista.split("/");
    const params = new URLSearchParams(query || "");
    const views = ["plano", "fases", "proyectos", "presupuesto"];
    const v = views.includes(view) ? view : "plano";
    for (const n of views) $(`#view-${n}`).hidden = n !== v;
    document.querySelectorAll(".tabs a").forEach((a) => {
      if (a.dataset.view === v) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    if (v === "plano") {
      if (sub && S.casa.niveles.some((n) => n.id === sub)) S.nivel = sub;
      const amb = params.get("amb");
      if (amb && ambiente(amb)) { S.nivel = ambiente(amb).nivel; S.sel = { tipo: "amb", id: amb }; }
      renderNiveles();
      renderPlano(true);
      renderDetalle();
    } else if (v === "fases") renderFases(sub);
    else if (v === "proyectos") renderProyectos();
    else renderPresupuesto();
  }

  // ---------- controles del plano ----------
  const CAPAS = [
    ["etiquetas", "Nombres y medidas"],
    ["desagues", "Desagües y ventilaciones"],
    ["proyectos", "Proyectos activos"],
    ["cotas", "Cotas generales"],
    ["exterior", "Patio, frente y vereda"],
  ];
  function armarControles() {
    const capas = $("#capas");
    capas.innerHTML = CAPAS.map(([k, t]) =>
      `<label><input type="checkbox" data-capa="${k}" ${S.capas[k] ? "checked" : ""}> ${t}</label>`).join("");
    capas.addEventListener("change", (e) => {
      const k = e.target.dataset.capa;
      if (!k) return;
      S.capas[k] = e.target.checked;
      store.set("capas", S.capas);
      renderPlano(false);
      renderLeyenda();
    });
  }
  function renderNiveles() {
    const box = $("#niveles");
    box.innerHTML = S.casa.niveles.map((n) =>
      `<button type="button" role="tab" data-nivel="${n.id}" aria-selected="${n.id === S.nivel}">${esc(n.nombre)}</button>`).join("");
    box.onclick = (e) => {
      const b = e.target.closest("button[data-nivel]");
      if (!b) return;
      S.nivel = b.dataset.nivel;
      store.set("nivel", S.nivel);
      if (S.sel?.tipo === "amb" && ambiente(S.sel.id)?.nivel !== S.nivel) S.sel = null;
      history.replaceState(null, "", `#plano/${S.nivel}`);
      renderNiveles();
      renderPlano(false);
      renderDetalle();
    };
    renderLeyenda();
  }

  function renderLeyenda() {
    const L = $("#leyenda");
    const sw = (cls, shape = "circle") => shape === "circle"
      ? `<svg width="18" height="18" viewBox="0 0 18 18"><circle cx="9" cy="9" r="7" style="fill:var(${cls})"/></svg>`
      : shape === "rect" ? `<svg width="18" height="18" viewBox="0 0 18 18"><rect x="2" y="2" width="14" height="14" rx="2" style="fill:var(${cls})"/></svg>`
      : `<svg width="22" height="18" viewBox="0 0 22 18"><line x1="2" y1="9" x2="20" y2="9" style="stroke:var(${cls});stroke-width:4;stroke-dasharray:${shape === "dash" ? "5 3" : "none"}"/></svg>`;
    let h = `<h2 class="label">Referencias</h2>`;
    if (S.capas.desagues) {
      h += `<div class="leyenda-item">${sw("--drain-1")} Artefacto a cloaca primaria</div>
            <div class="leyenda-item">${sw("--drain-2")} Artefacto a desagüe secundario</div>
            <div class="leyenda-item">${sw("--drain-0")} Sin desagüe</div>
            <div class="leyenda-item">${sw("--vent", "rect")} Ventilación / chimenea</div>
            <div class="leyenda-item">${sw("--drain-1", "line")} Cañería cloacal</div>
            <div class="leyenda-item">${sw("--drain-2", "line")} Cañería pluvial</div>
            <div class="leyenda-item">${sw("--warn", "dash")} Estimado, a verificar</div>`;
      const d = S.desagues;
      if (!d.tramos.length) {
        h += `<div class="aviso"><strong>Recorridos sin relevar.</strong> El plano no dibuja los desagües. Falta:
          <ul>${d.pendiente_relevar.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`;
      }
    }
    h += `<div class="leyenda-item">${sw("--room-wet", "rect")} Local húmedo</div>`;
    if (S.capas.proyectos) h += `<div class="leyenda-item">${sw("--accent", "dash")} Afectado por un proyecto</div>`;
    L.innerHTML = h;
  }

  // ---------- dibujo ----------
  function importar(nodo, cls, parent) {
    if (!nodo) return;
    const g = el("g", { class: cls }, parent);
    for (const c of nodo.children) g.appendChild(document.importNode(c, true));
  }

  function dibujarExterior(g, nivel, opts = {}) {
    const c = S.casa;
    const grupo = el("g", { class: nivel === "pb" ? "" : "faded" }, g);
    for (const z of c.zonas.filter((z) => z.nivel === "pb")) {
      el("polygon", { points: pts(z.poligono), class: `zona-${z.tipo}` }, grupo);
    }
    for (const e of c.elementos_exteriores) {
      if (e.tipo === "arbol") el("circle", { cx: e.centro[0], cy: e.centro[1], r: e.radio, class: "ext-arbol" }, grupo);
      else el("polyline", { points: pts(e.linea), class: { cerco: "ext-cerco", reja: "ext-reja", porton: "ext-porton", "linea-municipal": "ext-lm" }[e.tipo] }, grupo);
    }
    if (nivel === "pb" && !opts.mini) {
      el("text", { x: 707, y: 360, class: "etq-ext" }, grupo, "Patio · césped");
      el("text", { x: 490, y: 760, class: "etq-ext" }, grupo, "Galería");
      el("text", { x: 330, y: 1700, class: "etq-ext" }, grupo, "Acceso vehicular");
      el("text", { x: 1060, y: 1856, class: "etq-ext", "text-anchor": "end", style: "text-anchor:end;font-size:16px" }, grupo, "Línea municipal");
      el("text", { x: 200, y: 2000, class: "etq-ext" }, grupo, "Vereda");
      el("text", { x: 550, y: 2260, class: "etq-ext" }, grupo, "Calle 28");
    }
  }

  function dibujarTechos(g) {
    const c = S.casa;
    for (const t of c.techos) {
      const b = bbox(t.poligono);
      el("polygon", { points: pts(t.poligono), class: "techo" }, g);
      // líneas de chapa en el sentido de la pendiente
      const vertical = t.escurre === "norte-sur";
      const paso = 22;
      if (vertical) for (let x = b.x0 + paso; x < b.x1; x += paso) el("line", { x1: x, y1: b.y0, x2: x, y2: b.y1, class: "techo-chapa" }, g);
      else for (let y = b.y0 + paso; y < b.y1; y += paso) el("line", { x1: b.x0, y1: y, x2: b.x1, y2: y, class: "techo-chapa" }, g);
      if (t.cumbrera) el("polyline", { points: pts(t.cumbrera), class: "cumbrera" }, g);
      const flechas = {
        este: [[b.cx, b.cy, 0]],
        "norte-sur": [[b.cx, (b.y0 + t.cumbrera?.[0][1]) / 2, -90], [b.cx, (b.y1 + t.cumbrera?.[0][1]) / 2, 90]],
        "este-oeste": [[(b.x0 + t.cumbrera?.[0][0]) / 2, b.cy, 180], [(b.x1 + t.cumbrera?.[0][0]) / 2, b.cy, 0]],
      }[t.escurre] || [];
      for (const [x, y, ang] of flechas) {
        el("path", { d: "M-40,-14 L10,-14 L10,-32 L44,0 L10,32 L10,14 L-40,14 Z", class: "flecha", transform: `translate(${x},${y}) rotate(${ang})` }, g);
      }
      el("text", { x: b.cx, y: b.y0 + 60, class: "etq" , style: "font-size:22px" }, g, t.nombre.replace(/ \(.*\)/, ""));
      el("text", { x: b.cx, y: b.y0 + 88, class: "etq-meta" }, g, `Pendiente ${t.pendiente}`);
    }
    for (const k of c.claraboyas) el("rect", { x: k.rect[0], y: k.rect[1], width: k.rect[2], height: k.rect[3], class: "claraboya" }, g);
    for (const k of c.chimeneas) el("rect", { x: k.rect[0], y: k.rect[1], width: k.rect[2], height: k.rect[3], class: "chimenea" }, g);
  }

  function dibujarAmbientes(g, nivel, interactivo) {
    for (const a of S.casa.ambientes.filter((a) => a.nivel === nivel)) {
      const nh = a.id.includes("-nh-");
      const cls = ["amb", a.humedo ? "humedo" : "", nh ? "nh" : "", S.sel?.tipo === "amb" && S.sel.id === a.id ? "sel" : ""].join(" ");
      const p = el("polygon", { points: pts(a.poligono), class: cls, "data-amb": a.id }, g);
      if (interactivo) el("title", {}, p, a.nombre);
    }
  }

  function dibujarEtiquetas(g, nivel) {
    for (const a of S.casa.ambientes.filter((a) => a.nivel === nivel)) {
      const b = bbox(a.poligono);
      const cx = a.etiqueta?.[0] ?? b.cx, cy = a.etiqueta?.[1] ?? b.cy;
      if (a.id.includes("-nh-")) { el("text", { x: cx, y: cy, class: "etq-chica" }, g, "No habitable"); continue; }
      if (a.id.startsWith("placard")) { el("text", { x: cx, y: cy + 6, class: "etq-chica" }, g, "PL"); continue; }
      if (a.numero == null) continue;
      const chico = b.w < 260;
      const minimo = b.h < 180;
      const nombre = a.nombre.replace(/ \(.*\)/, "").replace("Cocina / comedor diario", "Cocina");
      el("text", { x: cx, y: cy - (minimo ? -6 : chico ? 8 : 12), class: "etq", style: chico ? "font-size:20px" : null }, g, nombre);
      if (a.medidas && !minimo) el("text", { x: cx, y: cy + (chico ? 16 : 20), class: "etq-meta", style: chico ? "font-size:15px" : null }, g,
        `${fmtM(a.medidas[0])} × ${fmtM(a.medidas[1])} · ${fmtM(a.area_m2)} m²`);
    }
  }

  function dibujarCotas(g, nivel) {
    const cota = (x1, y1, x2, y2, txt, off) => {
      const c = el("g", { class: "cota" }, g);
      const horiz = y1 === y2;
      const [ox, oy] = horiz ? [0, off] : [off, 0];
      el("line", { x1: x1 + ox, y1: y1 + oy, x2: x2 + ox, y2: y2 + oy }, c);
      for (const [x, y] of [[x1, y1], [x2, y2]]) {
        el("line", { x1: x + ox - 8, y1: y + oy + 8, x2: x + ox + 8, y2: y + oy - 8 }, c);
      }
      const tx = (x1 + x2) / 2 + ox, ty = (y1 + y2) / 2 + oy;
      el("text", { x: horiz ? tx : tx - 10, y: horiz ? ty - 10 : ty, transform: horiz ? null : `rotate(-90 ${tx - 10} ${ty})` }, c, txt);
    };
    if (nivel === "pb" || nivel === "techos") {
      cota(0, 0, 1100, 0, "11,00", -36);
      cota(1100, 0, 1100, 1830, "18,30 (hasta línea municipal)", 46);
      cota(0, 0, 0, 1620, "16,20", -36);
      cota(1100, 1830, 1100, 2230, "4,00", 46);
    }
    if (nivel === "pa") { cota(650, 685, 1100, 685, "4,50", -36); cota(650, 685, 650, 1620, "9,35", -36); }
    if (nivel === "ent") { cota(0, 911, 290, 911, "2,90", -30); cota(0, 911, 0, 1251, "3,40", -36); }
  }

  const ICONO = { inodoro: "I", bidet: "Bd", lavatorio: "L", pileta: "P", banera: "B", termotanque: "TT", anafe: "A", parrilla: "Pa", ducha: "D", rejilla: "R" };
  function dibujarDesagues(g, nivel) {
    const d = S.desagues;
    for (const t of d.tramos.filter((t) => t.nivel === nivel || (nivel === "techos" && t.red === "pluvial" && t.nivel === "techos"))) {
      el("polyline", { points: pts(t.puntos), class: `tramo ${t.red} ${t.estado}` }, g);
    }
    for (const c of d.camaras.filter((c) => c.nivel === nivel)) {
      const n = el("g", { class: `vent ${c.estado}`, "data-cam": c.id }, g);
      el("rect", { x: c.pos[0] - 22, y: c.pos[1] - 22, width: 44, height: 44, style: "fill:var(--drain-1)" }, n);
      el("text", { x: c.pos[0], y: c.pos[1] }, n, "CI");
    }
    for (const v of d.ventilaciones.filter((v) => v.nivel === nivel)) {
      const n = el("g", { class: "vent", "data-vent": v.id, style: "cursor:pointer" }, g);
      el("rect", { x: v.pos[0] - 13, y: v.pos[1] - 10, width: 26, height: 20, rx: 3 }, n);
      el("text", { x: v.pos[0], y: v.pos[1] }, n, v.id.startsWith("ch") ? "CH" : v.id.startsWith("cv") ? "CV" : "V");
      el("title", {}, n, v.nombre);
    }
    for (const a of d.artefactos.filter((a) => a.nivel === nivel)) {
      const tipo = a.desague === "primario" ? "primario" : a.desague === "secundario" ? "secundario" : "sin";
      const n = el("g", { class: `art ${tipo} ${a.estado}`, "data-art": a.id }, g);
      el("circle", { cx: a.pos[0], cy: a.pos[1], r: 17 }, n);
      el("text", { x: a.pos[0], y: a.pos[1] }, n, ICONO[a.tipo] || "•");
      el("title", {}, n, a.nombre);
    }
  }

  function proyectosActivos() {
    return S.proyectos.proyectos.filter((p) => !["terminado", "descartado"].includes(p.estado));
  }
  function dibujarProyectos(g, nivel) {
    for (const p of proyectosActivos()) {
      for (const id of p.ambientes || []) {
        const a = ambiente(id);
        if (a && a.nivel === nivel) el("polygon", { points: pts(a.poligono), class: "proy-amb" }, g);
      }
      for (const o of (p.overlay || []).filter((o) => o.nivel === nivel)) {
        if (o.tipo === "poligono") el("polygon", { points: pts(o.puntos), class: "proy-ov" }, g);
        else if (o.tipo === "linea") el("polyline", { points: pts(o.puntos), class: "proy-ov", style: "fill:none" }, g);
        else if (o.tipo === "punto") el("circle", { cx: o.puntos[0][0], cy: o.puntos[0][1], r: 18, class: "proy-ov" }, g);
        if (o.etiqueta) { const b = bbox(o.puntos); el("text", { x: b.cx, y: b.y0 - 14, class: "etq-meta", style: "fill:var(--f-futura)" }, g, o.etiqueta); }
      }
    }
  }

  /** Dibuja una planta completa dentro de `svg`. */
  function dibujarPlanta(svg, nivel, opts = {}) {
    svg.innerHTML = "";
    const niv = S.casa.niveles.find((n) => n.id === nivel);
    const capas = opts.capas || S.capas;
    const raiz = el("g", {}, svg);
    if (capas.exterior || opts.mini) dibujarExterior(raiz, nivel, opts);
    if (niv.fantasma && S.svgs[niv.fantasma]) importar(S.svgs[niv.fantasma].muros, "ghost", raiz);
    if (nivel !== "techos") {
      dibujarAmbientes(el("g", {}, raiz), nivel, !opts.mini);
      if (opts.fase) opts.fase(raiz);
      const s = S.svgs[nivel];
      if (s) { importar(s.rellenos, "relleno-svg", raiz); importar(s.detalle, "detalle-svg", raiz); importar(s.muros, "muros", raiz); }
    } else {
      dibujarTechos(el("g", {}, raiz));
    }
    if (opts.mini) return;
    if (capas.cotas) dibujarCotas(el("g", {}, raiz), nivel);
    if (capas.proyectos) dibujarProyectos(el("g", {}, raiz), nivel);
    if (capas.etiquetas && nivel !== "techos") dibujarEtiquetas(el("g", {}, raiz), nivel);
    if (capas.desagues) dibujarDesagues(el("g", {}, raiz), nivel);
  }

  // ---------- plano interactivo ----------
  function renderPlano(resetView) {
    const svg = $("#plano");
    const niv = S.casa.niveles.find((n) => n.id === S.nivel);
    if (resetView || !S.view.w) { const [x, y, w, h] = niv.viewBox; S.view = { x, y, w, h }; }
    aplicarVista();
    dibujarPlanta(svg, S.nivel);
    svg.setAttribute("aria-label", `Plano: ${niv.nombre}`);
  }
  function aplicarVista() {
    const v = S.view;
    $("#plano").setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
  }

  function armarZoom() {
    const svg = $("#plano");
    const zoomEn = (f, cx, cy) => {
      const v = S.view;
      const nw = Math.min(Math.max(v.w * f, 150), 4000);
      const k = nw / v.w;
      S.view = { x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k, w: nw, h: v.h * k };
      aplicarVista();
    };
    const aSVG = (cx, cy) => {
      const p = svg.createSVGPoint(); p.x = cx; p.y = cy;
      return p.matrixTransform(svg.getScreenCTM().inverse());
    };
    svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const p = aSVG(e.clientX, e.clientY);
      zoomEn(Math.exp(e.deltaY * 0.0015), p.x, p.y);
    }, { passive: false });

    const punteros = new Map();
    let arrastre = null, pinch = null, movido = false;
    svg.addEventListener("pointerdown", (e) => {
      punteros.set(e.pointerId, { x: e.clientX, y: e.clientY });
      movido = false;
      if (punteros.size === 1) arrastre = { x: e.clientX, y: e.clientY, view: { ...S.view } };
      if (punteros.size === 2) {
        const [a, b] = [...punteros.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), view: { ...S.view } };
        arrastre = null;
      }
    });
    svg.addEventListener("pointermove", (e) => {
      if (!punteros.has(e.pointerId)) return;
      punteros.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const rect = svg.getBoundingClientRect();
      const escala = Math.max(S.view.w / rect.width, S.view.h / rect.height);
      if (arrastre) {
        const dx = e.clientX - arrastre.x, dy = e.clientY - arrastre.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) { movido = true; svg.classList.add("dragging"); svg.setPointerCapture(e.pointerId); }
        if (movido) { S.view = { ...arrastre.view, x: arrastre.view.x - dx * escala, y: arrastre.view.y - dy * escala }; aplicarVista(); }
      } else if (pinch && punteros.size === 2) {
        movido = true;
        const [a, b] = [...punteros.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        S.view = { ...pinch.view };
        const c = aSVG((a.x + b.x) / 2, (a.y + b.y) / 2);
        zoomEn(pinch.d / d, c.x, c.y);
      }
    });
    const fin = (e) => {
      punteros.delete(e.pointerId);
      if (punteros.size < 2) pinch = null;
      if (punteros.size === 0) { arrastre = null; svg.classList.remove("dragging"); }
    };
    svg.addEventListener("pointerup", fin);
    svg.addEventListener("pointercancel", fin);

    svg.addEventListener("click", (e) => {
      if (movido) return;
      const t = e.target.closest("[data-amb],[data-art],[data-vent]");
      if (!t) { S.sel = null; }
      else if (t.dataset.art) S.sel = { tipo: "art", id: t.dataset.art };
      else if (t.dataset.vent) S.sel = { tipo: "vent", id: t.dataset.vent };
      else S.sel = { tipo: "amb", id: t.dataset.amb };
      renderPlano(false);
      renderDetalle();
    });

    document.querySelector(".zoom").addEventListener("click", (e) => {
      const z = e.target.closest("button")?.dataset.zoom;
      if (!z) return;
      const v = S.view;
      if (z === "reset") renderPlano(true);
      else zoomEn(z === "in" ? 0.75 : 1.33, v.x + v.w / 2, v.y + v.h / 2);
    });
  }

  function tareasDe(p) {
    const t = p.tareas || [];
    return { total: t.length, hechas: t.filter((x) => x.estado === "hecha").length };
  }

  function renderDetalle() {
    const box = $("#detalle");
    const s = S.sel;
    if (!s) { box.innerHTML = `<p class="muted">Tocá un ambiente o un artefacto para ver sus datos.</p>`; return; }
    if (s.tipo === "amb") {
      const a = ambiente(s.id);
      if (!a) { box.innerHTML = ""; return; }
      const arts = S.desagues.artefactos.filter((x) => x.ambiente === a.id);
      const vents = S.desagues.ventilaciones.filter((x) => x.ambiente === a.id);
      const proys = S.proyectos.proyectos.filter((p) => (p.ambientes || []).includes(a.id));
      box.innerHTML = `
        <h3>${a.numero ? `<span class="muted">${a.numero} · </span>` : ""}${esc(a.nombre)}</h3>
        <span class="muted">${esc(nivelNombre(a.nivel))}${a.humedo ? " · local húmedo" : ""}</span>
        <dl>
          ${a.medidas ? `<dt>Medidas</dt><dd>${fmtM(a.medidas[0])} × ${fmtM(a.medidas[1])} m</dd>` : ""}
          ${a.area_m2 ? `<dt>Superficie</dt><dd>${fmtM(a.area_m2)} m²</dd>` : ""}
          ${a.cota_piso ? `<dt>Nivel de piso</dt><dd>${esc(a.cota_piso)} m</dd>` : ""}
        </dl>
        ${a.nota ? `<p>${esc(a.nota)}</p>` : ""}
        ${arts.length || vents.length ? `<strong>Instalaciones</strong><ul class="mini">${[...arts, ...vents].map((x) => `<li>${esc(x.nombre)} <span class="muted">(${esc(x.estado)})</span></li>`).join("")}</ul>` : ""}
        ${proys.length ? `<p style="margin-top:10px"><strong>Proyectos</strong></p><ul class="mini">${proys.map((p) => {
          const t = tareasDe(p);
          return `<li><a href="#proyectos">${esc(p.nombre)}</a> <span class="muted">· ${esc(p.estado)} · ${t.hechas}/${t.total} tareas</span></li>`;
        }).join("")}</ul>` : ""}`;
    } else {
      const lista = s.tipo === "art" ? S.desagues.artefactos : S.desagues.ventilaciones;
      const x = lista.find((y) => y.id === s.id);
      if (!x) { box.innerHTML = ""; return; }
      const a = x.ambiente ? ambiente(x.ambiente) : null;
      const des = { primario: "Cloaca primaria", secundario: "Desagüe secundario (a pileta de patio)", false: "No tiene" };
      box.innerHTML = `
        <h3>${esc(x.nombre)}</h3>
        <span class="muted">${esc(nivelNombre(x.nivel))}${a ? " · " + esc(a.nombre) : ""}</span>
        <dl>
          ${s.tipo === "art" ? `<dt>Desagüe</dt><dd>${des[String(x.desague)] || esc(x.desague)}</dd>` : ""}
          <dt>Estado</dt><dd>${{ plano: "Figura en el plano", estimado: "Estimado, a verificar", verificado: "Verificado en obra" }[x.estado] || esc(x.estado)}</dd>
        </dl>
        ${x.nota ? `<p>${esc(x.nota)}</p>` : ""}
        <p class="muted" style="font-size:13px">La posición es aproximada. Para corregirla, editá <code>data/desagues.json</code>.</p>`;
    }
  }

  // ---------- fases ----------
  function colorFase(f) { return `var(--f-${f.tipo === "futura" ? "futura" : f.color})`; }
  function renderFases(sub) {
    const F = S.fases.fases;
    if (sub && F.some((f) => f.id === sub)) S.fase = sub;
    const sel = F.find((f) => f.id === S.fase) || F[F.length - 1];
    $("#timeline").innerHTML = F.map((f) => `
      <li><button type="button" data-fase="${f.id}" aria-pressed="${f.id === sel.id}" style="--c:${f.tipo === "actual" ? "var(--ink)" : colorFase(f)}">
        <span class="t-fecha">${esc(f.fecha || "fecha sin datos")}</span>
        <span class="t-nombre">${esc(f.nombre)}</span>
        <span class="t-m2">${fmtM(f.total_m2)} m²</span>
      </button></li>`).join("");
    $("#timeline").onclick = (e) => {
      const b = e.target.closest("[data-fase]");
      if (b) location.hash = `#fases/${b.dataset.fase}`;
    };

    // qué superficies mostrar: la fase elegida fuerte, las anteriores tenues
    const idx = F.indexOf(sel);
    const capas = [];
    if (sel.tipo === "actual") {
      for (const id of sel.incluye) { const f = F.find((x) => x.id === id); if (f) capas.push({ f, prev: false }); }
    } else {
      F.slice(0, idx + 1).forEach((f, i) => { if (f.superficies.length) capas.push({ f, prev: i < idx }); });
    }
    const filas = (sel.tipo === "actual" ? capas.map((c) => c.f) : [sel]).flatMap((f) => f.superficies.map((s) => ({ f, s })));
    $("#fase-info").innerHTML = `
      <h3>${esc(sel.nombre)}</h3>
      <p class="muted" style="margin:4px 0 0">${esc(sel.descripcion || "")}</p>
      ${filas.length ? `<table>
        <thead><tr><th>N°</th><th>Planta</th><th>Tipo</th><th>Medidas</th><th class="num">m²</th>${sel.tipo === "actual" ? "<th>Etapa</th>" : ""}</tr></thead>
        <tbody>${filas.map(({ f, s }) => `<tr><td>${s.n}</td><td>${esc(nivelNombre(s.nivel))}</td><td>${esc(s.tipo)}</td><td>${esc(s.medidas)}</td><td class="num">${fmtM(s.m2)}</td>${sel.tipo === "actual" ? `<td><span style="color:${colorFase(f)}">●</span> ${esc(f.nombre)}</td>` : ""}</tr>`).join("")}
          <tr><td colspan="4"><strong>Total</strong></td><td class="num"><strong>${fmtM(sel.total_m2)}</strong></td>${sel.tipo === "actual" ? "<td></td>" : ""}</tr>
        </tbody></table>` : ""}`;

    const cont = $("#fase-planos");
    cont.innerHTML = "";
    for (const nivel of ["pb", "ent", "pa"]) {
      const fig = document.createElement("figure");
      fig.innerHTML = `<figcaption>${esc(nivelNombre(nivel))}</figcaption>`;
      const svg = el("svg", { viewBox: "-40 -40 1220 1760", role: "img", "aria-label": `${nivelNombre(nivel)}: ${sel.nombre}` });
      fig.appendChild(svg);
      cont.appendChild(fig);
      dibujarPlanta(svg, nivel, {
        mini: true,
        fase: (g) => {
          for (const { f, prev } of capas) {
            for (const s of f.superficies.filter((s) => s.nivel === nivel)) {
              el("polygon", { points: pts(s.poligono), class: `fase-poly ${prev ? "prev" : ""}`, style: `fill:${colorFase(f)};stroke:${colorFase(f)}` }, g);
              if (!prev) {
                const b = bbox(s.poligono);
                el("text", { x: b.cx, y: b.cy, class: "fase-n" }, g, s.n);
                el("text", { x: b.cx, y: b.cy + 30, class: "fase-m2" }, g, `${fmtM(s.m2)} m²`);
              }
            }
          }
        },
      });
    }
  }

  // ---------- proyectos ----------
  const ESTADOS = ["idea", "planificado", "en-curso", "terminado", "descartado"];
  function subtotales(p) {
    let ars = 0, usd = 0;
    for (const i of p.presupuesto || []) { ars += toARS(i.monto, i.moneda); usd += toUSD(i.monto, i.moneda); }
    return { ars, usd };
  }
  function renderProyectos() {
    const P = S.proyectos.proyectos;
    const fe = $("#f-estado"), fa = $("#f-ambiente");
    if (fe.options.length === 1) {
      fe.insertAdjacentHTML("beforeend", ESTADOS.map((e) => `<option value="${e}">${e}</option>`).join(""));
      const usados = [...new Set(P.flatMap((p) => p.ambientes || []))];
      fa.insertAdjacentHTML("beforeend", usados.map((id) => `<option value="${id}">${esc(ambiente(id)?.nombre || id)}</option>`).join(""));
      fe.onchange = fa.onchange = renderProyectos;
    }
    const lista = P.filter((p) => (!fe.value || p.estado === fe.value) && (!fa.value || (p.ambientes || []).includes(fa.value)));
    const box = $("#proyectos");
    if (!lista.length) { box.innerHTML = `<div class="empty">No hay proyectos con ese filtro.</div>`; return; }
    box.innerHTML = lista.map((p) => {
      const t = tareasDe(p);
      const st = subtotales(p);
      return `<article class="card">
        <div class="badges"><span class="badge ${p.estado}">${esc(p.estado)}</span>${p.prioridad ? `<span class="badge ${p.prioridad}">prioridad ${esc(p.prioridad)}</span>` : ""}</div>
        <h3>${esc(p.nombre)}</h3>
        <p>${esc(p.descripcion || "")}</p>
        ${(p.ambientes || []).length ? `<div class="chips">${p.ambientes.map((id) => `<a href="#plano?amb=${id}">${esc(ambiente(id)?.nombre || id)}</a>`).join("")}</div>` : ""}
        ${t.total ? `<div><div class="bar" title="${t.hechas} de ${t.total} tareas"><span style="width:${(100 * t.hechas / t.total).toFixed(0)}%"></span></div>
          <span class="muted" style="font-size:12px">${t.hechas} de ${t.total} tareas</span></div>
          <ul class="tareas">${p.tareas.map((x) => `<li class="${x.estado}"><span class="chk"></span><span>${esc(x.titulo)}${x.responsable ? ` <span class="muted">· ${esc(x.responsable)}</span>` : ""}${x.fecha ? ` <span class="muted">· ${esc(x.fecha)}</span>` : ""}</span></li>`).join("")}</ul>` : ""}
        <div class="subtotal"><span class="muted">Presupuesto</span><span>${(p.presupuesto || []).length ? `${fmtMoney(st.ars, "ARS")} · ${fmtMoney(st.usd, "USD")}` : "sin cargar"}</span></div>
      </article>`;
    }).join("");
  }

  // ---------- presupuesto ----------
  function renderPresupuesto() {
    const P = S.proyectos.proyectos;
    const items = P.flatMap((p) => (p.presupuesto || []).map((i) => ({ p, i })));
    const porEstado = { estimado: [0, 0], cotizado: [0, 0], pagado: [0, 0] };
    let total = [0, 0];
    for (const { i } of items) {
      const a = toARS(i.monto, i.moneda), u = toUSD(i.monto, i.moneda);
      total[0] += a; total[1] += u;
      if (porEstado[i.estado]) { porEstado[i.estado][0] += a; porEstado[i.estado][1] += u; }
    }
    const t = S.config.tipo_cambio;
    const tile = (k, [a, u]) => `<div class="tot"><div class="k">${k}</div><div class="v">${fmtMoney(a, "ARS")}</div><div class="v2">${fmtMoney(u, "USD")}</div></div>`;
    $("#totales").innerHTML = tile("Total", total) + tile("Estimado", porEstado.estimado) + tile("Cotizado", porEstado.cotizado) + tile("Pagado", porEstado.pagado) +
      `<div class="tot"><div class="k">Tipo de cambio</div><div class="v">$ ${tc().toLocaleString("es-AR")}</div><div class="v2">por US$ · ${esc(t.fecha || "")} · ${esc(t.fuente || "")}</div></div>`;
    const box = $("#presupuesto");
    if (!items.length) {
      box.innerHTML = `<div class="empty">
        <p><strong>Todavía no hay presupuestos cargados.</strong> Agregá ítems en la lista <code>presupuesto</code> de cada proyecto en <code>data/proyectos.json</code>. Cada ítem va en su moneda original y la página calcula el equivalente con el tipo de cambio de <code>data/config.json</code>.</p>
        <pre>"presupuesto": [
  { "concepto": "Destapación y cámara nueva", "proveedor": "Plomero X",
    "monto": 350000, "moneda": "ARS", "estado": "cotizado", "fecha": "2026-12-01" },
  { "concepto": "Inodoro y bidet", "proveedor": "Corralón Y",
    "monto": 420, "moneda": "USD", "estado": "estimado" }
]</pre></div>`;
      return;
    }
    let rows = "";
    for (const p of P.filter((p) => (p.presupuesto || []).length)) {
      const st = subtotales(p);
      rows += `<tr class="grupo"><td colspan="4">${esc(p.nombre)}</td><td class="num">${fmtMoney(st.ars, "ARS")}</td><td class="num">${fmtMoney(st.usd, "USD")}</td></tr>`;
      rows += p.presupuesto.map((i) => `<tr>
        <td>${esc(i.concepto)}</td><td>${esc(i.proveedor || "")}</td><td><span class="badge">${esc(i.estado)}</span></td>
        <td class="num">${fmtMoney(i.monto, i.moneda)}</td><td class="num">${fmtMoney(toARS(i.monto, i.moneda), "ARS")}</td><td class="num">${fmtMoney(toUSD(i.monto, i.moneda), "USD")}</td></tr>`).join("");
    }
    box.innerHTML = `<div class="tabla-wrap"><table class="tabla">
      <thead><tr><th>Concepto</th><th>Proveedor</th><th>Estado</th><th class="num">Monto original</th><th class="num">En ARS</th><th class="num">En USD</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  init();
})();
