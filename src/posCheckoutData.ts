import {supabase} from './supabase';
import {createPosCheckout} from './posCheckout';
export const {loadPosCustomer,postPosSale,readPendingPosSale,recoverPosSale}=createPosCheckout(supabase,sessionStorage);
