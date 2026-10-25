import { useEffect, useState } from "react";
import { Flag, ScrollText, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SettingsSection } from "@/components/SettingsSection";
import {
  apiGetModerationSettings,
  apiUpdateModerationSettings,
  type AutomodSettings,
  type RoomModerationSettings,
} from "@/lib/api";

const DEFAULT_AUTOMOD: AutomodSettings = {
  enabled: false,
  blocked_words: [],
  block_links: false,
  block_invites: false,
  max_mentions: 0,
  block_repeats: false,
  timeout_secs: 0,
};

const AUTOMOD_TIMEOUTS: { label: string; secs: number }[] = [
  { label: "Only block the message", secs: 0 },
  { label: "Block and time out 1 minute", secs: 60 },
  { label: "Block and time out 10 minutes", secs: 10 * 60 },
  { label: "Block and time out 1 hour", secs: 60 * 60 },
  { label: "Block and time out 1 day", secs: 24 * 60 * 60 },
];

function ToggleRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <Label className="text-sm">{label}</Label>
        {hint && <p className="ui-hint">{hint}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

/**
 * The owner's moderation settings: rules and the gate in front of them,
 * whether members can report messages, and automod. Saved on its own button
 * rather than with the dialog's — these change what every member is held to,
 * so they are worth a deliberate save.
 */
export function ModerationSettingsPanel({ roomId }: { roomId: string }) {
  const [loaded, setLoaded] = useState<RoomModerationSettings | null>(null);
  const [rules, setRules] = useState("");
  const [rulesRequired, setRulesRequired] = useState(false);
  const [reportsEnabled, setReportsEnabled] = useState(true);
  const [automod, setAutomod] = useState<AutomodSettings>(DEFAULT_AUTOMOD);
  // Edited as text, one entry per line or comma, so pasting a list works.
  const [wordsText, setWordsText] = useState("");
  const [saving, setSaving] = useState(false);

  const adopt = (s: Partial<RoomModerationSettings>) => {
    const full: RoomModerationSettings = {
      rules: s.rules ?? "",
      rules_required: !!s.rules_required,
      reports_enabled: s.reports_enabled !== false,
      automod: { ...DEFAULT_AUTOMOD, ...(s.automod ?? {}) },
    };
    setLoaded(full);
    setRules(full.rules);
    setRulesRequired(full.rules_required);
    setReportsEnabled(full.reports_enabled);
    setAutomod(full.automod);
    setWordsText(full.automod.blocked_words.join("\n"));
  };

  useEffect(() => {
    let cancelled = false;
    apiGetModerationSettings(roomId)
      .then((s) => {
        if (!cancelled) adopt(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) toast.error(e instanceof Error ? e.message : "Failed to load moderation settings");
      });
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  const save = async () => {
    setSaving(true);
    try {
      const blocked_words = wordsText
        .split(/[\n,]/)
        .map((w) => w.trim())
        .filter(Boolean);
      const saved = await apiUpdateModerationSettings(roomId, {
        rules,
        rules_required: rulesRequired,
        reports_enabled: reportsEnabled,
        automod: { ...automod, blocked_words },
      });
      adopt(saved);
      toast.success("Moderation settings saved");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save moderation settings");
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) {
    return <p className="text-xs text-muted-foreground py-2">Loading moderation settings…</p>;
  }

  const setAm = (change: Partial<AutomodSettings>) => setAutomod((prev) => ({ ...prev, ...change }));

  return (
    <div className="space-y-3">
      <SettingsSection
        title="Rules"
        icon={ScrollText}
        description="Shown to members from the room menu. Markdown works."
      >
        <Textarea
          value={rules}
          onChange={(e) => setRules(e.target.value)}
          placeholder={"1. Be kind.\n2. No spam or self-promotion.\n3. Keep it on topic."}
          maxLength={8000}
          className="min-h-28 max-h-64 text-sm"
        />
        <ToggleRow
          label="Members must accept the rules"
          hint="Until they do, members can read but not post, react or join voice. Owners and moderators are exempt. Needs rules to be written."
          checked={rulesRequired}
          onChange={setRulesRequired}
        />
      </SettingsSection>

      <SettingsSection title="Reports" icon={Flag}>
        <ToggleRow
          label="Members can report messages"
          hint="Reports go to a queue that owners and moderators review."
          checked={reportsEnabled}
          onChange={setReportsEnabled}
        />
      </SettingsSection>

      <SettingsSection
        title="Automod"
        icon={ShieldAlert}
        description="Checks every message before it is posted. Anyone who can manage messages is exempt."
      >
        <ToggleRow label="Enable automod" checked={automod.enabled} onChange={(v) => setAm({ enabled: v })} />
        <div className={automod.enabled ? "space-y-3" : "space-y-3 opacity-50 pointer-events-none"}>
          <div className="space-y-1">
            <Label className="text-sm">Blocked words</Label>
            <p className="ui-hint">
              One per line. Matched as whole words, ignoring case; end a word with * to match anything starting with it. Only moderators can see this list.
            </p>
            <Textarea
              value={wordsText}
              onChange={(e) => setWordsText(e.target.value)}
              placeholder={"badword\nscam*"}
              className="min-h-20 max-h-48 font-mono text-xs"
            />
          </div>
          <ToggleRow
            label="Block links"
            hint="Any message containing a web address."
            checked={automod.block_links}
            onChange={(v) => setAm({ block_links: v })}
          />
          <ToggleRow
            label="Block invite links"
            hint="Invites to other Chatter rooms and to Discord servers."
            checked={automod.block_invites}
            onChange={(v) => setAm({ block_invites: v })}
          />
          <ToggleRow
            label="Block repeated messages"
            hint="The same message sent again within a minute."
            checked={automod.block_repeats}
            onChange={(v) => setAm({ block_repeats: v })}
          />
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <Label className="text-sm">Mention limit</Label>
              <p className="ui-hint">The most @mentions one message may have. 0 is no limit.</p>
            </div>
            <Input
              type="number"
              min={0}
              max={100}
              value={automod.max_mentions}
              onChange={(e) => setAm({ max_mentions: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
              className="w-20 text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-sm">When a message is blocked</Label>
            <select
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              value={automod.timeout_secs}
              onChange={(e) => setAm({ timeout_secs: Number(e.target.value) })}
            >
              {AUTOMOD_TIMEOUTS.map((t) => (
                <option key={t.secs} value={t.secs}>{t.label}</option>
              ))}
            </select>
          </div>
        </div>
      </SettingsSection>

      <div className="flex justify-end">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save moderation settings"}
        </Button>
      </div>
    </div>
  );
}
