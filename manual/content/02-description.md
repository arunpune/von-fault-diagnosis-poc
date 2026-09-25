<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->
<!-- Chapter 2 of the CAU-7 instruction manual. Every number comes from
     manual/spec through the Jinja namespace of manual/tools/context.py;
     see docs/plan/phase1-manual-content.md sections 8 and 10. -->

This chapter describes what the unit is made of and how the parts work
together. Read it once before you operate the unit; the procedures in the later
chapters assume that you know the names used here.

## What the unit does {#sec:overview}

The CAU-7 Compressed-Air Unit is a complete compressed-air station on one
frame. An oil-injected single-stage screw compressor driven by a fixed-speed
motor produces the air. An aftercooler and a cyclonic separator remove the bulk
of the condensate, a twin-tower heatless desiccant dryer removes the rest, and
two air reservoirs store the dried air and damp the demand of the installation.
A CTRL-7 controller regulates the unit, watches its sensors and reports what it
finds. A sound-insulated enclosure surrounds the whole assembly.

At the reference conditions of {{ ref('sec:reference-conditions') }} the unit
delivers {{ q(machine.ratings.free_air_delivery) }} at its maximum working
pressure of {{ q(machine.ratings.max_working_pressure) }}. The motor takes
{{ q(machine.ratings.motor_power) }} and turns at
{{ q(machine.ratings.motor_speed) }}. The complete ratings are listed in
{{ ref('sec:technical-data') }}; this chapter explains how the unit reaches
them, and {{ ref('sec:schematic') }} shows every part in one picture.

### Main assemblies {#sec:overview-assemblies}

On the compressor side the air intake filter, the intake and unloading valve,
the screw compression element, the drive motor and the motor coupling sit
together on the frame. The oil separator vessel carries the separator element,
the minimum-pressure valve, the safety valve and the oil level switch, and the
blow-down valve vents it.

The cooling group holds the oil cooler, the aftercooler, the cooling fan and
the thermostatic valve; the oil filter sits between the cooler and the
compression element. Downstream, the cyclonic separator and its automatic
condensate drain feed desiccant tower 1 and desiccant tower 2, which the dryer
changeover valves, the dryer purge valve and the purge silencer serve. The air
reservoirs, the reservoir inlet flow sensor and the reservoir isolation valve
close the air path, and the pneumatic panel carries the line-pressure
instruments. The CTRL-7 controller sits behind the front door.

## Air flow {#sec:air-flow}

Air enters through the air intake filter, which keeps dust out of the
compression element, and passes the intake and unloading valve. That valve
opens only while the controller has loaded the unit; at every other moment it
is closed, and the unit draws no air.

The screw compression element compresses the air and injects oil into it, so
what leaves the element is a mixture of air and oil mist. The mixture enters
the oil separator vessel, where most of the oil drops out by gravity and change
of direction. The separator element in the top of the vessel catches the mist
that remains. {{ sig('discharge_pressure') }} is measured in the vessel, and
{{ sig('oil_temperature') }} at the outlet of the compression element.

The minimum-pressure valve at the vessel outlet is a non-return valve with a
spring. It holds enough pressure in the vessel to keep the oil circulating, and
it stops air in the delivery line from flowing back when the unit unloads.
{% if fact_in_prose('machine.ratings.minimum_pressure_valve_opening') %}The
valve opens at {{ q(machine.ratings.minimum_pressure_valve_opening) }}, so the
vessel is never emptied faster than the separator element can drain.
{% endif %}

Past the valve the air runs through the aftercooler, where it gives up most of
its heat, and into the cyclonic separator, which spins out the condensate that
the cooling has produced. The automatic condensate drain empties the separator
into the condensate connection, and
{{ sig('separator_discharge_pressure') }} is measured at the separator
discharge port.

The cooled and drained air then passes the dryer described in
{{ ref('sec:drying') }}, flows through the reservoir inlet flow sensor into the
two air reservoirs, and leaves through the reservoir isolation valve to the
pneumatic panel. There {{ sig('line_pressure') }} and the low-pressure switch
watch the pressure the installation actually sees, and
{{ sig('reservoir_pressure') }} is measured immediately downstream of the
reservoirs.

## Oil circuit {#sec:oil-circuit}

The oil does three jobs inside the compression element: it seals the clearance
between the rotors, it carries away the heat of compression, and it lubricates
the bearings. The unit holds {{ q(machine.ratings.oil_fill_volume) }} of
synthetic screw compressor oil.

There is no oil pump. Air pressure in the oil separator vessel drives the
circuit: oil collects in the bottom of the vessel and is pushed out to the
thermostatic valve, which sends it either straight back to the compression
element or through the oil cooler, depending on how warm it is. From there the
oil passes the oil filter, which holds back wear particles, and re-enters the
compression element.

A scavenge line returns the oil that collects under the separator element to
the low-pressure side of the compression element. The line carries very little
oil and is easily blocked; a blocked scavenge line is the usual reason for oil
in the delivered air.

The oil level switch in the separator vessel reports whether the level is above
the minimum mark. Read the level from the sight glass as part of
{{ ref('task:daily_checks') }}, with the unit stopped and vented.

## Cooling {#sec:cooling}

One cooling fan draws ambient air through the enclosure and pushes it across
the oil cooler and the aftercooler. The same stream cools the drive motor and
the electrical box, so the unit needs a supply of cool air even when the oil
itself is not yet warm. {{ sig('ambient_temperature') }} is measured at the
cooling-air inlet.

The thermostatic valve keeps the oil out of the cooler until the oil is warm
enough. That matters in a cold room: oil that is too cold is too thick to
circulate, and condensate then collects in the separator vessel instead of
evaporating. The unit is built to run with cooling air between
{{ num(machine.limits.ambient_operating.min, machine.limits.ambient_operating.unit) }}
and
{{ num(machine.limits.ambient_operating.max, machine.limits.ambient_operating.unit) }}.
Outside that window the controller reports an ambient message, and the oil
temperature soon follows it. {{ ref('sec:installation-site') }} states what the
window means for the room the unit stands in.

## Air drying {#sec:drying}

The dryer is a twin-tower heatless desiccant dryer. Each tower holds a charge
of desiccant. One tower dries the air that flows to the reservoirs while the
other one regenerates, and the changeover valves swap their roles at the end of
every tower period. {{ sig('dryer_tower') }} tells you which of the two is
drying.

Regeneration needs no heater. A part of the already dried air is expanded to
atmospheric pressure and led backwards through the off-line tower, where it
picks up the water the desiccant collected during its drying period and carries
it out through the dryer purge valve and the purge silencer.
{% if fact_in_prose('machine.ratings.dryer_purge_fraction') %}That purge air is
{{ q(machine.ratings.dryer_purge_fraction) }} of the delivered flow, which is
why the unit compresses more air than the installation consumes.{% endif %}

{{ sig('dryer_purge_pressure') }} is measured in the purge line downstream of
the purge valve. It is near zero while a tower regenerates normally and rises
only in short pulses at changeover. A purge pressure that stays high means that
air is escaping continuously, either through a purge valve that no longer seats
or through a damaged silencer. {{ sig('purge_switch') }} confirms that the
off-line tower really discharges.

The tower period is {{ val('dryer_tower_period') }}, and the changeover is
linked to demand rather than to the clock: the towers change over only while
the unit is delivering air, because only then is there dry air to regenerate
with. After every cut-in, tower 1 takes the first period, so a unit that cycles
frequently keeps returning to the same tower. At the reference conditions the
dryer reaches a pressure dew point of
{{ q(machine.ratings.dryer_dew_point) }}. {{ ref('sec:dryer-operation') }}
describes what the operator sees during a changeover.

## Regulation {#sec:regulation}

The unit runs at fixed speed and is regulated by loading and unloading. While
the unit is loaded, the intake valve is open and the compression element
delivers air. When {{ sig('line_pressure') }} reaches the cut-out pressure of
{{ val('cut_out_pressure') }}, the controller de-energises the load solenoid:
the intake valve closes, the blow-down valve vents the separator vessel, and
the motor keeps turning without delivering air. When the pressure falls back to
the cut-in pressure of {{ val('cut_in_pressure') }}, the controller loads the
unit again.

A unit that has unloaded keeps running for the unloaded run-on time, so that a
short pause in demand does not cost a motor start; see
{{ ref('setting:unload_run_on_time') }} for the parameter and
{{ ref('ch:6') }} for its value and its effect. If no load request arrives
within that time, the motor stops and the unit waits in the off state. A
restart delay then keeps the motor off for a moment even if the pressure
already calls for air, which protects the motor against short start intervals.

The pneumatic panel also carries a hardware low-pressure switch that works
independently of the controller. It closes below
{{ q(machine.hardware_switches.low_pressure_switch.closes_below) }} and opens
again above {{ q(machine.hardware_switches.low_pressure_switch.opens_above) }},
so the controller learns that the installation has lost pressure even if the
line-pressure transducer is faulty. {{ ref('sec:normal-cycle') }} shows what a
complete load cycle looks like.

### Panel labels {#sec:regulation-labels}

Every measured value carries a short panel label, and the display, the
schematic in this chapter and the signal list all use the same one: the
pressures P1 to P5, the temperatures T1 and T2, the motor current I1 and the
digital inputs D1 to D8. A label tells you where a value is measured, not what
it should read; {{ ref('sec:signal-list') }} gives the complete list and
{{ ref('sec:normal-bands') }} the band each value normally stays in.

## System schematic {#sec:schematic}

{{ figure('system-schematic', 'Air, oil and signal flow of the CAU-7') }}

The schematic follows the air from the intake filter on the left to the
consumers on the right, with the oil circuit drawn as the loop that returns to
the compression element and the controller shown as the box that collects the
measured values. Every instrument is drawn at the place where it is installed
and carries its panel label, so the picture and the readings on the display use
the same names. The two desiccant towers are drawn side by side with the
changeover valves between them and the purge path leading down to the silencer.
Use the schematic together with {{ ref('sec:signal-list') }} when you trace a
fault: it is the quickest way to see which part sits upstream of the reading
that surprised you.
