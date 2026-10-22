import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiListReports, apiResolveReport, type MessageReport } from "@/lib/api";
import { useAppContext } from "@/lib/store";
import { displayUserId } from "@/lib/utils";
import { OPEN_REPORTS_EVENT } from "./moderationUtils";

type View = "open" | "closed";

function when(ts: number) {
  return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * The moderators' queue of reported messages for one room. Mounted once in
 * the layout and opened by `showReports` or the "new report" toast.
 */
export function ReportsPanel() {
  const { state, openMessage, openThread } = useAppContext();
  const [roomId, setRoomId] = useState<string | null>(null);
  const [view, setView] = useState<View>("open");
  const [items, setItems] = useState<MessageReport[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const open = (e: Event) => {
      const id = (e as CustomEvent<{ roomId?: string }>).detail?.roomId;
      if (!id) return;
      setRoomId(id);
      setView("open");
    };
    window.addEventListener(OPEN_REPORTS_EVENT, open);
    return () => window.removeEventListener(OPEN_REPORTS_EVENT, open);
  }, []);

  const load = useCallback(async (room: string, which: View, offset: number) => {
    setLoading(true);
    try {
      const data = await apiListReports(room, { status: which, offset, limit: 25 });
      setItems((prev) => (offset === 0 ? data.items : [...prev, ...data.items]));
      setHasMore(data.has_more);
      setNextOffset(data.next_offset);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to load reports");
    } finally {
      setLoading(false);
    }
  }, []);

  // Reloaded when the open count moves too: a report filed, or closed by
  // another moderator, while this is on screen.
  const openCount = roomId ? (state.reportCounts[roomId] ?? 0) : 0;
  const refreshKey = view === "open" ? openCount : -1;
  useEffect(() => {
    if (roomId) void load(roomId, view, 0);
  }, [roomId, view, refreshKey, load]);

  const close = async (report: MessageReport, status: "resolved" | "dismissed", deleteMessage: boolean) => {
    if (!roomId) return;
    setBusy(report.report_id);
    try {
      await apiResolveReport(roomId, report.report_id, status, deleteMessage);
      // Every open report of the same message closes with it.
      setItems((prev) => prev.filter((r) => r.event_id !== report.event_id));
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to close the report");
    } finally {
      setBusy(null);
    }
  };

  const jump = (report: MessageReport) => {
    if (!roomId) return;
    setRoomId(null);
    if (report.thread_id) {
      // A thread reply lives in its thread; open that, in its room.
      void openMessage({ roomId, eventId: report.thread_id, channelId: report.channel_id || null, ts: report.message_ts })
        .then(() => openThread(report.thread_id));
      return;
    }
    void openMessage({ roomId, eventId: report.event_id, channelId: report.channel_id || null, ts: report.message_ts });
  };

  const roomName = roomId ? state.roomInfoMap[roomId]?.name : "";

  return (
    <Dialog open={!!roomId} onOpenChange={(open) => !open && setRoomId(null)}>
      <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>Reports{roomName ? ` · ${roomName}` : ""}</DialogTitle>
          <DialogDescription>
            Messages members have flagged. Closing a report closes every report of the same message.
          </DialogDescription>
        </DialogHeader>
        <Tabs value={view} onValueChange={(v) => setView(v as View)} className="shrink-0">
          <TabsList className="w-full">
            <TabsTrigger value="open" className="flex-1">Open{openCount ? ` (${openCount})` : ""}</TabsTrigger>
            <TabsTrigger value="closed" className="flex-1">Closed</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {items.length === 0 && !loading && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {view === "open" ? "Nothing to review." : "No closed reports yet."}
            </p>
          )}
          {items.map((r) => (
            <div key={r.report_id} className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 p-2.5 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                <span className="font-medium">{displayUserId(r.reported_user)}</span>
                <span className="text-xs text-muted-foreground">
                  reported by {displayUserId(r.reporter)} · {when(r.created_at)}
                </span>
              </div>
              {r.reason && <p className="text-xs"><span className="text-muted-foreground">Reason:</span> {r.reason}</p>}
              <blockquote className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-border pl-2 text-xs text-muted-foreground">
                {r.body || "(no text)"}
              </blockquote>
              {view === "closed" ? (
                <p className="text-xs text-muted-foreground">
                  {r.status === "dismissed" ? "Dismissed" : "Resolved"}
                  {r.message_deleted ? ", message deleted" : ""}
                  {r.resolved_by ? ` by ${displayUserId(r.resolved_by)}` : ""}
                  {r.resolved_at ? ` · ${when(r.resolved_at)}` : ""}
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {r.message_exists ? (
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => jump(r)}>
                      Go to message
                    </Button>
                  ) : (
                    <span className="self-center text-xs text-muted-foreground">Message already deleted</span>
                  )}
                  {r.message_exists && (
                    <Button
                      size="sm"
                      variant="destructive"
                      className="h-7 text-xs"
                      disabled={busy === r.report_id}
                      onClick={() => void close(r, "resolved", true)}
                    >
                      Delete message
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={busy === r.report_id}
                    onClick={() => void close(r, "resolved", false)}
                    title="Mark as handled — for when you dealt with it another way, such as a timeout"
                  >
                    Mark resolved
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    disabled={busy === r.report_id}
                    onClick={() => void close(r, "dismissed", false)}
                  >
                    Dismiss
                  </Button>
                </div>
              )}
            </div>
          ))}
          {hasMore && roomId && (
            <Button variant="outline" size="sm" disabled={loading} onClick={() => void load(roomId, view, nextOffset)}>
              {loading ? "Loading…" : "Load more"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
