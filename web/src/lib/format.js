import { fromRaw, toRaw } from "sdk/solmix.js";

/** 1234.5 -> "1,234.5"; keeps at most `maxFrac` decimals, never rounds up. */
export function fmt(value, decimals, maxFrac = 6) {
  const [int, frac = ""] = fromRaw(value ?? 0n, decimals, maxFrac).split(".");
  return BigInt(int).toLocaleString("en-US") + (frac ? "." + frac : "");
}

export function parseAmount(text, decimals) {
  const t = String(text ?? "").trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
  try {
    return toRaw(t, decimals);
  } catch {
    return null;
  }
}

export const short = (addr, n = 4) => {
  const s = addr?.toString?.() ?? "";
  return s ? `${s.slice(0, n)}…${s.slice(-n)}` : "";
};

/** true when an amount has more than 2 significant digits (e.g. 0.7342), which makes it easier to trace. */
export function isUnusual(text) {
  const digits = String(text).replace(/[^\d]/g, "").replace(/^0+/, "").replace(/0+$/, "");
  return digits.length > 2;
}
