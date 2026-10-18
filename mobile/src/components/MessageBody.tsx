import { Fragment, memo, useMemo } from "react";
import { Linking, ScrollView, View } from "react-native";
import { Image } from "expo-image";
import { parseBody, type FormatOptions, type InlineNode } from "@chatter/core/messageFormat";
import { T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { serverImage } from "@/ui/media";
import { useTheme } from "@/theme/ThemeProvider";

/** The web's message text below 768px: 0.8125rem at 1.45 (index.css). */
export const BODY_TEXT = "text-[14.3px] leading-[21px]";

/**
 * A message body in Chatter's format (see @chatter/core/messageFormat): the
 * same parse the web draws as HTML, drawn here as native text.
 */
export const MessageBody = memo(function MessageBody({
  body,
  options,
  edited,
}: {
  body: string;
  options: FormatOptions;
  edited?: boolean;
}) {
  const blocks = useMemo(() => parseBody(body, options), [body, options]);
  return (
    <View className="gap-1.5">
      {blocks.map((block, i) =>
        block.type === "code" ? (
          // CodeBlock.tsx: GitHub's dark, whatever the theme.
          <ScrollView key={i} horizontal className="my-1 rounded-md bg-[#0d1117]" contentContainerClassName="p-3">
            <T selectable className="text-sm text-[#e6edf3]">
              {block.code.replace(/\n$/, "")}
            </T>
          </ScrollView>
        ) : (
          <T key={i} selectable className={BODY_TEXT}>
            <Inline nodes={block.children} />
            {edited && i === blocks.length - 1 ? <T className="text-2xs text-muted-foreground/80"> (edited)</T> : null}
          </T>
        ),
      )}
      {edited && blocks[blocks.length - 1]?.type === "code" ? <T className="text-2xs text-muted-foreground/80">(edited)</T> : null}
    </View>
  );
});

function Inline({ nodes }: { nodes: InlineNode[] }) {
  const { colors } = useTheme();
  return (
    <>
      {nodes.map((node, i) => {
        switch (node.type) {
          case "text":
            return <Fragment key={i}>{node.text}</Fragment>;
          case "bold":
            return (
              <T key={i} className={cn(BODY_TEXT, "font-bold")}>
                <Inline nodes={node.children} />
              </T>
            );
          case "italic":
            return (
              <T key={i} className={cn(BODY_TEXT, "italic")}>
                <Inline nodes={node.children} />
              </T>
            );
          case "strobe":
            // The web cycles hues; a static accent reads the same intent
            // without animating every message in a long scroll.
            return (
              <T key={i} className={cn(BODY_TEXT, "font-bold")} style={{ color: colors["chart-4"] }}>
                <Inline nodes={node.children} />
              </T>
            );
          case "mention": {
            const roleColor = node.kind === "role" && node.color ? normalizeHex(node.color) : null;
            return (
              <T
                key={i}
                // The web's pill: you in blue, others in the primary colour,
                // a role in its own.
                className={cn(
                  "rounded text-xs font-semibold",
                  !roleColor && (node.self ? "bg-blue-500/20 text-blue-400" : "bg-primary/20 text-primary"),
                )}
                style={roleColor ? { color: roleColor, backgroundColor: roleColor + "33" } : undefined}
              >
                {" "}@{node.name}{" "}
              </T>
            );
          }
          case "link":
            return (
              <T
                key={i}
                className={cn(BODY_TEXT, "text-primary")}
                onPress={() => void Linking.openURL(node.url)}
                accessibilityRole="link"
                suppressHighlighting
              >
                {node.display}
              </T>
            );
          case "emoji": {
            const source = serverImage(node.url);
            return source ? (
              <Image key={i} source={source} style={{ width: 20, height: 20 }} contentFit="contain" accessibilityLabel={node.alias ? `:${node.alias}:` : "emoji"} />
            ) : null;
          }
        }
      })}
    </>
  );
}

function normalizeHex(color: string): string {
  return color.startsWith("#") ? color : `#${color}`;
}
