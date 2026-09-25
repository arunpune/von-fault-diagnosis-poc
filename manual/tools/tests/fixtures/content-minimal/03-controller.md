<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->
<!-- Test fixture: the smallest chapter 3 that carries every anchor the
     manual's outline fixes for chapter 3, the alarm table macro and
     one figure call. Synthetic text. -->

## Display {#sec:controller-display}

The controller shows two lines of text. The upper line carries the machine state and the lower line the reading the operator selected or, when one is pending, the message that needs attention.

{{ figure('control-panel', 'Front of the controller') }}

## Keys and indicators {#sec:controller-keys}

Below the display sit the start, stop and reset keys, the menu key and the two arrow keys that walk through the readings. Three indicators show power, a pending warning and a shutdown.

## Message types {#sec:message-types}

The controller knows warnings, shutdown warnings, shutdowns and service messages. A warning lets the unit run on, a shutdown warning announces a stop that is still ahead, and a shutdown stops the unit at once.

## Message list {#sec:message-list}

The table lists every message the controller can show. {{ ref('alarm:W104') }} appears when {{ sig('oil_temperature') }} stays above {{ thr('W104') }} for {{ delay('W104') }} while the unit runs.

{{ tables.alarms() }}

## Acknowledging a message {#sec:acknowledging}

A warning clears itself once the reading returns inside its band. A shutdown has to be acknowledged with the reset key after the cause has been cleared; {{ ref('sec:message-types') }} says which messages behave in which way.
