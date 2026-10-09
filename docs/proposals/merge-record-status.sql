-- Proposal: ignore legacy browse states during parallel merge review
-- Deploy only after explicit approval. This updates functions only and preserves all rows.

-- Additive function update only: no existing rows, schema columns or policies change.
-- Blank stored field keys and automatic start times are not experimental records.
create or replace function public.research_has_recorded_value(p_value jsonb)
returns boolean language plpgsql immutable security invoker set search_path=public as $$
declare v_child jsonb; v_spaces text := E' \t\n\r\v\f' || chr(160) || chr(5760)
  || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198)
  || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239)
  || chr(8287) || chr(12288) || chr(65279);
begin
  if p_value is null or p_value='null'::jsonb then return false; end if;
  case jsonb_typeof(p_value)
    when 'string' then return btrim(p_value #>> '{}',v_spaces)<>'';
    when 'number' then return true;
    when 'boolean' then return true;
    when 'array' then
      for v_child in select value from jsonb_array_elements(p_value) loop
        if public.research_has_recorded_value(v_child) then return true; end if;
      end loop;
    when 'object' then
      for v_child in select value from jsonb_each(p_value) loop
        if public.research_has_recorded_value(v_child) then return true; end if;
      end loop;
    else return false;
  end case;
  return false;
end $$;
revoke all on function public.research_has_recorded_value(jsonb) from public,anon;
grant execute on function public.research_has_recorded_value(jsonb) to authenticated;

create or replace function public.research_review_merge(p_run_ids bigint[],p_after_position integer)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare v_run public.experiment_runs%rowtype; v_id bigint; v_schema jsonb;
  v_reference jsonb; v_count integer; v_versions jsonb:='{}'; v_steps jsonb;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  if coalesce(cardinality(p_run_ids),0) not between 2 and 8
    or exists(select 1 from unnest(p_run_ids) x where x is null)
    or (select count(distinct x) from unnest(p_run_ids) x) <> cardinality(p_run_ids) then
    raise exception '请选择 2 至 8 个不同的平行实验';
  end if;
  if p_after_position is null or p_after_position<0 then raise exception '合并边界不合法'; end if;
  foreach v_id in array p_run_ids loop
    select * into v_run from public.experiment_runs where id=v_id and user_id=auth.uid();
    if not found or v_run.status<>'running' then raise exception '实验不存在、无权访问或已结束'; end if;
    if exists(select 1 from public.experiment_merge_members where parent_run_id=v_id)
      or exists(select 1 from public.experiment_merge_groups where result_run_id=v_id) then
      raise exception '实验已属于共同阶段，不能重复或嵌套合并';
    end if;
    if exists(select 1 from public.run_steps where (run_id=v_id or link_run_id=v_id) and link_run_id is not null) then
      raise exception '请先处理旧关联；新合并不会自动转换或覆盖旧关系';
    end if;
    if exists(select 1 from public.run_steps where run_id=v_id and user_id<>auth.uid()) then
      raise exception '实验步骤归属不一致，请先核对数据';
    end if;
    select count(*) into v_count from public.run_steps where run_id=v_id and user_id=auth.uid();
    if v_count<2 or p_after_position>=v_count-1 then raise exception '合并后必须至少保留一个共同步骤'; end if;
    if exists(select 1 from generate_series(0,v_count-1) pos
      where not exists(select 1 from public.run_steps where run_id=v_id and position=pos and user_id=auth.uid())) then
      raise exception '步骤序号不连续，不能安全合并';
    end if;
    v_schema:=public.research_merge_schema(v_id);
    if v_reference is null then v_reference:=v_schema;
    elsif v_reference<>v_schema then
      raise exception '前置或后置步骤不一致：请核对顺序、说明、字段、单位、注意事项、时长和热解条件';
    end if;
    if exists(select 1 from public.run_steps where run_id=v_id and position<=p_after_position and status<>'done') then
      raise exception '每个平行实验都必须先完成合并前的所有步骤';
    end if;
    if exists(select 1 from public.run_steps where run_id=v_id and position>p_after_position
      and (status='done' or public.research_has_recorded_value(values) or public.research_has_recorded_value(to_jsonb(note)) or images<>'[]'::jsonb
        or finished_at is not null or case when jsonb_typeof(checks)='object' then
          exists(select 1 from jsonb_each(checks) c where c.value not in ('false'::jsonb,'"false"'::jsonb) and public.research_has_recorded_value(c.value))
          else checks not in ('false'::jsonb,'"false"'::jsonb) and public.research_has_recorded_value(checks) end)) then
      raise exception '合并后的步骤已有记录；为避免丢失或混淆数据，禁止合并';
    end if;
    select jsonb_agg(jsonb_build_object('id',id,'updated_at',updated_at) order by position)
      into v_steps from public.run_steps where run_id=v_id and user_id=auth.uid();
    v_versions:=v_versions||jsonb_build_object(v_id::text,jsonb_build_object('updated_at',v_run.updated_at,'steps',v_steps));
  end loop;
  return jsonb_build_object('allowed',true,'after_position',p_after_position,
    'schema',v_reference,'versions',v_versions,'run_ids',to_jsonb(p_run_ids));
end $$;

revoke all on function public.research_review_merge(bigint[],integer) from public,anon;
grant execute on function public.research_review_merge(bigint[],integer) to authenticated;
