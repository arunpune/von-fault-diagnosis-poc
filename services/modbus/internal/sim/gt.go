// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package sim

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"

	"fault-diagnosis-poc/services/modbus/internal/injection"
	"fault-diagnosis-poc/services/modbus/internal/mqttio"
)

// The four ground-truth topics all travel at PublishQoS. The catalog and the
// active list are retained on top of that; the events are not, because an
// event describes an instant and would be misleading if it were replayed to a
// late subscriber, which reads the retained list instead.

// GtDocuments are the two ground-truth files the simulator forwards without
// reading them: the preset menu and the MetroPT-3 failure table.
// packages/ground-truth owns both; the machine only needs `preset_id`,
// `sim_ts` and `lead_in_min` out of the presets, which LoadPresets takes, so
// everything else travels as opaque JSON.
type GtDocuments struct {
	Presets  json.RawMessage
	Failures json.RawMessage
}

// LoadGtDocuments reads the two forwarded documents from the paths cfg points
// at. A file that is absent or is not a JSON object is an error that names it:
// the catalog is the only place the user interface and the evaluation harness
// learn what the machine can do, so a half-built one is worse than none.
func LoadGtDocuments(cfg Config) (GtDocuments, error) {
	presets, err := readJSONObject(cfg.PresetsPath())
	if err != nil {
		return GtDocuments{}, err
	}
	failures, err := readJSONObject(cfg.FailuresPath())
	if err != nil {
		return GtDocuments{}, err
	}
	return GtDocuments{Presets: presets, Failures: failures}, nil
}

// readJSONObject reads one document and returns it compacted, so the catalog
// message carries no pretty-printing from the file.
func readJSONObject(path string) (json.RawMessage, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("sim: reading the ground-truth document: %w", err)
	}

	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		return nil, fmt.Errorf("sim: %s is not JSON: %w", path, err)
	}
	if compact.Len() == 0 || compact.Bytes()[0] != '{' {
		return nil, fmt.Errorf("sim: %s does not hold a JSON object", path)
	}
	return json.RawMessage(compact.Bytes()), nil
}

// GtConfig is everything the ground-truth publisher needs besides the engine
// state it reads per message.
type GtConfig struct {
	// UnitID is the machine the topics are rooted at.
	UnitID string
	// Clock supplies wall_ts.
	Clock Clock
	// Documents are the presets and the failure table, forwarded verbatim.
	Documents GtDocuments
	// Catalog is the injection catalog the menu is summarised from.
	Catalog *injection.Catalog
	// Gaps is how many holes the replay source has, for the catalog's
	// dataset object.
	Gaps int
}

// GtPublisher writes the four ground-truth topics (docs/simulation.md, "Where
// the ground truth goes").
//
// It is the only publisher under gt/, and nothing it renders ever reaches a
// plant/ topic: the broker ACL draws the same line (infra/mosquitto/acl), and
// the no-leak test of this package asserts it from the other side.
type GtPublisher struct {
	topics     mqttio.Topics
	unitID     string
	clock      Clock
	documents  GtDocuments
	injections []gtInjectionSummary
	gaps       int

	// mu guards lastActive, the rendering of the active list that was
	// published last. One command can stop several instances and the engine
	// reports each of them, so the list would otherwise be published
	// unchanged once per event.
	mu         sync.Mutex
	lastActive []byte
}

// NewGtPublisher returns the publisher for cfg.
func NewGtPublisher(cfg GtConfig) (*GtPublisher, error) {
	switch {
	case cfg.UnitID == "":
		return nil, errors.New("sim: the ground-truth publisher needs a unit id")
	case cfg.Clock == nil:
		return nil, errors.New("sim: the ground-truth publisher needs a clock")
	case cfg.Catalog == nil:
		return nil, errors.New("sim: the ground-truth publisher needs an injection catalog")
	case len(cfg.Documents.Presets) == 0:
		return nil, errors.New("sim: the ground-truth publisher needs the presets document")
	case len(cfg.Documents.Failures) == 0:
		return nil, errors.New("sim: the ground-truth publisher needs the failure table")
	case cfg.Gaps < 0:
		return nil, fmt.Errorf("sim: the replay source cannot have %d gaps", cfg.Gaps)
	}

	return &GtPublisher{
		topics:     mqttio.Topics{UnitID: cfg.UnitID},
		unitID:     cfg.UnitID,
		clock:      cfg.Clock,
		documents:  cfg.Documents,
		injections: summariseCatalog(cfg.Catalog),
		gaps:       cfg.Gaps,
	}, nil
}

// gtCatalog is the retained gt-catalog message.
type gtCatalog struct {
	Schema     string               `json:"schema"`
	UnitID     string               `json:"unit_id"`
	WallTS     string               `json:"wall_ts"`
	Dataset    gtCatalogDataset     `json:"dataset"`
	Presets    json.RawMessage      `json:"presets"`
	Injections []gtInjectionSummary `json:"injections"`
	Failures   json.RawMessage      `json:"failures"`
}

// gtCatalogDataset is the closed "dataset" object of the catalog: the status
// document's three fields plus the number of holes in the recording.
type gtCatalogDataset struct {
	FirstTS string `json:"first_ts"`
	LastTS  string `json:"last_ts"`
	Rows    int    `json:"rows"`
	Gaps    int    `json:"gaps"`
}

// gtInjectionSummary is one menu entry: what the user interface lists, without
// the transforms and the envelope that stay inside the machine.
type gtInjectionSummary struct {
	InjectionID           string               `json:"injection_id"`
	FaultID               string               `json:"fault_id"`
	Label                 string               `json:"label"`
	Benign                bool                 `json:"benign"`
	Description           string               `json:"description"`
	DefaultDurationSimMin int                  `json:"default_duration_sim_min"`
	Params                []injection.ParamDef `json:"params"`
}

// gtInstanceParams are the two resolved parameters an instance runs with.
type gtInstanceParams struct {
	Magnitude      float64 `json:"magnitude"`
	DurationSimMin int     `json:"duration_sim_min"`
}

// gtInjectionEvent is one start or stop on gt/<unit>/injection.
type gtInjectionEvent struct {
	Schema      string           `json:"schema"`
	UnitID      string           `json:"unit_id"`
	WallTS      string           `json:"wall_ts"`
	SimTS       string           `json:"sim_ts"`
	Event       string           `json:"event"`
	InstanceID  string           `json:"instance_id"`
	InjectionID string           `json:"injection_id"`
	FaultID     string           `json:"fault_id"`
	Params      gtInstanceParams `json:"params"`
	EndsSimTS   string           `json:"ends_sim_ts"`
	Reason      string           `json:"reason,omitempty"`
}

// gtActiveList is the retained gt-injection-active message.
type gtActiveList struct {
	Schema string             `json:"schema"`
	UnitID string             `json:"unit_id"`
	WallTS string             `json:"wall_ts"`
	SimTS  string             `json:"sim_ts"`
	Active []gtActiveInstance `json:"active"`
}

// gtActiveInstance is one running instance of the retained list.
type gtActiveInstance struct {
	InstanceID   string           `json:"instance_id"`
	InjectionID  string           `json:"injection_id"`
	FaultID      string           `json:"fault_id"`
	StartedSimTS string           `json:"started_sim_ts"`
	EndsSimTS    string           `json:"ends_sim_ts"`
	Params       gtInstanceParams `json:"params"`
}

// gtMarker is one discontinuity on gt/<unit>/marker.
type gtMarker struct {
	Schema    string `json:"schema"`
	UnitID    string `json:"unit_id"`
	WallTS    string `json:"wall_ts"`
	Kind      string `json:"kind"`
	SimTSFrom string `json:"sim_ts_from"`
	SimTSTo   string `json:"sim_ts_to"`
	PresetID  string `json:"preset_id,omitempty"`
}

// summariseCatalog reduces every definition to the menu entry the catalog
// advertises.
func summariseCatalog(cat *injection.Catalog) []gtInjectionSummary {
	out := make([]gtInjectionSummary, 0, len(cat.Injections))
	for i := range cat.Injections {
		def := &cat.Injections[i]
		out = append(out, gtInjectionSummary{
			InjectionID:           def.InjectionID,
			FaultID:               def.FaultID,
			Label:                 def.Label,
			Benign:                def.Benign,
			Description:           def.Description,
			DefaultDurationSimMin: def.DefaultDurationSimMin,
			Params:                def.Params,
		})
	}
	return out
}

// instanceParams reads the two resolved parameters out of the engine's
// instance description.
func instanceParams(info injection.InstanceInfo) gtInstanceParams {
	return gtInstanceParams{
		Magnitude:      info.Params[injection.MagnitudeParam],
		DurationSimMin: int(info.Params[injection.DurationParam]),
	}
}

// CatalogTopic, InjectionTopic, ActiveTopic and MarkerTopic are the four
// topics this publisher writes.
func (g *GtPublisher) CatalogTopic() string   { return g.topics.GtCatalog() }
func (g *GtPublisher) InjectionTopic() string { return g.topics.GtInjection() }
func (g *GtPublisher) ActiveTopic() string    { return g.topics.GtInjectionActive() }
func (g *GtPublisher) MarkerTopic() string    { return g.topics.GtMarker() }

// EncodeCatalog renders the retained catalog for snap.
func (g *GtPublisher) EncodeCatalog(snap Snapshot) ([]byte, error) {
	payload, err := json.Marshal(gtCatalog{
		Schema: mqttio.SchemaID("gt-catalog"),
		UnitID: g.unitID,
		WallTS: mqttio.WallTS(g.clock.Now()),
		Dataset: gtCatalogDataset{
			FirstTS: mqttio.SimTS(snap.FirstTsMs),
			LastTS:  mqttio.SimTS(snap.LastTsMs),
			Rows:    snap.Rows,
			Gaps:    g.gaps,
		},
		Presets:    g.documents.Presets,
		Injections: g.injections,
		Failures:   g.documents.Failures,
	})
	if err != nil {
		return nil, fmt.Errorf("sim: encoding the ground-truth catalog: %w", err)
	}
	return payload, nil
}

// PublishCatalog sends the retained catalog. It runs on every connection, the
// first one and every reconnect, because a broker that restarted has lost the
// retained copy.
func (g *GtPublisher) PublishCatalog(ctx context.Context, broker Broker, snap Snapshot) error {
	payload, err := g.EncodeCatalog(snap)
	if err != nil {
		return err
	}
	return publish(ctx, broker, g.CatalogTopic(), payload, true)
}

// EncodeActive renders the retained list of running instances for snap, and
// returns the rendering of the list itself so the caller can tell an unchanged
// list from a changed one without comparing wall clocks.
func (g *GtPublisher) EncodeActive(snap Snapshot) (payload, list []byte, err error) {
	active := make([]gtActiveInstance, 0, len(snap.Injections))
	for _, info := range snap.Injections {
		active = append(active, gtActiveInstance{
			InstanceID:   info.InstanceID,
			InjectionID:  info.InjectionID,
			FaultID:      info.FaultID,
			StartedSimTS: mqttio.SimTS(info.StartedSimTsMs),
			EndsSimTS:    mqttio.SimTS(info.EndsSimTsMs),
			Params:       instanceParams(info),
		})
	}

	if list, err = json.Marshal(active); err != nil {
		return nil, nil, fmt.Errorf("sim: encoding the active injections: %w", err)
	}
	payload, err = json.Marshal(gtActiveList{
		Schema: mqttio.SchemaID("gt-injection-active"),
		UnitID: g.unitID,
		WallTS: mqttio.WallTS(g.clock.Now()),
		SimTS:  mqttio.SimTS(snap.SimTsMs),
		Active: active,
	})
	if err != nil {
		return nil, nil, fmt.Errorf("sim: encoding the active injection list: %w", err)
	}
	return payload, list, nil
}

// PublishActive sends the retained list of running instances when it differs
// from the one last published. force sends it whatever it holds, which is what
// a new connection needs: the broker's retained copy is gone with the session
// that wrote it.
func (g *GtPublisher) PublishActive(ctx context.Context, broker Broker, snap Snapshot, force bool) error {
	payload, list, err := g.EncodeActive(snap)
	if err != nil {
		return err
	}

	g.mu.Lock()
	unchanged := !force && bytes.Equal(list, g.lastActive)
	if !unchanged {
		g.lastActive = list
	}
	g.mu.Unlock()

	if unchanged {
		return nil
	}
	if err := publish(ctx, broker, g.ActiveTopic(), payload, true); err != nil {
		// The list is forgotten again so the next change republishes it:
		// remembering a list the broker never took would hide the difference.
		g.forgetActive()
		return err
	}
	return nil
}

// forgetActive drops the remembered rendering, so the next PublishActive sends
// whatever the engine holds.
func (g *GtPublisher) forgetActive() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.lastActive = nil
}

// EncodeInjection renders one start or stop event.
func (g *GtPublisher) EncodeInjection(ev InjectionEvent) ([]byte, error) {
	payload, err := json.Marshal(gtInjectionEvent{
		Schema:      mqttio.SchemaID("gt-injection"),
		UnitID:      g.unitID,
		WallTS:      mqttio.WallTS(g.clock.Now()),
		SimTS:       mqttio.SimTS(ev.SimTsMs),
		Event:       ev.Event,
		InstanceID:  ev.Info.InstanceID,
		InjectionID: ev.Info.InjectionID,
		FaultID:     ev.Info.FaultID,
		Params:      instanceParams(ev.Info),
		EndsSimTS:   mqttio.SimTS(ev.Info.EndsSimTsMs),
		Reason:      string(ev.Reason),
	})
	if err != nil {
		return nil, fmt.Errorf("sim: encoding an injection event: %w", err)
	}
	return payload, nil
}

// PublishInjection sends one start or stop event. It is not retained: the
// event describes an instant, and a late subscriber reads the retained active
// list instead.
func (g *GtPublisher) PublishInjection(ctx context.Context, broker Broker, ev InjectionEvent) error {
	payload, err := g.EncodeInjection(ev)
	if err != nil {
		return err
	}
	return publish(ctx, broker, g.InjectionTopic(), payload, false)
}

// EncodeMarker renders one discontinuity.
func (g *GtPublisher) EncodeMarker(kind string, fromMs, toMs uint64, presetID string) ([]byte, error) {
	payload, err := json.Marshal(gtMarker{
		Schema:    mqttio.SchemaID("gt-marker"),
		UnitID:    g.unitID,
		WallTS:    mqttio.WallTS(g.clock.Now()),
		Kind:      kind,
		SimTSFrom: mqttio.SimTS(fromMs),
		SimTSTo:   mqttio.SimTS(toMs),
		PresetID:  presetID,
	})
	if err != nil {
		return nil, fmt.Errorf("sim: encoding a replay marker: %w", err)
	}
	return payload, nil
}

// PublishMarker sends one jump, reset or loop wrap.
func (g *GtPublisher) PublishMarker(ctx context.Context, broker Broker,
	kind string, fromMs, toMs uint64, presetID string,
) error {
	payload, err := g.EncodeMarker(kind, fromMs, toMs, presetID)
	if err != nil {
		return err
	}
	return publish(ctx, broker, g.MarkerTopic(), payload, false)
}
