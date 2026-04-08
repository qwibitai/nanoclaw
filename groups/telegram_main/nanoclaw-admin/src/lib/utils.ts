import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function splitIntoChunks<T>(arr: T[], chunkSize = 1000): T[][] {
  if (arr.length <= chunkSize) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    out.push(arr.slice(i, i + chunkSize));
  }
  return out;
}

export function prettifyNum(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

export function formatExecutionTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round((ms / 1000) * 10) / 10;
  return `${sec}s`;
}
