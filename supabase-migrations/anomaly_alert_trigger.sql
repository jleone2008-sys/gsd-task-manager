-- Phase 7 — anomaly alert trigger on oura_daily.
--
-- After every INSERT or UPDATE on oura_daily, compare today's metrics
-- against the user's 30-day baseline (from v_user_baselines_30d). If
-- any tracked metric is >2σ from baseline, write a row to
-- pending_anomaly_alerts. The next daily brief reads those rows and
-- leads with them.
--
-- Metrics tracked:
--   - sleep_score   (low = bad, surface for direction='below')
--   - readiness_score
--   - hrv_ms
--   - resting_hr    (high = bad, surface for direction='above')
--
-- Implementation notes:
--   - We use simple z-score: (value - baseline_median) / baseline_p75-p25 / 1.349
--     (IQR-based stddev is more robust than sample stddev for small n).
--     The baseline view exposes the percentiles already.
--   - Triggers only fire when the baseline has n>=14 days — fewer than
--     that and we can't reliably z-score.
--   - We skip duplicate alerts: if a row for the same (user_id,
--     for_date, metric) already exists unconsumed, don't insert.
--   - DEFINER security so the trigger can write to
--     pending_anomaly_alerts even though oura_daily rows are written
--     by the cron sync (service-key path, not user JWT).

create or replace function public._oura_anomaly_check() returns trigger
language plpgsql security definer as $$
declare
  v_user_id uuid;
  v_baselines record;
  v_iqr numeric;
  v_z numeric;
  v_dir text;
begin
  -- Resolve user_id from user_email on the row (oura_daily uses email).
  select id into v_user_id
    from auth.users
   where lower(email) = lower(NEW.user_email)
   limit 1;
  if v_user_id is null then return NEW; end if;

  -- Pull baseline once
  select * into v_baselines from public.v_user_baselines_30d where user_id = v_user_id;
  if v_baselines is null or coalesce(v_baselines.n_days_sleep, 0) < 14 then
    return NEW;
  end if;

  -- Helper inline — for each tracked metric, compute z and insert if |z|>2.
  -- (Repeated blocks because PL/pgSQL doesn't have a clean way to
  -- iterate dynamically named columns without dynamic SQL noise.)

  -- sleep_score (low = anomaly)
  if NEW.sleep_score is not null and v_baselines.sleep_score_median is not null then
    v_iqr := coalesce(v_baselines.sleep_score_p75 - v_baselines.sleep_score_p25, 0);
    if v_iqr > 0 then
      v_z := (NEW.sleep_score - v_baselines.sleep_score_median) / (v_iqr / 1.349);
      if abs(v_z) >= 2 then
        v_dir := case when v_z < 0 then 'below' else 'above' end;
        insert into public.pending_anomaly_alerts
          (user_id, for_date, metric, value, baseline_value, z_score, direction)
        select v_user_id, NEW.date, 'sleep_score', NEW.sleep_score, v_baselines.sleep_score_median, v_z, v_dir
        where not exists (
          select 1 from public.pending_anomaly_alerts
           where user_id = v_user_id and for_date = NEW.date
             and metric = 'sleep_score' and consumed_at is null
        );
      end if;
    end if;
  end if;

  -- readiness_score
  if NEW.readiness_score is not null and v_baselines.readiness_score_median is not null then
    v_iqr := coalesce(v_baselines.readiness_score_p75 - v_baselines.readiness_score_p25, 0);
    if v_iqr > 0 then
      v_z := (NEW.readiness_score - v_baselines.readiness_score_median) / (v_iqr / 1.349);
      if abs(v_z) >= 2 then
        v_dir := case when v_z < 0 then 'below' else 'above' end;
        insert into public.pending_anomaly_alerts
          (user_id, for_date, metric, value, baseline_value, z_score, direction)
        select v_user_id, NEW.date, 'readiness_score', NEW.readiness_score, v_baselines.readiness_score_median, v_z, v_dir
        where not exists (
          select 1 from public.pending_anomaly_alerts
           where user_id = v_user_id and for_date = NEW.date
             and metric = 'readiness_score' and consumed_at is null
        );
      end if;
    end if;
  end if;

  -- hrv_ms (low = anomaly)
  if NEW.hrv_ms is not null and v_baselines.hrv_ms_median is not null then
    v_iqr := coalesce(v_baselines.hrv_ms_p75 - v_baselines.hrv_ms_p25, 0);
    if v_iqr > 0 then
      v_z := (NEW.hrv_ms - v_baselines.hrv_ms_median) / (v_iqr / 1.349);
      if abs(v_z) >= 2 then
        v_dir := case when v_z < 0 then 'below' else 'above' end;
        insert into public.pending_anomaly_alerts
          (user_id, for_date, metric, value, baseline_value, z_score, direction)
        select v_user_id, NEW.date, 'hrv_ms', NEW.hrv_ms, v_baselines.hrv_ms_median, v_z, v_dir
        where not exists (
          select 1 from public.pending_anomaly_alerts
           where user_id = v_user_id and for_date = NEW.date
             and metric = 'hrv_ms' and consumed_at is null
        );
      end if;
    end if;
  end if;

  -- resting_hr (high = anomaly — concerning when elevated)
  if NEW.resting_hr is not null and v_baselines.resting_hr_median is not null then
    v_iqr := coalesce(v_baselines.resting_hr_p75 - v_baselines.resting_hr_p25, 0);
    if v_iqr > 0 then
      v_z := (NEW.resting_hr - v_baselines.resting_hr_median) / (v_iqr / 1.349);
      if abs(v_z) >= 2 then
        v_dir := case when v_z < 0 then 'below' else 'above' end;
        insert into public.pending_anomaly_alerts
          (user_id, for_date, metric, value, baseline_value, z_score, direction)
        select v_user_id, NEW.date, 'resting_hr', NEW.resting_hr, v_baselines.resting_hr_median, v_z, v_dir
        where not exists (
          select 1 from public.pending_anomaly_alerts
           where user_id = v_user_id and for_date = NEW.date
             and metric = 'resting_hr' and consumed_at is null
        );
      end if;
    end if;
  end if;

  return NEW;
end;
$$;

drop trigger if exists oura_anomaly_check on public.oura_daily;
create trigger oura_anomaly_check
  after insert or update on public.oura_daily
  for each row execute function public._oura_anomaly_check();
