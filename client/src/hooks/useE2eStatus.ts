import { useSyncExternalStore } from "react";
import { getE2eStatus, subscribeE2e, type E2eStatus } from "@chatter/core/e2e/session";

/** Where this device stands with end-to-end encryption (see e2e/session.ts). */
export function useE2eStatus(): E2eStatus {
  return useSyncExternalStore(subscribeE2e, getE2eStatus);
}
