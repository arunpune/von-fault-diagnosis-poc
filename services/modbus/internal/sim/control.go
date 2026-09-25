// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package sim

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"slices"
	"sync"
	"time"

	"fault-diagnosis-poc/services/modbus/internal/injection"
	"fault-diagnosis-poc/services/modbus/internal/mqttio"
)

// MQTTUsername is the broker credential the simulator always connects with.
// The ACL grants it exactly one subscription and three publish branches
// (infra/mosquitto/acl).
const MQTTUsername = "sim"

// SubscribeTimeout bounds the SUBSCRIBE sent when a connection comes up.
const SubscribeTimeout = 5 * time.Second

// AckCacheSize is how many command identifiers are remembered for the
// idempotence rule of the control plane: a repeat of one of the last 64
// cmd_ids is answered from the stored acknowledgement and never applied twice.
const AckCacheSize = 64

// The seven commands of the control protocol. They are the literals of the
// control-cmd schema's enum, and the acknowledgement echoes them back.
const (
	CmdNamePlay            = "play"
	CmdNamePause           = "pause"
	CmdNameSetSpeed        = "set_speed"
	CmdNameJump            = "jump"
	CmdNameInject          = "inject"
	CmdNameClearInjections = "clear_injections"
	CmdNameReset           = "reset"
)

// ControlPlaneConfig is everything the control plane needs.
type ControlPlaneConfig struct {
	// Engine is the replay loop every command is applied to.
	Engine *Engine
	// UnitID is the machine the topics are rooted at.
	UnitID string
	// Clock supplies wall_ts and drives the status ticker.
	Clock Clock
	// Status renders and sends the retained status document.
	Status *StatusPublisher
	// GT renders and sends the four ground-truth topics.
	GT *GtPublisher
	// Logger receives the refusals and the publish failures; nil discards
	// them.
	Logger *slog.Logger
}

// ControlPlane is the simulator's MQTT side: it takes commands on
// plant/<unit>/control/cmd, applies them to the engine, answers every one of
// them on plant/<unit>/control/ack, keeps the retained status document fresh
// and forwards the engine's own events to the ground-truth topics
// (docs/simulation.md, "Control commands and acknowledgements").
//
// It is built before the broker connection exists, because mqttio hands the
// client to the OnConnectionUp callback; ConnectionUp attaches it and is safe
// to call again on every reconnect.
type ControlPlane struct {
	engine *Engine
	topics mqttio.Topics
	unitID string
	clock  Clock
	status *StatusPublisher
	gt     *GtPublisher
	log    *slog.Logger
	acks   *ackCache

	mu     sync.RWMutex
	broker Broker
}

// NewControlPlane assembles the control plane. It neither connects nor
// subscribes: ConnectionUp does both, once the client is up.
func NewControlPlane(cfg ControlPlaneConfig) (*ControlPlane, error) {
	switch {
	case cfg.Engine == nil:
		return nil, errors.New("sim: the control plane needs an engine")
	case cfg.UnitID == "":
		return nil, errors.New("sim: the control plane needs a unit id")
	case cfg.Clock == nil:
		return nil, errors.New("sim: the control plane needs a clock")
	case cfg.Status == nil:
		return nil, errors.New("sim: the control plane needs a status publisher")
	case cfg.GT == nil:
		return nil, errors.New("sim: the control plane needs a ground-truth publisher")
	}

	log := cfg.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &ControlPlane{
		engine: cfg.Engine,
		topics: mqttio.Topics{UnitID: cfg.UnitID},
		unitID: cfg.UnitID,
		clock:  cfg.Clock,
		status: cfg.Status,
		gt:     cfg.GT,
		log:    log,
		acks:   newAckCache(AckCacheSize),
	}, nil
}

// CmdTopic and AckTopic are the two control topics.
func (p *ControlPlane) CmdTopic() string { return p.topics.ControlCmd() }
func (p *ControlPlane) AckTopic() string { return p.topics.ControlAck() }

// Connected reports whether the broker session is up. The health endpoint
// reads it: without a control plane the user interface cannot drive the
// machine, so the simulator is not ready.
func (p *ControlPlane) Connected() bool {
	broker, ok := p.currentBroker()
	return ok && broker.Connected()
}

// ConnectionUp attaches broker and restores everything a new session needs:
// the command subscription, the retained ground-truth catalog, the retained
// list of running injections and the retained status document.
//
// It runs on the first connection and on every reconnect. A broker that
// restarted has lost every retained message, so all three are sent again
// rather than assumed to be there.
func (p *ControlPlane) ConnectionUp(broker Broker) {
	p.mu.Lock()
	p.broker = broker
	p.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), SubscribeTimeout)
	defer cancel()

	if err := broker.Subscribe(ctx, p.CmdTopic(), PublishQoS, p.handle); err != nil {
		// The subscription is remembered by the client and retried on the
		// next reconnect; the retained documents below are still worth
		// sending, so this is a warning and not a return.
		p.log.Error("subscribing to the control topic failed",
			slog.String("topic", p.CmdTopic()), slog.Any("error", err))
	}

	snap := p.engine.Snapshot()
	if err := p.gt.PublishCatalog(ctx, broker, snap); err != nil {
		p.log.Warn("publishing the ground-truth catalog failed", slog.Any("error", err))
	}
	if err := p.gt.PublishActive(ctx, broker, snap, true); err != nil {
		p.log.Warn("publishing the active injections failed", slog.Any("error", err))
	}
	if err := p.status.Publish(ctx, broker, snap); err != nil {
		p.log.Warn("publishing the simulator status failed", slog.Any("error", err))
	}
}

// Run keeps the retained status document fresh: one publication per
// StatusInterval of the clock, until ctx ends.
//
// The first document of a session is ConnectionUp's, not this loop's — the
// ticker only refreshes what is already there, so a machine that nothing asks
// anything of still says where its cursor sits.
//
// A cancelled context returns without publishing anything, which is what a
// SIGTERM asks for: the retained document stays as the last state the machine
// was really in.
func (p *ControlPlane) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-p.clock.After(StatusInterval):
		}
		if ctx.Err() != nil {
			return
		}
		p.publishStatus(ctx, p.engine.Snapshot())
	}
}

// OnMarker is the engine's MarkerHook: every jump, reset and loop wrap becomes
// a gt/<unit>/marker message.
func (p *ControlPlane) OnMarker(kind string, fromMs, toMs uint64, presetID string) {
	broker, ok := p.currentBroker()
	if !ok {
		return
	}
	if err := p.gt.PublishMarker(context.Background(), broker, kind, fromMs, toMs, presetID); err != nil {
		p.log.Warn("publishing a replay marker failed",
			slog.String("kind", kind), slog.Any("error", err))
	}
}

// OnInjection is the engine's InjectionHook: every start and stop becomes a
// gt/<unit>/injection message, and the retained active list follows it.
func (p *ControlPlane) OnInjection(ev InjectionEvent) {
	broker, ok := p.currentBroker()
	if !ok {
		return
	}
	ctx := context.Background()

	if err := p.gt.PublishInjection(ctx, broker, ev); err != nil {
		p.log.Warn("publishing an injection event failed",
			slog.String("event", ev.Event), slog.Any("error", err))
	}
	if err := p.gt.PublishActive(ctx, broker, p.engine.Snapshot(), false); err != nil {
		p.log.Warn("publishing the active injections failed", slog.Any("error", err))
	}
}

// currentBroker returns the attached broker, or false before the first
// connection came up.
func (p *ControlPlane) currentBroker() (Broker, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.broker, p.broker != nil
}

// controlCommand is the control-cmd message. Unknown top-level fields are
// ignored on purpose, so a minor version of the schema can add one.
type controlCommand struct {
	Schema string          `json:"schema"`
	UnitID string          `json:"unit_id"`
	CmdID  string          `json:"cmd_id"`
	Cmd    string          `json:"cmd"`
	Args   json.RawMessage `json:"args"`
}

// controlAck is the control-ack message: the status snapshot taken after the
// command, and no bare state, speed or sim_ts beside it.
type controlAck struct {
	Schema     string    `json:"schema"`
	UnitID     string    `json:"unit_id"`
	WallTS     string    `json:"wall_ts"`
	CmdID      string    `json:"cmd_id"`
	Cmd        string    `json:"cmd"`
	OK         bool      `json:"ok"`
	Error      *ackError `json:"error"`
	Status     SimStatus `json:"status"`
	InstanceID string    `json:"instance_id,omitempty"`
}

// ackError is the refusal object: one of the seven codes and one English
// sentence for the operator.
type ackError struct {
	Code    ErrorCode `json:"code"`
	Message string    `json:"message"`
}

// handle answers one command. It runs on the client's dispatch goroutine, in
// the order the broker delivered the messages, so one command is applied and
// acknowledged before the next is read.
func (p *ControlPlane) handle(_ string, payload []byte, _ bool) {
	cmd, ok := p.parse(payload)
	if !ok {
		return
	}

	broker, attached := p.currentBroker()
	if !attached {
		// Unreachable in practice — the handler is registered on a connected
		// client — but a command that cannot be answered must not be applied
		// either, or the caller would never learn what happened.
		p.log.Warn("a control command arrived before the broker was attached",
			slog.String("cmd_id", cmd.CmdID))
		return
	}

	ctx := context.Background()
	if stored, replay := p.acks.get(cmd.CmdID); replay {
		p.log.Debug("re-sending the stored acknowledgement of a repeated command",
			slog.String("cmd_id", cmd.CmdID), slog.String("cmd", cmd.Cmd))
		p.sendAck(ctx, broker, cmd.CmdID, stored)
		return
	}

	res, kind := p.apply(cmd)
	ack, err := p.encodeAck(cmd, res)
	if err != nil {
		p.log.Error("encoding an acknowledgement failed",
			slog.String("cmd_id", cmd.CmdID), slog.Any("error", err))
		return
	}

	p.acks.put(cmd.CmdID, ack)
	p.sendAck(ctx, broker, cmd.CmdID, ack)

	// A command that moved the cursor, changed the speed or changed the state
	// refreshes the retained document at once rather than waiting for the next
	// tick.
	if res.Err == nil && changesReplay(kind) {
		p.publishStatus(ctx, res.Snapshot)
	}
}

// parse reads one command off the wire. A message that is not this machine's
// business — unparsable, another schema, another unit, or without a command
// identifier to answer — is logged and dropped: there is nobody to
// acknowledge it to.
func (p *ControlPlane) parse(payload []byte) (controlCommand, bool) {
	var cmd controlCommand
	if err := json.Unmarshal(payload, &cmd); err != nil {
		p.log.Warn("ignoring an unreadable control command", slog.Any("error", err))
		return controlCommand{}, false
	}

	switch {
	case cmd.Schema != mqttio.SchemaID("control-cmd"):
		p.log.Warn("ignoring a control command of another schema",
			slog.String("schema", cmd.Schema))
		return controlCommand{}, false
	case cmd.UnitID != p.unitID:
		p.log.Warn("ignoring a control command addressed to another unit",
			slog.String("unit_id", cmd.UnitID), slog.String("this_unit", p.unitID))
		return controlCommand{}, false
	case cmd.CmdID == "":
		p.log.Warn("ignoring a control command without a cmd_id",
			slog.String("cmd", cmd.Cmd))
		return controlCommand{}, false
	}
	return cmd, true
}

// apply turns one parsed command into an engine command and runs it, or
// refuses it before the engine sees it. It returns the result and the engine
// command kind, which is CmdUnknown for a refusal.
func (p *ControlPlane) apply(cmd controlCommand) (Result, CommandKind) {
	engineCmd, err := p.decode(cmd)
	if err != nil {
		return Result{Err: err, Snapshot: p.engine.Snapshot()}, CmdUnknown
	}
	return p.engine.Apply(engineCmd), engineCmd.Kind
}

// decode maps one command name and its arguments onto an engine command.
func (p *ControlPlane) decode(cmd controlCommand) (Command, error) {
	switch cmd.Cmd {
	case CmdNamePlay:
		return Play(), noArgs(cmd)
	case CmdNamePause:
		return Pause(), noArgs(cmd)
	case CmdNameClearInjections:
		return ClearInjections(), noArgs(cmd)
	case CmdNameReset:
		return Reset(), noArgs(cmd)
	case CmdNameSetSpeed:
		return decodeSetSpeed(cmd.Args)
	case CmdNameJump:
		return decodeJump(cmd.Args)
	case CmdNameInject:
		return decodeInject(cmd.Args)
	default:
		return Command{}, commandErrorf(CodeUnknownCmd,
			"this machine knows no command %q", cmd.Cmd)
	}
}

// noArgs rejects arguments passed to a command that takes none.
func noArgs(cmd controlCommand) error {
	var empty struct{}
	if err := decodeArgs(cmd.Args, &empty); err != nil {
		return err
	}
	return nil
}

// decodeSetSpeed reads {"speed": int}.
func decodeSetSpeed(raw json.RawMessage) (Command, error) {
	var args struct {
		Speed *int64 `json:"speed"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return Command{}, err
	}
	if args.Speed == nil {
		return Command{}, commandErrorf(CodeBadArgs, "set_speed needs a speed")
	}
	// The bound is checked here and not only in the engine, because a speed
	// outside the range of the register field would not survive the conversion
	// to uint16.
	if *args.Speed < int64(MinSpeed) || *args.Speed > int64(MaxSpeed) {
		return Command{}, commandErrorf(CodeSpeedOutOfRange,
			"the speed %d is outside %d..%d", *args.Speed, MinSpeed, MaxSpeed)
	}
	return SetSpeed(uint16(*args.Speed)), nil
}

// decodeJump reads {"preset_id": string} or {"sim_ts": iso}, exactly one of
// the two.
func decodeJump(raw json.RawMessage) (Command, error) {
	var args struct {
		PresetID *string `json:"preset_id"`
		SimTS    *string `json:"sim_ts"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return Command{}, err
	}

	switch {
	case args.PresetID != nil && args.SimTS != nil:
		return Command{}, commandErrorf(CodeBadArgs,
			"jump takes a preset_id or a sim_ts, not both")
	case args.PresetID != nil:
		if *args.PresetID == "" {
			return Command{}, commandErrorf(CodeBadArgs, "jump was given an empty preset_id")
		}
		return JumpPreset(*args.PresetID), nil
	case args.SimTS != nil:
		ms, err := mqttio.ParseTS(*args.SimTS)
		if err != nil {
			return Command{}, commandErrorf(CodeBadArgs,
				"jump was given the unreadable instant %q", *args.SimTS)
		}
		return JumpTo(ms), nil
	default:
		return Command{}, commandErrorf(CodeBadArgs, "jump needs a preset_id or a sim_ts")
	}
}

// decodeInject reads {"injection_id": string, "params": {...}}.
func decodeInject(raw json.RawMessage) (Command, error) {
	var args struct {
		InjectionID string `json:"injection_id"`
		Params      *struct {
			Magnitude      *float64 `json:"magnitude"`
			DurationSimMin *int64   `json:"duration_sim_min"`
		} `json:"params"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return Command{}, err
	}
	if args.InjectionID == "" {
		return Command{}, commandErrorf(CodeBadArgs, "inject needs an injection_id")
	}

	var params map[string]float64
	if args.Params != nil {
		params = map[string]float64{}
		if args.Params.Magnitude != nil {
			params[injection.MagnitudeParam] = *args.Params.Magnitude
		}
		if args.Params.DurationSimMin != nil {
			params[injection.DurationParam] = float64(*args.Params.DurationSimMin)
		}
	}
	return Inject(args.InjectionID, params), nil
}

// decodeArgs reads the argument object into target. An absent or null object
// is the empty one, which is what the commands that take no argument send; an
// argument the command does not declare is a bad_args refusal, because the
// schema closes every argument object.
func decodeArgs(raw json.RawMessage, target any) error {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil
	}

	dec := json.NewDecoder(bytes.NewReader(trimmed))
	dec.DisallowUnknownFields()
	if err := dec.Decode(target); err != nil {
		return commandErrorf(CodeBadArgs, "the arguments are not the ones this command takes: %v", err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return commandErrorf(CodeBadArgs, "the argument object is followed by more content")
	}
	return nil
}

// changesReplay reports whether a command moved the cursor, changed the speed
// or changed the state, which is what an immediate status publication is for.
func changesReplay(kind CommandKind) bool {
	return slices.Contains([]CommandKind{
		CmdPlay, CmdPause, CmdSetSpeed, CmdJumpTo, CmdJumpPreset, CmdReset,
	}, kind)
}

// encodeAck renders the acknowledgement of one command.
func (p *ControlPlane) encodeAck(cmd controlCommand, res Result) ([]byte, error) {
	ack := controlAck{
		Schema:     mqttio.SchemaID("control-ack"),
		UnitID:     p.unitID,
		WallTS:     mqttio.WallTS(p.clock.Now()),
		CmdID:      cmd.CmdID,
		Cmd:        cmd.Cmd,
		OK:         res.Err == nil,
		Status:     p.status.Document(res.Snapshot),
		InstanceID: res.InstanceID(),
	}
	if res.Err != nil {
		ack.Error = &ackError{Code: ErrorCodeOf(res.Err), Message: message(res.Err)}
	}

	payload, err := json.Marshal(ack)
	if err != nil {
		return nil, fmt.Errorf("sim: encoding the acknowledgement of %q: %w", cmd.CmdID, err)
	}
	return payload, nil
}

// message returns the operator-facing sentence of a refusal. A *CommandError
// carries it without its code; anything else is reported as it is.
func message(err error) string {
	var cmdErr *CommandError
	if errors.As(err, &cmdErr) {
		return cmdErr.Message
	}
	return err.Error()
}

// sendAck publishes one acknowledgement.
func (p *ControlPlane) sendAck(ctx context.Context, broker Broker, cmdID string, payload []byte) {
	if err := publish(ctx, broker, p.AckTopic(), payload, false); err != nil {
		p.log.Warn("publishing an acknowledgement failed",
			slog.String("cmd_id", cmdID), slog.Any("error", err))
	}
}

// publishStatus sends the retained status document, if there is a broker to
// send it to.
func (p *ControlPlane) publishStatus(ctx context.Context, snap Snapshot) {
	broker, ok := p.currentBroker()
	if !ok {
		return
	}
	if err := p.status.Publish(ctx, broker, snap); err != nil && ctx.Err() == nil {
		p.log.Warn("publishing the simulator status failed", slog.Any("error", err))
	}
}

// ackCache remembers the acknowledgements of the last commands, oldest first.
// It is the idempotence rule: a repeated cmd_id is answered with the stored
// message and the engine never sees the command a second time.
type ackCache struct {
	size int

	mu    sync.Mutex
	order []string
	by    map[string][]byte
}

// newAckCache returns a cache holding size acknowledgements.
func newAckCache(size int) *ackCache {
	return &ackCache{size: size, order: make([]string, 0, size), by: make(map[string][]byte, size)}
}

// get returns the stored acknowledgement of cmdID.
func (c *ackCache) get(cmdID string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	payload, ok := c.by[cmdID]
	return payload, ok
}

// put stores one acknowledgement, dropping the oldest when the cache is full.
func (c *ackCache) put(cmdID string, payload []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if _, ok := c.by[cmdID]; ok {
		c.by[cmdID] = payload
		return
	}
	if len(c.order) == c.size {
		oldest := c.order[0]
		c.order = c.order[1:]
		delete(c.by, oldest)
	}
	c.order = append(c.order, cmdID)
	c.by[cmdID] = payload
}
