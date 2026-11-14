# Supabase setup notes

1. Create a Supabase project and apply the SQL migration in `migrations/`.
2. Create Auth users for the Manager, Cashier, and Customer demo profiles, then add their `profiles` rows with the chosen role. This is an explicit admin action in Supabase; the migration does not create auth users or hard-code passwords.
3. Configure RLS, realtime publication, and environment secrets before replacing browser-local storage with Supabase calls.

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in the app's environment to enable email-and-password sign-in. After authentication, the app reads the signed-in user's `role` and `customer_id` from their `profiles` row. ERP data continues to use browser-local storage. Keep environment values out of source control; do not use a service-role key in browser code.
