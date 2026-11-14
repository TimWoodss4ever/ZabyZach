# Supabase setup notes

1. Create a Supabase project and apply the SQL migration in `migrations/`.
2. Create Auth users for the Manager, Cashier, and Customer demo profiles, then add their `profiles` rows with the chosen role. This is an explicit admin action in Supabase; the migration does not create auth users or hard-code passwords.
3. Configure RLS, realtime publication, and environment secrets before replacing browser-local storage with Supabase calls.

The current site does not contain a Supabase project URL or anon key and therefore stays in local demo mode. Keep keys out of source control; do not add a service-role key to browser code.
