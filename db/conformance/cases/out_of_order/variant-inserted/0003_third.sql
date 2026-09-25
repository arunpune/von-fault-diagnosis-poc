-- SPDX-FileCopyrightText: 2026 Meddle S.r.l.
-- SPDX-License-Identifier: Apache-2.0
--
-- Conformance fixture: the third migration of a case. The out_of_order case
-- applies 0001 and 0003, then offers a directory that inserts 0002 between them.

CREATE TABLE public.t_three (id integer PRIMARY KEY);
