/**
 * Parse PGN comment macros [%eval ...] and [%clk ...] from comment text.
 * Returns extracted values and the remaining human-readable comment.
 */
export function parseCommentMacros(raw: string): {
  eval?: number;
  clock?: string;
  comment?: string;
} {
  let text = raw;
  let evalValue: number | undefined;
  let clockValue: string | undefined;

  // Extract [%eval X.XX] or [%eval #N] (mate in N)
  const evalMatch = text.match(/\[%eval\s+([^\]]+)\]/);
  if (evalMatch) {
    const val = evalMatch[1].trim();
    if (val.startsWith('#')) {
      // Mate score: #5 means mate in 5 for white, #-3 means mate in 3 for black
      const mateNum = parseInt(val.slice(1), 10);
      // Represent mate as a large number: +/-100 * sign
      evalValue = mateNum > 0 ? 100 : mateNum < 0 ? -100 : 0;
    } else {
      evalValue = parseFloat(val);
      if (isNaN(evalValue)) evalValue = undefined;
    }
    text = text.replace(/\[%eval\s+[^\]]+\]/g, '');
  }

  // Extract [%clk H:MM:SS]
  const clkMatch = text.match(/\[%clk\s+([^\]]+)\]/);
  if (clkMatch) {
    clockValue = clkMatch[1].trim();
    text = text.replace(/\[%clk\s+[^\]]+\]/g, '');
  }

  // Clean up remaining text
  const comment = text.trim() || undefined;

  return { eval: evalValue, clock: clockValue, comment };
}

/**
 * Serialize eval/clock values back into PGN comment macro format.
 * Combines with human comment text if present.
 */
export function serializeCommentWithMacros(
  comment?: string,
  evalValue?: number,
  clock?: string,
): string | undefined {
  const parts: string[] = [];

  if (evalValue !== undefined) {
    // Format eval: mate scores as #N, otherwise as decimal
    if (evalValue >= 100) {
      parts.push('[%eval #1]');
    } else if (evalValue <= -100) {
      parts.push('[%eval #-1]');
    } else {
      parts.push(`[%eval ${evalValue.toFixed(2)}]`);
    }
  }

  if (comment) {
    parts.push(comment);
  }

  if (clock) {
    parts.push(`[%clk ${clock}]`);
  }

  if (parts.length === 0) return undefined;
  return parts.join(' ');
}
