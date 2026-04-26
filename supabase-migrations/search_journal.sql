-- Journal search RPC. Returns a row per entry_date that has any match across:
--   - journal_entries.reflections          (source: 'entry')
--   - journal_calendar_cache.events[].summary (source: 'event')
--   - tasks.text / tasks.note (done & completed)  (source: 'task')
--
-- Snippets are returned as plain text (no HTML wrapping) — the client
-- escapes them and inserts <mark> tags so we never trust SQL output as HTML
-- and never have to regex-escape user input on the server.
--
-- Tasks use UTC date for grouping. Same-day approximation; an 11pm-local
-- completion that crosses midnight UTC may show up under the next date.
-- Acceptable until we pass a tz offset from the client.

create or replace function public.search_journal(p_query text)
returns table (
  entry_date date,
  sources    text[],
  snippet    text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  q text := lower(trim(coalesce(p_query, '')));
  uid uuid := auth.uid();
begin
  if uid is null or q = '' then return; end if;

  return query
  with raw as (
    -- Reflections
    select
      e.entry_date as d,
      'entry'::text as src,
      e.reflections as txt
    from public.journal_entries e
    where e.user_id = uid
      and e.reflections is not null
      and lower(e.reflections) like '%' || q || '%'

    union all

    -- Calendar event summaries (each event row is one element of the cached array)
    select
      c.entry_date as d,
      'event'::text as src,
      ev->>'summary' as txt
    from public.journal_calendar_cache c
    cross join lateral jsonb_array_elements(coalesce(c.events, '[]'::jsonb)) ev
    where c.user_id = uid
      and lower(coalesce(ev->>'summary', '')) like '%' || q || '%'

    union all

    -- Completed task text / note. completed_at is a bigint of epoch
    -- milliseconds (the client writes Date.now()), so we convert to a
    -- timestamp before truncating to date. UTC is an approximation of
    -- the user's local day; same-day boundary cases may shift one day.
    select
      (to_timestamp(t.completed_at::bigint / 1000.0) at time zone 'UTC')::date as d,
      'task'::text as src,
      coalesce(nullif(t.text, ''), t.note) as txt
    from public.tasks t
    where t.user_id = uid
      and t.done = true
      and t.completed_at is not null
      and (
        lower(coalesce(t.text, '')) like '%' || q || '%'
        or lower(coalesce(t.note, '')) like '%' || q || '%'
      )
  ),
  with_snip as (
    select
      d,
      src,
      case
        when length(txt) <= 140 then txt
        else substring(
          txt
          from greatest(1, position(q in lower(txt)) - 40)
          for 140
        )
      end as snip
    from raw
    where txt is not null and txt <> ''
  )
  select
    s.d as entry_date,
    array_agg(distinct s.src order by s.src) as sources,
    string_agg(distinct s.snip, ' · ') as snippet
  from with_snip s
  group by s.d
  order by s.d desc
  limit 50;
end;
$$;

grant execute on function public.search_journal(text) to authenticated;
