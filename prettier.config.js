// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/** @type {import("prettier").Config} */
export default {
  printWidth: 100,
  trailingComma: "all",
  semi: true,
  singleQuote: false,
  proseWrap: "preserve",
  overrides: [
    {
      files: "*.md",
      options: { printWidth: 120 },
    },
  ],
};
