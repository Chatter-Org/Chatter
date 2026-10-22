import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** A shaded group of related settings. The room settings dialog had grown
 *  past the point where a flat column of controls could be read: tabs
 *  separated the broad areas, but within a tab a toggle for the public room
 *  list sat in the same undifferentiated stack as a password field. Each
 *  group gets a card with a heading, so the eye can find the boundary before
 *  it reads the labels. */
export function SettingsSection({
  title,
  description,
  icon: Icon,
  action,
  className,
  children,
}: {
  title: string;
  description?: string;
  icon?: LucideIcon;
  /** Rendered at the far right of the heading row — a "Create" button that
   *  belongs to the group as a whole rather than to any one control. */
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "space-y-3 rounded-lg border border-border/40 bg-muted/20 p-3",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h3 className="ui-heading flex items-center gap-1.5">
            {Icon && <Icon className="w-3.5 h-3.5 shrink-0" />}
            {title}
          </h3>
          {description && <p className="ui-hint">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}
