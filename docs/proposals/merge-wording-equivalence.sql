-- v1.2.3 proposal: allow wording and scale differences in completed parallel branches.
-- Shared suffix controls remain strict. No rows, columns, attachments or ownership data change.

create or replace function public.research_merge_text(p_text text, p_strip_numbers boolean default false)
returns text language plpgsql immutable set search_path=public as $$
declare v_text text := lower(coalesce(p_text,''));
begin
  v_text:=replace(v_text,'称取','称量');
  v_text:=replace(v_text,'加入','添加');
  v_text:=replace(v_text,'倒入','添加');
  v_text:=replace(v_text,'添加到','添加');
  v_text:=replace(v_text,'添加入','添加');
  v_text:=replace(v_text,'离心分离','离心');
  v_text:=replace(v_text,'烘干','干燥');
  v_text:=replace(v_text,'清洗','洗涤');
  v_text:=replace(v_text,'摄氏度','℃');
  v_text:=replace(v_text,'度','℃');
  v_text:=replace(v_text,'小时','h');
  v_text:=replace(v_text,'分钟','min');
  v_text:=replace(v_text,'并','');
  v_text:=replace(v_text,'将','');
  if p_strip_numbers then
    v_text:=regexp_replace(v_text,'[-+]?[0-9]+([.][0-9]+)?','','g');
  end if;
  v_text:=regexp_replace(v_text,'[[:space:]]+','','g');
  v_text:=regexp_replace(v_text,'[，。；：、（）()【】\[\]{}「」『』<>《》,.;:!?！？/\\]+','','g');
  return v_text;
end $$;

create or replace function public.research_merge_critical_text(p_text text)
returns text language sql immutable set search_path=public as $$
  select coalesce(string_agg(replace(m.match[1],' ',''),'|' order by m.ord),'')
  from regexp_matches(lower(coalesce(p_text,'')),
    '([-+]?[0-9]+(?:[.][0-9]+)?[[:space:]]*(?:mol/l|rpm|kpa|mpa|mbar|bar|mM|mmol|mol|pa|℃|°c|小时|分钟|min|秒|天|h|s|转|ph|k|%))(?:[^[:alpha:]]|$)','gi') with ordinality as m(match,ord)
$$;

create or replace function public.research_merge_review_schema(p_run_id bigint, p_after_position integer)
returns jsonb language sql stable security invoker set search_path=public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'position',s.position,
    'operation',public.research_merge_text(coalesce(s.title,'')||'|'||coalesce(s.instruction,'')||'|'||coalesce(s.notice,''),s.position<=p_after_position),
    'critical',public.research_merge_critical_text(coalesce(s.title,'')||'|'||coalesce(s.instruction,'')||'|'||coalesce(s.notice,'')),
    'pyro_seq',public.research_merge_text(s.pyro_seq),
    'duration_hint',public.research_merge_text(s.duration_hint),
    'fields',(select coalesce(jsonb_agg(jsonb_build_object('label',public.research_merge_text(f->>'label'),'unit',regexp_replace(coalesce(f->>'unit',''),'[[:space:]]+','','g'),'type',coalesce(f->>'type','text')) order by ord),'[]')
      from jsonb_array_elements(coalesce(s.fields,'[]'::jsonb)) with ordinality as fields(f,ord)),
    'checklist',coalesce(to_jsonb(s)->'checklist','[]')
  ) order by s.position),'[]')
  from public.run_steps s
  where s.run_id=p_run_id and s.user_id=auth.uid()
$$;

create or replace function public.research_review_merge(p_run_ids bigint[],p_after_position integer)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare v_run public.experiment_runs%rowtype; v_id bigint; v_schema jsonb;
  v_reference jsonb; v_count integer; v_versions jsonb:='{}'; v_steps jsonb;
  v_warnings jsonb:='[]'; v_only jsonb;
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
    v_schema:=public.research_merge_review_schema(v_id,p_after_position);
    if v_reference is null then v_reference:=v_schema;
    elsif v_reference<>v_schema then
      raise exception '前置或后置步骤的关键条件、结构或字段不一致；请核对温度、时间、浓度、气氛、顺序、字段和单位';
    end if;
    if exists(select 1 from public.run_steps s where s.run_id=v_id and s.position<=p_after_position
      and not (s.status='done' or s.finished_at is not null)) then
      raise exception '每个平行实验都必须先完成合并前的所有步骤';
    end if;
    select jsonb_agg(jsonb_build_object('run_id',v_id,'position',s.position,'reason','只有完成标记，没有有效填写') order by s.position)
      into v_only from public.run_steps s where s.run_id=v_id
      and (s.status='done' or s.finished_at is not null)
      and not public.research_step_has_recorded_input(s.values,s.note,s.images,s.checks);
    v_warnings:=v_warnings||coalesce(v_only,'[]'::jsonb);
    if exists(select 1 from public.run_steps s where s.run_id=v_id and s.position>p_after_position
      and public.research_step_has_recorded_input(s.values,s.note,s.images,s.checks)) then
      raise exception '合并后的步骤已有有效实验记录；为避免丢失或混淆数据，禁止合并';
    end if;
    select jsonb_agg(jsonb_build_object('id',id,'updated_at',updated_at) order by position)
      into v_steps from public.run_steps where run_id=v_id and user_id=auth.uid();
    v_versions:=v_versions||jsonb_build_object(v_id::text,jsonb_build_object('updated_at',v_run.updated_at,'steps',v_steps));
  end loop;
  return jsonb_build_object('allowed',true,'after_position',p_after_position,
    'schema',v_reference,'versions',v_versions,'run_ids',to_jsonb(p_run_ids),'warnings',v_warnings);
end $$;

revoke all on function public.research_merge_text(text,boolean),public.research_merge_critical_text(text),public.research_merge_review_schema(bigint,integer),public.research_review_merge(bigint[],integer) from public,anon;
grant execute on function public.research_merge_text(text,boolean),public.research_merge_critical_text(text),public.research_merge_review_schema(bigint,integer),public.research_review_merge(bigint[],integer) to authenticated;
