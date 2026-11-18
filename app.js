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
    capas: { etiquetas: true, muebles: true, desagues: true, agua: false, proyectos: true, cotas: false, exterior: true },
    sel: null,           // {tipo:'amb'|'art'|'vent', id}
    resaltar: null,      // id de ambiente pedido por URL
    fase: "actual",
    rev: { on: false, notas: [], marcando: false, borrador: null },
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
    await cargarRevision();
    if (S.rev.on) { CAPAS.push(["revision", "Marcas de revisión"]); S.capas.revision = true; }
    S.capas = Object.assign(S.capas, store.get("capas", {}));
    S.nivel = store.get("nivel", "pb");
    if (!S.casa.niveles.some((n) => n.id === S.nivel)) S.nivel = "pb";
    armarControles();
    armarZoom();
    armarTema();
    armarRevision();
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

  // ---------- modo día / noche ----------
  function armarTema() {
    const box = document.querySelector(".tema");
    const pintar = () => {
      const actual = store.get("tema", "auto");
      box.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tema === actual)));
    };
    box.addEventListener("click", (e) => {
      const t = e.target.closest("button")?.dataset.tema;
      if (!t) return;
      store.set("tema", t);
      if (t === "auto") document.documentElement.removeAttribute("data-theme");
      else document.documentElement.setAttribute("data-theme", t);
      pintar();
    });
    pintar();
  }

  // ---------- controles del plano ----------
  const CAPAS = [
    ["etiquetas", "Nombres y medidas"],
    ["muebles", "Muebles y equipamiento"],
    ["desagues", "Desagües y ventilaciones"],
    ["agua", "Agua (fría y caliente)"],
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
    if (S.capas.agua) {
      h += `<div class="leyenda-item">${sw("--water", "line")} Agua fría</div>
            <div class="leyenda-item">${sw("--hot", "line")} Agua caliente</div>
            <div class="leyenda-item"><span><b>M</b> medidor · <b>AF</b> subida · <b>BT</b> bajada de tanque · <b>TR</b> tanque</span></div>`;
    }
    if (S.capas.desagues) {
      h += `<div class="leyenda-item">${sw("--drain-1")} Artefacto a cloaca primaria</div>
            <div class="leyenda-item">${sw("--drain-2")} Artefacto a desagüe secundario</div>
            <div class="leyenda-item">${sw("--drain-0")} Sin desagüe</div>
            <div class="leyenda-item">${sw("--vent", "rect")} Ventilación / chimenea</div>
            <div class="leyenda-item">${sw("--drain-1", "line")} Cloaca primaria (Ø 100)</div>
            <div class="leyenda-item">${sw("--drain-2", "line")} Desagüe secundario</div>
            <div class="leyenda-item">${sw("--rain", "line")} Pluvial</div>
            <div class="leyenda-item"><svg width="18" height="18" viewBox="0 0 18 18"><rect x="2" y="2" width="14" height="14" rx="7" style="fill:var(--surface);stroke:var(--drain-1);stroke-width:2"/></svg> Pileta de patio (PPA / PPC) · <b style="font-weight:600">CI</b> cámara</div>
            <div class="leyenda-item">${sw("--warn", "dash")} Estimado, a verificar</div>`;
      const d = S.desagues;
      if ((d.pasos || []).length) {
        h += `<div class="aviso"><strong>Plano sanitario 1998: carga por pasos</strong>
          <ul class="pasos">${d.pasos.map((x) => `<li class="${x.estado}">${x.estado === "aplicado" ? "✓" : "○"} ${x.n}. ${esc(x.titulo)}</li>`).join("")}</ul></div>`;
      }
      if ((d.notas_plano || []).length) {
        h += `<details class="notas-plano"><summary>Notas del plano sanitario</summary><ul>${d.notas_plano.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>`;
      }
      if ((d.pendiente_relevar || []).length) {
        h += `<details class="notas-plano"><summary>Falta verificar en obra (${d.pendiente_relevar.length})</summary><ul>${d.pendiente_relevar.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>`;
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

  const ICONO = { lavarropas: "Lr", inodoro: "I", bidet: "Bd", lavatorio: "L", pileta: "P", banera: "B", termotanque: "TT", anafe: "A", parrilla: "Pa", ducha: "D", rejilla: "R" };
  const RED_AGUA = ["agua", "agua-caliente"], TIPO_AGUA = ["medidor", "subida-agua", "bajada-agua", "tanque"];
  const esAgua = (o) => RED_AGUA.includes(o.red) || TIPO_AGUA.includes(o.tipo);
  function dibujarDesagues(g, nivel, capas = S.capas) {
    const d = S.desagues;
    const ver = (o) => o.nivel === nivel && (esAgua(o) ? capas.agua : capas.desagues);
    for (const t of d.tramos.filter(ver)) {
      const sel = S.sel?.tipo === "tramo" && S.sel.id === t.id;
      el("polyline", { points: pts(t.puntos), class: `tramo ${t.red} ${t.estado} ${t.tipo || ""}${sel ? " sel" : ""}` }, g);
      const hit = el("polyline", { points: pts(t.puntos), class: "tramo-hit", "data-tramo": t.id }, g);
      el("title", {}, hit, t.nombre);
      // flecha de sentido de escurrimiento en el último segmento
      const [a, b] = t.puntos.slice(-2);
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
      el("path", { d: "M-14,-11 L10,0 L-14,11 Z", class: `tramo-flecha ${t.red}`, transform: `translate(${(a[0] + b[0]) / 2},${(a[1] + b[1]) / 2}) rotate(${ang})` }, g);
    }
    for (const c of d.camaras.filter(ver)) {
      const bajada = (c.tipo || "").startsWith("bajada");
      const chica = bajada || (c.tipo || "").startsWith("pileta") || ["subida-agua", "medidor"].includes(c.tipo);
      const r = bajada ? 15 : chica ? 17 : 22;
      const sel = S.sel?.tipo === "cam" && S.sel.id === c.id;
      const n = el("g", { class: `camara ${c.estado}${chica ? " pp" : ""}${bajada ? " bajada" : ""} ${c.tipo || ""}${sel ? " sel" : ""}`, "data-cam": c.id }, g);
      el("rect", { x: c.pos[0] - r, y: c.pos[1] - r, width: 2 * r, height: 2 * r, rx: chica ? r : 4 }, n);
      el("text", { x: c.pos[0], y: c.pos[1], style: chica ? "font-size:11px" : null }, n, c.sigla || "CI");
      el("title", {}, n, c.nombre);
    }
    for (const v of d.ventilaciones.filter((v) => v.nivel === nivel && capas.desagues)) {
      const n = el("g", { class: "vent", "data-vent": v.id, style: "cursor:pointer" }, g);
      el("rect", { x: v.pos[0] - 13, y: v.pos[1] - 10, width: 26, height: 20, rx: 3 }, n);
      el("text", { x: v.pos[0], y: v.pos[1] }, n, v.id.startsWith("ch") ? "CH" : v.id.startsWith("cv") ? "CV" : "V");
      el("title", {}, n, v.nombre);
    }
    for (const a of d.artefactos.filter((a) => a.nivel === nivel && (capas.desagues || capas.agua))) {
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
        const cls = `proy-ov ov-${o.estilo || "nuevo"}`;
        if (o.tipo === "poligono") el("polygon", { points: pts(o.puntos), class: cls }, g);
        else if (o.tipo === "linea") el("polyline", { points: pts(o.puntos), class: cls + " ov-linea" }, g);
        else if (o.tipo === "punto") el("rect", { x: o.puntos[0][0] - 10, y: o.puntos[0][1] - 10, width: 20, height: 20, class: cls }, g);
        if (o.etiqueta) {
          const b = bbox(o.puntos);
          const t = o.tipo === "punto"
            ? el("text", { x: b.cx + 18, y: b.cy + 6, class: `ov-etq ov-${o.estilo || "nuevo"}-t`, style: "text-anchor:start" }, g, o.etiqueta)
            : o.tipo === "linea"
              ? el("text", { x: b.x0 + 10, y: b.y0 - 8, class: `ov-etq ov-${o.estilo || "nuevo"}-t`, style: "text-anchor:start" }, g, o.etiqueta)
              : el("text", { x: b.cx, y: b.h > 200 ? b.cy : b.y0 - 12, class: `ov-etq ov-${o.estilo || "nuevo"}-t` }, g, o.etiqueta);
          t.dataset.proy = p.id;
        }
      }
    }
  }

  /** Esconde líneas del plano importado que caen completas dentro de los recuadros de corrección. */
  function ocultarDetalle(g, rects) {
    if (!rects.length) return;
    for (const path of g.querySelectorAll("path")) {
      let b;
      try { b = path.getBBox(); } catch { continue; }
      if (!b.width && !b.height) continue;
      if (rects.some(({ rect: [x, y, w, h] }) => b.x >= x && b.y >= y && b.x + b.width <= x + w && b.y + b.height <= y + h)) path.remove();
    }
  }

  function dibujarEquipamiento(g, nivel) {
    for (const m of (S.casa.equipamiento || []).filter((m) => m.nivel === nivel)) {
      const grupo = el("g", { class: `eq eq-${m.tipo}` }, g);
      el("title", {}, grupo, m.nombre);
      if (m.linea) {
        const [[x1, y1], [x2, y2]] = m.linea;
        if (m.tipo === "puerta-batiente") {
          // hoja abierta a 90° desde la bisagra (x1,y1) + arco de barrido
          const L = Math.hypot(x2 - x1, y2 - y1), sgn = m.abre || 1;
          const ox = x1 - (y2 - y1) * sgn, oy = y1 + (x2 - x1) * sgn;
          el("line", { x1, y1, x2: ox, y2: oy, class: "eq-linea" }, grupo);
          el("path", { d: `M${x2},${y2} A${L},${L} 0 0 ${sgn > 0 ? 1 : 0} ${ox},${oy}`, class: "eq-linea-f" }, grupo);
        } else if (m.tipo === "puerta-plegadiza") {
          // hojas plegadizas: la mitad pliega contra cada jamba, dibujadas entreabiertas a 60°
          const n = m.modulos || 4, porLado = Math.max(1, Math.round(n / 2));
          const L = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / L, uy = (y2 - y1) / L;
          const hoja = L / n, sgn = m.abre || 1, ang = Math.PI / 3;
          const nx = -uy * sgn, ny = ux * sgn;
          el("line", { x1, y1, x2, y2, class: "eq-cerrada" }, grupo);
          for (const [sx, sy, dir] of [[x1, y1, 1], [x2, y2, -1]]) {
            const pts2 = [[sx, sy]];
            let cx = sx, cy = sy;
            for (let i = 0; i < porLado; i++) {
              const out = i % 2 === 0 ? 1 : -1;
              cx += dir * ux * hoja * Math.cos(ang) + nx * hoja * Math.sin(ang) * out;
              cy += dir * uy * hoja * Math.cos(ang) + ny * hoja * Math.sin(ang) * out;
              pts2.push([cx, cy]);
            }
            el("polyline", { points: pts(pts2), class: "eq-linea" }, grupo);
          }
        } else {
          el("line", { x1, y1, x2, y2, class: m.tipo === "porton" ? "eq-porton" : "eq-linea" }, grupo);
        }
        continue;
      }
      const [x, y, w, h] = m.rect;
      el("rect", { x, y, width: w, height: h, rx: m.tipo === "bacha" ? 6 : 2, class: "eq-cuerpo" }, grupo);
      if (m.tipo === "anafe") {
        for (const [dx, dy] of [[.28, .28], [.72, .28], [.28, .72], [.72, .72]]) el("circle", { cx: x + w * dx, cy: y + h * dy, r: Math.min(w, h) * .16, class: "eq-linea-f" }, grupo);
      } else if (m.tipo === "bacha") {
        el("rect", { x: x + 5, y: y + 5, width: w - 10, height: h - 10, rx: 5, class: "eq-linea-f" }, grupo);
      } else if (m.tipo === "lavarropas") {
        el("circle", { cx: x + w / 2, cy: y + h / 2, r: Math.min(w, h) * .32, class: "eq-linea-f" }, grupo);
      } else if (m.tipo === "parrilla") {
        for (let i = 1; i < 6; i++) el("line", { x1: x + 8, y1: y + h * i / 6, x2: x + w - 8, y2: y + h * i / 6, class: "eq-linea-f" }, grupo);
      }
      const corto = { heladera: "Heladera", horno: "Horno", lavarropas: "", anafe: "", bacha: "", parrilla: "Parrilla", mesa: "Mesa", barra: "Barra" }[m.tipo];
      const txt = corto ?? (w > 120 || h > 120 ? m.nombre : "");
      if (txt) {
        const vertical = h > w * 2.2;
        el("text", { x: x + w / 2, y: y + h / 2, class: "eq-etq", transform: vertical ? `rotate(-90 ${x + w / 2} ${y + h / 2})` : null }, grupo, txt);
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
      const corr = (S.casa.correcciones || []).filter((c) => c.nivel === nivel);
      if (s) {
        const det = el("g", {}, raiz);
        importar(s.rellenos, "relleno-svg", det);
        importar(s.detalle, "detalle-svg", det);
        ocultarDetalle(det, corr.filter((c) => c.tipo === "ocultar-detalle"));
        if (capas.muebles !== false && !opts.mini) dibujarEquipamiento(el("g", {}, raiz), nivel);
        importar(s.muros, "muros", raiz);
        const g2 = el("g", {}, raiz);
        for (const c of corr) {
          const [x, y, w, h] = c.rect;
          if (c.tipo === "quitar-muro") el("rect", { x, y, width: w, height: h, class: "muro-quitado" }, g2);
          if (c.tipo === "agregar-muro") el("rect", { x, y, width: w, height: h, class: "muro-agregado" }, g2);
        }
      }
    } else {
      dibujarTechos(el("g", {}, raiz));
    }
    if (opts.mini) return;
    if (capas.cotas) dibujarCotas(el("g", {}, raiz), nivel);
    if (capas.proyectos) dibujarProyectos(el("g", {}, raiz), nivel);
    if (capas.etiquetas && nivel !== "techos") dibujarEtiquetas(el("g", {}, raiz), nivel);
    if (capas.desagues || capas.agua) dibujarDesagues(el("g", {}, raiz), nivel, capas);
    if (S.rev.on && (capas.revision || S.rev.borrador)) dibujarRevision(el("g", {}, raiz), nivel);
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
    let trazo = null;
    svg.addEventListener("pointerdown", (e) => {
      if (S.rev.marcando && punteros.size === 0) {
        const p0 = aSVG(e.clientX, e.clientY);
        trazo = { x0: p0.x, y0: p0.y, nodo: el("rect", { class: "rev-temp", x: p0.x, y: p0.y, width: 0, height: 0 }, svg) };
        svg.setPointerCapture(e.pointerId);
        movido = true;
        return;
      }
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
      if (trazo) {
        const p1 = aSVG(e.clientX, e.clientY);
        const x = Math.min(trazo.x0, p1.x), y = Math.min(trazo.y0, p1.y);
        Object.assign(trazo, { x, y, w: Math.abs(p1.x - trazo.x0), h: Math.abs(p1.y - trazo.y0) });
        trazo.nodo.setAttribute("x", x); trazo.nodo.setAttribute("y", y);
        trazo.nodo.setAttribute("width", trazo.w); trazo.nodo.setAttribute("height", trazo.h);
        return;
      }
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
      if (trazo) {
        const t = trazo; trazo = null;
        t.nodo.remove();
        if ((t.w || 0) > 15 && (t.h || 0) > 15) terminarMarca([t.x, t.y, t.w, t.h].map((v) => Math.round(v)));
        return;
      }
      punteros.delete(e.pointerId);
      if (punteros.size < 2) pinch = null;
      if (punteros.size === 0) { arrastre = null; svg.classList.remove("dragging"); }
    };
    svg.addEventListener("pointerup", fin);
    svg.addEventListener("pointercancel", fin);

    svg.addEventListener("click", (e) => {
      if (movido) return;
      const t = e.target.closest("[data-rev],[data-amb],[data-art],[data-vent],[data-tramo],[data-cam]");
      if (!t) { S.sel = null; }
      else if (t.dataset.rev) S.sel = { tipo: "rev", id: t.dataset.rev };
      else if (t.dataset.art) S.sel = { tipo: "art", id: t.dataset.art };
      else if (t.dataset.tramo) S.sel = { tipo: "tramo", id: t.dataset.tramo };
      else if (t.dataset.cam) S.sel = { tipo: "cam", id: t.dataset.cam };
      else if (t.dataset.vent) S.sel = { tipo: "vent", id: t.dataset.vent };
      else S.sel = { tipo: "amb", id: t.dataset.amb };
      renderPlano(false);
      renderDetalle();
    });

    document.querySelector(".zoom").addEventListener("click", (e) => {
      const z = e.target.closest("button")?.dataset.zoom;
      if (!z) return;
      const v = S.view;
      if (z === "marcar") { modoMarcar(!S.rev.marcando); return; }
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
    if (s.tipo === "rev") { detalleRevision(box, s.id); return; }
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
      const lista = { art: S.desagues.artefactos, vent: S.desagues.ventilaciones, tramo: S.desagues.tramos, cam: S.desagues.camaras }[s.tipo] || [];
      const x = lista.find((y) => y.id === s.id);
      if (!x) { box.innerHTML = ""; return; }
      const a = x.ambiente ? ambiente(x.ambiente) : null;
      const des = { primario: "Cloaca primaria", secundario: "Desagüe secundario (a pileta de patio)", false: "No tiene" };
      box.innerHTML = `
        <h3>${esc(x.nombre)}</h3>
        <span class="muted">${esc(nivelNombre(x.nivel))}${a ? " · " + esc(a.nombre) : ""}</span>
        <dl>
          ${s.tipo === "art" ? `<dt>Desagüe</dt><dd>${des[String(x.desague)] || esc(x.desague)}</dd>` : ""}
          ${x.red ? `<dt>Red</dt><dd>${esc(x.red)}</dd>` : ""}
          ${x.diametro ? `<dt>Diámetro</dt><dd>${esc(x.diametro)}</dd>` : ""}
          ${x.pendiente ? `<dt>Pendiente</dt><dd>${esc(x.pendiente)}</dd>` : ""}
          ${x.fuente ? `<dt>Fuente</dt><dd>${esc((S.desagues.fuentes || []).find((f) => f.id === x.fuente)?.nombre || x.fuente)}</dd>` : ""}
          <dt>Estado</dt><dd>${{ plano: "Figura en el plano", estimado: "Estimado, a verificar", verificado: "Verificado en obra" }[x.estado] || esc(x.estado)}</dd>
        </dl>
        ${x.nota ? `<p>${esc(x.nota)}</p>` : ""}
        <p class="muted" style="font-size:13px">La posición es aproximada. Para corregirla, editá <code>data/desagues.json</code>.</p>`;
    }
  }

  // ---------- revisión (solo local, con tools/servidor.py) ----------
  async function cargarRevision() {
    if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return;
    try {
      const r = await fetch("api/revision", { cache: "no-store" });
      if (!r.ok) return;
      S.rev.notas = (await r.json()).notas || [];
      S.rev.on = true;
    } catch { /* servidor sin API: modo solo lectura */ }
  }
  async function api(metodo, ruta, cuerpo) {
    const r = await fetch(ruta, { method: metodo, headers: { "Content-Type": "application/json" }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
    return r.json();
  }
  async function recargarRevision() {
    S.rev.notas = (await api("GET", "api/revision")).notas || [];
    renderRevisionPanel();
    renderPlano(false);
    renderDetalle();
  }

  function armarRevision() {
    if (!S.rev.on) return;
    $('[data-zoom="marcar"]').hidden = false;
    $("#revision").hidden = false;
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && (S.rev.marcando || S.rev.borrador)) { S.rev.borrador = null; modoMarcar(false); renderRevisionPanel(); renderPlano(false); }
    });
    $("#revision").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-accion]");
      if (!b) return;
      const acc = b.dataset.accion;
      if (acc === "marcar") modoMarcar(true);
      else if (acc === "cancelar") { S.rev.borrador = null; renderRevisionPanel(); renderPlano(false); }
      else if (acc === "guardar") {
        const texto = $("#rev-texto").value.trim();
        if (!texto) { $("#rev-texto").focus(); return; }
        b.disabled = true;
        try {
          const nota = await api("POST", "api/revision", { ...S.rev.borrador, texto, contexto: contextoDe(S.rev.borrador) });
          S.rev.borrador = null;
          S.sel = { tipo: "rev", id: nota.id };
          await recargarRevision();
        } catch (err) { b.disabled = false; alert("No se pudo guardar: " + err.message); }
      } else if (acc === "ir") irANota(b.dataset.id);
    });
    renderRevisionPanel();
  }

  function modoMarcar(on) {
    S.rev.marcando = on;
    $("#plano").classList.toggle("marcando", on);
    $('[data-zoom="marcar"]').setAttribute("aria-pressed", String(on));
    renderRevisionPanel();
  }

  function terminarMarca(rect) {
    S.rev.borrador = { nivel: S.nivel, rect };
    modoMarcar(false);
    renderPlano(false);
    renderRevisionPanel();
    const t = $("#rev-texto");
    if (t) { t.focus(); t.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  }

  /** Lo que hay dentro del recuadro, para que la nota tenga contexto al leerla después. */
  function contextoDe({ nivel, rect: [x, y, w, h] }) {
    const dentro = ([px, py]) => px >= x && px <= x + w && py >= y && py <= y + h;
    const cruza = (poly) => { const b = bbox(poly); return b.x0 < x + w && b.x1 > x && b.y0 < y + h && b.y1 > y; };
    const d = S.desagues;
    const enNivel = (o) => o.nivel === nivel;
    return {
      nivel_nombre: nivelNombre(nivel),
      ambientes: S.casa.ambientes.filter((a) => enNivel(a) && cruza(a.poligono)).map((a) => a.id),
      artefactos: d.artefactos.filter((o) => enNivel(o) && dentro(o.pos)).map((o) => o.id),
      camaras: d.camaras.filter((o) => enNivel(o) && dentro(o.pos)).map((o) => o.id),
      ventilaciones: d.ventilaciones.filter((o) => enNivel(o) && dentro(o.pos)).map((o) => o.id),
      tramos: d.tramos.filter((o) => enNivel(o) && o.puntos.some(dentro)).map((o) => o.id),
      proyectos: S.proyectos.proyectos.filter((p) => (p.overlay || []).some((o) => enNivel(o) && cruza(o.puntos))).map((p) => p.id),
      capas_visibles: Object.keys(S.capas).filter((k) => S.capas[k]),
    };
  }

  function dibujarRevision(g, nivel) {
    for (const n of S.rev.notas.filter((n) => n.nivel === nivel)) {
      const [x, y, w, h] = n.rect;
      const sel = S.sel?.tipo === "rev" && S.sel.id === n.id;
      const grupo = el("g", { class: `rev ${n.estado}${sel ? " sel" : ""}`, "data-rev": n.id }, g);
      el("rect", { x, y, width: w, height: h, class: "rev-box" }, grupo);
      el("circle", { cx: x, cy: y, r: 20, class: "rev-badge" }, grupo);
      el("text", { x, y, class: "rev-n" }, grupo, n.n);
      el("title", {}, grupo, n.texto);
    }
    const b = S.rev.borrador;
    if (b && b.nivel === nivel) el("rect", { x: b.rect[0], y: b.rect[1], width: b.rect[2], height: b.rect[3], class: "rev-temp" }, g);
  }

  function renderRevisionPanel() {
    const box = $("#revision");
    if (!S.rev.on) return;
    const abiertas = S.rev.notas.filter((n) => n.estado !== "resuelta");
    const resueltas = S.rev.notas.filter((n) => n.estado === "resuelta");
    const item = (n) => `<li><button type="button" data-accion="ir" data-id="${n.id}" class="rev-item ${n.estado}">
        <span class="rev-chip">${n.n}</span><span><span class="muted">${esc(nivelNombre(n.nivel))} · </span>${esc(n.texto.length > 80 ? n.texto.slice(0, 80) + "…" : n.texto)}</span></button></li>`;
    let h = `<h2 class="label">Revisión <span class="muted" style="text-transform:none;letter-spacing:0">· solo local</span></h2>`;
    if (S.rev.borrador) {
      h += `<p style="margin:0 0 6px;font-size:13px"><strong>¿Qué está mal en este recuadro?</strong> <span class="muted">(${esc(nivelNombre(S.rev.borrador.nivel))})</span></p>
        <textarea id="rev-texto" rows="4" placeholder="Ej.: la pileta de patio está del otro lado del baño, al lado de la puerta"></textarea>
        <div class="rev-acciones"><button type="button" class="btn primario" data-accion="guardar">Guardar marca</button><button type="button" class="btn" data-accion="cancelar">Cancelar</button></div>`;
    } else if (S.rev.marcando) {
      h += `<p class="aviso" style="margin:0">Arrastrá sobre el plano para dibujar un recuadro. <kbd>Esc</kbd> para cancelar.</p>`;
    } else {
      h += `<button type="button" class="btn primario" data-accion="marcar" style="width:100%">✎ Marcar un error en el plano</button>`;
    }
    if (abiertas.length) h += `<p class="t-grupo">Abiertas (${abiertas.length})</p><ul class="rev-lista">${abiertas.map(item).join("")}</ul>`;
    if (resueltas.length) h += `<details><summary class="t-grupo" style="cursor:pointer">Resueltas (${resueltas.length})</summary><ul class="rev-lista">${resueltas.map(item).join("")}</ul></details>`;
    if (!S.rev.notas.length && !S.rev.borrador) h += `<p class="muted" style="font-size:13px;margin:8px 0 0">Las marcas se guardan en <code>revision/notas.json</code>. Después pedime "tomá las marcas" y las reviso.</p>`;
    box.innerHTML = h;
  }

  function irANota(id) {
    const n = S.rev.notas.find((x) => x.id === id);
    if (!n) return;
    S.sel = { tipo: "rev", id };
    if (S.nivel !== n.nivel) { S.nivel = n.nivel; store.set("nivel", S.nivel); history.replaceState(null, "", `#plano/${S.nivel}`); renderNiveles(); }
    const [x, y, w, h] = n.rect;
    const m = Math.max(w, h) * 1.2 + 200;
    const rect = $("#plano").getBoundingClientRect();
    const ratio = rect.height / rect.width || 1;
    const vw = Math.max(m, m / ratio), vh = vw * ratio;
    S.view = { x: x + w / 2 - vw / 2, y: y + h / 2 - vh / 2, w: vw, h: vh };
    renderPlano(false);
    renderDetalle();
  }

  function detalleRevision(box, id) {
    const n = S.rev.notas.find((x) => x.id === id);
    if (!n) { box.innerHTML = ""; return; }
    const c = n.contexto || {};
    const nombres = (ids, lista, campo = "nombre") => (ids || []).map((i) => lista.find((o) => o.id === i)?.[campo] || i);
    const cosas = [
      ...nombres(c.ambientes, S.casa.ambientes),
      ...nombres(c.artefactos, S.desagues.artefactos),
      ...nombres(c.camaras, S.desagues.camaras),
      ...nombres(c.tramos, S.desagues.tramos),
      ...nombres(c.proyectos, S.proyectos.proyectos),
    ];
    box.innerHTML = `
      <h3><span class="rev-chip">${n.n}</span> Marca de revisión</h3>
      <span class="muted">${esc(nivelNombre(n.nivel))} · ${esc(n.creada.replace("T", " "))} · ${n.estado === "resuelta" ? "resuelta" : "abierta"}</span>
      <p style="white-space:pre-wrap">${esc(n.texto)}</p>
      ${n.respuesta ? `<p class="aviso" style="border-left-color:var(--ok)"><strong>Respuesta:</strong> ${esc(n.respuesta)}</p>` : ""}
      ${cosas.length ? `<p class="muted" style="font-size:12px;margin:6px 0">Dentro del recuadro: ${cosas.map(esc).join(", ")}</p>` : ""}
      <textarea id="rev-edit" rows="3">${esc(n.texto)}</textarea>
      <div class="rev-acciones">
        <button type="button" class="btn" data-rev-acc="editar">Guardar texto</button>
        <button type="button" class="btn" data-rev-acc="estado">${n.estado === "resuelta" ? "Reabrir" : "Marcar resuelta"}</button>
        <button type="button" class="btn peligro" data-rev-acc="borrar">Borrar</button>
      </div>`;
    box.onclick = async (e) => {
      const acc = e.target.closest("[data-rev-acc]")?.dataset.revAcc;
      if (!acc) return;
      try {
        if (acc === "editar") await api("PUT", `api/revision/${n.id}`, { texto: $("#rev-edit").value.trim() || n.texto });
        if (acc === "estado") await api("PUT", `api/revision/${n.id}`, { estado: n.estado === "resuelta" ? "abierta" : "resuelta" });
        if (acc === "borrar") {
          if (!confirm(`¿Borrar la marca ${n.n}?`)) return;
          await api("DELETE", `api/revision/${n.id}`);
          S.sel = null;
        }
        await recargarRevision();
      } catch (err) { alert("No se pudo guardar: " + err.message); }
    };
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
      ${(sel.proyectos || []).length ? `<p style="margin:6px 0 0;font-size:14px">Proyecto: ${sel.proyectos.map((id) => {
        const pr = S.proyectos.proyectos.find((x) => x.id === id);
        return `<a href="#proyectos">${esc(pr?.nombre || id)}</a>`;
      }).join(", ")}</p>` : ""}
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
  /** Suma ítems no condicionales. Devuelve mínimos y máximos en ARS y USD. */
  function sumar(items) {
    const r = { ars: 0, usd: 0, arsMax: 0, usdMax: 0 };
    for (const i of items) {
      if (i.condicional) continue;
      const max = i.monto_max ?? i.monto;
      r.ars += toARS(i.monto, i.moneda); r.usd += toUSD(i.monto, i.moneda);
      r.arsMax += toARS(max, i.moneda); r.usdMax += toUSD(max, i.moneda);
    }
    return r;
  }
  const subtotales = (p) => sumar(p.presupuesto || []);
  const rango = (min, max, cur) => Math.round(min) === Math.round(max) ? fmtMoney(min, cur) : `${fmtMoney(min, cur)} – ${fmtMoney(max, cur).replace(/^(US)?\$ /, "")}`;
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
    box.innerHTML = lista.map(tarjetaProyecto).join("");
  }

  function tareasHTML(p) {
    const grupos = [];
    for (const x of p.tareas || []) {
      const g = x.grupo || "";
      let gr = grupos.find((y) => y.nombre === g);
      if (!gr) grupos.push(gr = { nombre: g, items: [] });
      gr.items.push(x);
    }
    return grupos.map((g) => `${g.nombre ? `<p class="t-grupo">${esc(g.nombre)}</p>` : ""}
      <ul class="tareas">${g.items.map((x) => `<li class="${x.estado}"><span class="chk"></span><span>${esc(x.titulo)}${x.responsable ? ` <span class="muted">· ${esc(x.responsable)}</span>` : ""}${x.fecha ? ` <span class="muted">· ${esc(x.fecha)}</span>` : ""}</span></li>`).join("")}</ul>`).join("");
  }

  function tarjetaProyecto(p) {
    const t = tareasDe(p);
    const st = subtotales(p);
    const cond = (p.presupuesto || []).filter((i) => i.condicional);
    const fase = p.fase && S.fases.fases.find((f) => f.id === p.fase);
    const niveles = [...new Set((p.overlay || []).map((o) => o.nivel))];
    const mat = p.materiales || [];
    const totMat = mat.reduce((a, m) => a + (m.subtotal || 0), 0);
    return `<article class="card" id="proy-${p.id}">
      <div class="badges"><span class="badge ${p.estado}">${esc(p.estado)}</span>${p.prioridad ? `<span class="badge ${p.prioridad}">prioridad ${esc(p.prioridad)}</span>` : ""}${fase ? `<a class="badge futura" href="#fases/${fase.id}">fase: ${esc(fase.nombre)}</a>` : ""}</div>
      <h3>${esc(p.nombre)}</h3>
      ${p.version ? `<span class="muted" style="font-size:12px">${esc(p.version)}</span>` : ""}
      <p>${esc(p.descripcion || "")}</p>
      ${p.aviso ? `<p class="aviso" style="margin:0">${esc(p.aviso)}</p>` : ""}
      ${(p.ambientes || []).length ? `<div class="chips">${p.ambientes.map((id) => `<a href="#plano?amb=${id}">${esc(ambiente(id)?.nombre || id)}</a>`).join("")}</div>` : ""}
      ${niveles.length ? `<div class="ver-plano">Ver el cambio en el plano: ${niveles.map((n) => `<a href="#plano/${n}">${esc(nivelNombre(n))}</a>`).join(" · ")}</div>` : ""}
      ${t.total ? `<div><div class="bar" title="${t.hechas} de ${t.total} tareas"><span style="width:${(100 * t.hechas / t.total).toFixed(0)}%"></span></div>
        <span class="muted" style="font-size:12px">${t.hechas} de ${t.total} tareas</span></div>` : ""}
      ${(p.medidas || []).length ? `<details><summary>Medidas clave</summary><dl class="kv">${p.medidas.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl></details>` : ""}
      ${t.total ? (t.total > 6 ? `<details><summary>Tareas (${t.total})</summary>${tareasHTML(p)}</details>` : tareasHTML(p)) : ""}
      ${(p.presupuesto || []).length ? `<details><summary>Presupuesto por partida</summary><table class="mini-tabla">${p.presupuesto.map((i) => `<tr class="${i.condicional ? "cond" : ""}"><td>${esc(i.concepto)}</td><td class="num">${rango(i.monto, i.monto_max ?? i.monto, i.moneda)}</td></tr>`).join("")}</table></details>` : ""}
      ${mat.length ? `<details><summary>Materiales (${mat.length} ítems · ${fmtMoney(totMat, "ARS")})</summary><div class="tabla-wrap"><table class="mini-tabla">
          <thead><tr><th>Producto</th><th>Para qué</th><th>Cant.</th><th class="num">Subtotal</th></tr></thead>
          ${mat.map((m) => `<tr><td>${esc(m.producto)}<br><span class="muted">${esc(m.rubro)} · ${esc(m.proveedor || "")}</span></td><td>${esc(m.para)}</td><td>${esc(m.cantidad)}</td><td class="num">${m.subtotal ? fmtMoney(m.subtotal, "ARS") : "–"}</td></tr>`).join("")}
        </table></div></details>` : ""}
      ${(p.notas || []).length ? `<details><summary>Notas y decisiones</summary><ul class="mini">${p.notas.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>` : ""}
      <div class="subtotal"><span class="muted">Presupuesto</span><span>${(p.presupuesto || []).length ? `${rango(st.ars, st.arsMax, "ARS")}<br><span class="muted">${rango(st.usd, st.usdMax, "USD")}</span>` : "sin cargar"}</span></div>
      ${cond.length ? `<div class="muted" style="font-size:12px">Más ${cond.map((i) => `${rango(i.monto, i.monto_max ?? i.monto, i.moneda)} si hace falta: ${esc(i.concepto.toLowerCase())}`).join("; ")}.</div>` : ""}
    </article>`;
  }

  // ---------- presupuesto ----------
  function renderPresupuesto() {
    const P = S.proyectos.proyectos;
    const items = P.flatMap((p) => (p.presupuesto || []).map((i) => ({ p, i })));
    const todos = items.map((x) => x.i);
    const total = sumar(todos);
    const por = (e) => sumar(todos.filter((i) => i.estado === e));
    const t = S.config.tipo_cambio;
    const tile = (k, r) => `<div class="tot"><div class="k">${k}</div><div class="v">${rango(r.ars, r.arsMax, "ARS")}</div><div class="v2">${rango(r.usd, r.usdMax, "USD")}</div></div>`;
    $("#totales").innerHTML = tile("Total", total) + tile("Estimado", por("estimado")) + tile("Cotizado", por("cotizado")) + tile("Pagado", por("pagado")) +
      `<div class="tot"><div class="k">Tipo de cambio</div><div class="v">$ ${tc().toLocaleString("es-AR")}</div><div class="v2">por US$ · ${esc(t.fecha || "")} · ${esc(t.fuente || "")}</div></div>`;
    const box = $("#presupuesto");
    if (!items.length) {
      box.innerHTML = `<div class="empty">
        <p><strong>Todavía no hay presupuestos cargados.</strong> Agregá ítems en la lista <code>presupuesto</code> de cada proyecto en <code>data/proyectos.json</code>. Cada ítem va en su moneda original y la página calcula el equivalente con el tipo de cambio de <code>data/config.json</code>.</p>
        <pre>"presupuesto": [
  { "concepto": "Destapación y cámara nueva", "proveedor": "Plomero X",
    "monto": 350000, "moneda": "ARS", "estado": "cotizado", "fecha": "2026-12-01" },
  { "concepto": "Inodoro y bidet", "proveedor": "Corralón Y",
    "monto": 420, "monto_max": 600, "moneda": "USD", "estado": "estimado" }
]</pre></div>`;
      return;
    }
    let rows = "";
    for (const p of P.filter((p) => (p.presupuesto || []).length)) {
      const st = subtotales(p);
      rows += `<tr class="grupo"><td colspan="4"><a href="#proyectos">${esc(p.nombre)}</a></td><td class="num">${rango(st.ars, st.arsMax, "ARS")}</td><td class="num">${rango(st.usd, st.usdMax, "USD")}</td></tr>`;
      rows += p.presupuesto.map((i) => {
        const max = i.monto_max ?? i.monto;
        return `<tr class="${i.condicional ? "cond" : ""}">
          <td class="concepto">${esc(i.concepto)}${i.condicional ? ' <span class="badge">condicional, no suma</span>' : ""}</td><td>${esc(i.proveedor || "")}</td><td><span class="badge">${esc(i.estado)}</span></td>
          <td class="num">${rango(i.monto, max, i.moneda)}</td><td class="num">${rango(toARS(i.monto, i.moneda), toARS(max, i.moneda), "ARS")}</td><td class="num">${rango(toUSD(i.monto, i.moneda), toUSD(max, i.moneda), "USD")}</td></tr>`;
      }).join("");
    }
    box.innerHTML = `<div class="tabla-wrap"><table class="tabla">
      <thead><tr><th>Concepto</th><th>Proveedor</th><th>Estado</th><th class="num">Monto original</th><th class="num">En ARS</th><th class="num">En USD</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  init();
})();
