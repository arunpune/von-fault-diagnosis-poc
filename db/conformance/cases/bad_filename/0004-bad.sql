-- SPDX-FileCopyrightText: 2026 Meddle S.r.l.
-- SPDX-License-Identifier: Apache-2.0
--
-- Conformance fixture: a file whose name uses a hyphen where the contract asks
-- for an underscore. listMigrations() must refuse the whole directory with
-- invalid_filename before anything is applied, so t_one stays uncreated.

CREATE TABLE public.t_four (id integer PRIMARY KEY);
