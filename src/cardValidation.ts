// Format checks for the POS card boxes. The full card number, expiry, security
// code and ZIP are checked here and then thrown away: only the brand and the
// last 4 digits are ever sent to the database.
export type CardBrand = 'Visa' | 'Mastercard' | 'American Express' | 'Discover' | 'Other'

export const digitsOnly = (v: string) => v.replace(/\D/g, '')

export function detectCardBrand(number: string): CardBrand {
  const d = digitsOnly(number)
  if (/^4/.test(d)) return 'Visa'
  if (/^(5[1-5]|2(2[2-9][1-9]|2[3-9]\d|[3-6]\d\d|7[01]\d|720))/.test(d)) return 'Mastercard'
  if (/^3[47]/.test(d)) return 'American Express'
  if (/^(6011|65|64[4-9])/.test(d)) return 'Discover'
  return 'Other'
}

export type CardFields = { name: string; number: string; expiry: string; cvc: string; zip: string }

// Returns an error message, or '' when everything is correctly formatted.
export function cardError(c: CardFields): string {
  if (!c.name.trim()) return 'Enter the name on the card.'
  const n = digitsOnly(c.number)
  const amex = /^3[47]/.test(n)
  if (amex ? n.length !== 15 : n.length < 13 || n.length > 19) return 'Enter a valid card number.'
  const m = /^(\d{2})\/(\d{2})$/.exec(c.expiry)
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) return 'Enter the expiration as MM/YY.'
  if (!new RegExp(`^\\d{${amex ? 4 : 3}}$`).test(c.cvc)) return amex ? 'Security code must be 4 digits.' : 'Security code must be 3 digits.'
  if (!/^\d{5}$/.test(c.zip)) return 'Billing ZIP code must be 5 digits.'
  return ''
}

export function cardSummary(number: string): { brand: CardBrand; last4: string } {
  const d = digitsOnly(number)
  return { brand: detectCardBrand(d), last4: d.slice(-4) }
}
