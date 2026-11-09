import { useSyncExternalStore } from "react";
import { getUnsavedRecoveryKey, subscribeE2e } from "@chatter/core/e2e/session";

/** The recovery key made for this account, until it has been kept. */
export function useUnsavedRecoveryKey(): string | null {
  return useSyncExternalStore(subscribeE2e, getUnsavedRecoveryKey);
}
