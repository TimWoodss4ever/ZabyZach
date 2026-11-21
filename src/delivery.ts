import type { Location } from './domain';

export type FulfillmentType = 'pickup' | 'delivery';
export type DeliveryAddress = {
  street: string;
  unit: string;
  city: string;
  state: string;
  postalCode: string;
};
export type DeliveryQuote = {
  oneWayMinutes: number;
  oneWayMin: number;
  oneWayMax: number;
  distanceMiles: number;
  roundTripMinutes: number;
  fee: number;
  feeMin: number;
  feeMax: number;
  etaMin: number;
  etaMax: number;
};

// Fictional demo contact details. The 555-01xx numbers and .example domains
// are reserved for examples and must never be presented as real contacts.
export const customerStoreInfo: Record<Location, {
  address: string;
  phone: string;
  email: string;
}> = {
  'Provo Campus Store': {
    address: '150 N University Ave, Provo, UT 84601',
    phone: '(801) 555-0142',
    email: 'provo@zabyzach.example',
  },
  'Orem Store': {
    address: '470 N State St, Orem, UT 84057',
    phone: '(801) 555-0184',
    email: 'orem@zabyzach.example',
  },
  'Central Commissary': {
    address: 'Not open to customers',
    phone: '(801) 555-0190',
    email: 'commissary@zabyzach.example',
  },
};

export const deliveryLimitMinutes = 20;
export const deliveryRatePerMinute = 0.5;
type DeliveryZone = { oneWayMin: number; oneWayMax: number; distanceMiles: number };

// School-project estimates, selected by the first five digits of the ZIP code.
// These are preset zones, not live driving distances or verified service areas.
const deliveryZones: Partial<Record<Location, Record<string, DeliveryZone>>> = {
  'Provo Campus Store': {
    '84601': { oneWayMin: 8, oneWayMax: 12, distanceMiles: 3.0 },
    '84602': { oneWayMin: 8, oneWayMax: 14, distanceMiles: 3.5 },
    '84604': { oneWayMin: 9, oneWayMax: 15, distanceMiles: 4.0 },
    '84606': { oneWayMin: 12, oneWayMax: 18, distanceMiles: 6.0 },
    '84603': { oneWayMin: 14, oneWayMax: 20, distanceMiles: 8.0 },
  },
  'Orem Store': {
    '84057': { oneWayMin: 7, oneWayMax: 12, distanceMiles: 3.0 },
    '84058': { oneWayMin: 8, oneWayMax: 14, distanceMiles: 4.0 },
    '84097': { oneWayMin: 10, oneWayMax: 16, distanceMiles: 5.0 },
    '84059': { oneWayMin: 14, oneWayMax: 20, distanceMiles: 8.0 },
  },
};

export function deliveryZoneForPostalCode(location: Location, postalCode: string): DeliveryZone | null {
  const zip = postalCode.trim().match(/^[0-9]{5}/)?.[0];
  if (!zip || location === 'Central Commissary') return null;
  return deliveryZones[location]?.[zip] ?? null;
}

export function formatDeliveryAddress(value: DeliveryAddress) {
  return [value.street, value.unit.trim(), `${value.city}, ${value.state} ${value.postalCode}`]
    .filter(Boolean)
    .join(', ');
}

export function buildDeliveryQuote(input: {
  oneWayMin: number;
  oneWayMax: number;
  distanceMiles: number;
  pendingOrders: number;
  pizzaCount: number;
  otherItemCount: number;
}): DeliveryQuote {
  const oneWayMin = Math.max(1, Math.floor(input.oneWayMin));
  const requestedMax = Math.ceil(input.oneWayMax);
  if (oneWayMin > deliveryLimitMinutes || requestedMax > deliveryLimitMinutes) {
    throw new Error(`That address is outside our ${deliveryLimitMinutes}-minute delivery area.`);
  }
  const oneWayMax = Math.max(oneWayMin, requestedMax);

  // The fee uses the midpoint estimate, including the driver's return trip.
  const oneWayMinutes = Math.ceil((oneWayMin + oneWayMax) / 2);
  const roundTripMinutes = oneWayMinutes * 2;
  const fee = Math.round(roundTripMinutes * deliveryRatePerMinute * 100) / 100;
  const feeMin = Math.round(oneWayMin * 2 * deliveryRatePerMinute * 100) / 100;
  const feeMax = Math.round(oneWayMax * 2 * deliveryRatePerMinute * 100) / 100;

  // Starter estimates: one pizza takes about 15 minutes, extra pizzas add
  // three minutes, and sides/drinks add two minutes each. Open orders add an
  // estimated four minutes each to the queue, capped at 40 minutes.
  const pizzaPrep = input.pizzaCount > 0 ? 15 + Math.max(0, input.pizzaCount - 1) * 3 : 0;
  const otherPrep = input.otherItemCount * 2;
  const queue = Math.min(40, Math.max(0, input.pendingOrders) * 4);
  const prepMin = Math.max(8, pizzaPrep + otherPrep) + queue;
  const prepMax = prepMin + 5;

  return {
    oneWayMinutes,
    oneWayMin,
    oneWayMax,
    distanceMiles: Math.round(input.distanceMiles * 10) / 10,
    roundTripMinutes,
    fee,
    feeMin,
    feeMax,
    etaMin: prepMin + oneWayMin,
    etaMax: prepMax + oneWayMax,
  };
}
