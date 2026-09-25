// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package mqttio_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/mqttio"
	"fault-diagnosis-poc/services/modbus/internal/schematest"
)

func TestSchemaID(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "urn:fdp:schema:telemetry-samples:v1", mqttio.SchemaID("telemetry-samples"))
	assert.Equal(t, "urn:fdp:schema:gt-marker:v1", mqttio.SchemaID("gt-marker"))
}

// TestWallTSIsUTCWithMilliseconds is the envelope's timestamp rule: ISO-8601,
// UTC, three fractional digits, a trailing Z.
func TestWallTSIsUTCWithMilliseconds(t *testing.T) {
	t.Parallel()

	// A summer instant in a zone two hours ahead of UTC: the formatter has to
	// convert, not merely relabel.
	zone := time.FixedZone("UTC+2", 2*60*60)
	instant := time.Date(2020, 6, 1, 14, 30, 15, 250_000_000, zone)

	assert.Equal(t, "2020-06-01T12:30:15.250Z", mqttio.WallTS(instant))
}

func TestWallTSKeepsTrailingZerosInTheFraction(t *testing.T) {
	t.Parallel()

	whole := time.Date(2020, 2, 1, 0, 0, 0, 0, time.UTC)
	assert.Equal(t, "2020-02-01T00:00:00.000Z", mqttio.WallTS(whole))

	oneMilli := time.Date(2020, 2, 1, 0, 0, 0, 1_000_000, time.UTC)
	assert.Equal(t, "2020-02-01T00:00:00.001Z", mqttio.WallTS(oneMilli))
}

// TestWallTSTruncatesBelowTheMillisecond documents that sub-millisecond
// precision is dropped rather than rounded, which is what Go's formatter does
// and what keeps a formatted timestamp equal to the epoch milliseconds the
// registers carry.
func TestWallTSTruncatesBelowTheMillisecond(t *testing.T) {
	t.Parallel()

	instant := time.Date(2020, 2, 1, 0, 0, 0, 1_999_999, time.UTC)
	assert.Equal(t, "2020-02-01T00:00:00.001Z", mqttio.WallTS(instant))
}

func TestSimTSFormatsEpochMilliseconds(t *testing.T) {
	t.Parallel()

	// 2020-02-01T00:00:00.000Z, the first instant of the dataset.
	const datasetStart uint64 = 1580515200000

	assert.Equal(t, "2020-02-01T00:00:00.000Z", mqttio.SimTS(datasetStart))
	assert.Equal(t, "2020-02-01T00:00:00.123Z", mqttio.SimTS(datasetStart+123))
	assert.Equal(t, "1970-01-01T00:00:00.000Z", mqttio.SimTS(0))
}

// TestParseTSRoundTrips is the property the gateway and the evaluation harness
// rely on: what SimTS wrote, ParseTS reads back unchanged.
func TestParseTSRoundTrips(t *testing.T) {
	t.Parallel()

	for _, ms := range []uint64{0, 1, 999, 1580515200000, 1598932800000} {
		parsed, err := mqttio.ParseTS(mqttio.SimTS(ms))
		require.NoError(t, err)
		assert.Equal(t, ms, parsed)
	}
}

func TestParseTSAcceptsRFC3339Variants(t *testing.T) {
	t.Parallel()

	cases := map[string]struct {
		input string
		want  uint64
	}{
		"milliseconds and Z": {"2020-02-01T00:00:00.500Z", 1580515200500},
		"no fraction":        {"2020-02-01T00:00:00Z", 1580515200000},
		"microseconds":       {"2020-02-01T00:00:00.500999Z", 1580515200500},
		"positive offset":    {"2020-02-01T02:00:00.000+02:00", 1580515200000},
		"negative offset":    {"2020-01-31T22:00:00.000-02:00", 1580515200000},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			got, err := mqttio.ParseTS(tc.input)
			require.NoError(t, err)
			assert.Equal(t, tc.want, got)
		})
	}
}

// TestEnvelopeSatisfiesTheContract runs the helpers' own output through the
// generated JSON Schema: the "schema" field has to be the $id the contract
// declares, and the timestamps have to match the iso_ts pattern of
// common.schema.json. It skips in a checkout without the contracts.
func TestEnvelopeSatisfiesTheContract(t *testing.T) {
	t.Parallel()

	marker := map[string]string{
		"schema":      mqttio.SchemaID("gt-marker"),
		"unit_id":     mqttio.DefaultUnitID,
		"wall_ts":     mqttio.WallTS(time.Date(2026, 9, 20, 10, 0, 0, 0, time.UTC)),
		"kind":        "jump",
		"sim_ts_from": mqttio.SimTS(1580515200000),
		"sim_ts_to":   mqttio.SimTS(1583020800000),
	}
	payload, err := json.Marshal(marker)
	require.NoError(t, err)

	schematest.Validate(t, "gt-marker", payload)
}

func TestParseTSRejectsWhatIsNotATimestamp(t *testing.T) {
	t.Parallel()

	for _, input := range []string{"", "2020-02-01", "not a timestamp", "1580515200000", "1969-12-31T23:59:59Z"} {
		_, err := mqttio.ParseTS(input)
		assert.Error(t, err, "input %q", input)
	}
}
