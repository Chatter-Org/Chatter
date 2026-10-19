import { memo, useMemo, useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { Image } from "expo-image";
import { ChevronDown } from "lucide-react-native";
import type { Embed, EmbedSelect } from "@chatter/core/api";
import { DEFAULT_EMBED_COLOR, embedActionRows, embedSelectRows } from "@chatter/core/embeds";
import { useChatterActions } from "@/state/ChatterProvider";
import { useDevicePrefs } from "@/state/devicePrefs";
import { Sheet } from "@/ui/Sheet";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { serverImage } from "@/ui/media";
import { UI_META } from "@/ui/roles";
import { Tap } from "./Tap";

/** The web's button colours for each style (EmbedCard's actionStyleClasses). */
const ACTION_STYLE: Record<string, { box: string; text: string }> = {
  primary: { box: "bg-indigo-500", text: "text-white" },
  secondary: { box: "bg-secondary", text: "text-secondary-foreground" },
  success: { box: "bg-emerald-600", text: "text-white" },
  danger: { box: "bg-red-600", text: "text-white" },
};

const open = (url?: string) => url && void Linking.openURL(url).catch(() => {});

/**
 * A bot's rich embed — the web's EmbedCard: the coloured edge, author, title
 * (a link when it has a url), description, fields (inline ones two abreast),
 * thumbnail, image, footer and time, then the bot's buttons and select menus,
 * which answer through the socket (`embedInteraction`). A select opens as a
 * sheet, as menus do on the phone.
 */
export const EmbedCard = memo(function EmbedCard({ embed, eventId }: { embed: Embed; eventId: string }) {
  const { embedInteraction } = useChatterActions();
  const { autoplayAnimated } = useDevicePrefs();
  const [selecting, setSelecting] = useState<EmbedSelect | null>(null);
  const actionRows = useMemo(() => embedActionRows(embed.actions), [embed.actions]);
  const selectRows = useMemo(() => embedSelectRows(embed.selects), [embed.selects]);
  const thumb = serverImage(embed.thumbnail?.url);
  const image = serverImage(embed.image?.url);
  const [aspect, setAspect] = useState(16 / 9);

  // Inline fields sit two abreast; a field that is not inline takes the row.
  const fieldRows = useMemo(() => {
    const rows: NonNullable<Embed["fields"]>[] = [];
    for (const field of embed.fields ?? []) {
      const last = rows[rows.length - 1];
      if (field.inline && last && last.length === 1 && last[0].inline) last.push(field);
      else rows.push([field]);
    }
    return rows;
  }, [embed.fields]);

  return (
    <View className="mt-1 flex-row overflow-hidden rounded" style={{ maxWidth: 572, borderLeftWidth: 4, borderLeftColor: embed.color || DEFAULT_EMBED_COLOR }}>
      <View className="min-w-0 flex-1 gap-2 bg-secondary/50 p-3">
        {embed.author ? (
          <View className="flex-row items-center gap-1.5">
            {embed.author.icon_url ? <Image source={serverImage(embed.author.icon_url)} style={{ width: 20, height: 20, borderRadius: 10 }} /> : null}
            {embed.author.url ? (
              <Tap onPress={() => open(embed.author?.url)} label={embed.author.name}>
                <T className="text-xs font-semibold underline">{embed.author.name}</T>
              </Tap>
            ) : (
              <T className="text-xs font-semibold">{embed.author.name}</T>
            )}
          </View>
        ) : null}

        <View className="flex-row gap-3">
          <View className="min-w-0 flex-1 gap-0.5">
            {embed.title ? (
              embed.url ? (
                <Tap onPress={() => open(embed.url)} label={embed.title} className="self-start rounded">
                  <T className="text-sm font-semibold text-primary">{embed.title}</T>
                </Tap>
              ) : (
                <T className="text-sm font-semibold">{embed.title}</T>
              )
            ) : null}
            {embed.description ? <T className="text-sm text-muted-foreground">{embed.description}</T> : null}
            {fieldRows.length > 0 ? (
              <View className="mt-1.5 gap-1.5">
                {fieldRows.map((row, i) => (
                  <View key={i} className="flex-row gap-2">
                    {row.map((field, j) => (
                      <View key={j} className="min-w-0 flex-1">
                        <T className="text-xs font-semibold">{field.name}</T>
                        <T className="text-xs text-muted-foreground">{field.value}</T>
                      </View>
                    ))}
                  </View>
                ))}
              </View>
            ) : null}
          </View>
          {thumb ? <Image source={thumb} style={{ width: 64, height: 64, borderRadius: 4, marginTop: 2 }} contentFit="cover" autoplay={autoplayAnimated} /> : null}
        </View>

        {image ? (
          <Image
            source={image}
            onLoad={(e) => e.source.width && e.source.height && setAspect(e.source.width / e.source.height)}
            style={{ width: "100%", aspectRatio: aspect, borderRadius: 4 }}
            contentFit="cover"
            autoplay={autoplayAnimated}
          />
        ) : null}

        {embed.footer || embed.timestamp ? (
          <View className="flex-row flex-wrap items-center gap-1.5">
            {embed.footer?.icon_url ? <Image source={serverImage(embed.footer.icon_url)} style={{ width: 16, height: 16, borderRadius: 8 }} /> : null}
            {embed.footer?.text ? <T className={UI_META}>{embed.footer.text}</T> : null}
            {embed.footer?.text && embed.timestamp ? <T className={UI_META}>·</T> : null}
            {embed.timestamp ? <T className={UI_META}>{new Date(embed.timestamp).toLocaleString()}</T> : null}
          </View>
        ) : null}

        {actionRows.map((row, i) => (
          <View key={`a${i}`} className="flex-row flex-wrap gap-1">
            {row.map((action) => {
              const look = ACTION_STYLE[action.style ?? "secondary"] ?? ACTION_STYLE.secondary;
              return (
                <Tap
                  key={action.id}
                  disabled={action.disabled}
                  onPress={() => embedInteraction(eventId, action.id, "button")}
                  label={action.label}
                  className={cn("min-h-9 flex-row items-center gap-1 rounded px-3 py-1.5", look.box, action.disabled && "opacity-50")}
                >
                  {action.emoji ? <T className="text-sm">{action.emoji}</T> : null}
                  <T className={cn("text-sm font-medium", look.text)}>{action.label}</T>
                </Tap>
              );
            })}
          </View>
        ))}

        {selectRows.map((row, i) => (
          <View key={`s${i}`} className="gap-1">
            {row.map((sel) => (
              <Tap
                key={sel.id}
                disabled={sel.disabled}
                onPress={() => setSelecting(sel)}
                label={sel.placeholder || "Select"}
                className={cn("min-h-9 flex-row items-center rounded border border-border bg-background px-2 py-1.5", sel.disabled && "opacity-50")}
              >
                <T className="flex-1 text-sm text-muted-foreground" numberOfLines={1}>
                  {sel.placeholder || "Select..."}
                </T>
                <Icon as={ChevronDown} size={14} />
              </Tap>
            ))}
          </View>
        ))}
      </View>

      <Sheet open={!!selecting} onClose={() => setSelecting(null)} title={selecting?.placeholder || "Select"}>
        <View className="pb-2">
          {selecting?.options.map((opt) => (
            <Pressable
              key={opt.value}
              onPress={() => {
                embedInteraction(eventId, selecting.id, "select", [opt.value]);
                setSelecting(null);
              }}
              accessibilityRole="button"
              className="flex-row items-center gap-3 px-4 py-3 active:bg-accent"
            >
              {opt.emoji ? <T className="text-base">{opt.emoji}</T> : null}
              <View className="min-w-0 flex-1">
                <T className="text-sm">{opt.label}</T>
                {opt.description ? <T className="text-xs text-muted-foreground">{opt.description}</T> : null}
              </View>
            </Pressable>
          ))}
        </View>
      </Sheet>
    </View>
  );
});
