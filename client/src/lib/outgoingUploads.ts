// The queue moved to the shared core; this adds what only a browser has.
import { useSyncExternalStore } from "react";
import {
  configureOutgoingPreviews,
  outgoingUploads,
  subscribeOutgoing,
  type OutgoingBatch,
} from "@chatter/core/outgoingUploads";
import { isPreviewable } from "@/hooks/usePendingFiles";

export * from "@chatter/core/outgoingUploads";

// Pictures and videos show while they upload, from an object URL that is let
// go when the batch is.
configureOutgoingPreviews({
  make: (file) => (file instanceof File && isPreviewable(file) ? URL.createObjectURL(file) : null),
  release: (url) => URL.revokeObjectURL(url),
});

/** Every send still on its way, wherever it is going. */
export function useOutgoingUploads(): OutgoingBatch[] {
  return useSyncExternalStore(subscribeOutgoing, outgoingUploads, outgoingUploads);
}
