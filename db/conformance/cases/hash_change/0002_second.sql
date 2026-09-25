-- SPDX-FileCopyrightText: 2026 Meddle S.r.l.
-- SPDX-License-Identifier: Apache-2.0
--
-- Conformance fixture: the second migration of a case. Re-applying it would
-- fail on the duplicate key, which is what makes the `rerun` case meaningful.

CREATE TABLE public.t_two (id integer PRIMARY KEY, first_id integer NOT NULL REFERENCES public.t_one (id));
INSERT INTO public.t_two (id, first_id) VALUES (1, 1);
