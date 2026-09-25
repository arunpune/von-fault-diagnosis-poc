<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

## Setting table {#sec:settings-table}

{% if fact_in_prose('setting:cut_in_pressure') %}
The unit leaves the works with the cut-in pressure at {{ val('cut_in_pressure') }},
and only an operator who knows the service code may change a setting.
{% else %}
Only an operator who knows the service code may change a setting.
{% endif %}

{{ tables.settings() }}
