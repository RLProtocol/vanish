import { useEffect, useState } from "react";
import { ASSETS, EXPLORER, P, PROGRAM_ID, deployment, getPoolStats } from "../lib/solana.js";
import { fmt } from "../lib/format.js";
import { AssetIcon, ArrowUpRight } from "./shared.jsx";
import { Halftone, PixelIcon, PixelTile } from "./art.jsx";
import Spec from "./Spec.jsx";

const bySymbol = Object.fromEntries(ASSETS.map((a) => [a.symbol, a]));
const SOL = bySymbol.SOL;
const DOLLARS = ASSETS.filter((a) => a.kind === "dollar");
const STOCKS = ASSETS.filter((a) => a.kind === "stock");
const ISSUERS = [...new Set(STOCKS.map((a) => a.issuer))];

function usePoolStats() {
  const [stats, setStats] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => getPoolStats().then((s) => alive && setStats(s)).catch((e) => console.warn("pool stats unavailable:", e?.message ?? e));
    load();
    const t = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return stats;
}

// ------------------------------------------------------------------ building blocks

function TagRow({ icon, tone, children }) {
  return (
    <div className="tag-row">
      <PixelIcon name={icon} size={30} />
      <span className={`tag ${tone}`}>{children}</span>
      <PixelIcon name={icon} size={30} />
    </div>
  );
}

/** Full-height statement panel with numbered side rails. */
function Panel({ n, id, icon, tone, tag, children, sub }) {
  const num = String(n).padStart(2, "0");
  return (
    <section className="panel-sec" id={id}>
      <div className="panel-inner">
        <span className="rail l" aria-hidden="true" />
        <span className="rail r" aria-hidden="true" />
        <span className="rail-num l" aria-hidden="true">{num}</span>
        <span className="rail-num r" aria-hidden="true">{num}</span>
        <TagRow icon={icon} tone={tone}>{tag}</TagRow>
        <h2 className="statement">{children}</h2>
        {sub && <p className="sub-statement">{sub}</p>}
      </div>
    </section>
  );
}

function Content({ id, icon, tone, tag, title, intro, children }) {
  return (
    <section className="content" id={id}>
      <div className="content-head">
        <TagRow icon={icon} tone={tone}>{tag}</TagRow>
        {title && <h2>{title}</h2>}
        {intro && <p>{intro}</p>}
      </div>
      {children}
    </section>
  );
}

// ------------------------------------------------------------------ hero

const SAMPLE = [
  ["NVDAx", "10", "sh"],
  ["SPCX", "5", "sh"],
  ["SPYx", "50", "sh"],
  ["SOL", "20", "SOL"],
  ["USDC", "1,000", "USDC"],
].filter(([s]) => bySymbol[s]);

/** The owner's view of a shielded portfolio vs. what a block explorer can see. */
function PortfolioCard() {
  const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [view, setView] = useState("explorer");
  const [auto, setAuto] = useState(!reduced);
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => setView((v) => (v === "you" ? "explorer" : "you")), 3200);
    return () => clearInterval(t);
  }, [auto]);
  const pick = (v) => {
    setAuto(false);
    setView(v);
  };
  const hidden = view === "explorer";
  return (
    <figure className="pcard" aria-label="Example shielded portfolio">
      <div className="pcard-tabs" role="group" aria-label="Whose view">
        <button aria-pressed={!hidden} onClick={() => pick("you")}>You see</button>
        <button aria-pressed={hidden} onClick={() => pick("explorer")}>Explorer sees</button>
      </div>
      {SAMPLE.map(([sym, amt, unit], i) => {
        const a = bySymbol[sym];
        return (
          <div className="prow" key={sym}>
            <AssetIcon asset={a} />
            <span><b>{sym}</b><small>{a.kind === "stock" ? `${a.name} · ${a.issuer}` : a.name}</small></span>
            <span className="pval">
              {hidden ? <span className="redact" style={{ width: 64 + ((i * 23) % 40) }} aria-label="hidden" /> : `${amt} ${unit}`}
            </span>
          </div>
        );
      })}
      <figcaption className="pfoot">
        <span>Owner {hidden ? <span className="redact" style={{ width: 88, height: 12, verticalAlign: "middle" }} aria-label="hidden" /> : <span className="mono">7xKp…Q2vR</span>}</span>
        <span className="ok"><PixelIcon name="check" size={14} /> proof verified</span>
      </figcaption>
    </figure>
  );
}

function Hero({ stats, theme }) {
  const n = (v) => (stats ? v : "—");
  const loop = [...ASSETS, ...ASSETS];
  return (
    <section className="hero">
      <Halftone theme={theme} />
      <div className="hero-main">
        <div>
          <h1>Shield, swap and buy on Solana.<br /><span className="alt">Leave no trail.</span></h1>
          <p className="lede">
            Every wallet on Solana is an open book. Vanish is a zero-knowledge pool for SOL, dollars and {STOCKS.length} tokenized stocks: withdraw
            to any wallet, trade between assets inside the pool, or buy any token, pump.fun launches included, straight into a fresh wallet. None of
            it links back to you.
          </p>
          <div className="hero-ctas">
            <a className="btn btn-primary" href="#/app">
              Launch app <span className="arrow-box"><ArrowUpRight /></span>
            </a>
            <a className="btn btn-ghost" href="#/utility">What you can do</a>
          </div>
        </div>
        <PortfolioCard />
      </div>

      <div className="hero-bar" aria-label="Live pool statistics">
        <div className="hstat"><b>{n(stats?.transactions.toLocaleString("en-US"))}</b><span>Private transactions</span></div>
        <div className="hstat"><b>{n(fmt(stats?.balances.SOL, 9, 2))}</b><span>SOL shielded</span></div>
        <div className="hstat"><b>{n(fmt(stats?.balances.USDC, 6, 0))}</b><span>USDC shielded</span></div>
        <div className="hstat"><b>{ASSETS.length}</b><span>Assets supported</span></div>
      </div>

      <div className="marquee" aria-label="Supported assets">
        <div className="marquee-track">
          {loop.map((a, i) => (
            <span className="mq" key={`${a.symbol}-${i}`} aria-hidden={i >= ASSETS.length}>
              <AssetIcon asset={a} small /> <b>{a.symbol}</b> <span>{a.kind === "stock" ? a.name : a.issuer === "Native" ? "Solana" : a.issuer}</span>
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ utility

const UTILITY = [
  {
    id: "shield",
    icon: "coin",
    tone: "blue",
    name: "Shield",
    pitch: "Move SOL, dollars or stock tokens into the pool.",
    flow: ["Pick an asset and a fixed size", "Your browser makes the proof", "Your wallet signs one transaction"],
    sees: "Your wallet deposited 1 SOL into Vanish",
    hidden: "Who owns the note it created, and everything you do with it next",
    guarantees: ["Fixed sizes make every deposit of an asset look the same", "Only your key can ever spend the note"],
    fee: "Network fee + ~0.002 SOL rent",
  },
  {
    id: "unshield",
    icon: "arrow",
    tone: "rose",
    name: "Unshield",
    pitch: "Send any amount to any wallet, with no link back to the deposit.",
    flow: ["Enter an amount and a fresh wallet", "Your browser proves you own enough", "The relayer submits it; your wallet never signs"],
    sees: "The Vanish pool paid 3.5 NVDAx to 9fTe…4mWa",
    hidden: "Which deposit it came from, and that it was you",
    guarantees: ["Recipient and fee are sealed in the proof: nobody can redirect it", "The admin can pause deposits, never withdrawals"],
    fee: "0.3% (min 0.003 SOL · 0.5 USD · 0.002 sh)",
  },
  {
    id: "swap",
    icon: "chart",
    tone: "accent",
    name: "Private swap",
    pitch: "Trade one private asset for another without it ever leaving the pool. SOL into NVDAx, USDC into SPYx, stocks back to dollars.",
    flow: ["Choose From and To, see a live Jupiter quote", "Your browser makes three proofs: refund, output, spend", "The relayer runs the trade through Jupiter inside the program"],
    sees: "The pool sold 2 SOL and received 9.6 NVDAx",
    hidden: "Whose SOL it was and whose NVDAx it is now. Both legs start and end inside the pool",
    guarantees: ["You receive exactly the amount shown, enforced on-chain, or the swap cancels", "If the price runs away the swap cancels and your funds come back as a private note", "Anyone can cancel after the deadline, so nothing waits on the relayer"],
    fee: "0.3% (min 0.009 SOL) in the asset you sell",
  },
  {
    id: "buy",
    icon: "globe",
    tone: "sand",
    name: "Private buy",
    pitch: "Spend private funds on any token Jupiter can trade, including fresh pump.fun launches, and receive it in a brand-new wallet.",
    flow: ["Paste a mint: chart, market cap and liquidity load from DexScreener", "Pick or create a fresh wallet (we can generate one for you)", "One proof; the relayer buys and delivers straight to that wallet"],
    sees: "The Vanish pool bought 4.8M tokens for F7re…k2P",
    hidden: "Who paid. The new wallet's history ends at the pool",
    guarantees: ["Token, minimum, deadline and wallet are sealed in the proof", "Optional 0.01 SOL gas so the new wallet never needs funding from you", "If it can't fill, your SOL goes to the new wallet instead"],
    fee: "0.3% (min 0.006 SOL)",
  },
];

const GUARANTEES = [
  ["lock", "Non-custodial", "The pool is a program. Only your key can spend your notes; nobody holds your funds."],
  ["shield", "Withdrawals can't be paused", "The admin can list assets and pause deposits. No switch exists to stop a withdrawal."],
  ["check", "Terms sealed in proofs", "Recipients, fees, minimums, tokens and deadlines are hashed into each proof. Change one byte and it fails."],
  ["arrow", "Routes can't touch the pool", "Swaps run through whitelisted Jupiter, signed only by a per-order escrow. Pool vaults never sign."],
  ["clock", "Nothing gets stuck", "Every order has a deadline of at most an hour. After it, anyone can cancel and the funds come back."],
  ["eye", "No trail to the pool's users", "Withdrawals, swaps and buys are submitted by the relayer, so your wallet never appears next to them."],
];

function Utility() {
  return (
    <Content id="utility" icon="mask" tone="accent" tag="What you can do"
      title="Four private actions, one Solana program."
      intro="Shield once, then move value privately: withdraw to any wallet, trade between assets inside the pool, or buy any token into a fresh wallet. Every action is a zero-knowledge proof checked on-chain.">
      <div className="util-grid">
        {UTILITY.map((u, i) => (
          <article className={`card util util-${u.tone}`} key={u.id} id={`utility-${u.id}`}>
            <header className="util-head">
              <PixelTile name={u.icon} tone={u.tone} />
              <div>
                <span className="util-num">0{i + 1}</span>
                <h3>{u.name}</h3>
              </div>
            </header>
            <p className="util-pitch">{u.pitch}</p>
            <ol className="util-flow">
              {u.flow.map((s) => <li key={s}>{s}</li>)}
            </ol>
            <div className="util-views">
              <div><span>Solscan sees</span><p>{u.sees}</p></div>
              <div><span>Stays hidden</span><p>{u.hidden}</p></div>
            </div>
            <ul className="util-guard">
              {u.guarantees.map((g) => <li key={g}><PixelIcon name="check" size={14} /> {g}</li>)}
            </ul>
            <footer className="util-foot">
              <span>Fee <b>{u.fee}</b></span>
              <a className="try" href="#/app">Open <ArrowUpRight /></a>
            </footer>
          </article>
        ))}
      </div>

      <div className="guarantees">
        {GUARANTEES.map(([icon, title, body]) => (
          <div className="guarantee" key={title}>
            <PixelIcon name={icon} size={22} />
            <b>{title}</b>
            <p>{body}</p>
          </div>
        ))}
      </div>
    </Content>
  );
}

// ------------------------------------------------------------------ public vs private

function Hidden() {
  const pub = [
    ["Wallet that shields", "7xKp…Q2vR"],
    ["Amount and token shielded", "10 NVDAx"],
    ["Wallet that receives a withdrawal", "9fTe…4mWa"],
    ["What a swap traded", "2 SOL → 9.6 NVDAx"],
    ["Token bought and the wallet it went to", "4.8M FROG → F7re…k2P"],
    ["Relayer that paid the fee", "FwL2…BhHq"],
  ];
  const priv = [
    ["Which deposit paid for a withdrawal", 140],
    ["Whose funds a swap traded", 120],
    ["Who paid for a private buy", 110],
    ["Your balance inside the pool", 96],
    ["Every wallet you've paid privately", 120],
    ["Your private key", 150],
  ];
  return (
    <Content id="hidden" icon="eye" tone="white" tag="What stays public"
      title="Vanish hides who is behind a transaction, not that it happened."
      intro="Knowing exactly what Solscan can still see is how you keep everything else private.">
      <div className="grid-2 ledger">
        <div className="card">
          <h3>Public, like any transaction</h3>
          <ul>{pub.map(([k, v]) => <li key={k}><span>{k}</span><span className="v">{v}</span></li>)}</ul>
        </div>
        <div className="card">
          <h3>Private, protected by the proof</h3>
          <ul>{priv.map(([k, w]) => <li key={k}><span>{k}</span><span className="redact" style={{ width: w }} aria-label="hidden" /></li>)}</ul>
        </div>
      </div>
    </Content>
  );
}

// ------------------------------------------------------------------ assets

function Assets({ stats }) {
  const inPool = (a, frac) => (stats ? fmt(stats.balances[a.symbol], a.decimals, frac) : "—");
  return (
    <section className="content" id="assets-list" style={{ paddingTop: 0 }}>
      <div className="grid-3">
        <div className="card asset-card">
          <h3><AssetIcon asset={SOL} /> SOL<span className="muted" style={{ fontWeight: 550, fontSize: 17 }}>Native</span></h3>
          <p>Shield in one of four sizes.</p>
          <div className="chips">{SOL.denominations.map((d) => <span className="chip" key={d}>{d}</span>)}</div>
          <div className="stat-line">In the pool <b>{inPool(SOL, 2)} SOL</b></div>
        </div>
        <div className="card asset-card">
          <h3><AssetIcon asset={DOLLARS[0]} /> Dollars<span className="muted" style={{ fontWeight: 550, fontSize: 17 }}>{DOLLARS.map((d) => d.symbol).join(" · ")}</span></h3>
          <p>Circle's USDC, Tether's USDT and Paxos's USDG, each in its own pool lane.</p>
          <div className="chips">{DOLLARS[0].denominations.map((d) => <span className="chip" key={d}>{d}</span>)}</div>
          <div className="stat-line">In the pool <b>{DOLLARS.map((d) => `${inPool(d, 0)} ${d.symbol}`).join(" · ")}</b></div>
        </div>
        <div className="card asset-card">
          <h3><span className="icon icon-stock">{STOCKS.length}</span> Stock tokens</h3>
          <p>From {ISSUERS.join(" and ")}. Sizes are in shares.</p>
          <div className="chips">{STOCKS[0].denominations.map((d) => <span className="chip" key={d}>{d} sh</span>)}</div>
          <div className="stat-line">Dividends and splits <b>carried through</b></div>
        </div>
      </div>
      <div className="tickers" style={{ maxWidth: 1380, margin: "20px auto 0" }}>
        {STOCKS.map((a) => (
          <div className="ticker" key={a.symbol} title={`${a.name} · ${a.issuer} · ${a.mint}`}>
            <AssetIcon asset={a} size={34} />
            <b>{a.symbol}</b>
            <span>{a.name} · {a.issuer}</span>
            <span>{stats ? `${fmt(stats.balances[a.symbol], a.decimals, 2)} sh in pool` : " "}</span>
          </div>
        ))}
      </div>
      <p className="muted" style={{ maxWidth: 1380, margin: "18px auto 0", fontSize: 15 }}>
        Stock tokens apply dividends through a display multiplier, so your wallet may show 1 share as 1.0017. The pool holds the raw tokens, so
        whoever unshields gets the adjusted value. Tokenized stocks aren't offered to US persons.
      </p>
    </section>
  );
}

// ------------------------------------------------------------------ ways to use

function Ways() {
  return (
    <Content id="use" icon="globe" tone="white" tag="How to use Vanish"
      intro="Vanish is one Solana program. Use it from the browser with Phantom, Solflare or Backpack, from a terminal, or run the relayer that keeps everyone's wallets out of their withdrawals, swaps and buys.">
      <div className="grid-3">
        <div className="card">
          <h3>Web app</h3>
          <p>Connect a Solana wallet and sign once to unlock your private balance. Shield, unshield, swap and buy from one screen; proofs are generated in your browser.</p>
          <div className="card-art art-app">
            <div className="mini" aria-hidden="true">
              <div className="mini-tabs"><span>Shield</span><span>Unshield</span><span className="on">Swap</span><span>Buy</span></div>
              <div className="mini-label"><span>2 SOL → NVDAx</span><span>Private: 5 SOL</span></div>
              <div className="mini-row"><span>≈ 9.71</span><span className="on">min 9.61</span><span>1%</span></div>
              <div className="mini-btn">Swap privately</div>
            </div>
          </div>
          <div className="card-foot"><a className="try" href="#/app">Try now <ArrowUpRight /></a></div>
        </div>
        <div className="card">
          <h3>Command line</h3>
          <p>A Node CLI that uses the same notes as the web app. Good for scripting, or if you'd rather not connect a browser wallet.</p>
          <div className="card-art art-term" aria-hidden="true">
            <span className="d">$ </span>vanish shield --asset SOL --amount 1{"\n"}
            {"  "}sync · prove · confirm{"\n"}
            <span className="g">shielded</span> 1 SOL: 4hXq…9KdV{"\n"}
            <span className="d">$ </span>vanish unshield --asset NVDAx --amount 3.5{"\n"}
            {"    "}--to 9fTe…4mWa --relayer https://…{"\n"}
            <span className="v">relayer</span> Ry1a…z8Pk fee 0.0105 NVDAx{"\n"}
            <span className="g">sent</span> 3.5 NVDAx: 2Wbn…pQ7s
          </div>
          <div className="card-foot"><a className="try" href="#/developers">See commands <ArrowUpRight /></a></div>
        </div>
        <div className="card">
          <h3>Relayer</h3>
          <p>Pays the network fees and submits withdrawals, swaps and buys, so users' own wallets never sign them. Its fee is sealed inside each proof.</p>
          <div className="card-art art-term" aria-hidden="true">
            <div className="art-big">RELAYER</div>
            <span className="d">program</span> {PROGRAM_ID.toBase58().slice(0, 4)}…{PROGRAM_ID.toBase58().slice(-4)}  <span className="d">fee</span> 30 bps{"\n"}
            <span className="g">listening</span> :8000{"\n"}
            POST /swap   2 SOL → NVDAx  <span className="g">filled</span>{"\n"}
            POST /buy    0.5 SOL → FROG <span className="g">delivered</span>{"\n"}
            <span className="v">relayed</span> 2Wbn…pQ7s
          </div>
          <div className="card-foot"><a className="try" href="#/developers">Run one <ArrowUpRight /></a></div>
        </div>
      </div>
    </Content>
  );
}

// ------------------------------------------------------------------ tech / security / developers / faq

function Security() {
  const c = [
    ["Program", PROGRAM_ID.toBase58()],
    ["Pool account", P.pool.toBase58()],
    ["SOL vault", P.solVault.toBase58()],
    ...(deployment.lookupTable ? [["Lookup table", deployment.lookupTable]] : []),
    ["Swap router (whitelisted)", "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
  ];
  return (
    <Content id="security" icon="shield" tone="sand" tag="Read before you shield" title="Nobody, including the admin, can stop you from unshielding."
      intro="The admin can list assets and pause new deposits. It can close an asset only after it has been paused for over an hour and its vault is empty, so it can never trap anyone's funds. Vanish is an unaudited hobby project: only shield what you can afford to lose.">
      <div className="contracts">
        {c.map(([name, addr]) => (
          <div className="contract" key={name}>
            <b>{name}</b>
            <span className="mono">{addr}</span>
            <span className="contract-links">
              <a href={`${EXPLORER}/account/${addr}`} target="_blank" rel="noreferrer">Solscan</a>
            </span>
          </div>
        ))}
      </div>
    </Content>
  );
}

function Developers() {
  return (
    <Content id="developers" icon="terminal" tone="white" tag="Developers" title="Everything the app does, from a terminal.">
      <div className="grid-2">
        <div className="card">
          <h3>Command line wallet</h3>
          <p>Uses the same notes as the web app. Paste its key file into the app to see the same balance.</p>
          <pre className="code">{`npm install
node cli/vanish.mjs keygen
WALLET_KEYPAIR=~/id.json node cli/vanish.mjs shield --asset SOL --amount 1
node cli/vanish.mjs balance
node cli/vanish.mjs unshield --asset NVDAx --amount 3.5 \\
    --to <wallet> --relayer https://your-relayer`}</pre>
        </div>
        <div className="card">
          <h3>Run a relayer</h3>
          <p>Pays fees in SOL and earns its fee in the asset being spent. It simulates every transaction first, refuses ones that don't pay it, and routes swaps and buys through Jupiter.</p>
          <pre className="code">{`RELAYER_KEYPAIR=relayer.json \\
RPC_URL=https://your-rpc PORT=8000 FEE_BPS=30 \\
node cli/relayer.mjs

`}<span className="d">{`# GET  /info            -> address, fees
# GET  /quote, /token    -> Jupiter price, token info
# POST /relay            -> withdrawal { signature }
# POST /swap             -> private swap { status }
# POST /buy              -> private buy  { status }`}</span></pre>
        </div>
      </div>
    </Content>
  );
}

function Faq() {
  const qs = [
    ["Is this like Tornado Cash?", "Same core idea: deposit into a shared pool, withdraw elsewhere with a zero-knowledge proof. Vanish uses the later Tornado Nova design, so withdrawals can be any amount, and one pool holds SOL, dollars and stocks."],
    ["Which stock tokens work?", `${STOCKS.map((a) => a.symbol).join(", ")}. These are the busiest tokens from xStocks and from Backpack Securities via Sunrise. Fewer, busier tokens mean bigger crowds to hide in.`],
    ["Why can't I shield any amount I want?", "Fixed sizes make every deposit of an asset look identical. If everyone shielded unique amounts, matching deposits to withdrawals would be trivial."],
    ["How do I get my balance on another device?", "Connect the same wallet and sign the same message. Your private key is derived from that signature, and your notes are on-chain, encrypted to it."],
    ["How does a private swap work?", "Your browser makes three proofs: one for a refund note, one for the notes you'll receive, and one that spends your input. The relayer runs the trade through Jupiter inside the program, signed only by a one-off escrow. You get at least your guaranteed minimum, or the swap cancels and your funds come back as a private note."],
    ["Can I buy pump.fun tokens privately?", "Yes. Paste any mint Jupiter can trade. The pool pays from your private balance and the tokens land in a fresh wallet, which can also get 0.01 SOL for fees so you never fund it yourself. The token is never held by the pool, so it doesn't need to be listed."],
    ["What if the price moves while I'm waiting?", "Your minimum is sealed in the proof and checked on-chain after the trade. The relayer first refuses if the live price is already below it (nothing is spent), then retries the route a few times. If it still can't fill, a swap refunds you privately and a buy sends your SOL to the new wallet instead."],
    ["Can the relayer steal or redirect my funds?", "No. Recipients, fees, minimums, tokens and deadlines are all inside the proof, the swap route can only spend the order's own escrow, and if the relayer disappears anyone can cancel the order after its deadline."],
    ["What does a transaction cost?", "The normal Solana fee plus about 0.002 SOL of rent for the two nullifier accounts every transaction creates. That rent is what makes double spending impossible, and it isn't refundable."],
    ["What is a relayer?", "A service that pays the network fee and submits your withdrawal, swap or buy, so your wallet never signs it. It takes a small cut of the amount spent. The fee and recipient are sealed in your proof, so it can't redirect funds."],
    ["How private am I, really?", "As private as the crowd. With few deposits of an asset, or a withdrawal right after a deposit, timing and amounts can still point to you. Wait, use round amounts, send to fresh wallets, and never move tokens from a fresh wallet back to your main one."],
    ["Is this legal?", "Privacy tools are legal in many places, but rules differ by country and change. Tokenized stocks are not offered to US persons. Check what applies to you before using the pool."],
  ];
  return (
    <Content id="faq" icon="mask" tone="accent" tag="FAQ">
      <div className="faq">{qs.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}</div>
    </Content>
  );
}

// ------------------------------------------------------------------ page

export default function Landing({ theme }) {
  const stats = usePoolStats();
  return (
    <main>
      <Hero stats={stats} theme={theme} />
      <Utility />

      <Panel n={1} id="about" icon="mask" tone="accent" tag="Why it matters"
        sub="A brokerage account is private by default. A Solana wallet is the opposite: anyone can see every stock you hold, every token you ape into and every trade you make, and copy-trading bots follow along. Vanish gives you that privacy back without handing your funds to anyone. The pool is a program, and only your key can spend your notes.">
        Private <PixelTile name="coin" /> SOL, <PixelTile name="dollar" /> dollars and <PixelTile name="chart" /> stocks,
        private <PixelTile name="arrow" /> swaps and <PixelTile name="globe" /> buys of any token. Non-custodial,
        and <PixelTile name="eye" /> no public trail.
      </Panel>

      <Panel n={2} id="how" icon="coin" tone="blue" tag="How it works"
        sub="Everyone shields the same sizes, so deposits look identical. From then on your browser proves what you own without revealing which note is yours: to withdraw, to trade inside the pool, or to buy into a fresh wallet. Anything left over stays private as change.">
        Shield <PixelTile name="coin" tone="blue" /> a fixed amount. Swap <PixelTile name="chart" tone="blue" /> inside the pool.
        Buy <PixelTile name="globe" tone="blue" /> or unshield <PixelTile name="arrow" tone="blue" /> to a fresh wallet.
      </Panel>

      <Spec />

      <Hidden />

      <Panel n={3} id="assets" icon="chart" tone="rose" tag="Supported assets">
        One pool for <PixelTile name="coin" tone="rose" /> SOL, <PixelTile name="dollar" tone="rose" /> USDC, USDT, USDG and {STOCKS.length}{" "}
        <PixelTile name="chart" tone="rose" /> stock tokens, each kept in its own lane.
      </Panel>
      <Assets stats={stats} />

      <Ways />
      <Security />
      <Developers />
      <Faq />
    </main>
  );
}
