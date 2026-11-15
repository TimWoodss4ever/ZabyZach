const digitsOnly=(value:string)=>value.replace(/\D/g,'');

export function formatCardNumber(value:string):string {
 const digits=digitsOnly(value);
 if(/^3[47]/.test(digits)) {
  const card=digits.slice(0,15);
  return [card.slice(0,4),card.slice(4,10),card.slice(10,15)].filter(Boolean).join(' ');
 }
 return digits.slice(0,19).match(/.{1,4}/g)?.join(' ')??'';
}

export function formatCardExpiry(value:string):string {
 const digits=digitsOnly(value).slice(0,4);
 return digits.length>2?digits.slice(0,2)+'/'+digits.slice(2):digits;
}

// Preserve the logical digit position when a customer edits within formatted text.
export function updateFormattedPaymentInput(input:HTMLInputElement,format:(value:string)=>string,setValue:(value:string)=>void):void {
 const raw=input.value,position=input.selectionStart??raw.length;
 const digitsBefore=digitsOnly(raw.slice(0,position)).length;
 const formatted=format(raw);
 let cursor=0,seen=0;
 while(cursor<formatted.length&&seen<digitsBefore){if(/\d/.test(formatted[cursor]))seen++;cursor++;}
 if(position===raw.length)cursor=formatted.length;
 setValue(formatted);
 // Also update the element when deleting a separator yields the same React state.
 input.value=formatted;
 input.setSelectionRange(cursor,cursor);
 requestAnimationFrame(()=>{if(document.activeElement===input)input.setSelectionRange(cursor,cursor);});
}
