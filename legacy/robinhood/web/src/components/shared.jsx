import { useEffect, useRef, useState } from "react";
import { EXPLORER, deployment } from "../lib/client.js";
import { PixelIcon } from "./art.jsx";

const sourcify = (addr) => `https://repo.sourcify.dev/${deployment.chainId}/${addr}`;
const explorer = (addr) => `${EXPLORER}/address/${addr}`;

// ------------------------------------------------------------------ theme

export function useTheme() {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem("robinmix:theme") || "dark";
    } catch {
      return "dark";
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("robinmix:theme", theme);
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
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const esc = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className={`nav-item ${open ? "open" : ""}`} ref={ref} onMouseLeave={() => setOpen(false)}>
      <button className="nav-link" aria-expanded={open} onClick={() => setOpen((o) => !o)} onMouseEnter={() => setOpen(true)}>
        {label} <Chevron />
      </button>
      {open && (
        <div className="menu" role="menu">
          {items.map(([text, href, sub]) => (
            <a key={text} role="menuitem" href={href} onClick={() => setOpen(false)}
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

export function Nav({ onApp, theme, setTheme }) {
  return (
    <header className="nav">
      <div className="wrap">
        <a href="#/" className="wordmark" aria-label="RobinMix home">RobinMix</a>
        <Dropdown label="Protocol" items={[
          ["How it works", "#/how"],
          ["What stays public", "#/hidden"],
          ["Supported assets", "#/assets"],
          ["Under the hood", "#/tech"],
        ]} />
        <Dropdown label="Contracts" items={[
          ["Pool", explorer(deployment.pool), deployment.pool],
          ["Proof verifier", explorer(deployment.verifier), deployment.verifier],
          ["Verified source", sourcify(deployment.pool), "Sourcify · exact match"],
        ]} />
        <Dropdown label="Developers" items={[
          ["Command line", "#/developers"],
          ["Run a relayer", "#/developers"],
          ["Security notes", "#/security"],
        ]} />
        <div className="nav-item"><a className="nav-link" href="#/faq">FAQ</a></div>
        <div className="theme-toggle" role="group" aria-label="Colour theme">
          <button aria-pressed={theme === "light"} aria-label="Light theme" onClick={() => setTheme("light")}><Sun /></button>
          <button aria-pressed={theme === "dark"} aria-label="Dark theme" onClick={() => setTheme("dark")}><Moon /></button>
        </div>
        {!onApp && <a href="#/app" className="btn btn-primary btn-sm nav-cta">Launch app</a>}
      </div>
    </header>
  );
}

// Logos are self-hosted (see scripts/sync.mjs); stocks sit on a tile, coins are already round.
export function AssetIcon({ asset, small, size }) {
  const [failed, setFailed] = useState(false);
  const cls = `icon ${small ? "icon-sm" : ""}`;
  const style = size ? { width: size, height: size } : undefined;
  if (asset.logo && !failed) {
    return (
      <span className={`${cls} logo ${asset.logoTile ? `tile-${asset.logoTile}` : "logo-round"}`} style={style} aria-hidden="true">
        <img src={asset.logo} alt="" loading="lazy" onError={() => setFailed(true)} />
      </span>
    );
  }
  if (asset.kind === "ETH") {
    return (
      <span className={cls} aria-hidden="true">
        <svg viewBox="0 0 24 24" width="55%" height="55%"><path fill="currentColor" d="M12 2 5.5 12.3 12 16l6.5-3.7L12 2Zm0 15.3-6.5-3.8L12 22l6.5-8.5-6.5 3.8Z" opacity=".9" /></svg>
      </span>
    );
  }
  const label = asset.kind === "USDG" ? "$" : small ? asset.symbol[0] : asset.symbol;
  return <span className={`${cls} ${asset.kind === "STOCK" ? "icon-stock" : ""}`} aria-hidden="true">{label}</span>;
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
            <li><a href={explorer(deployment.pool)} target="_blank" rel="noreferrer"><PixelIcon name="shield" size={18} /> Pool on explorer</a></li>
            <li><a href={sourcify(deployment.pool)} target="_blank" rel="noreferrer"><PixelIcon name="check" size={18} /> Verified source</a></li>
            <li><a href="#/security"><PixelIcon name="warn" size={18} /> Security notes</a></li>
          </ul>
        </div>
        <span className="wordmark">RobinMix</span>
      </div>
      <p className="footer-note">
        RobinMix is an unaudited hobby project running on Robinhood Chain. It isn't affiliated with Robinhood. Stock tokens aren't available to US
        persons. Only shield what you can afford to lose.
      </p>
      <div className="footer-ctas">
        <a className="btn btn-primary" href="#/app">Launch app</a>
        <a className="btn btn-ghost" href="#/developers">Developers</a>
      </div>
    </footer>
  );
}
