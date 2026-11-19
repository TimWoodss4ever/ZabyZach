import cheese from './assets/pizzas/cheese.jpg';
import pepperoni from './assets/pizzas/pepperoni.jpg';
import hawaiian from './assets/pizzas/hawaiian.jpg';
import supreme from './assets/pizzas/supreme.jpg';
import veggie from './assets/pizzas/veggie.jpg';
import bbqChicken from './assets/pizzas/bbq-chicken.jpg';
import cocaCola from './assets/pizzas/coca-cola.png';
import dietCoke from './assets/pizzas/diet-coke.png';
import cocaColaZero from './assets/pizzas/coca-cola-zero-sugar.png';
import cocaColaCherry from './assets/pizzas/coca-cola-cherry.png';
import sprite from './assets/pizzas/sprite.png';
import fantaOrange from './assets/pizzas/fanta-orange.png';
import dippingCup from './assets/pizzas/dipping-cup.png';
import breadsticks from './assets/pizzas/breadsticks.jpg';

// Product photos keyed by item SKU. Items without a photo keep their emoji.
export const pizzaImages: Record<string, string> = {
  // Pizzas
  '2001': cheese,
  '2002': pepperoni,
  '2003': hawaiian,
  '2004': supreme,
  '2005': veggie,
  '2006': bbqChicken,
  // Sides
  '2007': breadsticks,
  '1017': dippingCup, // Ranch dipping cup
  '1041': dippingCup, // House sauce dipping cup
  '1042': dippingCup, // BBQ dipping cup
  '1043': dippingCup, // Buffalo dipping cup
  // Coca-Cola cans
  '1018': cocaCola,
  '1051': dietCoke,
  '1052': cocaColaZero,
  '1053': cocaColaCherry,
  '1054': sprite,
  '1055': fantaOrange,
};
