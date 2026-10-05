-- SPDX-FileCopyrightText: 2026 Meddle S.r.l.
-- SPDX-License-Identifier: Apache-2.0
--
-- The cost of the two decisions and one system alert, written as `app_rw` by
-- test/integration/app-schema.test.ts.
--
-- The token counts and prices are two worked examples: 1234 input tokens at
-- 0.042 per million, and 1000 input plus 200 output tokens at 5 and 25.
-- `cost_usd` is generated, so the test reads it back rather than stating it
-- here.

INSERT INTO app.cost_ledger (decision_id, backend, model, input_tokens, output_tokens,
                             price_input_per_mtok, price_output_per_mtok, prices_as_of, sim_ts)
VALUES ('bbbbbbbb-0000-4000-8000-000000000001', 'von', 'von-1.13', 1234, 0,
        0.042, 0, DATE '2026-09-01', '2020-02-09T10:05:30Z'),
       ('bbbbbbbb-0000-4000-8000-000000000002', 'llm', 'llm-medium', 1000, 200,
        5, 25, DATE '2026-09-01', '2020-02-09T11:05:30Z');

INSERT INTO app.system_alerts (alert_id, unit_id, kind, state, raised_wall_ts, cleared_wall_ts, details)
VALUES ('dddddddd-0000-4000-8000-000000000001', 'cau-7-01', 'telemetry_silent', 'raised',
        '2026-09-20T08:20:00Z', NULL, '{"silent_for_s": 90}'::jsonb);
