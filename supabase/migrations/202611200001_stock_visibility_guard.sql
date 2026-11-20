-- Existing item locks serialize writes, but now() is the transaction START time.
-- An older waiting request must see deductions committed by a newer winner.
-- Use the current clock only for the two availability cutoffs after locking.
-- No business rows, order lifecycle, amounts or API signatures are changed.
begin;
do $guard$
declare target regprocedure:=to_regprocedure('public.erp_plan_post_sale(uuid,jsonb,numeric,numeric,uuid)');
 definition text; patched text; old_count integer; new_count integer;
begin
 -- The disposable CI loader defers the base MRP installation. The current MRP
 -- regression suite reapplies this guard after the final engine is installed.
 if target is null then
  raise notice 'Base MRP posting helper not installed yet. Reapply this guard after MRP.';
  return;
 end if;
 if not (select prosecdef and provolatile='v' from pg_proc where oid=target) then
  raise exception 'Unexpected posting helper permissions or volatility; review before installing';
 end if;
 definition:=pg_get_functiondef(target);
 old_count:=regexp_count(definition,'occurred_at\s*<=\s*now\s*\(\s*\)',1,'i');
 new_count:=regexp_count(definition,'occurred_at\s*<=\s*clock_timestamp\s*\(\s*\)',1,'i');
 if old_count=2 and new_count=0 then
  patched:=regexp_replace(definition,'occurred_at\s*<=\s*now\s*\(\s*\)','occurred_at<=clock_timestamp()','gi');
  execute patched;
 elsif old_count<>0 or new_count<>2 then
  raise exception 'Unexpected stock predicates in posting helper; no function changed';
 end if;
 revoke all on function public.erp_plan_post_sale(uuid,jsonb,numeric,numeric,uuid) from public,anon,authenticated;
end $guard$;
commit;
select case when to_regprocedure('public.erp_plan_post_sale(uuid,jsonb,numeric,numeric,uuid)') is null
 then 'Posting helper not installed yet; reapply stock visibility guard after MRP.'
 else 'Stock visibility guard installed. Existing orders, inventory, sales and amounts were not changed.' end as result;
