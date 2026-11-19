import cheese from './assets/pizzas/cheese.jpg';
import pepperoni from './assets/pizzas/pepperoni.jpg';
import hawaiian from './assets/pizzas/hawaiian.jpg';
import supreme from './assets/pizzas/supreme.jpg';
import veggie from './assets/pizzas/veggie.jpg';
import bbqChicken from './assets/pizzas/bbq-chicken.jpg';

// Product photos keyed by item SKU. Items without a photo keep their emoji.
export const pizzaImages: Record<string, string> = {
  '2001': cheese,
  '2002': pepperoni,
  '2003': hawaiian,
  '2004': supreme,
  '2005': veggie,
  '2006': bbqChicken,
};
