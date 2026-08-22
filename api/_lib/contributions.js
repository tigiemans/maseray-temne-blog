export const CONTRIBUTION_TYPES = Object.freeze({
  monthly: "Monthly Contribution",
  birthday: "Birthday Contribution",
  welfare: "General Welfare",
  emergency: "Emergency Support",
  wedding: "Wedding Support",
  naming: "Naming Ceremony",
  burial: "Burial Support",
  special_project: "Special Project",
});

export const PAYMENT_PROVIDER_ALIASES = Object.freeze({
  m17: "m17",
  "orange money": "m17",
  "orange money sierra leone": "m17",
  "orange": "m17",
});

export function normalizeProvider(value) {
  if (typeof value !== "string") return null;
  return PAYMENT_PROVIDER_ALIASES[value.trim().toLowerCase()] ?? null;
}

export function parseAmountToMinorUnits(value) {
  const raw = String(value ?? "").trim().replace(/,/g, "");
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(raw)) {
    throw new Error("Amount must be a positive SLE amount with at most 2 decimal places.");
  }
  const [whole, fraction = ""] = raw.split(".");
  const minor = BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
  if (minor <= 0n) throw new Error("Amount must be greater than zero.");
  if (minor > 100_000_000n) throw new Error("Amount exceeds the configured maximum.");
  return minor;
}

export function formatMajorAmount(minor) {
  const n = BigInt(minor);
  return `${n / 100n}.${String(n % 100n).padStart(2, "0")}`;
}

export function validateContributionInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("JSON object required.");
  }

  const contributionType = String(body.contributionType ?? "").trim();
  if (!Object.hasOwn(CONTRIBUTION_TYPES, contributionType)) {
    throw new Error("Unknown contribution type.");
  }

  const customerName = String(body.customerName ?? "").trim().replace(/\s+/g, " ");
  if (customerName.length < 2 || customerName.length > 100) {
    throw new Error("Customer name must be between 2 and 100 characters.");
  }

  const paymentProvider = normalizeProvider(body.paymentProvider);
  if (paymentProvider !== "m17") {
    throw new Error("Only Orange Money Sierra Leone (m17) is supported.");
  }

  const amountMinor = parseAmountToMinorUnits(body.amount);
  const maxSle = Number(process.env.MAX_CONTRIBUTION_SLE || "1000000");
  if (!Number.isFinite(maxSle) || maxSle <= 0) {
    throw new Error("Invalid server amount limit.");
  }
  if (amountMinor > BigInt(Math.round(maxSle * 100))) {
    throw new Error("Amount exceeds the configured maximum.");
  }

  return {
    contributionType,
    name: CONTRIBUTION_TYPES[contributionType],
    customerName,
    paymentProvider,
    amountMinor,
  };
}
