<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->
<!-- Chapter 1 of the CAU-7 instruction manual. Every number comes from
     manual/spec through the Jinja namespace of manual/tools/context.py;
     see docs/plan/phase1-manual-content.md sections 8 and 10. -->

Read this chapter before you install, start or service the unit. Its rules
apply everywhere in this book.

## General rules {#sec:safety-general}

The CAU-7 Compressed-Air Unit produces, stores and dries compressed air for
industrial installations. Use it for nothing else, and never feed its air to
breathing equipment.

Only trained people may operate the unit, and only people who know its pressure
and electrical hazards may service it.

Keep the enclosure panels closed and the guards in place while the motor turns.
Do not hang pipework from the unit, alter its pressure envelope or change its
wiring, and keep the cooling-air openings free;
{{ ref('sec:installation-site') }} states the room it needs. Obey national
rules wherever they are stricter.

## Pressure {#sec:safety-pressure}

The unit, the reservoirs and the pipework stay under pressure after the motor
stops. Before you loosen a fitting or open the separator vessel:

- stop the unit at the controller and isolate the electrical supply;
- close the reservoir isolation valve;
- vent the unit and the reservoirs through the drain connection;
- confirm on the display that {{ sig('discharge_pressure') }} and
  {{ sig('reservoir_pressure') }} read zero.

Never exceed the maximum working pressure of
{{ q(machine.ratings.max_working_pressure) }}. The safety valve on the
separator vessel opens at {{ q(machine.ratings.safety_valve_setting) }} and is
the last protection against overpressure: never plug, paint or readjust it.
The reservoirs are built for
{{ q(machine.ratings.reservoir_design_pressure) }}; replace one that is dented,
corroded or overheated.

Air at the purge silencer escapes as part of normal dryer operation; keep your
face away, because the blast carries desiccant dust.

## Electrical supply {#sec:safety-electrical}

The unit is fed from a three-phase supply of
{{ q(machine.ratings.supply_voltage) }} at
{{ q(machine.ratings.supply_frequency) }}; see
{{ ref('sec:electrical-connection') }}. Only a qualified electrician may open
the electrical box.

Isolate the unit at the external disconnecting device and lock it out before
you open the box, work on the motor or remove a marked cover. The STOP key
does not isolate.

**The motor starts without warning.** A unit standing still with its supply on
is waiting to start: it starts as soon as {{ sig('line_pressure') }} falls to
the cut-in pressure and the restart delay has run out. After a shutdown the
start stays inhibited until the message has been reset.

## Hot surfaces {#sec:safety-hot-surfaces}

The compression element, the separator vessel, the oil pipework, both coolers
and the delivery pipe stay hot long after the unit has stopped. The controller
warns before the oil reaches {{ thr('X201') }}; see {{ ref('alarm:X201') }}.

Let the unit cool before you drain the oil, change the oil filter or clean a
cooler, and wear gloves and eye protection. Open the oil filler plug only when
the unit is vented and cool: hot oil under pressure sprays.

## Warning symbols {#sec:safety-signs}

Three notices appear in this book and on the unit.

- **Danger** marks a hazard that causes death or serious injury.
- **Warning** marks a hazard that can injure.
- **Caution** marks a practice that can damage the unit or spoil the delivered
  air.

A symbol on the unit repeats the notice where the hazard is: electrical at the
electrical box, hot surface at the compression element, pressure at the
separator vessel and the reservoirs. Replace an unreadable label. The
controller raises messages of its own; {{ ref('sec:message-types') }} explains
each type.
