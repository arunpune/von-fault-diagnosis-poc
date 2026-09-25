// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Entry point: one QueryClient per page load, the live feed, the shared providers, and the page.

import { QueryClient } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "@/App";
import { startLiveFeed } from "@/api/live-feed";
import { AppProviders } from "@/components/app-shell/AppProviders";
import "@/index.css";
// Registers the recorder's frame handlers before the first frame can arrive.
import "@/store/telemetry-store";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

// The one WsClient, started once per page load and outside React (advanced-init-once rule),
// before the first render; on every open it re-reads GET /api/status, invalidates the queries of
// `queryClient` and dispatches `link.open`.
startLiveFeed({ queryClient });

const container = document.getElementById("root");
if (container === null) {
  throw new Error("index.html has no #root element");
}

createRoot(container).render(
  <StrictMode>
    <AppProviders queryClient={queryClient}>
      <App />
    </AppProviders>
  </StrictMode>,
);
