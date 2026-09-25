// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package sim_test

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/ctrl7"
	"fault-diagnosis-poc/services/modbus/internal/injection"
	"fault-diagnosis-poc/services/modbus/internal/regmap"
	"fault-diagnosis-poc/services/modbus/internal/replay"
	"fault-diagnosis-poc/services/modbus/internal/sim"
	"fault-diagnosis-poc/services/modbus/internal/testutil"
)

// Every unit test in this file runs offline on a synthetic waveform: no
// MetroPT-3 row is committed, so the pacing, the gaps and the alarms are
// exercised on a file internal/testutil generates. The real slice is read by
// engine_integration_test.go, which skips without it.
const (
	// stepMs is the synthetic sampling interval, the dataset's own 10 s.
	stepMs = 10_000
	// synthSeed fixes the generated noise.
	synthSeed = 0x5106
	// barrier is how long a helper waits for the emit loop to reach a state
	// it must reach in microseconds. It is generous on purpose: it only
	// bounds a failure, never a success.
	barrier = 5 * time.Second
	// barrierTick is how often those helpers look.
	barrierTick = 200 * time.Microsecond
)

// sample is one emitted slot as the harness recorded it, decoded straight out
// of the register store the way the gateway would read it.
type sample struct {
	Seq  uint32
	Slot regmap.Slot
}

// harness runs one engine over one synthetic file with a fake clock.
type harness struct {
	t      *testing.T
	clock  *testutil.FakeClock
	store  *sim.Store
	engine *sim.Engine
	source *replay.Source

	cancel  context.CancelFunc
	done    chan error
	stopped bool

	mu       sync.Mutex
	samples  []sample
	markers  []sim.Marker
	injected []sim.InjectionEvent
}

// engineOpts configures a harness.
type engineOpts struct {
	// Rows is the number of synthetic rows; ignored when CSV is set.
	Rows int
	// Gaps are the holes to punch into the synthetic timeline.
	Gaps []testutil.SynthGap
	// CSV overrides the generated file.
	CSV string
	// Catalog is the injection catalog; nil offers no injection.
	Catalog *injection.Catalog
	// Presets are the jump targets.
	Presets []sim.Preset
	// Speed, Autoplay and Loop are the engine configuration.
	Speed    uint16
	Autoplay bool
	Loop     bool
}

// synthCSV writes a synthetic MetroPT-3 file into the test's own directory.
func synthCSV(t *testing.T, rows int, gaps []testutil.SynthGap) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), "synthetic.csv")
	file, err := os.Create(path)
	require.NoError(t, err)
	defer func() { assert.NoError(t, file.Close()) }()

	require.NoError(t, testutil.SynthCSV(file, testutil.SynthOpts{
		Seed: synthSeed, Rows: rows, Gaps: gaps,
	}))
	return path
}

// emptyCatalog is the catalog an engine gets when a test does not need one:
// the injection engine always needs a catalog, and this one offers a
// definition no test starts.
func emptyCatalog(t *testing.T) *injection.Catalog {
	t.Helper()

	cat := &injection.Catalog{
		Schema: injection.CatalogSchema,
		Injections: []injection.Definition{{
			InjectionID:           "unused_definition",
			FaultID:               "oil_cooler_fouled",
			Label:                 "Unused",
			Description:           "Never started; the catalog may not be empty.",
			DefaultDurationSimMin: 60,
			Params:                []injection.ParamDef{{Name: injection.MagnitudeParam, Default: 1, Min: 0, Max: 2}},
			Transforms: []injection.Transform{{
				Tag: "oil_temperature", Op: injection.OpOffset,
				When: injection.WhenAny, Value: injection.Number(1),
			}},
		}},
	}
	require.NoError(t, cat.Validate(regmap.Signals))
	return cat
}

// newHarness builds and starts an engine. It stops with the test.
func newHarness(t *testing.T, opts engineOpts) *harness {
	t.Helper()

	if opts.Speed == 0 {
		opts.Speed = 1
	}
	if opts.Rows == 0 {
		opts.Rows = 120
	}
	if opts.CSV == "" {
		opts.CSV = synthCSV(t, opts.Rows, opts.Gaps)
	}
	if opts.Catalog == nil {
		opts.Catalog = emptyCatalog(t)
	}

	source, err := replay.Open(opts.CSV, regmap.Signals)
	require.NoError(t, err)

	alarms, err := ctrl7.New(regmap.Alarms, regmap.Signals)
	require.NoError(t, err)

	h := &harness{
		t:      t,
		clock:  testutil.NewFakeClock(time.Date(2026, 9, 20, 9, 0, 0, 0, time.UTC)),
		store:  sim.NewStore(),
		source: source,
	}

	cfg := sim.Config{
		Speed:    opts.Speed,
		Autoplay: opts.Autoplay,
		Loop:     opts.Loop,
		Presets:  opts.Presets,
	}
	engine, err := sim.New(cfg, source,
		injection.NewEngine(regmap.Signals, opts.Catalog, injection.WithBootID("aaaaaa")),
		alarms, h.clock, h.store)
	require.NoError(t, err)
	h.engine = engine

	engine.OnEmit = h.recordEmit
	engine.OnMarker = h.recordMarker
	engine.OnInjection = h.recordInjection

	ctx, cancel := context.WithCancel(t.Context())
	h.cancel, h.done = cancel, make(chan error, 1)
	go func() { h.done <- engine.Run(ctx) }()
	t.Cleanup(func() {
		h.stop()
		assert.NoError(t, engine.Close())
	})
	return h
}

// stop cancels the emit loop and waits for it to return. It is idempotent, so
// a test that stops the engine on purpose does not fight the cleanup.
func (h *harness) stop() {
	h.t.Helper()

	if h.stopped {
		return
	}
	h.stopped = true

	h.cancel()
	select {
	case err := <-h.done:
		assert.NoError(h.t, err)
	case <-time.After(barrier):
		h.t.Error("the emit loop did not return after its context was cancelled")
	}
}

// recordEmit decodes the sample the engine just published, exactly as a
// gateway reading the ring would.
func (h *harness) recordEmit(seq uint32, _ uint64) {
	regs, err := h.store.Read(regmap.SlotAddr(seq), regmap.SlotRegs)
	if err != nil {
		h.t.Errorf("reading the slot of sample %d: %v", seq, err)
		return
	}
	slot, err := regmap.DecodeSlot(regs)
	if err != nil {
		h.t.Errorf("decoding the slot of sample %d: %v", seq, err)
		return
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	h.samples = append(h.samples, sample{Seq: seq, Slot: slot})
}

// recordMarker notes one jump, reset or loop wrap.
func (h *harness) recordMarker(kind string, fromMs, toMs uint64, presetID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.markers = append(h.markers, sim.Marker{
		Kind: kind, FromMs: fromMs, ToMs: toMs, PresetID: presetID,
	})
}

// recordInjection notes one injection start or stop.
func (h *harness) recordInjection(ev sim.InjectionEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.injected = append(h.injected, ev)
}

// emitted returns the samples recorded so far.
func (h *harness) emitted() []sample {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]sample(nil), h.samples...)
}

// count returns how many samples have been emitted.
func (h *harness) count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.samples)
}

// markerList returns the markers recorded so far.
func (h *harness) markerList() []sim.Marker {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]sim.Marker(nil), h.markers...)
}

// injectionEvents returns the injection events recorded so far.
func (h *harness) injectionEvents() []sim.InjectionEvent {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]sim.InjectionEvent(nil), h.injected...)
}

// waitEmitted blocks until n samples have been emitted.
func (h *harness) waitEmitted(n int) {
	h.t.Helper()

	require.Eventuallyf(h.t, func() bool { return h.count() >= n }, barrier, barrierTick,
		"the engine emitted %d samples, expected %d", h.count(), n)
}

// waitArmed blocks until the emit loop is parked on a pacing timer.
//
// The fake clock only wakes a goroutine that is waiting on one of its timers,
// so once the loop has registered the timer for the next row it cannot make
// progress on its own. That is the barrier every pacing assertion needs: after
// it, an Advance that fires no timer provably changes nothing, and one that
// does fires exactly the work the test is measuring.
func (h *harness) waitArmed(timers int) {
	h.t.Helper()

	require.Eventuallyf(h.t, func() bool { return h.clock.Pending() >= timers }, barrier, barrierTick,
		"the emit loop registered %d pacing timers, expected %d", h.clock.Pending(), timers)
}

// play starts the replay and waits for the boot sample and its timer.
func (h *harness) play() {
	h.t.Helper()

	require.NoError(h.t, h.engine.Apply(sim.Play()).Err)
	h.waitEmitted(1)
	h.waitArmed(1)
}

// advanceStep moves the fake clock by one sampling interval and waits for the
// loop to emit up to want samples and park on its next pacing timer.
func (h *harness) advanceStep(want int) {
	h.t.Helper()

	h.clock.Advance(stepMs * time.Millisecond)
	h.waitEmitted(want)
	h.waitArmed(1)
	require.Equal(h.t, want, h.count(), "one sampling interval emitted more than it owed")
}

// firstTs returns the timestamp of the first row of the source.
func (h *harness) firstTs() uint64 {
	first, _, _ := h.source.Bounds()
	return first
}

// seqOf returns the emitted sample with this sequence number.
func seqOf(t *testing.T, samples []sample, seq uint32) sample {
	t.Helper()

	for _, s := range samples {
		if s.Seq == seq {
			return s
		}
	}
	t.Fatalf("no sample %d among the %d emitted", seq, len(samples))
	return sample{}
}

// discontinuous returns the sequence numbers that carry the discontinuity flag.
func discontinuous(samples []sample) []uint32 {
	var seqs []uint32
	for _, s := range samples {
		if s.Slot.Discontinuity {
			seqs = append(seqs, s.Seq)
		}
	}
	return seqs
}

func TestBootIsPausedAtTheFirstRow(t *testing.T) {
	t.Parallel()

	h := newHarness(t, engineOpts{})

	snap := h.engine.Snapshot()
	assert.Equal(t, sim.StatePaused, snap.State)
	assert.Equal(t, uint16(1), snap.Speed)
	assert.Equal(t, h.firstTs(), snap.SimTsMs, "the clock sits on the first row")
	assert.Equal(t, uint32(0), snap.HeadSeq, "nothing has been emitted")
	assert.Equal(t, 120, snap.Rows)
	assert.Empty(t, snap.Injections)

	// A paused engine emits nothing however far the wall clock moves.
	h.clock.Advance(time.Hour)
	assert.Equal(t, 0, h.count())
}

func TestAutoplayEmitsTheFirstRowWithDiscontinuity(t *testing.T) {
	t.Parallel()

	h := newHarness(t, engineOpts{Autoplay: true})
	h.waitEmitted(1)
	h.waitArmed(1)

	first := h.emitted()[0]
	assert.Equal(t, uint32(1), first.Seq)
	assert.Equal(t, h.firstTs(), first.Slot.SimTsMs)
	assert.True(t, first.Slot.Discontinuity, "the first sample after boot is a discontinuity")
	assert.False(t, first.Slot.Missing)
	assert.Equal(t, sim.StatePlaying, h.engine.Snapshot().State)
}

// TestSpeedOneEmitsOneRowPerSamplingInterval is the 1× case: one wall second
// is one simulated second, so ten of them are one row.
func TestSpeedOneEmitsOneRowPerSamplingInterval(t *testing.T) {
	t.Parallel()

	h := newHarness(t, engineOpts{Speed: 1})
	h.play()
	require.Equal(t, 1, h.count())

	for row := 2; row <= 5; row++ {
		h.clock.Advance(stepMs * time.Millisecond)
		h.waitEmitted(row)
		h.waitArmed(1)
		assert.Equal(t, row, h.count(), "one advance of the sampling interval is one row")
	}

	samples := h.emitted()
	for i, s := range samples {
		assert.Equal(t, uint32(i+1), s.Seq, "the sequence is contiguous from one")
		assert.Equal(t, h.firstTs()+uint64(i*stepMs), s.Slot.SimTsMs)
	}
	assert.Equal(t, []uint32{1}, discontinuous(samples), "only the boot sample")
}

// TestSpeedSixHundredCatchesUpWithoutSleeping is the 600× case: one wall
// second is ten simulated minutes, which is sixty rows emitted back to back.
func TestSpeedSixHundredCatchesUpWithoutSleeping(t *testing.T) {
	t.Parallel()

	h := newHarness(t, engineOpts{Speed: 600, Rows: 200})
	h.play()

	h.clock.Advance(time.Second)
	h.waitEmitted(61)
	h.waitArmed(1)
	assert.Equal(t, 61, h.count(), "the boot sample plus sixty rows")

	last := h.emitted()[60]
	assert.Equal(t, h.firstTs()+60*stepMs, last.Slot.SimTsMs)
}

// TestSpeedThirtySixHundredEmitsThirtySixRowsPerTenthSecond is the fastest
// replay: a simulated hour per wall second.
func TestSpeedThirtySixHundredEmitsThirtySixRowsPerTenthSecond(t *testing.T) {
	t.Parallel()

	h := newHarness(t, engineOpts{Speed: 3600, Rows: 200})
	h.play()

	h.clock.Advance(100 * time.Millisecond)
	h.waitEmitted(37)
	h.waitArmed(1)
	assert.Equal(t, 37, h.count(), "the boot sample plus thirty-six rows")
}

// TestPauseFreezesTheClockAndResumeFlagsNothing: play after pause carries no
// discontinuity, because the clock kept its position.
func TestPauseFreezesTheClockAndResumeFlagsNothing(t *testing.T) {
	t.Parallel()

	h := newHarness(t, engineOpts{Speed: 1})
	h.play()
	h.clock.Advance(stepMs * time.Millisecond)
	h.waitEmitted(2)
	h.waitArmed(1)

	require.NoError(t, h.engine.Apply(sim.Pause()).Err)
	paused := h.engine.Snapshot()
	assert.Equal(t, sim.StatePaused, paused.State)

	// The pending timer fires into a channel the loop has already dropped.
	h.clock.Advance(time.Hour)
	assert.Equal(t, 2, h.count(), "a paused engine emits nothing")
	assert.Equal(t, paused.SimTsMs, h.engine.Snapshot().SimTsMs, "the clock is frozen")

	require.NoError(t, h.engine.Apply(sim.Play()).Err)
	h.waitArmed(1)
	assert.Equal(t, 2, h.count(), "resuming does not replay the row it was waiting for")

	h.clock.Advance(stepMs * time.Millisecond)
	h.waitEmitted(3)
	h.waitArmed(1)

	third := seqOf(t, h.emitted(), 3)
	assert.False(t, third.Slot.Discontinuity, "pause and play are not a discontinuity")
	assert.Equal(t, h.firstTs()+2*stepMs, third.Slot.SimTsMs)
	assert.Equal(t, []uint32{1}, discontinuous(h.emitted()))
}

// TestSetSpeedMidWaitRecomputesThePendingTimer is the requirement that a speed
// change takes effect immediately: the row that was ten wall seconds away is
// one wall second away at 10×, and it is emitted once, not twice.
func TestSetSpeedMidWaitRecomputesThePendingTimer(t *testing.T) {
	t.Parallel()

	h := newHarness(t, engineOpts{Speed: 1})
	h.play()

	// Four of the ten simulated seconds to the next row have passed.
	h.clock.Advance(4 * time.Second)
	h.waitArmed(1)
	require.Equal(t, 1, h.count())

	require.NoError(t, h.engine.Apply(sim.SetSpeed(10)).Err)
	// The stale timer is still registered with the fake clock; the loop has
	// armed a second one for the remaining six simulated seconds, which is
	// 600 ms of wall time at 10×.
	h.waitArmed(2)
	assert.Equal(t, uint16(10), h.engine.Snapshot().Speed)

	h.clock.Advance(599 * time.Millisecond)
	assert.Equal(t, 1, h.count(), "no timer has fired, so nothing was emitted early")

	h.clock.Advance(time.Millisecond)
	h.waitEmitted(2)
	h.waitArmed(1)
	assert.Equal(t, 2, h.count(), "the row is emitted once")
	assert.Equal(t, h.firstTs()+stepMs, seqOf(t, h.emitted(), 2).Slot.SimTsMs)
}

func TestSetSpeedRefusesValuesOutsideTheRange(t *testing.T) {
	t.Parallel()

	h := newHarness(t, engineOpts{Speed: 600})

	for _, speed := range []uint16{0, 3601} {
		res := h.engine.Apply(sim.SetSpeed(speed))
		require.Error(t, res.Err)
		assert.Equal(t, sim.CodeSpeedOutOfRange, sim.ErrorCodeOf(res.Err))
		assert.Equal(t, uint16(600), res.Snapshot.Speed, "a refused command changes nothing")
	}

	require.NoError(t, h.engine.Apply(sim.SetSpeed(3600)).Err)
	assert.Equal(t, uint16(3600), h.engine.Snapshot().Speed)
}

func TestUnknownCommandIsRefused(t *testing.T) {
	t.Parallel()

	h := newHarness(t, engineOpts{})

	res := h.engine.Apply(sim.Command{})
	require.Error(t, res.Err)
	assert.Equal(t, sim.CodeUnknownCmd, sim.ErrorCodeOf(res.Err))
}

// TestSourceGapsCollapseAndFlagDiscontinuity mirrors the two real holes of the
// first recorded day — 307 s at 12:48 and 12,929 s at 19:40 — on the synthetic
// timeline: both are crossed without waiting and the row after each carries
// the flag.
func TestSourceGapsCollapseAndFlagDiscontinuity(t *testing.T) {
	t.Parallel()

	h := newHarness(t, engineOpts{
		Speed: 1,
		Rows:  20,
		Gaps: []testutil.SynthGap{
			{AfterRow: 5, Seconds: 307},
			{AfterRow: 10, Seconds: 12_929},
		},
	})
	h.play()

	// The fourth advance emits row 5 and then finds row 6 sitting 307 s
	// later: the gap is crossed inside the same iteration, with no wall time
	// spent on it, which is why the count jumps from four to six.
	for _, want := range []int{2, 3, 4, 6} {
		h.advanceStep(want)
	}
	require.Equal(t, 6, h.count(), "the first gap was collapsed, not waited out")

	// The same again across the 12,929 s hole between rows 10 and 11.
	for _, want := range []int{7, 8, 9, 11} {
		h.advanceStep(want)
	}
	require.Equal(t, 11, h.count(), "the second gap was collapsed, not waited out")

	samples := h.emitted()
	assert.Equal(t, []uint32{1, 6, 11}, discontinuous(samples),
		"the boot sample and the first row after each collapsed gap")

	first := h.firstTs()
	assert.Equal(t, first+uint64(5*stepMs)+307_000, seqOf(t, samples, 6).Slot.SimTsMs)
	assert.Equal(t, first+uint64(10*stepMs)+307_000+12_929_000, seqOf(t, samples, 11).Slot.SimTsMs)
}

// TestShortStepsAreNotGaps keeps the 60 s threshold honest: a 60 s step is a
// wait, a 61 s step is a collapse.
func TestShortStepsAreNotGaps(t *testing.T) {
	t.Parallel()

	const rows = 12
	h := newHarness(t, engineOpts{
		Speed: 3600,
		Rows:  rows,
		Gaps:  []testutil.SynthGap{{AfterRow: 3, Seconds: 50}},
	})
	h.play()

	// One wall second at 3600× is an hour of simulated time, so the whole
	// file and its 50 s step fit inside it.
	h.clock.Advance(time.Second)
	require.Eventually(t, func() bool { return h.engine.Snapshot().State == sim.StateStopped },
		barrier, barrierTick, "the engine reaches the end of the twelve rows")

	assert.Equal(t, rows, h.count())
	assert.Equal(t, []uint32{1}, discontinuous(h.emitted()),
		"a step inside the 60 s threshold is replayed as a wait, not collapsed")
}

func TestJumpLandsOnTheFirstRowAtOrAfterTheTarget(t *testing.T) {
	t.Parallel()

	h := newHarness(t, engineOpts{Speed: 1, Rows: 60})
	h.play()

	// Between rows 30 and 31, so the jump has to round forward.
	target := h.firstTs() + 30*stepMs + 4_000
	res := h.engine.Apply(sim.JumpTo(target))
	require.NoError(t, res.Err)
	require.NotNil(t, res.Marker)
	assert.Equal(t, sim.MarkerJump, res.Marker.Kind)
	assert.Equal(t, h.firstTs(), res.Marker.FromMs)
	assert.Equal(t, h.firstTs()+31*stepMs, res.Marker.ToMs)
	assert.Empty(t, res.Marker.PresetID)
	assert.Equal(t, sim.StatePlaying, res.Snapshot.State, "a jump does not change the state")

	h.waitEmitted(2)
	h.waitArmed(1)

	landed := seqOf(t, h.emitted(), 2)
	assert.Equal(t, h.firstTs()+31*stepMs, landed.Slot.SimTsMs, "the first row at or after the target")
	assert.True(t, landed.Slot.Discontinuity)
	assert.Equal(t, []sim.Marker{*res.Marker}, h.markerList())
}

func TestJumpRefusesInstantsOutsideTheRecording(t *testing.T) {
	t.Parallel()

	h := newHarness(t, engineOpts{Rows: 60})
	first, last, _ := h.source.Bounds()

	for _, target := range []uint64{first - 1, last + 1} {
		res := h.engine.Apply(sim.JumpTo(target))
		require.Error(t, res.Err)
		assert.Equal(t, sim.CodeOutOfRange, sim.ErrorCodeOf(res.Err))
	}
	assert.Empty(t, h.markerList(), "a refused jump publishes no marker")
}

func TestJumpPresetAppliesTheLeadInAndClampsToTheStart(t *testing.T) {
	t.Parallel()

	// The presets point into the generated file, which starts at the same
	// instant as the dataset (testutil.SynthStart).
	first := uint64(testutil.SynthStart.UnixMilli())
	h := newHarness(t, engineOpts{
		Speed: 1,
		Rows:  200,
		Presets: []sim.Preset{
			{PresetID: "mid", SimTsMs: first + 100*stepMs, LeadInMin: 5},
			{PresetID: "early", SimTsMs: first + 2*stepMs, LeadInMin: 240},
		},
	})
	require.Equal(t, first, h.firstTs())
	h.play()

	res := h.engine.Apply(sim.JumpPreset("mid"))
	require.NoError(t, res.Err)
	require.NotNil(t, res.Marker)
	assert.Equal(t, "mid", res.Marker.PresetID)
	// Five simulated minutes of lead-in is thirty rows of ten seconds.
	assert.Equal(t, first+70*stepMs, res.Marker.ToMs)

	res = h.engine.Apply(sim.JumpPreset("early"))
	require.NoError(t, res.Err)
	require.NotNil(t, res.Marker)
	assert.Equal(t, first, res.Marker.ToMs, "the lead-in clamps to the dataset start")

	res = h.engine.Apply(sim.JumpPreset("no_such_preset"))
	require.Error(t, res.Err)
	assert.Equal(t, sim.CodeUnknownPreset, sim.ErrorCodeOf(res.Err))
}

func TestResetReturnsToTheStartPausedAtTheConfiguredSpeed(t *testing.T) {
	t.Parallel()

	h := newHarness(t, engineOpts{Speed: 600, Rows: 200})
	h.play()

	h.clock.Advance(time.Second)
	h.waitEmitted(61)
	h.waitArmed(1)

	require.NoError(t, h.engine.Apply(sim.SetSpeed(3600)).Err)

	res := h.engine.Apply(sim.Reset())
	require.NoError(t, res.Err)
	require.NotNil(t, res.Marker)
	assert.Equal(t, sim.MarkerReset, res.Marker.Kind)
	assert.Equal(t, h.firstTs(), res.Marker.ToMs)

	snap := res.Snapshot
	assert.Equal(t, sim.StatePaused, snap.State)
	assert.Equal(t, uint16(600), snap.Speed, "reset restores REPLAY_SPEED")
	assert.Equal(t, h.firstTs(), snap.SimTsMs)
	assert.Equal(t, uint32(61), snap.HeadSeq, "head_seq is never reset by a command")

	before := h.count()
	require.NoError(t, h.engine.Apply(sim.Play()).Err)
	h.waitEmitted(before + 1)
	h.waitArmed(1)

	next := seqOf(t, h.emitted(), uint32(before)+1)
	assert.Equal(t, h.firstTs(), next.Slot.SimTsMs, "the replay starts over at the first row")
	assert.True(t, next.Slot.Discontinuity)
}

func TestLoopWrapsAtTheEndOfDataWithDiscontinuity(t *testing.T) {
	t.Parallel()

	const rows = 12
	h := newHarness(t, engineOpts{Speed: 3600, Rows: rows, Loop: true})
	h.play()

	// A tenth of a wall second at 3600× is an hour of simulated time, so the
	// twelve rows and the wrap are all inside it.
	h.clock.Advance(100 * time.Millisecond)
	h.waitEmitted(rows + 1)
	h.waitArmed(1)

	samples := h.emitted()
	require.GreaterOrEqual(t, len(samples), rows+1)
	assert.Equal(t, h.firstTs(), seqOf(t, samples, rows+1).Slot.SimTsMs, "the wrap is back at row one")
	assert.Equal(t, []uint32{1, uint32(rows) + 1}, discontinuous(samples[:rows+1]))

	markers := h.markerList()
	require.NotEmpty(t, markers)
	assert.Equal(t, sim.MarkerLoop, markers[0].Kind)
	assert.Equal(t, h.firstTs(), markers[0].ToMs)
}

func TestWithoutLoopTheReplayStopsAndPlayWraps(t *testing.T) {
	t.Parallel()

	const rows = 12
	h := newHarness(t, engineOpts{Speed: 3600, Rows: rows, Loop: false})
	h.play()

	h.clock.Advance(100 * time.Millisecond)
	require.Eventually(t, func() bool { return h.engine.Snapshot().State == sim.StateStopped },
		barrier, barrierTick, "the engine stops at the end of data")

	snap := h.engine.Snapshot()
	_, last, _ := h.source.Bounds()
	assert.Equal(t, rows, h.count(), "every row was emitted exactly once")
	assert.Equal(t, last, snap.SimTsMs, "the clock rests on the last row")
	assert.Equal(t, uint32(rows), snap.HeadSeq)
	assert.Empty(t, h.markerList())

	res := h.engine.Apply(sim.Play())
	require.NoError(t, res.Err)
	require.NotNil(t, res.Marker)
	assert.Equal(t, sim.MarkerLoop, res.Marker.Kind, "play from stopped wraps like a loop")

	h.waitEmitted(rows + 1)
	wrapped := seqOf(t, h.emitted(), rows+1)
	assert.Equal(t, h.firstTs(), wrapped.Slot.SimTsMs)
	assert.True(t, wrapped.Slot.Discontinuity)
}

func TestHeaderFollowsTheEngine(t *testing.T) {
	t.Parallel()

	h := newHarness(t, engineOpts{Speed: 600, Rows: 60})

	header := func() regmap.Header {
		regs, err := h.store.Read(regmap.HeaderBase, regmap.HeaderRegs)
		require.NoError(t, err)
		decoded, err := regmap.DecodeHeader(regs)
		require.NoError(t, err)
		return decoded
	}

	boot := header()
	assert.Equal(t, regmap.ReplayPaused, boot.State)
	assert.Equal(t, uint16(600), boot.Speed)
	assert.Equal(t, h.firstTs(), boot.SimTsMs)
	assert.Equal(t, uint32(0), boot.HeadSeq)

	h.play()
	playing := header()
	assert.Equal(t, regmap.ReplayPlaying, playing.State)
	assert.Equal(t, uint32(1), playing.HeadSeq)

	require.NoError(t, h.engine.Apply(sim.Pause()).Err)
	assert.Equal(t, regmap.ReplayPaused, header().State, "every command refreshes the header")
}

// offsetDefinition builds a one-transform injection definition that shifts an
// analog tag by a fixed amount for the whole of its duration: no ramp, so the
// magnitude is one from the instance's first sample and the effect on a slot
// is exactly `value`.
func offsetDefinition(injectionID, tag string, value float64, durationMin int) injection.Definition {
	return injection.Definition{
		InjectionID:           injectionID,
		FaultID:               "oil_cooler_fouled",
		Label:                 "Test overlay",
		Description:           "A flat offset used by the engine tests.",
		DefaultDurationSimMin: durationMin,
		Params: []injection.ParamDef{
			{Name: injection.MagnitudeParam, Default: 1, Min: 0, Max: 2},
		},
		Transforms: []injection.Transform{{
			Tag: tag, Op: injection.OpOffset, When: injection.WhenAny, Value: injection.Number(value),
		}},
	}
}

// testCatalog validates a catalog of definitions against the register map.
func testCatalog(t *testing.T, defs ...injection.Definition) *injection.Catalog {
	t.Helper()

	cat := &injection.Catalog{Schema: injection.CatalogSchema, Injections: defs}
	require.NoError(t, cat.Validate(regmap.Signals))
	return cat
}

// oilTemperature returns the oil temperature of one emitted sample.
func oilTemperature(t *testing.T, s sample) float64 {
	t.Helper()

	v, ok := s.Slot.Analog["oil_temperature"]
	require.True(t, ok, "the slot carries the oil temperature")
	return v
}

// TestInjectionChangesTheEmittedValues compares the same synthetic rows with
// and without an overlay: the engine is deterministic, so the only difference
// between the two runs is the offset the injection adds.
func TestInjectionChangesTheEmittedValues(t *testing.T) {
	t.Parallel()

	const (
		offsetC = 14.0
		rows    = 12
	)
	csv := synthCSV(t, 60, nil)

	baseline := newHarness(t, engineOpts{Speed: 3600, CSV: csv})
	baseline.play()
	baseline.clock.Advance(40 * time.Millisecond)
	baseline.waitEmitted(rows)

	overlaid := newHarness(t, engineOpts{
		Speed:   3600,
		CSV:     csv,
		Catalog: testCatalog(t, offsetDefinition("hot_oil", "oil_temperature", offsetC, 60)),
	})
	res := overlaid.engine.Apply(sim.Inject("hot_oil", nil))
	require.NoError(t, res.Err)
	require.NotNil(t, res.Started)
	assert.Equal(t, "inj-aaaaaa-1", res.InstanceID())
	require.Len(t, res.Snapshot.Injections, 1)
	assert.Equal(t, "hot_oil", res.Snapshot.Injections[0].InjectionID)

	overlaid.play()
	overlaid.clock.Advance(40 * time.Millisecond)
	overlaid.waitEmitted(rows)

	base, hot := baseline.emitted()[:rows], overlaid.emitted()[:rows]
	for i := range rows {
		require.Equal(t, base[i].Slot.SimTsMs, hot[i].Slot.SimTsMs, "the same source row")
		// The register holds hundredths of a degree, so the two encodings may
		// round to neighbouring integers.
		assert.InDelta(t, oilTemperature(t, base[i])+offsetC, oilTemperature(t, hot[i]), 0.011,
			"sample %d carries the overlay", base[i].Seq)
		assert.InDelta(t, base[i].Slot.Analog["line_pressure"], hot[i].Slot.Analog["line_pressure"],
			0.0001, "a tag the definition does not name is untouched")
	}

	events := overlaid.injectionEvents()
	require.Len(t, events, 1)
	assert.Equal(t, sim.EventStart, events[0].Event)
	assert.Equal(t, "inj-aaaaaa-1", events[0].Info.InstanceID)
}

func TestInjectRefusesUnknownDefinitionsAndBadParameters(t *testing.T) {
	t.Parallel()

	h := newHarness(t, engineOpts{
		Catalog: testCatalog(t, offsetDefinition("hot_oil", "oil_temperature", 14, 60)),
	})

	res := h.engine.Apply(sim.Inject("no_such_injection", nil))
	require.Error(t, res.Err)
	assert.Equal(t, sim.CodeUnknownInjection, sim.ErrorCodeOf(res.Err))

	res = h.engine.Apply(sim.Inject("hot_oil", map[string]float64{"magnitude": 9}))
	require.Error(t, res.Err)
	assert.Equal(t, sim.CodeBadArgs, sim.ErrorCodeOf(res.Err))

	res = h.engine.Apply(sim.Inject("hot_oil", map[string]float64{"tilt": 1}))
	require.Error(t, res.Err)
	assert.Equal(t, sim.CodeBadArgs, sim.ErrorCodeOf(res.Err))

	assert.Empty(t, h.engine.Snapshot().Injections, "no instance was created")
	assert.Empty(t, h.injectionEvents())
}

// TestInjectionsExpireOnTheirOwnDuration covers the `expired` stop reason: the
// instance ends on the simulated clock, not on the wall clock.
func TestInjectionsExpireOnTheirOwnDuration(t *testing.T) {
	t.Parallel()

	h := newHarness(t, engineOpts{
		Speed:   3600,
		Rows:    60,
		Catalog: testCatalog(t, offsetDefinition("hot_oil", "oil_temperature", 14, 1)),
	})
	require.NoError(t, h.engine.Apply(sim.Inject("hot_oil", nil)).Err)
	h.play()

	h.clock.Advance(100 * time.Millisecond)
	h.waitEmitted(10)

	require.Eventually(t, func() bool { return len(h.engine.Snapshot().Injections) == 0 },
		barrier, barrierTick, "the instance ends one simulated minute after it started")

	events := h.injectionEvents()
	require.Len(t, events, 2)
	assert.Equal(t, sim.EventStart, events[0].Event)
	assert.Equal(t, sim.EventStop, events[1].Event)
	assert.Equal(t, injection.ReasonExpired, events[1].Reason)
	assert.Equal(t, h.firstTs()+60_000, events[1].SimTsMs, "it stops at the first row past its end")
}

func TestJumpAndResetStopTheActiveInjections(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		cmd    sim.Command
		reason injection.Reason
	}{
		{"jump", sim.JumpTo(uint64(testutil.SynthStart.UnixMilli()) + 30*stepMs), injection.ReasonJump},
		{"reset", sim.Reset(), injection.ReasonReset},
		{"clear_injections", sim.ClearInjections(), injection.ReasonCleared},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			h := newHarness(t, engineOpts{
				Speed:   1,
				Rows:    60,
				Catalog: testCatalog(t, offsetDefinition("hot_oil", "oil_temperature", 14, 60)),
			})
			require.NoError(t, h.engine.Apply(sim.Inject("hot_oil", nil)).Err)
			h.play()
			// Two rows in, so the instant the command is applied at is not
			// the one a reset or a jump moves the clock to.
			h.advanceStep(2)
			h.advanceStep(3)
			appliedAt := h.firstTs() + 2*stepMs
			require.Equal(t, appliedAt, h.engine.Snapshot().SimTsMs)

			res := h.engine.Apply(tc.cmd)
			require.NoError(t, res.Err)
			require.Len(t, res.Stopped, 1, "the running instance is reported to the caller")
			assert.Equal(t, tc.reason, res.Stopped[0].Reason)
			assert.Equal(t, "inj-aaaaaa-1", res.Stopped[0].Info.InstanceID)
			assert.Empty(t, res.Snapshot.Injections)

			events := h.injectionEvents()
			require.Len(t, events, 2)
			assert.Equal(t, sim.EventStop, events[1].Event)
			assert.Equal(t, tc.reason, events[1].Reason)
			assert.Equal(t, appliedAt, events[1].SimTsMs,
				"the instance stopped where the machine was, not where the command sent it")
		})
	}
}

// thresholdAlarmAbove returns the generated alarm that watches tag for a value
// above its threshold. Tests look the alarm up in the table rather than naming
// a code, so a renumbering in the manual does not break them.
func thresholdAlarmAbove(t *testing.T, tag string) regmap.Alarm {
	t.Helper()

	for _, a := range regmap.Alarms {
		if a.Trigger.Kind == "threshold" && a.Trigger.Signal == tag && a.Trigger.Op == "gt" {
			return a
		}
	}
	t.Fatalf("the generated alarm table has no `%s greater than` threshold alarm", tag)
	return regmap.Alarm{}
}

// TestAlarmBitsFollowTheControllerTable drives the controller emulation from
// the engine: the synthetic waveform is a normal cycle and raises nothing, and
// an overlay that pushes the ambient temperature over its threshold raises the
// matching bit once its delay has run on the simulated clock.
func TestAlarmBitsFollowTheControllerTable(t *testing.T) {
	t.Parallel()

	alarm := thresholdAlarmAbove(t, "ambient_temperature")
	require.Positive(t, alarm.Trigger.DelayS, "the ambient alarm has a delay to wait out")
	// Far above the threshold, so the condition holds through the whole run
	// whatever the season and the diurnal swing add.
	ambientOffsetC := alarm.Trigger.Threshold + 20

	// One sample per ten seconds, so the delay is this many rows.
	delayRows := alarm.Trigger.DelayS / (stepMs / 1000)
	rows := delayRows + 10

	quiet := newHarness(t, engineOpts{Speed: 3600, Rows: rows})
	quiet.play()
	quiet.clock.Advance(time.Second)
	quiet.waitEmitted(rows)
	for _, s := range quiet.emitted() {
		assert.Equal(t, uint32(0), s.Slot.AlarmBits,
			"the synthetic cycle is normal operation: sample %d raises nothing", s.Seq)
	}

	hot := newHarness(t, engineOpts{
		Speed: 3600,
		Rows:  rows,
		Catalog: testCatalog(t,
			offsetDefinition("hot_ambient", "ambient_temperature", ambientOffsetC, 600)),
	})
	require.NoError(t, hot.engine.Apply(sim.Inject("hot_ambient", nil)).Err)
	hot.play()
	hot.clock.Advance(time.Second)
	hot.waitEmitted(rows)

	samples := hot.emitted()
	mask := uint32(1) << alarm.Bit
	assert.Equal(t, uint32(0), seqOf(t, samples, uint32(delayRows)).Slot.AlarmBits,
		"the delay has not run out one row early")
	assert.Equal(t, mask, seqOf(t, samples, uint32(delayRows)+1).Slot.AlarmBits&mask,
		"the bit is set at the first sample a full delay after the condition began")
	assert.Equal(t, mask, seqOf(t, samples, uint32(rows)).Slot.AlarmBits&mask,
		"and stays set while the condition holds")
	assert.Equal(t, []string{alarm.Code},
		regmap.AlarmCodes(seqOf(t, samples, uint32(rows)).Slot.AlarmBits),
		"the overlay raises that alarm and no other")
}

func TestSnapshotReportsTheDatasetAndTheLoopSetting(t *testing.T) {
	t.Parallel()

	h := newHarness(t, engineOpts{Speed: 600, Rows: 40, Loop: true})
	first, last, rows := h.source.Bounds()

	snap := h.engine.Snapshot()
	assert.Equal(t, first, snap.FirstTsMs)
	assert.Equal(t, last, snap.LastTsMs)
	assert.Equal(t, rows, snap.Rows)
	assert.True(t, snap.Loop)
}

func TestNewRejectsAMisconfiguredEngine(t *testing.T) {
	t.Parallel()

	source, err := replay.Open(synthCSV(t, 10, nil), regmap.Signals)
	require.NoError(t, err)
	alarms, err := ctrl7.New(regmap.Alarms, regmap.Signals)
	require.NoError(t, err)
	inj := injection.NewEngine(regmap.Signals, emptyCatalog(t))
	clock := testutil.NewFakeClock(time.Unix(0, 0))
	store := sim.NewStore()
	cfg := sim.Config{Speed: 600}

	_, err = sim.New(cfg, nil, inj, alarms, clock, store)
	assert.ErrorContains(t, err, "replay source")

	_, err = sim.New(cfg, source, nil, alarms, clock, store)
	assert.ErrorContains(t, err, "injection engine")

	_, err = sim.New(cfg, source, inj, nil, clock, store)
	assert.ErrorContains(t, err, "alarm evaluator")

	_, err = sim.New(cfg, source, inj, alarms, nil, store)
	assert.ErrorContains(t, err, "clock")

	_, err = sim.New(cfg, source, inj, alarms, clock, nil)
	assert.ErrorContains(t, err, "register store")

	_, err = sim.New(sim.Config{Speed: 0}, source, inj, alarms, clock, store)
	assert.ErrorContains(t, err, "replay speed 0")
}

// TestRunIsRefusedTwiceAndApplyStopsWithIt keeps the emit loop single: the
// cursor, the clock and the injection engine belong to the goroutine that
// called Run, and a command that arrives after it has returned is answered
// instead of blocking for ever.
func TestRunIsRefusedTwiceAndApplyStopsWithIt(t *testing.T) {
	t.Parallel()

	h := newHarness(t, engineOpts{Speed: 600})
	h.play()

	assert.ErrorContains(t, h.engine.Run(t.Context()), "already running")

	h.stop()

	res := h.engine.Apply(sim.Pause())
	require.Error(t, res.Err)
	assert.Equal(t, sim.CodeInternal, sim.ErrorCodeOf(res.Err))
	assert.Equal(t, uint32(1), res.Snapshot.HeadSeq, "the last known state is still readable")
}
