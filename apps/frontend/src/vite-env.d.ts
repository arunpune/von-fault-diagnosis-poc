// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/// <reference types="vite/client" />

/**
 * The per-icon entry points of lucide-react, which is imported one module per icon and never
 * through its barrel. The package ships no declaration file beside each icon module, so the
 * default export is typed here with the type the barrel declares for every icon.
 */
declare module "lucide-react/dist/esm/icons/*" {
  import type { LucideIcon } from "lucide-react";

  const Icon: LucideIcon;
  export default Icon;
}
