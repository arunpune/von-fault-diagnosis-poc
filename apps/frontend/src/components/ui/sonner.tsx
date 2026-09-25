// Edited after `shadcn add`: `useTheme` comes from the app's own ThemeProvider instead of
// next-themes, which is not a dependency, and lucide icons are imported one module per icon
// instead of from the barrel.
"use client"

import { useTheme } from "@/components/theme/ThemeProvider"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import CircleCheckIcon from "lucide-react/dist/esm/icons/circle-check"
import InfoIcon from "lucide-react/dist/esm/icons/info"
import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert"
import OctagonXIcon from "lucide-react/dist/esm/icons/octagon-x"
import Loader2Icon from "lucide-react/dist/esm/icons/loader-2"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
