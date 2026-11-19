type SearchableItem={sku:string;name:string;barcode:string};
export function parseItemQuery(value:string){
 const cleaned=value.normalize('NFKC').replace(/[\u2010-\u2015\u2212]/g,'-').trim();
 const match=cleaned.match(/^sku\s*[:#-]?\s*(\d+)$/i);
 return {query:match?match[1]:cleaned,skuOnly:!!match};
}
const words=(value:string)=>value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
export function matchesItemQuery(item:SearchableItem,value:string){
 const {query,skuOnly}=parseItemQuery(value),q=query.toLowerCase();
 if(!q)return true;
 if(skuOnly)return item.sku.toLowerCase()===q;
 if(item.sku.toLowerCase()===q||item.barcode.toLowerCase()===q)return true;
 const name=words(item.name);
 // Familiar food words expand search only; stored names and item codes stay intact.
 const aliases=/\b(mozzarella|parmesan|cheddar|ricotta|provolone|feta)\b/.test(name)?' cheese':'';
 const tokens=words(query).split(/\s+/).filter(Boolean);
 return tokens.length>0&&tokens.every(token=>(name+aliases).includes(token));
}
export function matchingItems<T extends SearchableItem>(catalog:T[],value:string):T[]{
 const {query,skuOnly}=parseItemQuery(value),q=query.toLowerCase();
 if(q){const exact=catalog.filter(i=>i.sku.toLowerCase()===q||(!skuOnly&&i.barcode.toLowerCase()===q));if(exact.length)return exact;}
 return catalog.filter(i=>matchesItemQuery(i,value));
}
