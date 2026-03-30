import { describe, expect, it } from "vitest";
import { buildSearchQueries, rawPathForSearch, toSearchSourceItem } from "./search.ts";

describe("buildSearchQueries", () => {
  it("keeps the opportunity title first and adds an evidence-grounded follow-up query", () => {
    const queries = buildSearchQueries(
      { title: "Finance Ops Opportunity", cluster_key: "finance-ops" },
      [
        {
          title: "Teams keep reconciling invoices by hand",
          text: "Manual invoice reconciliation across ERP and spreadsheets causes approval delays.",
        },
        {
          title: null,
          text: "People copy paste invoice data into spreadsheets and follow up by email.",
        },
      ],
    );

    expect(queries[0]).toBe("Finance Ops Opportunity");
    expect(queries.length).toBeGreaterThanOrEqual(2);
    expect(queries[1]).toContain("invoice");
  });

  it("falls back to a cluster query with pricing/alternatives angle when the title already covers the strong keywords", () => {
    const queries = buildSearchQueries(
      { title: "Invoice Reconciliation", cluster_key: "invoice-reconciliation" },
      [{ title: "Invoice reconciliation workflow", text: "Invoice reconciliation is painful." }],
    );

    expect(queries[0]).toBe("Invoice Reconciliation");
    expect(queries[1]).toContain("alternatives");
    expect(queries[1]).toContain("invoice-reconciliation".replace(/-/g, " "));
  });

  it("emits up to 3 queries including a market landscape angle", () => {
    const queries = buildSearchQueries(
      { title: "Finance Ops Opportunity", cluster_key: "finance-ops" },
      [
        { title: "Teams keep reconciling invoices by hand", text: "Manual invoice reconciliation." },
        { title: null, text: "People copy paste invoice data into spreadsheets." },
      ],
    );

    expect(queries.length).toBeGreaterThanOrEqual(2);
    expect(queries.length).toBeLessThanOrEqual(3);
  });
});

describe("rawPathForSearch", () => {
  it("writes under the search raw directory using the run id prefix", () => {
    const path = rawPathForSearch(42, "finance ops", new Date("2026-03-30T10:20:30Z"));

    expect(path).toContain("/data/raw/search/2026/03/30/");
    expect(path).toMatch(/\/42_[a-f0-9]{12}\.json$/);
  });
});

describe("toSearchSourceItem", () => {
  it("normalizes Tavily results into search source items", () => {
    const item = toSearchSourceItem({
      runId: 42,
      query: "finance ops",
      rank: 1,
      timestamp: new Date("2026-03-30T10:20:30Z"),
      rawPath: "/tmp/search.json",
      result: {
        title: " AP automation tools ",
        content: " Teams compare AP automation tools. ",
        url: "https://example.com/ap",
        site_name: "Example",
        score: 0.88,
      },
    });

    expect(item.source).toBe("search");
    expect(item.thread_ref).toBe("42");
    expect(item.title).toBe("AP automation tools");
    expect(item.text).toBe("Teams compare AP automation tools.");
    expect(item.canonical_url).toBe("https://example.com/ap");
    expect(item.channel_or_label).toBe("tavily");
    expect(item.metadata_json).toMatchObject({
      provider: "tavily",
      query: "finance ops",
      rank: 1,
      score: 0.88,
      run_id: 42,
    });
  });

  it("falls back to the query when Tavily omits title and content", () => {
    const item = toSearchSourceItem({
      runId: 7,
      query: "support workflow",
      rank: 2,
      timestamp: new Date("2026-03-30T10:20:30Z"),
      rawPath: "/tmp/search.json",
      result: {},
    });

    expect(item.title).toBe("support workflow");
    expect(item.text).toBe("support workflow");
  });
});
