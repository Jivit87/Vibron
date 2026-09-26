"use client"

import type { CSSProperties } from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

import { useViberon } from "@/store/viberon"

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useViberon((s) => s.settings.theme)

  return (
    <Sonner
      theme={theme === "light" ? "light" : "dark"}
      className="toaster group"
      toastOptions={{ style: { borderRadius: 4, fontSize: 12.5 } }}
      style={
        {
          "--normal-bg": "var(--vb-bg-overlay)",
          "--normal-text": "var(--vb-text-hi)",
          "--normal-border": "var(--vb-line-strong)",
        } as CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
