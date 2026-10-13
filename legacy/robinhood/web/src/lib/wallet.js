import { BrowserProvider } from "ethers";
import { CHAIN_ID, RPC_URL, EXPLORER } from "./client.js";

const HEX_CHAIN = "0x" + CHAIN_ID.toString(16);

export const hasWallet = () => typeof window !== "undefined" && !!window.ethereum;

export async function currentChainId() {
  return parseInt(await window.ethereum.request({ method: "eth_chainId" }), 16);
}

export async function switchToRobinhoodChain() {
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: HEX_CHAIN }] });
  } catch (e) {
    if (e?.code !== 4902 && e?.data?.originalError?.code !== 4902) throw e;
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: HEX_CHAIN,
        chainName: "Robinhood Chain",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: [RPC_URL],
        blockExplorerUrls: [EXPLORER],
      }],
    });
  }
}

export async function connectWallet() {
  if (!hasWallet()) throw new Error("No browser wallet found. Install MetaMask or Rabby, or open this page in a wallet browser.");
  const [address] = await window.ethereum.request({ method: "eth_requestAccounts" });
  return address;
}

export async function getSigner() {
  if ((await currentChainId()) !== CHAIN_ID) await switchToRobinhoodChain();
  return new BrowserProvider(window.ethereum, "any").getSigner();
}

export function onWalletChange(cb) {
  if (!hasWallet()) return () => {};
  window.ethereum.on?.("accountsChanged", cb);
  window.ethereum.on?.("chainChanged", cb);
  return () => {
    window.ethereum.removeListener?.("accountsChanged", cb);
    window.ethereum.removeListener?.("chainChanged", cb);
  };
}

/** Wallet errors -> one line people can act on. */
export function explainError(e) {
  const code = e?.code ?? e?.info?.error?.code;
  if (code === 4001 || code === "ACTION_REJECTED") return "You rejected the request in your wallet.";
  if (/insufficient funds/i.test(e?.message ?? "")) return "Your wallet doesn't have enough ETH for this amount plus gas.";
  return e?.shortMessage ?? e?.reason ?? e?.message ?? String(e);
}
