(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,15831,e=>{"use strict";async function t(e){await e.exec("ANALYZE")}async function s(e){let{rows:s}=await e.query(`SELECT bool_or(c.reltuples < 0 OR abs(c.reltuples - t.n) > GREATEST(50, t.n * 0.2)) AS stale
       FROM (VALUES ('conversations', (SELECT count(*) FROM conversations)::float8),
                    ('usage_records', (SELECT count(*) FROM usage_records)::float8),
                    ('estimate_buckets', (SELECT count(*) FROM estimate_buckets)::float8)) AS t(name, n)
       JOIN pg_class c ON c.oid = t.name::regclass`);return s[0]?.stale===!0&&(await t(e),!0)}e.s(["I",0,s,"u",0,t])},2751,21046,34786,e=>{"use strict";var t=e.i(64339),s=e.i(90159),a=e.i(15831),n=e.i(75379);let o=`
CREATE TEMP TABLE IF NOT EXISTS stg_models (
  key text PRIMARY KEY, display_name text NOT NULL, family text NOT NULL, tokenizer_family text NOT NULL
);
CREATE TEMP TABLE IF NOT EXISTS stg_conversations (
  dedup_key text PRIMARY KEY, kind text NOT NULL, external_id text NOT NULL, title text, project_label text,
  model_key text, created_at timestamptz, updated_at timestamptz, metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE TEMP TABLE IF NOT EXISTS stg_messages (
  conversation_key text NOT NULL, external_id text NOT NULL, parent_external_id text, role text NOT NULL,
  created_at timestamptz, occurred_at timestamptz NOT NULL, ordinal int NOT NULL, model_key text,
  text_chars int NOT NULL, thinking_chars int NOT NULL, tool_chars int NOT NULL, attachment_chars int NOT NULL,
  attachment_count int NOT NULL, file_count int NOT NULL,
  input_base int NOT NULL, output_base int NOT NULL, replay_base bigint NOT NULL, replay_cached_base bigint NOT NULL,
  request_count int NOT NULL, method_key text NOT NULL, limitation_flags int NOT NULL
);
CREATE TEMP TABLE IF NOT EXISTS stg_usage (
  conversation_key text, model_key text, occurred_at timestamptz NOT NULL, bucket_seconds int NOT NULL,
  price_tier text NOT NULL, input_tokens bigint NOT NULL, output_tokens bigint NOT NULL,
  cache_read_tokens bigint NOT NULL, cache_write_5m_tokens bigint NOT NULL, cache_write_1h_tokens bigint NOT NULL,
  request_count int NOT NULL, user_message_count int NOT NULL, assistant_message_count int NOT NULL,
  web_search_requests int NOT NULL, confidence text NOT NULL, dedup_key text NOT NULL
);
CREATE TEMP TABLE IF NOT EXISTS stg_costs (
  model_key text, occurred_at timestamptz NOT NULL, bucket_seconds int NOT NULL, cost_type text, token_type text,
  description text, amount_usd numeric(20,8) NOT NULL, dedup_key text NOT NULL
);
CREATE TEMP TABLE IF NOT EXISTS stg_owner (token text NOT NULL);`;async function r(e){let t=globalThis.crypto.randomUUID();return await e.exec(o),await e.exec(`TRUNCATE stg_models, stg_conversations, stg_messages, stg_usage, stg_costs, stg_owner; INSERT INTO stg_owner (token) VALUES ('${t}');`),t}async function i(e){let t=await e.query("SELECT to_regclass('pg_temp.stg_owner') IS NOT NULL AS present");if(t.rows[0]?.present!==!0)return null;let{rows:s}=await e.query("SELECT token FROM stg_owner LIMIT 1");return s[0]?.token??null}e.s(["S",0,class{db;models;conversations;messages;usages;costs;chain;counts;constructor(e){this.db=e,this.models=[],this.conversations=[],this.messages=[],this.usages=[],this.costs=[],this.chain=Promise.resolve(),this.counts={models:0,conversations:0,messages:0,usage:0,costs:0}}model(e){if(this.models.push(e),this.counts.models++,this.models.length>=4e3)return this.flushModels()}conversation(e){if(this.conversations.push(e),this.counts.conversations++,this.conversations.length>=4e3)return this.flushConversations()}message(e){if(this.messages.push(e),this.counts.messages++,this.messages.length>=4e3)return this.flushMessages()}usage(e){if(this.usages.push(e),this.counts.usage++,this.usages.length>=4e3)return this.flushUsage()}cost(e){if(this.costs.push(e),this.counts.costs++,this.costs.length>=4e3)return this.flushCosts()}addBatch(e){for(let t of e.models??[])this.models.push(t);for(let t of e.conversations??[])this.conversations.push(t);for(let t of e.messages??[])this.messages.push(t);for(let t of e.usage??[])this.usages.push(t);for(let t of e.costs??[])this.costs.push(t);return this.counts.models+=e.models?.length??0,this.counts.conversations+=e.conversations?.length??0,this.counts.messages+=e.messages?.length??0,this.counts.usage+=e.usage?.length??0,this.counts.costs+=e.costs?.length??0,this.finish()}async finish(){this.flushModels(),this.flushConversations(),this.flushMessages(),this.flushUsage(),this.flushCosts(),await this.chain}enqueue(e){return this.chain=this.chain.then(()=>e()).then(()=>void 0),this.chain}flushModels(){let e=this.models;return 0===e.length?this.chain:(this.models=[],this.enqueue(()=>this.db.query(`INSERT INTO stg_models (key, display_name, family, tokenizer_family)
         SELECT DISTINCT ON (k) k, d, f, t FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS x(k, d, f, t)
         ON CONFLICT (key) DO NOTHING`,[e.map(e=>e.key),e.map(e=>e.displayName),e.map(e=>e.family),e.map(e=>e.tokenizerFamily)])))}flushConversations(){let e=this.conversations;return 0===e.length?this.chain:(this.conversations=[],this.enqueue(()=>this.db.query(`INSERT INTO stg_conversations (dedup_key, kind, external_id, title, project_label, model_key, created_at, updated_at, metadata)
         SELECT DISTINCT ON (k) k, kind, ext, title, proj, model, created::timestamptz, updated::timestamptz, meta::jsonb
           FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[])
             AS x(k, kind, ext, title, proj, model, created, updated, meta)
         ON CONFLICT (dedup_key) DO UPDATE SET
           title = COALESCE(EXCLUDED.title, stg_conversations.title),
           project_label = COALESCE(EXCLUDED.project_label, stg_conversations.project_label),
           model_key = COALESCE(stg_conversations.model_key, EXCLUDED.model_key),
           created_at = LEAST(stg_conversations.created_at, EXCLUDED.created_at),
           updated_at = GREATEST(stg_conversations.updated_at, EXCLUDED.updated_at),
           metadata = stg_conversations.metadata || EXCLUDED.metadata`,[e.map(e=>e.dedupKey),e.map(e=>e.kind),e.map(e=>e.externalId),e.map(e=>e.title),e.map(e=>e.projectLabel),e.map(e=>e.modelKey),e.map(e=>e.createdAt),e.map(e=>e.updatedAt),e.map(e=>JSON.stringify(e.metadata??{}))])))}flushMessages(){let e=this.messages;return 0===e.length?this.chain:(this.messages=[],this.enqueue(()=>this.db.query(`INSERT INTO stg_messages (conversation_key, external_id, parent_external_id, role, created_at, occurred_at, ordinal, model_key,
            text_chars, thinking_chars, tool_chars, attachment_chars, attachment_count, file_count,
            input_base, output_base, replay_base, replay_cached_base, request_count, method_key, limitation_flags)
         SELECT ck, ext, parent, role, created::timestamptz, occurred::timestamptz, ord, model,
                tc, thc, toc, ac, an, fn, ib, ob, rb, rcb, rc, mk, lf
           FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::text[],
                       $9::int[], $10::int[], $11::int[], $12::int[], $13::int[], $14::int[],
                       $15::int[], $16::int[], $17::bigint[], $18::bigint[], $19::int[], $20::text[], $21::int[])
             AS x(ck, ext, parent, role, created, occurred, ord, model, tc, thc, toc, ac, an, fn, ib, ob, rb, rcb, rc, mk, lf)`,[e.map(e=>e.conversationKey),e.map(e=>e.externalId),e.map(e=>e.parentExternalId),e.map(e=>e.role),e.map(e=>e.createdAt),e.map(e=>e.occurredAt),e.map(e=>e.ordinal),e.map(e=>e.modelKey),e.map(e=>e.textChars),e.map(e=>e.thinkingChars),e.map(e=>e.toolChars),e.map(e=>e.attachmentChars),e.map(e=>e.attachmentCount),e.map(e=>e.fileCount),e.map(e=>e.inputBase),e.map(e=>e.outputBase),e.map(e=>e.replayBase),e.map(e=>e.replayCachedBase),e.map(e=>e.requestCount),e.map(e=>e.methodKey),e.map(e=>e.limitationFlags)])))}flushUsage(){let e=this.usages;return 0===e.length?this.chain:(this.usages=[],this.enqueue(()=>this.db.query(`INSERT INTO stg_usage (conversation_key, model_key, occurred_at, bucket_seconds, price_tier,
            input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
            request_count, user_message_count, assistant_message_count, web_search_requests, confidence, dedup_key)
         SELECT ck, model, occurred::timestamptz, bs, tier, i, o, cr, cw5, cw1, rc, um, am, ws, conf, dk
           FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::text[],
                       $6::bigint[], $7::bigint[], $8::bigint[], $9::bigint[], $10::bigint[],
                       $11::int[], $12::int[], $13::int[], $14::int[], $15::text[], $16::text[])
             AS x(ck, model, occurred, bs, tier, i, o, cr, cw5, cw1, rc, um, am, ws, conf, dk)`,[e.map(e=>e.conversationKey),e.map(e=>e.modelKey),e.map(e=>e.occurredAt),e.map(e=>e.bucketSeconds),e.map(e=>e.priceTier),e.map(e=>e.inputTokens),e.map(e=>e.outputTokens),e.map(e=>e.cacheReadTokens),e.map(e=>e.cacheWrite5mTokens),e.map(e=>e.cacheWrite1hTokens),e.map(e=>e.requestCount),e.map(e=>e.userMessageCount),e.map(e=>e.assistantMessageCount),e.map(e=>e.webSearchRequests),e.map(e=>e.confidence),e.map(e=>e.dedupKey)])))}flushCosts(){let e=this.costs;return 0===e.length?this.chain:(this.costs=[],this.enqueue(()=>this.db.query(`INSERT INTO stg_costs (model_key, occurred_at, bucket_seconds, cost_type, token_type, description, amount_usd, dedup_key)
         SELECT model, occurred::timestamptz, bs, ct, tt, descr, amount::numeric, dk
           FROM unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])
             AS x(model, occurred, bs, ct, tt, descr, amount, dk)`,[e.map(e=>e.modelKey),e.map(e=>e.occurredAt),e.map(e=>e.bucketSeconds),e.map(e=>e.costType),e.map(e=>e.tokenType),e.map(e=>e.description),e.map(e=>e.amountUsd),e.map(e=>e.dedupKey)])))}},"B",0,r,"v",0,i],21046);let c=async(e,t,s=[])=>{let{rows:a}=await e.query(t,s);return a[0]};async function d(e,t,s){let a=await c(e,"SELECT id FROM data_sources WHERE user_id = $1 AND kind = $2::source_kind AND external_ref = $3",[t,s.source.kind,s.source.externalRef]);return a?.id??null}let u=(e,t)=>`(
  ${e}.dedup_key = ${t}.dedup_key AND ${e}.occurred_at = ${t}.occurred_at AND ${e}.bucket_seconds = ${t}.bucket_seconds
  AND ${e}.price_tier = ${t}.price_tier AND ${e}.input_tokens = ${t}.input_tokens AND ${e}.output_tokens = ${t}.output_tokens
  AND ${e}.cache_read_tokens = ${t}.cache_read_tokens AND ${e}.cache_write_5m_tokens = ${t}.cache_write_5m_tokens
  AND ${e}.cache_write_1h_tokens = ${t}.cache_write_1h_tokens AND ${e}.request_count = ${t}.request_count
  AND ${e}.user_message_count = ${t}.user_message_count AND ${e}.assistant_message_count = ${t}.assistant_message_count
  AND ${e}.web_search_requests = ${t}.web_search_requests AND ${e}.confidence = ${t}.confidence::text
  AND (SELECT mc.id FROM model_catalog mc WHERE mc.model_key = ${e}.model_key) IS NOT DISTINCT FROM ${t}.model_id)`,_=(e,t)=>`(
  ${e}.dedup_key = ${t}.dedup_key AND ${e}.occurred_at = ${t}.occurred_at AND ${e}.bucket_seconds = ${t}.bucket_seconds
  AND ${e}.amount_usd = ${t}.amount_usd AND ${e}.cost_type IS NOT DISTINCT FROM ${t}.cost_type
  AND ${e}.token_type IS NOT DISTINCT FROM ${t}.token_type AND ${e}.description IS NOT DISTINCT FROM ${t}.description
  AND (SELECT mc.id FROM model_catalog mc WHERE mc.model_key = ${e}.model_key) IS NOT DISTINCT FROM ${t}.model_id)`,l=(e,t)=>`unnest(${e}::timestamptz[], ${t}::timestamptz[]) AS rg(s, e)`,m=(e,t,s)=>{let a;return`EXISTS (SELECT 1 FROM ${l(t,s)} WHERE ${a="rg.e",`(${e}.occurred_at >= rg.s AND ${e}.occurred_at < ${a} AND ${e}.occurred_at + make_interval(secs => ${e}.bucket_seconds) <= ${a})`})`},E=new Set(["generic_csv","generic_json"]);async function h(e,t,s,a){if(null===s||null===a.contentHash||!E.has(a.source.kind))return[];let{rows:n}=await e.query("SELECT id FROM import_batches WHERE user_id = $1 AND source_id = $2 AND content_hash = $3 ORDER BY id",[t,s,a.contentHash]);return n.map(e=>e.id)}function N(e){let t=e.replaceRanges??[];return 0===t.length?null:{starts:t.map(e=>e.start),ends:t.map(e=>e.end)}}async function T(e,a,n){let o=[a,n.starts,n.ends],r=e=>{let t;return`SELECT x.occurred_at, x.bucket_seconds, b.file_name
       FROM ${e} x JOIN import_batches b ON b.id = x.batch_id
      WHERE x.source_id = $1 AND EXISTS (SELECT 1 FROM ${l("$2","$3")} WHERE ${t="rg.s",`(x.occurred_at < rg.e AND CASE WHEN x.bucket_seconds = 0 THEN x.occurred_at >= ${t}
                                        ELSE x.occurred_at + make_interval(secs => x.bucket_seconds) > ${t} END)`}) AND NOT ${m("x","$2","$3")}`},i=await c(e,`SELECT * FROM (${r("usage_records")} UNION ALL ${r("reported_costs")}) y ORDER BY occurred_at LIMIT 1`,o);if(i){var d,u;let e;throw new t.f(`This report starts or ends in the middle of a period that an earlier import (“${i.file_name}”) stored as a single total: ${(d=i.bucket_seconds,e=(u=(0,s.r)(i.occurred_at)).slice(0,10),86400===d?`the daily total for ${e} (UTC)`:3600===d?`the hourly total that starts at ${u.slice(11,16)} UTC on ${e}`:d%86400==0?`the total for the ${d/86400} days from ${e} (UTC)`:`a total that starts at ${u.slice(11,16)} UTC on ${e}`)}. A total cannot be replaced in part, and adding the new rows on top of it would count that time twice. Export the report so that it covers that period completely, or delete the earlier import first. Nothing was saved.`,"range_conflict")}}async function p(e){let s=await e.query("SELECT DISTINCT method_key FROM stg_messages WHERE method_key NOT IN (SELECT method_key FROM estimation_methods) LIMIT 3");if(s.rows.length>0)throw new t.f(`The import refers to an unknown estimation method (${s.rows.map(e=>e.method_key).join(", ")}).`,"unknown_estimation_method")}let L=(e,t)=>`(CASE WHEN ${e}.bucket_seconds >= 86400 THEN (${e}.occurred_at AT TIME ZONE 'UTC')::date ELSE (${e}.occurred_at AT TIME ZONE ${t}::text)::date END)`,g=(e,t)=>`(CASE WHEN ${e}.bucket_seconds >= 86400 THEN ((${e}.occurred_at + make_interval(secs => ${e}.bucket_seconds - 1)) AT TIME ZONE 'UTC')::date
         ELSE (${e}.occurred_at AT TIME ZONE ${t}::text)::date END)`;async function S(e,t,a){await p(e);let o=await d(e,t,a),r=(await c(e,"SELECT timezone FROM users WHERE id = $1",[t]))?.timezone??"UTC",i=await c(e,`SELECT count(*)::int AS total, count(*) FILTER (WHERE c.id IS NULL)::int AS fresh
       FROM stg_conversations s LEFT JOIN conversations c ON c.user_id = $1 AND c.dedup_key = s.dedup_key`,[t]),l=await c(e,`WITH d AS (SELECT DISTINCT ON (conversation_key, external_id) * FROM stg_messages ORDER BY conversation_key, external_id, ordinal)
     SELECT (SELECT count(*) FROM stg_messages)::int AS staged,
            count(*)::int AS total,
            count(*) FILTER (WHERE m.id IS NULL)::int AS fresh,
            count(*) FILTER (WHERE m.id IS NULL AND d.model_key IS NULL)::int AS without_model,
            count(*) FILTER (WHERE m.id IS NULL AND d.created_at IS NULL)::int AS without_timestamp,
            -- rounded per category, exactly as the usage_facts view does, so the preview matches the dashboard
            COALESCE(sum(round(d.input_base * em.central_factor) + round(d.output_base * em.central_factor) + round(d.replay_base * em.central_factor))
                     FILTER (WHERE m.id IS NULL), 0)::bigint AS tokens,
            min(d.occurred_at) FILTER (WHERE m.id IS NULL) AS first_at,
            max(d.occurred_at) FILTER (WHERE m.id IS NULL) AS last_at,
            min((d.occurred_at AT TIME ZONE $2::text)::date) FILTER (WHERE m.id IS NULL)::text AS first_day,
            max((d.occurred_at AT TIME ZONE $2::text)::date) FILTER (WHERE m.id IS NULL)::text AS last_day
       FROM d
       JOIN estimation_methods em ON em.method_key = d.method_key
       LEFT JOIN conversations c ON c.user_id = $1 AND c.dedup_key = d.conversation_key
       LEFT JOIN messages m ON m.conversation_id = c.id AND m.external_id = d.external_id`,[t,r]),E=null!==o?N(a):null;E&&null!==o&&await T(e,o,E);let S=await h(e,t,o,a),O=[o??0,E?.starts??[],E?.ends??[],S],f=e=>`((${e}.source_id = $2 AND ${m(e,"$3","$4")}) OR ${e}.batch_id = ANY($5::int[]))`,R=await c(e,`WITH d AS (SELECT DISTINCT ON (dedup_key) * FROM stg_usage ORDER BY dedup_key),
          j AS (SELECT d.*, (u.id IS NULL OR (${f("u")} AND NOT ${u("d","u")})) AS fresh
                  FROM d LEFT JOIN usage_records u ON u.user_id = $1 AND u.dedup_key = d.dedup_key)
     SELECT (SELECT count(*) FROM stg_usage)::int AS staged,
            count(*)::int AS total,
            count(*) FILTER (WHERE fresh)::int AS fresh,
            count(*) FILTER (WHERE fresh AND model_key IS NULL)::int AS without_model,
            count(*) FILTER (WHERE fresh AND confidence = 'exact')::int AS exact_rows,
            count(*) FILTER (WHERE fresh AND confidence <> 'exact')::int AS stated_rows,
            COALESCE(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens)
                     FILTER (WHERE fresh AND confidence = 'exact'), 0)::bigint AS exact_tokens,
            COALESCE(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens)
                     FILTER (WHERE fresh AND confidence <> 'exact'), 0)::bigint AS estimated_tokens,
            min(occurred_at) FILTER (WHERE fresh) AS first_at,
            max(occurred_at) FILTER (WHERE fresh) AS last_at,
            min(${L("j","$6")}) FILTER (WHERE fresh)::text AS first_day,
            max(${g("j","$6")}) FILTER (WHERE fresh)::text AS last_day
       FROM j`,[t,...O,r]),$=await c(e,`WITH d AS (SELECT DISTINCT ON (dedup_key) * FROM stg_costs ORDER BY dedup_key),
          j AS (SELECT d.*, (r.id IS NULL OR (${f("r")} AND NOT ${_("d","r")})) AS fresh
                  FROM d LEFT JOIN reported_costs r ON r.user_id = $1 AND r.dedup_key = d.dedup_key)
     SELECT (SELECT count(*) FROM stg_costs)::int AS staged, count(*)::int AS total,
            count(*) FILTER (WHERE fresh)::int AS fresh,
            count(*) FILTER (WHERE fresh AND model_key IS NULL)::int AS without_model,
            min(occurred_at) FILTER (WHERE fresh) AS first_at, max(occurred_at) FILTER (WHERE fresh) AS last_at,
            min(${L("j","$6")}) FILTER (WHERE fresh)::text AS first_day,
            max(${g("j","$6")}) FILTER (WHERE fresh)::text AS last_day
       FROM j`,[t,...O,r]),y=null;if(E||S.length>0){let t=e=>`((${e}.source_id = $1 AND ${m(e,"$2","$3")}) OR ${e}.batch_id = ANY($4::int[]))`,a=await c(e,`SELECT (SELECT count(*) FROM usage_records u WHERE ${t("u")}
                  AND NOT EXISTS (SELECT 1 FROM stg_usage s WHERE ${u("s","u")}))::int AS usage_rows,
              (SELECT COALESCE(sum(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_5m_tokens + u.cache_write_1h_tokens), 0)
                 FROM usage_records u WHERE ${t("u")}
                  AND NOT EXISTS (SELECT 1 FROM stg_usage s WHERE ${u("s","u")}))::bigint AS tokens,
              (SELECT count(*) FROM reported_costs r WHERE ${t("r")}
                  AND NOT EXISTS (SELECT 1 FROM stg_costs s WHERE ${_("s","r")}))::int AS cost_rows`,[o,E?.starts??[],E?.ends??[],S]);y={usageRows:a.usage_rows,costRows:a.cost_rows,tokens:(0,s.L)(a.tokens)}}let k=a.contentHash?await c(e,`SELECT b.id, b.created_at, s.label, b.source_id FROM import_batches b JOIN data_sources s ON s.id = b.source_id
          WHERE b.user_id = $1 AND b.content_hash = $2
          ORDER BY (b.source_id = $3) DESC, b.created_at DESC LIMIT 1`,[t,a.contentHash,o??0]):void 0,w=await e.query(`SELECT DISTINCT k FROM (SELECT model_key AS k FROM stg_messages UNION SELECT model_key FROM stg_usage
                             UNION SELECT model_key FROM stg_conversations UNION SELECT model_key FROM stg_costs) x
      WHERE k IS NOT NULL ORDER BY k LIMIT 50`),A=await c(e,"SELECT count(*)::int AS n FROM data_sources WHERE user_id = $1 AND is_synthetic",[t]),C=(0,s.L)(l.fresh),I=(0,s.L)(R.fresh),b=$.fresh,D=C+I+b,F=(0,s.L)(l.without_model)+(0,s.L)(R.without_model)+$.without_model,x=a.replaceRanges??[],U=x.length>0?new Date(Date.parse(x[x.length-1].end)-1).toISOString():null,M=[(0,s.r)(l.first_at),(0,s.r)(R.first_at),(0,s.r)($.first_at),x[0]?.start??null].filter(Boolean),v=[(0,s.r)(l.last_at),(0,s.r)(R.last_at),(0,s.r)($.last_at),U].filter(Boolean),H=x.map(e=>{let t;return t=new Date(Date.parse(e.end)-1).toISOString(),e.start.endsWith("T00:00:00.000Z")&&e.end.endsWith("T00:00:00.000Z")?{first:e.start.slice(0,10),last:t.slice(0,10)}:{first:(0,n.J)(e.start,r),last:(0,n.J)(t,r)}}),W=[l.first_day,R.first_day,$.first_day,...H.map(e=>e.first)].filter(e=>"string"==typeof e),q=[l.last_day,R.last_day,$.last_day,...H.map(e=>e.last)].filter(e=>"string"==typeof e),j=(y?.usageRows??0)+(y?.costRows??0),X=e=>"number"==typeof a.stats[e]?a.stats[e]:null;return{format:a.format,formatLabel:a.formatLabel,source:a.source,fileName:a.fileName,fileSize:a.fileSize,previousImport:k?{batchId:k.id,importedAt:(0,s.r)(k.created_at),sourceLabel:k.label,sameSource:k.source_id===o}:null,recordsSeen:a.recordsSeen,recordsSkipped:a.recordsSkipped,conversations:{total:i.total,new:i.fresh,existing:i.total-i.fresh},messages:{total:(0,s.L)(l.staged),new:C,duplicate:(0,s.L)(l.staged)-C,withoutModel:(0,s.L)(l.without_model),withoutTimestamp:(0,s.L)(l.without_timestamp)},usageRows:{total:(0,s.L)(R.staged),new:I,duplicate:(0,s.L)(R.staged)-I,withoutModel:(0,s.L)(R.without_model)},costRows:{total:$.staged,new:b,duplicate:$.staged-b},requests:a.requestKeys||void 0!==a.duplicateRequests?null!==X("newResponses")?{new:X("newResponses")+(X("newAdvisorRecords")??0),duplicate:(X("duplicateResponses")??0)+(X("duplicateAdvisorRecords")??0)}:{new:a.requestKeys?.length??0,duplicate:a.duplicateRequests??0}:null,prompts:null!==X("newHumanPrompts")?{new:X("newHumanPrompts"),duplicate:X("duplicateHumanPrompts")??0}:null,replaced:y,rereadsEarlierImport:S.length>0&&j>0,tokens:{exact:(0,s.L)(R.exact_tokens),estimated:(0,s.L)(l.tokens)+(0,s.L)(R.estimated_tokens)},dateRange:{start:M.length?M.sort()[0]:null,end:v.length?v.sort()[v.length-1]:null},coveredDays:{first:W.length?W.sort()[0]:null,last:q.length?q.sort()[q.length-1]:null},coverage:{hasExactUsage:(0,s.L)(R.exact_tokens)>0,hasModel:D>0&&F<D,modelShare:D>0?1-F/D:null,hasTimestamps:0===(0,s.L)(l.without_timestamp)},figures:{exactTokens:(0,s.L)(R.exact_rows)>0,statedTokens:(0,s.L)(R.stated_rows)>0,textEstimates:C>0,costs:b>0},models:w.rows.map(e=>e.k),missingFields:a.missingFields,warnings:a.warnings,willRemoveDemoData:!a.source.isSynthetic&&A.n>0,nothingNew:0===C&&0===I&&0===b&&0===j}}async function O(e,t){let a=await c(e,"SELECT (COALESCE(max(id), 0)::bigint * 1000003 + count(*))::bigint AS g FROM import_batches WHERE user_id = $1",[t]);return(0,s.L)(a.g)}async function f(e,t){let{rows:s}=await e.query("SELECT unnest(request_keys) AS k FROM import_batches WHERE user_id = $1 AND cardinality(request_keys) > 0",[t]),a=new Set;for(let e of s)a.add(BigInt(e.k));return a}async function R(e,n,o,r={}){let l=await e.transaction(async e=>{if(void 0!==r.staging&&await i(e)!==r.staging)throw new t.f("The records prepared for this import are no longer there: another import or a manual entry was made in the meantime, or the tab that held the database was closed. Nothing was saved. Run the import again.","stale_preview");if(await p(e),void 0!==r.generation&&void 0!==o.requestKeys&&await O(e,n)!==r.generation)throw new t.f("Other data was imported or deleted after this preview was prepared. Run the import again so that what is already stored is recognised correctly. Nothing was saved.","stale_preview");let s=!1;if(o.source.isSynthetic){if((await c(e,"SELECT count(*)::int AS n FROM data_sources WHERE user_id = $1 AND NOT is_synthetic",[n])).n>0)throw new t.f("The demo dataset can only be loaded into an empty workspace. Delete your imported data first, or keep working with your real data.","demo_requires_empty_workspace")}else{let t=await e.query("DELETE FROM data_sources WHERE user_id = $1 AND is_synthetic",[n]);await e.query("DELETE FROM subscription_periods WHERE user_id = $1 AND is_synthetic",[n]),s=(t.affectedRows??0)>0}let a=await d(e,n,o),l=await h(e,n,a,o),E=(await c(e,`INSERT INTO data_sources (user_id, kind, label, external_ref, is_synthetic)
       VALUES ($1, $2::source_kind, $3, $4, $5)
       ON CONFLICT (user_id, kind, external_ref) DO UPDATE SET label = EXCLUDED.label, updated_at = now()
       RETURNING id`,[n,o.source.kind,o.source.label,o.source.externalRef,o.source.isSynthetic??!1])).id,L=(await c(e,`INSERT INTO import_batches (user_id, source_id, file_name, file_size, content_hash, format, parser_version,
                                   records_seen, records_skipped, missing_fields, warnings, stats, request_keys)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11::jsonb, $12::jsonb, $13::bigint[])
       RETURNING id`,[n,E,o.fileName,o.fileSize,o.contentHash,o.format,o.parserVersion,o.recordsSeen,o.recordsSkipped,o.missingFields,JSON.stringify(o.warnings),JSON.stringify(o.stats),(o.requestKeys??[]).map(e=>e.toString())])).id;await e.query(`INSERT INTO model_catalog (model_key, display_name, family, tokenizer_family, is_builtin)
       SELECT key, display_name, family, tokenizer_family, false FROM stg_models
       ON CONFLICT (model_key) DO NOTHING`);let g={usageRows:0,costRows:0},S=new Map,f=null!==a?N(o):null,R=new Set;if(f||l.length>0){f&&await T(e,E,f);let t=[E,f?.starts??[],f?.ends??[],l],s=e=>`((${e}.source_id = $1 AND ${m(e,"$2","$3")}) OR ${e}.batch_id = ANY($4::int[]))`,a=await e.query(`DELETE FROM usage_records u WHERE ${s("u")}
            AND NOT EXISTS (SELECT 1 FROM stg_usage s WHERE ${u("s","u")}) RETURNING u.batch_id, u.conversation_id`,t),n=await e.query(`DELETE FROM reported_costs r WHERE ${s("r")}
            AND NOT EXISTS (SELECT 1 FROM stg_costs s WHERE ${_("s","r")}) RETURNING r.batch_id`,t);for(let e of(g.usageRows=a.rows.length,g.costRows=n.rows.length,[...a.rows,...n.rows]))S.set(e.batch_id,(S.get(e.batch_id)??0)+1);for(let e of a.rows)null!==e.conversation_id&&R.add(e.conversation_id)}let y=(await e.query(`INSERT INTO conversations (user_id, source_id, kind, external_id, dedup_key, title, project_label, model_id, created_at, updated_at, metadata)
       SELECT $1, $2, s.kind::conversation_kind, s.external_id, s.dedup_key, s.title, s.project_label, mc.id, s.created_at, s.updated_at, s.metadata
         FROM stg_conversations s LEFT JOIN model_catalog mc ON mc.model_key = s.model_key
       ON CONFLICT (user_id, dedup_key) DO UPDATE SET
         -- The newer state of a conversation names it: an older export imported later must not put an old title back.
         title = CASE WHEN EXCLUDED.title IS NULL THEN conversations.title
                      WHEN conversations.title IS NULL THEN EXCLUDED.title
                      WHEN COALESCE(EXCLUDED.updated_at, '-infinity') >= COALESCE(conversations.updated_at, '-infinity') THEN EXCLUDED.title
                      ELSE conversations.title END,
         project_label = CASE WHEN EXCLUDED.project_label IS NULL THEN conversations.project_label
                              WHEN conversations.project_label IS NULL THEN EXCLUDED.project_label
                              WHEN COALESCE(EXCLUDED.updated_at, '-infinity') >= COALESCE(conversations.updated_at, '-infinity') THEN EXCLUDED.project_label
                              ELSE conversations.project_label END,
         -- The model of a Claude Code session is recomputed from its stored usage below (refreshConversationCounters).
         model_id = COALESCE(conversations.model_id, EXCLUDED.model_id),
         created_at = LEAST(conversations.created_at, EXCLUDED.created_at),
         updated_at = GREATEST(conversations.updated_at, EXCLUDED.updated_at),
         metadata = conversations.metadata || EXCLUDED.metadata
       RETURNING (xmax = 0) AS inserted`,[n,E])).rows.filter(e=>e.inserted).length,k=await c(e,"SELECT count(*)::int AS n FROM stg_messages"),w=(await e.query(`INSERT INTO messages (conversation_id, batch_id, external_id, parent_external_id, role, created_at, ordinal, model_id,
                             text_chars, thinking_chars, tool_chars, attachment_chars, attachment_count, file_count)
       SELECT c.id, $2, s.external_id, s.parent_external_id, s.role::message_role, s.created_at, s.ordinal, mc.id,
              s.text_chars, s.thinking_chars, s.tool_chars, s.attachment_chars, s.attachment_count, s.file_count
         FROM stg_messages s
         JOIN conversations c ON c.user_id = $1 AND c.dedup_key = s.conversation_key
         LEFT JOIN model_catalog mc ON mc.model_key = s.model_key
        ORDER BY s.conversation_key, s.ordinal
       ON CONFLICT (conversation_id, external_id) DO NOTHING`,[n,L])).affectedRows??0;await e.query(`INSERT INTO token_estimates (message_id, user_id, source_id, batch_id, conversation_id, model_id, occurred_at, role,
                                    input_base, output_base, replay_base, replay_cached_base, request_count, method_id, limitation_flags)
       SELECT DISTINCT ON (m.id) m.id, $1, $3, $2, c.id, mc.id, s.occurred_at, s.role::message_role,
              s.input_base, s.output_base, s.replay_base, s.replay_cached_base, s.request_count, em.id, s.limitation_flags
         FROM stg_messages s
         JOIN conversations c ON c.user_id = $1 AND c.dedup_key = s.conversation_key
         JOIN messages m ON m.conversation_id = c.id AND m.external_id = s.external_id AND m.batch_id = $2
         JOIN estimation_methods em ON em.method_key = s.method_key
         LEFT JOIN model_catalog mc ON mc.model_key = s.model_key
        ORDER BY m.id, s.ordinal`,[n,L,E]),await e.query("SELECT refresh_estimate_buckets($1::int)",[L]);let A=await c(e,"SELECT count(*)::int AS n FROM stg_usage"),C=(await e.query(`INSERT INTO usage_records (user_id, source_id, batch_id, conversation_id, model_id, occurred_at, bucket_seconds, price_tier,
                                  input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
                                  request_count, user_message_count, assistant_message_count, web_search_requests, confidence, dedup_key)
       SELECT $1, $3, $2, c.id, mc.id, s.occurred_at, s.bucket_seconds, s.price_tier,
              s.input_tokens, s.output_tokens, s.cache_read_tokens, s.cache_write_5m_tokens, s.cache_write_1h_tokens,
              s.request_count, s.user_message_count, s.assistant_message_count, s.web_search_requests, s.confidence::confidence, s.dedup_key
         FROM stg_usage s
         LEFT JOIN conversations c ON c.user_id = $1 AND c.dedup_key = s.conversation_key
         LEFT JOIN model_catalog mc ON mc.model_key = s.model_key
       ON CONFLICT (user_id, dedup_key) DO NOTHING`,[n,L,E])).affectedRows??0,I=await c(e,"SELECT count(*)::int AS n FROM stg_costs"),b=(await e.query(`INSERT INTO reported_costs (user_id, source_id, batch_id, model_id, occurred_at, bucket_seconds, cost_type, token_type, description, amount_usd, dedup_key)
       SELECT $1, $3, $2, mc.id, s.occurred_at, s.bucket_seconds, s.cost_type, s.token_type, s.description, s.amount_usd, s.dedup_key
         FROM stg_costs s LEFT JOIN model_catalog mc ON mc.model_key = s.model_key
       ON CONFLICT (user_id, dedup_key) DO NOTHING`,[n,L,E])).affectedRows??0;for(let[t,s]of(o.syncedFiles?.length&&await e.query(`INSERT INTO synced_files (source_id, path, size, last_modified)
         SELECT $1, p, min(s), to_timestamp(min(m) / 1000.0)
           FROM unnest($2::text[], $3::bigint[], $4::double precision[]) AS x(p, s, m)
          GROUP BY p HAVING count(*) = 1
         ON CONFLICT (source_id, path) DO UPDATE SET size = EXCLUDED.size, last_modified = EXCLUDED.last_modified, synced_at = now()`,[E,o.syncedFiles.map(e=>e.path),o.syncedFiles.map(e=>e.size),o.syncedFiles.map(e=>e.lastModified)]),S)){if(t===L)continue;let a=await c(e,`SELECT count(*)::int AS n, min(occurred_at) AS first_at, max(occurred_at) AS last_at
           FROM (SELECT occurred_at FROM usage_records WHERE batch_id = $1
                 UNION ALL SELECT occurred_at FROM token_estimates WHERE batch_id = $1
                 UNION ALL SELECT occurred_at FROM reported_costs WHERE batch_id = $1) x`,[t]);0===a.n?await e.query("DELETE FROM import_batches WHERE id = $1 AND user_id = $2",[t,n]):await e.query(`UPDATE import_batches SET records_inserted = $2, coverage_start = $3, coverage_end = $4,
                  warnings = (SELECT COALESCE(jsonb_agg(w), '[]'::jsonb) FROM jsonb_array_elements(warnings) w WHERE w->>'code' <> 'superseded')
                             || jsonb_build_array(jsonb_build_object('code', 'superseded', 'count',
                                  $5::int + COALESCE((SELECT (w->>'count')::int FROM jsonb_array_elements(warnings) w WHERE w->>'code' = 'superseded' LIMIT 1), 0),
                                  'message', $6::text))
            WHERE id = $1 AND user_id = $7`,[t,a.n,a.first_at,a.last_at,s,"records of this import were replaced by a later import: a report that states the same period differently, or the same file read with other settings. They are no longer stored under this import.",n])}let D=0===w&&0===C&&0===b&&0===g.usageRows&&0===g.costRows,F=D&&null===a;if(D)await e.query("DELETE FROM import_batches WHERE id = $1",[L]),F&&await e.query("DELETE FROM data_sources WHERE id = $1",[E]);else{let t=[...R].map(e=>Number(e));t.length>0&&await e.query(`DELETE FROM conversations c
            WHERE c.user_id = $1 AND c.id = ANY($2::int[])
              AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
              AND NOT EXISTS (SELECT 1 FROM usage_records u WHERE u.conversation_id = c.id)`,[n,t]),await $(e,n,`(c.dedup_key IN (SELECT dedup_key FROM stg_conversations)${t.length>0?` OR c.id IN (${t.join(",")})`:""})`);let s=g.usageRows+g.costRows;await e.query(`UPDATE import_batches b SET
           records_inserted = $2, records_duplicate = $3,
           coverage_start = r.first_at, coverage_end = r.last_at,
           -- Deleting this import does not bring back what it replaced; the history says so before it is deleted.
           warnings = CASE WHEN $4::int > 0
                           THEN b.warnings || jsonb_build_array(jsonb_build_object('code', 'replaced_earlier', 'count', $4::int, 'message', $5::text))
                           ELSE b.warnings END
          FROM (SELECT min(occurred_at) AS first_at, max(occurred_at) AS last_at
                  FROM (SELECT occurred_at FROM usage_records WHERE batch_id = $1
                        UNION ALL SELECT occurred_at FROM token_estimates WHERE batch_id = $1
                        UNION ALL SELECT occurred_at FROM reported_costs WHERE batch_id = $1) x) r
         WHERE b.id = $1`,[L,w+C+b,k.n-w+(A.n-C)+(I.n-b)+(o.duplicateRequests??0),s,"records that an earlier import had stored were replaced by this one. Deleting this import does not bring them back."])}return{batchId:D?null:L,sourceId:F?null:E,inserted:{conversations:y,messages:w,usageRows:C,costRows:b},duplicates:{messages:k.n-w,usageRows:A.n-C,costRows:I.n-b},replaced:g,removedDemoData:s,nothingNew:D}});await e.exec("TRUNCATE stg_models, stg_conversations, stg_messages, stg_usage, stg_costs;"),(!l.nothingNew||l.replaced.usageRows+l.replaced.costRows>0)&&await (0,a.u)(e);try{await e.flush()}catch(e){if(e instanceof s.X)throw e;return{...l,notOnDevice:e instanceof Error?e.message:String(e)}}return l}async function $(e,t,s){await e.query(`UPDATE conversations c SET
       message_count = COALESCE(m.n, 0) + COALESCE(u.um, 0) + COALESCE(u.am, 0),
       user_message_count = COALESCE(m.un, 0) + COALESCE(u.um, 0),
       assistant_message_count = COALESCE(m.an, 0) + COALESCE(u.am, 0),
       created_at = COALESCE(c.created_at, LEAST(e.first_at, u.first_at)),
       updated_at = GREATEST(c.updated_at, e.last_at, u.last_at),
       -- A Claude Code session is filed under the model that handled most of its tokens, over everything stored
       -- for it. An import only sees the files that changed, so it cannot decide this on its own.
       model_id = CASE WHEN c.kind = 'code_session' THEN COALESCE(d.model_id, c.model_id) ELSE c.model_id END
      FROM conversations t
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS n, count(*) FILTER (WHERE role = 'user')::int AS un, count(*) FILTER (WHERE role = 'assistant')::int AS an
          FROM messages WHERE conversation_id = t.id) m ON true
      LEFT JOIN LATERAL (
        SELECT min(occurred_at) AS first_at, max(occurred_at) AS last_at FROM token_estimates WHERE conversation_id = t.id) e ON true
      LEFT JOIN LATERAL (
        SELECT sum(user_message_count)::int AS um, sum(assistant_message_count)::int AS am,
               min(occurred_at) AS first_at, max(occurred_at) AS last_at
          FROM usage_records WHERE conversation_id = t.id) u ON true
      LEFT JOIN LATERAL (
        SELECT model_id FROM usage_records
         WHERE conversation_id = t.id AND model_id IS NOT NULL
         GROUP BY model_id
         ORDER BY sum(input_tokens + output_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens) DESC, model_id
         LIMIT 1) d ON true
     WHERE c.id = t.id AND c.user_id = $1 AND ${s}`,[t])}e.s(["S",0,R,"C",0,O,"G",0,f,"N",0,S,"H",0,$],2751);let y=!1;function k(){if(y)return Promise.resolve(null);y=!0;let e=!1,t=()=>{e||(e=!0,y=!1)},s="u"<typeof navigator?void 0:navigator.locks;return s?.request?new Promise(e=>{s.request("claude-lifetime:import",{ifAvailable:!0},s=>{if(!s){t(),e(null);return}return new Promise(s=>e(()=>{t(),s()}))})}):Promise.resolve(t)}async function w(e){let s=await k();if(!s)throw new t.f("Another import is being prepared or is waiting to be saved, in this tab or another one. Save or cancel it first, then try again.","import_in_progress");try{return await e()}finally{s()}}e.s(["v",0,k,"y",0,w],34786)},75379,e=>{"use strict";let t=new Intl.NumberFormat("en-US"),s=new Intl.NumberFormat("en-US",{notation:"compact",maximumSignificantDigits:3}),a=new Intl.NumberFormat("en-US",{notation:"compact",maximumSignificantDigits:2});function n(e){return t.format(Math.round(e))}function o(e,t=1){return new Intl.NumberFormat("en-US",{minimumFractionDigits:0,maximumFractionDigits:t}).format(e)}let r=e=>new Date(`${e}T00:00:00Z`);function i(e,t="short"){if(!e)return"–";let s=r(e.slice(0,10));return Number.isNaN(s.getTime())?"–":s.toLocaleDateString("en-US",{..."long"===t?{day:"numeric",month:"long",year:"numeric"}:"weekday"===t?{weekday:"short",day:"numeric",month:"short",year:"numeric"}:{day:"numeric",month:"short",year:"numeric"},timeZone:"UTC"})}function c(e,t){let s="string"==typeof e?new Date(e):e;try{return new Intl.DateTimeFormat("en-CA",{timeZone:t,year:"numeric",month:"2-digit",day:"2-digit"}).format(s)}catch{return s.toISOString().slice(0,10)}}e.s(["b",0,function(e,t){let s=r(e);return s.setUTCDate(s.getUTCDate()+t),s.toISOString().slice(0,10)},"I",0,function(e,t){let s=r(e),a=s.getUTCDate();s.setUTCDate(1),s.setUTCMonth(s.getUTCMonth()+t);let n=new Date(Date.UTC(s.getUTCFullYear(),s.getUTCMonth()+1,0)).getUTCDate();return s.setUTCDate(Math.min(a,n)),s.toISOString().slice(0,10)},"J",0,c,"r",0,function(e,t){return Math.round((r(t).getTime()-r(e).getTime())/864e5)+1},"l",0,function(e){return 0===e?"0":1e3>Math.abs(e)?t.format(Math.round(e)):a.format(e)},"L",0,function(e){if(e<1024)return`${e} B`;let t=["KB","MB","GB","TB"],s=e/1024,a=0;for(;s>=1024&&a<t.length-1;)s/=1024,a++;return`${s<10?s.toFixed(1):Math.round(s)} ${t[a]}`},"_",0,i,"N",0,function(e,t){if(!e&&!t)return"All time";if(e&&t){if(e===t)return i(e);let s=e.slice(0,4)===t.slice(0,4),a=r(e).toLocaleDateString("en-US",{day:"numeric",month:"short",...s?{}:{year:"numeric"},timeZone:"UTC"});return`${a} – ${i(t)}`}return e?`From ${i(e)}`:`Until ${i(t)}`},"X",0,o,"U",0,function(e,t,s="date"){if(!e)return"–";let a=new Date(e);if(Number.isNaN(a.getTime()))return"–";let n="datetime"===s?{day:"numeric",month:"short",year:"numeric",hour:"numeric",minute:"2-digit"}:{day:"numeric",month:"short",year:"numeric"};try{return a.toLocaleString("en-US",{...n,timeZone:t})}catch{return a.toLocaleString("en-US",{...n,timeZone:"UTC"})}},"M",0,n,"i",0,function(e,t){let s="number"==typeof e?e:Number(e);try{return new Intl.NumberFormat("en-US",{style:"currency",currency:t,maximumFractionDigits:2}).format(s)}catch{return`${o(s,2)} ${t}`}},"Y",0,function(e){return r(e.slice(0,10)).toLocaleDateString("en-US",{month:"short",year:"numeric",timeZone:"UTC"})},"w",0,function(e,t=Date.now()){let s=Math.max(0,Math.round((t-e)/1e3));if(s<45)return"just now";if(s<90)return"a minute ago";let a=Math.round(s/60);if(a<60)return`${a} minutes ago`;let n=Math.round(a/60);if(n<24)return`${n} hour${1===n?"":"s"} ago`;let o=Math.round(n/24);return`${o} day${1===o?"":"s"} ago`},"g",0,function(e){if(!Number.isFinite(e))return"–";let t=100*e;return 0===t?"0%":t<1?"<1%":t>99&&t<100?">99%":`${Math.round(t)}%`},"h",0,function(e){if(!Number.isFinite(e)||e<=0)return"–";if(e<60)return`${Math.round(e)} day${1===Math.round(e)?"":"s"}`;let t=Math.round(e/30.4375);if(t<24)return`${t} months`;let s=Math.floor(t/12),a=t%12;return 0===a?`${s} years`:`${s} years, ${a} month${1===a?"":"s"}`},"k",0,function(e){return Number.isFinite(e)?1e4>Math.abs(e)?t.format(Math.round(e)):s.format(e):"–"},"x",0,function(e,t={}){if(null==e||""===e)return"–";let s="number"==typeof e?e:Number(e);if(!Number.isFinite(s))return"–";if(0===s)return"$0";if(.01>Math.abs(s))return s>0?"<$0.01":"-<$0.01";let a=t.cents??1e3>Math.abs(s);return new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",minimumFractionDigits:2*!!a,maximumFractionDigits:2*!!a}).format(s)},"G",0,function(e,t,s=`${t}s`){return`${n(e)} ${1===e?t:s}`},"B",0,function(e){return c(new Date,e)}])}]);