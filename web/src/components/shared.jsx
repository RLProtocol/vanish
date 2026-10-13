import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EXPLORER, P, PROGRAM_ID, logos } from "../lib/solana.js";
import { PixelIcon } from "./art.jsx";

const explorer = (addr) => `${EXPLORER}/account/${addr}`;

// ------------------------------------------------------------------ theme

export function useTheme() {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem("solmix:theme") || "dark";
    } catch {
      return "dark";
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("solmix:theme", theme);
    } catch {}
  }, [theme]);
  return [theme, setTheme];
}

const Chevron = () => (
  <svg width="14" height="9" viewBox="0 0 14 9" fill="none" aria-hidden="true"><path d="m1 1.5 6 6 6-6" stroke="currentColor" strokeWidth="1.8" /></svg>
);
const Sun = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);
const Moon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" /></svg>
);
export const ArrowUpRight = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 12 12 4M5 4h7v7" stroke="currentColor" strokeWidth="1.8" /></svg>
);

function Dropdown({ label, items }) {
  const [open, setOpen] = useState(false);
  // opened by a click: stays open until an outside click, Escape or a choice (hover-opened menus close on leave)
  const [pinned, setPinned] = useState(false);
  const ref = useRef(null);
  const leaveTimer = useRef(null);
  const close = () => {
    clearTimeout(leaveTimer.current);
    setOpen(false);
    setPinned(false);
  };
  useEffect(() => {
    if (!open) return;
    const outside = (e) => !ref.current?.contains(e.target) && close();
    const esc = (e) => e.key === "Escape" && close();
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  useEffect(() => () => clearTimeout(leaveTimer.current), []);
  const enter = () => {
    clearTimeout(leaveTimer.current);
    setOpen(true);
  };
  // a short grace period so a slip of the mouse (or a scroll nudge) doesn't snap the menu shut
  const leave = () => {
    if (pinned) return;
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => setOpen(false), 250);
  };
  return (
    <div className={`nav-item ${open ? "open" : ""}`} ref={ref} onMouseEnter={enter} onMouseLeave={leave}>
      <button className="nav-link" aria-expanded={open}
        onClick={() => (pinned ? close() : (setOpen(true), setPinned(true)))}>
        {label} <Chevron />
      </button>
      {open && (
        <div className="menu" role="menu">
          {items.map(([text, href, sub]) => (
            <a key={text} role="menuitem" href={href} onClick={close}
              {...(href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}>
              {text}
              {sub && <small>{sub}</small>}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

const NAV = [
  ["Features", [["Shield & unshield", "#/utility"], ["Private swap", "#/utility-swap"], ["Private buy (any token)", "#/utility-buy"], ["Guarantees", "#/utility"]]],
  ["Protocol", [["How it works", "#/how"], ["Protocol specification", "#/spec"], ["What stays public", "#/hidden"], ["Supported assets", "#/assets"]]],
  ["Program", [
    ["Vanish program", explorer(PROGRAM_ID.toBase58()), PROGRAM_ID.toBase58()],
    ["Pool account", explorer(P.pool.toBase58()), P.pool.toBase58()],
    ["SOL vault", explorer(P.solVault.toBase58()), P.solVault.toBase58()],
  ]],
  ["Developers", [["Command line", "#/developers"], ["Run a relayer", "#/developers"], ["Security", "#/security"]]],
];

function ThemeToggle({ theme, setTheme }) {
  return (
    <div className="theme-toggle" role="group" aria-label="Colour theme">
      <button aria-pressed={theme === "light"} aria-label="Light theme" onClick={() => setTheme("light")}><Sun /></button>
      <button aria-pressed={theme === "dark"} aria-label="Dark theme" onClick={() => setTheme("dark")}><Moon /></button>
    </div>
  );
}

/** Full-width sheet under the nav bar on tablets and phones. */
function MobileMenu({ open, onClose, theme, setTheme, onApp }) {
  useEffect(() => {
    if (!open) return;
    const esc = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", esc);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);
  if (!open) return null;
  // portalled to <body>: the nav's backdrop-filter would otherwise clip a fixed-position child
  return createPortal(
    <div className="mobile-menu" role="dialog" aria-label="Menu">
      {NAV.map(([group, items]) => (
        <div className="mm-group" key={group}>
          <h4>{group}</h4>
          {items.map(([text, href, sub]) => (
            <a key={text} href={href} onClick={onClose} {...(href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}>
              {text}
              {sub && <small>{sub}</small>}
            </a>
          ))}
        </div>
      ))}
      <div className="mm-group">
        <a href="#/faq" onClick={onClose}>FAQ</a>
      </div>
      <div className="mm-foot">
        <ThemeToggle theme={theme} setTheme={setTheme} />
        {!onApp && <a href="#/app" className="btn btn-primary" onClick={onClose}>Launch app</a>}
      </div>
    </div>,
    document.body,
  );
}

export function Nav({ onApp, theme, setTheme }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener("hashchange", close);
    return () => window.removeEventListener("hashchange", close);
  }, []);
  return (
    <header className={`nav ${open ? "menu-open" : ""}`}>
      <div className="wrap">
        <a href="#/" className="wordmark" aria-label="Vanish home">Vanish</a>
        {NAV.map(([label, items]) => <Dropdown key={label} label={label} items={items} />)}
        <div className="nav-item"><a className="nav-link" href="#/faq">FAQ</a></div>
        <div className="nav-theme"><ThemeToggle theme={theme} setTheme={setTheme} /></div>
        {!onApp && <a href="#/app" className="btn btn-primary btn-sm nav-cta">Launch app</a>}
        <button className="menu-btn" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span /><span /><span />
        </button>
      </div>
      <MobileMenu open={open} onClose={() => setOpen(false)} theme={theme} setTheme={setTheme} onApp={onApp} />
    </header>
  );
}

// Logos are self-hosted (see scripts/sync.mjs); stocks sit on a tile, coins are already round.
export function AssetIcon({ asset, small, size }) {
  const [failed, setFailed] = useState(false);
  const cls = `icon ${small ? "icon-sm" : ""}`;
  const style = size ? { width: size, height: size } : undefined;
  const logo = logos[asset.symbol];
  if (logo?.mono) {
    // single-colour mark: painted in the current text colour so it shows in both themes
    return <span className={`${cls} logo logo-mono`} style={{ ...style, WebkitMaskImage: `url(${logo.src})`, maskImage: `url(${logo.src})` }} aria-hidden="true" />;
  }
  if (logo && !failed) {
    return (
      <span className={`${cls} logo`} style={style} aria-hidden="true">
        <img src={logo.src} alt="" onError={() => setFailed(true)} />
      </span>
    );
  }
  const label = small ? asset.symbol[0] : asset.symbol.slice(0, 4);
  return <span className={`${cls} ${asset.kind === "stock" ? "icon-stock" : ""}`} style={style} aria-hidden="true">{label}</span>;
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="footer-top">
        <div>
          <h4>App</h4>
          <ul>
            <li><a href="#/app">Launch app</a></li>
            <li><a href="#/developers">Command line</a></li>
            <li><a href="#/developers">Run a relayer</a></li>
          </ul>
        </div>
        <div>
          <h4>Verify</h4>
          <ul>
            <li><a href={explorer(PROGRAM_ID.toBase58())} target="_blank" rel="noreferrer"><PixelIcon name="shield" size={18} /> Program on Solscan</a></li>
            <li><a href={explorer(P.pool.toBase58())} target="_blank" rel="noreferrer"><PixelIcon name="check" size={18} /> Pool account</a></li>
            <li><a href="#/security"><PixelIcon name="warn" size={18} /> Security notes</a></li>
          </ul>
        </div>
        <span className="wordmark">Vanish</span>
      </div>
      <div className="footer-ctas">
        <a className="btn btn-primary" href="#/app">Launch app</a>
        <a className="btn btn-ghost" href="#/developers">Developers</a>
      </div>
    </footer>
  );
}
