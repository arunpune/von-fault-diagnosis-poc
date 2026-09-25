-- SPDX-FileCopyrightText: 2026 Meddle S.r.l.
-- SPDX-License-Identifier: Apache-2.0
--
-- Conformance fixture: the first migration of a case. Two statements, so the
-- single-batch path of the runner is exercised.
--
-- The copy under variant-modified/ differs from this file by exactly the digit
-- on the last line: nothing more may be needed for hash_mismatch.
-- hash marker: 1

CREATE TABLE public.t_one (id integer PRIMARY KEY, note text NOT NULL DEFAULT 'one');
INSERT INTO public.t_one (id) VALUES (1);
