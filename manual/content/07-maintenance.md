<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

## Safety during maintenance {#sec:maintenance-safety}

Only trained personnel may service the {{ machine.identity.name }}. Read {{ ref('ch:1') }} before you start, and carry out the four steps below, in this order, before every task in this chapter. They apply to the short checks as well as to the long overhauls; most of the accidents a unit of this kind causes happen during a job that was thought too small to prepare for.

**Stop the unit and wait for it to come to rest.** Stop it from the controller and let the motor run down. A unit that is merely unloaded is not stopped: the {{ machine.identity.controller }} loads the motor again on its own as soon as the line pressure falls to the cut-in setting, and it gives no warning before it does so.

**Isolate the unit electrically and secure it against restarting.** Lock the isolator open and keep the key with the person doing the work. A warning label hung on an unlocked isolator is not a lock-out; see {{ ref('sec:safety-electrical') }}.

**Vent the unit.** The blow-down valve empties the separator vessel when the unit stops, but the reservoirs, the dryer towers and the pipework stay under pressure until you close the isolation valve at the pneumatic panel and open the vent. Read {{ sig('discharge_pressure') }} and {{ sig('reservoir_pressure') }} on the controller, confirm that both stand at zero and confirm it a second time on a test gauge at the panel before you open any joint. Stored compressed air gives no sign of itself, and a vessel that still holds pressure will throw a cover bolt or a fitting across the room; see {{ ref('sec:safety-pressure') }}.

**Let the unit cool down.** The airend, the oil charge, the separator vessel, the oil cooler and the aftercooler stay hot long after the motor has stopped. Hot oil under residual pressure sprays out of a joint that is opened too early; see {{ ref('sec:safety-hot-surfaces') }}.

Never adjust, block or paint the safety valve, and never defeat a guard or a door interlock to reach a part more comfortably. Work on the electrical cabinet, on the safety valve and on the pressure vessels is reserved for qualified personnel. When the work is finished, refit every guard, take every tool out of the enclosure, close the drain and vent valves that you opened, and only then restore the supply and unlock the isolator.

## Maintenance schedule {#sec:maintenance-schedule}

The schedule below gives the interval of every task. An interval stated in both running hours and elapsed months falls due at whichever comes first: a unit that stands idle ages through condensate and through oxidation of the oil just as a busy unit ages through running hours, so neither figure on its own is enough. The controller counts the running hours for you; the calendar months are yours to keep.

The daily and the weekly checks are operator work and need no tool beyond a torch. Every task from the air intake filter service onwards is service work, and each of them assumes that the unit has been stopped, isolated, vented and allowed to cool as {{ ref('sec:maintenance-safety') }} describes.

The tasks that the controller can count carry a service message. The message appears once the counter reaches the interval, it does not stop the unit, and it stays on the display until the work has been carried out and the counter has been reset. {{ ref('sec:message-types') }} explains how a service message differs from a warning: a warning reports a reading that has left its band now, a service message reports work that has become due. The remaining tasks — the daily and weekly checks, the cooler cleaning, the purge valve and silencer service, the safety valve test and the drive coupling inspection — are not counted by the controller and have to be planned from the operating log.

Site conditions shorten intervals; they never lengthen them. A dusty room, a warm room, a high duty cycle or a long spell of continuous load wears the intake filter, the oil charge and the desiccant faster than the figures below assume. Shorten the interval when the unit works in such a place, rather than waiting for the message and then finding a filter that has been choked for months.

{{ tables.maintenance_schedule() }}

## Maintenance procedures {#sec:maintenance-procedures}

Each procedure below names the safety measures that apply to it, the tools and consumables it needs, the steps in the order in which they are carried out and the checks that close it. Read the whole procedure before you begin and lay out the parts first: a procedure that stops halfway for a missing seal leaves the unit open, unusable and, if the enclosure has been left standing open overnight, dirty inside as well.

Use only the consumables listed for the task. The oil grade is part of the design of the unit; an oil of another grade changes the viscosity, the separation behaviour and the running temperature that the controller has been set up to expect, and the effect shows up weeks later as oil carry-over or as a warning nobody can explain. Fit the new seals and gaskets that a procedure names, even when the old ones still look sound.

{{ tables.maintenance_procedures() }}

### Recording the work and resetting the service message {#sec:maintenance-procedures-record}

Record every service in the operating log: the date, the running hours, the task, the parts that were fitted and the readings taken before and after the work. The log is what turns a row of separate repairs into a history. A slow drift in {{ sig('oil_temperature') }}, in the loaded run time or in the number of load cycles per hour is invisible from one visit to the next and obvious across a year of entries, and most of the conditions in {{ ref('ch:8') }} are found that way long before a message appears.

Reset the service counter at the controller once the work is complete and the post-service checks have passed, and not before. Resetting a counter clears the service message and starts the next interval from the current running hours; {{ ref('sec:acknowledging') }} gives the key sequence. A counter that is cleared without the work being done hides the task until the next interval falls due, and the unit then runs with a choked filter, a tired oil charge or a spent desiccant charge for twice as long as was intended.

Close every visit by running the unit through one complete load cycle with all guards refitted, and compare the readings with the figures in {{ ref('sec:normal-bands') }} before you hand the unit back to the operator.
