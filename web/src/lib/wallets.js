// Wallet discovery and a single interface over Wallet Standard and legacy injected wallets.
//
// Modern Solana wallets (Phantom, Solflare, Backpack, Jupiter, ...) register through the
// Wallet Standard, often a moment after the page loads. Older ones only set a window global.
// Every wallet is normalized to: { name, icon, connect(), signMessage(bytes), signTransaction(tx) }.
import { getWallets } from "@wallet-standard/app";
import {
  registerMwa,
  createDefaultAuthorizationCache,
  createDefaultChainSelector,
  createDefaultWalletNotFoundHandler,
  SolanaMobileWalletAdapterWalletName,
} from "@solana-mobile/wallet-standard-mobile";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";

const CHAIN = "solana:mainnet";

// ---------------------------------------------------------------------------- mobile

export const isMobileBrowser = () =>
  typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
export const isAndroid = () => typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

/**
 * Android Chrome: Solana Mobile Wallet Adapter. Registers a Wallet Standard wallet that hands
 * signing to an installed wallet app (Phantom, Solflare, ...) and returns to the browser.
 * registerMwa itself no-ops off Android, outside HTTPS, and inside wallet in-app browsers.
 */
let mwaRegistered = false;
export function initMobileWallets() {
  if (mwaRegistered || typeof window === "undefined") return;
  mwaRegistered = true;
  registerMwa({
    appIdentity: { name: "Vanish", uri: window.location.origin, icon: "favicon.svg" },
    authorizationCache: createDefaultAuthorizationCache(),
    chains: [CHAIN],
    chainSelector: createDefaultChainSelector(),
    onWalletNotFound: createDefaultWalletNotFoundHandler(),
  });
}

/**
 * iOS (and any mobile browser without a wallet): reopen this page inside the wallet's own
 * browser, where the wallet is injected and connects like on desktop.
 */
export function openInWalletLinks(url = window.location.href) {
  const u = encodeURIComponent(url);
  const ref = encodeURIComponent(window.location.origin);
  return [
    ["Phantom", `https://phantom.app/ul/browse/${u}?ref=${ref}`],
    ["Solflare", `https://solflare.com/ul/v1/browse/${u}?ref=${ref}`],
  ];
}

export const walletLabel = (w) => (w.name === SolanaMobileWalletAdapterWalletName ? "Phantom / wallet app" : w.name);

function fromStandard(w) {
  let account = null;
  return {
    name: w.name,
    icon: w.icon,
    async connect() {
      const res = await w.features["standard:connect"].connect();
      const accounts = res?.accounts?.length ? res.accounts : w.accounts;
      account = accounts.find((a) => a.chains?.includes(CHAIN)) ?? accounts[0];
      if (!account) throw new Error(`${w.name} didn't share an account.`);
      return new PublicKey(account.publicKey);
    },
    async signMessage(message) {
      const [out] = await w.features["solana:signMessage"].signMessage({ account, message });
      return out.signature;
    },
    async signTransaction(tx) {
      const [out] = await w.features["solana:signTransaction"].signTransaction({ account, transaction: tx.serialize(), chain: CHAIN });
      return VersionedTransaction.deserialize(out.signedTransaction);
    },
  };
}

function fromInjected(name, provider) {
  return {
    name,
    icon: provider.icon ?? null,
    async connect() {
      const res = await provider.connect();
      return new PublicKey((res?.publicKey ?? provider.publicKey).toString());
    },
    async signMessage(message) {
      const res = await provider.signMessage(message, "utf8");
      return res?.signature ?? res;
    },
    signTransaction: (tx) => provider.signTransaction(tx),
  };
}

const usable = (w) =>
  w.features?.["standard:connect"] &&
  w.features?.["solana:signTransaction"] &&
  w.features?.["solana:signMessage"] &&
  (w.chains?.some((c) => c.startsWith("solana:")) ?? true);

export function listWallets() {
  if (typeof window === "undefined") return [];
  const standard = getWallets().get().filter(usable).map(fromStandard);
  const names = new Set(standard.map((w) => w.name.toLowerCase()));
  const injected = [
    ["Phantom", window.phantom?.solana],
    ["Solflare", window.solflare],
    ["Backpack", window.backpack],
  ]
    .filter(([name, p]) => p && !names.has(name.toLowerCase()))
    .map(([name, p]) => fromInjected(name, p));
  return [...standard, ...injected];
}

/** Calls cb whenever wallets appear or disappear (extensions often register after load). */
export function watchWallets(cb) {
  const api = getWallets();
  const offs = [api.on("register", cb), api.on("unregister", cb)];
  const onEvent = () => cb();
  window.addEventListener("load", onEvent);
  window.addEventListener("focus", onEvent);
  // some extensions (e.g. MetaMask's Solana wallet) register several seconds after load
  let ticks = 0;
  const poll = setInterval(() => {
    cb();
    if (++ticks >= 20) clearInterval(poll);
  }, 500);
  return () => {
    offs.forEach((off) => off());
    window.removeEventListener("load", onEvent);
    window.removeEventListener("focus", onEvent);
    clearInterval(poll);
  };
}

export const INSTALL_LINKS = [
  ["Phantom", "https://phantom.com/download"],
  ["Solflare", "https://solflare.com/download"],
  ["Backpack", "https://backpack.app/downloads"],
];
