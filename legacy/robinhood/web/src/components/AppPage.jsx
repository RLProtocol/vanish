import { useCallback, useEffect, useRef, useState } from "react";
import { ZeroAddress, isAddress, getAddress } from "ethers";
import { ASSETS, CHAIN_ID, EXPLORER, KEY_MESSAGE, RobinMixClient, getWalletBalance, keypairFromSignature } from "../lib/client.js";
import { Keypair, toHex32 } from "../lib/crypto.js";
import { preloadProver } from "../lib/transaction.js";
import { connectWallet, currentChainId, explainError, getSigner, hasWallet, onWalletChange, switchToRobinhoodChain } from "../lib/wallet.js";
import { fmt, isUnusual, parseAmount, short } from "../lib/format.js";
import { AssetIcon } from "./shared.jsx";
import { PixelIcon } from "./art.jsx";

const sessionKey = (addr) => `robinmix:session:${addr.toLowerCase()}`;
const ss = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} },
  del: (k) => { try { sessionStorage.removeItem(k); } catch {} },
};

// ------------------------------------------------------------------ wallet + key state

function useWallet() {
  const [address, setAddress] = useState(null);
  const [chainOk, setChainOk] = useState(true);
  const refresh = useCallback(async () => {
    if (!hasWallet()) return;
    const accounts = await window.ethereum.request({ method: "eth_accounts" });
    setAddress(accounts[0] ? getAddress(accounts[0]) : null);
    setChainOk((await currentChainId()) === CHAIN_ID);
  }, []);
  useEffect(() => {
    refresh();
    return onWalletChange(refresh);
  }, [refresh]);
  return { address, chainOk, refresh };
}

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
        <span><b>{value.symbol}</b> <span className="muted">{value.name}</span></span>
        <span className="caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="asset-menu" role="listbox" aria-label="Choose asset">
          {ASSETS.map((a) => (
            <button type="button" role="option" aria-selected={a.symbol === value.symbol} key={a.symbol} className="asset-option"
              onClick={() => { onChange(a); setOpen(false); }}>
              <AssetIcon asset={a} small />
              <span><b>{a.symbol}</b> <span className="sub">{a.name}</span></span>
              {right && <span className="right">{right(a)}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const STEP_LABELS = {
  sync: "Read the pool",
  approve: "Approve token",
  merge: "Merge notes",
  prove: "Generate proof",
  submit: "Send transaction",
  pending: "Wait for block",
  done: "Done",
};

function Progress({ run }) {
  if (!run) return null;
  const steps = run.steps;
  const idx = steps.indexOf(run.stage);
  const width = run.stage === "done" ? 100 : Math.max(6, ((idx + (run.sub ?? 0)) / (steps.length - 1)) * 100);
  return (
    <div className="progress" aria-live="polite">
      <div className="progress-bar"><i style={{ width: `${width}%` }} /></div>
      <ol>
        {steps.map((s, i) => (
          <li key={s} className={i < idx || run.stage === "done" ? "done" : i === idx ? "active" : ""}>
            {STEP_LABELS[s]}
            {i === idx && s === "prove" && run.detail && <span className="muted">· {run.detail}</span>}
            {i === idx && s === "submit" && run.detail && <span className="muted">· {run.detail}</span>}
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
    <div className="result ok" role="status">
      {result.message}{" "}
      <a href={`${EXPLORER}/tx/${result.hash}`} target="_blank" rel="noreferrer">View transaction</a>
    </div>
  );
}

/** Maps client stage callbacks onto the progress list. */
function useRun() {
  const [run, setRun] = useState(null);
  const start = (steps) => setRun({ steps, stage: steps[0], detail: null, sub: 0 });
  const onStage = (stage, hash) => {
    setRun((r) => {
      if (!r) return r;
      let steps = r.steps;
      if (stage === "approve" && !steps.includes("approve")) steps = ["sync", "approve", ...steps.slice(1)];
      if (stage === "merge" && !steps.includes("merge")) steps = ["sync", "merge", ...steps.slice(1)];
      const map = { confirm: "submit", relay: "submit" };
      const detail = stage === "confirm" ? "confirm in your wallet" : stage === "relay" ? "sent to relayer" : stage === "pending" ? short(hash, 6) : null;
      return { ...r, steps, stage: map[stage] ?? stage, detail, sub: 0 };
    });
  };
  const onProgress = (p) => {
    setRun((r) => {
      if (!r) return r;
      if (p.stage === "download") {
        const pct = p.total ? Math.round((p.loaded / p.total) * 100) : 0;
        return { ...r, stage: "prove", detail: `downloading proving key ${pct}%`, sub: pct / 200 };
      }
      return { ...r, stage: "prove", detail: "about 5–20 seconds", sub: 0.5 };
    });
  };
  return { run, setRun, start, onStage, onProgress };
}

// ------------------------------------------------------------------ shield

function ShieldForm({ client, address, onDone }) {
  const [asset, setAsset] = useState(ASSETS[0]);
  const [denom, setDenom] = useState(null);
  const [walletBal, setWalletBal] = useState(null);
  const [result, setResult] = useState(null);
  const { run, setRun, start, onStage, onProgress } = useRun();
  const busy = run && run.stage !== "done" && !result?.error;

  useEffect(() => {
    setDenom(null);
    setWalletBal(null);
    getWalletBalance(asset, address).then(setWalletBal).catch(() => {});
  }, [asset, address]);

  const denoms = asset.denominations.map((d) => ({ label: d, value: parseAmount(d, asset.decimals) }));
  const chosen = denoms.find((d) => d.label === denom);
  const tooMuch = chosen && walletBal !== null && chosen.value > walletBal;

  async function submit() {
    setResult(null);
    start(["sync", "prove", "submit", "pending", "done"]);
    try {
      const signer = await getSigner();
      const r = await client.shield({ asset, amount: chosen.value, signer, onStage, onProgress });
      setResult({ hash: r.hash, message: `Shielded ${chosen.label} ${asset.symbol}.` });
      getWalletBalance(asset, address).then(setWalletBal).catch(() => {});
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
        <span className="field-label" id="denom-label"><span>Amount{asset.kind === "STOCK" ? " (shares)" : ""}</span><span>Fixed sizes only</span></span>
        <div className="denoms" role="radiogroup" aria-labelledby="denom-label">
          {denoms.map((d) => (
            <button type="button" role="radio" aria-checked={denom === d.label} key={d.label} className="denom" onClick={() => setDenom(d.label)} disabled={busy}>
              {d.label}
            </button>
          ))}
        </div>
        {tooMuch && <p className="hint err">Your wallet has less than {chosen.label} {asset.symbol}.</p>}
        {!denom && <p className="hint">Everyone shields the same sizes, which is what makes deposits indistinguishable.</p>}
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

// ------------------------------------------------------------------ unshield

function UnshieldForm({ client, address, balances, onDone }) {
  const [asset, setAsset] = useState(ASSETS[0]);
  const [amountText, setAmountText] = useState("");
  const [recipient, setRecipient] = useState("");
  const [route, setRoute] = useState("relayer");
  const [relayerUrl, setRelayerUrl] = useState(() => { try { return localStorage.getItem("robinmix:relayer") || ""; } catch { return ""; } });
  const [relayer, setRelayer] = useState(null); // {address, feeBps} | {error}
  const [plan, setPlan] = useState(null);
  const [result, setResult] = useState(null);
  const { run, setRun, start, onStage, onProgress } = useRun();
  const busy = run && run.stage !== "done" && !result?.error;

  const bal = balances?.[asset.symbol]?.total ?? 0n;
  const amount = parseAmount(amountText, asset.decimals);
  const useRelayer = route === "relayer";
  const fee = useRelayer && relayer?.feeBps != null && amount ? (amount * BigInt(relayer.feeBps) + 9999n) / 10000n : 0n;

  useEffect(() => {
    if (!useRelayer || !relayerUrl) return setRelayer(null);
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const info = await (await fetch(new URL("/info", relayerUrl))).json();
        if (!alive) return;
        if (info.chainId !== CHAIN_ID) return setRelayer({ error: "This relayer serves a different chain." });
        setRelayer({ address: info.address, feeBps: info.feeBps });
        try { localStorage.setItem("robinmix:relayer", relayerUrl); } catch {}
      } catch {
        if (alive) setRelayer({ error: "Can't reach this relayer." });
      }
    }, 400);
    return () => { alive = false; clearTimeout(t); };
  }, [relayerUrl, useRelayer]);

  useEffect(() => {
    setPlan(null);
    if (!amount || amount <= 0n) return;
    let alive = true;
    client.plan({ asset, amount, fee }).then((p) => alive && setPlan(p)).catch(() => {});
    return () => { alive = false; };
  }, [client, asset, amountText, fee, balances]);

  const recipientOk = isAddress(recipient);
  const toSelf = recipientOk && address && getAddress(recipient) === address;
  const relayerReady = !useRelayer || (relayer && !relayer.error);
  const enough = amount && amount + fee <= bal;
  const canSubmit = amount && amount > 0n && enough && recipientOk && relayerReady && !busy;

  const maxAmount = () => {
    if (!useRelayer || !relayer?.feeBps) return bal;
    return (bal * 10000n) / (10000n + BigInt(relayer.feeBps));
  };

  async function submit() {
    setResult(null);
    start(["sync", "prove", "submit", "pending", "done"]);
    try {
      const signer = useRelayer ? null : await getSigner();
      const r = await client.unshield({
        asset, amount, recipient: getAddress(recipient), signer,
        relayerUrl: useRelayer ? relayerUrl : null, relayer: useRelayer ? relayer.address : ZeroAddress, fee,
        onStage, onProgress,
      });
      setResult({ hash: r.hash, message: `Sent ${amountText} ${asset.symbol} to ${short(recipient)}.` });
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
          right={(a) => balances?.[a.symbol]?.total ? fmt(balances[a.symbol].total, a.decimals, 4) : ""} />
      </div>

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
        <label htmlFor="to"><span>Recipient address</span></label>
        <input id="to" className="input" placeholder="0x…" value={recipient} onChange={(e) => setRecipient(e.target.value.trim())} spellCheck={false} autoComplete="off" disabled={busy} />
        {recipient && !recipientOk && <p className="hint err">That isn't a valid address.</p>}
        {toSelf && <p className="hint warn">This is your connected wallet. Unshielding here links the funds back to you. Use a fresh address.</p>}
      </div>

      <div className="field">
        <span className="field-label" id="route-label"><span>Who pays gas</span></span>
        <div className="route" role="radiogroup" aria-labelledby="route-label">
          <button type="button" role="radio" aria-checked={useRelayer} className="route-opt" onClick={() => setRoute("relayer")} disabled={busy}>
            <b>A relayer</b><span>Your wallet never appears. Costs a small fee.</span>
          </button>
          <button type="button" role="radio" aria-checked={!useRelayer} className="route-opt" onClick={() => setRoute("wallet")} disabled={busy}>
            <b>My wallet</b><span>No fee, but {short(address)} is shown as the sender.</span>
          </button>
        </div>
        {useRelayer && (
          <div style={{ marginTop: 10 }}>
            <input className="input" placeholder="Relayer URL, e.g. https://relayer.example.com" value={relayerUrl}
              onChange={(e) => setRelayerUrl(e.target.value.trim())} spellCheck={false} aria-label="Relayer URL" disabled={busy} />
            {relayer?.error && <p className="hint err">{relayer.error}</p>}
            {relayer?.address && <p className="hint">Relayer {short(relayer.address)} · fee {relayer.feeBps / 100}%</p>}
            {!relayerUrl && <p className="hint">Run your own with <span className="mono">npm run relayer</span>, or paste a relayer you trust.</p>}
          </div>
        )}
      </div>

      {amount && enough && (
        <dl className="summary">
          <div><dt>Recipient gets</dt><dd>{amountText} {asset.symbol}</dd></div>
          {fee > 0n && <div><dt>Relayer fee</dt><dd>{fmt(fee, asset.decimals, 8)} {asset.symbol}</dd></div>}
          {plan?.ok && <div><dt>Stays private as change</dt><dd>{fmt(plan.change, asset.decimals, 6)} {asset.symbol}</dd></div>}
          {plan?.merges > 0 && <div><dt>Notes to merge first</dt><dd>{plan.merges} extra proof{plan.merges > 1 ? "s" : ""}</dd></div>}
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

// ------------------------------------------------------------------ activity

function Activity({ notes }) {
  if (!notes) return <p className="muted">Reading your notes…</p>;
  if (!notes.length) return <p className="muted">No notes yet. Shield something to create your first private note.</p>;
  const bySymbol = Object.fromEntries(ASSETS.map((a) => [BigInt(a.address).toString(), a]));
  return (
    <ul className="notes">
      {[...notes].reverse().map(({ utxo, spent }) => {
        const a = bySymbol[utxo.assetId.toString()];
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

// ------------------------------------------------------------------ page

export default function AppPage() {
  const { address, chainOk, refresh } = useWallet();
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

  // restore an unlocked key for this tab session
  useEffect(() => {
    setClient(null);
    setBalances(null);
    setNotes(null);
    if (!address) return;
    const saved = ss.get(sessionKey(address));
    if (saved) setClient(new RobinMixClient(new Keypair(BigInt(saved))));
  }, [address]);

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

  const unlockWith = (kp) => {
    ss.set(sessionKey(address), "0x" + kp.privkey.toString(16));
    setClient(new RobinMixClient(kp));
  };

  async function guard(fn) {
    setGateError(null);
    setGateBusy(true);
    try { await fn(); } catch (e) { setGateError(explainError(e)); } finally { setGateBusy(false); refresh(); }
  }

  const unlock = () => guard(async () => {
    const signer = await getSigner();
    unlockWith(keypairFromSignature(await signer.signMessage(KEY_MESSAGE)));
  });

  const importKey = () => guard(async () => {
    let t = importText.trim();
    try { t = JSON.parse(t).privkey ?? t; } catch {}
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(t)) throw new Error("Paste the privkey value from .robinmix/wallet.json (0x…).");
    unlockWith(new Keypair(BigInt(t)));
  });

  const lock = () => {
    if (address) ss.del(sessionKey(address));
    setClient(null);
  };

  const resetCache = async () => {
    client.resetCache();
    setBalances(null);
    setNotes(null);
    await reload();
  };

  let gate = null;
  if (!hasWallet()) {
    gate = (
      <div className="panel gate">
        <PixelIcon name="key" size={36} />
        <h2>Connect a wallet</h2>
        <p>RobinMix needs a browser wallet such as MetaMask or Rabby to sign and send transactions on Robinhood Chain.</p>
      </div>
    );
  } else if (!address) {
    gate = (
      <div className="panel gate">
        <PixelIcon name="key" size={36} />
        <h2>Connect a wallet</h2>
        <p>Connect the wallet you'll shield from. Your private balance is tied to it, and you can reopen it on any device.</p>
        <button className="btn btn-primary" onClick={() => guard(connectWallet)} disabled={gateBusy}>Connect wallet</button>
        {gateError && <p className="hint err">{gateError}</p>}
      </div>
    );
  } else if (!chainOk) {
    gate = (
      <div className="panel gate">
        <PixelIcon name="globe" size={40} />
        <h2>Switch to Robinhood Chain</h2>
        <p>Your wallet is on another network. RobinMix runs on Robinhood Chain (chain ID {CHAIN_ID}).</p>
        <button className="btn btn-primary" onClick={() => guard(switchToRobinhoodChain)} disabled={gateBusy}>Switch network</button>
        {gateError && <p className="hint err">{gateError}</p>}
      </div>
    );
  } else if (!client) {
    gate = (
      <div className="panel gate">
        <PixelIcon name="lock" size={36} />
        <h2>Unlock your private balance</h2>
        <p>Sign one message to derive your private key. It stays in this browser, costs no gas, and the same wallet gives you the same key anywhere.</p>
        <button className="btn btn-primary" onClick={unlock} disabled={gateBusy}>
          {gateBusy && <span className="spinner" aria-hidden="true" />}Sign to unlock
        </button>
        {gateError && <p className="hint err">{gateError}</p>}
        <p className="small">
          Used the command line?{" "}
          <button className="link-btn" onClick={() => setImporting((v) => !v)}>Use a key file instead</button>
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
            <div className="eyebrow">Robinhood Chain · {CHAIN_ID}</div>
            <h1>Private balance</h1>
          </div>
          {address && <span className="mono muted">{short(address, 6)}</span>}
        </div>

        {gate ?? (
          <div className="app-grid">
            <section className="panel" aria-labelledby="bal-h">
              <div className="panel-head">
                <h2 id="bal-h">Shielded</h2>
                <button className="link-btn" onClick={reload}>Refresh</button>
              </div>
              {syncError && (
                <p className="hint err">
                  {syncError} <button className="link-btn" onClick={resetCache}>Reset local cache</button>
                </p>
              )}
              {!balances && !syncError && <p className="muted">Scanning the pool for your notes…</p>}
              {balances && shieldedCount === 0 && <p className="muted">Nothing shielded yet. Pick an asset and a size to start.</p>}
              {balances && shieldedCount > 0 && (
                <ul className="balances">
                  {ASSETS.filter((a) => balances[a.symbol].total > 0n).map((a) => (
                    <li key={a.symbol}>
                      <AssetIcon asset={a} />
                      <div><b>{a.symbol}</b><div className="muted" style={{ fontSize: 13.5 }}>{a.name}</div></div>
                      <span className="amt">{fmt(balances[a.symbol].total, a.decimals, 6)}<small>{balances[a.symbol].notes} note{balances[a.symbol].notes === 1 ? "" : "s"}</small></span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="key-row">
                <span>Key <span className="mono">{toHex32(client.keypair.pubkey).slice(0, 10)}…</span></span>
                <span>· Proving key {keyReady === 100 ? "ready" : keyReady == null ? "loading" : `${keyReady}%`}</span>
                <button className="link-btn" onClick={lock} style={{ marginLeft: "auto" }}>Lock</button>
              </div>
            </section>

            <section className="panel" aria-label="Actions">
              <div className="tabs" role="tablist">
                {[["shield", "Shield"], ["unshield", "Unshield"], ["activity", "Activity"]].map(([id, label]) => (
                  <button key={id} role="tab" aria-selected={tab === id} className="tab" onClick={() => setTab(id)}>{label}</button>
                ))}
              </div>
              {tab === "shield" && <ShieldForm client={client} address={address} onDone={reload} />}
              {tab === "unshield" && <UnshieldForm client={client} address={address} balances={balances} onDone={reload} />}
              {tab === "activity" && <Activity notes={notes} />}
            </section>
          </div>
        )}
      </div>
    </main>
  );
}
