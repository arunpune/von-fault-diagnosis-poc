-- SPDX-FileCopyrightText: 2026 Meddle S.r.l.
-- SPDX-License-Identifier: Apache-2.0
--
-- Two episodes of one simulated unit carried through the pipeline, written as
-- `app_rw` by test/integration/app-schema.test.ts.
--
-- Both episodes are open at once, which the `episodes_one_open` index allows
-- because their symptom keys differ; the index test adds a third episode that
-- collides. One ticket is in status `review` and one in status `open`: that is
-- the whole review model, and there is no queue table to fill.
--
-- The uuids are fixed rather than generated, so a failing assertion names the
-- row it was looking at.

INSERT INTO app.suspect_events (event_id, unit_id, sim_ts, wall_ts, episode_id, symptom_key,
                                rule_ids, machine_mode, evidence, observations, active_alarms,
                                co_symptoms, ambient, window_from_sim_ts, window_to_sim_ts, payload)
VALUES ('11111111-1111-4111-8111-111111111111', 'cau-7-01',
        '2020-02-09T10:05:00Z', '2026-09-20T08:05:00Z',
        'aaaaaaaa-0000-4000-8000-000000000001', 'oil_temperature_high',
        ARRAY['rul_oil_temperature_band'], 'loaded',
        '{"signals": {"sig_oil_temperature": {"level": "high"}}}'::jsonb,
        '{"sig_oil_temperature": {"avg": 92.4}}'::jsonb,
        ARRAY['W101'], ARRAY['air_pressure_low'], 'warm',
        '2020-02-09T09:50:00Z', '2020-02-09T10:05:00Z',
        '{"schema": "urn:fdp:schema:suspect-event:v1"}'::jsonb),
       ('22222222-2222-4222-8222-222222222222', 'cau-7-01',
        '2020-02-09T11:05:00Z', '2026-09-20T08:10:00Z',
        'aaaaaaaa-0000-4000-8000-000000000002', 'air_pressure_low',
        ARRAY['rul_air_pressure_band'], 'loaded',
        '{"signals": {"sig_air_pressure": {"level": "low"}}}'::jsonb,
        '{"sig_air_pressure": {"avg": 4.9}}'::jsonb,
        ARRAY['S204'], ARRAY[]::text[], 'warm',
        '2020-02-09T10:50:00Z', '2020-02-09T11:05:00Z',
        '{"schema": "urn:fdp:schema:suspect-event:v1"}'::jsonb);

INSERT INTO app.episodes (episode_id, unit_id, symptom_key, symptom_keys, status, opened_sim_ts,
                          last_event_sim_ts, last_decision_sim_ts, first_event_id,
                          event_count, decision_count)
VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 'cau-7-01', 'oil_temperature_high',
        ARRAY['oil_temperature_high'], 'open', '2020-02-09T10:05:00Z',
        '2020-02-09T10:05:00Z', '2020-02-09T10:05:30Z',
        '11111111-1111-4111-8111-111111111111', 1, 1),
       ('aaaaaaaa-0000-4000-8000-000000000002', 'cau-7-01', 'air_pressure_low',
        ARRAY['air_pressure_low'], 'open', '2020-02-09T11:05:00Z',
        '2020-02-09T11:05:00Z', '2020-02-09T11:05:30Z',
        '22222222-2222-4222-8222-222222222222', 1, 1);

INSERT INTO app.decisions (decision_id, episode_id, event_id, unit_id, sim_ts, wall_ts,
                           backend, model, status, choice, confidence, probabilities, support,
                           severity_level, severity_score, severity_probabilities, severity_confidence,
                           gate_outcome, abstained, candidates, state, state_digest,
                           request_id, rationale, input_tokens, output_tokens, latency_ms, message)
VALUES ('bbbbbbbb-0000-4000-8000-000000000001',
        'aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
        'cau-7-01', '2020-02-09T10:05:30Z', '2026-09-20T08:05:30Z',
        'jev', 'jev-1.13', 'ok', 'fau_fouled_oil_cooler', 0.62,
        '{"fau_fouled_oil_cooler": 0.62, "fau_blocked_intake_filter": 0.38}'::jsonb,
        '{"chunks": 4}'::jsonb,
        'medium', 0.55, '{"medium": 0.7, "high": 0.3}'::jsonb, 0.71,
        'review', false,
        '[{"fault_id": "fau_fouled_oil_cooler", "probability": 0.62}]'::jsonb,
        '{"symptom_key": "oil_temperature_high"}'::jsonb, repeat('b', 64),
        'req-0001', 'The oil temperature band was exceeded while loaded.',
        1234, 0, 412, '{"schema": "urn:fdp:schema:decision:v1"}'::jsonb),
       ('bbbbbbbb-0000-4000-8000-000000000002',
        'aaaaaaaa-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222',
        'cau-7-01', '2020-02-09T11:05:30Z', '2026-09-20T08:10:30Z',
        'llm', 'llm-medium', 'ok', 'fau_blocked_intake_filter', 0.88,
        '{"fau_blocked_intake_filter": 0.88, "fau_fouled_oil_cooler": 0.12}'::jsonb,
        '{"chunks": 6}'::jsonb,
        'high', 0.81, '{"high": 0.8, "critical": 0.2}'::jsonb, 0.9,
        'ticket', false,
        '[{"fault_id": "fau_blocked_intake_filter", "probability": 0.88}]'::jsonb,
        '{"symptom_key": "air_pressure_low"}'::jsonb, repeat('c', 64),
        'req-0002', 'The unit never reached the unload pressure.',
        1000, 200, 980, '{"schema": "urn:fdp:schema:decision:v1"}'::jsonb);

INSERT INTO app.decision_candidates (decision_id, rank, fault_id, condition_id, name,
                                     probability, support, benign, manual_ref, retrieval)
VALUES ('bbbbbbbb-0000-4000-8000-000000000001', 1, 'fau_fouled_oil_cooler',
        'cnd_oil_temperature_high', 'Fouled oil cooler', 0.62, 0.7, false,
        '{"section": "8.2.3", "page": 12}'::jsonb, '{"chunk_ids": [1]}'::jsonb),
       ('bbbbbbbb-0000-4000-8000-000000000001', 2, 'fau_blocked_intake_filter',
        'cnd_air_pressure_low', 'Blocked intake filter', 0.38, 0.4, false,
        '{"section": "9.1.0", "page": 20}'::jsonb, '{"chunk_ids": [2]}'::jsonb);

INSERT INTO app.tickets (ticket_id, episode_id, unit_id, status, fault_id, condition_id, title,
                         cause, remedy, checks, manual_ref, evidence, confidence, probabilities,
                         severity_level, backend, model, rationale, latest_decision_id,
                         opened_sim_ts, updated_sim_ts, update_count)
VALUES ('cccccccc-0000-4000-8000-000000000001',
        'aaaaaaaa-0000-4000-8000-000000000001', 'cau-7-01', 'review',
        'fau_fouled_oil_cooler', 'cnd_oil_temperature_high', 'Oil temperature above the normal band',
        'Fouled oil cooler', 'Clean the cooler matrix and recheck the oil temperature.',
        '["Inspect the cooler matrix for dust."]'::jsonb,
        '{"section": "8.2.3", "page": 12}'::jsonb,
        '[{"signal": "sig_oil_temperature", "avg": 92.4}]'::jsonb,
        0.62, '{"fau_fouled_oil_cooler": 0.62}'::jsonb, 'medium', 'jev', 'jev-1.13',
        'Below the ticket threshold, so it waits for a second decision.',
        'bbbbbbbb-0000-4000-8000-000000000001',
        '2020-02-09T10:05:30Z', '2020-02-09T10:05:30Z', 0),
       ('cccccccc-0000-4000-8000-000000000002',
        'aaaaaaaa-0000-4000-8000-000000000002', 'cau-7-01', 'open',
        'fau_blocked_intake_filter', 'cnd_air_pressure_low', 'Air pressure below the set band',
        'Blocked intake filter', 'Replace the intake filter element.',
        '["Read the intake filter indicator."]'::jsonb,
        '{"section": "9.1.0", "page": 20}'::jsonb,
        '[{"signal": "sig_air_pressure", "avg": 4.9}]'::jsonb,
        0.88, '{"fau_blocked_intake_filter": 0.88}'::jsonb, 'high', 'llm', 'llm-medium',
        'Above the ticket threshold on the first decision.',
        'bbbbbbbb-0000-4000-8000-000000000002',
        '2020-02-09T11:05:30Z', '2020-02-09T11:05:30Z', 0);

UPDATE app.episodes e
   SET ticket_id = t.ticket_id
  FROM app.tickets t
 WHERE t.episode_id = e.episode_id;

INSERT INTO app.ticket_closures (ticket_id, verdict, note, closed_by, sim_ts, wall_ts)
VALUES ('cccccccc-0000-4000-8000-000000000002', 'correct',
        'The filter element was loaded as described.', 'technician-1',
        '2020-02-09T12:00:00Z', '2026-09-20T09:00:00Z');
