<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

## Display {#sec:controller-display}

The CAU-7 is operated from the CTRL-7 controller in the front panel. It regulates the unit,
supervises every measured signal, counts the running hours behind the service intervals and holds
the programmable settings. Everything an operator has to see, acknowledge or change is on the
panel.

The display has two lines and shows one of two pictures.

- While no message is active, the upper line shows {{ sig('line_pressure') }}, the value the unit
  regulates on, and the lower line shows the machine state — off, unloaded or loaded — with the
  run-hour counter.
- While a message is active, the upper line carries its code and the lower line the short text
  that belongs to that code. Both are listed in {{ ref('sec:message-list') }}.

When several messages are active, the most severe is shown first: shutdown, shutdown warning,
warning, service message. Step through the rest with the arrow keys.

{{ figure('control-panel', 'CTRL-7 front panel') }}

The figure shows the panel with the oil temperature warning active. Paging on reaches the measured
signals, so the reading behind a message can be read without acknowledging it.

## Keys and indicator lamps {#sec:controller-keys}

- **START** starts the unit through the sequence of {{ ref('sec:starting') }}. It is refused while
  a shutdown is active.
- **STOP** stops the unit through the unload and run-on sequence of {{ ref('sec:stopping') }}.
  Always stop with this key, never by switching off the supply.
- **RESET** acknowledges the message on the display. A message whose condition remains reappears
  at once.
- **MENU** opens and leaves the settings menu of {{ ref('sec:settings-access') }}.
- The **arrow keys** page through the messages and the measured signals, select a parameter and
  change a value.
- **ENTER** confirms a selection or a changed value.
- The **emergency-stop button** is wired into the motor circuit; it is not a controller key and
  works whatever the controller is doing.

Four lamps repeat the state of the unit for anyone too far away to read the display. **Power**,
green, is lit whenever the controller is supplied; **warning**, amber, while a warning is active,
flashing while a shutdown warning is; **shutdown**, red, while the unit is stopped by a shutdown;
**service**, blue, while a service message is active.

## Message types {#sec:message-types}

Every message carries a code whose first letter gives the type and decides what the unit does. The
number behind the letter only groups the messages of that type.

- **W — warning.** A value has left its limit, or a signal is missing. The unit keeps running.
  Deal with the cause at the next opportunity; an ignored warning usually becomes a shutdown
  warning.
- **X — shutdown warning.** The same quantity has moved further and is close to a shutdown limit.
  The unit still runs, but the controller will stop it if the value keeps moving. Act at once:
  reduce the demand or remove the cause.
- **S — shutdown.** The controller has stopped the unit to protect it, and start stays inhibited
  until the message is reset. Never bridge, disable or repeatedly reset a shutdown to keep
  production running.
- **M — service.** A run-hour counter or a calendar interval has expired. The unit keeps running
  and only the service lamp lights.

## Message list {#sec:message-list}

The list holds every message the CTRL-7 can show: the code, the type, the display text, the plain
title, the threshold and delay that make the message appear, and what the unit does while it is
active. The causes behind a message, and the checks that separate them, are in the problem-solving
chapter.

{{ tables.alarms() }}

The threshold column gives the value the signal is compared with, and the delay beside it how long
the condition must last before the message appears. A short delay keeps one disturbed reading from
raising a message; a long one lets a slow quantity such as an oil temperature settle. Where the
threshold is printed as a parameter number, the limit is programmable: look the parameter up in
{{ ref('sec:settings-table') }} for its range and its delivered value. A threshold printed as a
plain value is fixed in the controller. Messages with no threshold come from a separate input or
from a service counter rather than from a measured signal.

## Acknowledging and resetting messages {#sec:acknowledging}

How a message leaves the display depends on its reset rule, which the list gives for every code.

- **Automatic.** The message disappears as soon as the condition goes away. Most warnings behave
  this way; nothing has to be acknowledged, but the event is worth recording.
- **Automatic with hysteresis.** The signal has to fall back past the limit by a hysteresis band
  first, so a value sitting on its limit does not make the message flicker.
- **Manual.** Every shutdown is reset by hand. Remove the cause and let the unit reach a safe
  state — a hot machine has to cool down — then press RESET. The controller refuses the reset
  while the condition is still present.
- **Service.** A service message is cleared by the technician who did the work, by resetting the
  matching counter in the menu. Resetting a counter without doing the work hides the next interval
  and is never acceptable.

After a reset, and after every stop, the motor is held for the restart delay,
{{ ref('setting:restart_delay') }}, before it may start again. That keeps it from being restarted
while it is still turning down and holds the starts per hour within what the drive is designed
for. The pause is normal and is not a fault.
