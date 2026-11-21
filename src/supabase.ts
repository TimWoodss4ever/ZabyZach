import { createClient } from '@supabase/supabase-js'

// Each browser tab gets its own login. Without this, Supabase keeps ONE login
// for the whole browser (and tells every other tab when it changes), so a
// customer in one tab and a manager in another would keep overwriting each other.
// sessionStorage is private to a tab, and a per-tab storage key also keeps the
// tabs from broadcasting sign-in/sign-out events to each other.
const tabId = (() => {
  try {
    let id = window.sessionStorage.getItem('zaby-tab-id')
    if (!id) {
      id = crypto.randomUUID()
      window.sessionStorage.setItem('zaby-tab-id', id)
    }
    return id
  } catch {
    return 'default'
  }
})()

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      storage: window.sessionStorage,
      storageKey: `zaby-auth-${tabId}`,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  }
)
