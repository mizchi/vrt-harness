import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  CraterBreakpointDiscoveryDiagnostics,
  CraterBreakpointDiscoveryResult,
} from "./crater-client.ts";
import {
  discoverResponsiveBreakpointsForHtmlDocuments,
  summarizeBreakpointDiscoveryDiagnostics,
  type BreakpointDiscoveryClient,
  type BreakpointDiscoveryDocumentInput,
} from "./migration-compare.ts";

function createDiagnostics(
  overrides: Partial<CraterBreakpointDiscoveryDiagnostics> = {},
): CraterBreakpointDiscoveryDiagnostics {
  return {
    stylesheetCount: 1,
    ruleCount: 1,
    externalStylesheetLinks: [],
    ignoredQueries: [],
    unsupportedQueries: [],
    ...overrides,
  };
}

function createMockClient(
  results: CraterBreakpointDiscoveryResult[],
): BreakpointDiscoveryClient {
  let index = 0;
  return {
    async connect() {},
    async close() {},
    async setContent() {},
    async getResponsiveBreakpoints() {
      return results[index++] ?? { breakpoints: [] };
    },
  };
}

describe("summarizeBreakpointDiscoveryDiagnostics", () => {
  it("should preserve per-document diagnostics and aggregate totals", () => {
    const summary = summarizeBreakpointDiscoveryDiagnostics([
      {
        label: "baseline",
        diagnostics: createDiagnostics({
          stylesheetCount: 1,
          ruleCount: 3,
          externalStylesheetLinks: ["/base.css"],
          ignoredQueries: ["print"],
          unsupportedQueries: ["(prefers-color-scheme: dark)"],
        }),
      },
      {
        label: "variant:modern-normalize.html",
        diagnostics: createDiagnostics({
          stylesheetCount: 2,
          ruleCount: 4,
          externalStylesheetLinks: ["/base.css", "/theme.css"],
          ignoredQueries: ["print", "speech"],
        }),
      },
    ]);

    assert.ok(summary);
    assert.deepEqual(
      summary.documents.map((entry) => entry.label),
      ["baseline", "variant:modern-normalize.html"],
    );
    assert.equal(summary.totals.stylesheetCount, 3);
    assert.equal(summary.totals.ruleCount, 7);
    assert.deepEqual(summary.totals.externalStylesheetLinks, ["/base.css", "/theme.css"]);
    assert.deepEqual(summary.totals.ignoredQueries, ["print", "speech"]);
    assert.deepEqual(summary.totals.unsupportedQueries, ["(prefers-color-scheme: dark)"]);
  });

  it("should return undefined when no diagnostics are available", () => {
    const summary = summarizeBreakpointDiscoveryDiagnostics([
      { label: "baseline", diagnostics: undefined },
      { label: "variant:modern-normalize.html", diagnostics: undefined },
    ]);

    assert.equal(summary, undefined);
  });
});

describe("discoverResponsiveBreakpointsForHtmlDocuments", () => {
  it("should include crater diagnostics in discovery status", async () => {
    const documents: BreakpointDiscoveryDocumentInput[] = [
      {
        label: "baseline",
        html: "<style>@media (min-width: 768px) { .card { display:block } }</style>",
      },
      {
        label: "variant:after.html",
        html: "<style>@media (max-width: 40rem) { .card { display:block } }</style>",
      },
    ];
    const mockClient = createMockClient([
      {
        breakpoints: [
          {
            axis: "width",
            op: "ge",
            valuePx: 768,
            raw: "(min-width: 768px)",
            normalized: "(width >= 768px)",
            guards: [],
            ruleCount: 1,
          },
        ],
        diagnostics: createDiagnostics({
          stylesheetCount: 1,
          ruleCount: 1,
          ignoredQueries: ["print"],
        }),
      },
      {
        breakpoints: [
          {
            axis: "width",
            op: "le",
            valuePx: 640,
            raw: "(max-width: 40rem)",
            normalized: "(width <= 640px)",
            guards: [],
            ruleCount: 1,
          },
        ],
        diagnostics: createDiagnostics({
          stylesheetCount: 2,
          ruleCount: 2,
          unsupportedQueries: ["(prefers-color-scheme: dark)"],
        }),
      },
    ]);

    const status = await discoverResponsiveBreakpointsForHtmlDocuments(
      documents,
      "crater",
      "ws://127.0.0.1:9222",
      () => mockClient,
    );

    assert.equal(status.backendUsed, "crater");
    assert.equal(status.breakpoints.length, 2);
    assert.ok(status.diagnostics);
    assert.deepEqual(
      status.diagnostics.documents.map((entry) => entry.label),
      ["baseline", "variant:after.html"],
    );
    assert.equal(status.diagnostics.totals.stylesheetCount, 3);
    assert.deepEqual(status.diagnostics.totals.ignoredQueries, ["print"]);
    assert.deepEqual(
      status.diagnostics.totals.unsupportedQueries,
      ["(prefers-color-scheme: dark)"],
    );
  });
});
