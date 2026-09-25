// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Package replay streams the MetroPT-3 CSV and hands the simulator engine a
// seekable cursor over it (docs/simulation.md, "The replay clock").
//
// The file is 218 MB and is bind-mounted read only, so it is never loaded
// into memory and no sidecar cache is written next to it. Open makes one
// sequential pass that parses only the timestamp column and records a sparse
// index — a (byte offset, sim_ts) pair every IndexStride rows — together with
// the dataset bounds, the row count and every source step above
// GapThresholdMs. Seek is then a binary search on that index, a file seek and
// a forward scan of at most IndexStride rows.
//
// Columns are resolved through regmap.Signal.Column, so the package never
// hard-codes a CSV column name and column order in the file is irrelevant.
// Signals without a column — the synthetic extras such as ambient_temperature
// — are not replayed and do not appear in a Row.
//
// Nothing here reads encoding/csv: the file has no quoted fields, and a
// hand-rolled field scanner keeps a row parse free of per-row allocation so
// the cursor sustains the rate a 3600× replay needs.
package replay
