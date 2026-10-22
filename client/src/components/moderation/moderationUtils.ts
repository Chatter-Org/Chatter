/** "3:45 PM", or "Oct 24, 3:45 PM" when it is not today. */
export function formatTimeoutEnd(ts: number): string {
  const end = new Date(ts);
  const sameDay = end.toDateString() === new Date().toDateString();
  return end.toLocaleString(undefined, sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Whoever wants the rules on screen — the composer's notice, the room menu —
 *  asks through this rather than each holding a dialog of its own. The one
 *  `RulesDialog` in the layout listens. */
const rulesListeners = new Set<() => void>();
export function showRoomRules() {
  for (const listener of rulesListeners) listener();
}
export function onShowRoomRules(listener: () => void): () => void {
  rulesListeners.add(listener);
  return () => {
    rulesListeners.delete(listener);
  };
}

export interface ReportTarget {
  roomId: string;
  eventId: string;
  senderName: string;
}

/** Ask the one `ReportDialog` in the layout to report a message. Messages are
 *  memoized and numerous, so none of them holds a dialog of its own. */
const reportListeners = new Set<(target: ReportTarget) => void>();
export function showReportDialog(target: ReportTarget) {
  for (const listener of reportListeners) listener(target);
}
export function onShowReportDialog(listener: (target: ReportTarget) => void): () => void {
  reportListeners.add(listener);
  return () => {
    reportListeners.delete(listener);
  };
}

/** Open the moderators' report queue for a room. The same event the core
 *  socket handler emits from a "new report" toast, so both routes land in
 *  one place. */
export const OPEN_REPORTS_EVENT = "chatter:open-reports";
export function showReports(roomId: string) {
  window.dispatchEvent(new CustomEvent(OPEN_REPORTS_EVENT, { detail: { roomId } }));
}
