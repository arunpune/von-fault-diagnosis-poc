<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->
<!-- Test fixture: the smallest chapter 2 that carries every anchor the
     manual's outline fixes for chapter 2, one figure call and the
     five prose-only facts of the realistic variant. Synthetic text. -->

## Overview {#sec:overview}

The {{ machine.identity.name }} draws in ambient air, compresses it in an oil-injected screw element and delivers dry compressed air to the works network. The {{ machine.identity.controller }} controller runs the unit without an operator once it has been commissioned. The unit never works above {{ q(machine.ratings.max_working_pressure) }}.

## Air flow {#sec:air-flow}

Ambient air enters through the intake filter and the intake valve and reaches the compression element. The compressed air and the injected oil leave the element together and enter the separator vessel, where {{ sig('discharge_pressure') }} is measured.

## Oil circuit {#sec:oil-circuit}

Oil collects at the bottom of the separator vessel and is pushed back to the compression element by the pressure of the vessel itself. {{ sig('oil_temperature') }} is measured at the element outlet and decides whether the thermostatic valve sends the oil through the cooler or past it.

## Cooling {#sec:cooling}

One fan draws cooling air over the oil cooler and the aftercooler. {{ sig('ambient_temperature') }} is measured at the cooling-air inlet, because the whole cooling capacity of the unit depends on it.

## Air drying {#sec:drying}

Two desiccant towers dry the air in turn: one tower dries while the other regenerates on a small part of the dried air. {% if fact_in_prose('machine.ratings.dryer_purge_fraction') %}The regenerating tower keeps only a small fraction of the delivered air for itself, and that air leaves through the purge silencer.{% endif %} {% if fact_in_prose('setting:dryer_changeover_timeout') %}The controller expects the towers to change over within the changeover timeout and reports a message when they do not.{% endif %}

## Regulation {#sec:regulation}

The unit regulates by loading and unloading. It loads when {{ sig('line_pressure') }} falls to the cut-in setting and unloads when it reaches the cut-out setting. {% if fact_in_prose('setting:unload_run_on_time') %}After unloading, the motor keeps turning for the run-on time so that short pauses in demand do not stop it.{% endif %} {% if fact_in_prose('setting:restart_delay') %}A restart delay then keeps the motor off long enough to protect it against a rapid second start.{% endif %} {% if fact_in_prose('machine.ratings.minimum_pressure_valve_opening') %}The minimum-pressure valve does not open before the separator vessel has built up enough pressure to circulate the oil.{% endif %}

## Process schematic {#sec:schematic}

The schematic below shows the air path in reading order and the oil circuit underneath it; every measured value carries the panel label the controller shows, and {{ ref('ch:3') }} explains those readings.

{{ figure('system-schematic', 'Air and oil path of the unit') }}
