import { describe, expect, it } from "vitest"

import { resolveDisplayCost } from "../webui/src/lib/cost.js"

describe("WebUI 费用显示解析", () => {
  it("按主币种返回费用和等值币种", () => {
    const costs = [
      { currency: "USD", request_count: 10, total_cost_nanos: 1_000_000_000 },
      { currency: "CNY", request_count: 10, total_cost_nanos: 7_000_000_000 },
    ]
    expect(resolveDisplayCost(costs, "usd", 7)).toEqual({
      primaryNanos: 1_000_000_000,
      primaryCurrency: "USD",
      equivalentNanos: 7_000_000_000,
      equivalentCurrency: "CNY",
      requestCount: 10,
    })
  })

  it("缺少等值币种时按汇率换算", () => {
    expect(resolveDisplayCost([{ currency: "USD", request_count: 2, total_cost_nanos: 3_000 }], "cny", 7)).toMatchObject({
      primaryNanos: 21_000,
      primaryCurrency: "CNY",
      equivalentNanos: 3_000,
      equivalentCurrency: "USD",
    })
  })
})
