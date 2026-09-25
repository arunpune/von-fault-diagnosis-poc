<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

## How to use this chapter {#sec:troubleshooting-how-to}

Start from what the unit shows, not from the part you suspect. Each section of this chapter is one condition: the symptom as the operator meets it, the controller messages that usually come with it, the readings that carry the evidence, and a table of the causes that produce it.

Read a table in four columns. The **cause** names the thing that is wrong. The **likelihood** ranks it against the other causes of the same condition, and the rows are already ordered, so work down the list rather than across it. The **signals** column says which readings move, in which direction and in which machine state; that is the column which tells you whether the unit in front of you is really showing this cause or only this condition. The **remedy** says what to do once the cause is confirmed. Each cause also carries its own checks, and the checks come before the spanner: they confirm or rule out a cause without changing a part.

Before you call for service, write down what the controller shows. Note the machine state, the code and the text of every pending message, the running hours, and the readings for {{ sig('line_pressure') }}, {{ sig('discharge_pressure') }}, {{ sig('oil_temperature') }}, {{ sig('motor_current') }}, {{ sig('dryer_purge_pressure') }} and {{ sig('separator_discharge_pressure') }} in each state the unit passes through. Add how long a loaded run lasts and how often the unit loads in an hour. Those figures, compared against {{ ref('sec:normal-bands') }}, are worth more than any description of the noise the unit makes.

Not every cause is a fault. Some of the causes listed here are benign: the unit is healthy and is reporting what the plant or the room is doing to it. Air demand above the rated delivery and an ambient temperature outside the operating range both behave exactly like a defect for as long as they last, and both disappear on their own. Recognise them, record them and change the installation or the duty; there is nothing on the machine to repair.

Several conditions share the same causes, which is why the checks decide and the symptom alone does not. Two examples are worth reading before you use the tables.

A leak in the distribution network is listed under {{ ref('cond:low_line_pressure') }} and again under {{ ref('cond:continuous_load') }}. It is the same fault in both places; only the stage differs. Early on, the unit still reaches its cut-out setting and the pressure simply falls back faster than it should during the idle phase, so the unit loads more often. Later, when the loss has grown to match what the unit can deliver, the pressure settles on a plateau and the unit stays loaded. The check is the same at either stage: stop the unit, close the isolation valve at the pneumatic panel and watch whether the reservoir pressure still falls. If it holds, the loss is in the plant behind the valve. The entry to follow is {{ ref('fault:downstream_air_leak') }}.

A purge valve that no longer seats is listed under {{ ref('cond:continuous_load') }} as well, and on the display the two faults look identical: the unit delivers without pause and never reaches cut-out. The pressure-hold test separates them, because this loss is inside the unit and the pressure keeps falling with the panel valve closed. So does the purge line itself: {{ sig('dryer_purge_pressure') }} stays raised between tower changeovers instead of falling back, and a steady discharge is audible at the silencer. The reported condition is the same; the check tells you which cause to work on, and here that cause is {{ ref('fault:dryer_purge_leak') }}.

## Symptoms, causes and remedies {#sec:troubleshooting-tables}

The conditions below are arranged from the pressure faults an operator meets first, through the oil, cooling, separation and drying faults, to the electrical and sensor faults that stop the unit outright.

{{ tables.troubleshooting() }}

## After a repair {#sec:after-repair}

Clear the cause first and the message second. A warning clears itself once the reading has come back inside its band, a shutdown has to be acknowledged with the reset key after the cause has been removed, and a service message is cleared by resetting its counter; {{ ref('sec:acknowledging') }} gives the key sequence for each of them. A message that returns within the next cycle means the cause is still there, whatever was changed, and the right response is to go back to the table rather than to reset it again.

Then run the unit through one complete cycle before you leave it: start, load, deliver until it reaches the cut-out setting, unload, let the run-on time expire and let the unit stop by itself. Watch the dryer change tower during that cycle and confirm that regeneration is audible at the silencer and stops cleanly at the end of the purge phase.

Compare every reading you noted at the start with the figures in {{ ref('sec:normal-bands') }}, in the state each band belongs to. A repair is finished when the readings sit inside their bands, the loaded run time and the number of load cycles match the reference duty of {{ ref('sec:normal-cycle') }}, and no message stands on the display.

Close the operating log last. Record the condition as reported, the checks carried out and what they showed, the cause confirmed, the parts fitted and the readings before and after. The next person to meet this unit will read that entry before they read this chapter.
