import { getPRSize, getPRSizeColor, type PRSize } from "@/lib/github";

interface Props {
  additions: number;
  deletions: number;
}

export function PRSizeBadge({ additions, deletions }: Props) {
  const size = getPRSize(additions, deletions);
  const colorClass = getPRSizeColor(size);
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-mono font-medium ${colorClass}`}>
      {size}
    </span>
  );
}
