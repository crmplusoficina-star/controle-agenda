alter table public.ai_insights
  drop constraint if exists ai_insights_generated_by_check;

alter table public.ai_insights
  add constraint ai_insights_generated_by_check
  check (generated_by = any (array[
    'rules'::text,
    'gemini'::text,
    'rules+gemini'::text,
    'groq'::text,
    'rules+groq'::text
  ]));
