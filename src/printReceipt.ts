// Prints ONE receipt on its own page. The old print rules hid the whole pop-up window
// (the receipt lives inside it), so nothing was left to print and the page came out
// blank. Here the receipt is copied into a print-only area directly under <body>, and
// the print styles hide everything else while it is there.
export function printReceipt(selector: string) {
  const source = document.querySelector(selector)
  if (!source) { window.print(); return }
  const holder = document.createElement('div')
  holder.id = 'print-root'
  holder.innerHTML = source.outerHTML
  document.body.appendChild(holder)
  document.body.classList.add('printing-receipt')
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    holder.remove()
    document.body.classList.remove('printing-receipt')
    window.removeEventListener('afterprint', cleanup)
  }
  window.addEventListener('afterprint', cleanup)
  window.setTimeout(cleanup, 120000)
  window.print()
}
