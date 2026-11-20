import { useEffect, useState } from "react";

/**
 * A countdown in whole seconds for "Resend code": `start()` arms it, it ticks to zero once a second, and
 * `seconds > 0` means resending is not offered yet.
 */
export const useResendCooldown = (durationSeconds: number) => {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (seconds <= 0) return;
    const timeout = setTimeout(() => setSeconds((remaining) => remaining - 1), 1000);
    return () => clearTimeout(timeout);
  }, [seconds]);

  return {
    seconds,
    start: () => setSeconds(durationSeconds),
    reset: () => setSeconds(0),
  };
};
