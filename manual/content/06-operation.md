<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

## Starting the unit {#sec:starting}

Work through these checks before the first start of a shift and after every service.

1. Read the oil level while the unit is stopped and vented. Top up before starting, never during
   operation.
2. Check that no message is active. A shutdown has to be cleared as described in
   {{ ref('sec:acknowledging') }} before the unit will start at all.
3. Check that the reservoir isolation valve is open and the condensate drain lines run free.
4. Check that the cooling air inlet and outlet are clear and all guards are fitted.
5. Check that the emergency-stop button is released.

Press START. The controller closes the intake valve, starts the motor and lets the unit run
unloaded while the oil circuit fills and the drive settles. It then compares
{{ sig('line_pressure') }} with the cut-in setting: the unit goes to load only while the line
pressure is **below** {{ val('cut_in_pressure') }}, and otherwise stays unloaded until the
consumers have drawn the pressure down. On the reference machine, loading begins at
{{ q(machine.reference_operation.cut_in_pressure_observed) }}.

For a few seconds after the motor starts, {{ sig('motor_current') }} is higher than its running
value and can approach the rated current of the motor,
{{ q(machine.ratings.motor_rated_current) }}. The controller therefore ignores the motor current
messages for the start mask time, {{ val('motor_start_mask_time') }}, so the peak raises no
warning.

{% if fact_in_prose('setting:restart_delay') %}
After every stop, and after a message has been reset, the controller holds the motor for the
restart delay of {{ val('restart_delay') }} before it will start again. A START command given
inside that window is remembered and carried out when the delay has run out.
{% endif %}

## Stopping the unit {#sec:stopping}

Press STOP for a normal stop. The controller does not cut the motor at once; it unloads the unit
first. The intake valve closes, the blow-down valve vents the oil separator vessel so that
{{ sig('discharge_pressure') }} falls to near zero, and the motor keeps turning unloaded for the
run-on time before it stops. Running on lets the oil drain back and leaves the compression
element unpressurised, so the next start is made against a closed intake.

Use the emergency-stop button only in an emergency. It stops the motor immediately, without the
unloading and run-on sequence, and raises a shutdown message. Release it by turning it, then
reset the message; the unit will not start before both are done.

A stopped unit is not a vented unit. The blow-down valve vents the separator vessel only; the
reservoirs, the dryer and the distribution system stay at {{ sig('line_pressure') }}. Before any
work on the air side, isolate the unit, close the reservoir isolation valve, vent the section you
will open and check that the panel reads no pressure.

## The normal load cycle {#sec:normal-cycle}

In steady operation the unit repeats one cycle. The figures below describe the machine at its
reference operating point — what a healthy unit looks like — and the bands they come from are in
{{ ref('sec:normal-bands') }}.

**Cut-in.** The consumers draw the line pressure down to the cut-in setting,
{{ q(machine.reference_operation.cut_in_pressure_observed) }} on the reference machine. The
controller energises the load solenoid and opens the intake valve.

**Loaded run.** The unit delivers. {{ sig('line_pressure') }} rises at about
{{ q(machine.reference_operation.pressure_rise_loaded) }} and {{ sig('discharge_pressure') }}
follows it, a little higher because of the separator element. A loaded run lasts about
{{ q(machine.reference_operation.loaded_run_typical) }}, almost always between
{{ num(machine.reference_operation.loaded_run_band.min, 's') }} and
{{ num(machine.reference_operation.loaded_run_band.max, 's') }}. During the run
{{ sig('intake_closed') }} reads zero, {{ sig('load_valve') }} reads one,
{{ sig('separator_discharge_pressure') }} falls to near zero because the separator discharges into
the delivery, and {{ sig('motor_current') }} sits at its loaded value.

**Cut-out.** At the cut-out setting, {{ q(machine.reference_operation.cut_out_pressure_observed) }}
on the reference machine, the controller unloads. The intake valve closes, the blow-down valve
vents the separator vessel and {{ sig('discharge_pressure') }} drops to near zero, while
{{ sig('separator_discharge_pressure') }} rises to the line pressure again.

{% if fact_in_prose('setting:unload_run_on_time') %}
**Run-on.** The motor keeps turning unloaded for {{ val('unload_run_on_time') }}, so that a short
new demand can be answered without a restart. The reference machine runs on for about
{{ q(machine.reference_operation.unloaded_run_on_typical) }}.
{% endif %}

**Off.** If no new demand arrives the motor stops. The off phase lasts about
{{ q(machine.reference_operation.off_phase_typical) }}, during which {{ sig('motor_current') }}
reads zero and the line pressure decays slowly through the normal leakage of the system, at about
{{ q(machine.reference_operation.pressure_decay_unloaded_typical) }}. Together that is a load rate
of about {{ q(machine.reference_operation.load_cycles_per_hour) }}.

## Checks during operation {#sec:checks-during-operation}

Walk past the unit once a shift and read the panel. Judge every value against the machine state it
was read in, because the normal band of a signal differs between loaded, unloaded and off; the
bands are in {{ ref('sec:normal-bands') }}.

- {{ sig('oil_temperature') }} settles inside its band a few minutes after a cold start. A reading
  that keeps climbing through a loaded run, or never leaves the bottom of the band, is worth
  following up.
- {{ sig('motor_current') }} has its own band per state and is highest while the unit is loaded.
  Compare it with the band of the state the unit is actually in.
- {{ sig('dryer_purge_pressure') }} reads near zero while the unit delivers, apart from a short
  rise at each tower changeover.
- {{ sig('dryer_tower') }} changes over while the unit delivers, so the towers share the work.
- The condensate drain discharges briefly and regularly. A drain that blows continuously and one
  that never discharges are both faults.
- Note the code and the reading of any message before you acknowledge it; the reading is what
  separates the possible causes later.

Four departures from that pattern matter more than the exact values, because each points at a
group of causes.

- **More frequent cycles.** The unit loads more often over the same shift and the loaded runs get
  shorter: see {{ ref('cond:frequent_cycling') }}.
- **Longer loaded runs, or no cut-out.** The unit stays loaded and the line pressure no longer
  reaches the cut-out setting: see {{ ref('cond:continuous_load') }}.
- **Faster pressure decay.** The off phase grows shorter because the pressure falls away quicker
  than the reference figure above.
- **Purge pressure that stays up.** {{ sig('dryer_purge_pressure') }} no longer returns to near
  zero between changeovers, so air is leaving through the regeneration path:
  see {{ ref('cond:purge_pressure_high') }}.

## Dryer operation {#sec:dryer-operation}

The twin-tower dryer works without heat. One tower dries the delivered air while the other is
regenerated by a small flow of dried air, which expands to atmosphere through the purge silencer
and carries the collected moisture with it. The towers then change over and swap roles.

Changeover is tied to delivery, not to the clock: the towers change over only while the unit is
loaded, and the tower period, {{ val('dryer_tower_period') }}, counts loaded time only. A unit
that stands unloaded for a long time therefore keeps the same tower in service, which is correct,
because a tower that dries no air needs no regenerating. After a cut-in the first changeover
follows within about {{ q(machine.reference_operation.tower_pulse_after_cut_in) }}.

{% if fact_in_prose('setting:dryer_changeover_timeout') %}
If the controller sees no changeover for {{ val('dryer_changeover_timeout') }} of loaded running,
it reports the dryer. The timeout is generous on purpose, so that a short loaded run followed by a
long off phase never reports a dryer that is working.
{% endif %}

A short, sharp discharge at the purge silencer at every changeover is normal, and so is the noise
it makes. A discharge that never stops is not: compressed air is then lost continuously through
the regeneration path, and it shows up as a purge pressure that no longer falls back.

With both towers working and the desiccant in good condition the unit delivers air at a pressure
dew point of {{ q(machine.ratings.dryer_dew_point) }} at the reference conditions. Moisture at the
consumers, a risen dew point or water in a filter bowl point at the dryer rather than the
compressor.
