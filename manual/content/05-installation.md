<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->
<!-- Chapter 5 of the CAU-7 instruction manual. Every number comes from
     manual/spec through the Jinja namespace of manual/tools/context.py;
     see docs/plan/phase1-manual-content.md sections 8 and 10. -->

This chapter covers the installation of the unit and the conditions its ratings
refer to. Read {{ ref('sec:safety-general') }} before you begin, and have the
work done by people who are allowed to do it.

## Site {#sec:installation-site}

Install the unit indoors, on a level floor that carries its mass of
{{ q(machine.ratings.mass) }}, in a room that stays clean, dry and frost-free.
It measures {{ q(machine.ratings.length) }} in length,
{{ q(machine.ratings.width) }} in width and {{ q(machine.ratings.height) }} in
height. Leave room on every side to open the panels and pull the coolers; a
clear space equal to the width of the unit in front of the cooling-air inlet
and behind the outlet is the practical minimum.

The room must supply the cooling air the unit needs and get rid of the heat
again. Do not let warm outlet air return to the inlet. Draw the intake air from
the cleanest place available: dust shortens the life of the intake filter, the
separator element and the desiccant alike.

Keep the cooling air between
{{ num(machine.limits.ambient_operating.min, machine.limits.ambient_operating.unit) }}
and
{{ num(machine.limits.ambient_operating.max, machine.limits.ambient_operating.unit) }}.
{{ ref('sec:cooling') }} explains why. The relative humidity of the room must
stay below {{ q(machine.limits.max_relative_humidity) }}, and the site must lie
no higher than {{ q(machine.limits.max_altitude) }} above sea level; thinner
air carries away less heat and reduces the delivered flow. When the unit is
stored rather than installed, keep it between
{{ num(machine.limits.ambient_storage.min, machine.limits.ambient_storage.unit) }}
and
{{ num(machine.limits.ambient_storage.max, machine.limits.ambient_storage.unit) }}.

## Reference conditions {#sec:reference-conditions}

Every rating in this book, and every band the controller compares a reading
with, refers to one agreed set of conditions. They are an ambient temperature
of {{ q(machine.reference_conditions.ambient_temperature) }}, cooling air at
{{ q(machine.reference_conditions.cooling_air_temperature) }}, an absolute
inlet pressure of
{{ q(machine.reference_conditions.inlet_pressure_absolute) }} and a relative
humidity of {{ q(machine.reference_conditions.relative_humidity) }}.

_At reference conditions_ therefore means two things. A rating such as the free
air delivery or the pressure dew point is the value the unit reaches when the
site matches that set; a warmer, damper or higher site gives less. And the
normal bands in {{ ref('sec:normal-bands') }} were recorded on a unit running
at those conditions, so a reading that sits outside its band on a hot day is
not automatically a fault. Judge it against the ambient temperature of the
moment, and note the conditions whenever you log a measurement. The ratings
themselves are collected in {{ ref('sec:technical-data') }}.

## Electrical connection {#sec:electrical-connection}

Connect the unit to a three-phase supply of
{{ q(machine.ratings.supply_voltage) }} at
{{ q(machine.ratings.supply_frequency) }}, through an external disconnecting
device that can be locked in the open position. The supply voltage may deviate
by {{ q(machine.limits.supply_voltage_tolerance) }} from its nominal value; a
larger deviation, or an unbalanced supply, overloads the motor.

Protect the circuit with a fuse of {{ q(machine.ratings.supply_fuse) }}, sized
for the rated motor current of
{{ q(machine.ratings.motor_rated_current) }} and for the peak the motor draws
at each start. Use a cable cross-section that suits the fuse and the length of
the run, and earth the unit before you connect anything else.

Check the direction of rotation on the first start. A screw compression element
that turns the wrong way delivers no air and is damaged within seconds: start
the motor briefly, watch the arrow on the drive and swap two phases if it turns
wrongly. {{ ref('sec:safety-electrical') }} applies throughout.

## Air connection {#sec:air-connection}

Connect the delivery pipe to the outlet of the reservoir isolation valve
through a flexible element, so that no pipe force reaches the unit. Size the
pipe for the flow the installation takes and lay it with a fall towards a drain
point. Close the isolation valve to separate the unit from the distribution
line during service work, and leave it open in normal operation: a closed valve
makes the unit cycle against its own reservoirs.

Lead the condensate from the automatic drain to a collecting vessel or an
oil-water separator through a pipe that falls all the way; it carries oil and
must not go into the drain untreated. Never connect the drain line to a line
that can be pressurised from elsewhere.

Leave the outlet of the purge silencer free. It discharges to atmosphere in
short bursts and must never be piped into a closed system or throttled; back
pressure in the purge line stops the off-line tower from regenerating.
{{ ref('sec:air-flow') }} shows where each of these connections sits in the air
path.

## Commissioning {#sec:commissioning}

Work through this list before the first start, and again after any work that
opened the pressure envelope or the electrical box.

- All transport brackets removed, all panels back in place and all guards
  fitted.
- Oil level in the separator vessel above the minimum mark, with the unit
  stopped and vented.
- Electrical connection, earth and direction of rotation checked as described
  above.
- Reservoir isolation valve open, condensate line connected and falling, purge
  silencer outlet free.
- Cooling-air inlet and outlet unobstructed, room temperature inside the
  window given above.
- Cut-in and cut-out pressures checked against the installation they have to
  serve.

Then start the unit as described in {{ ref('sec:starting') }} and let it run
through several complete load cycles while you watch the display. Confirm that
the unit unloads at the cut-out pressure, that it loads again at the cut-in
pressure, that the condensate drain discharges and that the dryer changes over.
Finally run {{ ref('task:daily_checks') }} once, so that the first log entry
records the unit when it was known to be sound.
