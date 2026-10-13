// Protocol specification: the actual construction, written out formally.
// Every formula here corresponds to circuits/transaction.circom or programs/solmix/src/{lib,swap,buy}.rs.
import { useMemo } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import { PixelIcon } from "./art.jsx";

function Tex({ children, block }) {
  const html = useMemo(
    () => katex.renderToString(children, { displayMode: !!block, throwOnError: false, output: "html", strict: false }),
    [children, block],
  );
  return block ? <div className="tex-block" dangerouslySetInnerHTML={{ __html: html }} /> : <span className="tex-inline" dangerouslySetInnerHTML={{ __html: html }} />;
}

// ------------------------------------------------------------------ diagrams

function Node({ x, y, w = 260, h = 88, title, lines = [], tone }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect width={w} height={h} rx="12" className={`dg-node ${tone ? `dg-${tone}` : ""}`} />
      <text x="16" y="28" className="dg-title">{title}</text>
      {lines.map((l, i) => (
        <text key={l} x="16" y={50 + i * 18} className="dg-mono">{l}</text>
      ))}
    </g>
  );
}

function Arrow({ d, label, lx, ly, dashed }) {
  return (
    <g>
      <path d={d} className={`dg-edge ${dashed ? "dg-dashed" : ""}`} markerEnd="url(#dg-arrow)" />
      {label && <text x={lx} y={ly} className="dg-label" textAnchor="middle">{label}</text>}
    </g>
  );
}

function FlowDiagram() {
  return (
    <svg viewBox="0 0 1200 400" className="diagram-svg" role="img" aria-label="Shield and unshield data flow">
      <defs>
        <marker id="dg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 10 5 0 10z" className="dg-arrowhead" />
        </marker>
      </defs>
      <text x="20" y="18" className="dg-lane">SHIELD · Δ &gt; 0</text>
      <Node x={20} y={30} title="Depositor wallet" lines={["signs transact(π, x, ext)", "pays Δ = d ∈ D_τ"]} />
      <Node x={470} y={30} title="Vanish program" lines={["Groth16.verify(vk, x, π)", "assert Δ ∈ D_τ, fee = 0"]} tone="accent" />
      <Node x={920} y={30} title="Incremental Merkle tree" lines={["depth 20 · H = Poseidon", "roots ring buffer R₁₀₀"]} />
      <Arrow d="M280 74 H462" label="cm′₁, cm′₂, Δ" lx={371} ly={64} />
      <Arrow d="M730 74 H912" label="insert(cm′₁, cm′₂)" lx={821} ly={64} />

      <text x="20" y="228" className="dg-lane">UNSHIELD · Δ &lt; 0</text>
      <Node x={20} y={240} title="Prover (your browser)" lines={["witness w · 28,044 R1CS", "π ← Groth16.Prove(pk, x, w)"]} />
      <Node x={320} y={240} title="Relayer" lines={["fee payer · simulates", "binds f via h_ext"]} />
      <Node x={620} y={240} title="Vanish program" lines={["e(−A,B)·e(vk_x,γ)·e(C,δ)", "·e(α,β) = 1   nf ∉ 𝒩"]} tone="accent" />
      <Node x={920} y={240} title="Recipient" lines={["receives |Δ|", "unlinkable to depositor"]} />
      <Arrow d="M280 284 H312" />
      <Arrow d="M580 284 H612" label="(π, x)" lx={596} ly={274} />
      <Arrow d="M880 284 H912" label="|Δ|" lx={896} ly={274} />
      <Arrow d="M1000 118 C 1000 180, 150 170, 150 232" label="authentication path (rt, π_Merkle) — read off-chain" lx={575} ly={168} dashed />
      <Arrow d="M820 240 C 860 190, 1010 180, 1040 126" label="change cm′" lx={985} ly={205} dashed />
      <g transform="translate(620 344)">
        <rect width="260" height="40" rx="10" className="dg-node dg-soft" />
        <text x="16" y="25" className="dg-mono">creates PDA(&quot;nullifier&quot;, nf₁), (…, nf₂)</text>
      </g>
      <Arrow d="M750 328 V342" />
    </svg>
  );
}

function MerkleDiagram() {
  // depth-4 illustration of the authentication path for leaf i = 5
  const levels = 4;
  const W = 600;
  const top = 40;
  const gap = 58;
  const pos = (lvl, idx) => {
    const n = 2 ** (levels - lvl);
    return [((idx + 0.5) * W) / n, top + (levels - lvl) * gap];
  };
  const leaf = 5;
  const path = new Set();
  const sibs = new Set();
  for (let l = 0, i = leaf; l <= levels; l++, i >>= 1) {
    path.add(`${l}-${i}`);
    if (l < levels) sibs.add(`${l}-${i ^ 1}`);
  }
  const nodes = [];
  const edges = [];
  for (let l = 0; l <= levels; l++) {
    for (let i = 0; i < 2 ** (levels - l); i++) {
      const [x, y] = pos(l, i);
      if (l < levels) {
        const [px, py] = pos(l + 1, i >> 1);
        edges.push(<line key={`e${l}-${i}`} x1={x} y1={y} x2={px} y2={py} className={path.has(`${l}-${i}`) ? "dg-edge dg-hot" : "dg-edge dg-faint"} />);
      }
      const k = `${l}-${i}`;
      const cls = path.has(k) ? "dg-dot dg-dot-path" : sibs.has(k) ? "dg-dot dg-dot-sib" : "dg-dot";
      nodes.push(<circle key={k} cx={x} cy={y} r={l === levels ? 11 : 8} className={cls} />);
    }
  }
  const [rx, ry] = pos(levels, 0);
  const [lx, ly] = pos(0, leaf);
  return (
    <svg viewBox="0 0 600 300" className="diagram-svg" role="img" aria-label="Merkle authentication path">
      {edges}
      {nodes}
      <text x={rx + 20} y={ry + 5} className="dg-mono">rt ∈ R₁₀₀</text>
      <text x={lx} y={ly + 30} className="dg-mono" textAnchor="middle">cm (i = 5)</text>
      <g transform="translate(18 274)">
        <circle cx="6" cy="-4" r="6" className="dg-dot dg-dot-path" /><text x="18" y="0" className="dg-small">path H(·,·)</text>
        <circle cx="136" cy="-4" r="6" className="dg-dot dg-dot-sib" /><text x="148" y="0" className="dg-small">siblings π_Merkle</text>
        <text x="320" y="0" className="dg-small">illustrated at depth 4; on-chain depth is 20</text>
      </g>
    </svg>
  );
}

function JoinSplitDiagram() {
  return (
    <svg viewBox="0 0 600 300" className="diagram-svg" role="img" aria-label="Two-in two-out JoinSplit circuit">
      <defs>
        <marker id="dg-arrow2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0 10 5 0 10z" className="dg-arrowhead" />
        </marker>
      </defs>
      {[0, 1].map((j) => (
        <g key={j} transform={`translate(10 ${40 + j * 120})`}>
          <rect width="150" height="80" rx="10" className="dg-node" />
          <text x="14" y="26" className="dg-title">note n{j === 0 ? "₁" : "₂"}</text>
          <text x="14" y="48" className="dg-mono">(v, pk, ρ, τ)</text>
          <text x="14" y="66" className="dg-mono">→ nf{j === 0 ? "₁" : "₂"}</text>
          <path d={`M160 40 H200`} className="dg-edge" markerEnd="url(#dg-arrow2)" />
        </g>
      ))}
      <g transform="translate(212 20)">
        <rect width="176" height="240" rx="14" className="dg-node dg-accent" />
        <text x="88" y="30" className="dg-title" textAnchor="middle">circuit 𝓡</text>
        {["membership ∀ v_j ≠ 0", "nf_j well-formed", "cm′_k = H(v′,pk′,ρ′,τ)", "v ∈ [0, 2²⁴⁸)", "Σv + v_pub ≡ Σv′", "nf₁ ≠ nf₂", "h_ext² bound"].map((t, i) => (
          <text key={t} x="88" y={62 + i * 26} className="dg-mono" textAnchor="middle">{t}</text>
        ))}
      </g>
      {[0, 1].map((k) => (
        <g key={k} transform={`translate(440 ${40 + k * 120})`}>
          <path d="M-40 40 H-2" className="dg-edge" markerEnd="url(#dg-arrow2)" />
          <rect width="150" height="80" rx="10" className="dg-node" />
          <text x="14" y="26" className="dg-title">output {k === 0 ? "₁" : "₂"}</text>
          <text x="14" y="48" className="dg-mono">cm′{k === 0 ? "₁" : "₂"}, c{k === 0 ? "₁" : "₂"}</text>
          <text x="14" y="66" className="dg-mono">AES-GCM(v′‖ρ′)</text>
        </g>
      ))}
      <path d="M300 290 V264" className="dg-edge" markerEnd="url(#dg-arrow2)" />
      <text x="312" y="288" className="dg-small">v_pub = (Δ − f) mod r</text>
    </svg>
  );
}

function SwapDiagram() {
  return (
    <svg viewBox="0 0 1200 430" className="diagram-svg" role="img" aria-label="Private swap state machine and private buy flow">
      <defs>
        <marker id="dg-arrow4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 10 5 0 10z" className="dg-arrowhead" />
        </marker>
      </defs>
      <text x="20" y="18" className="dg-lane">PRIVATE SWAP · τ_A → τ_B · order PDA(&quot;order&quot;, id)</text>
      <Node x={20} y={30} w={250} title="swap_prepare" lines={["π_refund: Δ = +x over τ_A", "stores cm_ref (worth x)"]} />
      <Node x={320} y={30} w={250} title="swap_commit_out" lines={["π_out: Δ = +y over τ_B", "stores cm_out (worth y)"]} />
      <Node x={620} y={30} w={260} title="swap_open" lines={["π_in: Δ = −x, f  over τ_A", "h_ext ∋ T = terms(order)"]} tone="accent" />
      <Node x={930} y={30} w={250} title="swap_execute" lines={["CPI Jupiter, signer = order", "assert out ≥ y, insert cm_out"]} tone="accent" />
      <path d="M270 74 H312" className="dg-edge" markerEnd="url(#dg-arrow4)" />
      <path d="M570 74 H612" className="dg-edge" markerEnd="url(#dg-arrow4)" />
      <path d="M880 74 H922" className="dg-edge" markerEnd="url(#dg-arrow4)" />
      <text x="901" y="64" className="dg-label" textAnchor="middle">x → escrow</text>
      <g transform="translate(620 150)">
        <rect width="560" height="44" rx="10" className="dg-node dg-soft" />
        <text x="16" y="27" className="dg-mono">swap_cancel (relayer, or anyone after t &gt; deadline): escrow → vault_A, insert cm_ref</text>
      </g>
      <path d="M750 118 V148" className="dg-edge dg-dashed" markerEnd="url(#dg-arrow4)" />

      <text x="20" y="248" className="dg-lane">PRIVATE BUY · any mint μ · order PDA(&quot;buy&quot;, id)</text>
      <Node x={20} y={260} w={270} title="Prover (your browser)" lines={["π_in: Δ = −(x + g), f", "h_ext ∋ B = (μ, y, t, W, g)"]} />
      <Node x={340} y={260} w={250} title="buy_open" lines={["x → escrow, g held", "change cm′ inserted"]} tone="accent" />
      <Node x={640} y={260} w={250} title="buy_execute" lines={["CPI Jupiter, signer = order", "assert Δbal(ATA_W,μ) ≥ y"]} tone="accent" />
      <Node x={940} y={260} w={240} title="Fresh wallet W" lines={["receives ≥ y of μ + gas g", "history ends at the pool"]} />
      <path d="M290 304 H332" className="dg-edge" markerEnd="url(#dg-arrow4)" />
      <path d="M590 304 H632" className="dg-edge" markerEnd="url(#dg-arrow4)" />
      <path d="M890 304 H932" className="dg-edge" markerEnd="url(#dg-arrow4)" />
      <g transform="translate(340 380)">
        <rect width="840" height="40" rx="10" className="dg-node dg-soft" />
        <text x="16" y="25" className="dg-mono">buy_cancel: x + g → W  (a plain withdrawal to W: nothing about the payer is revealed)</text>
      </g>
      <path d="M465 348 V378" className="dg-edge dg-dashed" markerEnd="url(#dg-arrow4)" />
    </svg>
  );
}

// ------------------------------------------------------------------ content

const METRICS = [
  ["28,044", "R1CS constraints"],
  ["8", "public inputs"],
  ["256 B", "proof (A, B, C)"],
  ["~195k", "compute units"],
  ["2²⁰", "leaf capacity"],
  ["100", "root history window"],
  ["3", "proofs per private swap"],
  ["1", "proof per private buy"],
];

const SECTIONS = [
  {
    id: "field",
    title: "Field and hash",
    tex: [
      String.raw`\mathbb{F}_r,\quad r = 21888\ldots95617 \approx 2^{253.6}\ \ (\text{BN254 scalar order})`,
      String.raw`H = \mathrm{Poseidon}_{t}:\ \mathbb{F}_r^{\,t-1}\to\mathbb{F}_r,\qquad S(x)=x^{5},\ \ R_F = 8`,
    ],
    body: "All arithmetic lives in the scalar field of BN254. Poseidon is an algebraic sponge with a degree-5 S-box, cheap inside R1CS and available on Solana as a native syscall, so the in-circuit and on-chain trees agree bit for bit.",
  },
  {
    id: "keys",
    title: "Spending key derivation",
    tex: [
      String.raw`\mathsf{sk} = \mathrm{SHA256}\big(\texttt{"solmix-shielded-key:"}\,\Vert\,\sigma_{\mathrm{Ed25519}}(m)\big)_{[0,248)},\qquad \mathsf{pk} = H(\mathsf{sk})`,
    ],
    body: "Ed25519 signatures are deterministic, so the same wallet signing the same domain-separated message m always yields the same spending key. Nothing is stored server-side and recovery is a single signature.",
  },
  {
    id: "notes",
    title: "Note commitments",
    tex: [
      String.raw`n = (v,\ \mathsf{pk},\ \rho,\ \tau),\qquad \mathsf{cm} = H(v,\ \mathsf{pk},\ \rho,\ \tau)`,
      String.raw`\tau = \textstyle\sum_{k=0}^{30} \mathrm{mint}_k\cdot 256^{\,30-k},\qquad \rho \xleftarrow{\$}\{0,1\}^{248}`,
    ],
    body: "A commitment is hiding under the 248-bit random blinding ρ and binding under Poseidon's collision resistance. The asset tag τ is the first 31 bytes of the SPL mint (native SOL is τ = 0), so value can never cross between assets.",
  },
  {
    id: "nullifiers",
    title: "Nullifiers",
    tex: [String.raw`\sigma = H(\mathsf{sk},\ \mathsf{cm},\ i),\qquad \mathsf{nf} = H(\mathsf{cm},\ i,\ \sigma)`],
    body: "Each note at leaf index i admits exactly one nullifier. Computing it requires sk, so an observer holding cm cannot derive nf, and nf reveals nothing about which leaf was spent.",
  },
  {
    id: "tree",
    title: "Incremental Merkle accumulator",
    tex: [
      String.raw`z_0 = 0,\quad z_{k+1} = H(z_k,\ z_k),\qquad \mathsf{rt} = \mathrm{Root}_{20}(\mathsf{cm}_0,\dots,\mathsf{cm}_{N-1})`,
      String.raw`\mathsf{accept}(\mathsf{rt}) \iff \mathsf{rt}\in\mathcal{R}_{100} = \{\mathsf{rt}_{t-99},\dots,\mathsf{rt}_t\}`,
    ],
    body: "The program stores only the 20 filled-subtree frontier nodes and a ring buffer of the last 100 roots, inserting leaves in pairs. Proofs against any recent root verify, which tolerates concurrent transactions.",
  },
  {
    id: "relation",
    title: "The NP relation",
    tex: [
      String.raw`x = (\mathsf{rt},\ v_{\mathrm{pub}},\ h_{\mathrm{ext}},\ \tau,\ \mathsf{nf}_1,\ \mathsf{nf}_2,\ \mathsf{cm}'_1,\ \mathsf{cm}'_2)`,
      String.raw`\begin{aligned}
&\forall j:\ v_j\neq 0 \Rightarrow \mathrm{MerkleVerify}(\mathsf{rt},\ \mathsf{cm}_j,\ i_j,\ \pi_j) = 1\\
&\forall j:\ \mathsf{nf}_j = H\!\big(\mathsf{cm}_j,\ i_j,\ H(\mathsf{sk}_j,\mathsf{cm}_j,i_j)\big)\\
&\forall k:\ \mathsf{cm}'_k = H(v'_k,\ \mathsf{pk}'_k,\ \rho'_k,\ \tau),\quad v_j,\ v'_k\in[0,2^{248})\\
&\textstyle\sum_{j} v_j + v_{\mathrm{pub}} \equiv \sum_{k} v'_k \pmod r,\qquad \mathsf{nf}_1\neq\mathsf{nf}_2
\end{aligned}`,
    ],
    body: "A 2-input, 2-output JoinSplit. Zero-value dummy inputs skip the membership check, the 248-bit range checks rule out field-wraparound inflation, and conservation of value holds exactly in 𝔽_r.",
  },
  {
    id: "binding",
    title: "External data binding",
    tex: [
      String.raw`h_{\mathrm{ext}} = \mathrm{Keccak256}\big(\mathsf{to}\,\Vert\,\Delta\,\Vert\,\mathsf{relayer}\,\Vert\,f\,\Vert\,\mathsf{mint}\,\Vert\,c_1\,\Vert\,c_2\big)\bmod r`,
      String.raw`v_{\mathrm{pub}} = (\Delta - f)\bmod r,\qquad \Delta>0 \Rightarrow \Delta\in D_\tau`,
    ],
    body: "Recipient, signed amount Δ, relayer, fee f, mint and both ciphertexts are hashed into a public input. Any mutation in the mempool invalidates the proof, which makes relaying non-malleable and front-running useless.",
  },
  {
    id: "groth16",
    title: "Groth16 verification",
    tex: [
      String.raw`\mathrm{vk}_x = \mathrm{IC}_0 + \textstyle\sum_{i=1}^{8} x_i\cdot \mathrm{IC}_i`,
      String.raw`e(-A,\ B)\cdot e(\mathrm{vk}_x,\ [\gamma]_2)\cdot e(C,\ [\delta]_2)\cdot e([\alpha]_1,\ [\beta]_2) = 1_{\mathbb{G}_T}`,
    ],
    body: "A single four-pairing product over BN254, evaluated with Solana's alt_bn128 syscalls. The proof is three group elements (A, C ∈ 𝔾₁, B ∈ 𝔾₂), 256 bytes regardless of circuit size: succinct, perfectly zero-knowledge, and knowledge-sound provided the circuit-specific setup was honest.",
  },
  {
    id: "nullset",
    title: "Double-spend prevention",
    tex: [String.raw`\mathsf{spend}(\mathsf{nf}) \implies \mathsf{nf}\notin\mathcal{N},\qquad \mathcal{N}\leftarrow\mathcal{N}\cup\{\mathsf{nf}\}\ \ \text{via}\ \ \mathrm{PDA}(\texttt{"nullifier"},\ \mathsf{nf})`],
    body: "The nullifier set 𝒩 is materialized as program-derived accounts. Account creation is atomic and fails if the address exists, so a replayed or duplicated nullifier aborts the whole transaction.",
  },
  {
    id: "encryption",
    title: "Note encryption and recovery",
    tex: [String.raw`c = \mathrm{AES\text{-}256\text{-}GCM}_{k}\big(v\,\Vert\,\rho\big),\qquad k = \mathrm{SHA256}(\texttt{"solmix-note-key:"}\,\Vert\,\mathsf{sk})`],
    body: "Every output note is emitted on-chain as a 68-byte authenticated ciphertext. Wallets trial-decrypt the event log; GCM's tag rejects foreign notes, so recovery needs nothing but sk and the chain.",
  },
  {
    id: "swap",
    title: "Atomic swap orders and term binding",
    tex: [
      String.raw`\pi_{\mathrm{ref}}:\ \Delta=+x\ \text{over}\ \tau_A,\qquad \pi_{\mathrm{out}}:\ \Delta=+y\ \text{over}\ \tau_B`,
      String.raw`T = \mathrm{Keccak}\big(\texttt{"swap"}\,\Vert\,\tau_B\,\Vert\,y\,\Vert\,t\,\Vert\,\mathsf{cm}_{\mathrm{out}}\,\Vert\,c_{\mathrm{out}}\,\Vert\,\mathsf{cm}_{\mathrm{ref}}\,\Vert\,c_{\mathrm{ref}}\big)`,
      String.raw`h_{\mathrm{ext}}^{\mathrm{in}} = \mathrm{Keccak}\big(\mathsf{order}\,\Vert\,{-x}\,\Vert\,\mathsf{relayer}\,\Vert\,f\,\Vert\,\tau_A\,\Vert\,c_1\,\Vert\,c_2\,\Vert\,T\big)\bmod r`,
    ],
    body: "Every note a swap can ever create is proven before value moves: the refund notes are worth exactly x and the output notes exactly y, each by a deposit-shaped proof that moves nothing. The spending proof then commits to T, recomputed on-chain from the stored order, so substituting any note or term breaks π_in.",
  },
  {
    id: "isolation",
    title: "Route isolation",
    tex: [
      String.raw`\mathrm{Signers}(\mathrm{CPI}_{\mathrm{JUP}}) = \{\mathsf{order}\},\qquad \{\mathsf{pool},\ \mathsf{vault}_{\mathrm{SOL}}\}\cap \mathrm{Accounts}(\mathrm{route}) = \varnothing`,
      String.raw`\mathrm{out} = \mathrm{bal}_{\mathrm{after}}(\mathsf{escrow}_B) - \mathrm{bal}_{\mathrm{before}}(\mathsf{escrow}_B)\ \ge\ y`,
    ],
    body: "The aggregator is invoked through a hard-whitelisted program id with one PDA signer that owns only this order's escrows. Pool vaults never sign and may not appear in the route, so a malicious route can spend at most x. Proceeds are measured as a balance delta after the CPI; surplus above y tips the relayer, unspent input returns to the pool.",
  },
  {
    id: "buy",
    title: "Private buy of arbitrary mints",
    tex: [
      String.raw`B = \mathrm{Keccak}\big(\texttt{"buy"}\,\Vert\,\mu\,\Vert\,y\,\Vert\,t\,\Vert\,W\,\Vert\,g\big),\qquad \Delta = -(x+g)`,
      String.raw`\Delta\mathrm{bal}\big(\mathrm{ATA}(W,\mu)\big) \ge y,\qquad g\in\{0\}\cup[10^{6},\infty)\ \text{lamports}`,
    ],
    body: "For tokens the pool never lists, a single spend proof binds the mint μ, minimum y, deadline t, destination wallet W and gas g. The route delivers straight into W's associated token account; anything a route parks on the order's own account is swept to W in the same instruction.",
  },
  {
    id: "liveness",
    title: "Liveness and refunds",
    tex: [
      String.raw`t \le t_{\mathrm{open}} + 3600,\qquad \mathsf{cancel}\ \text{allowed iff}\ \mathsf{caller}=\mathsf{relayer}\ \lor\ \mathrm{now} > t`,
      String.raw`\mathsf{close}(\tau)\ \text{allowed iff}\ \mathrm{paused}(\tau)\ \land\ \mathrm{now}\ge t_{\mathrm{pause}}+3660\ \land\ \mathrm{bal}(\mathsf{vault}_\tau)=0`,
    ],
    body: "No order outlives an hour and none can open on a paused asset. After its deadline anyone may cancel: a swap re-inserts the proven refund notes, a buy pays x + g to W. Admin cleanup is gated on an empty vault and a pause older than any order, so it can never strand a note.",
  },
  {
    id: "anonymity",
    title: "Anonymity set",
    tex: [String.raw`\mathcal{A}_{\tau} = \{\mathsf{cm}\ :\ \text{inserted with asset }\tau\},\qquad \Pr[\text{link}\mid\pi] \le \frac{1}{|\mathcal{A}_\tau|}`],
    body: "Under zero-knowledge, a withdrawal is indistinguishable across all unspent notes of the same asset; the bound is the ideal case. Fixed denominations D_τ keep deposits identical, so privacy grows with |𝒜_τ| and is eroded only by timing and amount heuristics.",
  },
];

export default function Spec() {
  return (
    <section className="content spec-sec" id="spec">
      <div className="content-head">
        <div className="tag-row">
          <PixelIcon name="terminal" size={30} />
          <span className="tag accent">Protocol specification</span>
          <PixelIcon name="terminal" size={30} />
        </div>
        <h2>A zk-SNARK shielded pool with atomic private swaps: commitments, nullifiers and a Groth16 JoinSplit over BN254.</h2>
        <p>
          The formal construction behind Vanish, exactly as implemented in the circuit and the on-chain program. Funds enter as hiding commitments,
          move between assets through escrowed, term-bound aggregator routes, and leave through a succinct non-interactive argument of knowledge.
          The link between any two of those events is computationally severed.
        </p>
      </div>

      <div className="metrics">
        {METRICS.map(([v, k]) => (
          <div className="metric" key={k}><b>{v}</b><span>{k}</span></div>
        ))}
      </div>

      <figure className="diagram card">
        <figcaption><b>Fig. 1</b> Data flow. Shielding inserts commitments; unshielding proves membership and ownership in zero knowledge, then spends via nullifiers.</figcaption>
        <span className="swipe-hint">swipe to explore →</span>
        <div className="diagram-scroll"><FlowDiagram /></div>
      </figure>

      <div className="spec-grid">
        {SECTIONS.map((s, i) => (
          <article className="spec-card card" key={s.id}>
            <h3><span className="spec-num">§{i + 1}</span> {s.title}</h3>
            {s.tex.map((t) => <Tex key={t} block>{t}</Tex>)}
            <p>{s.body}</p>
          </article>
        ))}
      </div>

      <figure className="diagram card">
        <figcaption><b>Fig. 4</b> Private swap state machine (top) and private buy (bottom). Accent nodes move value; dashed edges are the cancel paths.</figcaption>
        <span className="swipe-hint">swipe to explore →</span>
        <div className="diagram-scroll"><SwapDiagram /></div>
      </figure>

      <div className="grid-2 diagram-pair">
        <figure className="diagram card">
          <figcaption><b>Fig. 2</b> Merkle authentication path. Highlighted nodes are recomputed in-circuit; siblings are private witness.</figcaption>
          <span className="swipe-hint">swipe to explore →</span>
          <div className="diagram-scroll small"><MerkleDiagram /></div>
        </figure>
        <figure className="diagram card">
          <figcaption><b>Fig. 3</b> The 2-in / 2-out JoinSplit relation enforced by the circuit.</figcaption>
          <span className="swipe-hint">swipe to explore →</span>
          <div className="diagram-scroll small"><JoinSplitDiagram /></div>
        </figure>
      </div>
    </section>
  );
}
