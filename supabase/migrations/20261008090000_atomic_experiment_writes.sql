-- 2026-10-08 用户已明确授权新增并部署这两个事务接口。
-- 部署只新增两个 RPC，不改表、字段，不清理现存数据。
-- RPC 在用户点击保存/完成时执行，失败会整笔回滚。
create or replace function public.research_save_plan(
  p_id bigint, p_title text, p_source text, p_steps jsonb,
  p_parse_version integer, p_version_log jsonb, p_expected_updated_at timestamptz
) returns bigint language plpgsql security invoker set search_path = public as $$
declare v_id bigint; v_updated timestamptz;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  if nullif(btrim(p_title), '') is null or length(p_title)>200
    or p_steps is null or jsonb_typeof(p_steps) is distinct from 'array' then
    raise exception '方案标题或步骤不合法';
  end if;
  if jsonb_array_length(p_steps) not between 1 and 200 then raise exception '步骤数量应为 1 至 200'; end if;
  if exists(select 1 from jsonb_array_elements(p_steps) as x(item)
    where jsonb_typeof(item) is distinct from 'object'
      or jsonb_typeof(coalesce(item->'fields','[]')) is distinct from 'array') then
    raise exception '步骤或字段格式不合法';
  end if;
  if exists(select 1 from jsonb_array_elements(p_steps) as x(item)
    where exists(select 1 from jsonb_array_elements(coalesce(item->'fields','[]')) as f(field)
      group by btrim(field->>'label') having count(*)>1)) then
    raise exception '同一步骤的字段名不可重复';
  end if;
  if p_id is null then
    insert into experiment_plans(user_id,title,source,parse_version,version_log)
      values(auth.uid(),p_title,coalesce(p_source,''),p_parse_version,coalesce(p_version_log,'[]'))
      returning id into v_id;
  else
    select updated_at into v_updated from experiment_plans
      where id=p_id and user_id=auth.uid() for update;
    if not found then raise exception '方案不存在或无权操作'; end if;
    if p_expected_updated_at is null or v_updated <> p_expected_updated_at then
      raise exception '方案已被其他设备修改，请重新打开后核对';
    end if;
    v_id := p_id;
    update experiment_plans set title=p_title,source=coalesce(p_source,''),
      parse_version=p_parse_version,version_log=coalesce(p_version_log,'[]') where id=v_id;
    delete from plan_steps where plan_id=v_id and user_id=auth.uid();
  end if;
  insert into plan_steps(user_id,plan_id,position,title,instruction,fields,duration_hint,notice,pyro_seq,checklist)
    select auth.uid(),v_id,(ord-1)::integer,coalesce(item->>'title',''),
      coalesce(item->>'instruction',''),coalesce(item->'fields','[]'),
      coalesce(item->>'duration_hint',''),coalesce(item->>'notice',''),
      coalesce(item->>'pyro_seq',''),'[]'::jsonb
    from jsonb_array_elements(p_steps) with ordinality as x(item,ord);
  return v_id;
end $$;
revoke all on function public.research_save_plan(bigint,text,text,jsonb,integer,jsonb,timestamptz) from public,anon;
grant execute on function public.research_save_plan(bigint,text,text,jsonb,integer,jsonb,timestamptz) to authenticated;

create or replace function public.research_finish_run(p_id bigint,p_content text,p_date date)
returns bigint language plpgsql security invoker set search_path = public as $$
declare v_run experiment_runs%rowtype; v_record bigint; v_last integer;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  if nullif(btrim(p_content),'') is null then raise exception '日志内容不能为空'; end if;
  select * into v_run from experiment_runs where id=p_id and user_id=auth.uid() for update;
  if not found then raise exception '实验不存在或无权操作'; end if;
  if v_run.status='aborted' then raise exception '已终止的实验不能完成'; end if;
  select id into v_record from research_records where user_id=auth.uid()
    and tags @> array['experiment:'||p_id::text] order by id limit 1;
  if v_run.status='done' then return v_record; end if;
  select max(position) into v_last from run_steps where run_id=p_id and user_id=auth.uid();
  if v_last is null then raise exception '实验没有步骤'; end if;
  if not exists(select 1 from run_steps where run_id=p_id and position=v_last and status='done' and user_id=auth.uid()) then
    raise exception '最后一步尚未保存完成';
  end if;
  if v_record is null then
    insert into research_records(user_id,title,category,content,tags,occurred_on)
      values(auth.uid(),v_run.title||' · 实验日志','实验日志',p_content,
        array['实验日志','experiment:'||p_id::text],coalesce(p_date,current_date)) returning id into v_record;
  end if;
  update experiment_runs set status='done',current_step=v_last,finished_at=now() where id=p_id;
  return v_record;
end $$;
revoke all on function public.research_finish_run(bigint,text,date) from public,anon;
grant execute on function public.research_finish_run(bigint,text,date) to authenticated;
