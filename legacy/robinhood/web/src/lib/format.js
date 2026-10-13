import { formatUnits, parseUnits } from "ethers";

/** 1234.5000 -> "1,234.5"; keeps at most `maxFrac` decimals, never rounds up past the value. */
export function fmt(value, decimals, maxFrac = 6) {
  const [int, frac = ""] = formatUnits(value ?? 0n, decimals).split(".");
  const f = frac.slice(0, maxFrac).replace(/0+$/, "");
  return BigInt(int).toLocaleString("en-US") + (f ? "." + f : "");
}

export function parseAmount(text, decimals) {
  const t = String(text ?? "").trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
  const [, frac = ""] = t.split(".");
  if (frac.length > decimals) return null;
  try {
    return parseUnits(t, decimals);
  } catch {
    return null;
  }
}

export const short = (addr, n = 4) => (addr ? `${addr.slice(0, 2 + n)}…${addr.slice(-n)}` : "");

/** true when an amount has more than 2 significant digits (e.g. 0.7342) — a linkable fingerprint. */
export function isUnusual(text) {
  const digits = String(text).replace(/[^\d]/g, "").replace(/^0+/, "").replace(/0+$/, "");
  return digits.length > 2;
}
