// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Severity levels as the UI shows them: each level has its colour token and its word, and the
// word is always shown — colour is never the only carrier. A level this build does not know (a
// newer contract may add one) reads as its own text in the lowest tone, the explicit `other`
// branch every consumed enum keeps (packages/contracts/VERSIONING.md).

import type { SeverityLevel } from "@/api/types";

interface SeverityStyle {
  /** The word on the badge, lowercase like the level itself. */
  readonly label: string;
  /** Tailwind classes that tint a badge's text and border with the level's token. */
  readonly tone: string;
  /** The CSS custom property of the level. */
  readonly token: string;
  /** 0 for low up to 3 for critical: the decision's `severity.score` index. */
  readonly rank: number;
}

// Full class names, so Tailwind's scanner sees each one.
const SEVERITY_STYLES: Readonly<Record<SeverityLevel, SeverityStyle>> = {
  low: {
    label: "low",
    tone: "border-severity-low text-severity-low",
    token: "--severity-low",
    rank: 0,
  },
  medium: {
    label: "medium",
    tone: "border-severity-medium text-severity-medium",
    token: "--severity-medium",
    rank: 1,
  },
  high: {
    label: "high",
    tone: "border-severity-high text-severity-high",
    token: "--severity-high",
    rank: 2,
  },
  critical: {
    label: "critical",
    tone: "border-severity-critical text-severity-critical",
    token: "--severity-critical",
    rank: 3,
  },
};

/** The four levels, lowest first. */
export const SEVERITY_LEVELS = Object.keys(SEVERITY_STYLES) as readonly SeverityLevel[];

export function isSeverityLevel(level: unknown): level is SeverityLevel {
  return typeof level === "string" && Object.hasOwn(SEVERITY_STYLES, level);
}

function styleOf(level: string): SeverityStyle | undefined {
  return isSeverityLevel(level) ? SEVERITY_STYLES[level] : undefined;
}

/** The word a badge shows; an unknown level shows its own text. */
export function severityLabel(level: string): string {
  return styleOf(level)?.label ?? level;
}

/** Text and border classes in the level's colour; an unknown level takes the lowest tone. */
export function severityTone(level: string): string {
  return (styleOf(level) ?? SEVERITY_STYLES.low).tone;
}

/** `var(--severity-…)` for drawing (meters, chart marks); the lowest tone for an unknown level. */
export function severityColor(level: string): string {
  return `var(${(styleOf(level) ?? SEVERITY_STYLES.low).token})`;
}

/** 0 (low) to 3 (critical) for sorting; -1 for a level this build does not know. */
export function severityRank(level: string): number {
  return styleOf(level)?.rank ?? -1;
}
