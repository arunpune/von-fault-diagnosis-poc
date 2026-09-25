-- SPDX-FileCopyrightText: 2026 Meddle S.r.l.
-- SPDX-License-Identifier: Apache-2.0
--
-- Folded telemetry and two controller alarms for one simulated unit, written
-- as `app_rw` by test/integration/app-schema.test.ts.
--
-- The retention test does not read these rows: it replaces the table's
-- contents inside a transaction it rolls back, so it can state exactly which
-- minutes straddle the cut-off.

INSERT INTO app.telemetry_agg_1m (unit_id, minute_sim_ts, signal_id, n, min, max, avg, last, duty, discontinuity)
VALUES ('cau-7-01', '2020-02-09T10:00:00Z', 'sig_oil_temperature', 60, 71.0, 78.5, 74.2, 78.5, NULL, false),
       ('cau-7-01', '2020-02-09T10:01:00Z', 'sig_oil_temperature', 60, 72.5, 79.0, 75.1, 79.0, NULL, false),
       ('cau-7-01', '2020-02-09T10:00:00Z', 'sig_air_pressure', 60, 6.1, 8.9, 7.4, 8.9, NULL, true);

INSERT INTO app.native_alarms (unit_id, code, state, sim_ts, wall_ts, seq)
VALUES ('cau-7-01', 'W101', 'raised', '2020-02-09T10:00:30Z', '2026-09-20T08:00:00Z', 1),
       ('cau-7-01', 'W101', 'cleared', '2020-02-09T10:12:00Z', '2026-09-20T08:00:12Z', 2);
