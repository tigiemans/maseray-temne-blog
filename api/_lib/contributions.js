export const SUPPORTED_PROVIDERS = {
  m17: "Orange Money",
  m18: "Afrimoney",
};

export function validateContributionInput(body) {
  if (!body || typeof body !== "object") {
    throw new Error("Request body must be an object.");
  }

  const { contributionType, customerName, paymentProvider, amountMinor } = body;

  if (!contributionType || !CONTRIBUTION_TYPES[contributionType]) {
    throw new Error("Invalid contribution type.");
  }

  if (!customerName || typeof customerName !== "string" || customerName.trim().length === 0) {
    throw new Error("Customer name is required.");
  }

  if (!paymentProvider || !["m17", "m18"].includes(paymentProvider)) {
    throw new Error("Invalid payment provider. Must be 'm17' (Orange Money) or 'm18' (Afrimoney).");
  }

  if (!amountMinor || isNaN(Number(amountMinor)) || Number(amountMinor) <= 0) {
    throw new Error("amountMinor must be a positive number.");
  }

  return {
    contributionType,
    name: CONTRIBUTION_TYPES[contributionType],
    customerName: customerName.trim(),
    paymentProvider,
    amountMinor: Number(amountMinor),
  };
}
