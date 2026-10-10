-- v1.2.5: allow legacy project assignment for frozen merged runs.
-- This migration changes only the merge guard. It does not change experiment
-- facts, run steps, values, attachments, status, or merge membership.

create or replace function public.research_guard_merged_run()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_common boolean;
begin
  if exists(select 1 from public.experiment_merge_members where parent_run_id=old.id) then
    -- Project assignment is metadata added after the run was created. Permit
    -- this one-column change so legacy rows can enter a project workspace.
    if TG_OP='UPDATE'
       and new.project_id is distinct from old.project_id
       and row(new.user_id,new.plan_id,new.title,new.status,new.current_step,
               new.started_at,new.finished_at,new.created_at)
           is not distinct from
           row(old.user_id,old.plan_id,old.title,old.status,old.current_step,
               old.started_at,old.finished_at,old.created_at) then
      return new;
    end if;
    raise exception '已合并的平行支路不可修改或删除';
  end if;
  select exists(select 1 from public.experiment_merge_groups where result_run_id=old.id) into v_common;
  if v_common then
    if TG_OP='DELETE' then raise exception '合并链路需保留，不能直接删除共同阶段'; end if;
    if old.status<>'running' or new.user_id<>old.user_id or new.plan_id is distinct from old.plan_id then
      raise exception '共同阶段归属或已完成记录不可修改';
    end if;
    if new.status='done' and exists(select 1 from public.run_steps where run_id=old.id and status<>'done') then
      raise exception '共同阶段的所有步骤必须完成后才能结束';
    end if;
  end if;
  return new;
end $$;

revoke all on function public.research_guard_merged_run() from public, anon;
