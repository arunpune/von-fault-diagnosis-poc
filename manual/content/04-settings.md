<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

## Reaching the settings {#sec:settings-access}

Press MENU to open the settings menu, step to a parameter with the arrow keys and press ENTER. The
value then blinks; change it with the arrow keys and press ENTER again to store it, or press MENU
to leave it as it was. A stored value takes effect at once and survives a power failure.

The controller knows two access levels, and the access column of the parameter list says which one
a parameter needs.

- **Operator level** is open without a code. It holds the settings of daily running: the
  regulation pressures, the timers of the load cycle and the ambient warning limits.
- **Service level** is protected by a code held by the maintenance organisation. It holds the
  limits that protect the machine: the thresholds behind the messages of
  {{ ref('sec:message-types') }}.

Only a trained technician changes a service-level parameter, and only for a written reason.
Raising a protection limit does not let the machine work beyond it; it only removes the warning
that would have come first. Record every change with its date and both values, so a later fault
can be judged against the settings that were active.

## Parameter list {#sec:settings-table}

The list gives every programmable parameter with its number, name, accepted range, delivered value
and access level. A value outside the range is refused: the display keeps the old value and
nothing is stored.

{{ tables.settings() }}

## Rules the controller enforces {#sec:settings-rules}

Several parameters only make sense in relation to another one, so the controller checks each new
value against its neighbours and refuses a combination that would leave the unit without a graded
response.

**The regulation band keeps a margin.** {{ ref('setting:cut_in_pressure') }} is delivered at
{{ val('cut_in_pressure') }} and {{ ref('setting:cut_out_pressure') }} at
{{ val('cut_out_pressure') }}. The controller refuses a cut-in that comes closer to the cut-out
than the margin in the list, and a cut-out that comes closer to the cut-in; without that margin
the unit would load and unload continuously. It also refuses a cut-out above the maximum working
pressure, {{ q(machine.ratings.max_working_pressure) }}, and a discharge pressure shutdown above
the safety valve setting, so the controller stops the unit before the valve blows.

**Protection limits stay in order.** For the oil temperature, the motor current and the discharge
pressure the controller holds three limits: a warning, a shutdown warning and a shutdown. The
warning must stay below the shutdown warning, and the shutdown warning below the shutdown. A value
that breaks the order is refused, so the unit can never reach a shutdown unannounced.

**Ambient warnings follow the operating limits.**
{{ ref('setting:ambient_temperature_high_warning') }} and
{{ ref('setting:ambient_temperature_low_warning') }} are tied to the operating limits given in
{{ ref('sec:installation-site') }}. They report that the machine room has left the range the unit
was designed for; moving them does not move that range.

**Dryer timers keep their ratio.** {{ ref('setting:dryer_changeover_timeout') }} has to stay well
above {{ ref('setting:dryer_tower_period') }}, because the timeout must allow at least one
complete changeover before it reports a dryer that has stopped working.
