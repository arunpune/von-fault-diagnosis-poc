-- SPDX-FileCopyrightText: 2026 Meddle S.r.l.
-- SPDX-License-Identifier: Apache-2.0
--
-- A fictional two-condition slice of the fault catalog, written as `app_rw`
-- by test/integration/app-schema.test.ts.
--
-- The shape is what makes the view worth testing: `fau_fouled_oil_cooler` is
-- listed by both conditions, so its catalog entry must carry a `conditions`
-- array of length two ordered by the link's ordinal, while
-- `fau_blocked_intake_filter` is listed by one. The first cause carries a
-- signal-based and a behaviour-based move, one of them without a note or a
-- rendered sentence, so the view is shown to drop the absent keys.

INSERT INTO app.catalog_sections (document_id, section_ref, title, level, parent_ref, page_start, page_end)
SELECT d.id, s.section_ref, s.title, s.level, s.parent_ref, s.page_start, s.page_end
  FROM app.manual_documents d
 CROSS JOIN (VALUES ('8.2.3', 'Separator drain valve', 3, '8.2', 12, 13),
                    ('9.1.0', 'Dryer tower switching', 3, '9.1', 20, 21))
            AS s(section_ref, title, level, parent_ref, page_start, page_end)
 WHERE d.sha256 = repeat('a', 64);

INSERT INTO app.catalog_conditions (document_id, condition_id, title, symptom, symptoms,
                                    alarm_codes, signals, manual_section, page_start, page_end, source)
SELECT d.id, c.condition_id, c.title, c.symptom, c.symptoms, c.alarm_codes, c.signals,
       c.manual_section, c.page_start, c.page_end, c.source
  FROM app.manual_documents d
 CROSS JOIN (VALUES ('cnd_oil_temperature_high', 'Oil temperature above the normal band',
                     'The oil temperature climbs while the unit stays loaded.',
                     ARRAY['oil_temperature_high'], ARRAY['W101'], ARRAY['sig_oil_temperature'],
                     '8.2.3', 12, 13, 'tables'),
                    ('cnd_air_pressure_low', 'Air pressure below the set band',
                     'The unit never reaches the unload pressure.',
                     ARRAY['air_pressure_low'], ARRAY['S204'], ARRAY['sig_air_pressure'],
                     '9.1.0', 20, 21, 'tables'))
            AS c(condition_id, title, symptom, symptoms, alarm_codes, signals,
                 manual_section, page_start, page_end, source)
 WHERE d.sha256 = repeat('a', 64);

INSERT INTO app.catalog_causes (document_id, fault_id, name, summary, subsystem, benign, remedy,
                                parts, maintenance, related_alarms, manual_section, manual_anchor,
                                page, page_start, page_end, pages, source)
SELECT d.id, c.fault_id, c.name, c.summary, c.subsystem, c.benign, c.remedy,
       c.parts, c.maintenance, c.related_alarms, c.manual_section, c.manual_anchor,
       c.page, c.page_start, c.page_end, c.pages::jsonb, c.source
  FROM app.manual_documents d
 CROSS JOIN (VALUES ('fau_fouled_oil_cooler', 'Fouled oil cooler',
                     'Dust on the cooler matrix lowers the heat it can shed.',
                     'cooling', false, 'Clean the cooler matrix and recheck the oil temperature.',
                     ARRAY['prt_cooler_matrix'], ARRAY['mnt_cooler_cleaning'], ARRAY['W101'],
                     '8.2.3', 'sec-8-2-3', 12, 12, 13,
                     '{"clean": [12], "realistic": [14]}', 'tables'),
                    ('fau_blocked_intake_filter', 'Blocked intake filter',
                     'A loaded intake filter starves the element and lengthens the load phase.',
                     'intake_unloading', false, 'Replace the intake filter element.',
                     ARRAY['prt_intake_filter'], ARRAY['mnt_filter_change'], ARRAY['S204'],
                     '9.1.0', 'sec-9-1-0', 20, 20, 21,
                     '{"clean": [20], "realistic": [22]}', 'tables'))
            AS c(fault_id, name, summary, subsystem, benign, remedy, parts, maintenance,
                 related_alarms, manual_section, manual_anchor, page, page_start, page_end, pages, source)
 WHERE d.sha256 = repeat('a', 64);

-- Both conditions list the fouled cooler; only the low-pressure condition
-- lists the blocked filter.
INSERT INTO app.catalog_condition_causes (condition_pk, cause_pk, ordinal, likelihood, note)
SELECT cond.id, cause.id, l.ordinal, l.likelihood, l.note
  FROM (VALUES ('cnd_oil_temperature_high', 'fau_fouled_oil_cooler', 0, 'common', 'The usual finding on a dusty site.'),
               ('cnd_air_pressure_low', 'fau_fouled_oil_cooler', 1, 'occasional', NULL),
               ('cnd_air_pressure_low', 'fau_blocked_intake_filter', 0, 'rare', 'Seen after a missed service interval.'))
       AS l(condition_id, fault_id, ordinal, likelihood, note)
  JOIN app.catalog_conditions cond ON cond.condition_id = l.condition_id
  JOIN app.catalog_causes cause ON cause.fault_id = l.fault_id;

INSERT INTO app.catalog_checks (cause_pk, ordinal, instruction, expected)
SELECT cause.id, k.ordinal, k.instruction, k.expected
  FROM (VALUES ('fau_fouled_oil_cooler', 0, 'Inspect the cooler matrix for dust.', 'A clean matrix.'),
               ('fau_fouled_oil_cooler', 1, 'Compare the oil temperature with the normal band.', 'Inside the band.'),
               ('fau_blocked_intake_filter', 0, 'Read the intake filter indicator.', 'Green.'))
       AS k(fault_id, ordinal, instruction, expected)
  JOIN app.catalog_causes cause ON cause.fault_id = k.fault_id;

INSERT INTO app.catalog_remedies (cause_pk, ordinal, action, post_check)
SELECT cause.id, r.ordinal, r.action, r.post_check
  FROM (VALUES ('fau_fouled_oil_cooler', 0, 'Clean the cooler matrix.', 'Run loaded for ten minutes.'),
               ('fau_blocked_intake_filter', 0, 'Replace the intake filter element.', 'Reset the indicator.'))
       AS r(fault_id, ordinal, action, post_check)
  JOIN app.catalog_causes cause ON cause.fault_id = r.fault_id;

-- One signal-based move and one behaviour-based move on the shared cause; the
-- behaviour move carries neither a note nor a rendered sentence.
INSERT INTO app.catalog_signal_moves (cause_pk, ordinal, signal_id, behaviour, direction, phase, onset, note, text)
SELECT cause.id, m.ordinal, m.signal_id, m.behaviour, m.direction, m.phase, m.onset, m.note, m.move_text
  FROM (VALUES ('fau_fouled_oil_cooler', 0, 'sig_oil_temperature', NULL, 'rises', 'loaded', 'gradual',
                'Above the normal band after ten loaded minutes.',
                'Oil temperature rises gradually while the unit is loaded.'),
               ('fau_fouled_oil_cooler', 1, NULL, 'beh_load_cycle', 'faster', 'any', 'sustained', NULL, NULL),
               ('fau_blocked_intake_filter', 0, 'sig_air_pressure', NULL, 'low', 'loaded', 'gradual', NULL,
                'Air pressure stays low while the unit is loaded.'))
       AS m(fault_id, ordinal, signal_id, behaviour, direction, phase, onset, note, move_text)
  JOIN app.catalog_causes cause ON cause.fault_id = m.fault_id;

INSERT INTO app.catalog_alarms (document_id, code, type, title, display, trigger_text, signal_id,
                                direction, threshold, threshold_unit, delay_s, reset_rule, bit, manual_section)
SELECT d.id, a.code, a.type, a.title, a.display, a.trigger_text, a.signal_id,
       a.direction, a.threshold, a.threshold_unit, a.delay_s, a.reset_rule, a.bit_no, a.manual_section
  FROM app.manual_documents d
 CROSS JOIN (VALUES ('W101', 'warning', 'Oil temperature high', 'OIL TEMP HIGH',
                     'Oil temperature above the warning limit.', 'sig_oil_temperature',
                     'rises', 95.0, 'degC', 30, 'auto', 3, '8.2.3'),
                    ('S204', 'shutdown', 'Air pressure low', 'AIR PRESS LOW',
                     'Air pressure below the shutdown limit.', 'sig_air_pressure',
                     'falls', 4.5, 'bar', 10, 'manual', 11, '9.1.0'))
            AS a(code, type, title, display, trigger_text, signal_id, direction,
                 threshold, threshold_unit, delay_s, reset_rule, bit_no, manual_section)
 WHERE d.sha256 = repeat('a', 64);

INSERT INTO app.catalog_signals (document_id, signal_id, panel_label, name, description, unit,
                                 "group", kind, subsystem, metropt_column, range_min, range_max,
                                 normal_bands, manual_section)
SELECT d.id, s.signal_id, s.panel_label, s.name, s.description, s.unit,
       s."group", s.kind, s.subsystem, s.metropt_column, s.range_min, s.range_max,
       s.normal_bands::jsonb, s.manual_section
  FROM app.manual_documents d
 CROSS JOIN (VALUES ('sig_oil_temperature', 'OIL T', 'Oil temperature',
                     'Temperature of the oil leaving the separator.', 'degC',
                     'analog', 'temperature', 'oil', 'Oil_temperature', 0.0, 120.0,
                     '{"loaded": [60, 90]}', '8.2.3'),
                    ('sig_air_pressure', 'AIR P', 'Air pressure',
                     'Pressure at the reservoir outlet.', 'bar',
                     'analog', 'pressure', 'reservoirs', 'TP2', 0.0, 12.0,
                     '{"loaded": [6, 9]}', '9.1.0'))
            AS s(signal_id, panel_label, name, description, unit, "group", kind, subsystem,
                 metropt_column, range_min, range_max, normal_bands, manual_section)
 WHERE d.sha256 = repeat('a', 64);
