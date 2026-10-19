import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

// Ledger buttons — pill-shaped since redesign v2, so icon sizes are round. The .btn-* classes live in globals.css so markup that never
// moved to this component (`className="btn btn-v"`) looks identical.
//
// Variants: primary · secondary · ghost · destructive · link.
// `default` and `outline` are the pre-redesign names, kept as aliases so no
// call site has to change.
const buttonVariants = cva(
  "btn group/button relative [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 aria-invalid:border-danger",
  {
    variants: {
      variant: {
        primary: "btn-v",
        default: "btn-v",
        secondary: "btn-o",
        outline: "btn-o",
        ghost: "btn-g",
        destructive: "btn-r",
        link: "h-auto! px-0! text-accent-text underline underline-offset-[3px] decoration-[color-mix(in_srgb,currentColor_40%,transparent)] hover:decoration-current",
      },
      size: {
        sm: "h-8! px-3.5! text-xs!",
        md: "",
        default: "",
        lg: "h-11! px-5! text-sm!",
        xs: "h-6! px-2! text-xs! [&_svg:not([class*='size-'])]:size-3.5",
        icon: "size-9! p-0!",
        "icon-xs": "size-6! p-0! [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "size-8! p-0!",
        "icon-lg": "size-11! p-0!",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

type ButtonProps = ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & {
    /** Shows a spinner in place of the label, keeping the button's width. */
    loading?: boolean
  }

function Button({
  className,
  variant = "default",
  size = "default",
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      data-loading={loading || undefined}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      {loading ? (
        <>
          {/* The label stays in the layout (invisible) so the width holds. */}
          <span className="invisible inline-flex items-center gap-1.5">{children as ReactNode}</span>
          <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
            <span className="size-3.5 rounded-full border-[1.5px] border-current border-r-transparent animate-spin" />
          </span>
        </>
      ) : (
        children as ReactNode
      )}
    </ButtonPrimitive>
  )
}

export { Button, buttonVariants }
