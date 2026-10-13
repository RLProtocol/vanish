import { useEffect, useState } from "react";
import { ASSETS, EXPLORER, deployment, getPoolStats } from "../lib/client.js";
import { fmt } from "../lib/format.js";
import { AssetIcon, ArrowUpRight } from "./shared.jsx";
import { Halftone, PixelIcon, PixelTile } from "./art.jsx";

const ETH = ASSETS.find((a) => a.kind === "ETH");
const USDG = ASSETS.find((a) => a.kind === "USDG");
const STOCKS = ASSETS.filter((a) => a.kind === "STOCK");

function usePoolStats() {
  const [stats, setStats] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => getPoolStats().then((s) => alive && setStats(s)).catch(() => {});
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

const bySymbol = Object.fromEntries(ASSETS.map((a) => [a.symbol, a]));
const SAMPLE = [
  ["NVDA", "10", "sh"],
  ["TSLA", "5", "sh"],
  ["SPY", "50", "sh"],
  ["ETH", "0.5", "ETH"],
  ["USDG", "1,000", "USDG"],
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
            <span><b>{sym}</b><small>{a.name}</small></span>
            <span className="pval">
              {hidden ? <span className="redact" style={{ width: 64 + ((i * 23) % 40) }} aria-label="hidden" /> : `${amt} ${unit}`}
            </span>
          </div>
        );
      })}
      <figcaption className="pfoot">
        <span>Owner {hidden ? <span className="redact" style={{ width: 88, height: 12, verticalAlign: "middle" }} aria-label="hidden" /> : <span className="mono">0x9DCB…Cc22</span>}</span>
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
          <h1>Hold stocks onchain.<br /><span className="alt">Keep the trail private.</span></h1>
          <p className="lede">
            Every stock token on Robinhood Chain sits in a wallet anyone can look up. Shield ETH, USDG and {STOCKS.length} stock tokens, then send any
            amount to any address with no onchain link back to you.
          </p>
          <div className="hero-ctas">
            <a className="btn btn-primary" href="#/app">
              Launch app <span className="arrow-box"><ArrowUpRight /></span>
            </a>
            <a className="btn btn-ghost" href="#/how">How it works</a>
          </div>
        </div>
        <PortfolioCard />
      </div>

      <div className="hero-bar" aria-label="Live pool statistics">
        <div className="hstat"><b>{n(stats?.transactions.toLocaleString("en-US"))}</b><span>Private transactions</span></div>
        <div className="hstat"><b>{n(fmt(stats?.balances.ETH, 18, 3))}</b><span>ETH shielded</span></div>
        <div className="hstat"><b>{n(fmt(stats?.balances.USDG, 6, 0))}</b><span>USDG shielded</span></div>
        <div className="hstat"><b>{ASSETS.length}</b><span>Assets supported</span></div>
      </div>

      <div className="marquee" aria-label="Supported assets">
        <div className="marquee-track">
          {loop.map((a, i) => (
            <span className="mq" key={`${a.symbol}-${i}`} aria-hidden={i >= ASSETS.length}>
              <AssetIcon asset={a} small /> <b>{a.symbol}</b> <span>{a.name}</span>
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ public vs private

function Hidden() {
  const pub = [
    ["Wallet that shields", "0x9DCB…Cc22"],
    ["Amount and token shielded", "0.1 ETH"],
    ["Address that receives", "0x9965…A4dc"],
    ["Amount and token received", "0.1337 ETH"],
    ["Relayer that paid gas", "0x7099…79C8"],
  ];
  const priv = [
    ["Which deposit paid for a withdrawal", 140],
    ["Your balance inside the pool", 96],
    ["How many notes you hold", 64],
    ["Every address you've paid privately", 120],
    ["Your private key", 150],
  ];
  return (
    <Content id="hidden" icon="eye" tone="white" tag="What stays public"
      title="RobinMix hides the link between transactions, not the transactions themselves."
      intro="Knowing exactly what an explorer can still see is how you keep everything else private.">
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
        {[ETH, USDG].map((a) => (
          <div className="card asset-card" key={a.symbol}>
            <h3><AssetIcon asset={a} /> {a.symbol}<span className="muted" style={{ fontWeight: 550, fontSize: 17 }}>{a.name}</span></h3>
            <p>Shield in one of four sizes.</p>
            <div className="chips">{a.denominations.map((d) => <span className="chip" key={d}>{d}</span>)}</div>
            <div className="stat-line">In the pool <b>{inPool(a, a.decimals === 6 ? 2 : 4)} {a.symbol}</b></div>
          </div>
        ))}
        <div className="card asset-card">
          <h3><span className="icon icon-stock">{STOCKS.length}</span> Stock tokens</h3>
          <p>Sizes are in shares and set higher, since one share costs far less than one ether.</p>
          <div className="chips">{STOCKS[0].denominations.map((d) => <span className="chip" key={d}>{d} sh</span>)}</div>
          <div className="stat-line">Dividends and splits <b>carried through</b></div>
        </div>
      </div>
      <div className="tickers" style={{ maxWidth: 1380, margin: "20px auto 0" }}>
        {STOCKS.map((a) => (
          <div className="ticker" key={a.symbol} title={a.name}>
            <AssetIcon asset={a} size={34} />
            <b>{a.symbol}</b>
            <span>{a.name}</span>
            <span>{stats ? `${fmt(stats.balances[a.symbol], 18, 2)} sh in pool` : " "}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ ways to use

function Ways() {
  return (
    <Content id="use" icon="globe" tone="white" tag="How to use RobinMix"
      intro="The pool is a set of verified contracts on Robinhood Chain. Use it from the browser, from a terminal, or run the relayer that keeps other people's wallets out of their withdrawals.">
      <div className="grid-3">
        <div className="card">
          <h3>Web app</h3>
          <p>Connect a wallet, sign once to unlock your private balance, and shield or unshield. Proofs are generated in your browser.</p>
          <div className="card-art art-app">
            <div className="mini" aria-hidden="true">
              <div className="mini-tabs"><span className="on">Shield</span><span>Unshield</span><span>Activity</span></div>
              <div className="mini-label"><span>Asset</span><span>In wallet: 2.4 ETH</span></div>
              <div className="mini-row"><span>0.01</span><span className="on">0.1</span><span>0.5</span><span>1</span></div>
              <div className="mini-btn">Shield 0.1 ETH</div>
            </div>
          </div>
          <div className="card-foot"><a className="try" href="#/app">Try now <ArrowUpRight /></a></div>
        </div>
        <div className="card">
          <h3>Command line</h3>
          <p>A Node CLI with the same keys and notes as the web app. Good for scripting and for people who don't want a browser wallet.</p>
          <div className="card-art art-term" aria-hidden="true">
            <span className="d">$ </span>robinmix deposit --asset ETH --amount 0.1{"\n"}
            proving + depositing 0.1 ETH ...{"\n"}
            <span className="g">done:</span> 0xb341…1b87{"\n"}
            <span className="d">$ </span>robinmix withdraw --asset NVDA --amount 3.25{"\n"}
            {"    "}--to 0x9965…A4dc --relayer https://…{"\n"}
            <span className="v">relayer</span> 0x7099…79C8 fee 0.00975 NVDA{"\n"}
            <span className="g">done:</span> 0x06c9…43d5{"\n"}
            remaining shielded NVDA: <span className="y">6.74025</span>
          </div>
          <div className="card-foot"><a className="try" href="#/developers">See commands <ArrowUpRight /></a></div>
        </div>
        <div className="card">
          <h3>Relayer</h3>
          <p>Submits withdrawals and pays the gas, so users' own wallets never appear. It earns a small fee that is sealed inside each proof.</p>
          <div className="card-art art-term" aria-hidden="true">
            <div className="art-big">RELAYER</div>
            <span className="d">pool</span> 0xA525…65aA  <span className="d">chain</span> 4663{"\n"}
            <span className="g">listening</span> :8000  fee 30 bps{"\n"}
            POST /relay  3.25 NVDA  <span className="g">fee ok</span>{"\n"}
            <span className="v">relayed</span> 0x06c9…43d5
          </div>
          <div className="card-foot"><a className="try" href="#/developers">Run one <ArrowUpRight /></a></div>
        </div>
      </div>
    </Content>
  );
}

// ------------------------------------------------------------------ tech / security / developers / faq

function Tech() {
  const rows = [
    ["Proof system", "Groth16 on BN254, verified on-chain in one call"],
    ["Circuit", "2 notes in, 2 notes out, 28,044 constraints"],
    ["Hash", "Poseidon, for notes, nullifiers and the Merkle tree"],
    ["Pool size", "Merkle tree of depth 20: 1,048,576 notes"],
    ["Multi-asset", "Every note is bound to one token, so value can't cross assets"],
    ["Front-running", "Recipient, relayer and fee are sealed inside the proof"],
    ["Your key", "Derived in your browser from one wallet signature"],
    ["Recovery", "Notes are stored on-chain, encrypted to your key (AES-256-GCM)"],
    ["Where proofs run", "In your browser, in a background worker. Nothing leaves your device"],
    ["Corporate actions", "Stock dividends and splits carry through automatically (ERC-8056)"],
  ];
  return (
    <Content id="tech" icon="terminal" tone="blue" tag="Under the hood" title="Built on the Tornado Nova design, extended to hold ETH, dollars and stocks in one pool.">
      <dl className="spec">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    </Content>
  );
}

function Security() {
  const c = [
    ["Pool", deployment.pool, true],
    ["Proof verifier", deployment.verifier, true],
    ["Poseidon hasher", deployment.hasher, false],
  ];
  return (
    <Content id="security" icon="shield" tone="sand" tag="Read before you shield" title="The contracts are verified byte for byte. Nobody, including the deployer, can stop you from unshielding.">
      <div className="contracts">
        {c.map(([name, addr, verified]) => (
          <div className="contract" key={name}>
            <b>{name}</b>
            <span className="mono">{addr}</span>
            <span className="contract-links">
              <a href={`${EXPLORER}/address/${addr}`} target="_blank" rel="noreferrer">Explorer</a>
              {verified
                ? <a href={`https://repo.sourcify.dev/${deployment.chainId}/${addr}`} target="_blank" rel="noreferrer">Source</a>
                : <span className="muted">circomlibjs bytecode</span>}
            </span>
          </div>
        ))}
      </div>
      <div className="callout" role="note">
        <h3><PixelIcon name="warn" size={22} /> Before you shield real money</h3>
        <ul>
          <li>The code has not been audited.</li>
          <li>The proving keys come from a single-party setup. Whoever ran it could forge proofs. A multi-party ceremony is needed before the pool should hold meaningful value.</li>
          <li>The owner can pause new deposits for an asset. Withdrawals can't be paused.</li>
          <li>Token issuers (Paxos for USDG, Robinhood for stock tokens) may be able to freeze tokens at their own contracts.</li>
        </ul>
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
          <p>Uses the same notes as the web app. Import its key file in the app to see the same balance.</p>
          <pre className="code">{`npm install
node src/cli.js keygen
node src/cli.js deposit  --network rhMainnet --asset ETH  --amount 0.1
node src/cli.js balance  --network rhMainnet
node src/cli.js withdraw --network rhMainnet --asset NVDA --amount 3.25 \\
    --to 0xRecipient --relayer https://your-relayer`}</pre>
        </div>
        <div className="card">
          <h3>Run a relayer</h3>
          <p>Pays gas in ETH, earns its fee in the withdrawn asset. It refuses proofs that don't name it or underpay.</p>
          <pre className="code">{`RELAYER_PRIVATE_KEY=0x…  \\
NETWORK=rhMainnet PORT=8000 FEE_BPS=30 \\
node src/relayer.js

`}<span className="d">{`# GET  /info   -> address, pool, fee
# POST /relay  -> { txHash }`}</span></pre>
        </div>
      </div>
    </Content>
  );
}

function Faq() {
  const qs = [
    ["Is this like Tornado Cash?", "Same core idea: deposit into a shared pool, withdraw elsewhere with a zero-knowledge proof. RobinMix uses the later Tornado Nova design, so withdrawals can be any amount, and one pool holds several assets."],
    ["Why can't I shield any amount I want?", "Fixed sizes make every deposit of an asset look identical. If everyone shielded unique amounts, matching deposits to withdrawals would be trivial."],
    ["How do I get my balance on another device?", "Connect the same wallet and sign the same message. Your private key is derived from that signature, and your notes are stored on-chain, encrypted to it."],
    ["What happens to dividends and stock splits?", "Stock tokens record corporate actions as an on-chain multiplier while token balances stay fixed. The pool holds tokens, so whoever unshields receives the adjusted value."],
    ["What is a relayer?", "A service that submits your withdrawal and pays the gas, so your own wallet never appears. It takes a small fee from the withdrawn amount. The fee and recipient are sealed in your proof, so it can't redirect funds."],
    ["How private am I, really?", "As private as the crowd. With few deposits of an asset, or a withdrawal right after a deposit, timing and amounts can still point to you. Wait, use round amounts, and withdraw through a relayer to a fresh address."],
    ["Is this legal?", "Privacy tools are legal in many places, but rules differ by country and change. Stock tokens are not offered to US persons. Check what applies to you before using the pool."],
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

      <Panel n={1} id="about" icon="mask" tone="accent" tag="Privacy for onchain stocks"
        sub="A brokerage account is private by default. An onchain wallet is the opposite. RobinMix gives you that privacy back without handing your tokens to anyone: the pool is a contract, and only your key can spend your notes.">
        Private access to <PixelTile name="eth" /> ETH, <PixelTile name="dollar" /> dollars and{" "}
        <PixelTile name="chart" /> stocks. Non-custodial, <PixelTile name="lock" /> withdrawals nobody can pause,
        and <PixelTile name="eye" /> no public trail.
      </Panel>

      <Panel n={2} id="how" icon="coin" tone="blue" tag="How it works"
        sub="Everyone shields the same sizes, so deposits look identical. Your browser later proves you own enough to withdraw without revealing which note is yours, and anything left over stays private as change.">
        Shield <PixelTile name="coin" tone="blue" /> a fixed amount. Let the pool <PixelTile name="clock" tone="blue" /> grow.
        Unshield <PixelTile name="arrow" tone="blue" /> any amount, to any address.
      </Panel>

      <Hidden />

      <Panel n={3} id="assets" icon="chart" tone="rose" tag="Supported assets">
        One pool for <PixelTile name="eth" tone="rose" /> ETH, <PixelTile name="dollar" tone="rose" /> USDG and {STOCKS.length}{" "}
        <PixelTile name="chart" tone="rose" /> stock tokens, each kept in its own lane.
      </Panel>
      <Assets stats={stats} />

      <Ways />
      <Tech />
      <Security />
      <Developers />
      <Faq />
    </main>
  );
}
