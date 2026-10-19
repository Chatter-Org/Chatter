import { useSyncExternalStore } from "react";
import {
  configureOutgoingPreviews,
  outgoingUploads,
  subscribeOutgoing,
  type OutgoingBatch,
} from "@chatter/core/outgoingUploads";

/**
 * Sends with attachments still on their way (the shared queue in
 * @chatter/core/outgoingUploads). They outlive the composer: switch channel
 * mid-upload and the message still lands where it was written.
 */
export function useOutgoingUploads(): OutgoingBatch[] {
  return useSyncExternalStore(subscribeOutgoing, outgoingUploads, outgoingUploads);
}

// A phone's staged file already has a path the image view can read, so the
// preview is the file itself; there is nothing to release.
configureOutgoingPreviews({
  make: (file) => {
    const part = "part" in file && typeof file.part === "function" ? file.part() : null;
    if (part && "uri" in part && /^(image|video)\//.test(part.type)) return part.uri;
    return null;
  },
  release: () => {},
});
