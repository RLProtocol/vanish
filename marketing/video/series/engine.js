// Shared engine for the Vanish feature videos. Each video defines its scenes in render(t);
// timing comes from window.TIMING (generated from the measured narration), so scenes are keyed
// to narration lines: T("shield") is when that line starts, D("shield") how long it lasts.
(function () {
  const $ = (id) => document.getElementById(id);
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const outBack = (x) => { const c = 1.6; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
  const prog = (t, a, b) => ease(clamp((t - a) / (b - a)));
  const pop = (t, a, d = 0.45) => clamp((t - a) / d);
  function style(el, { o = 1, x = 0, y = 0, s = 1, blur = 0, rot = 0 } = {}) {
    if (!el) return;
    el.style.opacity = o;
    el.style.transform = `translate(${x}px, ${y}px) scale(${s}) rotate(${rot}deg)`;
    el.style.filter = blur ? `blur(${blur}px)` : "none";
    el.style.visibility = o <= 0.001 ? "hidden" : "visible";
  }
  /** fade + rise in at a, fade out at c */
  function enter(el, t, a, c = 1e9, { dy = 36, dx = 0, dur = 0.6, out = 0.45 } = {}) {
    const i = prog(t, a, a + dur), o = 1 - prog(t, c, c + out);
    style(el, { o: Math.min(i, o), y: (1 - i) * dy, x: (1 - i) * dx, blur: (1 - i) * 7 });
  }
  /** springy pop-in */
  function popIn(el, t, a, c = 1e9) {
    const p = pop(t, a), o = 1 - prog(t, c, c + 0.4);
    style(el, { o: Math.min(ease(p), o), s: 0.8 + 0.2 * outBack(p) });
  }
  const typed = (text, t, a, dur) => text.slice(0, Math.floor(clamp((t - a) / dur) * text.length));
  const press = (el, t, at) => { if (el) el.style.transform = `scale(${1 - 0.045 * clamp(1 - Math.abs(t - at) / 0.15)})`; };
  const fmt = (v, d) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

  const TIMING = window.TIMING;
  const LINE = Object.fromEntries(TIMING.lines.map((l) => [l.id, l]));
  const T = (id, off = 0) => LINE[id].start + off;
  const D = (id) => LINE[id].dur;
  const END = (id, off = 0) => LINE[id].start + LINE[id].dur + off;

  /** show a scene from a (fade in) to b (fade out); returns local visibility 0..1 */
  function scene(el, t, a, b) {
    const on = t > a - 0.05 && t < b + 0.5;
    el.style.display = on ? "block" : "none";
    if (!on) return 0;
    const v = Math.min(prog(t, a, a + 0.45), 1 - prog(t, b, b + 0.45));
    el.style.opacity = v;
    return v;
  }

  // ---------------------------------------------------------------- shared chrome
  const stage = $("stage");
  stage.insertAdjacentHTML("afterbegin", `
    <div id="dots" class="abs" style="inset:0;background-image:radial-gradient(rgba(255,255,255,.07) 1.4px, transparent 1.6px);background-size:26px 26px"></div>
    <div id="glowA" class="abs" style="width:900px;height:900px;border-radius:50%;background:radial-gradient(circle, rgba(153,69,255,.30), transparent 65%)"></div>
    <div id="glowB" class="abs" style="width:900px;height:900px;border-radius:50%;background:radial-gradient(circle, rgba(25,251,155,.17), transparent 65%)"></div>
    <div id="corner" class="abs row" style="left:70px;top:54px;gap:18px"><span class="grad-text" style="font:800 32px var(--font);letter-spacing:.32em">VANISH</span><span class="muted" style="font:600 22px var(--mono);letter-spacing:.12em">${TIMING.label ?? ""}</span></div>`);
  stage.insertAdjacentHTML("beforeend", `<div id="caption"></div><div id="fade" class="abs" style="inset:0;background:#000;pointer-events:none"></div>`);

  function chrome(t) {
    $("dots").style.backgroundPosition = `${t * 7}px ${t * 4}px`;
    style($("glowA"), { x: -250 + Math.sin(t * 0.25) * 260, y: -260 + Math.cos(t * 0.2) * 120 });
    style($("glowB"), { x: 1300 + Math.cos(t * 0.22) * 240, y: 520 + Math.sin(t * 0.3) * 140 });
    const first = TIMING.lines[0], last = TIMING.lines[TIMING.lines.length - 1];
    style($("corner"), { o: Math.min(prog(t, first.start + first.dur, first.start + first.dur + 0.6), 1 - prog(t, last.start - 0.6, last.start)) * 0.92 });
    const line = TIMING.lines.find((l) => t >= l.start - 0.1 && t <= l.start + l.dur + 0.35);
    const cap = $("caption");
    if (line) {
      cap.textContent = line.text;
      const long = line.text.length > 105;
      cap.style.fontSize = long ? "27px" : line.text.length > 80 ? "28px" : "31px";
      cap.style.whiteSpace = long ? "normal" : "nowrap";
      cap.style.width = long ? "1640px" : "auto";
      cap.style.opacity = Math.min(prog(t, line.start - 0.1, line.start + 0.2), 1 - prog(t, line.start + line.dur + 0.05, line.start + line.dur + 0.35));
    } else cap.style.opacity = 0;
    $("fade").style.opacity = Math.max(1 - prog(t, 0, 0.5), prog(t, TIMING.duration - 0.8, TIMING.duration));
  }

  window.V = { $, clamp, ease, outBack, prog, pop, style, enter, popIn, typed, press, fmt, T, D, END, scene, TIMING };
  window.startVideo = function (render) {
    window.DURATION = TIMING.duration;
    window.renderAt = (t) => { chrome(t); render(t); };
    if (location.search.includes("play")) {
      const t0 = performance.now();
      const loop = () => { window.renderAt(((performance.now() - t0) / 1000) % TIMING.duration); requestAnimationFrame(loop); };
      document.fonts.ready.then(loop);
    } else window.renderAt(Number(new URLSearchParams(location.search).get("t") ?? 0));
  };
})();
