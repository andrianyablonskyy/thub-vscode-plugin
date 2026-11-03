export interface RttError {
  index: number;
  message: string;
}

export function parseRttError(line: string): RttError | undefined {
  const match = /^RTT (\d+): (.+)$/.exec(line),
    failure = match && /^(?:no OpenOCD target\b|this Client has no ST-Link\b|OpenOCD (?:exited\b|didn't open\b|isn't installed\b|closed\b|:)|ST-Link \d+ is already in use\b)/.test(match[2]);
  return match && failure ? { index: Number(match[1]), message: match[2] } : undefined;
}
