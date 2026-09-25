// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { REDACTED } from "../config/secret.ts";
import { loadOverlayConfig, OverlayConfigError } from "./config.ts";

describe("loadOverlayConfig", () => {
  it("composes the overlay connection from the parts Compose passes", () => {
    const config = loadOverlayConfig({
      UNIT_ID: "cau-7",
      PG_HOST: "postgres",
      PG_PORT: "5432",
      POSTGRES_DB: "fdp",
      PG_GT_PASSWORD: "overlay-password",
      MQTT_URL: "mqtt://mqtt:1883",
      MQTT_BACKEND_OPS_PASSWORD: "ops-password",
    });
    expect(config.unitId).toBe("cau-7");
    expect(config.db).toMatchObject({ host: "postgres", port: 5432, database: "fdp" });
    expect(config.db.url).toBeUndefined();
    expect(config.db.password.reveal()).toBe("overlay-password");
    expect(config.mqtt.url).toBe("mqtt://mqtt:1883");
    expect(config.mqtt.password.reveal()).toBe("ops-password");
  });

  it("falls back to the Compose defaults on an empty environment", () => {
    const config = loadOverlayConfig({});
    expect(config.unitId).toBe("cau-7");
    expect(config.db).toMatchObject({ host: "localhost", port: 5432, database: "fdp" });
    expect(config.mqtt.url).toBe("mqtt://mqtt:1883");
  });

  it("treats an empty interpolation as an unset variable", () => {
    const config = loadOverlayConfig({ PG_HOST: "", PG_PORT: "  ", DATABASE_URL_GT: "" });
    expect(config.db.host).toBe("localhost");
    expect(config.db.port).toBe(5432);
    expect(config.db.url).toBeUndefined();
  });

  it("leaves a missing credential empty, for the caller to refuse by name", () => {
    const config = loadOverlayConfig({});
    expect(config.mqtt.password.isEmpty).toBe(true);
    expect(config.db.password.isEmpty).toBe(true);
  });

  it("prefers the development override of the connection string", () => {
    const config = loadOverlayConfig({ DATABASE_URL_GT: "postgres://elsewhere/db" });
    expect(config.db.url?.reveal()).toBe("postgres://elsewhere/db");
  });

  it("names the variable that is not a port", () => {
    expect(() => loadOverlayConfig({ PG_PORT: "70000" })).toThrow(OverlayConfigError);
    expect(() => loadOverlayConfig({ PG_PORT: "one" })).toThrow(/PG_PORT/);
  });

  it("carries both credentials wrapped, so neither can be printed", () => {
    const config = loadOverlayConfig({
      PG_GT_PASSWORD: "overlay-password",
      MQTT_BACKEND_OPS_PASSWORD: "ops-password",
      DATABASE_URL_GT: "postgres://user:overlay-password@host/db",
    });
    const printed = JSON.stringify(config);
    expect(printed).not.toContain("overlay-password");
    expect(printed).not.toContain("ops-password");
    expect(String(config.mqtt.password)).toBe(REDACTED);
  });
});
