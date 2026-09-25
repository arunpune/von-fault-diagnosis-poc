// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package sim

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"fault-diagnosis-poc/services/modbus/internal/ctrl7"
	"fault-diagnosis-poc/services/modbus/internal/injection"
	"fault-diagnosis-poc/services/modbus/internal/machine"
	"fault-diagnosis-poc/services/modbus/internal/regmap"
	"fault-diagnosis-poc/services/modbus/internal/replay"
)

// State is the replay state (docs/simulation.md, "Play, pause, stop and
// loop").
type State uint8

// The three replay states.
const (
	// StateStopped is reached only at the end of data with SIM_LOOP=false.
	StateStopped State = iota
	// StatePlaying means the simulated clock advances.
	StatePlaying
	// StatePaused means the simulated clock is frozen.
	StatePaused
)

// String returns the lower-case name the status and health documents carry.
func (s State) String() string {
	switch s {
	case StateStopped:
		return "stopped"
	case StatePlaying:
		return "playing"
	case StatePaused:
		return "paused"
	default:
		return fmt.Sprintf("State(%d)", uint8(s))
	}
}

// register returns the value of the replay_state header register.
func (s State) register() uint16 {
	switch s {
	case StatePlaying:
		return regmap.ReplayPlaying
	case StatePaused:
		return regmap.ReplayPaused
	default:
		return regmap.ReplayStopped
	}
}

// Marker kinds of the gt/cau-7/marker topic.
const (
	// MarkerJump is a jump to another instant of the recording.
	MarkerJump = "jump"
	// MarkerReset is the reset command.
	MarkerReset = "reset"
	// MarkerLoop is a wrap from the end of the data back to the start.
	MarkerLoop = "loop"
)

// headerInterval is how often the emit loop refreshes sim_ts_now, the state
// and the speed in the header while playing (at least every 100 ms of wall
// time). head_seq is written with every sample regardless, by
// Store.WriteSample.
const headerInterval = 100 * time.Millisecond

// commandBuffer is the depth of the command channel. Commands arrive one at a
// time from the control plane and are answered before the next is read, so the
// buffer only keeps a caller from blocking while the loop finishes a row.
const commandBuffer = 8

// CommandKind names one control command.
type CommandKind uint8

// The eight commands.
const (
	// CmdUnknown is the zero value: an unset Command is rejected rather than
	// silently read as `play`.
	CmdUnknown CommandKind = iota
	CmdPlay
	CmdPause
	CmdSetSpeed
	CmdJumpTo
	CmdJumpPreset
	CmdInject
	CmdClearInjections
	CmdReset
)

// String returns the name the control protocol uses.
func (k CommandKind) String() string {
	switch k {
	case CmdPlay:
		return "play"
	case CmdPause:
		return "pause"
	case CmdSetSpeed:
		return "set_speed"
	case CmdJumpTo, CmdJumpPreset:
		return "jump"
	case CmdInject:
		return "inject"
	case CmdClearInjections:
		return "clear_injections"
	case CmdReset:
		return "reset"
	default:
		return "unknown"
	}
}

// Command is one control request. Only the fields its Kind names are read, so
// the control plane builds one with the constructors below rather than filling
// the struct by hand.
type Command struct {
	Kind        CommandKind
	Speed       uint16
	SimTsMs     uint64
	PresetID    string
	InjectionID string
	Params      map[string]float64
}

// Play resumes the replay, wrapping to the start when it had stopped.
func Play() Command { return Command{Kind: CmdPlay} }

// Pause freezes the simulated clock where it stands.
func Pause() Command { return Command{Kind: CmdPause} }

// SetSpeed changes the replay speed, which must be in MinSpeed..MaxSpeed.
func SetSpeed(speed uint16) Command { return Command{Kind: CmdSetSpeed, Speed: speed} }

// JumpTo moves the replay to the first row at or after simTsMs.
func JumpTo(simTsMs uint64) Command { return Command{Kind: CmdJumpTo, SimTsMs: simTsMs} }

// JumpPreset moves the replay to a preset's instant minus its lead-in.
func JumpPreset(presetID string) Command {
	return Command{Kind: CmdJumpPreset, PresetID: presetID}
}

// Inject starts one instance of an injection definition.
func Inject(injectionID string, params map[string]float64) Command {
	return Command{Kind: CmdInject, InjectionID: injectionID, Params: params}
}

// ClearInjections stops every running instance.
func ClearInjections() Command { return Command{Kind: CmdClearInjections} }

// Reset clears the injections and returns to the first row, paused.
func Reset() Command { return Command{Kind: CmdReset} }

// ErrorCode is one of the acknowledgement error codes.
type ErrorCode string

// The seven error codes.
const (
	CodeUnknownCmd       ErrorCode = "unknown_cmd"
	CodeBadArgs          ErrorCode = "bad_args"
	CodeUnknownPreset    ErrorCode = "unknown_preset"
	CodeUnknownInjection ErrorCode = "unknown_injection"
	CodeOutOfRange       ErrorCode = "out_of_range"
	CodeSpeedOutOfRange  ErrorCode = "speed_out_of_range"
	CodeInternal         ErrorCode = "internal"
)

// CommandError is a refused command. The control plane copies Code and
// Message straight into the acknowledgement's error object.
type CommandError struct {
	Code    ErrorCode
	Message string
}

// Error renders the code and the message.
func (e *CommandError) Error() string { return string(e.Code) + ": " + e.Message }

// commandErrorf builds a CommandError with a formatted message.
func commandErrorf(code ErrorCode, format string, args ...any) *CommandError {
	return &CommandError{Code: code, Message: fmt.Sprintf(format, args...)}
}

// ErrorCodeOf returns the acknowledgement code of err, or CodeInternal for an
// error that did not come from a refused command.
func ErrorCodeOf(err error) ErrorCode {
	var cmdErr *CommandError
	if errors.As(err, &cmdErr) {
		return cmdErr.Code
	}
	return CodeInternal
}

// Marker is a discontinuity the operator caused or the data forced, published
// on gt/cau-7/marker.
type Marker struct {
	Kind     string
	FromMs   uint64
	ToMs     uint64
	PresetID string
}

// InjectionEvent is the start or the stop of one injection instance.
type InjectionEvent struct {
	// Event is "start" or "stop".
	Event string
	// SimTsMs is the simulated instant the event happened at.
	SimTsMs uint64
	// Info describes the instance.
	Info injection.InstanceInfo
	// Reason is empty for a start and the stop reason otherwise.
	Reason injection.Reason
}

// The two injection event names.
const (
	EventStart = "start"
	EventStop  = "stop"
)

// Result is what a command produced, for the acknowledgement the control
// plane sends back.
//
// The marker and the injection events a command caused are also reported
// through OnMarker and OnInjection, which the loop calls before it answers, so
// the two paths carry the same events: a publisher that sends from the hooks
// reads Result only for the acknowledgement's own fields, and one that sends
// from Result does not subscribe to the hooks. Doing both publishes twice.
type Result struct {
	// Err is nil when the command was applied; otherwise it is a *CommandError
	// whose Code is one of the seven acknowledgement error codes.
	Err error
	// Snapshot is the engine state after the command.
	Snapshot Snapshot
	// Started is the instance an accepted inject created.
	Started *injection.InstanceInfo
	// Stopped are the instances the command ended, with their reasons.
	Stopped []injection.Stopped
	// Marker is the discontinuity the command caused, if any.
	Marker *Marker
}

// InstanceID returns the id of the instance an inject created, empty for every
// other command.
func (r Result) InstanceID() string {
	if r.Started == nil {
		return ""
	}
	return r.Started.InstanceID
}

// Snapshot is the engine state the control plane publishes. It carries nothing
// the status document may not (ground-truth isolation); the caller decides
// that the injection list goes to gt/# and nowhere else.
type Snapshot struct {
	State     State
	Speed     uint16
	SimTsMs   uint64
	HeadSeq   uint32
	FirstTsMs uint64
	LastTsMs  uint64
	Rows      int
	Loop      bool
	// Injections are the running instances, oldest start first. It belongs on
	// gt/cau-7/injection/active and on no other topic.
	Injections []injection.InstanceInfo
}

// Hook signatures. They are plain callbacks set before Run and are called from
// the emit loop's goroutine, in order, so an implementation that publishes
// must not block for long — a command's acknowledgement waits behind them.
//
// Between them they report every event the machine produces, whether a command
// or the recording itself caused it: a loop wrap and an expiring injection
// reach the hooks and no Result at all.
type (
	// EmitHook is called after a sample has been written to the store.
	EmitHook func(seq uint32, simTsMs uint64)
	// MarkerHook is called for every jump, reset and loop wrap.
	MarkerHook func(kind string, fromMs, toMs uint64, presetID string)
	// InjectionHook is called when an instance starts or stops.
	InjectionHook func(ev InjectionEvent)
)

// Engine is the machine's replay loop: it paces the source rows against the
// simulated clock, overlays the injections, evaluates the controller alarms
// and publishes each sample into the register store.
//
// One goroutine runs Run; every other goroutine talks to it through Apply and
// reads Snapshot. The hooks are set before Run and not written afterwards.
type Engine struct {
	// OnEmit, OnMarker and OnInjection are set before Run; cmd/modbus-sim
	// wires them to the ground-truth publisher.
	OnEmit      EmitHook
	OnMarker    MarkerHook
	OnInjection InjectionHook

	cfg    Config
	log    *slog.Logger
	src    *replay.Source
	cursor *replay.Cursor
	inj    *injection.Engine
	alarms *ctrl7.Evaluator
	clock  *simClock
	store  *Store

	cmds    chan request
	done    chan struct{}
	running atomic.Bool

	// The fields below belong to the emit loop's goroutine.
	state          State
	seq            uint32
	pendingDisc    bool
	havePrev       bool
	prevRowMs      uint64
	lastHeaderWall time.Time

	firstMs uint64
	lastMs  uint64
	rows    int

	compIdx, loadValveIdx, currentIdx int
	analogTags, digitalTags           []string
	values                            injection.Values
	slot                              regmap.Slot

	mu   sync.Mutex
	snap Snapshot
}

// request is one command with the channel its result goes back on.
type request struct {
	cmd   Command
	reply chan Result
}

// New builds the engine. It opens a cursor on src, so the caller closes the
// engine when it is done with it.
//
// cfg supplies the initial speed, SIM_AUTOPLAY, SIM_LOOP and the presets the
// jump command resolves; src, inj, alarms and store must all have been built
// from the same regmap.Signals table, which is what lets the engine address
// every value by index instead of by name once per sample.
func New(cfg Config, src *replay.Source, inj *injection.Engine, alarms *ctrl7.Evaluator,
	clock Clock, store *Store,
) (*Engine, error) {
	switch {
	case src == nil:
		return nil, errors.New("sim: the engine needs a replay source")
	case inj == nil:
		return nil, errors.New("sim: the engine needs an injection engine")
	case alarms == nil:
		return nil, errors.New("sim: the engine needs an alarm evaluator")
	case clock == nil:
		return nil, errors.New("sim: the engine needs a clock")
	case store == nil:
		return nil, errors.New("sim: the engine needs a register store")
	}
	if cfg.Speed < MinSpeed || cfg.Speed > MaxSpeed {
		return nil, fmt.Errorf("sim: replay speed %d is outside %d..%d",
			cfg.Speed, MinSpeed, MaxSpeed)
	}

	first, last, rows := src.Bounds()
	if rows == 0 {
		return nil, errors.New("sim: the replay source has no rows")
	}

	e := &Engine{
		cfg:     cfg,
		log:     cfg.logger(),
		src:     src,
		inj:     inj,
		alarms:  alarms,
		store:   store,
		cmds:    make(chan request, commandBuffer),
		done:    make(chan struct{}),
		state:   StatePaused,
		firstMs: first,
		lastMs:  last,
		rows:    rows,
	}
	if cfg.Autoplay {
		e.state = StatePlaying
	}
	if err := e.bindSignals(src); err != nil {
		return nil, err
	}

	cursor, err := src.Cursor()
	if err != nil {
		return nil, fmt.Errorf("sim: opening the replay cursor: %w", err)
	}
	e.cursor = cursor

	e.clock = newSimClock(clock, first, cfg.Speed)
	e.clock.running = e.state == StatePlaying
	// The very first sample of a process always carries discontinuity.
	e.pendingDisc = true
	e.refreshSnapshot()
	e.store.WriteHeader(e.header())
	return e, nil
}

// bindSignals resolves the three columns the load-state rule reads and the
// value slices the emit loop reuses.
//
// The order is the one every other package numbers the values in: the analog
// signals of regmap.Signals in table order, the recorded ones first and the
// synthetic ambient extra last, then the digital ones.
func (e *Engine) bindSignals(src *replay.Source) error {
	for _, sig := range regmap.Signals {
		switch sig.Kind {
		case regmap.KindAnalog:
			e.analogTags = append(e.analogTags, sig.Tag)
		case regmap.KindDigital:
			e.digitalTags = append(e.digitalTags, sig.Tag)
		default:
			return fmt.Errorf("sim: signal %q has unknown kind %d", sig.Tag, sig.Kind)
		}
	}

	if got := src.AnalogTags(); !slices.Equal(got, e.analogTags[:len(got)]) {
		return fmt.Errorf("sim: the source reads the analog tags %q but the register map "+
			"declares %q", got, e.analogTags)
	}
	if got := src.DigitalTags(); !slices.Equal(got, e.digitalTags) {
		return fmt.Errorf("sim: the source reads the digital tags %q but the register map "+
			"declares %q", got, e.digitalTags)
	}

	var err error
	if e.compIdx, err = digitalIndexOfColumn(e.digitalTags, "COMP"); err != nil {
		return err
	}
	if e.loadValveIdx, err = digitalIndexOfColumn(e.digitalTags, "DV_eletric"); err != nil {
		return err
	}
	if e.currentIdx, err = analogIndexOfColumn(e.analogTags, "Motor_current"); err != nil {
		return err
	}

	e.values = injection.Values{
		Analog:  make([]float64, len(e.analogTags)),
		Digital: make([]bool, len(e.digitalTags)),
	}
	e.slot = regmap.Slot{
		Analog:  make(map[string]float64, len(e.analogTags)),
		Digital: make(map[string]bool, len(e.digitalTags)),
	}
	for _, tag := range e.analogTags {
		e.slot.Analog[tag] = 0
	}
	for _, tag := range e.digitalTags {
		e.slot.Digital[tag] = false
	}
	return nil
}

// analogIndexOfColumn returns the position of the signal read from a MetroPT-3
// column among the analog values. Resolving by column rather than by tag is
// what keeps the load-state rule working across a tag rename.
func analogIndexOfColumn(tags []string, column string) (int, error) {
	sig, ok := regmap.ByColumn(column)
	if !ok || sig.Kind != regmap.KindAnalog {
		return 0, fmt.Errorf("sim: the register map declares no analog signal for column %q", column)
	}
	idx := slices.Index(tags, sig.Tag)
	if idx < 0 {
		return 0, fmt.Errorf("sim: the analog signal %q is not in the value order", sig.Tag)
	}
	return idx, nil
}

// digitalIndexOfColumn is analogIndexOfColumn for the digital values.
func digitalIndexOfColumn(tags []string, column string) (int, error) {
	sig, ok := regmap.ByColumn(column)
	if !ok || sig.Kind != regmap.KindDigital {
		return 0, fmt.Errorf("sim: the register map declares no digital signal for column %q", column)
	}
	idx := slices.Index(tags, sig.Tag)
	if idx < 0 {
		return 0, fmt.Errorf("sim: the digital signal %q is not in the value order", sig.Tag)
	}
	return idx, nil
}

// Close releases the replay cursor. It does not stop Run; cancel its context
// first.
func (e *Engine) Close() error {
	if err := e.cursor.Close(); err != nil {
		return fmt.Errorf("sim: closing the replay cursor: %w", err)
	}
	return nil
}

// Snapshot returns the engine state. It is safe to call from any goroutine at
// any time, including before Run starts.
func (e *Engine) Snapshot() Snapshot {
	e.mu.Lock()
	defer e.mu.Unlock()

	snap := e.snap
	snap.Injections = slices.Clone(e.snap.Injections)
	return snap
}

// Apply hands a command to the emit loop and waits for its result.
//
// It must be called while Run is executing: the loop owns the cursor, the
// clock and the injection engine, so a command is only ever applied between
// two rows. Once Run has returned, Apply reports CodeInternal instead of
// blocking for ever.
func (e *Engine) Apply(cmd Command) Result {
	req := request{cmd: cmd, reply: make(chan Result, 1)}
	select {
	case e.cmds <- req:
	case <-e.done:
		return Result{Err: notRunning(), Snapshot: e.Snapshot()}
	}
	select {
	case res := <-req.reply:
		return res
	case <-e.done:
		return Result{Err: notRunning(), Snapshot: e.Snapshot()}
	}
}

// notRunning is the result of a command that arrived after the loop stopped.
func notRunning() error {
	return &CommandError{Code: CodeInternal, Message: "the replay engine is not running"}
}

// Run drives the emit loop until ctx is cancelled. It returns nil on
// cancellation; any other return is a condition the replay cannot continue
// from.
//
// One engine has one loop: the cursor, the clock and the injection engine are
// owned by the goroutine that calls Run, so a second call is refused rather
// than allowed to interleave with the first.
func (e *Engine) Run(ctx context.Context) error {
	if !e.running.CompareAndSwap(false, true) {
		return errors.New("sim: the replay engine is already running")
	}
	defer close(e.done)

	e.lastHeaderWall = e.clock.wallNow()
	e.store.WriteHeader(e.header())

	for {
		if e.state != StatePlaying {
			select {
			case req := <-e.cmds:
				e.handle(req)
			case <-ctx.Done():
				return nil
			}
			continue
		}

		row, err := e.cursor.Peek()
		if err != nil {
			if !errors.Is(err, io.EOF) {
				return fmt.Errorf("sim: reading the replay source: %w", err)
			}
			e.endOfData()
			continue
		}

		// A source step wider than the gap threshold is collapsed: the clock
		// jumps to the next row and that row carries discontinuity.
		if e.havePrev && row.SimTsMs > e.prevRowMs+replay.GapThresholdMs {
			e.log.Debug("collapsing a source gap",
				slog.Uint64("from_sim_ts", e.prevRowMs),
				slog.Uint64("to_sim_ts", row.SimTsMs),
				slog.Uint64("seconds", (row.SimTsMs-e.prevRowMs)/1000))
			e.clock.reanchor(row.SimTsMs)
			e.pendingDisc = true
		}

		if row.SimTsMs <= e.clock.now() {
			e.emit(row)
			e.cursor.Advance()
			// Yield between rows so a command takes effect within one row even
			// during a catch-up burst.
			select {
			case req := <-e.cmds:
				e.handle(req)
			case <-ctx.Done():
				return nil
			default:
			}
			continue
		}

		select {
		case req := <-e.cmds:
			e.handle(req)
		case <-ctx.Done():
			return nil
		case <-e.clock.after(row.SimTsMs):
		}
	}
}

// handle applies one command and answers its caller.
func (e *Engine) handle(req request) {
	// The instant the command was applied at. A jump and a reset re-anchor
	// the clock, so an event they caused has to be stamped with where the
	// machine was when it happened, not with where it landed.
	at := e.clock.now()

	res := e.apply(req.cmd)
	// Every command refreshes the header, so a client that polls the
	// registers sees the new state without waiting for the next sample.
	e.store.WriteHeader(e.header())
	e.refreshSnapshot()
	res.Snapshot = e.Snapshot()

	if res.Marker != nil && e.OnMarker != nil {
		m := res.Marker
		e.OnMarker(m.Kind, m.FromMs, m.ToMs, m.PresetID)
	}
	e.fireInjectionEvents(res, at)

	req.reply <- res
}

// fireInjectionEvents reports what a command started and stopped, stamped with
// the instant the command was applied at.
func (e *Engine) fireInjectionEvents(res Result, at uint64) {
	if e.OnInjection == nil {
		return
	}
	if res.Started != nil {
		e.OnInjection(InjectionEvent{Event: EventStart, SimTsMs: at, Info: *res.Started})
	}
	for _, stopped := range res.Stopped {
		e.OnInjection(InjectionEvent{
			Event: EventStop, SimTsMs: at, Info: stopped.Info, Reason: stopped.Reason,
		})
	}
}

// apply runs one command on the loop's own state.
func (e *Engine) apply(cmd Command) Result {
	switch cmd.Kind {
	case CmdPlay:
		return e.play()
	case CmdPause:
		e.state = StatePaused
		e.clock.freeze()
		return Result{}
	case CmdSetSpeed:
		return e.setSpeed(cmd.Speed)
	case CmdJumpTo:
		return e.jumpTo(cmd.SimTsMs, "")
	case CmdJumpPreset:
		return e.jumpPreset(cmd.PresetID)
	case CmdInject:
		return e.inject(cmd.InjectionID, cmd.Params)
	case CmdClearInjections:
		return Result{Stopped: e.inj.StopAll(injection.ReasonCleared)}
	case CmdReset:
		return e.reset()
	default:
		return Result{Err: commandErrorf(CodeUnknownCmd, "the command %d is not one this machine knows",
			uint8(cmd.Kind))}
	}
}

// play resumes the replay. From stopped it wraps to the first row exactly as a
// loop wrap does, marker included.
func (e *Engine) play() Result {
	if e.state == StateStopped {
		from := e.clock.now()
		if err := e.rewind(); err != nil {
			return Result{Err: err}
		}
		e.state = StatePlaying
		e.clock.running = true
		return Result{Marker: &Marker{Kind: MarkerLoop, FromMs: from, ToMs: e.clock.now()}}
	}

	e.state = StatePlaying
	e.clock.start()
	return Result{}
}

// setSpeed changes the replay speed with immediate effect.
func (e *Engine) setSpeed(speed uint16) Result {
	if speed < MinSpeed || speed > MaxSpeed {
		return Result{Err: commandErrorf(CodeSpeedOutOfRange,
			"the speed %d is outside %d..%d", speed, MinSpeed, MaxSpeed)}
	}
	e.clock.setSpeed(speed)
	return Result{}
}

// jumpTo moves the replay to the first row at or after simTsMs. The state is
// unchanged, the active injections stop and the next sample carries
// discontinuity.
func (e *Engine) jumpTo(simTsMs uint64, presetID string) Result {
	if simTsMs < e.firstMs || simTsMs > e.lastMs {
		return Result{Err: commandErrorf(CodeOutOfRange,
			"the instant %d is outside the recording %d..%d", simTsMs, e.firstMs, e.lastMs)}
	}

	from := e.clock.now()
	stopped := e.inj.StopAll(injection.ReasonJump)
	if err := e.seek(simTsMs); err != nil {
		return Result{Err: err, Stopped: stopped}
	}
	return Result{
		Stopped: stopped,
		Marker:  &Marker{Kind: MarkerJump, FromMs: from, ToMs: e.clock.now(), PresetID: presetID},
	}
}

// jumpPreset resolves a preset to its lead-in start and jumps there.
func (e *Engine) jumpPreset(presetID string) Result {
	preset, ok := e.cfg.Preset(presetID)
	if !ok {
		return Result{Err: commandErrorf(CodeUnknownPreset,
			"the machine offers no preset %q", presetID)}
	}

	target := preset.LeadInStartMs()
	// The lead-in is clamped to the start of the recording: a preset near the
	// first row asks for time that was never recorded.
	if target < e.firstMs {
		target = e.firstMs
	}
	return e.jumpTo(target, preset.PresetID)
}

// inject starts one instance at the current simulated instant.
func (e *Engine) inject(injectionID string, params map[string]float64) Result {
	inst, err := e.inj.Start(injectionID, params, e.clock.now())
	if err != nil {
		switch {
		case errors.Is(err, injection.ErrUnknownInjection):
			return Result{Err: &CommandError{Code: CodeUnknownInjection, Message: err.Error()}}
		case errors.Is(err, injection.ErrBadArgs):
			return Result{Err: &CommandError{Code: CodeBadArgs, Message: err.Error()}}
		default:
			return Result{Err: &CommandError{Code: CodeInternal, Message: err.Error()}}
		}
	}
	info := inst.Info()
	return Result{Started: &info}
}

// reset clears the injections, returns to the first row and pauses at the
// configured speed.
func (e *Engine) reset() Result {
	from := e.clock.now()
	stopped := e.inj.StopAll(injection.ReasonReset)

	e.clock.speed = e.cfg.Speed
	if err := e.rewind(); err != nil {
		return Result{Err: err, Stopped: stopped}
	}
	e.state = StatePaused
	e.clock.running = false
	return Result{
		Stopped: stopped,
		Marker:  &Marker{Kind: MarkerReset, FromMs: from, ToMs: e.clock.now()},
	}
}

// rewind moves the cursor back to the first row.
func (e *Engine) rewind() error { return e.seek(e.firstMs) }

// seek moves the cursor to the first row at or after simTsMs, re-anchors the
// clock there and arms the discontinuity flag.
//
// It also forgets the previous row, so the step across the jump is never read
// as a source gap: the discontinuity is already flagged for another reason.
func (e *Engine) seek(simTsMs uint64) error {
	if err := e.cursor.Seek(simTsMs); err != nil {
		return commandErrorf(CodeInternal, "seeking to %d: %v", simTsMs, err)
	}
	position, ok := e.cursor.Position()
	if !ok {
		return commandErrorf(CodeOutOfRange, "the recording has no row at or after %d", simTsMs)
	}

	e.clock.reanchor(position)
	e.pendingDisc = true
	e.havePrev = false
	return nil
}

// endOfData wraps or stops when the cursor has run out of rows.
func (e *Engine) endOfData() {
	from := e.clock.now()
	if !e.cfg.Loop {
		e.state = StateStopped
		e.clock.freezeAt(e.lastMs)
		e.store.WriteHeader(e.header())
		e.refreshSnapshot()
		e.log.Info("the recording has ended", slog.Uint64("sim_ts", e.lastMs))
		return
	}

	if err := e.rewind(); err != nil {
		// A source that has rows at boot and none after a rewind is broken;
		// stopping beats spinning on it.
		e.state = StateStopped
		e.clock.freezeAt(e.lastMs)
		e.store.WriteHeader(e.header())
		e.refreshSnapshot()
		e.log.Error("the replay source could not be rewound", slog.String("error", err.Error()))
		return
	}

	e.store.WriteHeader(e.header())
	e.refreshSnapshot()
	if e.OnMarker != nil {
		e.OnMarker(MarkerLoop, from, e.clock.now(), "")
	}
}

// emit runs one source row through the emit pipeline and publishes it.
func (e *Engine) emit(row *replay.Row) {
	seq := e.seq + 1
	disc := e.pendingDisc

	// The load state is computed from the untouched row: an overlay may not
	// change what it is conditioned on.
	state := machine.Classify(row.Digital[e.compIdx], row.Digital[e.loadValveIdx],
		row.Analog[e.currentIdx])

	copy(e.values.Analog, row.Analog)
	// The ambient extra is the last analog value; the overlay that raises the
	// ambient temperature adds to it, so it is computed before the overlays.
	e.values.Analog[len(e.values.Analog)-1] = Ambient(row.SimTsMs)
	copy(e.values.Digital, row.Digital)

	e.inj.Apply(&e.values, state, row.SimTsMs)

	bits, _ := e.alarms.Step(
		ctrl7.Values{Analog: e.values.Analog, Digital: e.values.Digital},
		state, row.SimTsMs, disc)

	e.slot.Seq = seq
	e.slot.SimTsMs = row.SimTsMs
	e.slot.Discontinuity = disc
	e.slot.Missing = row.Missing
	e.slot.AlarmBits = bits
	for i, tag := range e.analogTags {
		e.slot.Analog[tag] = e.values.Analog[i]
	}
	for i, tag := range e.digitalTags {
		e.slot.Digital[tag] = e.values.Digital[i]
	}

	regs, err := regmap.EncodeSlot(e.slot)
	if err != nil {
		// The slot is built from regmap.Signals itself, so this cannot happen
		// without a mismatched build; dropping the sample keeps the sequence
		// contiguous rather than publishing a half-encoded one.
		e.log.Error("encoding a sample failed; the row is skipped",
			slog.Uint64("sim_ts", row.SimTsMs), slog.String("error", err.Error()))
		return
	}

	e.store.WriteSample(regs, seq)
	e.seq = seq
	e.pendingDisc = false
	e.havePrev, e.prevRowMs = true, row.SimTsMs

	if wall := e.clock.wallNow(); wall.Sub(e.lastHeaderWall) >= headerInterval {
		e.store.WriteHeader(e.header())
		e.lastHeaderWall = wall
	}
	e.refreshSnapshot()

	if e.OnEmit != nil {
		e.OnEmit(seq, row.SimTsMs)
	}
	e.expireInjections(row.SimTsMs)
}

// expireInjections ends the instances whose duration has run out.
func (e *Engine) expireInjections(simTsMs uint64) {
	stopped := e.inj.Expire(simTsMs)
	if len(stopped) == 0 {
		return
	}
	e.refreshSnapshot()
	if e.OnInjection == nil {
		return
	}
	for _, s := range stopped {
		e.OnInjection(InjectionEvent{
			Event: EventStop, SimTsMs: simTsMs, Info: s.Info, Reason: s.Reason,
		})
	}
}

// header renders the current header block.
func (e *Engine) header() regmap.Header {
	return regmap.Header{
		HeadSeq: e.seq,
		SimTsMs: e.clock.now(),
		State:   e.state.register(),
		Speed:   e.clock.speed,
	}
}

// refreshSnapshot copies the loop's state into the snapshot readers see.
func (e *Engine) refreshSnapshot() {
	active := e.inj.Active()

	e.mu.Lock()
	defer e.mu.Unlock()
	e.snap = Snapshot{
		State:      e.state,
		Speed:      e.clock.speed,
		SimTsMs:    e.clock.now(),
		HeadSeq:    e.seq,
		FirstTsMs:  e.firstMs,
		LastTsMs:   e.lastMs,
		Rows:       e.rows,
		Loop:       e.cfg.Loop,
		Injections: active,
	}
}
