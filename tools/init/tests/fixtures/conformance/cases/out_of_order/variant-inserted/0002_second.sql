-- SPDX-FileCopyrightText: 2026 Meddle S.r.l.
-- SPDX-License-Identifier: Apache-2.0
--
-- Conformance fixture: the migration that arrives too late. 0003 is already
-- applied, so the runner must refuse this directory with out_of_order and
-- leave t_two uncreated.

CREATE TABLE public.t_two (id integer PRIMARY KEY);
