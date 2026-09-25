-- SPDX-FileCopyrightText: 2026 Meddle S.r.l.
-- SPDX-License-Identifier: Apache-2.0
--
-- Conformance fixture: a migration that fails halfway. The table is created
-- first, then a division by zero aborts the batch, so a runner that does not
-- roll the whole file back leaves t_partial behind.

CREATE TABLE public.t_partial (id integer PRIMARY KEY);
SELECT 1 / 0;
