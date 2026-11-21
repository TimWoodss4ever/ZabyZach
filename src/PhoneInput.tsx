import { useState } from 'react'
import { formatCustomerPhone, normalizeCustomerPhone } from './domain'

// A phone box that only accepts digits and shows (801) 555-0123 as you type.
// It works inside plain <form> submits (it has a name) and blocks the form until
// the number is a full 10-digit US number (or blank, when optional).
export function PhoneInput({
  name, defaultValue = '', required = false, id, placeholder = '(801) 555-0123',
}: { name: string; defaultValue?: string; required?: boolean; id?: string; placeholder?: string }) {
  const [value, setValue] = useState(formatCustomerPhone(defaultValue))
  const valid = !value.trim() ? !required : !!normalizeCustomerPhone(value)
  return (
    <input
      id={id}
      name={name}
      type="tel"
      inputMode="tel"
      autoComplete="tel-national"
      maxLength={14}
      required={required}
      value={value}
      placeholder={placeholder}
      onChange={(e) => {
        const el = e.currentTarget
        setValue(formatCustomerPhone(el.value))
        el.setCustomValidity('')
      }}
      onInvalid={(e) => e.currentTarget.setCustomValidity('Enter a 10-digit US phone number.')}
      ref={(el) => { if (el) el.setCustomValidity(valid ? '' : 'Enter a 10-digit US phone number.') }}
    />
  )
}
