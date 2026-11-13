import type { BillingConfig } from "../../types";

/** The OKtoMerge plan table from oktomerge#10, used across the tests. */
export const testConfig: BillingConfig = {
  plans: {
    free: { includedUnits: 50 },
    pro: { includedUnits: 250, priceLookupKey: "test_pro_monthly" },
    team: { includedUnits: 750, priceLookupKey: "test_team_monthly" },
    fleet: { includedUnits: 2000, priceLookupKey: "test_fleet_monthly" },
  },
  freePlan: "free",
  overage: { priceLookupKey: "test_credit_overage", meterEventName: "test_credits" },
  gracePeriodDays: 7,
};
