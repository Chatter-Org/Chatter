import { useSyncExternalStore } from "react";
import { hasShare, onShare, takeShare, type IncomingShare } from "../../modules/chatter-share";
import type { PickedFile } from "./uploads";
import { showToast } from "./toast";

/**
 * What another app shared into Chatter, on its way to a conversation.
 *
 * Two small stores. The first holds the share while the person picks where it
 * goes (/share); the second holds it for the composer of the conversation they
 * picked, which takes it into its box and its attachments the next time it is
 * on screen. Nothing is sent without them: a share is a message they finish.
 */

function store<T>() {
  let value: T | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T | null) {
      value = next;
      for (const l of listeners) l();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** A share as the composer takes it. */
export interface SharedContent {
  text: string;
  files: PickedFile[];
}

/** A share on its way to one conversation's composer. */
export interface AddressedShare extends SharedContent {
  roomId: string;
  /** Empty for a conversation chosen as a whole (a DM): whichever channel it opens on. */
  channelId: string;
}

const incoming = store<SharedContent>();
const forComposer = store<AddressedShare>();

function toContent(share: IncomingShare): SharedContent | null {
  // A link shared from a browser comes as its page's title and the link; the
  // link is what is worth sending, the title only when it is not already in it.
  const text = [share.subject && !share.text?.includes(share.subject) ? share.subject : null, share.text]
    .filter(Boolean)
    .join("\n")
    .trim();
  const files = share.files.map((f) => ({ uri: f.uri, name: f.name, type: f.type, size: f.size }));
  return text || files.length > 0 ? { text, files } : null;
}

async function collect() {
  if (!hasShare()) return;
  const share = await takeShare().catch(() => null);
  const content = share ? toContent(share) : null;
  if (share?.failed) {
    showToast({
      tone: "error",
      message: content ? `Couldn't read ${share.failed} of the shared files` : "Couldn't read what was shared",
      description: "The app it came from may not have allowed it.",
    });
  }
  if (content) incoming.set(content);
}

/**
 * Listen for shares: the one that started the app, if any, and any that come
 * while it runs. Call once signed in. Returns the unsubscribe.
 */
export function listenForShares(): () => void {
  void collect();
  return onShare(() => void collect());
}

/** The share waiting for a conversation, if there is one. */
export function useIncomingShare(): SharedContent | null {
  return useSyncExternalStore(incoming.subscribe, incoming.get);
}

/** Put the share away: sent on to a composer, or let go. */
export function dropIncomingShare(): void {
  incoming.set(null);
}

/** Hand the share to the composer of the conversation it is going to. */
export function handShareToComposer(content: SharedContent, roomId: string, channelId: string): void {
  incoming.set(null);
  forComposer.set({ ...content, roomId, channelId });
}

/** The share this conversation's composer is to take, if one was handed to it. */
export function useShareForComposer(roomId: string | null, channelId: string): AddressedShare | null {
  const share = useSyncExternalStore(forComposer.subscribe, forComposer.get);
  return share && share.roomId === roomId && (!share.channelId || share.channelId === channelId) ? share : null;
}

/** The composer has it now. */
export function takeShareForComposer(): void {
  forComposer.set(null);
}
