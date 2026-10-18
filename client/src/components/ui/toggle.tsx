"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Toggle as TogglePrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { both, toggle } from "@chatter/core/ui/recipes"

const toggleVariants = cva(
  // The look is shared with the mobile app (@chatter/core/ui/recipes).
  `inline-flex items-center justify-center gap-2 ${both(toggle.base)} hover:bg-muted hover:text-muted-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none transition-[color,box-shadow] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive whitespace-nowrap`,
  {
    variants: {
      variant: {
        default: both(toggle.variant.default),
        outline:
          `${both(toggle.variant.outline)} shadow-xs hover:bg-accent hover:text-accent-foreground`,
      },
      size: {
        default: both(toggle.size.default),
        sm: both(toggle.size.sm),
        lg: both(toggle.size.lg),
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Toggle({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Root> &
  VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive.Root
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Toggle, toggleVariants }
