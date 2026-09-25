// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package mqttio_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/mqttio"
	"fault-diagnosis-poc/services/modbus/internal/schematest"
)

// contractsDirEnv overrides where the generated contracts live; the default is
// packages/contracts seen from this package, four levels below the repository
// root.
const contractsDirEnv = "FDP_CONTRACTS_DIR"

const defaultContractsDir = "../../../../packages/contracts"

// topicsDoc is the part of packages/contracts/topics.json this test reads: the
// unit id every template is rendered with, the two roots and, per entry, the
// template with its `{unit_id}` placeholder and the schema it carries. QoS,
// retain, publisher and the acl block belong to packages/contracts and the
// broker configuration.
type topicsDoc struct {
	Roots         map[string]string `json:"roots"`
	DefaultUnitID string            `json:"default_unit_id"`
	Topics        map[string]struct {
		Template string `json:"template"`
		Schema   string `json:"schema"`
	} `json:"topics"`
}

// builders maps every entry of topics.json to the method that builds it.
func builders(topics mqttio.Topics) map[string]func() string {
	return map[string]func() string{
		"telemetry_samples":   topics.Telemetry,
		"control_cmd":         topics.ControlCmd,
		"control_ack":         topics.ControlAck,
		"status_sim":          topics.StatusSim,
		"status_gateway":      topics.StatusGateway,
		"status_backend":      topics.StatusBackend,
		"events_suspect":      topics.EventsSuspect,
		"decisions":           topics.Decisions,
		"alerts_ticket":       topics.AlertsTicket,
		"alerts_system":       topics.AlertsSystem,
		"gt_catalog":          topics.GtCatalog,
		"gt_injection":        topics.GtInjection,
		"gt_injection_active": topics.GtInjectionActive,
		"gt_marker":           topics.GtMarker,
	}
}

// TestTopicsMatchTheBaseline pins the literal topic strings for the unit the
// PoC simulates. This case never skips: the table is the contract even in a
// checkout without the generated files.
func TestTopicsMatchTheBaseline(t *testing.T) {
	t.Parallel()

	topics := mqttio.Topics{UnitID: mqttio.DefaultUnitID}
	require.Equal(t, "cau-7", mqttio.DefaultUnitID)

	assert.Equal(t, "plant/cau-7/telemetry/samples", topics.Telemetry())
	assert.Equal(t, "plant/cau-7/control/cmd", topics.ControlCmd())
	assert.Equal(t, "plant/cau-7/control/ack", topics.ControlAck())
	assert.Equal(t, "plant/cau-7/status/sim", topics.StatusSim())
	assert.Equal(t, "plant/cau-7/status/gateway", topics.StatusGateway())
	assert.Equal(t, "plant/cau-7/status/backend", topics.StatusBackend())
	assert.Equal(t, "plant/cau-7/events/suspect", topics.EventsSuspect())
	assert.Equal(t, "plant/cau-7/decisions", topics.Decisions())
	assert.Equal(t, "plant/cau-7/alerts/ticket", topics.AlertsTicket())
	assert.Equal(t, "plant/cau-7/alerts/system", topics.AlertsSystem())
	assert.Equal(t, "gt/cau-7/catalog", topics.GtCatalog())
	assert.Equal(t, "gt/cau-7/injection", topics.GtInjection())
	assert.Equal(t, "gt/cau-7/injection/active", topics.GtInjectionActive())
	assert.Equal(t, "gt/cau-7/marker", topics.GtMarker())
}

// TestTopicsMatchTheContract compares the builders with the file
// packages/contracts generates, so a change to the topic tree cannot land on
// one side only.
func TestTopicsMatchTheContract(t *testing.T) {
	t.Parallel()

	doc := readTopicsJSON(t)

	assert.Equal(t, mqttio.DefaultUnitID, doc.DefaultUnitID,
		"the contract's default unit id and mqttio.DefaultUnitID must agree")
	assert.Equal(t, mqttio.PlantRoot, doc.Roots["plant"])
	assert.Equal(t, mqttio.GtRoot, doc.Roots["gt"])

	topics := mqttio.Topics{UnitID: doc.DefaultUnitID}
	built := builders(topics)

	for key, entry := range doc.Topics {
		build, ok := built[key]
		if !assert.Truef(t, ok, "topics.json has %q but mqttio.Topics has no builder for it", key) {
			continue
		}
		want := renderTemplate(entry.Template, doc.DefaultUnitID)
		assert.Equalf(t, want, build(), "topic %q", key)
		assert.NotEmptyf(t, mqttio.SchemaID(entry.Schema), "topic %q carries no schema name", key)
	}

	// The other direction: no builder may describe a topic the contract does
	// not know about.
	var unknown []string
	for key := range built {
		if _, ok := doc.Topics[key]; !ok {
			unknown = append(unknown, key)
		}
	}
	sort.Strings(unknown)
	assert.Emptyf(t, unknown, "mqttio.Topics builds topics that topics.json does not declare: %v", unknown)
}

// TestTopicsBuildForAnyUnitID keeps the unit id a parameter: nothing in the
// builders is allowed to hard-code cau-7.
func TestTopicsBuildForAnyUnitID(t *testing.T) {
	t.Parallel()

	topics := mqttio.Topics{UnitID: "cau-9"}
	assert.Equal(t, "plant/cau-9/telemetry/samples", topics.Telemetry())
	assert.Equal(t, "gt/cau-9/injection/active", topics.GtInjectionActive())
}

// readTopicsJSON loads packages/contracts/topics.json, or skips when the
// contracts are not in the checkout — the same rule the schema helper follows.
func readTopicsJSON(t *testing.T) topicsDoc {
	t.Helper()

	dir := os.Getenv(contractsDirEnv)
	if dir == "" {
		dir = defaultContractsDir
	}
	path, err := filepath.Abs(filepath.Join(dir, "topics.json"))
	require.NoError(t, err)

	raw, err := os.ReadFile(path)
	if err != nil {
		if os.Getenv(schematest.RequireSchemasEnv) != "" {
			t.Fatalf("the generated contracts are required (%s is set) but %s is missing: %v",
				schematest.RequireSchemasEnv, path, err)
		}
		t.Skipf("no generated contracts at %s; run `make contracts`, or set %s=1 to make this a failure",
			path, schematest.RequireSchemasEnv)
	}

	var doc topicsDoc
	require.NoError(t, json.Unmarshal(raw, &doc), "parsing %s", path)
	require.NotEmpty(t, doc.Topics, "%s declares no topic", path)
	return doc
}

// renderTemplate substitutes the one placeholder the templates use.
func renderTemplate(template, unitID string) string {
	return strings.ReplaceAll(template, "{unit_id}", unitID)
}
