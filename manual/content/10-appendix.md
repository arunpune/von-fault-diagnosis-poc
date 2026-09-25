<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

## Glossary {#sec:glossary}

- **Airend** — the screw element in which the air is compressed.
- **Blow-down** — the venting of the separator vessel when the unit unloads or stops.
- **Changeover** — the dryer's switch between the drying and the regenerating tower.
- **Cut-in** — the line pressure at which the controller loads the unit.
- **Cut-out** — the line pressure at which the controller unloads the unit.
- **Cyclonic separator** — the vessel that spins condensate out of the cooled air.
- **Desiccant** — the porous material in the towers that dries the air.
- **Load** — the state in which the intake valve is open and air is delivered.
- **Minimum-pressure valve** — the valve that holds vessel pressure so the oil circulates.
- **Normal band** — the range a reading covers on a healthy unit in one state.
- **Pressure dew point** — the temperature at which the delivered air, at working pressure, condenses.
- **Purge** — the small flow of dried air that regenerates the resting tower.
- **Reference conditions** — the stated inlet and cooling conditions the ratings refer to.
- **Run-on** — the time the motor keeps turning unloaded after cut-out.
- **Scavenge line** — the line returning separated oil to the airend.
- **Separator element** — the element in the separator vessel that takes oil out of the air.
- **Service message** — a message reporting that a maintenance task has become due.
- **Shutdown** — a message that stops the unit and inhibits a start until it is reset.
- **Shutdown warning** — a message reporting that a shutdown limit is close; the unit runs on.
- **Unload** — the state in which the intake valve is closed and no air is delivered.
- **Warning** — a message reporting a reading outside its band; the unit runs on.

## Revision history {#sec:revision-history}

Every issue of this manual is listed below.

{{ tables.revision_history() }}

## Licence and disclaimer {#sec:license-notice}

This manual is a work of fiction. The {{ machine.identity.name }} and the {{ machine.identity.controller }} controller do not exist: no such machine, component, part code or setting was ever built or sold, and nothing here is derived from any real product's documentation. It is reference material for a fault-diagnosis research project and must never be used to install, operate, service or repair real equipment.

This manual is licensed under the Creative Commons Attribution 4.0 International Licence (CC BY 4.0), <https://creativecommons.org/licenses/by/4.0/>. Attribute it to _Meddle S.r.l._ You may share and adapt it, including commercially, provided you give credit, link to the licence and state whether changes were made.

## Data credit {#sec:data-credit}

The normal bands of {{ ref('sec:normal-bands') }} and the reference operation behind them were derived from a public recording of a real air production unit: Davari, N., Veloso, B., Ribeiro, R., & Gama, J. (2021). _MetroPT-3 Dataset_. UCI Machine Learning Repository. <https://doi.org/10.24432/C5VW3R>. That dataset is licensed under CC BY 4.0.

Only statistical summaries were taken from it: the bands and the cycle figures in {{ ref('ch:9') }}. The machine described here is not the machine that was recorded, and no text or drawing came from the dataset or its documentation.
