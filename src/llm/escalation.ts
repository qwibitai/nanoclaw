export interface EscalationResult {
  shouldEscalate: boolean;
  reason?: string;
  score: number;
}

export function scoreComplexity(message: string): EscalationResult {
  let score = 0;
  const reasons: string[] = [];

  if (message.length > 500) {
    score += 2;
    reasons.push('long message');
  }
  if (message.length > 2000) {
    score += 3;
    reasons.push('very long message');
  }

  if (/```/.test(message)) {
    score += 3;
    reasons.push('code block');
  }

  // Check code keywords only in non-code-block portions
  const withoutCodeBlocks = message.replace(/```[\s\S]*?```/g, '');
  if (
    /\b(function|class|import|export|const|let|var)\b/.test(withoutCodeBlocks)
  ) {
    score += 2;
    reasons.push('code keywords');
  }

  if (
    /\b(debug|fix|refactor|architect|design|security|vulnerability)\b/i.test(
      message,
    )
  ) {
    score += 2;
    reasons.push('technical keywords');
  }
  if (/\b(analyze|compare|evaluate|trade-?off)\b/i.test(message)) {
    score += 2;
    reasons.push('analysis keywords');
  }

  const questionMarks = (message.match(/\?/g) || []).length;
  if (questionMarks >= 3) {
    score += 2;
    reasons.push('multi-question');
  }
  if (questionMarks >= 4) {
    score += 3;
  }

  const fileRefs = (message.match(/\b[\w/-]+\.\w{1,5}\b/g) || []).length;
  if (fileRefs >= 3) {
    score += 2;
    reasons.push('multi-file reference');
  }

  const shouldEscalate = score >= 5;
  return {
    shouldEscalate,
    reason: shouldEscalate ? reasons.join(', ') : undefined,
    score,
  };
}
