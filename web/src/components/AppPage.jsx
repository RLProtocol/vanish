import { useCallback, useEffect, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  ASSETS, EXPLORER, NATIVE_SOL, RELAYER_URL, deployment, explainError, getRpc, getWalletBalance, keypairFromWallet, makeClient, preloadProver, setRpc,
} from "../lib/solana.js";
import { INSTALL_LINKS, isMobileBrowser, listWallets, openInWalletLinks, walletLabel, watchWallets } from "../lib/wallets.js";
import { Keypair } from "sdk/crypto.js";
import { privateBuy } from "sdk/buy.js";
import { privateSwap } from "sdk/swap.js";
import { relayerEndpoint } from "sdk/solmix.js";
import { Keypair as SolKeypair } from "@solana/web3.js";
import bs58 from "bs58";
import { fmt, isUnusual, parseAmount, short } from "../lib/format.js";
import { AssetIcon } from "./shared.jsx";
import { PixelIcon } from "./art.jsx";

const ss = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} },
  del: (k) => { try { sessionStorage.removeItem(k); } catch {} },
};
const sessionKey = (pk) => `solmix:session:${pk}`;
const assetLabel = (a) => (a.kind === "stock" ? `${a.name} · ${a.issuer}` : a.name);

// ------------------------------------------------------------------ small pieces

function AssetSelect({ value, onChange, right }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className="asset-select" ref={ref}>
      <button type="button" className="asset-trigger" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <AssetIcon asset={value} small />
        <span><b>{value.symbol}</b> <span className="muted">{assetLabel(value)}</span></span>
        <span className="caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="asset-menu" role="listbox" aria-label="Choose asset">
          {ASSETS.map((a) => (
            <button type="button" role="option" aria-selected={a.symbol === value.symbol} key={a.symbol} className="asset-option"
              onClick={() => { onChange(a); setOpen(false); }}>
              <AssetIcon asset={a} small />
              <span><b>{a.symbol}</b> <span className="sub">{assetLabel(a)}</span></span>
              {right && <span className="right">{right(a)}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const STEP_LABELS = { sync: "Read the pool", merge: "Merge notes", prove: "Generate proof", submit: "Send transaction", pending: "Wait for confirmation", done: "Done" };

function Progress({ run }) {
  if (!run) return null;
  const idx = run.steps.indexOf(run.stage);
  const width = run.stage === "done" ? 100 : Math.max(6, ((idx + (run.sub ?? 0)) / (run.steps.length - 1)) * 100);
  return (
    <div className="progress" aria-live="polite">
      <div className="progress-bar"><i style={{ width: `${width}%` }} /></div>
      <ol>
        {run.steps.map((s, i) => (
          <li key={s} className={i < idx || run.stage === "done" ? "done" : i === idx ? "active" : ""}>
            {STEP_LABELS[s]}
            {i === idx && run.detail && <span className="muted">· {run.detail}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Result({ result }) {
  if (!result) return null;
  if (result.error) return <div className="result err" role="alert">{result.error}</div>;
  return (
    <div className={`result ${result.warn ? "warn" : "ok"}`} role="status">
      {result.message} <a href={`${EXPLORER}/tx/${result.sig}`} target="_blank" rel="noreferrer">View on Solscan</a>
    </div>
  );
}

function useRun() {
  const [run, setRun] = useState(null);
  const start = () => setRun({ steps: ["sync", "prove", "submit", "pending", "done"], stage: "sync", detail: null, sub: 0 });
  const onStage = (stage, sig) =>
    setRun((r) => {
      if (!r) return r;
      const steps = stage === "merge" && !r.steps.includes("merge") ? ["sync", "merge", ...r.steps.slice(1)] : r.steps;
      const map = { confirm: "submit", relay: "submit" };
      const detail = stage === "confirm" ? "approve in your wallet" : stage === "relay" ? "sent to relayer" : stage === "pending" ? short(sig, 6) : null;
      return { ...r, steps, stage: map[stage] ?? stage, detail, sub: 0 };
    });
  const onProgress = (p) =>
    setRun((r) => {
      if (!r) return r;
      if (p.stage === "download") {
        const pct = p.total ? Math.round((p.loaded / p.total) * 100) : 0;
        return { ...r, stage: "prove", detail: `downloading proving key ${pct}%`, sub: pct / 200 };
      }
      return { ...r, stage: "prove", detail: "about 5–20 seconds", sub: 0.5 };
    });
  return { run, setRun, start, onStage, onProgress };
}

// ------------------------------------------------------------------ shield

function ShieldForm({ client, owner, wallet, onDone }) {
  const [asset, setAsset] = useState(ASSETS[0]);
  const [denom, setDenom] = useState(null);
  const [walletBal, setWalletBal] = useState(null);
  const [result, setResult] = useState(null);
  const { run, setRun, start, onStage, onProgress } = useRun();
  const busy = run && run.stage !== "done" && !result?.error;

  useEffect(() => {
    setDenom(null);
    setWalletBal(null);
    getWalletBalance(asset, owner).then(setWalletBal).catch(() => {});
  }, [asset, owner]);

  const denoms = asset.denominations.map((d) => ({ label: d, value: parseAmount(d, asset.decimals) }));
  const chosen = denoms.find((d) => d.label === denom);
  const tooMuch = chosen && walletBal !== null && chosen.value > walletBal;

  async function submit() {
    setResult(null);
    start();
    try {
      const sig = await client.shield({ asset, amount: chosen.value, wallet, onStage, onProgress });
      setResult({ sig, message: `Shielded ${chosen.label} ${asset.symbol}. The more people deposit after you, the harder your withdrawal is to link back. The Unshield tab shows how big the crowd is.` });
      getWalletBalance(asset, owner).then(setWalletBal).catch(() => {});
      onDone();
    } catch (e) {
      setResult({ error: explainError(e) });
      setRun(null);
    }
  }

  return (
    <div>
      <div className="field">
        <span className="field-label"><span>Asset</span><span>In wallet: {walletBal === null ? "…" : fmt(walletBal, asset.decimals, 4)} {asset.symbol}</span></span>
        <AssetSelect value={asset} onChange={setAsset} />
      </div>
      <div className="field">
        <span className="field-label" id="denom-label"><span>Amount{asset.kind === "stock" ? " (shares)" : ""}</span><span>Fixed sizes only</span></span>
        <div className="denoms" role="radiogroup" aria-labelledby="denom-label">
          {denoms.map((d) => (
            <button type="button" role="radio" aria-checked={denom === d.label} key={d.label} className="denom" onClick={() => setDenom(d.label)} disabled={busy}>
              {d.label}
            </button>
          ))}
        </div>
        {tooMuch && <p className="hint err">Your wallet has less than {chosen.label} {asset.symbol}.</p>}
        {!denom && <p className="hint">Everyone shields the same sizes, which is what makes deposits indistinguishable.</p>}
        {asset.mint === NATIVE_SOL && denom && <p className="hint">Keep about 0.01 SOL extra for the fee and the two nullifier accounts (~0.002 SOL).</p>}
      </div>
      <button className="btn btn-primary btn-block" disabled={!chosen || tooMuch || busy} onClick={submit}>
        {busy ? <span className="spinner" aria-hidden="true" /> : null}
        {chosen ? `Shield ${chosen.label} ${asset.symbol}` : "Choose an amount"}
      </button>
      <Progress run={run} />
      <Result result={result} />
    </div>
  );
}

// ------------------------------------------------------------------ privacy meter

const ago = (t) => {
  if (!t) return null;
  const m = Math.max(0, Math.round((Date.now() / 1000 - t) / 60));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

/** How many people deposited the same asset after you: the crowd a withdrawal hides in. */
function PrivacyMeter({ info, asset }) {
  if (!info || info.after === null) return null;
  const n = info.after;
  const level = n === 0 ? 0 : n < 5 ? 1 : n < 20 ? 2 : 3;
  const label = ["Wait for more deposits", "Small crowd", "Good crowd", "Large crowd"][level];
  const when = ago(info.depositedAt);
  const msg =
    n === 0
      ? `You're the latest ${asset.symbol} depositor${when ? ` (${when})` : ""}. Withdrawing now could let someone link this withdrawal back to your deposit by timing alone. Waiting for others to deposit keeps it unlinkable.`
      : n < 5
        ? `${n} ${n === 1 ? "person has" : "people have"} deposited ${asset.symbol} since you${when ? ` (${when})` : ""}. Waiting for a few more makes this withdrawal much harder to link back to you.`
        : `Your withdrawal blends in with ${n} deposits made after yours${when ? ` (${when})` : ""}, ${info.total} in total.`;
  return (
    <div className={`privacy-meter lvl-${level}`} role="status">
      <div className="pm-head">
        <b>{label}</b>
        <span className="pm-bars" aria-hidden="true">{[0, 1, 2].map((i) => <i key={i} className={i < level ? "on" : ""} />)}</span>
      </div>
      <p>{msg}</p>
    </div>
  );
}

// ------------------------------------------------------------------ unshield

function UnshieldForm({ client, owner, wallet, balances, onDone }) {
  const [asset, setAsset] = useState(ASSETS[0]);
  const [amountText, setAmountText] = useState("");
  const [recipient, setRecipient] = useState("");
  // Withdrawals always go through the Vanish relayer; paying from your own wallet is only
  // offered if the relayer can't be reached.
  const [route, setRoute] = useState("relayer");
  const relayerUrl = RELAYER_URL;
  const [relayer, setRelayer] = useState(null);
  const [plan, setPlan] = useState(null);
  const [anon, setAnon] = useState(null);
  const [result, setResult] = useState(null);
  const { run, setRun, start, onStage, onProgress } = useRun();
  const busy = run && run.stage !== "done" && !result?.error;

  useEffect(() => {
    setAnon(null);
    let alive = true;
    client.anonymity(asset).then((a) => alive && setAnon(a)).catch(() => {});
    return () => { alive = false; };
  }, [client, asset, balances]);

  const bal = balances?.[asset.symbol]?.total ?? 0n;
  const amount = parseAmount(amountText, asset.decimals);
  const useRelayer = route === "relayer";
  const relayerFee = (amt) => {
    if (!relayer?.address || !amt) return 0n;
    const pct = (amt * BigInt(relayer.feeBps) + 9999n) / 10000n;
    const min = BigInt(relayer.minFees?.[asset.mint] ?? 0);
    return pct > min ? pct : min;
  };
  const fee = useRelayer && amount ? relayerFee(amount) : 0n;

  useEffect(() => {
    if (!relayerUrl) return setRelayer({ error: "No relayer is configured for this site." });
    let alive = true;
    (async () => {
      try {
        const info = await (await fetch(relayerEndpoint(relayerUrl, "/info"))).json();
        if (!alive) return;
        if (info.programId !== deployment.programId) return setRelayer({ error: "The relayer serves a different program." });
        setRelayer({ address: info.address, feeBps: info.feeBps, minFees: info.minFees ?? {}, allowFreeMerges: info.allowFreeMerges });
      } catch {
        if (alive) setRelayer({ error: "The Vanish relayer can't be reached right now." });
      }
    })();
    return () => { alive = false; };
  }, [relayerUrl]);

  useEffect(() => {
    setPlan(null);
    if (!amount || amount <= 0n) return;
    let alive = true;
    client.plan({ asset, amount, fee }).then((p) => alive && setPlan(p)).catch(() => {});
    return () => { alive = false; };
  }, [client, asset, amountText, fee, balances]);

  let recipientKey = null;
  try { recipientKey = recipient ? new PublicKey(recipient) : null; } catch { recipientKey = null; }
  const toSelf = recipientKey && recipientKey.equals(owner);
  const relayerReady = !useRelayer || (relayer && !relayer.error);
  const enough = amount && amount + fee <= bal;
  const mergeBlocked = useRelayer && plan?.merges > 0 && relayer && !relayer.allowFreeMerges;
  const canSubmit = amount && amount > 0n && enough && recipientKey && relayerReady && !mergeBlocked && !busy;

  const maxAmount = () => {
    if (!useRelayer || !relayer?.address) return bal;
    const byPct = (bal * 10000n) / (10000n + BigInt(relayer.feeBps));
    const min = BigInt(relayer.minFees?.[asset.mint] ?? 0);
    return byPct + min > bal ? (bal > min ? bal - min : 0n) : byPct;
  };

  async function submit() {
    setResult(null);
    start();
    try {
      const sig = await client.unshield({
        asset, amount, to: recipientKey, wallet: useRelayer ? null : wallet,
        relayerUrl: useRelayer ? relayerUrl : null, relayer: useRelayer ? new PublicKey(relayer.address) : null, fee,
        onStage, onProgress,
      });
      setResult({ sig, message: `Sent ${amountText} ${asset.symbol} to ${short(recipient)}.` });
      setAmountText("");
      onDone();
    } catch (e) {
      setResult({ error: explainError(e) });
      setRun(null);
    }
  }

  return (
    <div>
      <div className="field">
        <span className="field-label"><span>Asset</span><span>Private: {fmt(bal, asset.decimals, 6)} {asset.symbol}</span></span>
        <AssetSelect value={asset} onChange={(a) => { setAsset(a); setAmountText(""); }}
          right={(a) => (balances?.[a.symbol]?.total ? fmt(balances[a.symbol].total, a.decimals, 4) : "")} />
      </div>
      {bal > 0n && <PrivacyMeter info={anon} asset={asset} />}

      <div className="field">
        <label htmlFor="amt"><span>Amount</span><span>Any amount</span></label>
        <div className="input-wrap">
          <input id="amt" className="input input-lg" inputMode="decimal" placeholder="0.0" value={amountText} autoComplete="off"
            onChange={(e) => setAmountText(e.target.value)} disabled={busy} />
          <button type="button" className="btn btn-sm max" onClick={() => setAmountText(fmt(maxAmount(), asset.decimals, asset.decimals).replace(/,/g, ""))} disabled={busy || bal === 0n}>
            Max
          </button>
        </div>
        {amountText && amount === null && <p className="hint err">Enter a number with at most {asset.decimals} decimals.</p>}
        {amount && !enough && <p className="hint err">You have {fmt(bal, asset.decimals, 6)} private {asset.symbol}{fee ? " (fee included)" : ""}.</p>}
        {amount && enough && isUnusual(amountText) && <p className="hint warn">Unusual amounts are easier to trace. Round numbers blend in better.</p>}
      </div>

      <div className="field">
        <label htmlFor="to"><span>Recipient wallet</span></label>
        <input id="to" className="input" placeholder="Solana address" value={recipient} onChange={(e) => setRecipient(e.target.value.trim())} spellCheck={false} autoComplete="off" disabled={busy} />
        {recipient && !recipientKey && <p className="hint err">That isn't a valid Solana address.</p>}
        {toSelf && <p className="hint warn">This is your connected wallet. Unshielding here links the funds back to you. Use a fresh wallet.</p>}
        {recipientKey && asset.mint !== NATIVE_SOL && <p className="hint">Its {asset.symbol} token account is created automatically if it doesn't exist.</p>}
      </div>

      <div className="field">
        <span className="field-label"><span>Sent by</span></span>
        {useRelayer ? (
          <div className="relayer-card">
            <PixelIcon name="shield" size={22} />
            <div>
              <b>Vanish relayer</b>
              {relayer?.address && (
                <span>
                  Pays the network fee so your wallet never signs · {relayer.feeBps / 100}% fee, minimum {fmt(BigInt(relayer.minFees?.[asset.mint] ?? 0), asset.decimals, 6)} {asset.symbol}
                </span>
              )}
              {!relayer && <span>Connecting…</span>}
              {relayer?.error && <span className="err">{relayer.error}</span>}
            </div>
          </div>
        ) : (
          <div className="relayer-card warn">
            <PixelIcon name="warn" size={22} />
            <div>
              <b>Your wallet</b>
              <span>{short(owner)} signs and pays the fee, which links this withdrawal to it.</span>
            </div>
          </div>
        )}
        {relayer?.error && useRelayer && (
          <p className="hint">
            <button type="button" className="link-btn" onClick={() => setRoute("wallet")}>Pay the fee from my wallet instead</button> (less private)
          </p>
        )}
        {!useRelayer && (
          <p className="hint"><button type="button" className="link-btn" onClick={() => setRoute("relayer")}>Use the Vanish relayer</button></p>
        )}
        {mergeBlocked && <p className="hint err">This needs {plan.merges} note merge{plan.merges > 1 ? "s" : ""} first, which the relayer doesn't do for free. Unshield a smaller amount.</p>}
      </div>

      {amount && enough && (
        <dl className="summary">
          <div><dt>Recipient gets</dt><dd>{amountText} {asset.symbol}</dd></div>
          {fee > 0n && <div><dt>Relayer fee</dt><dd>{fmt(fee, asset.decimals, 9)} {asset.symbol}</dd></div>}
          {plan?.ok && <div><dt>Stays private as change</dt><dd>{fmt(plan.change, asset.decimals, 6)} {asset.symbol}</dd></div>}
          {plan?.merges > 0 && <div><dt>Notes to merge first</dt><dd>{plan.merges} extra transaction{plan.merges > 1 ? "s" : ""}</dd></div>}
        </dl>
      )}

      <button className="btn btn-primary btn-block" disabled={!canSubmit} onClick={submit}>
        {busy ? <span className="spinner" aria-hidden="true" /> : null}
        {amount && amount > 0n ? `Unshield ${amountText} ${asset.symbol}` : "Enter an amount"}
      </button>
      <Progress run={run} />
      <Result result={result} />
    </div>
  );
}

// ------------------------------------------------------------------ private swap (listed assets)

function SwapForm({ client, balances, onDone }) {
  const [from, setFrom] = useState(ASSETS[0]);
  const [to, setTo] = useState(ASSETS.find((a) => a.kind === "stock") ?? ASSETS[1]);
  const [amountText, setAmountText] = useState("");
  const [slippage, setSlippage] = useState(50); // the user receives exactly the minimum, so keep the gap small
  const [relayer, setRelayer] = useState(null);
  const [quote, setQuote] = useState(null);
  const [result, setResult] = useState(null);
  const { run, setRun, start, onStage, onProgress } = useRun();
  const busy = run && run.stage !== "done" && !result?.error;

  const bal = balances?.[from.symbol]?.total ?? 0n;
  const amount = parseAmount(amountText, from.decimals);

  useEffect(() => {
    if (!RELAYER_URL) return setRelayer({ error: "No relayer is configured for this site." });
    let alive = true;
    fetch(relayerEndpoint(RELAYER_URL, "/info")).then((r) => r.json()).then((info) => {
      if (!alive) return;
      if (info.programId !== deployment.programId) return setRelayer({ error: "The relayer serves a different program." });
      if (!info.swap) return setRelayer({ error: "Private swaps aren't live on this relayer yet." });
      setRelayer({ address: info.address, feeBps: info.feeBps, minFees: info.swap.minFees });
    }).catch(() => alive && setRelayer({ error: "The Vanish relayer can't be reached right now." }));
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    setQuote(null);
    if (!amount || amount <= 0n || from.symbol === to.symbol || busy || !RELAYER_URL) return;
    let alive = true;
    let failing = false;
    const load = () =>
      fetch(relayerEndpoint(RELAYER_URL, `/quote?mintIn=${from.mint}&mintOut=${to.mint}&amount=${amount}&slippageBps=${slippage}`))
        .then(async (r) => {
          const j = await r.json().catch(() => ({}));
          failing = !r.ok;
          if (!alive) return;
          // a busy price service is retried quietly; real answers (no route, bad token) are shown
          if (r.ok) setQuote(j);
          else setQuote((q) => (/busy|unavailable|timed out|50\d|429/i.test(j.error ?? "") ? (q?.outAmount ? { ...q, stale: true } : { error: "Price service busy, retrying…" }) : { error: j.error ?? "No price available" }));
        })
        .catch(() => { failing = true; if (alive) setQuote((q) => (q?.outAmount ? { ...q, stale: true } : { error: "Price service busy, retrying…" })); });
    // wait until typing stops, then refresh every 15 s (4 s while the price service is failing)
    let timer = setTimeout(function tick() {
      load().finally(() => { if (alive) timer = setTimeout(tick, failing ? 4000 : 15000); });
    }, 500);
    return () => { alive = false; clearTimeout(timer); };
  }, [from.mint, to.mint, amountText, slippage, busy]);

  const fee = (() => {
    if (!relayer?.address || !amount) return 0n;
    const pct = (amount * BigInt(relayer.feeBps) + 9999n) / 10000n;
    const min = BigInt(relayer.minFees?.[from.mint] ?? 0);
    return pct > min ? pct : min;
  })();
  const enough = amount && amount + fee <= bal;
  const out = quote?.outAmount ? fmt(BigInt(quote.outAmount), to.decimals, 6) : null;
  const minOut = quote?.minOut ? fmt(BigInt(quote.minOut), to.decimals, 6) : null;
  const canSubmit = amount > 0n && enough && from.symbol !== to.symbol && quote?.minOut && relayer?.address && !busy;
  const flip = () => { setFrom(to); setTo(from); setAmountText(""); };

  async function submit() {
    setResult(null);
    start();
    try {
      const res = await privateSwap(client, {
        assetIn: from, assetOut: to, amountIn: amount, minOut: BigInt(quote.minOut), fee,
        relayerUrl: RELAYER_URL, relayer: new PublicKey(relayer.address), onStage, onProgress,
      });
      setResult(
        res.status === "filled"
          ? { sig: res.signature, message: `Swapped ${amountText} ${from.symbol} for ${minOut} ${to.symbol}. It's in your private balance.` }
          : { sig: res.signature, warn: true, message: `The trade couldn't fill at your guaranteed minimum, so it was cancelled. Your ${amountText} ${from.symbol} is back in your private balance (only the fee was spent).` },
      );
      setAmountText("");
      onDone();
    } catch (e) {
      setResult({ error: explainError(e) });
      setRun(null);
    }
  }

  return (
    <div>
      <p className="tab-intro">Trade one private asset for another without it ever leaving the pool. No wallet of yours appears on-chain.</p>
      <div className="field">
        <span className="field-label"><span>From</span><span>Private: {fmt(bal, from.decimals, 6)} {from.symbol}</span></span>
        <AssetSelect value={from} onChange={(a) => { if (a.symbol === to.symbol) setTo(from); setFrom(a); setAmountText(""); }}
          right={(a) => (balances?.[a.symbol]?.total ? fmt(balances[a.symbol].total, a.decimals, 4) : "")} />
      </div>
      <div className="field">
        <label htmlFor="swap-amt"><span>Amount</span></label>
        <input id="swap-amt" className="input input-lg" inputMode="decimal" placeholder="0.0" value={amountText} autoComplete="off"
          onChange={(e) => setAmountText(e.target.value)} disabled={busy} />
        {amountText && amount === null && <p className="hint err">Enter a number with at most {from.decimals} decimals.</p>}
        {amount && !enough && <p className="hint err">You need {fmt(amount + fee, from.decimals, 6)} private {from.symbol} including the fee.</p>}
      </div>
      <div className="swap-flip">
        <button type="button" className="btn btn-sm" onClick={flip} disabled={busy} aria-label="Swap direction">⇅</button>
      </div>
      <div className="field">
        <span className="field-label"><span>To</span><span>Stays private</span></span>
        <AssetSelect value={to} onChange={(a) => { if (a.symbol === from.symbol) setFrom(to); setTo(a); }} />
      </div>
      <div className="field">
        <span className="field-label" id="sslip-label"><span>Max price slippage</span></span>
        <div className="denoms denoms-3" role="radiogroup" aria-labelledby="sslip-label">
          {SLIPPAGES.map((s) => (
            <button type="button" role="radio" aria-checked={slippage === s} key={s} className="denom" onClick={() => setSlippage(s)} disabled={busy}>{s / 100}%</button>
          ))}
        </div>
      </div>

      {amount > 0n && from.symbol !== to.symbol && (
        <dl className="summary">
          {/* the output notes are proven before the trade, so the user receives exactly minOut */}
          <div><dt>You receive (exactly)</dt><dd>{quote?.error ? <span className="err">{quote.error}</span> : minOut ? <b>{minOut} {to.symbol}</b> : "…"}</dd></div>
          {out && <div><dt>Route estimate</dt><dd>{out} {to.symbol}{quote?.stale ? " (refreshing…)" : ""}</dd></div>}
          {quote?.route?.length > 0 && <div><dt>Route</dt><dd>{quote.route.join(" → ")}</dd></div>}
          <div><dt>Relayer fee</dt><dd>{fmt(fee, from.decimals, 9)} {from.symbol}</dd></div>
          <div><dt>Relayer tip</dt><dd>up to {slippage / 100}% (anything the route returns above what you receive)</dd></div>
          <div><dt>If the price runs away</dt><dd>Cancelled; {amountText || "it"} {from.symbol} stays private</dd></div>
        </dl>
      )}
      {relayer?.error && <p className="hint err">{relayer.error}</p>}

      <button className="btn btn-primary btn-block" disabled={!canSubmit} onClick={submit}>
        {busy ? <span className="spinner" aria-hidden="true" /> : null}
        {amount > 0n ? `Swap ${amountText} ${from.symbol} → ${to.symbol}` : "Enter an amount"}
      </button>
      <Progress run={run} />
      <Result result={result} />
    </div>
  );
}

// ------------------------------------------------------------------ private buy

const SLIPPAGES = [50, 100, 300];
const usd = (n) => {
  const v = Number(n);
  if (v >= 1) return `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  // tiny memecoin prices: keep 3 significant digits
  return `$${v.toPrecision(3)}`;
};
const compactUsd = (n) => `$${Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(Number(n))}`;
const age = (ms) => {
  const d = (Date.now() - ms) / 86_400_000;
  if (d < 1) return `${Math.max(1, Math.round(d * 24))} h`;
  if (d < 60) return `${Math.round(d)} days`;
  return `${Math.round(d / 30)} months`;
};
const GAS = 10_000_000n; // 0.01 SOL: enough for a new wallet to sell or move its tokens later

/** A brand-new Solana wallet whose key is shown once so the user can import it into Phantom/Solflare. */
function NewWallet({ onCreate, created, saved, onSaved }) {
  if (!created) {
    return (
      <button type="button" className="link-btn" onClick={() => onCreate(SolKeypair.generate())}>
        Create a new wallet for me
      </button>
    );
  }
  const secret = bs58.encode(created.secretKey);
  const download = () => {
    const blob = new Blob([JSON.stringify(Array.from(created.secretKey))], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `vanish-wallet-${created.publicKey.toBase58().slice(0, 6)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className={`new-wallet${saved ? " saved" : ""}`}>
      <p><b>New wallet {short(created.publicKey.toBase58(), 6)}</b> exists only in this browser tab until you save its key. Import it into Phantom or Solflare (Add wallet → Import private key).</p>
      <div className="secret" aria-label="Private key">{secret}</div>
      <div className="row">
        <button type="button" className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(secret)}>Copy private key</button>
        <button type="button" className="btn btn-sm" onClick={download}>Download .json</button>
      </div>
      <label className="check">
        <input type="checkbox" checked={saved} onChange={(e) => onSaved(e.target.checked)} />
        I saved this key. Anyone with it controls the tokens; if I lose it they are gone.
      </label>
    </div>
  );
}

function BuyForm({ client, owner, balances, onDone }) {
  const [asset, setAsset] = useState(ASSETS[0]);
  const [amountText, setAmountText] = useState("");
  const [mintText, setMintText] = useState("");
  const [token, setToken] = useState(null);
  const [slippage, setSlippage] = useState(100);
  const [recipient, setRecipient] = useState("");
  const [created, setCreated] = useState(null);
  const [savedKey, setSavedKey] = useState(false);
  const [sendGas, setSendGas] = useState(true);
  const [relayer, setRelayer] = useState(null);
  const [quote, setQuote] = useState(null);
  const [anon, setAnon] = useState(null);
  const [result, setResult] = useState(null);
  const { run, setRun, start, onStage, onProgress } = useRun();
  const busy = run && run.stage !== "done" && !result?.error;

  const isSol = asset.mint === NATIVE_SOL;
  const bal = balances?.[asset.symbol]?.total ?? 0n;
  const amount = parseAmount(amountText, asset.decimals);
  const gas = isSol && sendGas ? GAS : 0n;
  let mintKey = null;
  try { mintKey = mintText ? new PublicKey(mintText) : null; } catch { mintKey = null; }
  let recipientKey = null;
  try { recipientKey = recipient ? new PublicKey(recipient) : null; } catch { recipientKey = null; }

  useEffect(() => {
    if (!RELAYER_URL) return setRelayer({ error: "No relayer is configured for this site." });
    let alive = true;
    fetch(relayerEndpoint(RELAYER_URL, "/info")).then((r) => r.json()).then((info) => {
      if (!alive) return;
      if (info.programId !== deployment.programId) return setRelayer({ error: "The relayer serves a different program." });
      if (!info.buy) return setRelayer({ error: "Private buy isn't live on this relayer yet." });
      setRelayer({ address: info.address, feeBps: info.feeBps, minFees: info.buy.minFees });
    }).catch(() => alive && setRelayer({ error: "The Vanish relayer can't be reached right now." }));
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    setAnon(null);
    let alive = true;
    client.anonymity(asset).then((a) => alive && setAnon(a)).catch(() => {});
    return () => { alive = false; };
  }, [client, asset, balances]);

  // token lookup
  useEffect(() => {
    setToken(null);
    if (!mintKey || !RELAYER_URL) return;
    let alive = true;
    const t = setTimeout(() => {
      fetch(relayerEndpoint(RELAYER_URL, `/token?mint=${mintKey.toBase58()}`)).then(async (r) => {
        const j = await r.json();
        if (alive) setToken(r.ok ? j : { error: j.error ?? "Unknown token" });
      }).catch(() => alive && setToken({ error: "Couldn't look up this token." }));
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [mintText]);

  // live quote, refreshed every 15 s while idle
  useEffect(() => {
    setQuote(null);
    if (!token?.mint || !amount || amount <= 0n || busy) return;
    let alive = true;
    let failing = false;
    const load = () =>
      fetch(relayerEndpoint(RELAYER_URL, `/quote?mintIn=${asset.mint}&mintOut=${token.mint}&amount=${amount}&slippageBps=${slippage}`))
        .then(async (r) => {
          const j = await r.json().catch(() => ({}));
          failing = !r.ok;
          if (!alive) return;
          // a busy price service is retried quietly; real answers (no route, bad token) are shown
          if (r.ok) setQuote(j);
          else setQuote((q) => (/busy|unavailable|timed out|50\d|429/i.test(j.error ?? "") ? (q?.outAmount ? { ...q, stale: true } : { error: "Price service busy, retrying…" }) : { error: j.error ?? "No price available" }));
        })
        .catch(() => { failing = true; if (alive) setQuote((q) => (q?.outAmount ? { ...q, stale: true } : { error: "Price service busy, retrying…" })); });
    // wait until typing stops, then refresh every 15 s (4 s while the price service is failing)
    let timer = setTimeout(function tick() {
      load().finally(() => { if (alive) timer = setTimeout(tick, failing ? 4000 : 15000); });
    }, 500);
    return () => { alive = false; clearTimeout(timer); };
  }, [token?.mint, amountText, asset.mint, slippage, busy]);

  const fee = (() => {
    if (!relayer?.address || !amount) return 0n;
    const spend = amount + gas;
    const pct = (spend * BigInt(relayer.feeBps) + 9999n) / 10000n;
    const min = BigInt(relayer.minFees?.[asset.mint] ?? 0);
    return pct > min ? pct : min;
  })();
  const need = amount ? amount + gas + fee : 0n;
  const enough = amount && need <= bal;
  const toSelf = recipientKey && recipientKey.equals(owner);
  const keyOk = !created || savedKey || !(recipientKey && recipientKey.equals(created.publicKey));
  const canSubmit = amount > 0n && enough && token?.mint && quote?.outAmount && recipientKey && !toSelf && keyOk && relayer?.address && !busy;
  const out = token?.decimals !== undefined && quote?.outAmount ? fmt(BigInt(quote.outAmount), token.decimals, 4) : null;
  const minOut = token?.decimals !== undefined && quote?.minOut ? fmt(BigInt(quote.minOut), token.decimals, 4) : null;
  const sym = token?.symbol ?? "tokens";

  async function submit() {
    setResult(null);
    start();
    try {
      const res = await privateBuy(client, {
        assetIn: asset, amountIn: amount, gas, fee, mintOut: token.mint, minOut: BigInt(quote.minOut), destination: recipientKey,
        relayerUrl: RELAYER_URL, relayer: new PublicKey(relayer.address), onStage, onProgress,
      });
      setResult(
        res.status === "filled"
          ? { sig: res.signature, message: `Bought about ${out} ${sym} with ${amountText} ${asset.symbol}, delivered to ${short(recipient)}.` }
          : { sig: res.signature, warn: true, message: `The buy couldn't fill at your guaranteed minimum, so nothing was bought. Your ${amountText} ${asset.symbol} went to ${short(recipient)} instead, still unlinked to you.` },
      );
      setAmountText("");
      onDone();
    } catch (e) {
      setResult({ error: explainError(e) });
      setRun(null);
    }
  }

  return (
    <div>
      <p className="tab-intro">Spend private funds on any token Jupiter can trade (pump.fun included). It arrives in a fresh wallet that has no link to yours.</p>
      <div className="field">
        <span className="field-label"><span>Pay with</span><span>Private: {fmt(bal, asset.decimals, 6)} {asset.symbol}</span></span>
        <AssetSelect value={asset} onChange={(a) => { setAsset(a); setAmountText(""); }}
          right={(a) => (balances?.[a.symbol]?.total ? fmt(balances[a.symbol].total, a.decimals, 4) : "")} />
      </div>
      {bal > 0n && <PrivacyMeter info={anon} asset={asset} />}

      <div className="field">
        <label htmlFor="buy-amt"><span>Spend</span></label>
        <input id="buy-amt" className="input input-lg" inputMode="decimal" placeholder="0.0" value={amountText} autoComplete="off"
          onChange={(e) => setAmountText(e.target.value)} disabled={busy} />
        {amountText && amount === null && <p className="hint err">Enter a number with at most {asset.decimals} decimals.</p>}
        {amount && !enough && <p className="hint err">You need {fmt(need, asset.decimals, 6)} private {asset.symbol} including the fee{gas ? " and gas" : ""}.</p>}
      </div>

      <div className="field">
        <label htmlFor="buy-mint"><span>Token to buy</span><span>Paste the mint address</span></label>
        <input id="buy-mint" className="input" placeholder="e.g. …pump" value={mintText} onChange={(e) => setMintText(e.target.value.trim())} spellCheck={false} autoComplete="off" disabled={busy} />
        {mintText && !mintKey && <p className="hint err">That isn't a valid address.</p>}
        {token?.error && <p className="hint err">{token.error}</p>}
        {mintKey && !token && <p className="hint">Looking up token…</p>}
        {token?.mint && (
          <div className="token-card">
            {token.banner && <img className="token-banner" src={token.banner} alt="" loading="lazy" />}
            <div className="token-head">
              {token.icon ? <img className="token-logo" src={token.icon} alt="" width="48" height="48" /> : <span className="token-ph" aria-hidden="true">?</span>}
              <div className="token-id">
                <b>{token.symbol ?? short(token.mint, 6)}</b>
                <span className="sub">{token.name ?? "Unknown name"}{token.launchpad ? ` · ${token.launchpad}` : ""}{token.verified ? " · verified" : ""}</span>
              </div>
              <div className="token-price">
                <b>{token.usdPrice ? usd(token.usdPrice) : "no price"}</b>
                {token.change24h !== null && token.change24h !== undefined && (
                  <span className={token.change24h >= 0 ? "up" : "down"}>{token.change24h >= 0 ? "+" : ""}{token.change24h.toFixed(1)}% 24h</span>
                )}
              </div>
            </div>
            <dl className="token-stats">
              <div><dt>Market cap</dt><dd>{token.marketCap ? compactUsd(token.marketCap) : "–"}</dd></div>
              <div><dt>Liquidity</dt><dd>{token.liquidityUsd ? compactUsd(token.liquidityUsd) : "–"}</dd></div>
              <div><dt>Pair age</dt><dd>{token.pairCreatedAt ? age(token.pairCreatedAt) : "–"}</dd></div>
            </dl>
            {token.dexscreener && <a className="token-link" href={token.dexscreener} target="_blank" rel="noreferrer">View chart on DexScreener ↗</a>}
          </div>
        )}
        {token?.mint && token.liquidityUsd !== null && token.liquidityUsd < 10000 && (
          <p className="hint warn">Very low liquidity ({compactUsd(token.liquidityUsd)}). Even a small buy can move the price a lot, and selling later may be hard.</p>
        )}
        {token?.mint && !token.verified && <p className="hint warn">Anyone can create a token with any name or picture. Check the mint address matches the one you meant.</p>}
      </div>

      <div className="field">
        <span className="field-label" id="slip-label"><span>Max price slippage</span></span>
        <div className="denoms denoms-3" role="radiogroup" aria-labelledby="slip-label">
          {SLIPPAGES.map((s) => (
            <button type="button" role="radio" aria-checked={slippage === s} key={s} className="denom" onClick={() => setSlippage(s)} disabled={busy}>{s / 100}%</button>
          ))}
        </div>
      </div>

      <div className="field">
        <label htmlFor="buy-to"><span>Deliver to</span><span>A wallet you have never used</span></label>
        <input id="buy-to" className="input" placeholder="New Solana address" value={recipient}
          onChange={(e) => { setRecipient(e.target.value.trim()); }} spellCheck={false} autoComplete="off" disabled={busy} />
        {recipient && !recipientKey && <p className="hint err">That isn't a valid Solana address.</p>}
        {toSelf && <p className="hint err">That's your connected wallet, which would link the buy straight back to you.</p>}
        <div className="hint">
          <NewWallet created={created} saved={savedKey} onSaved={setSavedKey}
            onCreate={(kp) => { setCreated(kp); setSavedKey(false); setRecipient(kp.publicKey.toBase58()); }} />
        </div>
        {isSol && (
          <label className="check">
            <input type="checkbox" checked={sendGas} onChange={(e) => setSendGas(e.target.checked)} disabled={busy} />
            Also send 0.01 SOL so the new wallet can pay fees later (without funding it from a wallet that links to you)
          </label>
        )}
      </div>

      {amount > 0n && token?.mint && (
        <dl className="summary">
          <div><dt>You get (estimate)</dt><dd>{quote?.error ? <span className="err">{quote.error}</span> : out ? `${out} ${sym}` : "…"}</dd></div>
          {minOut && <div><dt>Guaranteed at least</dt><dd>{minOut} {sym}</dd></div>}
          {quote?.route?.length > 0 && <div><dt>Route</dt><dd>{quote.route.join(" → ")}</dd></div>}
          {gas > 0n && <div><dt>Gas for the new wallet</dt><dd>0.01 SOL</dd></div>}
          <div><dt>Relayer fee</dt><dd>{fmt(fee, asset.decimals, 9)} {asset.symbol}</dd></div>
          <div><dt>If the price runs away</dt><dd>{amountText} {asset.symbol} goes to the new wallet instead</dd></div>
        </dl>
      )}
      {relayer?.error && <p className="hint err">{relayer.error}</p>}

      <button className="btn btn-primary btn-block" disabled={!canSubmit} onClick={submit}>
        {busy ? <span className="spinner" aria-hidden="true" /> : null}
        {token?.mint && amount ? `Buy ${sym} privately` : "Enter an amount and a token"}
      </button>
      <Progress run={run} />
      <Result result={result} />
    </div>
  );
}

// ------------------------------------------------------------------ activity + settings

function Activity({ notes }) {
  if (!notes) return <p className="muted">Reading your notes…</p>;
  if (!notes.length) return <p className="muted">No notes yet. Shield something to create your first private note.</p>;
  return (
    <ul className="notes">
      {[...notes].reverse().map(({ utxo, mint, spent }) => {
        const a = ASSETS.find((x) => x.mint === mint);
        return (
          <li key={utxo.index}>
            {a ? <AssetIcon asset={a} small /> : <span />}
            <span><b className="mono">{a ? fmt(utxo.amount, a.decimals, 6) : utxo.amount.toString()} {a?.symbol}</b> <span className="muted">· note #{utxo.index}</span></span>
            <span className={`tag-s ${spent ? "" : "live"}`}>{spent ? "spent" : "unspent"}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Settings({ onReset }) {
  const [rpc, setRpcText] = useState(getRpc());
  const [saved, setSaved] = useState(false);
  return (
    <div>
      <div className="field">
        <label htmlFor="rpc"><span>RPC endpoint</span><span>public RPC is rate limited</span></label>
        <input id="rpc" className="input" value={rpc} onChange={(e) => { setRpcText(e.target.value.trim()); setSaved(false); }} spellCheck={false} />
        <p className="hint">Use your own (Helius, Triton, QuickNode…) for faster syncing. It only sees public data.</p>
      </div>
      <button className="btn btn-ghost btn-sm" onClick={() => { setRpc(rpc); setSaved(true); }}>Save RPC</button>{" "}
      {saved && <span className="muted">Saved. Reload the page to use it.</span>}
      <div className="field" style={{ marginTop: 28 }}>
        <span className="field-label"><span>Local cache</span></span>
        <p className="hint" style={{ marginTop: 0 }}>Your browser keeps a copy of the pool's tree and your notes. Reset it if balances look wrong.</p>
      </div>
      <button className="btn btn-ghost btn-sm" onClick={onReset}>Reset local cache</button>
    </div>
  );
}

// ------------------------------------------------------------------ page

export default function AppPage() {
  const [wallets, setWallets] = useState(listWallets);
  const [active, setActive] = useState(null); // the normalized wallet the user connected
  const [owner, setOwner] = useState(null);
  const [client, setClient] = useState(null);
  const [balances, setBalances] = useState(null);
  const [notes, setNotes] = useState(null);
  const [tab, setTab] = useState("shield");
  const [gateError, setGateError] = useState(null);
  const [gateBusy, setGateBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState("");
  const [syncError, setSyncError] = useState(null);
  const [keyReady, setKeyReady] = useState(null);

  // only re-render when the set of wallets actually changes
  useEffect(() => watchWallets(() => setWallets((prev) => {
    const next = listWallets();
    return next.map((w) => w.name).join("|") === prev.map((w) => w.name).join("|") ? prev : next;
  })), []);
  // shape the SDK expects
  const wallet = active && owner ? { publicKey: owner, signTransaction: (tx) => active.signTransaction(tx) } : null;

  async function guard(fn) {
    setGateError(null);
    setGateBusy(true);
    try { await fn(); } catch (e) { setGateError(explainError(e)); } finally { setGateBusy(false); }
  }

  const connect = (w) => guard(async () => {
    const pk = await w.connect();
    setActive(w);
    setOwner(pk);
    const saved = ss.get(sessionKey(pk.toBase58()));
    if (saved) setClient(await makeClient(new Keypair(BigInt(saved))));
  });

  const unlockWith = async (kp) => {
    ss.set(sessionKey(owner.toBase58()), kp.toString());
    setClient(await makeClient(kp));
  };
  const unlock = () => guard(async () => unlockWith(await keypairFromWallet(active)));
  const importKey = () => guard(async () => {
    let t = importText.trim();
    try { t = JSON.parse(t).privkey ?? t; } catch {}
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(t)) throw new Error("Paste the privkey value from .solmix/wallet.json (0x…).");
    await unlockWith(new Keypair(BigInt(t)));
  });

  const reload = useCallback(async () => {
    if (!client) return;
    try {
      setSyncError(null);
      const [b, n] = await Promise.all([client.getBalances(), client.getNotes()]);
      setBalances(b);
      setNotes(n);
    } catch (e) {
      setSyncError(explainError(e));
    }
  }, [client]);

  useEffect(() => {
    if (!client) return;
    reload();
    preloadProver((p) => p.stage === "download" && p.total && setKeyReady(Math.round((p.loaded / p.total) * 100))).then(() => setKeyReady(100));
  }, [client, reload]);

  const lock = () => {
    if (owner) ss.del(sessionKey(owner.toBase58()));
    setClient(null);
    setBalances(null);
    setNotes(null);
  };
  const resetCache = async () => {
    client.resetCache();
    setBalances(null);
    setNotes(null);
    await reload();
  };

  let gate = null;
  if (!deployment.deployed) {
    gate = (
      <div className="panel gate">
        <PixelIcon name="clock" size={36} />
        <h2>Launching soon</h2>
        <p>The Vanish program isn't on Solana mainnet yet. This page goes live as soon as it's deployed.</p>
      </div>
    );
  } else if (!owner) {
    gate = (
      <div className="panel gate">
        <PixelIcon name="key" size={36} />
        <h2>Connect a wallet</h2>
        {wallets.length ? (
          <>
            <p>Connect the wallet you'll shield from. Your private balance is tied to it, and you can reopen it on any device.</p>
            <div className="wallet-list">
              {wallets.map((w) => (
                <button key={w.name} className="wallet-btn" onClick={() => connect(w)} disabled={gateBusy}>
                  {w.icon ? <img src={w.icon} alt="" /> : <span className="wallet-dot" aria-hidden="true" />}
                  {walletLabel(w)}
                </button>
              ))}
            </div>
          </>
        ) : isMobileBrowser() ? (
          <>
            <p>Open Vanish inside your wallet app's browser to connect. Your wallet then works here just like on desktop.</p>
            <div className="wallet-list">
              {openInWalletLinks().map(([name, url]) => (
                <a key={name} className="wallet-btn" href={url}>Open in {name}</a>
              ))}
            </div>
          </>
        ) : (
          <>
            <p>No Solana wallet found in this browser. Install one, then reload this page.</p>
            <div className="wallet-list">
              {INSTALL_LINKS.map(([name, url]) => (
                <a key={name} className="wallet-btn" href={url} target="_blank" rel="noreferrer">Get {name}</a>
              ))}
            </div>
          </>
        )}
        {wallets.length > 0 && isMobileBrowser() && (
          <p className="small">
            Prefer the wallet's own browser?{" "}
            {openInWalletLinks().map(([name, url], i) => (
              <span key={name}>{i > 0 && " · "}<a href={url}>Open in {name}</a></span>
            ))}
          </p>
        )}
        {gateError && <p className="hint err">{gateError}</p>}
      </div>
    );
  } else if (!client) {
    gate = (
      <div className="panel gate">
        <PixelIcon name="lock" size={36} />
        <h2>Unlock your private balance</h2>
        <p>Sign one message to derive your private key. It stays in this browser, costs nothing, and the same wallet gives you the same key anywhere.</p>
        <button className="btn btn-primary" onClick={unlock} disabled={gateBusy}>
          {gateBusy && <span className="spinner" aria-hidden="true" />}Sign to unlock
        </button>
        {gateError && <p className="hint err">{gateError}</p>}
        <p className="small">
          Used the command line? <button className="link-btn" onClick={() => setImporting((v) => !v)}>Use a key file instead</button>
        </p>
        {importing && (
          <div className="import-box">
            <textarea value={importText} onChange={(e) => setImportText(e.target.value)} placeholder='{"privkey": "0x…"}' spellCheck={false} aria-label="Key file contents" />
            <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={importKey} disabled={!importText.trim()}>Unlock with key</button>
          </div>
        )}
      </div>
    );
  }

  const shieldedCount = balances ? Object.values(balances).filter((b) => b.total > 0n).length : 0;

  return (
    <main className="app">
      <div className="wrap">
        <div className="app-title">
          <div>
            <div className="eyebrow">Solana mainnet</div>
            <h1>Private balance</h1>
          </div>
          {owner && <span className="mono muted">{short(owner, 6)}</span>}
        </div>

        {gate ?? (
          <div className="app-grid">
            <section className="panel" aria-labelledby="bal-h">
              <div className="panel-head">
                <h2 id="bal-h">Shielded</h2>
                <button className="link-btn" onClick={reload}>Refresh</button>
              </div>
              {syncError && <p className="hint err">{syncError} <button className="link-btn" onClick={resetCache}>Reset local cache</button></p>}
              {!balances && !syncError && <p className="muted">Scanning the pool for your notes…</p>}
              {balances && shieldedCount === 0 && <p className="muted">Nothing shielded yet. Pick an asset and a size to start.</p>}
              {balances && shieldedCount > 0 && (
                <ul className="balances">
                  {ASSETS.filter((a) => balances[a.symbol]?.total > 0n).map((a) => (
                    <li key={a.symbol}>
                      <AssetIcon asset={a} />
                      <div><b>{a.symbol}</b><div className="muted" style={{ fontSize: 13.5 }}>{assetLabel(a)}</div></div>
                      <span className="amt">{fmt(balances[a.symbol].total, a.decimals, 6)}<small>{balances[a.symbol].notes} note{balances[a.symbol].notes === 1 ? "" : "s"}</small></span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="key-row">
                <span>Key <span className="mono">0x{client.keypair.pubkey.toString(16).slice(0, 8)}…</span></span>
                <span>· Proving key {keyReady === 100 ? "ready" : keyReady == null ? "loading" : `${keyReady}%`}</span>
                <button className="link-btn" onClick={lock} style={{ marginLeft: "auto" }}>Lock</button>
              </div>
            </section>

            <section className="panel" aria-label="Actions">
              <div className="tabs" role="tablist">
                {[["shield", "Shield"], ["unshield", "Unshield"], ["swap", "Swap"], ["buy", "Buy"], ["activity", "Activity"], ["settings", "Settings"]].map(([id, label]) => (
                  <button key={id} role="tab" aria-selected={tab === id} className="tab" onClick={() => setTab(id)}>{label}</button>
                ))}
              </div>
              {tab === "shield" && <ShieldForm client={client} owner={owner} wallet={wallet} onDone={reload} />}
              {tab === "unshield" && <UnshieldForm client={client} owner={owner} wallet={wallet} balances={balances} onDone={reload} />}
              {tab === "swap" && <SwapForm client={client} balances={balances} onDone={reload} />}
              {tab === "buy" && <BuyForm client={client} owner={owner} balances={balances} onDone={reload} />}
              {tab === "activity" && <Activity notes={notes} />}
              {tab === "settings" && <Settings onReset={resetCache} />}
            </section>
          </div>
        )}
      </div>
    </main>
  );
}
