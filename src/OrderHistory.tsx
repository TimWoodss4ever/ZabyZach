import { useCallback, useEffect, useMemo, useState } from 'react'
import { Printer, RotateCcw, X, Search } from 'lucide-react'
import { supabase } from './supabase'
import { printReceipt } from './printReceipt'
import { readPlanSnapshot } from './sharedMrp'
import type { PlanSnapshot } from './sharedMrp'
import { OrderImpactDialog, fetchOrderImpact } from './SharedPlanningScreens'
import type { OrderImpact } from './SharedPlanningScreens'

type SaleLine = { item_sku: string; quantity: number; unit_price: number }
type Sale = {
  id: string; receipt_no: string; location_id: string; customer_id: string | null
  subtotal: number; discount: number; tax: number; total: number; status: string; created_at: string
  pickup_name: string | null; payment_method: string | null; card_brand: string | null; card_last4: string | null
  sale_lines: SaleLine[]
}
type OrderRow = {
  id: string; customer_id: string | null; erp_order_number: number; erp_name: string | null; erp_phone: string | null; erp_sale_id: string | null
  erp_prepared_at: string | null; status: string; pickup_at: string; location_id: string
  discount_pct: number; discount_amount: number; created_at: string; card_brand: string | null; card_last4: string | null
  erp_fulfillment_type: string | null; erp_delivery_address: string | null; erp_delivery_fee: number | null
  sales_order_lines: SaleLine[]
}
type Ret = { id: string; original_sale_id: string; transaction_type: 'Return' | 'Exchange'; refund_total: number; created_at: string }
type Entry = {
  key: string; created: string; label: string; kind: 'Counter' | 'Pickup' | 'Delivery'
  customer: string; phone: string; email: string; location: string; orderId?: string; orderStatus?: string; paymentLong: string; lines: { name: string; qty: number; price: number }[]
  subtotal: number; discount: number; tax: number; fee: number; total: number; estimated: boolean
  payment: string; status: { label: string; cls: string }; saleId?: string; when?: string; address?: string
  returns: Ret[]; search: string
}

const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
const stamp = (iso: string) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
const dayStr = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Denver' })
const phoneText = (raw: string | null | undefined) => {
  const d = (raw ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (raw ?? '')
}
const PAGE = 25

export function OrderHistory({ flash, onStartReturn }: { flash: (m: string) => void; onStartReturn: (saleId: string) => void }) {
  const [from, setFrom] = useState(() => dayStr(new Date(Date.now() - 29 * 86400000)))
  const [to, setTo] = useState(() => dayStr(new Date()))
  const [search, setSearch] = useState('')
  const [source, setSource] = useState<'All' | 'Counter' | 'Pickup' | 'Delivery'>('All')
  const [returnState, setReturnState] = useState<'All' | 'With returns' | 'No returns'>('All')
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [capped, setCapped] = useState(false)
  const [shown, setShown] = useState(PAGE)
  const [open, setOpen] = useState<Entry | null>(null)
  const [closing, setClosing] = useState(false)
  const [impact, setImpact] = useState<{ entry: Entry; loading: boolean; error: string; data?: OrderImpact; plan?: PlanSnapshot | null } | null>(null)

  // Fulfilled orders leave the outstanding list; this is where they get closed.
  const closeOrder = async (entry: Entry) => {
    if (!entry.orderId || closing) return
    setClosing(true)
    try {
      const r = await supabase.rpc('erp_pickup_progress', { p_order: entry.orderId, p_action: 'close' })
      if (r.error) throw Error(r.error.message)
      if (!r.data) throw Error('Confirmation was incomplete; retry this action.')
      flash('Order closed.')
      window.dispatchEvent(new Event('erp-shared-planning-updated'))
      setOpen(null)
      await load()
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Unable to close the order.')
    } finally { setClosing(false) }
  }

  const openImpact = async (entry: Entry) => {
    setImpact({ entry, loading: true, error: '' })
    try {
      const data = await fetchOrderImpact({ orderId: entry.orderId, saleId: entry.orderId ? undefined : entry.saleId })
      let plan: PlanSnapshot | null = null
      if (entry.orderId && !entry.saleId) {
        // Only an order that has not been prepared yet needs the live MRP view.
        const snapshot = await supabase.rpc('erp_planning_snapshot')
        if (!snapshot.error) { try { plan = readPlanSnapshot(snapshot.data) } catch { plan = null } }
      }
      setImpact({ entry, loading: false, error: '', data, plan })
    } catch (e) {
      setImpact({ entry, loading: false, error: e instanceof Error ? e.message : 'Unable to load order history.' })
    }
  }

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const start = new Date(`${from}T00:00:00`).toISOString()
      const end = new Date(new Date(`${to}T00:00:00`).getTime() + 86400000).toISOString()
      const sales: Sale[] = []
      let wasCapped = false
      for (let offset = 0; offset < 5000; offset += 1000) {
        const { data, error: e } = await supabase.from('sales')
          .select('id,receipt_no,location_id,customer_id,subtotal,discount,tax,total,status,created_at,pickup_name,payment_method,card_brand,card_last4,sale_lines(item_sku,quantity,unit_price)')
          .gte('created_at', start).lt('created_at', end)
          .order('created_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + 999)
        if (e) throw Error(e.message)
        sales.push(...((data ?? []) as unknown as Sale[]))
        if (!data || data.length < 1000) break
        if (offset === 4000) wasCapped = true
      }
      const orders: OrderRow[] = []
      for (let offset = 0; offset < 5000; offset += 1000) {
        const { data, error: e } = await supabase.from('sales_orders')
          .select('id,customer_id,erp_order_number,erp_name,erp_phone,erp_sale_id,erp_prepared_at,status,pickup_at,location_id,discount_pct,discount_amount,created_at,card_brand,card_last4,erp_fulfillment_type,erp_delivery_address,erp_delivery_fee,sales_order_lines(item_sku,quantity,unit_price)')
          .gte('created_at', start).lt('created_at', end)
          .order('created_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + 999)
        if (e) throw Error(e.message)
        orders.push(...((data ?? []) as unknown as OrderRow[]))
        if (!data || data.length < 1000) break
      }
      // Orders that already became a sale can be found by sale id, even outside this date range.
      const loadedSaleIds = new Set(sales.map(s => s.id))
      const linked = new Map<string, OrderRow>()
      for (const o of orders) if (o.erp_sale_id) linked.set(o.erp_sale_id, o)
      const ids = sales.map(s => s.id)
      const missing = ids.filter(id => !linked.has(id))
      const rets: Ret[] = []
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100)
        const r = await supabase.from('sales_returns').select('id,original_sale_id,transaction_type,refund_total,created_at').in('original_sale_id', chunk)
        if (r.error) throw Error(r.error.message)
        rets.push(...((r.data ?? []) as Ret[]))
      }
      for (let i = 0; i < missing.length; i += 100) {
        const { data } = await supabase.from('sales_orders')
          .select('id,customer_id,erp_order_number,erp_name,erp_phone,erp_sale_id,erp_prepared_at,status,pickup_at,location_id,discount_pct,discount_amount,created_at,card_brand,card_last4,erp_fulfillment_type,erp_delivery_address,erp_delivery_fee,sales_order_lines(item_sku,quantity,unit_price)')
          .in('erp_sale_id', missing.slice(i, i + 100))
        for (const o of (data ?? []) as unknown as OrderRow[]) if (o.erp_sale_id) linked.set(o.erp_sale_id, o)
      }
      const custIds = [...new Set([...sales.map(r => r.customer_id), ...orders.map(o => o.customer_id), ...[...linked.values()].map(o => o.customer_id)].filter((v): v is string => !!v))]
      const cust = new Map<string, { name: string; phone: string; email: string }>()
      for (let i = 0; i < custIds.length; i += 100) {
        const { data } = await supabase.from('customers').select('id,name,phone,email').in('id', custIds.slice(i, i + 100))
        for (const c of (data ?? []) as { id: string; name: string; phone: string; email: string | null }[]) cust.set(c.id, { name: c.name, phone: c.phone, email: c.email ?? '' })
      }
      const [it, lo, st] = await Promise.all([
        supabase.from('items').select('sku,name'), supabase.from('locations').select('id,name'),
        supabase.from('settings').select('value').eq('setting_key', 'sales_tax_rate').maybeSingle(),
      ])
      const itemName = new Map(((it.data ?? []) as { sku: string; name: string }[]).map(x => [x.sku, x.name]))
      const locName = new Map(((lo.data ?? []) as { id: string; name: string }[]).map(x => [x.id, x.name]))
      const rate = Number((st.data as { value?: unknown } | null)?.value ?? 0.0725) || 0.0725
      const retsBySale = new Map<string, Ret[]>()
      for (const r of rets) retsBySale.set(r.original_sale_id, [...(retsBySale.get(r.original_sale_id) ?? []), r])

      const cardText = (brand: string | null | undefined, last4: string | null | undefined) => (brand && last4 ? `${brand} ····${last4}` : '')
      const built: Entry[] = []

      for (const s of sales) {
        const o = linked.get(s.id)
        const c = (s.customer_id ? cust.get(s.customer_id) : undefined) ?? (o?.customer_id ? cust.get(o.customer_id) : undefined)
        const customer = o?.erp_name || s.pickup_name || c?.name || 'Walk-in'
        const phone = phoneText(o?.erp_phone || c?.phone || '')
        const card = cardText(s.card_brand, s.card_last4) || cardText(o?.card_brand, o?.card_last4)
        const payment = card || (s.payment_method === 'Card (simulated)' ? 'Card (details not recorded)' : s.payment_method || '—')
        const paymentLong = (s.card_brand && s.card_last4 ? `${s.card_brand} ending ${s.card_last4}` : '') || (o?.card_brand && o?.card_last4 ? `${o.card_brand} ending ${o.card_last4}` : '') || payment
        const returns = retsBySale.get(s.id) ?? []
        const refunded = returns.reduce((t, x) => t + Number(x.refund_total), 0)
        const kind: Entry['kind'] = o ? (o.erp_fulfillment_type === 'delivery' ? 'Delivery' : 'Pickup') : 'Counter'
        const lines = s.sale_lines.map(l => ({ name: itemName.get(l.item_sku) ?? l.item_sku, qty: Number(l.quantity), price: Number(l.unit_price) }))
        built.push({
          key: 's' + s.id, created: s.created_at, label: s.receipt_no, kind, customer, phone, email: c?.email ?? '', orderId: o?.id, orderStatus: o?.status, paymentLong,
          location: locName.get(s.location_id) ?? '', lines,
          subtotal: Number(s.subtotal), discount: Number(s.discount), tax: Number(s.tax), fee: 0, total: Number(s.total), estimated: false,
          payment,
          status: returns.length ? { label: returns.some(x => x.transaction_type === 'Exchange') ? `Exchanged · ${money(refunded)} credited` : `Refunded ${money(refunded)}`, cls: 'warn' } : { label: o ? (o.status === 'Order Placed' ? 'Preparing' : o.status) : 'Completed', cls: 'good' },
          saleId: s.id, when: o ? stamp(o.pickup_at) : undefined, address: o?.erp_delivery_address ?? undefined, returns,
          search: [s.receipt_no, customer, phone.replace(/\D/g, ''), card, locName.get(s.location_id), ...lines.map(l => l.name)].join(' ').toLowerCase(),
        })
      }

      for (const o of orders) {
        if (o.erp_sale_id && (loadedSaleIds.has(o.erp_sale_id) || linked.get(o.erp_sale_id))) continue
        const lines = o.sales_order_lines.map(l => ({ name: itemName.get(l.item_sku) ?? l.item_sku, qty: Number(l.quantity), price: Number(l.unit_price) }))
        const subtotal = lines.reduce((t, l) => t + l.qty * l.price, 0)
        const discount = Math.min(subtotal, subtotal * Number(o.discount_pct) / 100 + Number(o.discount_amount))
        const tax = Math.round((subtotal - discount) * rate * 100) / 100
        const fee = Number(o.erp_delivery_fee ?? 0)
        const card = cardText(o.card_brand, o.card_last4)
        const oc = o.customer_id ? cust.get(o.customer_id) : undefined
        const kind: Entry['kind'] = o.erp_fulfillment_type === 'delivery' ? 'Delivery' : 'Pickup'
        built.push({
          key: 'o' + o.id, created: o.created_at, label: `Order ${o.erp_order_number}`, kind,
          customer: o.erp_name || oc?.name || 'Pickup customer', phone: phoneText(o.erp_phone || oc?.phone || ''), email: oc?.email ?? '', orderId: o.id, orderStatus: o.status,
          paymentLong: o.card_brand && o.card_last4 ? `${o.card_brand} ending ${o.card_last4}` : 'No card on file', location: locName.get(o.location_id) ?? '', lines,
          subtotal, discount, tax, fee, total: subtotal - discount + tax + fee, estimated: true,
          payment: card || 'No card on file',
          status: { label: o.status === 'Order Placed' ? (o.erp_prepared_at ? 'Preparing' : 'Order placed') : o.status, cls: o.status === 'Cancelled' ? 'warn' : 'good' },
          when: stamp(o.pickup_at), address: o.erp_delivery_address ?? undefined, returns: [],
          search: [`order ${o.erp_order_number}`, o.erp_name, (o.erp_phone ?? '').replace(/\D/g, ''), card, locName.get(o.location_id), ...lines.map(l => l.name)].join(' ').toLowerCase(),
        })
      }
      built.sort((a, b) => b.created.localeCompare(a.created))
      setEntries(built); setCapped(wasCapped); setShown(PAGE)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load orders.')
    } finally { setLoading(false) }
  }, [from, to])

  useEffect(() => { void load() }, [load])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const qDigits = q.replace(/\D/g, '')
    return entries.filter(e => {
      if (source !== 'All' && e.kind !== source) return false
      if (returnState === 'With returns' && !e.returns.length) return false
      if (returnState === 'No returns' && e.returns.length) return false
      if (!q) return true
      return e.search.includes(q) || (qDigits.length >= 4 && e.search.includes(qDigits))
    })
  }, [entries, search, source, returnState])

  return (
    <section className="panel p-spaced">
      <div className="panel-head"><div><h2>All orders &amp; receipts</h2><p>Counter sales and online pickup/delivery orders, with customer, items, prices, and card type. Search, reprint a receipt, or start a return.</p></div></div>
      <div className="form-grid two order-history-filters" style={{ marginBottom: 12 }}>
        <div><label className="field-label">From</label><input type="date" value={from} max={to} onChange={e => e.target.value && setFrom(e.target.value)} /></div>
        <div><label className="field-label">To</label><input type="date" value={to} min={from} onChange={e => e.target.value && setTo(e.target.value)} /></div>
      </div>
      <div className="form-grid two order-history-filters" style={{ marginBottom: 12 }}>
        <div><label className="field-label">Search</label>
          <div style={{ position: 'relative' }}><Search size={14} style={{ position: 'absolute', left: 10, top: 12, opacity: .5 }} />
            <input style={{ paddingLeft: 30 }} value={search} onChange={e => { setSearch(e.target.value); setShown(PAGE) }} placeholder="Order #, name, phone, item, card last 4" /></div></div>
        <div className="form-grid two">
          <div><label className="field-label">Order type</label><select value={source} onChange={e => setSource(e.target.value as typeof source)}><option>All</option><option>Counter</option><option>Pickup</option><option>Delivery</option></select></div>
          <div><label className="field-label">Returns</label><select value={returnState} onChange={e => setReturnState(e.target.value as typeof returnState)}><option>All</option><option>With returns</option><option>No returns</option></select></div>
        </div>
      </div>
      {error && <p className="checkout-error" role="alert">{error} <button className="table-action" onClick={() => void load()}>Retry</button></p>}
      {capped && <p className="p-note">Showing the most recent 5,000 sales in this range. Narrow the dates to see older ones.</p>}
      <div className="table-scroll"><table>
        <thead><tr><th>ORDER</th><th>DATE</th><th>TYPE</th><th>CUSTOMER</th><th>LOCATION</th><th>PAYMENT</th><th className="right">TOTAL</th><th>STATUS</th><th></th></tr></thead>
        <tbody>
          {loading ? <tr><td colSpan={9}>Loading orders…</td></tr>
            : filtered.length === 0 ? <tr><td colSpan={9}><div className="empty-inline">No orders match these filters.</div></td></tr>
            : filtered.slice(0, shown).map(e => (
              <tr key={e.key}>
                <td><b className="mono">{e.label}</b></td>
                <td>{stamp(e.created)}</td>
                <td>{e.kind}</td>
                <td>{e.customer}{e.phone && <small className="cell-sub">{e.phone}</small>}</td>
                <td>{e.location.replace(' Store', '')}</td>
                <td>{e.payment}</td>
                <td className="right"><b>{money(e.total)}</b>{e.estimated && <small className="cell-sub">estimated</small>}</td>
                <td><span className={`status-chip ${e.status.cls}`}>{e.status.label}</span></td>
                <td><button className="table-action" onClick={() => setOpen(e)}>View / reprint</button> <button className="table-action" onClick={() => void openImpact(e)}>View impact</button>{e.orderId && e.orderStatus === 'Fulfilled' && <> <button className="table-action" disabled={closing} onClick={() => void closeOrder(e)}>Close order</button></>}</td>
              </tr>))}
        </tbody>
      </table></div>
      <p className="p-note">{filtered.length} order{filtered.length === 1 ? '' : 's'} found.{filtered.length > shown && <> <button className="table-action" onClick={() => setShown(shown + PAGE)}>Show more</button></>}</p>

      {open && (
        <div className="modal-backdrop"><div className="modal receipt-modal">
          <button className="modal-x" aria-label="Close receipt" onClick={() => setOpen(null)}><X size={18} /></button>
          <span className="eyebrow">ORDER DETAILS</span>
          <div className="receipt-paper">
            <div className="receipt-brand">ZA BY ZACK<small>{open.location}</small></div>
            <div className="receipt-row receipt-grand"><b>{open.label}</b><b>{open.kind} order</b></div>
            <div className="receipt-row"><span>Placed</span><b>{stamp(open.created)}</b></div>
            {open.when && <div className="receipt-row"><span>{open.kind === 'Delivery' ? 'Delivery time' : 'Pickup time'}</span><b>{open.when}</b></div>}
            <div className="receipt-row"><span>Location</span><b>{open.location}</b></div>
            <div className="receipt-row"><span>Name</span><b>{open.customer}</b></div>
            <div className="receipt-row"><span>Phone</span><b>{open.phone || 'Not provided'}</b></div>
            {open.email && <div className="receipt-row"><span>Email</span><b>{open.email}</b></div>}
            {open.address && <div className="receipt-row"><span>Deliver to</span><b>{open.address}</b></div>}
            {open.lines.map((l, i) => (<div className="receipt-row" key={i}><span>{l.qty} × {l.name} @ {money(l.price)}</span><b>{money(l.qty * l.price)}</b></div>))}
            <div className="receipt-row"><span>Subtotal</span><b>{money(open.subtotal)}</b></div>
            <div className="receipt-row"><span>Discount</span><b>−{money(open.discount)}</b></div>
            <div className="receipt-row"><span>Tax</span><b>{money(open.tax)}</b></div>
            {open.fee > 0 && <div className="receipt-row"><span>Delivery fee</span><b>{money(open.fee)}</b></div>}
            <div className="receipt-row receipt-grand"><b>Total{open.estimated ? ' (estimated)' : ''}</b><b>{money(open.total)}</b></div>
            <div className="receipt-row"><span>Paid with</span><b>{open.paymentLong}</b></div>
            <div className="receipt-row"><span>Status</span><b>{open.status.label}</b></div>
            {open.returns.map(r => (<div className="receipt-row" key={r.id}><span>{r.transaction_type} · {stamp(r.created_at)}</span><b>−{money(Number(r.refund_total))}</b></div>))}
            <small>{open.label}{open.saleId ? ` · Sale ${open.saleId}` : ''}{open.orderId ? ` · Order ${open.orderId}` : ''}</small>
          </div>
          <button className="button secondary full" onClick={() => printReceipt('.receipt-modal .receipt-paper')}><Printer size={16} /> Print receipt</button>
          <button className="button secondary full" style={{ marginTop: 8 }} onClick={() => void openImpact(open)}>View impact</button>
          {open.orderId && open.orderStatus === 'Fulfilled' && <button className="button secondary full" style={{ marginTop: 8 }} disabled={closing} onClick={() => void closeOrder(open)}>Close order</button>}
          {open.saleId
            ? <button className="button primary full" style={{ marginTop: 8 }} onClick={() => { const id = open.saleId!; setOpen(null); flash('Opening Returns for this order.'); onStartReturn(id) }}><RotateCcw size={16} /> Return or exchange items from this order</button>
            : <p className="p-note">Returns open once this order has been prepared and its sale is recorded.</p>}
        </div></div>
      )}
      {impact && (impact.data
        ? <OrderImpactDialog impact={impact.data} data={impact.plan} paymentLabel={impact.entry.paymentLong} onClose={() => setImpact(null)} />
        : <div className="so-modal-backdrop"><section className="so-impact-modal" role="dialog" aria-modal="true" aria-labelledby="so-impact-title">
            {impact.loading ? <p role="status">Loading saved order, sales, return, and inventory history…</p>
              : <><h2 id="so-impact-title">Order history</h2><p className="p-error" role="alert">{impact.error}</p>
                <button className="button secondary" onClick={() => void openImpact(impact.entry)}>Retry</button>{' '}
                <button className="button secondary" onClick={() => setImpact(null)}>Close</button></>}
          </section></div>)}
    </section>
  )
}
