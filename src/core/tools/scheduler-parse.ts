/**
 * Parse a relative time string ("+5m", "+2h30m", "+1d") or ISO datetime
 * into an absolute Unix timestamp in milliseconds.
 */
export function parseAtTime(input: string, now: number): number {
  if (input.startsWith("+")) {
    return now + parseRelativeDuration(input.slice(1));
  }

  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid time: "${input}". Use "+5m", "+2h", or ISO datetime.`);
  }
  return date.getTime();
}

/**
 * Parse a duration string ("30s", "5m", "2h", "1d") into milliseconds.
 */
export function parseEveryDuration(input: string): number {
  return parseRelativeDuration(input);
}

function parseRelativeDuration(input: string): number {
  const regex = /(\d+)\s*(d|h|m|s)/g;
  let totalMs = 0;
  let matched = false;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(input)) !== null) {
    matched = true;
    const value = Number(match[1]);
    const unit = match[2];
    switch (unit) {
      case "d": totalMs += value * 86_400_000; break;
      case "h": totalMs += value * 3_600_000; break;
      case "m": totalMs += value * 60_000; break;
      case "s": totalMs += value * 1_000; break;
    }
  }

  if (!matched || totalMs <= 0) {
    throw new Error(`Invalid duration: "${input}". Use "5m", "2h", "1d", etc.`);
  }

  return totalMs;
}
