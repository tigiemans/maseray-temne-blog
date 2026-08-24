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
  if (!body || typeof body !== "object") {
    throw new Error("Request body must be a valid JSON object.");
  }

  const { contributionType, customerName, amount, amountMinor, paymentProvider } = body;

  // 1. Validate contribution type
  if (!contributionType || !CONTRIBUTION_TYPES[contributionType]) {
    throw new Error(
      `Invalid contribution type '${contributionType}'. Valid types: ${Object.keys(CONTRIBUTION_TYPES).join(", ")}`
    );
  }

  // 2. Validate customer name
  if (!customerName || typeof customerName !== "string" || customerName.trim().length < 2) {
    throw new Error("Customer name must be at least 2 characters.");
  }

  // 3. Handle amount conversion (supports either major amount or amountMinor)
  let finalAmountMinor;
  if (amountMinor !== undefined && amountMinor !== null) {
    finalAmountMinor = Number(amountMinor);
  } else if (amount !== undefined && amount !== null) {
    finalAmountMinor = Math.round(Number(amount) * 100);
  } else {
    throw new Error("Contribution amount is required.");
  }

  if (isNaN(finalAmountMinor) || finalAmountMinor <= 0) {
    throw new Error("Contribution amount must be greater than 0.");
  }

  // Sensible upper limit: SLE 500,000 (50,000,000 minor units)
  if (finalAmountMinor > 50000000) {
    throw new Error("Contribution amount exceeds allowable limit.");
  }

  // 4. Validate payment provider (defaults to m17 Orange Money)
  const provider = paymentProvider || "m17";
  if (!SUPPORTED_PROVIDERS[provider]) {
    throw new Error(`Unsupported payment provider '${provider}'. Supported: m17 (Orange Money), m18 (Afrimoney).`);
  }

  return {
    contributionType,
    name: CONTRIBUTION_TYPES[contributionType],
    customerName: customerName.trim(),
    paymentProvider: provider,
    amountMinor: finalAmountMinor,
  };
}
