/**
 * Owns browser-native select semantics for large option sets and platform
 * pickers that should not use the custom Radix menu interaction.
 */

import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "../../lib/utils";

const nativeSelectVariants = cva(
  "min-h-10 border border-input bg-bg px-3 text-sm text-txt transition-colors disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      presentation: {
        default: "w-full rounded-sm",
        touch: "min-h-touch w-full rounded-sm text-base",
        compact:
          "h-8 w-full rounded-md bg-background px-2 text-base sm:text-xs",
        overlay:
          "absolute inset-0 size-full cursor-pointer appearance-none border-0 bg-transparent opacity-0",
      },
    },
    defaultVariants: { presentation: "default" },
  },
);

export interface NativeSelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement>,
    VariantProps<typeof nativeSelectVariants> {}

export const NativeSelect = React.forwardRef<
  HTMLSelectElement,
  NativeSelectProps
>(({ className, presentation, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(nativeSelectVariants({ presentation }), className)}
    {...props}
  />
));
NativeSelect.displayName = "NativeSelect";

export { nativeSelectVariants };
