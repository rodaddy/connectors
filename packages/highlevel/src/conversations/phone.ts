/**
 * E.164 phone normalization, ported from earlier tooling `ghl_sms.to_e164`
 *. Anything it cannot normalize is refused, never guessed,
 * because a wrong number means messaging a stranger.
 *
 * @module
 */

/** A number that cannot be normalized to E.164. The message never carries the number. */
export class InvalidPhoneError extends Error {
  /** @param reason - Why the number was refused. */
  constructor(reason: string) {
    super(`Cannot normalize phone number to E.164: ${reason}.`);
    this.name = "InvalidPhoneError";
  }
}

/** A default country's calling code and national number length. */
interface NationalPlan {
  callingCode: string;
  nationalLength: number;
}

/** Countries a number without a leading `+` may be read in (NANP only, as proven in H28). */
const NATIONAL_PLANS: Record<string, NationalPlan> = {
  US: { callingCode: "1", nationalLength: 10 },
  CA: { callingCode: "1", nationalLength: 10 },
};

const E164_MIN_DIGITS = 8;
const E164_MAX_DIGITS = 15;

/**
 * Normalize a phone number to E.164.
 *
 * A leading `+` is trusted as international and only cleaned of separators
 * (8-15 digits). Otherwise a 10-digit number gets the default country's code,
 * and an 11-digit number starting with that code gets a `+`.
 *
 * @param input - The number as typed, punctuation allowed.
 * @param defaultCountry - Country for numbers without `+`; `US` or `CA`.
 * @returns The E.164 number, e.g. `+15551234567`.
 * @throws InvalidPhoneError when the number cannot be normalized.
 */
export function toE164(input: string, defaultCountry = "US"): string {
  const text = input.trim();
  const digits = text.replace(/\D/g, "");
  if (text.startsWith("+")) {
    if (digits.length >= E164_MIN_DIGITS && digits.length <= E164_MAX_DIGITS) {
      return `+${digits}`;
    }
    throw new InvalidPhoneError("international number has the wrong digit count");
  }
  const plan = NATIONAL_PLANS[defaultCountry];
  if (plan === undefined) {
    throw new InvalidPhoneError(`unsupported default country ${defaultCountry}`);
  }
  if (digits.length === plan.nationalLength) return `+${plan.callingCode}${digits}`;
  const withCode = plan.callingCode.length + plan.nationalLength;
  if (digits.length === withCode && digits.startsWith(plan.callingCode)) {
    return `+${digits}`;
  }
  throw new InvalidPhoneError("national number has the wrong digit count");
}
