import type { ComponentProps } from "react";
import { T } from "@/ui/primitives";
import { useNameFont } from "@/ui/nameFonts";

/** Someone's name in their own font (useNameFont), where they have one. */
export function NameText({ fontUrl, style, ...props }: ComponentProps<typeof T> & { fontUrl?: string | null }) {
  const nameFont = useNameFont(fontUrl);
  return <T {...props} style={[style, nameFont]} />;
}
