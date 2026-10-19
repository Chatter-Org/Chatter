import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"
import { both, button } from "@chatter/core/ui/recipes"

const buttonVariants = cva(
  // The look is shared with the mobile app (@chatter/core/ui/recipes); what
  // follows it here is the web's own: layout, hover, focus and svg sizing.
  `inline-flex items-center justify-center gap-2 whitespace-nowrap ${both(button.base)} transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive`,
  {
    variants: {
      variant: {
        default: `${both(button.variant.default)} hover:bg-primary/90`,
        destructive:
          `${both(button.variant.destructive)} hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60`,
        outline:
          `${both(button.variant.outline)} shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50`,
        secondary:
          `${both(button.variant.secondary)} hover:bg-secondary/80`,
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: `${both(button.variant.link)} underline-offset-4 hover:underline`,
      },
      size: {
        default: `${both(button.size.default)} py-2 has-[>svg]:px-3`,
        xs: `${both(button.size.xs)} has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3`,
        sm: `${both(button.size.sm)} has-[>svg]:px-2.5`,
        lg: `${both(button.size.lg)} has-[>svg]:px-4`,
        icon: both(button.size.icon),
        "icon-xs": `${both(button.size["icon-xs"])} [&_svg:not([class*='size-'])]:size-3`,
        "icon-sm": both(button.size["icon-sm"]),
        "icon-lg": both(button.size["icon-lg"]),
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
