import "server-only";
import { redisSecondaryStorage } from "../secondary-storage";
import { EMAIL_CODE_SEND_LIMITS, EMAIL_CODE_VERIFY_LIMIT } from "./constants";

/**
 * Per-address counters in Redis (INCR + EXPIRE, atomic). Deliberately NOT Better Auth's rate limiter:
 * that one is per IP, and RATE_LIMITING_DISABLED switches it off; these caps protect a code from brute
 * force and a mailbox from flooding, so they always apply. Callers fail closed when Redis is down.
 *
 * `pool` separates a trusted device's budget from everyone else's (see EMAIL_CODE_DEVICE_COOKIE_NAME).
 */
export type TEmailCodePool = "shared" | "device";

export const EMAIL_CODE_REDIS_PREFIX = "email-code:";

/** True when this send is within every per-address window. Stops at the first window that is full. */
export const consumeEmailCodeSendQuota = async (tag: string, pool: TEmailCodePool): Promise<boolean> => {
  for (const { windowSeconds, max } of EMAIL_CODE_SEND_LIMITS) {
    const key = `${EMAIL_CODE_REDIS_PREFIX}send:${pool}:${tag}:${windowSeconds}`;
    if ((await redisSecondaryStorage.increment(key, windowSeconds)) > max) return false;
  }
  return true;
};

/** True when this sign-in attempt is within the daily per-address cap. Counted before the code is checked. */
export const consumeEmailCodeVerifyQuota = async (tag: string, pool: TEmailCodePool): Promise<boolean> => {
  const { windowSeconds, max } = EMAIL_CODE_VERIFY_LIMIT;
  const key = `${EMAIL_CODE_REDIS_PREFIX}verify:${pool}:${tag}`;
  return (await redisSecondaryStorage.increment(key, windowSeconds)) <= max;
};
