import { useEffect, useState } from 'react'
import type { InputHTMLAttributes } from 'react'

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value'> & {
  value: number | string
}

// A number box you can actually clear. The old boxes pushed "0" straight back in
// when you deleted it, so you could never replace it. While the box is focused it
// shows exactly what you type (including an empty box); the page still receives
// every change, and min/max/step rules still apply on submit. When you leave the
// box it shows the page's real value again.
export function NumberInput({ value, onChange, onFocus, onBlur, ...rest }: Props) {
  const [draft, setDraft] = useState<string | null>(null)

  useEffect(() => {
    // Keep in step if the page changes the value while the box is focused
    // (for example a scan or a clamp to the maximum).
    if (draft !== null && draft !== '' && Number(draft) !== Number(value)) setDraft(String(value))
  }, [value]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <input
      {...rest}
      type="number"
      value={draft ?? String(value)}
      onFocus={(e) => {
        setDraft(String(value))
        e.currentTarget.select()
        onFocus?.(e)
      }}
      onChange={(e) => {
        setDraft(e.target.value)
        onChange?.(e)
      }}
      onBlur={(e) => {
        setDraft(null)
        onBlur?.(e)
      }}
    />
  )
}
