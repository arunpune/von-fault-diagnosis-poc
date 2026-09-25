<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->
<!-- Test fixture: the smallest chapter 8 that carries every anchor the
     manual's outline fixes for chapter 8 and the troubleshooting
     macro, whose generated headings the outline numbers. Synthetic text. -->

## How to use this chapter {#sec:troubleshooting-how-to}

Start from the symptom the unit shows, not from the part you suspect. Each symptom below lists its possible causes with the most likely one first, the reading that moves and the remedy. A fouled oil cooler, for instance, is listed as {{ ref('fault:oil_cooler_fouled') }}.

## Symptoms and causes {#sec:troubleshooting-tables}

The tables repeat the wording of the readings, so the same sentence describes a fault in the manual and on the controller.

{{ tables.troubleshooting() }}

## After a repair {#sec:after-repair}

Run the unit through one complete load cycle after every repair and watch that {{ sig('line_pressure') }} reaches the cut-out setting again. Reset the message at the controller only once the reading has settled, as {{ ref('sec:acknowledging') }} describes.
