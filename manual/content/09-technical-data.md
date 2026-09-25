<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

## Technical data {#sec:technical-data}

The ratings below apply at the reference conditions given in {{ ref('sec:reference-conditions') }}. Free air delivery, power consumption and pressure dew point are all measured there, and all three fall away as the inlet air becomes warmer, thinner or wetter, so compare a measurement on site with the reference conditions before you judge it against the table.

{{ tables.technical_data() }}

## Signal list {#sec:signal-list}

Every reading the {{ machine.identity.controller }} shows carries a short panel label: P for a pressure, T for a temperature, I for a motor current and D for a switched input. The same label appears on the schematic, on the display, in the fault tables of {{ ref('ch:8') }} and in the log the controller writes, so one label identifies a reading everywhere in this manual.

The controller samples every signal at a fixed interval and stores it together with the machine state that was active at the time. That is why the bands in the next section are given per state and why a recorded fault can still be read back afterwards: the record keeps the reading and the context in which it was taken.

{{ tables.signals() }}

## Normal bands {#sec:normal-bands}

A normal band is not a limit. Limits are the settings of {{ ref('ch:4') }} and the messages of {{ ref('ch:3') }}; a band describes what a healthy unit reads while it is doing a particular thing. Bands are therefore given per machine state, because the same tag reads quite differently while the unit is loaded, while it is unloaded and while it stands off, and a value that is perfectly normal in one state is a fault in another.

The bands below were derived from a reference month of recorded operation of a healthy unit at reference conditions. Read them as the shape of healthy operation rather than as acceptance figures. A single reading outside its band is a reason to look, not a fault in itself. A reading that has crossed its band slowly over weeks says far more than one that happens to sit at the edge today, which is why {{ ref('sec:maintenance-procedures-record') }} asks for the readings to be written down at every visit.

{{ tables.normal_bands() }}

## Spare parts and consumables {#sec:parts}

Order by the part code below and quote the serial number of the unit, which is stamped on the identification plate on the frame. The consumables are the parts named by the procedures in {{ ref('sec:maintenance-procedures') }}; keeping one set of them on site is what decides whether a service takes an afternoon or a fortnight.

{{ tables.parts() }}
