<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Simulation

`App.tsx` renders the default export of `SimulationPanel.tsx` from this fixed path at the top of the right rail. Every control sends one `POST /api/sim/:cmd { args }` through `useSimCommand`, whose acknowledged status reaches the live store at once (`applyAck`); running injections come from the live store too.

| File | What it is | Command |
| --- | --- | --- |
| `PlayPause.tsx` | The primary button, "Play" or "Pause" by the replay state; rests while in flight and while the link is down ("Waiting for the backend") | `play`, `pause` with `{}` |
| `SpeedControl.tsx` | Slider over `speed.ts`'s steps 1…3600×, one command per value commit | `speed` with `{ speed }` |
| `JumpMenu.tsx` | "Jump to", sections "Dataset failures" and "Diagnostic" (`presets.ts`) | `jump` with `{ preset_id }` |
| `InjectMenu.tsx`, `InjectDialog.tsx` | "Inject fault", running entries checked and disabled; every entry opens the parameter dialog (`inject-params.ts`), whose "Inject" sends | `inject` with `{ injection_id, params: { magnitude, duration_sim_min } }` |
| `ActiveInjections.tsx` | Badges "Oil cooler fouling since 2020-06-05 08:00:00" and "Clear injections" | `clear` with `{}` |
| `ResetReplay.tsx` | "Reset replay" behind a confirmation | `reset` with `{}` |

`use-sim-action.ts` gives each control its own mutation and the toasts; `command-errors.ts` turns every failure into one sentence (the acknowledgement's codes, `sim_timeout`, the route's `bad_request` and `sim_unreachable`, "Backend unavailable").

Test ids (`src/lib/testids.ts`): `tid.sim.play`, `speed`, `jump`, `jumpItem(preset_id)`, `inject`, `injectItem(injection_id)`, `active`, `clear`, `reset`. Menu items also carry `data-preset-id` / `data-injection-id`; a preset item's accessible name is its label (role `menuitem`), an injection item's is its label too (role `menuitemcheckbox`, checked while it runs).
