// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package sim_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/injection"
	"fault-diagnosis-poc/services/modbus/internal/mqttio"
	"fault-diagnosis-poc/services/modbus/internal/schematest"
	"fault-diagnosis-poc/services/modbus/internal/sim"
	"fault-diagnosis-poc/services/modbus/internal/testutil"
)

// gtCatalogOf is the retained catalog as the tests read it back.
type gtCatalogOf struct {
	Schema  string `json:"schema"`
	UnitID  string `json:"unit_id"`
	WallTS  string `json:"wall_ts"`
	Dataset struct {
		FirstTS string `json:"first_ts"`
		LastTS  string `json:"last_ts"`
		Rows    int    `json:"rows"`
		Gaps    int    `json:"gaps"`
	} `json:"dataset"`
	Presets    json.RawMessage `json:"presets"`
	Injections []struct {
		InjectionID           string               `json:"injection_id"`
		FaultID               string               `json:"fault_id"`
		Label                 string               `json:"label"`
		Benign                bool                 `json:"benign"`
		Description           string               `json:"description"`
		DefaultDurationSimMin int                  `json:"default_duration_sim_min"`
		Params                []injection.ParamDef `json:"params"`
	} `json:"injections"`
	Failures json.RawMessage `json:"failures"`
}

// gtInjectionOf is one injection event.
type gtInjectionOf struct {
	Schema      string `json:"schema"`
	UnitID      string `json:"unit_id"`
	WallTS      string `json:"wall_ts"`
	SimTS       string `json:"sim_ts"`
	Event       string `json:"event"`
	InstanceID  string `json:"instance_id"`
	InjectionID string `json:"injection_id"`
	FaultID     string `json:"fault_id"`
	Params      struct {
		Magnitude      float64 `json:"magnitude"`
		DurationSimMin int     `json:"duration_sim_min"`
	} `json:"params"`
	EndsSimTS string `json:"ends_sim_ts"`
	Reason    string `json:"reason"`
}

// gtActiveOf is the retained list of running instances.
type gtActiveOf struct {
	Schema string `json:"schema"`
	SimTS  string `json:"sim_ts"`
	Active []struct {
		InstanceID   string `json:"instance_id"`
		InjectionID  string `json:"injection_id"`
		FaultID      string `json:"fault_id"`
		StartedSimTS string `json:"started_sim_ts"`
		EndsSimTS    string `json:"ends_sim_ts"`
		Params       struct {
			Magnitude      float64 `json:"magnitude"`
			DurationSimMin int     `json:"duration_sim_min"`
		} `json:"params"`
	} `json:"active"`
}

// gtMarkerOf is one replay marker.
type gtMarkerOf struct {
	Schema    string `json:"schema"`
	UnitID    string `json:"unit_id"`
	Kind      string `json:"kind"`
	SimTSFrom string `json:"sim_ts_from"`
	SimTSTo   string `json:"sim_ts_to"`
	PresetID  string `json:"preset_id"`
}

// decodeGt reads one ground-truth message into target.
func decodeGt[T any](t *testing.T, payload []byte) T {
	t.Helper()

	var out T
	require.NoError(t, json.Unmarshal(payload, &out), "the message is not JSON: %s", payload)
	return out
}

// groundTruthDocuments resolves packages/ground-truth/data — the documents the
// simulator forwards in production — and reports whether it is in the
// checkout. The fixtures under services/modbus/testdata/gt are cut down for
// the offline tests and do not satisfy the forwarded documents' own schemas,
// so anything that validates a catalog reads the real ones. They live outside
// the Go module and are resolved four levels up, exactly as schematest
// resolves the schemas beside them.
func groundTruthDocuments() (string, bool) {
	dir, err := filepath.Abs(filepath.Join("..", "..", "..", "..", "packages", "ground-truth", "data"))
	if err != nil {
		return "", false
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return "", false
	}
	return dir, true
}

// groundTruthDataDir is groundTruthDocuments for a test that cannot run
// without them.
func groundTruthDataDir(t *testing.T) string {
	t.Helper()

	dir, ok := groundTruthDocuments()
	if !ok {
		t.Skip("no packages/ground-truth/data in this checkout")
	}
	return dir
}

func TestGtCatalogIsRetainedAndCarriesTheMenu(t *testing.T) {
	t.Parallel()

	c := newControl(t, controlOpts{})
	published := c.seen.await(t, c.topics.GtCatalog(), 1, budget(t, deliveryBudget))
	catalog := decodeGt[gtCatalogOf](t, published[0].payload)

	assert.Equal(t, mqttio.SchemaID("gt-catalog"), catalog.Schema)
	assert.Equal(t, mqttio.DefaultUnitID, catalog.UnitID)
	assert.Equal(t, wallStart, catalog.WallTS)
	assert.Equal(t, datasetFirst, catalog.Dataset.FirstTS)
	assert.Equal(t, datasetLast, catalog.Dataset.LastTS)
	assert.Equal(t, datasetRows, catalog.Dataset.Rows)
	assert.Equal(t, 0, catalog.Dataset.Gaps, "the synthetic recording has no hole")

	require.Len(t, catalog.Injections, 1)
	entry := catalog.Injections[0]
	assert.Equal(t, "hot_oil", entry.InjectionID)
	assert.Equal(t, "oil_cooler_fouled", entry.FaultID)
	assert.NotEmpty(t, entry.Label)
	assert.NotEmpty(t, entry.Description)
	assert.Equal(t, 60, entry.DefaultDurationSimMin)
	require.Len(t, entry.Params, 1)
	assert.Equal(t, injection.MagnitudeParam, entry.Params[0].Name)
	assert.NotContains(t, string(published[0].payload), "transforms",
		"the overlay itself stays inside the machine")

	// The two documents packages/ground-truth owns travel byte-for-byte, only
	// compacted.
	assert.JSONEq(t, readFixture(t, "gt/presets.json"), string(catalog.Presets))
	assert.JSONEq(t, readFixture(t, "gt/metropt3-failures.json"), string(catalog.Failures))

	// A subscriber that arrives later reads it from the retained store.
	late := newCollector()
	client := c.connect(t, "fdp-late-catalog", nil)
	require.NoError(t, client.Subscribe(c.ctx(t), c.topics.GtCatalog(), 1, late.handle))

	retained := late.await(t, c.topics.GtCatalog(), 1, budget(t, deliveryBudget))
	assert.True(t, retained[0].retain, "the catalog is delivered from the retained store")
	assert.JSONEq(t, string(published[0].payload), string(retained[0].payload))
}

// readFixture returns the contents of one file under services/modbus/testdata.
func readFixture(t *testing.T, name string) string {
	t.Helper()

	raw, err := os.ReadFile(testutil.FixturePath(t, name))
	require.NoError(t, err)
	return string(raw)
}

func TestGtCatalogIsRepublishedAfterAReconnect(t *testing.T) {
	t.Parallel()

	c := newControl(t, controlOpts{})
	require.Len(t, c.seen.on(c.topics.GtCatalog()), 1)

	// The broker restarts on the same port: every session, subscription and
	// retained message is gone, which is exactly the case the republication on
	// connection-up exists for.
	testutil.RestartEmbeddedBroker(t, c.url)

	published := c.seen.await(t, c.topics.GtCatalog(), 2, budget(t, 30*time.Second))
	assert.JSONEq(t, string(published[0].payload), string(published[1].payload))

	active := c.seen.await(t, c.topics.GtInjectionActive(), 2, budget(t, 30*time.Second))
	assert.Empty(t, decodeGt[gtActiveOf](t, active[1].payload).Active,
		"the empty list is sent again, so a reader never inherits a stale one")

	// The command subscription came back with it.
	_, _ = c.command(cmdIDOne, "pause", `{}`)
	assert.Equal(t, sim.StatePaused, c.engine.Snapshot().State)
}

func TestGtInjectionStartIsAnnouncedWithTheActiveList(t *testing.T) {
	t.Parallel()

	c := newControl(t, controlOpts{})
	require.Len(t, c.seen.on(c.topics.GtInjectionActive()), 1, "the empty list on connect")

	_, _ = c.command(cmdIDOne, "inject", `{"injection_id":"hot_oil","params":{"magnitude":1.5}}`)

	events := c.seen.await(t, c.topics.GtInjection(), 1, budget(t, deliveryBudget))
	start := decodeGt[gtInjectionOf](t, events[0].payload)
	assert.Equal(t, mqttio.SchemaID("gt-injection"), start.Schema)
	assert.Equal(t, "start", start.Event)
	assert.Equal(t, "inj-aaaaaa-1", start.InstanceID)
	assert.Equal(t, "hot_oil", start.InjectionID)
	assert.Equal(t, "oil_cooler_fouled", start.FaultID)
	assert.InDelta(t, 1.5, start.Params.Magnitude, 1e-9)
	assert.Equal(t, 60, start.Params.DurationSimMin)
	assert.Equal(t, datasetFirst, start.SimTS)
	assert.Equal(t, "2020-02-01T01:00:00.000Z", start.EndsSimTS)
	assert.Empty(t, start.Reason, "a start carries no reason")
	assert.False(t, events[0].retain, "an event describes an instant and is not retained")

	lists := c.seen.await(t, c.topics.GtInjectionActive(), 2, budget(t, deliveryBudget))
	active := decodeGt[gtActiveOf](t, lists[1].payload)
	require.Len(t, active.Active, 1)
	assert.Equal(t, "inj-aaaaaa-1", active.Active[0].InstanceID)
	assert.Equal(t, "hot_oil", active.Active[0].InjectionID)
	assert.Equal(t, "oil_cooler_fouled", active.Active[0].FaultID)
	assert.Equal(t, datasetFirst, active.Active[0].StartedSimTS)
	assert.Equal(t, "2020-02-01T01:00:00.000Z", active.Active[0].EndsSimTS)
	assert.InDelta(t, 1.5, active.Active[0].Params.Magnitude, 1e-9)

	// The list is retained, so a reader that connects while the overlay runs
	// learns about it without waiting for the next change.
	late := newCollector()
	client := c.connect(t, "fdp-late-active", nil)
	require.NoError(t, client.Subscribe(c.ctx(t), c.topics.GtInjectionActive(), 1, late.handle))

	retained := late.await(t, c.topics.GtInjectionActive(), 1, budget(t, deliveryBudget))
	assert.True(t, retained[0].retain, "the list is delivered from the retained store")
	assert.JSONEq(t, string(lists[1].payload), string(retained[0].payload))
}

func TestGtInjectionExpiresOnItsOwnDuration(t *testing.T) {
	t.Parallel()

	// A one-minute instance at 3600x expires inside the first tenth of a
	// wall-clock second of replay.
	c := newControl(t, controlOpts{
		Speed:   sim.MaxSpeed,
		Catalog: testCatalog(t, offsetDefinition("hot_oil", "oil_temperature", 14, 1)),
	})
	_, _ = c.command(cmdIDOne, "inject", `{"injection_id":"hot_oil"}`)
	_, _ = c.command(cmdIDTwo, "play", `{}`)
	c.waitTimers(2)

	c.clock.Advance(100 * time.Millisecond)

	events := c.seen.await(t, c.topics.GtInjection(), 2, budget(t, deliveryBudget))
	stop := decodeGt[gtInjectionOf](t, events[1].payload)
	assert.Equal(t, "stop", stop.Event)
	assert.Equal(t, "inj-aaaaaa-1", stop.InstanceID)
	assert.Equal(t, string(injection.ReasonExpired), stop.Reason)
	assert.Equal(t, "2020-02-01T00:01:00.000Z", stop.SimTS, "it stops at the first row past its end")
	assert.Equal(t, "2020-02-01T00:01:00.000Z", stop.EndsSimTS)

	lists := c.seen.await(t, c.topics.GtInjectionActive(), 3, budget(t, deliveryBudget))
	assert.Empty(t, decodeGt[gtActiveOf](t, lists[len(lists)-1].payload).Active,
		"an empty list clears the overlay")
}

func TestGtJumpStopsTheInjectionAndMarksTheDiscontinuity(t *testing.T) {
	t.Parallel()

	c := newControl(t, controlOpts{Presets: midPreset()})
	_, _ = c.command(cmdIDOne, "inject", `{"injection_id":"hot_oil"}`)
	c.seen.await(t, c.topics.GtInjection(), 1, budget(t, deliveryBudget))

	_, _ = c.command(cmdIDTwo, "jump", `{"preset_id":"fixture_mid"}`)

	events := c.seen.await(t, c.topics.GtInjection(), 2, budget(t, deliveryBudget))
	stop := decodeGt[gtInjectionOf](t, events[1].payload)
	assert.Equal(t, "stop", stop.Event)
	assert.Equal(t, string(injection.ReasonJump), stop.Reason)
	assert.Equal(t, datasetFirst, stop.SimTS,
		"the instance stopped where the machine was, not where the jump sent it")

	markers := c.seen.await(t, c.topics.GtMarker(), 1, budget(t, deliveryBudget))
	marker := decodeGt[gtMarkerOf](t, markers[0].payload)
	assert.Equal(t, mqttio.SchemaID("gt-marker"), marker.Schema)
	assert.Equal(t, "jump", marker.Kind)
	assert.Equal(t, datasetFirst, marker.SimTSFrom)
	assert.Equal(t, "2020-02-01T00:11:40.000Z", marker.SimTSTo)
	assert.Equal(t, "fixture_mid", marker.PresetID)
	assert.False(t, markers[0].retain)

	lists := c.seen.await(t, c.topics.GtInjectionActive(), 3, budget(t, deliveryBudget))
	assert.Empty(t, decodeGt[gtActiveOf](t, lists[len(lists)-1].payload).Active)
}

func TestGtClearInjectionsStopsEveryInstance(t *testing.T) {
	t.Parallel()

	c := newControl(t, controlOpts{})
	_, _ = c.command(cmdIDOne, "inject", `{"injection_id":"hot_oil"}`)
	c.seen.await(t, c.topics.GtInjection(), 1, budget(t, deliveryBudget))

	_, _ = c.command(cmdIDTwo, "clear_injections", `{}`)

	events := c.seen.await(t, c.topics.GtInjection(), 2, budget(t, deliveryBudget))
	stop := decodeGt[gtInjectionOf](t, events[1].payload)
	assert.Equal(t, "stop", stop.Event)
	assert.Equal(t, string(injection.ReasonCleared), stop.Reason)

	lists := c.seen.await(t, c.topics.GtInjectionActive(), 3, budget(t, deliveryBudget))
	assert.Empty(t, decodeGt[gtActiveOf](t, lists[len(lists)-1].payload).Active)
	assert.Empty(t, c.seen.on(c.topics.GtMarker()), "clearing is not a discontinuity")
}

func TestGtResetMarksTheReturnAndStopsTheInjection(t *testing.T) {
	t.Parallel()

	c := newControl(t, controlOpts{Speed: 60, Autoplay: true})
	c.waitTimers(2)
	_, _ = c.command(cmdIDOne, "inject", `{"injection_id":"hot_oil"}`)
	c.clock.Advance(sim.StatusInterval)
	c.waitTimers(2)

	_, _ = c.command(cmdIDTwo, "reset", `{}`)

	events := c.seen.await(t, c.topics.GtInjection(), 2, budget(t, deliveryBudget))
	stop := decodeGt[gtInjectionOf](t, events[1].payload)
	assert.Equal(t, "stop", stop.Event)
	assert.Equal(t, string(injection.ReasonReset), stop.Reason)

	markers := c.seen.await(t, c.topics.GtMarker(), 1, budget(t, deliveryBudget))
	marker := decodeGt[gtMarkerOf](t, markers[0].payload)
	assert.Equal(t, "reset", marker.Kind)
	assert.Equal(t, "2020-02-01T00:01:00.000Z", marker.SimTSFrom)
	assert.Equal(t, datasetFirst, marker.SimTSTo)
	assert.Empty(t, marker.PresetID, "a reset names no preset")
	assert.Equal(t, sim.StatePaused, c.engine.Snapshot().State, "a reset leaves the machine paused")
}

func TestGtMarksTheLoopWrap(t *testing.T) {
	t.Parallel()

	// Twelve rows of ten seconds is 110 s of recording, which one wall-clock
	// second at 3600x runs past three times over.
	c := newControl(t, controlOpts{Rows: 12, Speed: sim.MaxSpeed, Autoplay: true, Loop: true})
	c.waitTimers(2)

	c.clock.Advance(100 * time.Millisecond)

	markers := c.seen.await(t, c.topics.GtMarker(), 1, budget(t, deliveryBudget))
	marker := decodeGt[gtMarkerOf](t, markers[0].payload)
	assert.Equal(t, "loop", marker.Kind)
	assert.Equal(t, datasetFirst, marker.SimTSTo, "a wrap returns to the first row")
	assert.Empty(t, marker.PresetID)
}

func TestLoadGtDocumentsRejectsWhatItCannotForward(t *testing.T) {
	t.Parallel()

	good := readFixture(t, "gt/presets.json")

	tests := []struct {
		name     string
		presets  *string
		failures *string
		want     string
	}{
		{name: "a missing presets file", presets: nil, failures: &good, want: "presets.json"},
		{name: "a missing failure table", presets: &good, failures: nil, want: "metropt3-failures.json"},
		{name: "a presets file that is not JSON", presets: ptr("{"), failures: &good, want: "presets.json"},
		{name: "a failure table that is not an object", presets: &good, failures: ptr("[]"), want: "metropt3-failures.json"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			dir := t.TempDir()
			if tc.presets != nil {
				require.NoError(t, os.WriteFile(filepath.Join(dir, sim.PresetsFile), []byte(*tc.presets), 0o600))
			}
			if tc.failures != nil {
				require.NoError(t, os.WriteFile(filepath.Join(dir, sim.FailuresFile), []byte(*tc.failures), 0o600))
			}

			_, err := sim.LoadGtDocuments(sim.Config{GTDir: dir})
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.want)
		})
	}
}

// ptr returns a pointer to v, for the table above.
func ptr[T any](v T) *T { return &v }

func TestNewGtPublisherRejectsAnIncompleteConfiguration(t *testing.T) {
	t.Parallel()

	documents, err := sim.LoadGtDocuments(sim.Config{GTDir: testutil.TestdataPath("gt")})
	require.NoError(t, err)
	catalog := testCatalog(t, offsetDefinition("hot_oil", "oil_temperature", 14, 60))
	complete := sim.GtConfig{
		UnitID: mqttio.DefaultUnitID, Clock: sim.RealClock{},
		Documents: documents, Catalog: catalog,
	}

	tests := []struct {
		name    string
		corrupt func(*sim.GtConfig)
	}{
		{"no unit id", func(cfg *sim.GtConfig) { cfg.UnitID = "" }},
		{"no clock", func(cfg *sim.GtConfig) { cfg.Clock = nil }},
		{"no catalog", func(cfg *sim.GtConfig) { cfg.Catalog = nil }},
		{"no presets", func(cfg *sim.GtConfig) { cfg.Documents.Presets = nil }},
		{"no failure table", func(cfg *sim.GtConfig) { cfg.Documents.Failures = nil }},
		{"a negative gap count", func(cfg *sim.GtConfig) { cfg.Gaps = -1 }},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			cfg := complete
			tc.corrupt(&cfg)
			_, err := sim.NewGtPublisher(cfg)
			assert.Error(t, err)
		})
	}
}

func TestSchemaGroundTruthMessagesValidate(t *testing.T) {
	t.Parallel()

	schematest.MustSchemaDir(t)

	// The catalog forwards the presets and the failure table verbatim, so it
	// only validates against gt-catalog with the documents
	// packages/ground-truth actually ships.
	c := newControl(t, controlOpts{Presets: midPreset(), GTDir: groundTruthDataDir(t)})

	retained := c.seen.await(t, c.topics.GtCatalog(), 1, budget(t, deliveryBudget))
	schematest.Validate(t, "gt-catalog", retained[0].payload)

	_, _ = c.command(cmdIDOne, "inject", `{"injection_id":"hot_oil","params":{"duration_sim_min":30}}`)
	c.seen.await(t, c.topics.GtInjection(), 1, budget(t, deliveryBudget))
	_, _ = c.command(cmdIDTwo, "jump", `{"preset_id":"fixture_mid"}`)

	events := c.seen.await(t, c.topics.GtInjection(), 2, budget(t, deliveryBudget))
	for _, message := range events {
		schematest.Validate(t, "gt-injection", message.payload)
	}
	for _, message := range c.seen.await(t, c.topics.GtInjectionActive(), 3, budget(t, deliveryBudget)) {
		schematest.Validate(t, "gt-injection-active", message.payload)
	}
	for _, message := range c.seen.await(t, c.topics.GtMarker(), 1, budget(t, deliveryBudget)) {
		schematest.Validate(t, "gt-marker", message.payload)
	}
}
