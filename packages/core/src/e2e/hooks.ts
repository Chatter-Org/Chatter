/**
 * How `api.ts` reaches end-to-end encryption without importing it.
 *
 * The session (`e2e/session.ts`) needs the API to fetch keys, and the API
 * needs the session to seal what it sends and open what it loads. Importing
 * each other would be a cycle, so the session installs itself here instead.
 * Until it does, nothing is sealed or opened: a send into an encrypted room is
 * refused by the server, and a loaded one shows its placeholder.
 */

import type { SealedMessage } from "./crypto";

/**
 * How opening an encrypted message went, stamped on its content.
 *
 * - `ok`: opened, and signed by its sender.
 * - `unverified`: opened, but the signature does not match the sender's
 *   current keys (they have reset them since, or it was forged).
 * - `locked`: this device has not unlocked encryption.
 * - `missing`: no key for it here — sent before this account joined, or the
 *   key has not reached this device yet.
 * - `broken`: the key is here and it still does not open.
 */
export type E2eMessageState = "ok" | "unverified" | "locked" | "missing" | "broken";

export interface SealedSend {
  e2e: SealedMessage;
  /** Upload links in the text, sent beside it in the clear so the server
   *  keeps the files (uploads are not encrypted yet). */
  attachments: string[];
}

export interface MessageCrypto {
  /** The sealed form of `body` for this room, or null to send it as it is. */
  seal(roomId: string, body: string, inReplyTo?: string): Promise<SealedSend | null>;
  /** The server refused a send with `errcode`. Whether something has been
   *  done about it (a new key fetched or made) that makes a retry worth it. */
  recover(roomId: string, errcode: string | undefined): Promise<boolean>;
  /** These messages from this room, with any sealed ones opened. */
  open<T>(roomId: string, events: T[]): Promise<T[]>;
}

const passthrough: MessageCrypto = {
  seal: async () => null,
  recover: async () => false,
  open: async (_roomId, events) => events,
};

let current: MessageCrypto = passthrough;

export function configureMessageCrypto(crypto: MessageCrypto): void {
  current = crypto;
}

export function messageCrypto(): MessageCrypto {
  return current;
}
