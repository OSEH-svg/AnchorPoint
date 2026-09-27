import { Sep31TransactionRequest, Sep31Config } from "./types";

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/** Hard-coded defaults used when no SystemConfig is provided. */
const DEFAULT_SEP31_CONFIG: Sep31Config = {
  assets: {
    USDC: {
      enabled: true,
      min_amount: 1,
      max_amount: 1_000_000,
      fee_fixed: 0,
      fee_percent: 0.5,
      quotes_supported: false,
      quotes_required: false,
      sender_sep12_type: "sep31-sender",
      receiver_sep12_type: "sep31-receiver",
    },
    EURC: {
      enabled: true,
      min_amount: 1,
      max_amount: 1_000_000,
      fee_fixed: 0,
      fee_percent: 0.5,
      quotes_supported: false,
      quotes_required: false,
      sender_sep12_type: "sep31-sender",
      receiver_sep12_type: "sep31-receiver",
    },
    XLM: {
      enabled: true,
      min_amount: 10,
      max_amount: 10_000_000,
      fee_fixed: 0,
      fee_percent: 0.5,
      quotes_supported: false,
      quotes_required: false,
      sender_sep12_type: "sep31-sender",
      receiver_sep12_type: "sep31-receiver",
    },
  },
};

const VALID_MEMO_TYPES = new Set(["text", "id", "hash"]);

/**
 * Extracts the subset of SEP-31 configuration needed by the validators.
 * Returns only the assets that are **enabled** so that disabled assets are
 * automatically treated as unsupported.
 */
function toValidationConfig(sep31Config?: Sep31Config): Sep31Config {
  if (!sep31Config) return DEFAULT_SEP31_CONFIG;

  const enabledAssets: Sep31Config["assets"] = {};
  for (const [code, cfg] of Object.entries(sep31Config.assets)) {
    if (cfg.enabled) {
      enabledAssets[code] = { ...cfg };
    }
  }
  return { assets: enabledAssets };
}

/**
 * Validates a SEP-31 POST /transactions request body.
 *
 * Accepts an optional `sep31Config` parameter that is driven by the dynamic
 * SystemConfig. When provided, amount limits and supported-asset checking
 * are sourced from the live configuration. Falls back to hard-coded defaults
 * when omitted.
 *
 * Returns a list of field-level errors — an empty array means the request
 * is valid and can proceed.
 */
export function validateTransactionRequest(
  body: Partial<Sep31TransactionRequest>,
  sep31Config?: Sep31Config
): ValidationResult {
  const errors: ValidationError[] = [];
  const cfg = toValidationConfig(sep31Config);

  const supportedAssets = new Set(
    Object.keys(cfg.assets).map((c) => c.toUpperCase())
  );

  // ── amount ────────────────────────────────────────────────────────────────
  if (!body.amount) {
    errors.push({ field: "amount", message: "amount is required." });
  } else {
    const parsed = parseFloat(body.amount);
    if (isNaN(parsed) || parsed <= 0) {
      errors.push({
        field: "amount",
        message: "amount must be a positive number.",
      });
    }
  }

  // ── asset_code ────────────────────────────────────────────────────────────
  if (!body.asset_code) {
    errors.push({ field: "asset_code", message: "asset_code is required." });
  } else if (!supportedAssets.has(body.asset_code.toUpperCase())) {
    errors.push({
      field: "asset_code",
      message: `asset_code "${body.asset_code}" is not supported. Supported assets: ${[...supportedAssets].join(", ")}.`,
    });
  } else if (body.amount) {
    // Range check against config-driven limits
    const parsed = parseFloat(body.amount);
    const assetCfg = cfg.assets[body.asset_code.toUpperCase()];
    if (assetCfg && !isNaN(parsed)) {
      if (parsed < assetCfg.min_amount) {
        errors.push({
          field: "amount",
          message: `Minimum amount for ${body.asset_code} is ${assetCfg.min_amount}.`,
        });
      }
      if (parsed > assetCfg.max_amount) {
        errors.push({
          field: "amount",
          message: `Maximum amount for ${body.asset_code} is ${assetCfg.max_amount}.`,
        });
      }
    }
  }

  // ── sender / receiver identity ─────────────────────────────────────────
  const hasSenderIdentity = body.sender_id || body.sender_info;
  const hasReceiverIdentity = body.receiver_id || body.receiver_info;

  if (!hasSenderIdentity) {
    errors.push({
      field: "sender_id",
      message: "Either sender_id or sender_info is required.",
    });
  }

  if (!hasReceiverIdentity) {
    errors.push({
      field: "receiver_id",
      message: "Either receiver_id or receiver_info is required.",
    });
  }

  // ── sender ≠ receiver ─────────────────────────────────────────────────
  if (body.sender_id && body.receiver_id && body.sender_id === body.receiver_id) {
    errors.push({
      field: "receiver_id",
      message: "sender_id and receiver_id must refer to different customers.",
    });
  }

  if (
    body.sender_info &&
    body.receiver_info &&
    !body.sender_id &&
    !body.receiver_id
  ) {
    const senderKey = [
      body.sender_info.first_name?.trim().toLowerCase(),
      body.sender_info.last_name?.trim().toLowerCase(),
      body.sender_info.email?.trim().toLowerCase(),
    ].join("|");
    const receiverKey = [
      body.receiver_info.first_name?.trim().toLowerCase(),
      body.receiver_info.last_name?.trim().toLowerCase(),
      body.receiver_info.email?.trim().toLowerCase(),
    ].join("|");
    if (senderKey === receiverKey && senderKey !== "||") {
      errors.push({
        field: "receiver_info",
        message: "sender_info and receiver_info must refer to different customers.",
      });
    }
  }

  // ── memo_type ──────────────────────────────────────────────────────────
  if (body.memo_type && !VALID_MEMO_TYPES.has(body.memo_type)) {
    errors.push({
      field: "memo_type",
      message: `memo_type must be one of: ${[...VALID_MEMO_TYPES].join(", ")}.`,
    });
  }

  // ── memo consistency ───────────────────────────────────────────────────
  if (body.memo && !body.memo_type) {
    errors.push({
      field: "memo_type",
      message: "memo_type is required when memo is provided.",
    });
  }
  if (body.memo_type && !body.memo) {
    errors.push({
      field: "memo",
      message: "memo is required when memo_type is provided.",
    });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates minimal required fields in receiver_info when receiver_id is
 * not provided. Anchors typically require name + bank routing details.
 */
export function validateReceiverInfo(
  info: Record<string, string> | undefined
): ValidationError[] {
  if (!info) return [];
  const errors: ValidationError[] = [];
  const required = ["first_name", "last_name"];
  for (const field of required) {
    if (!info[field] || info[field].trim() === "") {
      errors.push({
        field: `receiver_info.${field}`,
        message: `receiver_info.${field} is required.`,
      });
    }
  }
  return errors;
}
