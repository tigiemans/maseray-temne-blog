export const CONTRIBUTION_TYPES = {
  monthly: "Monthly Contribution",
  birthday: "Birthday Contribution",
  welfare: "General Welfare",
  emergency: "Emergency Support",
  wedding: "Wedding Support",
  naming: "Naming Ceremony",
  burial: "Burial Support",
  special_project: "Special Project",
};

export const SUPPORTED_PROVIDERS = {
  m17: "Orange Money",
  m18: "Afrimoney",
};

export function formatMajorAmount(amountMinor) {
  return (Number(amountMinor) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function validateContributionInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Request body must be a valid JSON object.");
  }

  const { contributionType, customerName, amount, amountMinor, paymentProvider } = body;

  if (!contributionType || !CONTRIBUTION_TYPES[contributionType]) {
    throw new Error(
      `Invalid contribution type '${contributionType}'. Valid types: ${Object.keys(CONTRIBUTION_TYPES).join(", ")}`
    );
  }

  if (!customerName || typeof customerName !== "string" || customerName.trim().length < 2) {
    throw new Error("Customer name must be at least 2 characters.");
  }

  let finalAmountMinor;
  if (amountMinor !== undefined && amountMinor !== null) {
    if (typeof amountMinor !== "number" && typeof amountMinor !== "string") {
      throw new Error("Contribution amount is invalid.");
    }
    finalAmountMinor = Number(amountMinor);
  } else if (amount !== undefined && amount !== null) {
    finalAmountMinor = Number(amount) * 100;
  } else {
    throw new Error("Contribution amount is required.");
  }

  if (!Number.isSafeInteger(finalAmountMinor) || finalAmountMinor <= 0) {
    throw new Error("Contribution amount must be a positive amount with at most 2 decimal places.");
  }

  if (finalAmountMinor > 50000000) {
    throw new Error("Contribution amount exceeds allowable limit.");
  }

  const provider = paymentProvider || "m17";
  if (!SUPPORTED_PROVIDERS[provider]) {
    throw new Error(
      `Unsupported payment provider '${provider}'. Supported: m17 (Orange Money), m18 (Afrimoney).`
    );
  }

  return {
    contributionType,
    name: CONTRIBUTION_TYPES[contributionType],
    customerName: customerName.trim(),
    paymentProvider: provider,
    amountMinor: finalAmountMinor,
  };
}
