// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Command modbus-sim is the CAU-7 machine: a read-only Modbus TCP device that
// replays MetroPT-3 rows into a ring buffer, evaluates the CTRL-7 alarms and
// applies fault-injection overlays (docs/simulation.md).
//
// Subcommands:
//
//	run                              replay and serve; the default
//	probe                            GET /healthz on 127.0.0.1:$SIM_HTTP_PORT
//	index --csv PATH                 report the bounds, rows and gaps of a file
//	dump  --csv PATH --from TS --n N print N rows from an instant as JSON lines
//
// `run` needs the broker: it takes its commands on plant/<unit>/control/cmd
// and is the only publisher of the ground truth under gt/<unit>/. An
// unreachable MQTT_URL is therefore a startup failure, not a degraded mode,
// and /healthz reports mqtt_connected=false while the first connection is
// still being attempted.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"fault-diagnosis-poc/services/modbus/internal/ctrl7"
	"fault-diagnosis-poc/services/modbus/internal/injection"
	"fault-diagnosis-poc/services/modbus/internal/mqttio"
	"fault-diagnosis-poc/services/modbus/internal/regmap"
	"fault-diagnosis-poc/services/modbus/internal/replay"
	"fault-diagnosis-poc/services/modbus/internal/sim"
)

// Exit statuses. Anything the operator can act on is 1; a misuse of the
// command line is 2, which is what a shell expects from bad arguments.
const (
	exitOK    = 0
	exitError = 1
	exitUsage = 2
)

// probeTimeout is the budget of the health request `probe` performs.
const probeTimeout = 2 * time.Second

// connectTimeout bounds the first connection to the broker. A broker that is
// still starting is not a failure — Compose brings the two up together — but a
// URL nothing answers on is, and a minute is long enough to tell them apart.
// The health endpoint is already serving while this runs, so an orchestrator
// sees mqtt_connected=false rather than a refused connection.
const connectTimeout = 60 * time.Second

// shutdownTimeout bounds the orderly disconnect after a signal.
const shutdownTimeout = 5 * time.Second

// gapsPrinted is how many gaps `index` lists before it stops; the full file
// has 331 of them and the first few are what a reader wants.
const gapsPrinted = 10

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

// run dispatches one subcommand. It returns the exit status instead of
// calling os.Exit so the whole command line is testable.
func run(args []string, stdout, stderr io.Writer) int {
	name := "run"
	if len(args) > 0 && !isFlag(args[0]) {
		name, args = args[0], args[1:]
	}

	var err error
	switch name {
	case "run":
		err = runSimulator(args, stderr)
	case "probe":
		err = runProbe(args)
	case "index":
		err = runIndex(args, stdout)
	case "dump":
		err = runDump(args, stdout)
	case "help", "-h", "--help":
		out := &printer{w: stdout}
		out.usage()
		return exitOK
	default:
		out := &printer{w: stderr}
		out.printf("modbus-sim: %q is not a subcommand\n\n", name)
		out.usage()
		return exitUsage
	}

	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return exitUsage
		}
		_, _ = fmt.Fprintf(stderr, "modbus-sim: %v\n", err)
		return exitError
	}
	return exitOK
}

// isFlag reports whether an argument is a flag rather than a subcommand.
func isFlag(arg string) bool { return len(arg) > 1 && arg[0] == '-' }

// printer writes a report line by line and remembers the first write error, so
// a closed pipe is reported once at the end rather than checked at every line.
type printer struct {
	w   io.Writer
	err error
}

// printf writes one line unless an earlier one already failed.
func (p *printer) printf(format string, args ...any) {
	if p.err != nil {
		return
	}
	_, p.err = fmt.Fprintf(p.w, format, args...)
}

// usage prints the subcommand list.
func (p *printer) usage() {
	p.printf(`usage: modbus-sim <command> [flags]

  run                                    replay the recording and serve it (default)
  probe                                  check %s on 127.0.0.1:$SIM_HTTP_PORT
  index --csv PATH                       report the bounds, rows and gaps of a CSV
  dump  --csv PATH --from TS [--n N]     print rows from an instant as JSON lines

The environment is documented in docs/simulation.md.
`, sim.HealthPath)
}

// newLogger builds the process logger.
func newLogger(w io.Writer, level slog.Level) *slog.Logger {
	return slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{Level: level}))
}

// runSimulator is the `run` subcommand: index the CSV, start the register
// store, the Modbus listener, the health endpoint, the broker session and the
// replay engine, and keep going until SIGINT or SIGTERM.
func runSimulator(args []string, stderr io.Writer) error {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	fs.SetOutput(stderr)
	if err := fs.Parse(args); err != nil {
		return err
	}

	started := time.Now()
	cfg, err := sim.LoadConfig(os.Getenv)
	if err != nil {
		return err
	}
	log := newLogger(stderr, cfg.LogLevel)
	cfg.Logger = log

	if cfg.Presets, err = sim.LoadPresets(cfg.PresetsPath()); err != nil {
		return err
	}
	catalog, err := injection.LoadCatalog(cfg.InjectionsPath(), regmap.Signals)
	if err != nil {
		return err
	}
	documents, err := sim.LoadGtDocuments(cfg)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	log.Info("starting the machine", slog.Any("config", cfg))

	// The health endpoint comes up before the index pass so an orchestrator
	// sees 503 rather than a refused connection while the CSV is read (Compose
	// gives the healthcheck a 60 s start period).
	store := sim.NewStore()
	server, err := sim.NewServer(sim.ServerConfig{
		Bind:       cfg.ModbusBind,
		Port:       cfg.ModbusPort,
		MaxClients: cfg.MaxClients,
		Logger:     log,
	}, store)
	if err != nil {
		return err
	}

	// The health endpoint serves from its own goroutine from here on, while
	// this one is still building the engine and the control plane, so the two
	// it reads are published atomically rather than assigned into a variable
	// it would race with.
	var (
		engine  *sim.Engine
		serving struct {
			engine atomic.Pointer[sim.Engine]
			plane  atomic.Pointer[sim.ControlPlane]
		}
	)
	indexed := make(chan struct{})
	health, err := sim.NewHealthServer(cfg.HTTPPort, sim.Probes{
		CSVIndexed:      func() bool { return isClosed(indexed) },
		ModbusListening: server.Listening,
		// False until the broker session is up, which is what an orchestrator
		// watching the first connect attempt reads.
		MQTTConnected: func() bool {
			plane := serving.plane.Load()
			return plane != nil && plane.Connected()
		},
		Snapshot: func() sim.Snapshot {
			if running := serving.engine.Load(); running != nil {
				return running.Snapshot()
			}
			return sim.Snapshot{}
		},
	}, log)
	if err != nil {
		return err
	}
	if err := health.Start(); err != nil {
		return err
	}
	defer shutdownHealth(health, log)

	indexStarted := time.Now()
	source, err := replay.Open(cfg.CSVPath, regmap.Signals)
	if err != nil {
		return err
	}
	first, last, rows := source.Bounds()
	log.Info("indexed the recording",
		slog.String("csv", cfg.CSVPath),
		slog.Int("rows", rows),
		slog.String("first_sim_ts", mqttio.SimTS(first)),
		slog.String("last_sim_ts", mqttio.SimTS(last)),
		slog.Int("gaps", len(source.Gaps())),
		slog.Duration("took", time.Since(indexStarted)))
	close(indexed)

	alarms, err := ctrl7.New(regmap.Alarms, regmap.Signals)
	if err != nil {
		return err
	}
	engine, err = sim.New(cfg, source,
		injection.NewEngine(regmap.Signals, catalog), alarms, sim.RealClock{}, store)
	if err != nil {
		return err
	}
	defer func() {
		if err := engine.Close(); err != nil {
			log.Error("closing the replay cursor", slog.String("error", err.Error()))
		}
	}()
	serving.engine.Store(engine)

	gt, err := sim.NewGtPublisher(sim.GtConfig{
		UnitID:    cfg.UnitID,
		Clock:     sim.RealClock{},
		Documents: documents,
		Catalog:   catalog,
		Gaps:      len(source.Gaps()),
	})
	if err != nil {
		return err
	}
	status := sim.NewStatusPublisher(cfg.UnitID, sim.RealClock{}, started)
	plane, err := sim.NewControlPlane(sim.ControlPlaneConfig{
		Engine: engine,
		UnitID: cfg.UnitID,
		Clock:  sim.RealClock{},
		Status: status,
		GT:     gt,
		Logger: log,
	})
	if err != nil {
		return err
	}
	serving.plane.Store(plane)
	// The hooks are the only path to the ground-truth topics, so they are set
	// before the loop starts: a marker or an injection event the engine
	// reports with no hook attached is lost.
	engine.OnMarker, engine.OnInjection = plane.OnMarker, plane.OnInjection

	if err := server.Start(); err != nil {
		return err
	}
	defer func() {
		if err := server.Stop(); err != nil {
			log.Error("stopping the Modbus server", slog.String("error", err.Error()))
		}
	}()
	log.Info("serving the registers",
		slog.String("addr", server.Addr()),
		slog.Int("unit_id", int(sim.UnitID)),
		slog.String("health", health.Addr()))

	client, err := connectBroker(ctx, cfg, plane)
	if err != nil {
		return err
	}
	defer closeBroker(client, log)
	log.Info("connected to the broker",
		slog.String("mqtt_url", cfg.MQTTURL),
		slog.String("cmd_topic", plane.CmdTopic()),
		slog.String("ack_topic", plane.AckTopic()),
		slog.String("status_topic", status.Topic()),
		slog.String("gt_catalog_topic", gt.CatalogTopic()))

	var ticker sync.WaitGroup
	ticker.Add(1)
	go func() {
		defer ticker.Done()
		plane.Run(ctx)
	}()
	defer ticker.Wait()

	if err := engine.Run(ctx); err != nil {
		return err
	}
	log.Info("stopped", slog.Uint64("head_seq", uint64(engine.Snapshot().HeadSeq)))
	return nil
}

// connectBroker opens the simulator's one MQTT session and hands every
// connection to the control plane, which subscribes and republishes the
// retained documents on each one.
//
// A URL nothing answers on ends the process with a sentence that names it: the
// control plane is not optional, because without it the user interface cannot
// drive the machine.
func connectBroker(ctx context.Context, cfg sim.Config, plane *sim.ControlPlane) (*mqttio.Client, error) {
	connectCtx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()

	client, err := mqttio.Connect(connectCtx, mqttio.Config{
		URL:      cfg.MQTTURL,
		ClientID: clientID(),
		Username: sim.MQTTUsername,
		Password: cfg.MQTTPassword,
	}, func(c *mqttio.Client) { plane.ConnectionUp(c) })
	if err != nil {
		return nil, fmt.Errorf("the broker at %s did not answer within %s: %w",
			cfg.MQTTURL, connectTimeout, err)
	}
	return client, nil
}

// closeBroker disconnects cleanly on the way out. Nothing new is published:
// the retained status document stays as the last state the machine was really
// in.
func closeBroker(client *mqttio.Client, log *slog.Logger) {
	ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := client.Close(ctx); err != nil {
		log.Warn("closing the MQTT connection failed", slog.String("error", err.Error()))
	}
}

// clientID is the MQTT client identifier, "sim-<hostname>". A host without a
// name falls back to the process id, which is still unique inside one broker.
func clientID() string {
	host, err := os.Hostname()
	if err != nil || host == "" {
		host = strconv.Itoa(os.Getpid())
	}
	return sim.MQTTUsername + "-" + host
}

// isClosed reports whether a signalling channel has been closed.
func isClosed(ch <-chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

// shutdownHealth closes the health endpoint on the way out.
func shutdownHealth(health *sim.HealthServer, log *slog.Logger) {
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	if err := health.Shutdown(ctx); err != nil {
		log.Error("shutting down the health endpoint", slog.String("error", err.Error()))
	}
}

// runProbe is the `probe` subcommand, which the container healthcheck runs
// because the distroless image has no curl.
func runProbe(args []string) error {
	fs := flag.NewFlagSet("probe", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	if err := fs.Parse(args); err != nil {
		return err
	}

	port, err := healthPort()
	if err != nil {
		return err
	}
	return sim.ProbeHealth(context.Background(), port, probeTimeout)
}

// healthPort reads SIM_HTTP_PORT with its default.
func healthPort() (int, error) {
	raw := os.Getenv(sim.EnvHTTPPort)
	if raw == "" {
		return sim.DefaultHTTPPort, nil
	}
	port, err := strconv.Atoi(raw)
	if err != nil || port < 1 || port > 65535 {
		return 0, fmt.Errorf("%s is %q, not a port", sim.EnvHTTPPort, raw)
	}
	return port, nil
}

// runIndex is the `index` subcommand: the boot-time pass over a CSV, reported
// instead of replayed. CI runs it over the fixture as a sanity step.
func runIndex(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("index", flag.ContinueOnError)
	fs.SetOutput(stdout)
	csv := fs.String("csv", "", "the CSV to index; defaults to "+sim.EnvCSVPath)
	if err := fs.Parse(args); err != nil {
		return err
	}

	source, err := openSource(*csv)
	if err != nil {
		return err
	}
	first, last, rows := source.Bounds()
	gaps := source.Gaps()

	out := &printer{w: stdout}
	out.printf("rows: %d\n", rows)
	out.printf("first: %s\n", mqttio.SimTS(first))
	out.printf("last: %s\n", mqttio.SimTS(last))
	out.printf("index entries: %d\n", source.IndexLen())
	out.printf("gaps: %d\n", len(gaps))

	for i, gap := range gaps {
		if i == gapsPrinted {
			out.printf("  ... %d more\n", len(gaps)-gapsPrinted)
			break
		}
		out.printf("  %s -> %s (%d s)\n",
			mqttio.SimTS(gap.StartMs), mqttio.SimTS(gap.EndMs), gap.DurationMs()/1000)
	}
	return out.err
}

// dumpRow is one row of the `dump` output: the source values in SI units,
// plus the synthetic ambient temperature the machine would add to them, so
// what is printed is what the replay would emit before any overlay.
type dumpRow struct {
	SimTs   string             `json:"sim_ts"`
	Missing bool               `json:"missing"`
	Analog  map[string]float64 `json:"analog"`
	Digital map[string]bool    `json:"digital"`
}

// runDump is the `dump` subcommand: the rows a cursor reads at an instant, as
// JSON lines, for looking at what the replay would emit there.
func runDump(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("dump", flag.ContinueOnError)
	fs.SetOutput(stdout)
	csv := fs.String("csv", "", "the CSV to read; defaults to "+sim.EnvCSVPath)
	from := fs.String("from", "", "the first instant to print, ISO-8601 UTC")
	count := fs.Int("n", 10, "how many rows to print")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *count < 1 {
		return fmt.Errorf("--n is %d; there is nothing to print", *count)
	}

	source, err := openSource(*csv)
	if err != nil {
		return err
	}
	fromMs, _, _ := source.Bounds()
	if *from != "" {
		if fromMs, err = mqttio.ParseTS(*from); err != nil {
			return err
		}
	}

	cursor, err := source.Cursor()
	if err != nil {
		return err
	}
	defer func() { _ = cursor.Close() }()

	if err := cursor.Seek(fromMs); err != nil {
		return err
	}

	analogTags, digitalTags := source.AnalogTags(), source.DigitalTags()
	enc := json.NewEncoder(stdout)
	for range *count {
		row, err := cursor.Peek()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}

		out := dumpRow{
			SimTs:   mqttio.SimTS(row.SimTsMs),
			Missing: row.Missing,
			Analog:  make(map[string]float64, len(analogTags)+1),
			Digital: make(map[string]bool, len(digitalTags)),
		}
		for i, tag := range analogTags {
			out.Analog[tag] = row.Analog[i]
		}
		for i, tag := range digitalTags {
			out.Digital[tag] = row.Digital[i]
		}
		out.Analog["ambient_temperature"] = sim.Ambient(row.SimTsMs)

		if err := enc.Encode(out); err != nil {
			return err
		}
		cursor.Advance()
	}
	return nil
}

// openSource opens a CSV, falling back to METROPT_CSV and its default.
func openSource(path string) (*replay.Source, error) {
	if path == "" {
		cfg, err := sim.LoadConfig(os.Getenv)
		if err != nil {
			return nil, err
		}
		path = cfg.CSVPath
	}
	return replay.Open(path, regmap.Signals)
}
