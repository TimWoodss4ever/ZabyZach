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
  distanceMiles: number;
  roundTripMinutes: number;
  fee: number;
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

export function formatDeliveryAddress(value: DeliveryAddress) {
  return [value.street, value.unit.trim(), `${value.city}, ${value.state} ${value.postalCode}`]
    .filter(Boolean)
    .join(', ');
}

export function buildDeliveryQuote(input: {
  oneWayMinutes: number;
  distanceMiles: number;
  pendingOrders: number;
  pizzaCount: number;
  otherItemCount: number;
}): DeliveryQuote {
  const oneWayMinutes = Math.max(1, Math.ceil(input.oneWayMinutes));
  if (oneWayMinutes > deliveryLimitMinutes) {
    throw new Error(`That address is outside our ${deliveryLimitMinutes}-minute delivery area.`);
  }
  const roundTripMinutes = oneWayMinutes * 2;
  const fee = Math.round(roundTripMinutes * deliveryRatePerMinute * 100) / 100;

  // Starter estimates: one pizza takes about 15 minutes, extra pizzas add
  // three minutes, and sides/drinks add two minutes each. Open orders add an
  // estimated four minutes each to the queue, capped at 40 minutes.
  const pizzaPrep = input.pizzaCount > 0 ? 15 + Math.max(0, input.pizzaCount - 1) * 3 : 0;
  const otherPrep = input.otherItemCount * 2;
  const queue = Math.min(40, Math.max(0, input.pendingOrders) * 4);
  const prep = Math.max(8, pizzaPrep + otherPrep) + queue;

  return {
    oneWayMinutes,
    distanceMiles: Math.round(input.distanceMiles * 10) / 10,
    roundTripMinutes,
    fee,
    etaMin: prep + oneWayMinutes,
    etaMax: prep + oneWayMinutes + 10,
  };
}
