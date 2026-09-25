// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

//go:build integration

// The signal-level gate: ten scenarios of known ground truth, each of which
// must be visible in the telemetry that leaves the gateway.
//
// The gate runs no diagnosis code, so "the fault was found" cannot mean a
// ticket. It means the signal is there to be found:
//
//   - 1–4: jump to each failure preset of the recording and wait for the
//     native CTRL-7 alarm the manual assigns to that failure's signature.
//     Signature A is the continuous-load or the purge-pressure warning,
//     signature B the low-pressure-switch warning; the codes are looked up in
//     regmap.Alarms by what their triggers watch, never written down here
//     so a renumbered registry moves the gate with it.
//   - 5–9: start one injection each on the baseline segment and compare the
//     published tags against a second, un-injected pass over the same rows.
//     Every transform of the definition must have moved its tag in the
//     declared direction by at least half of what the catalog configures.
//   - 10: the same un-injected pass must leave the controller quiet.
//
// The gate passes at ≥ 8 of 10 with the negative among them. The whole run
// writes a JSON summary to $FDP_GATE_REPORT.
//
// Reading presets.json and injections.json here is allowed: this is test code
// of the injector, and ground-truth isolation names the simulator as a
// permitted reader. The gateway is untouched; everything is read back from the
// broker through the anonymous subscription, exactly as a diagnosing client
// would.

package e2e

import (
	"encoding/json"
	"fmt"
	"maps"
	"math"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/e2e/gate"
	"fault-diagnosis-poc/services/modbus/internal/injection"
	"fault-diagnosis-poc/services/modbus/internal/machine"
	"fault-diagnosis-poc/services/modbus/internal/mqttio"
	"fault-diagnosis-poc/services/modbus/internal/regmap"
	"fault-diagnosis-poc/services/modbus/internal/sim"
)

// gateSlice is the multi-segment slice `make fixtures` cuts for this gate:
// the baseline of 3 February and the four failure presets, each from its
// lead-in start (data/fixtures/metropt3-slices.json).
const gateSlice = "sim-gate"

// gateReportEnv names the file the JSON summary is written to. Without it the
// run still prints every verdict; it just leaves nothing behind.
const gateReportEnv = "FDP_GATE_REPORT"

// gateSegmentGapMs separates the slice's five segments from the holes inside
// them. The segments are weeks apart and the widest hole inside one is under
// six minutes, so an hour sits safely between the two and the boundaries move
// with a re-cut slice instead of being written down.
const gateSegmentGapMs uint64 = 3_600_000

// gateRunBudget bounds one scenario's replay. The longest window is nine
// recorded hours, nine wall seconds at 3600×; three minutes leaves room for
// the race detector without letting a stall pass unnoticed. It scales with
// FDP_TIMING_SLACK like every other bound in this package.
const gateRunBudget = 180 * time.Second

// gateMinGuarded is the fewest published samples a transform's verdict may
// rest on. The baseline segment compresses in twelve short runs, so a
// `loaded` transform is judged on a few dozen samples and a window that
// offers fewer than this is reported as inconclusive rather than passed.
const gateMinGuarded = 10

// gateHalf is the fraction of a configured move a tag must actually make:
// "at least half the configured magnitude at hold".
const gateHalf = 0.5

// gateScatterFactor is what the deviation of an injected-minus-control delta
// must reach against the deterministic transforms' own spread: "standard
// deviation up by ≥ 50 %".
const gateScatterFactor = 1.5

// gateScaleFloor is the smallest control value a ratio is measured on, so a
// tag passing through zero cannot invent an enormous relative move.
const gateScaleFloor = 0.1

// gateMsPerMin is the simulated milliseconds in one minute; the catalog
// states every envelope in minutes.
const gateMsPerMin uint64 = 60_000

// The five injections of the gate, in scenario order. They are named here
// because the gate scores these and not the other four of the catalog; every
// tag, direction and amount behind them is read from injections.json.
var gateInjections = []string{
	"oil_cooler_fouling",
	"high_ambient_temperature",
	"air_leak_downstream",
	"intake_valve_sticking",
	"motor_overload",
}

// gateWindow is a stretch of the recording, in epoch milliseconds UTC.
type gateWindow struct{ from, until uint64 }

// String renders a window the way the report writes it.
func (w gateWindow) String() string {
	return mqttio.SimTS(w.from) + ".." + mqttio.SimTS(w.until)
}

// segments splits the slice into the contiguous stretches of rows a replay
// crosses without a collapsed hole wider than gateSegmentGapMs.
func (f *fixture) segments() []gateWindow {
	out := []gateWindow{{from: f.timestamps[0]}}
	for i := 1; i < len(f.timestamps); i++ {
		if f.timestamps[i] > f.timestamps[i-1]+gateSegmentGapMs {
			out[len(out)-1].until = f.timestamps[i-1]
			out = append(out, gateWindow{from: f.timestamps[i]})
		}
	}
	out[len(out)-1].until = f.timestamps[len(f.timestamps)-1]
	return out
}

// segmentAt returns the segment a jump to ms lands in: the first stretch that
// has not ended before it.
//
// The instant need not be inside a segment. A preset's lead-in start is a
// whole minute and the slice was cut on the same minute, so the recording's
// first row of that segment is usually a few seconds later; the engine seeks
// to the first row at or after the instant, which is that row.
func segmentAt(t *testing.T, segments []gateWindow, ms uint64) gateWindow {
	t.Helper()

	for _, segment := range segments {
		if ms <= segment.until {
			return segment
		}
	}
	t.Fatalf("every segment of the slice ends before %s; the slice has %v", mqttio.SimTS(ms), segments)
	return gateWindow{}
}

// gatePreset is one failure preset with the signature its failure carries.
type gatePreset struct {
	preset    sim.Preset
	failureID string
	signature string
}

// start is the instant a jump to this preset lands on: its lead-in start,
// clamped to the first row of the slice exactly as the engine clamps it.
func (p gatePreset) start(f *fixture) uint64 {
	return max(p.preset.LeadInStartMs(), f.firstMs())
}

// loadGatePresets reads the failure presets of GT_DIR/presets.json and pairs
// each one with the signature its failure carries in the failure table.
//
// The instants come from sim.LoadPresets — the engine's own loader — so the
// jump target is resolved exactly as a `jump {"preset_id": ...}` would
// resolve it; the two fields the machine does not read, `kind` and
// `failure_id`, are decoded from the same file beside it.
func loadGatePresets(t *testing.T, dir string) []gatePreset {
	t.Helper()

	path := sim.Config{GTDir: dir}.PresetsPath()
	resolved, err := sim.LoadPresets(path)
	require.NoErrorf(t, err, "reading %s", path)

	var doc struct {
		Presets []struct {
			PresetID  string `json:"preset_id"`
			Kind      string `json:"kind"`
			FailureID string `json:"failure_id"`
		} `json:"presets"`
	}
	body, err := os.ReadFile(path)
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(body, &doc))
	require.Lenf(t, doc.Presets, len(resolved), "%s decodes to the same presets twice", path)

	signatures := loadGateSignatures(t, dir)
	var out []gatePreset
	for i, raw := range doc.Presets {
		require.Equalf(t, resolved[i].PresetID, raw.PresetID, "preset %d of %s", i, path)
		if raw.Kind != "failure" {
			continue
		}
		signature, ok := signatures[raw.FailureID]
		require.Truef(t, ok, "the failure table has no %q for preset %q", raw.FailureID, raw.PresetID)
		out = append(out, gatePreset{preset: resolved[i], failureID: raw.FailureID, signature: signature})
	}
	require.NotEmptyf(t, out, "%s declares no failure preset", path)
	return out
}

// loadGateSignatures reads failure id → signature from the failure table.
func loadGateSignatures(t *testing.T, dir string) map[string]string {
	t.Helper()

	path := sim.Config{GTDir: dir}.FailuresPath()
	body, err := os.ReadFile(path)
	require.NoErrorf(t, err, "reading %s", path)

	var doc struct {
		Failures []struct {
			ID        string `json:"id"`
			Signature string `json:"signature"`
		} `json:"failures"`
	}
	require.NoError(t, json.Unmarshal(body, &doc))

	out := make(map[string]string, len(doc.Failures))
	for _, failure := range doc.Failures {
		require.NotEmptyf(t, failure.Signature, "failure %q carries no signature in %s", failure.ID, path)
		out[failure.ID] = failure.Signature
	}
	require.NotEmptyf(t, out, "%s lists no failure", path)
	return out
}

// gateReportPath resolves where the JSON summary is written, and is empty
// when the run was not asked for one.
//
// A relative $FDP_GATE_REPORT is taken from the repository root. `go test`
// runs in the package directory, so the documented command —
// `FDP_GATE_REPORT=reports/sim-gate.json ... ./internal/e2e/ -run Gate` from
// services/modbus — would otherwise leave the file four levels down, beside
// this file and outside the gitignored `reports/` of the checkout. The root is
// resolved the way groundTruthDir resolves the ground-truth tree, four levels
// up.
func gateReportPath(t *testing.T) string {
	t.Helper()

	raw := os.Getenv(gateReportEnv)
	if raw == "" || filepath.IsAbs(raw) {
		return raw
	}
	root, err := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	require.NoError(t, err)
	return filepath.Join(root, raw)
}

// gateGroundTruthDir returns the ground-truth tree and fails when the checkout
// only has the cut-down simulator fixtures: the gate scores the documents the
// product ships, not a fixture of them.
func gateGroundTruthDir(t *testing.T) string {
	t.Helper()

	dir, real := groundTruthDir()
	require.Truef(t, real, "the gate needs packages/ground-truth/data; %s is the simulator fixture tree", dir)
	return dir
}

// alarmsMatching returns the alarms of the generated table whose trigger
// answers pred, and fails when none does — a registry that no longer carries
// the message is a finding, not a silent pass.
func alarmsMatching(t *testing.T, what string, pred func(regmap.Trigger) bool) []regmap.Alarm {
	t.Helper()

	var found []regmap.Alarm
	for _, alarm := range regmap.Alarms {
		if pred(alarm.Trigger) {
			found = append(found, alarm)
		}
	}
	require.NotEmptyf(t, found, "the generated table has no alarm that %s", what)
	return found
}

// signatureAlarms returns the alarms one failure signature is expected to
// raise, found by what their triggers watch rather than by their codes.
//
// Signature A is the stuck-loaded run with raised purge pressure, so the
// controller's own answer to it is the continuous-load warning or the
// purge-pressure warning; signature B is the fast decay that trips the
// low-pressure switch (the failure table's `signature`,
// docs/dataset.md#two-leak-signatures).
func signatureAlarms(t *testing.T, signature string) []regmap.Alarm {
	t.Helper()

	switch signature {
	case "A":
		load := alarmsMatching(t, "counts how long the unit has been compressing",
			func(tr regmap.Trigger) bool {
				return tr.Kind == "state_duration" && tr.State == machine.StateLoaded.String()
			})
		purge := alarmsMatching(t, "watches the dryer purge pressure rise",
			func(tr regmap.Trigger) bool {
				return tr.Kind == "threshold" && tr.Signal == "dryer_purge_pressure" && tr.Op == "gt"
			})
		return append(load, purge...)
	case "B":
		return alarmsMatching(t, "watches the low-pressure switch",
			func(tr regmap.Trigger) bool {
				return tr.Kind == "digital" && tr.Signal == "low_pressure_switch"
			})
	default:
		t.Fatalf("the gate has no alarm rule for signature %q", signature)
		return nil
	}
}

// dwellS is how long an alarm's condition must hold before its bit is set, in
// simulated seconds. A state_duration trigger states it as `duration_s`, the
// other kinds as `delay_s`.
func dwellS(alarm regmap.Alarm) int {
	if alarm.Trigger.Kind == "state_duration" {
		return alarm.Trigger.DurationS
	}
	return alarm.Trigger.DelayS
}

// alarmByCode returns the table entry one published code belongs to.
func alarmByCode(code string) (regmap.Alarm, bool) {
	i := slices.IndexFunc(regmap.Alarms, func(a regmap.Alarm) bool { return a.Code == code })
	if i < 0 {
		return regmap.Alarm{}, false
	}
	return regmap.Alarms[i], true
}

// tap is the gate's reader of the anonymous telemetry subscription. It
// decodes each batch once and hands the samples over a window at a time, so a
// run of twenty thousand samples neither re-parses the stream on every poll
// nor holds it all at once.
type tap struct {
	stack *stack
	next  int
	buf   []telemetrySample
	last  uint32
}

// poll decodes every batch that arrived since the last call.
func (tp *tap) poll(t *testing.T) {
	t.Helper()

	messages := tp.stack.plant.on(tp.stack.topics.Telemetry())
	for ; tp.next < len(messages); tp.next++ {
		for _, sample := range decodeBatch(t, messages[tp.next].payload, tp.next) {
			tp.buf = append(tp.buf, sample)
			tp.last = max(tp.last, sample.Seq)
		}
	}
}

// peek returns everything buffered since the last drain, decoding what has
// arrived meanwhile.
func (tp *tap) peek(t *testing.T) []telemetrySample {
	t.Helper()
	tp.poll(t)
	return tp.buf
}

// lastSeq is the newest sequence number the subscriber has been handed.
func (tp *tap) lastSeq(t *testing.T) uint32 {
	t.Helper()
	tp.poll(t)
	return tp.last
}

// drain returns the buffer and empties it.
func (tp *tap) drain(t *testing.T) []telemetrySample {
	t.Helper()
	tp.poll(t)
	out := tp.buf
	tp.buf = nil
	return out
}

// gateRunner is one machine driven through the ten scenarios.
type gateRunner struct {
	stack    *stack
	tap      *tap
	segments []gateWindow
}

// pause stops the replay. It is sent before every jump, because a machine that
// ran out of data replays from the first row on the next `play` and would
// throw the jump away.
func (g *gateRunner) pause(t *testing.T) {
	t.Helper()

	ack := g.stack.command("pause", `{}`)
	require.Truef(t, ack.OK, "pause was refused: %s", ack.raw)
}

// settle waits until every sample the machine has emitted has been published
// by the gateway and delivered to the subscriber. The machine is paused when
// it is called, so the head sequence number cannot move under it.
func (g *gateRunner) settle(t *testing.T) {
	t.Helper()

	head := g.stack.engine.Snapshot().HeadSeq
	if head == 0 {
		return
	}
	waitFor(t, func() bool { return g.stack.service.Snapshot().LastSeq >= head },
		fmt.Sprintf("the gateway to publish sample %d", head))
	waitFor(t, func() bool { return g.tap.lastSeq(t) >= head },
		fmt.Sprintf("sample %d to reach the subscriber", head))
}

// replay positions the machine at the start of w, runs prepare — which may
// start an injection — and plays until the simulated clock has left w or stop
// reports that the evidence is already in. It returns every sample the
// anonymous subscriber received inside w.
func (g *gateRunner) replay(t *testing.T, w gateWindow, prepare func(), stop func() bool) []telemetrySample {
	t.Helper()

	g.pause(t)
	jump := g.stack.command("jump", `{"sim_ts":"`+mqttio.SimTS(w.from)+`"}`)
	require.Truef(t, jump.OK, "the jump to %s was refused: %s", mqttio.SimTS(w.from), jump.raw)

	// Everything the earlier scenarios emitted is now behind the cursor, so
	// what this window collects is its own.
	g.settle(t)
	g.tap.drain(t)

	if prepare != nil {
		prepare()
	}

	play := g.stack.command("play", `{}`)
	require.Truef(t, play.OK, "play was refused: %s", play.raw)

	waitUntil(t, budget(t, gateRunBudget), func() bool {
		if stop != nil && stop() {
			return true
		}
		snapshot := g.stack.engine.Snapshot()
		return snapshot.SimTsMs >= w.until || snapshot.State == sim.StateStopped
	}, "the replay of "+w.String())

	g.pause(t)
	g.settle(t)

	var out []telemetrySample
	for _, sample := range g.tap.drain(t) {
		if sample.SimTsMs >= w.from && sample.SimTsMs <= w.until {
			out = append(out, sample)
		}
	}
	require.NotEmptyf(t, out, "nothing was published inside %s", w)
	return out
}

// presetScenario is one of scenarios 1–4: jump to a failure preset and wait
// for the alarm its signature is expected to raise, at or after the instant
// the preset declares the failure at. An alarm that was already up during the
// lead-in counts, because it is still up inside the window — its first
// instant is recorded either way.
func (g *gateRunner) presetScenario(t *testing.T, id int, p gatePreset) gate.Scenario {
	t.Helper()

	alarms := signatureAlarms(t, p.signature)
	codes := make([]string, 0, len(alarms))
	for _, alarm := range alarms {
		codes = append(codes, alarm.Code)
	}

	start := p.start(g.stack.fixture)
	segment := segmentAt(t, g.segments, start)
	w := gateWindow{from: max(start, segment.from), until: segment.until}
	require.Lessf(t, p.preset.SimTsMs, w.until,
		"the slice does not reach the instant %s declares the failure at", p.preset.PresetID)

	t.Logf("scenario %d: %s (%s, signature %s) over %s, waiting for one of %v at or after %s",
		id, p.preset.PresetID, p.failureID, p.signature, w, codes, mqttio.SimTS(p.preset.SimTsMs))

	// The window ends as soon as the evidence is in: the rest of the segment
	// would only cost wall time. The scan keeps its own cursor so the poll
	// loop stays linear in the samples it has seen.
	scanned := 0
	var hit telemetrySample
	var hitCode string
	found := func() bool {
		buffered := g.tap.peek(t)
		for ; scanned < len(buffered); scanned++ {
			sample := buffered[scanned]
			if sample.SimTsMs < p.preset.SimTsMs {
				continue
			}
			for _, code := range codes {
				if slices.Contains(sample.Alarms, code) {
					hit, hitCode = sample, code
					return true
				}
			}
		}
		return false
	}

	samples := g.replay(t, w, nil, found)
	scenario := gate.Scenario{
		ID: id, Name: p.preset.Label, Kind: gate.KindPreset, Subject: p.preset.PresetID,
		Signature: p.signature,
		Window:    gate.Window{From: mqttio.SimTS(w.from), Until: mqttio.SimTS(w.until)},
		Samples:   len(samples),
	}

	if hitCode == "" {
		scenario.Note = fmt.Sprintf("none of %v reached the wire at or after %s in %d samples",
			codes, mqttio.SimTS(p.preset.SimTsMs), len(samples))
		scenario.Evidence = []gate.Evidence{{
			Kind: gate.EvidenceAlarm, Samples: len(samples), Detail: scenario.Note,
		}}
		return scenario
	}

	alarm, ok := alarmByCode(hitCode)
	require.Truef(t, ok, "the published code %q is not in the generated table", hitCode)
	scenario.Passed = true
	scenario.Evidence = []gate.Evidence{{
		Kind: gate.EvidenceAlarm, Code: hitCode, SimTS: hit.SimTS, Samples: len(samples), OK: true,
		Detail: fmt.Sprintf("%s (%s, bit %d) after %d s of %s; first seen at %s, sample %d",
			hitCode, alarm.Type, alarm.Bit, dwellS(alarm), alarm.Trigger.Kind,
			firstAlarmTS(samples, hitCode), hit.Seq),
	}}
	return scenario
}

// firstAlarmTS is the first instant a code appears anywhere in the window,
// lead-in included, which is what a reader of the summary wants beside the
// instant that satisfied the rule.
func firstAlarmTS(samples []telemetrySample, code string) string {
	for _, sample := range samples {
		if slices.Contains(sample.Alarms, code) {
			return sample.SimTS
		}
	}
	return ""
}

// negativeScenario is scenario 10: the un-injected pass over the baseline
// segment must leave the controller quiet. A bit that is set has by
// definition already held for its dwell, so the rule is that none of them
// stays set for longer than that — a clean segment produces no sustained
// alarm at all.
func negativeScenario(t *testing.T, id int, samples []telemetrySample, w gateWindow) gate.Scenario {
	t.Helper()

	type stretch struct {
		startMs, lastMs uint64
	}
	open := map[string]stretch{}
	longest := map[string]uint64{}
	for _, sample := range samples {
		for code := range open {
			if !slices.Contains(sample.Alarms, code) {
				delete(open, code)
			}
		}
		for _, code := range sample.Alarms {
			run, ok := open[code]
			if !ok {
				run = stretch{startMs: sample.SimTsMs}
			}
			run.lastMs = sample.SimTsMs
			open[code] = run
			longest[code] = max(longest[code], run.lastMs-run.startMs)
		}
	}

	scenario := gate.Scenario{
		ID: id, Name: "Baseline segment, nothing injected", Kind: gate.KindNegative,
		Subject: "baseline-" + mqttio.SimTS(w.from)[:10],
		Window:  gate.Window{From: mqttio.SimTS(w.from), Until: mqttio.SimTS(w.until)},
		Samples: len(samples),
	}

	if len(longest) == 0 {
		scenario.Passed = true
		scenario.Evidence = []gate.Evidence{{
			Kind: gate.EvidenceQuiet, Samples: len(samples), OK: true,
			Detail: "no alarm bit was set over the whole segment",
		}}
		return scenario
	}

	codes := slices.Sorted(maps.Keys(longest))
	scenario.Passed = true
	for _, code := range codes {
		alarm, ok := alarmByCode(code)
		require.Truef(t, ok, "the published code %q is not in the generated table", code)
		held := float64(longest[code]) / 1000
		dwell := float64(dwellS(alarm))
		evidence := gate.Evidence{
			Kind: gate.EvidenceQuiet, Code: code, Samples: len(samples),
			Observed: held, Required: dwell, OK: held <= dwell,
			Detail: fmt.Sprintf("%s stayed up for %.0f s against a dwell of %.0f s", code, held, dwell),
		}
		if !evidence.OK {
			scenario.Passed = false
			scenario.Note = evidence.Detail
		}
		scenario.Evidence = append(scenario.Evidence, evidence)
	}
	return scenario
}

// gatePair is one sample of an injected run beside the sample the control run
// published for the same recorded row.
type gatePair struct {
	injected telemetrySample
	control  telemetrySample
	// state is the load state of the row, classified from the control run's
	// own values: the engine conditions a transform on the state it computed
	// before any overlay, so the un-injected pass carries it exactly.
	state machine.State
}

// gatePairs matches an injected window against the control run row by row and
// keeps the pairs that fall inside the envelope's hold, where the magnitude
// is one and the catalog's numbers are the whole of the move.
func gatePairs(t *testing.T, injected []telemetrySample,
	control map[uint64]telemetrySample, hold gateWindow,
) []gatePair {
	t.Helper()

	out := make([]gatePair, 0, len(injected))
	for _, sample := range injected {
		if sample.SimTsMs < hold.from || sample.SimTsMs > hold.until {
			continue
		}
		reference, ok := control[sample.SimTsMs]
		if !ok {
			continue
		}
		out = append(out, gatePair{injected: sample, control: reference, state: gateState(t, reference)})
	}
	require.NotEmptyf(t, out, "the control run has no row inside %s", hold)
	return out
}

// gateState classifies one published sample with the load-state rule of
// machine.Classify. The three inputs are resolved through regmap.Signals by
// their MetroPT-3 column, so a tag rename moves the rule with it.
func gateState(t *testing.T, sample telemetrySample) machine.State {
	t.Helper()

	return machine.Classify(
		gateDigital(t, sample, tagOfColumn(t, "COMP")),
		gateDigital(t, sample, tagOfColumn(t, "DV_eletric")),
		sample.analog(t, tagOfColumn(t, "Motor_current")))
}

// tagOfColumn returns the registry tag one MetroPT-3 column is published
// under.
func tagOfColumn(t *testing.T, column string) string {
	t.Helper()

	i := slices.IndexFunc(regmap.Signals, func(s regmap.Signal) bool { return s.Column == column })
	require.GreaterOrEqualf(t, i, 0, "no signal of the generated map reads the column %q", column)
	return regmap.Signals[i].Tag
}

// gateDigital returns one digital value of a sample.
func gateDigital(t *testing.T, sample telemetrySample, tag string) bool {
	t.Helper()

	raw, ok := sample.Values[tag]
	require.Truef(t, ok, "sample %d carries no %q", sample.Seq, tag)
	value, ok := raw.(bool)
	require.Truef(t, ok, "%q of sample %d is %T, not a boolean", tag, sample.Seq, raw)
	return value
}

// gateWhenHolds is the state guard of an injection transform. The engine's own
// copy is unexported, and the gate has to filter the samples a transform could
// have touched before it measures them.
func gateWhenHolds(when injection.When, state machine.State) bool {
	switch when {
	case injection.WhenAny:
		return true
	case injection.WhenLoaded:
		return state == machine.StateLoaded
	case injection.WhenNotLoaded:
		return state != machine.StateLoaded
	case injection.WhenUnloaded:
		return state == machine.StateUnloaded
	case injection.WhenOff:
		return state == machine.StateOff
	default:
		return false
	}
}

// instance waits for the ground truth to report the start of one instance and
// returns the event, which carries the instant the engine applied the command
// at and the instant the envelope ends.
func (g *gateRunner) instance(t *testing.T, instanceID string) injectionEvent {
	t.Helper()

	var found injectionEvent
	waitFor(t, func() bool {
		for _, m := range g.stack.gt.on(g.stack.topics.GtInjection()) {
			var event injectionEvent
			if json.Unmarshal(m.payload, &event) != nil {
				continue
			}
			if event.Event == "start" && event.InstanceID == instanceID {
				found = event
				return true
			}
		}
		return false
	}, "the ground truth to report the start of "+instanceID)
	return found
}

// injectionScenario is one of scenarios 5–9: start one injection at the first
// row of the baseline segment, replay the segment, and require every
// transform of the definition to have moved its tag against the control run.
func (g *gateRunner) injectionScenario(t *testing.T, id int, injectionID string,
	control map[uint64]telemetrySample, segment gateWindow,
) gate.Scenario {
	t.Helper()

	definition := g.stack.definition(t, injectionID)
	duration := gateDuration(definition, segment)
	var started injectionEvent
	samples := g.replay(t, segment, func() {
		ack := g.stack.command("inject", fmt.Sprintf(
			`{"injection_id":%q,"params":{"duration_sim_min":%d}}`, injectionID, duration))
		require.Truef(t, ack.OK, "inject %s was refused: %s", injectionID, ack.raw)
		require.NotEmptyf(t, ack.InstanceID,
			"the acknowledgement of inject %s names no instance", injectionID)
		started = g.instance(t, ack.InstanceID)
	}, nil)

	startedMs, err := mqttio.ParseTS(started.SimTS)
	require.NoErrorf(t, err, "the start of %s carries %q", injectionID, started.SimTS)
	endsMs, err := mqttio.ParseTS(started.EndsSimTS)
	require.NoErrorf(t, err, "the start of %s ends at %q", injectionID, started.EndsSimTS)

	hold := gateWindow{
		from:  startedMs + uint64(definition.Envelope.RampInMin)*gateMsPerMin,
		until: min(endsMs-uint64(definition.Envelope.RampOutMin)*gateMsPerMin, segment.until),
	}
	require.Greaterf(t, hold.until, hold.from,
		"%s holds at full magnitude for no time inside the segment", injectionID)

	pairs := gatePairs(t, samples, control, hold)
	t.Logf("scenario %d: %s over %s for %d simulated minutes, %d of %d published samples at hold",
		id, injectionID, hold, duration, len(pairs), len(samples))

	scenario := gate.Scenario{
		ID: id, Name: definition.Label, Kind: gate.KindInjection, Subject: injectionID,
		Window:  gate.Window{From: mqttio.SimTS(hold.from), Until: mqttio.SimTS(hold.until)},
		Samples: len(samples), Passed: true,
	}
	for _, transform := range definition.Transforms {
		for _, evidence := range transformEvidence(t, definition, transform, pairs) {
			if !evidence.OK {
				scenario.Passed = false
				if scenario.Note == "" {
					scenario.Note = evidence.Detail
				}
			}
			scenario.Evidence = append(scenario.Evidence, evidence)
		}
	}
	return scenario
}

// gateDuration is how long an instance is asked to run for: long enough that
// its hold reaches the end of the replayed segment.
//
// The catalog's own durations are written for a whole simulated day, and a
// transform guarded on `loaded` would otherwise be judged on the handful of
// compressing runs that fall inside the default window. The envelope keeps the
// shape the author wrote — the ramps are unchanged and the magnitude at hold
// is still one — so a longer instance measures the same move on more of the
// recording.
func gateDuration(definition *injection.Definition, segment gateWindow) int {
	minutes := int((segment.until-segment.from)/gateMsPerMin) + 1
	return min(definition.Envelope.RampInMin+minutes+definition.Envelope.RampOutMin,
		injection.MaxDurationSimMin)
}

// transformEvidence measures one transform of a definition against the
// control run and reports whether the tag moved as the catalog declares. A
// noise transform answers with two measurements, everything else with one.
func transformEvidence(t *testing.T, definition *injection.Definition,
	transform injection.Transform, pairs []gatePair,
) []gate.Evidence {
	t.Helper()

	guarded := make([]gatePair, 0, len(pairs))
	for _, pair := range pairs {
		if gateWhenHolds(transform.When, pair.state) {
			guarded = append(guarded, pair)
		}
	}
	evidence := gate.Evidence{
		Kind: gate.EvidenceTag, Tag: transform.Tag, Op: string(transform.Op), Samples: len(guarded),
	}
	if len(guarded) < gateMinGuarded {
		evidence.Detail = fmt.Sprintf("only %d of %d samples at hold were %q, too few to judge %s",
			len(guarded), len(pairs), transform.When, transform.Tag)
		return []gate.Evidence{evidence}
	}

	switch transform.Op {
	case injection.OpOffset:
		return []gate.Evidence{moveEvidence(t, transform.Tag, transform.Value.Float(), guarded,
			evidence, "the catalog offsets it by")}
	case injection.OpRamp:
		target := transform.Cap
		if transform.RatePerMin < 0 {
			target = -target
		}
		return []gate.Evidence{moveEvidence(t, transform.Tag, target, guarded, evidence,
			"the catalog drifts it to a cap of")}
	case injection.OpScale:
		return []gate.Evidence{scaleEvidence(t, transform, guarded, evidence)}
	case injection.OpNoise:
		return scatterEvidence(t, definition, transform, guarded, evidence)
	default:
		evidence.Detail = fmt.Sprintf(
			"the gate has no rule for the %s primitive, so %s is not judged here",
			transform.Op, transform.Tag)
		return []gate.Evidence{evidence}
	}
}

// moveEvidence judges an absolute move: the extreme difference from the
// control run has to reach half of target, in target's own direction.
func moveEvidence(t *testing.T, tag string, target float64, guarded []gatePair,
	evidence gate.Evidence, what string,
) gate.Evidence {
	t.Helper()

	deltas := make([]float64, 0, len(guarded))
	for _, pair := range guarded {
		deltas = append(deltas, pair.injected.analog(t, tag)-pair.control.analog(t, tag))
	}

	up := target > 0
	evidence.Direction = gateDirection(up)
	evidence.Observed = gateExtreme(deltas, up)
	evidence.Required = gateHalf * target
	evidence.OK = gateClears(evidence.Observed, evidence.Required, up)
	evidence.Detail = fmt.Sprintf("%s moved %+.4g against the control run at hold; %s %+.4g",
		tag, evidence.Observed, what, target)
	return evidence
}

// scaleEvidence judges a relative move: the extreme ratio to the control run
// has to reach half of the configured factor, in the factor's own direction.
func scaleEvidence(t *testing.T, transform injection.Transform, guarded []gatePair,
	evidence gate.Evidence,
) gate.Evidence {
	t.Helper()

	ratios := make([]float64, 0, len(guarded))
	for _, pair := range guarded {
		reference := pair.control.analog(t, transform.Tag)
		if math.Abs(reference) < gateScaleFloor {
			continue
		}
		ratios = append(ratios, pair.injected.analog(t, transform.Tag)/reference-1)
	}
	evidence.Samples = len(ratios)
	if len(ratios) < gateMinGuarded {
		evidence.Detail = fmt.Sprintf(
			"only %d samples at hold carried a %s big enough to take a ratio of",
			len(ratios), transform.Tag)
		return evidence
	}

	up := transform.Factor > 1
	evidence.Direction = gateDirection(up)
	evidence.Observed = gateExtreme(ratios, up)
	evidence.Required = gateHalf * (transform.Factor - 1)
	evidence.OK = gateClears(evidence.Observed, evidence.Required, up)
	evidence.Detail = fmt.Sprintf(
		"%s changed by %+.2f %% against the control run at hold; the catalog scales it by %.4g",
		transform.Tag, 100*evidence.Observed, transform.Factor)
	return evidence
}

// scatterEvidence judges a noise transform, which has no direction to move
// in, with two measurements over the same samples.
//
// The deterministic transforms of the same definition on the same tag are
// predicted from the control run, and what is left of the delta is the
// scatter the injection added. The deviation of the whole delta has to be
// half again as wide as the deterministic part's on its own — "standard
// deviation up by ≥ 50 %" — and the scatter itself has to reach half the
// sigma the catalog configures, which is the rule every other transform is
// held to.
func scatterEvidence(t *testing.T, definition *injection.Definition,
	transform injection.Transform, guarded []gatePair, evidence gate.Evidence,
) []gate.Evidence {
	t.Helper()

	deltas := make([]float64, 0, len(guarded))
	residuals := make([]float64, 0, len(guarded))
	predicted := make([]float64, 0, len(guarded))
	for _, pair := range guarded {
		reference := pair.control.analog(t, transform.Tag)
		delta := pair.injected.analog(t, transform.Tag) - reference
		deterministic := gateDeterministic(t, definition, transform.Tag, pair.state, reference)
		deltas = append(deltas, delta)
		predicted = append(predicted, deterministic)
		residuals = append(residuals, delta-deterministic)
	}
	deterministic := gateStdev(predicted)

	wider := evidence
	wider.Kind = gate.EvidenceScatter
	wider.Direction = gateDirection(true)
	wider.Observed = gateStdev(deltas)
	wider.Required = gateScatterFactor * deterministic
	wider.OK = wider.Observed >= wider.Required
	wider.Detail = fmt.Sprintf(
		"the deviation of the %s delta at hold is %.4g against %.4g for the definition's "+
			"deterministic transforms alone",
		transform.Tag, wider.Observed, deterministic)

	own := evidence
	own.Kind = gate.EvidenceScatter
	own.Direction = gateDirection(true)
	own.Observed = gateStdev(residuals)
	own.Required = gateHalf * transform.Sigma
	own.OK = own.Observed >= own.Required
	own.Detail = fmt.Sprintf(
		"the scatter left on %s once the deterministic part is taken off is %.4g; "+
			"the catalog adds a sigma of %.4g",
		transform.Tag, own.Observed, transform.Sigma)

	return []gate.Evidence{wider, own}
}

// gateDeterministic returns what the definition's offset and scale transforms
// on one tag add to a control value at full magnitude, which is the part of a
// delta that is not scatter. A ramp on the same tag would make the prediction
// incomplete — its anchor is not observable from the wire — so the gate says
// so instead of guessing.
func gateDeterministic(t *testing.T, definition *injection.Definition, tag string,
	state machine.State, reference float64,
) float64 {
	t.Helper()

	value := reference
	for _, transform := range definition.Transforms {
		if transform.Tag != tag || !gateWhenHolds(transform.When, state) {
			continue
		}
		switch transform.Op {
		case injection.OpOffset:
			value += transform.Value.Float()
		case injection.OpScale:
			value *= transform.Factor
		case injection.OpNoise:
			// The scatter being measured; it is not part of the prediction.
		default:
			t.Fatalf("%s moves %s with a %s beside its noise, which the gate cannot predict",
				definition.InjectionID, tag, transform.Op)
		}
	}
	return value - reference
}

// gateDirection names the way a move goes.
func gateDirection(up bool) string {
	if up {
		return "up"
	}
	return "down"
}

// gateExtreme returns the largest move in one direction.
func gateExtreme(values []float64, up bool) float64 {
	extreme := values[0]
	for _, value := range values[1:] {
		if up == (value > extreme) {
			extreme = value
		}
	}
	return extreme
}

// gateClears reports whether an observed move reached its bound.
func gateClears(observed, required float64, up bool) bool {
	if up {
		return observed >= required
	}
	return observed <= required
}

// gateStdev is the sample standard deviation of values.
func gateStdev(values []float64) float64 {
	if len(values) < 2 {
		return 0
	}
	var total float64
	for _, value := range values {
		total += value
	}
	mean := total / float64(len(values))

	var squares float64
	for _, value := range values {
		squares += (value - mean) * (value - mean)
	}
	return math.Sqrt(squares / float64(len(values)-1))
}

// TestGateSignalScenarios is the gate itself: one machine, ten scenarios, one
// summary. It runs as `go test -tags integration ./internal/e2e/ -run Gate`.
func TestGateSignalScenarios(t *testing.T) {
	directory := gateGroundTruthDir(t)
	presets := loadGatePresets(t, directory)
	require.Equalf(t, gate.Total, len(presets)+len(gateInjections)+1,
		"the gate is %d failure presets, %d injections and the negative",
		len(presets), len(gateInjections))

	url, committed := startBroker(t)
	s := newStack(t, url, committed, stackOpts{slice: gateSlice, speed: sim.MaxSpeed})
	g := &gateRunner{stack: s, tap: &tap{stack: s}, segments: s.fixture.segments()}
	require.Lenf(t, g.segments, len(presets)+1,
		"%s carries the baseline segment and one per failure preset: %v", gateSlice, g.segments)

	baseline := g.segments[0]
	started := time.Now()

	// The un-injected pass comes first: it is the control half of scenarios
	// 5–9 and the whole of the negative scenario.
	control := g.replay(t, baseline, nil, nil)
	byInstant := make(map[uint64]telemetrySample, len(control))
	for _, sample := range control {
		byInstant[sample.SimTsMs] = sample
	}
	t.Logf("control run: %d samples over %s", len(control), baseline)
	negative := negativeScenario(t, gate.Total, control, baseline)

	scenarios := make([]gate.Scenario, 0, gate.Total)
	for i, preset := range presets {
		scenarios = append(scenarios, g.presetScenario(t, i+1, preset))
	}
	for i, injectionID := range gateInjections {
		scenarios = append(scenarios,
			g.injectionScenario(t, len(presets)+1+i, injectionID, byInstant, baseline))
	}
	scenarios = append(scenarios, negative)

	report := gate.NewReport(gateSlice, s.opts.speed, mqttio.WallTS(time.Now()))
	for _, scenario := range scenarios {
		report.Add(scenario)
		t.Log(scenario.Line())
	}
	report.Summarise()
	t.Logf("%s, run in %s", report.Verdict(), time.Since(started).Round(time.Second))
	if path := gateReportPath(t); path != "" {
		require.NoError(t, report.Write(path))
		t.Logf("the gate summary is at %s", path)
	}

	assert.Zero(t, s.server.Refusals(),
		"the gateway only ever read: no write function code reached the simulator")
	require.Lenf(t, report.Scenarios, gate.Total, "the gate scores ten scenarios")
	require.Truef(t, report.NegativePassed,
		"the un-injected baseline did not stay quiet: %s", negative.Note)
	require.GreaterOrEqualf(t, report.Passed, gate.Threshold,
		"%s; the scenarios that missed are %v", report.Verdict(), report.Missed)
	require.True(t, report.Pass, report.Verdict())
}
