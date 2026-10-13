import { useEffect, useRef } from "react";

// ------------------------------------------------------------------ pixel glyphs
// '#' = pixel on. Drawn by hand on small grids so they read like the dithered tiles.
const GLYPHS = {
  eth: [
    "...#...",
    "..###..",
    ".#####.",
    "#######",
    ".#####.",
    "..###..",
    "#.....#",
    ".##.##.",
    "..###..",
    "...#...",
  ],
  dollar: [
    "...#...",
    ".#####.",
    "##.#...",
    "##.#...",
    ".#####.",
    "...#.##",
    "...#.##",
    ".#####.",
    "...#...",
  ],
  chart: [
    "#........",
    "#....####",
    "#.....###",
    "#....##.#",
    "#..##...#",
    "#.##.....",
    "###......",
    "#........",
    "#########",
  ],
  lock: [
    "..###..",
    ".#...#.",
    ".#...#.",
    ".#...#.",
    "#######",
    "###.###",
    "###.###",
    "##...##",
    "#######",
  ],
  key: [
    ".#####.",
    "##...##",
    "##...##",
    ".#####.",
    "...#...",
    "...###.",
    "...#...",
    "...##..",
    "...#...",
  ],
  shield: [
    "#######",
    "#.....#",
    "#.###.#",
    "#.###.#",
    "#.###.#",
    ".#.#.#.",
    ".#...#.",
    "..#.#..",
    "...#...",
  ],
  coin: [
    "..#####..",
    ".#.....#.",
    "#..###..#",
    "#.#.....#",
    "#.#.....#",
    "#.#.....#",
    "#..###..#",
    ".#.....#.",
    "..#####..",
  ],
  arrow: [
    ".....#...",
    ".....##..",
    "########.",
    "#########",
    "########.",
    ".....##..",
    ".....#...",
  ],
  check: [
    "........#",
    ".......##",
    "#.....##.",
    "##...##..",
    ".##.##...",
    "..###....",
    "...#.....",
  ],
  eye: [
    "..#####..",
    ".#.....#.",
    "#..###..#",
    "#.#####.#",
    "#..###..#",
    ".#.....#.",
    "..#####..",
  ],
  warn: [
    "....#....",
    "...###...",
    "...#.#...",
    "..##.##..",
    "..##.##..",
    ".#######.",
    ".###.###.",
    "#########",
  ],
  clock: [
    "..#####..",
    ".#..#..#.",
    "#...#...#",
    "#...#...#",
    "#...###.#",
    "#.......#",
    ".#.....#.",
    "..#####..",
  ],
  mask: [
    ".###...###.",
    "#####.#####",
    "##..###..##",
    "#####.#####",
    ".###...###.",
  ],
  terminal: [
    "#########",
    "#.......#",
    "#.#.....#",
    "#..#....#",
    "#.#..##.#",
    "#.......#",
    "#########",
  ],
  globe: [
    "..#####..",
    ".#..#..#.",
    "#..#.#..#",
    "#########",
    "#..#.#..#",
    "#########",
    "#..#.#..#",
    ".#..#..#.",
    "..#####..",
  ],
};

/** Plain pixel glyph in the current text colour (used beside pill tags). */
export function PixelIcon({ name, size = 28 }) {
  const g = GLYPHS[name];
  const w = g[0].length;
  const h = g.length;
  return (
    <svg width={size} height={(size * h) / w} viewBox={`0 0 ${w} ${h}`} shapeRendering="crispEdges" aria-hidden="true" className="pixel-icon">
      {g.flatMap((row, y) => [...row].map((c, x) => (c === "#" ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="currentColor" /> : null)))}
    </svg>
  );
}

/** Inline tile: glyph knocked out of a dithered colour field, sized to sit in a line of text. */
export function PixelTile({ name, tone = "accent" }) {
  const g = GLYPHS[name];
  const W = 11;
  const H = 16;
  const gw = g[0].length;
  const gh = g.length;
  const ox = Math.floor((W - gw) / 2);
  const oy = Math.floor((H - gh) / 2);
  const rects = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const gx = x - ox;
      const gy = y - oy;
      const on = gy >= 0 && gy < gh && gx >= 0 && gx < gw && g[gy][gx] === "#";
      if (on) rects.push(<rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" className="px-ink" />);
      else if ((x + y) % 2 === 0) rects.push(<rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" className="px-dot" />);
    }
  }
  return (
    <svg className={`pixel-tile tone-${tone}`} viewBox={`0 0 ${W} ${H}`} shapeRendering="crispEdges" aria-hidden="true">
      <rect width={W} height={H} className="px-bg" />
      {rects}
    </svg>
  );
}

// ------------------------------------------------------------------ halftone landscape

// Deterministic value noise so the range looks the same on every load.
function ridge(seed) {
  const r = (i) => {
    const s = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  return (t) => {
    let v = 0;
    let amp = 1;
    let freq = 1;
    for (let o = 0; o < 5; o++) {
      const x = t * freq * 6 + o * 13.7;
      const i = Math.floor(x);
      const f = x - i;
      const u = f * f * (3 - 2 * f);
      v += amp * (r(i) * (1 - u) + r(i + 1) * u);
      amp *= 0.5;
      freq *= 2.1;
    }
    return v / 1.9;
  };
}

/** A rising price chart printed as a dot screen: faint area below, accent dots along the line. */
export function Halftone({ theme }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const { width, height } = canvas.getBoundingClientRect();
      if (!width || !height) return;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      const ctx = canvas.getContext("2d");
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);
      const css = getComputedStyle(canvas);
      const dot = css.getPropertyValue("--dot").trim() || "255,255,255";
      const accent = css.getPropertyValue("--accent-rgb").trim() || "45,212,164";

      // price path: noisy uptrend from lower-left to upper-right, with a couple of sell-offs
      const n1 = ridge(21);
      const n2 = ridge(7);
      const price = (t) => {
        const trend = 0.18 + 0.52 * Math.pow(t, 1.25);
        const wiggle = (n1(t * 0.9) - 0.5) * 0.22 + (n2(t * 3.1) - 0.5) * 0.07;
        const dip = -0.1 * Math.exp(-(((t - 0.58) / 0.05) ** 2));
        return Math.min(0.92, Math.max(0.05, trend + wiggle + dip));
      };

      const step = 6;
      const grain = ridge(9);
      const top = (x) => height * (1 - price(x / width) * 0.82);
      for (let x = 0; x < width; x += step) {
        const yTop = top(x + step / 2);
        for (let y = 0; y < height; y += step) {
          const cy = y + step / 2;
          const d = cy - yTop;
          let color = null;
          let a = 0;
          if (Math.abs(d) < step * 0.9) {
            color = accent; // the line itself
            a = 0.85;
          } else if (d > 0) {
            color = dot; // area under the line, fading toward the bottom
            a = 0.2 * Math.pow(1 - d / (height - yTop + 1), 1.4);
          } else if (y % (step * 16) === 0) {
            color = dot; // sparse horizontal gridlines above the line
            a = 0.07;
          }
          if (!color || a < 0.015) continue;
          const r = step * (color === accent ? 0.3 : 0.26) * (0.6 + 0.6 * grain(x * 0.011 + y * 0.017));
          ctx.fillStyle = `rgba(${color},${a.toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(x + step / 2, cy, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [theme]);
  return <canvas ref={ref} className="halftone" aria-hidden="true" />;
}
