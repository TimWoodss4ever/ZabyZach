-- Disposable CI database only. Never run bootstrap or fixture tests in Supabase.
create role anon nologin;
create role authenticated nologin;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema public,auth to authenticated,anon;
grant execute on function auth.uid() to authenticated,anon;

-- Supabase supplies this publication in production; mirror it in disposable CI.
create publication supabase_realtime;
