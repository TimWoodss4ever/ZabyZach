begin;

do $migration$
declare
  v_updated integer;
  v_present integer;
  v_ids uuid[] := array['14e0f65b-66d6-5895-9712-06eb2fb5dc01'::uuid,'c0a0db68-4911-5c4c-a532-c62dcb05afc1'::uuid,'c7c56a65-8c4c-5513-ba4d-2ab6db9a5216'::uuid,'d60ff8d9-b756-58f4-87ad-36a38cac8788'::uuid,'2269feaa-c999-5b27-a475-94981b120925'::uuid,'9ea1bd08-fd05-558b-99ad-f0c8a311cfa2'::uuid,'172aa326-1dd7-533e-af55-6900c810f9d5'::uuid,'eec51a44-e447-5deb-ad4f-3bc82cc2bf2f'::uuid];
begin
  select count(*) into v_present from public.inventory_transactions where id=any(v_ids);
  if v_present=0 then raise notice 'Verified seed rows are absent; no timestamp repair is needed';return;end if;
  if v_present<>8 then raise exception 'Only % of the 8 verified seed receipts exist; no records changed',v_present;end if;
  if (select count(*) from public.inventory_transactions where id=any(v_ids)
    and occurred_at=timestamptz '2026-05-17 05:59:59.999999+00'
    and metadata->>'original_occurred_at'='2026-05-18T06:00:00.000000Z'
    and metadata->>'correction_reason'='Correct synthetic opening stock timestamp to precede the matching May 17 production withdrawal; retain the original timestamp in metadata.')=8 then
    raise notice 'Verified seed timestamp repair already applied';return;
  end if;
  update public.inventory_transactions as t
  set
    occurred_at = timestamptz '2026-05-17 05:59:59.999999+00',
    metadata = t.metadata || jsonb_build_object(
      'original_occurred_at',
        to_char(
          t.occurred_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ),
      'correction_reason',
        'Correct synthetic opening stock timestamp to precede the matching May 17 production withdrawal; retain the original timestamp in metadata.'
    )
  from (
    values
      (
        '14e0f65b-66d6-5895-9712-06eb2fb5dc01'::uuid,
        '1001'::text,
        '11067339-4806-46db-a53d-693d02ff7011'::uuid,
        146120::numeric,
        0.04::numeric,
        17036,
        'OPEN-TOPUP-1001-Orem Store'::text,
        '84ccf91e-dee3-5195-a149-320f2d53711c'::uuid,
        -140400::numeric,
        17029,
        'H-DOUGH-Orem Store-1001'::text
      ),
      (
        'c0a0db68-4911-5c4c-a532-c62dcb05afc1'::uuid,
        '1001'::text,
        '187f938b-398e-4f2b-a662-97e8d8e476db'::uuid,
        196258::numeric,
        0.04::numeric,
        17035,
        'OPEN-TOPUP-1001-Provo Campus Store'::text,
        '78166f3c-a292-52ca-be47-b8f52017a934'::uuid,
        -189120::numeric,
        17023,
        'H-DOUGH-Provo Campus Store-1001'::text
      ),
      (
        'c7c56a65-8c4c-5513-ba4d-2ab6db9a5216'::uuid,
        '1021'::text,
        '11067339-4806-46db-a53d-693d02ff7011'::uuid,
        3038::numeric,
        0.2::numeric,
        17076,
        'OPEN-TOPUP-1021-Orem Store'::text,
        'ca3a4338-b317-5000-bf94-6b7962fe7832'::uuid,
        -2925::numeric,
        17030,
        'H-DOUGH-Orem Store-1021'::text
      ),
      (
        'd60ff8d9-b756-58f4-87ad-36a38cac8788'::uuid,
        '1021'::text,
        '187f938b-398e-4f2b-a662-97e8d8e476db'::uuid,
        4079::numeric,
        0.2::numeric,
        17075,
        'OPEN-TOPUP-1021-Provo Campus Store'::text,
        'd2246b8e-956e-568e-b530-496f078567bf'::uuid,
        -3940::numeric,
        17024,
        'H-DOUGH-Provo Campus Store-1021'::text
      ),
      (
        '2269feaa-c999-5b27-a475-94981b120925'::uuid,
        '1022'::text,
        '11067339-4806-46db-a53d-693d02ff7011'::uuid,
        3616::numeric,
        0.08::numeric,
        17078,
        'OPEN-TOPUP-1022-Orem Store'::text,
        'cdaf62c2-9f49-5898-80f2-0952df8c5da8'::uuid,
        -3656.25::numeric,
        17031,
        'H-DOUGH-Orem Store-1022'::text
      ),
      (
        '9ea1bd08-fd05-558b-99ad-f0c8a311cfa2'::uuid,
        '1022'::text,
        '187f938b-398e-4f2b-a662-97e8d8e476db'::uuid,
        4818::numeric,
        0.08::numeric,
        17077,
        'OPEN-TOPUP-1022-Provo Campus Store'::text,
        '1a256bb2-33c0-5de6-aa1e-ed8d964aa142'::uuid,
        -4925::numeric,
        17025,
        'H-DOUGH-Provo Campus Store-1022'::text
      ),
      (
        '172aa326-1dd7-533e-af55-6900c810f9d5'::uuid,
        '1024'::text,
        '11067339-4806-46db-a53d-693d02ff7011'::uuid,
        84542::numeric,
        0.001::numeric,
        17080,
        'OPEN-TOPUP-1024-Orem Store'::text,
        'd89ce9ec-4af7-5cf4-a657-4c5cf7cd2c99'::uuid,
        -84825::numeric,
        17033,
        'H-DOUGH-Orem Store-1024'::text
      ),
      (
        'eec51a44-e447-5deb-ad4f-3bc82cc2bf2f'::uuid,
        '1024'::text,
        '187f938b-398e-4f2b-a662-97e8d8e476db'::uuid,
        113354::numeric,
        0.001::numeric,
        17079,
        'OPEN-TOPUP-1024-Provo Campus Store'::text,
        '1f1575b1-dffd-5a73-bc7d-a6eb0a877708'::uuid,
        -114260::numeric,
        17027,
        'H-DOUGH-Provo Campus Store-1024'::text
      )
  ) as e(
    receipt_id,
    item_sku,
    location_id,
    receipt_quantity,
    unit_cost,
    receipt_source_row,
    receipt_demo_id,
    production_id,
    production_quantity,
    production_source_row,
    production_demo_id
  )
  where t.id = e.receipt_id
    and t.item_sku = e.item_sku
    and t.location_id = e.location_id
    and t.quantity = e.receipt_quantity
    and t.unit_cost = e.unit_cost
    and t.transaction_type = 'Receipt'
    and t.reference_document = 'Seed opening stock'
    and t.occurred_at = timestamptz '2026-05-18 06:00:00+00'
    and t.metadata = jsonb_build_object(
      'source_row', e.receipt_source_row,
      'source_demo_id', e.receipt_demo_id
    )
    and exists (
      select 1
      from public.inventory_transactions as p
      where p.id = e.production_id
        and p.item_sku = e.item_sku
        and p.location_id = e.location_id
        and p.quantity = e.production_quantity
        and p.unit_cost = e.unit_cost
        and p.transaction_type = 'Production'
        and p.reference_document = 'Historical in-house dough production'
        and p.occurred_at = timestamptz '2026-05-17 06:00:00+00'
        and p.metadata = jsonb_build_object(
          'source_row', e.production_source_row,
          'source_demo_id', e.production_demo_id
        )
    );

  get diagnostics v_updated = row_count;

  if v_updated <> 8 then
    raise exception
      'Expected to retime exactly 8 verified seed receipts; updated %',
      v_updated;
  end if;
end
$migration$;

commit;
