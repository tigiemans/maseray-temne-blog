import test from "node:test";
import assert from "node:assert/strict";
import { CONTRIBUTION_TYPES, parseAmountToMinorUnits, validateContributionInput } from "./contributions.js";

test("maps birthday contribution", () => {
  assert.equal(CONTRIBUTION_TYPES.birthday, "Birthday Contribution");
});

test("converts SLE major units to minor units", () => {
  assert.equal(parseAmountToMinorUnits("500").toString(), "50000");
  assert.equal(parseAmountToMinorUnits("500.50").toString(), "50050");
});

test("rejects unknown contribution types", () => {
  assert.throws(() => validateContributionInput({
    contributionType: "unknown",
    customerName: "Musa Kamara",
    amount: "500",
    paymentProvider: "m17"
  }));
});
