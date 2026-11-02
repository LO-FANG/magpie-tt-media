import { ActivityStore, promptTitle, codexThreadName } from './activity.mjs';
import { readdir, readFile, stat, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, extname, basename, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const types = {'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.heic':'image/heic','.mp4':'video/mp4','.mov':'video/quicktime','.m4v':'video/mp4','.webm':'video/webm'};
const hash = value => createHash('sha256').update(value).digest('hex').slice(0,32);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function* files(dir) {
  let entries;
  try { entries = await readdir(dir, {withFileTypes:true}); }
  catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (/\.jsonl(?:\.zst)?$/.test(entry.name)) yield path;
  }
}

// Claude session transcript in Magpie's own part format ({role, kind, name, text, model}), but keeping the NEWEST
// characters: Magpie stops at 400k characters from the start, which freezes a long session at its early part.
const transcriptBudget = 400_000, partLimit = 8_000;
const pretty = value => { try { return JSON.stringify(value, null, 2); } catch { return String(value); } };
const resultText = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(x => x?.text ?? '').filter(Boolean).join('\n') : '';
function textPart(role, text) {
  const t = String(text ?? '').trim();
  return {role, kind: t.startsWith('<') || t.startsWith('# AGENTS.md') ? 'context' : 'text', text};
}
function claudeParts(content, role) {
  if (typeof content === 'string') return [textPart(role, content)];
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const b of content) {
    if (b.type === 'text') parts.push(textPart(role, b.text));
    else if (b.type === 'thinking') parts.push({role, kind:'thinking', text:b.thinking ?? ''});
    else if (b.type === 'tool_use') parts.push({role, kind:'tool_use', name:b.name, text:pretty(b.input)});
    else if (b.type === 'tool_result') parts.push({role:'tool', kind:'tool_result', text:resultText(b.content)});
    else if (b.type === 'image') parts.push({role, kind:'image', text:'[image]'});
  }
  return parts;
}
// `seq` is the part's place in the file (line number, then its place within the line). It does not move when the
// window's start does, so the app can use it as the part's identity.
function keepPart(part, seq) {
  const text = String(part.text ?? '').trim();
  if (!text) return null;
  const chars = [...text];
  if (chars.length > partLimit) return {...part, seq, text:chars.slice(0, partLimit).join(''), cut:chars.length - partLimit};
  return {...part, seq, text};
}

// Codex rollout -> Magpie's transcript parts (internal/sessions/content.go codexContentOf), newest first.
function codexOutput(raw) {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && (raw.content || raw.output)) return raw.content || raw.output;
  return raw === undefined || raw === null ? '' : JSON.stringify(raw);
}
const prettyArguments = text => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return String(text ?? ''); } };
const codexWords = content => Array.isArray(content) ? content.map(x => x?.text ?? '').join('\n') : '';
function codexParts(payload) {
  switch (payload.type) {
    case 'message':
      if (payload.role === 'user') return [textPart('user', codexWords(payload.content))];
      if (payload.role === 'assistant') return [textPart('assistant', codexWords(payload.content))];
      return [];
    case 'reasoning': case 'magpie_reasoning':
      return [{role:'assistant', kind:'thinking', text:(payload.summary ?? []).map(x => x?.text ?? '').join('\n\n')}];
    case 'function_call': return [{role:'assistant', kind:'tool_use', name:payload.name, text:prettyArguments(payload.arguments)}];
    case 'custom_tool_call': return [{role:'assistant', kind:'tool_use', name:payload.name, text:String(payload.input ?? '')}];
    case 'local_shell_call': return [{role:'assistant', kind:'tool_use', name:'shell', text:(payload.action?.command ?? []).join(' ')}];
    case 'function_call_output': case 'custom_tool_call_output': return [{role:'tool', kind:'tool_result', text:codexOutput(payload.output)}];
    default: return [];
  }
}
export class MediaStore {
  constructor(home = process.env.CODEX_HOME || join(homedir(), '.codex'), claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), piHome = process.env.PI_AGENT_DIR || join(homedir(), '.pi', 'agent')) {
    this.home = resolve(home); this.claudeHome = resolve(claudeHome); this.piHome = resolve(piHome); this.cache = new Map(); this.media = new Map();
    this.activity = new ActivityStore(this);
  }
  async find(id) {
    if (!uuid.test(id)) throw Object.assign(new Error('Expected a Codex session UUID'), {status:400});
    for (const root of ['sessions','archived_sessions']) {
      for await (const file of files(join(this.home,root))) {
        if (basename(file).endsWith(`${id}.jsonl`) || basename(file).endsWith(`${id}.jsonl.zst`)) return file;
      }
    }
    throw Object.assign(new Error('Session not found in this Codex home'), {status:404});
  }
  async findClaude(id) {
    if (!uuid.test(id)) throw Object.assign(new Error('Expected a Claude session UUID'), {status:400});
    const root = join(this.claudeHome,'projects');
    let projects;
    try { projects = await readdir(root,{withFileTypes:true}); }
    catch (e) { if (e.code === 'ENOENT') projects = []; else throw e; }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const file = join(root,project.name,`${id}.jsonl`);
      try { if ((await stat(file)).isFile()) return file; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    throw Object.assign(new Error('Session not found in this Claude home'), {status:404});
  }
  async findPi(id) {
    if (!uuid.test(id)) throw Object.assign(new Error('Expected a Pi session id'), {status:400});
    for await (const file of files(join(this.piHome, 'sessions'))) {
      if (basename(file) === `${id}.jsonl` || basename(file).endsWith(`_${id}.jsonl`)) return file;
    }
    throw Object.assign(new Error('Session not found in this Pi home'), {status:404});
  }
  // Claude Code (also run from Claude Desktop's Code tab) keeps uploaded and
  // pasted images as base64 blocks in its own session file; Magpie's
  // transcript only shows them as "[image]", so they are listed here in log order.
  async claudeSession(id) {
    const file = await this.findClaude(id), info = await stat(file);
    const revision = `${info.mtimeMs}:${info.size}`;
    const key = `claude:${id}`, previous = this.cache.get(key);
    if (previous?.revision === revision) return previous.result;
    const attachments = [], seen = new Set();
    let lineIndex = 0;
    for (const line of (await readFile(file,'utf8')).split('\n')) {
      lineIndex++;
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type !== 'user' || !Array.isArray(record.message?.content)) continue;
      const blocks = record.message.content;
      const userText = blocks.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
      for (const [index,block] of blocks.entries()) {
        const source = block.source;
        if (block.type !== 'image' || source?.type !== 'base64' || !/^image\/[\w.+-]+$/.test(source.media_type ?? '')) continue;
        const data = Buffer.from(source.data ?? '','base64');
        const mediaID = hash(`${id}\0${record.uuid ?? lineIndex}\0${index}`);
        if (!data.length || seen.has(mediaID)) continue;
        seen.add(mediaID);
        const entry = {data, mime:source.media_type, size:data.length, name:`attachment.${source.media_type.split('/')[1]}`};
        this.media.set(mediaID,{...entry,session:key});
        attachments.push({id:mediaID, line:lineIndex, timestamp:record.timestamp, role:'user', itemType:'image', userText, text:userText,
          name:entry.name, mime:entry.mime, size:entry.size, kind:'image', url:`media/${mediaID}`});
      }
    }
    if (previous) for (const item of previous.result.attachments) if (!seen.has(item.id)) this.media.delete(item.id);
    const result = {agent:'claude',session:id,revision,attachments};
    this.cache.set(key,{revision,result});
    while (this.cache.size > 8) {
      const oldest = this.cache.keys().next().value;
      for (const item of this.cache.get(oldest).result.attachments) this.media.delete(item.id);
      this.cache.delete(oldest);
    }
    return result;
  }
  // The model a turn was sent to is named by the nearest earlier turn_context line, so lines are first indexed
  // from the start (cheap), then the newest ones are turned into parts.
  async codexTranscript(id) {
    const file = await this.find(id), info = await stat(file);
    const revision = `${info.mtimeMs}:${info.size}`;
    const key = `codex-transcript:${id}`, previous = this.cache.get(key);
    if (previous?.revision === revision) return previous.result;
    const text = file.endsWith('.zst')
      ? (await run('zstd',['-dc',file], {maxBuffer:1024*1024*1024})).stdout
      : await readFile(file,'utf8');
    const lines = text.split('\n');
    const models = new Array(lines.length);
    let model = '', contextWindow = 0, prompt = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('"turn_context"') && !line.includes('"response_item"')) {
        try {
          const record = JSON.parse(line);
          if (record.type === 'turn_context') {
            model = record.payload?.model ?? '';
            if (typeof record.payload?.model_context_window === 'number') contextWindow = record.payload.model_context_window;
          }
        } catch { /* partial line */ }
      } else if (line.includes('"token_count"') && line.includes('model_context_window')) {
        try {
          const record = JSON.parse(line);
          const window = record.payload?.info?.model_context_window;
          if (record.type === 'event_msg' && record.payload?.type === 'token_count' && typeof window === 'number') contextWindow = window;
        } catch { /* partial line */ }
      }
      if (!prompt && line.includes('"response_item"') && line.includes('"role":"user"')) {
        try {
          const record = JSON.parse(line);
          const content = record.payload?.content;
          if (record.type === 'response_item' && record.payload?.type === 'message' && record.payload?.role === 'user') {
            const parts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.map(part => part?.text ?? '') : [];
            for (const part of parts) {
              const title = promptTitle(part);
              if (title) { prompt = title; break; }
            }
          }
        } catch { /* partial line */ }
      }
      models[i] = model;
    }
    const collected = [];
    let size = 0, cut = false;
    for (let i = lines.length - 1; i >= 0 && !cut; i--) {
      const line = lines[i];
      if (!line.includes('"response_item"')) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type !== 'response_item' || !record.payload) continue;
      const kept = codexParts(record.payload)
        .map(p => p.role === 'assistant' && models[i] ? {...p, model:models[i]} : p)
        .map((p, n) => keepPart(p, i * 1000 + n)).filter(Boolean);
      const chars = kept.reduce((sum, p) => sum + p.text.length, 0);
      if (size + chars > transcriptBudget && collected.length) { cut = true; break; }
      size += chars;
      collected.push(...kept.reverse());
    }
    const named = await codexThreadName(this.home, id);
    const result = {parts:collected.reverse(), cut, source:'plugin', title: named || prompt};
    if (contextWindow) result.contextWindow = contextWindow;
    this.cache.set(key,{revision,result});
    while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
    return result;
  }
  // Newest-first reading: parts are collected from the end of the file until the budget is spent.
  async claudeTranscript(id) {
    const file = await this.findClaude(id), info = await stat(file);
    const revision = `${info.mtimeMs}:${info.size}`;
    const key = `claude-transcript:${id}`, previous = this.cache.get(key);
    if (previous?.revision === revision) return previous.result;
    const lines = (await readFile(file,'utf8')).split('\n');
    let custom = '', named = '', prompt = '', contextWindow = 0;
    for (const line of lines) {
      const titled = line.includes('"custom-title"') || line.includes('"ai-title"') || line.includes('"summary"');
      const windowed = line.includes('contextWindow') || line.includes('model_context_window') || line.includes('"modelUsage"');
      if (!titled && !windowed && (prompt || !line.includes('"type":"user"'))) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type === 'custom-title' && record.customTitle) custom = String(record.customTitle).replace(/\s+/g, ' ').trim();
      else if (record.type === 'ai-title' && record.aiTitle) named = String(record.aiTitle).replace(/\s+/g, ' ').trim();
      else if (record.type === 'summary' && record.summary && !named) named = String(record.summary).replace(/\s+/g, ' ').trim();
      const window = record.contextWindow ?? record.model_context_window ?? record.message?.usage?.contextWindow ?? record.message?.usage?.model_context_window;
      if (typeof window === 'number') contextWindow = window;
      if (record.modelUsage && typeof record.modelUsage === 'object') {
        for (const item of Object.values(record.modelUsage)) {
          if (typeof item?.contextWindow === 'number') contextWindow = item.contextWindow;
        }
      }
      if (!prompt && record.type === 'user' && !record.isMeta && !record.isSidechain) {
        const content = record.message?.content;
        if (Array.isArray(content) && content.some(part => part.type === 'tool_result')) continue;
        const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part.type === 'text').map(part => part.text).join(' ') : '';
        const title = promptTitle(text);
        if (title) prompt = title;
      }
    }
    const collected = [];
    let size = 0, cut = false;
    for (let i = lines.length - 1; i >= 0 && !cut; i--) {
      if (!lines[i].trim()) continue;
      let record;
      try { record = JSON.parse(lines[i]); } catch { continue; }
      const message = record.message;
      if (!message || record.isSidechain) continue;
      let parts;
      if (record.type === 'user' && !record.isMeta) parts = claudeParts(message.content, 'user');
      else if (record.type === 'assistant') {
        const model = message.model === '<synthetic>' ? '' : message.model;
        parts = claudeParts(message.content, 'assistant').map(p => p.role === 'assistant' && model ? {...p, model} : p);
      } else continue;
      const kept = parts.map((p, n) => keepPart(p, i * 1000 + n)).filter(Boolean);
      const chars = kept.reduce((sum, p) => sum + p.text.length, 0);
      if (size + chars > transcriptBudget && collected.length) { cut = true; break; }
      size += chars;
      collected.push(...kept.reverse());
    }
    const result = {parts:collected.reverse(), cut, source:'plugin', title: custom || named || prompt};
    if (contextWindow) result.contextWindow = contextWindow;
    this.cache.set(key,{revision,result});
    while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
    return result;
  }
  async session(id) {
    const file = await this.find(id), info = await stat(file);
    const revision = `${info.mtimeMs}:${info.size}`;
    const previous = this.cache.get(id);
    if (previous?.revision === revision) return previous.result;
    const text = file.endsWith('.zst')
      ? (await run('zstd',['-dc',file], {maxBuffer:512*1024*1024})).stdout
      : await readFile(file,'utf8');
    const attachments = [], seen = new Set();
    const add = async (source, context) => {
      if (typeof source !== 'string' || !source) return;
      let entry;
      const inline = /^data:(image\/[\w.+-]+|video\/[\w.+-]+);base64,([\s\S]+)$/.exec(source);
      if (inline) {
        const data = Buffer.from(inline[2],'base64');
        entry = {data, mime:inline[1], size:data.length, name:`attachment.${inline[1].split('/')[1]}`};
      } else if (isAbsolute(source) && types[extname(source).toLowerCase()]) {
        try {
          const path = await realpath(source), s = await stat(path);
          if (!s.isFile()) return;
          entry = {path, mime:types[extname(path).toLowerCase()], size:s.size, name:basename(path)};
        } catch (e) { if (['ENOENT','ENOTDIR','EACCES','EPERM'].includes(e.code)) return; throw e; }
      } else return;
      const mediaID = hash(id+'\0'+source);
      if (seen.has(mediaID)) return;
      seen.add(mediaID); this.media.set(mediaID, {...entry, session:id});
      attachments.push({id:mediaID, ...context, name:entry.name, mime:entry.mime, size:entry.size, kind:entry.mime.startsWith('video/')?'video':'image', url:`media/${mediaID}`});
    };
    const contentText = value => typeof value === 'string' ? value
      : Array.isArray(value) ? value.map(x => x.text ?? '').filter(Boolean).join('\n') : '';
    let userText = '';
    const calls = new Map();
    let lineIndex = 0;
    for (const line of text.split('\n')) {
      lineIndex++;
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; } // rollout's last line can still be streaming
      if (record.type !== 'response_item') continue;
      const p = record.payload ?? {};
      const messageText = contentText(p.content ?? p.output);
      if (p.role === 'user') userText = messageText;
      if (['function_call','custom_tool_call','local_shell_call'].includes(p.type)) {
        calls.set(p.call_id ?? p.id, p.arguments ?? p.input ?? '');
      }
      const context = {line:lineIndex, timestamp:record.timestamp, role:p.role ?? 'tool', itemType:p.type,
        callID:p.call_id, toolInput:calls.get(p.call_id), userText, text:messageText};
      // Codex app records both attachment wrappers and their encoded image
      // parts. Prefer the encoded parts when they cover every wrapper.
      const wrappers = [...messageText.matchAll(/<image\b[^>]*\bpath="([^"\n]+)"/g)].map(x => x[1]);
      const inlineCount = Array.isArray(p.content)
        ? p.content.filter(x => x.type === 'input_image' && /^data:image\//.test(x.image_url ?? '')).length : 0;
      const coveredPaths = new Set(inlineCount >= wrappers.length ? wrappers : []);
      const walk = async value => {
        if (Array.isArray(value)) { for (const x of value) await walk(x); return; }
        if (value && typeof value === 'object') {
          for (const [key,v] of Object.entries(value)) {
            if (['image_url','url','path'].includes(key) && typeof v === 'string') await add(v,context);
            else await walk(v);
          }
        } else if (typeof value === 'string') {
          // Codex app's attachment wrapper and Markdown produced by tools.
          for (const match of value.matchAll(/\bpath="([^"\n]+)"|!\[[^\]]*\]\((\/[^)\n]+)\)/g)) {
            const source = match[1] ?? match[2];
            if (!coveredPaths.has(source)) await add(source,context);
          }
          if (/^\s*[\[{]/.test(value)) {
            let nested; try { nested = JSON.parse(value); } catch { return; }
            await walk(nested);
          }
        }
      };
      await walk(p.content); await walk(p.output);
    }
    if (previous) for (const item of previous.result.attachments) if (!seen.has(item.id)) this.media.delete(item.id);
    const result = {agent:'codex',session:id,revision,attachments};
    this.cache.set(id,{revision,result});
    while (this.cache.size > 8) {
      const oldest = this.cache.keys().next().value;
      for (const item of this.cache.get(oldest).result.attachments) this.media.delete(item.id);
      this.cache.delete(oldest);
    }
    return result;
  }
}
function json(res,status,body) {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(body));
}
// TokenDance reads the Kilo subscription. These fields only: stripe ids, subscription ids and the key stay out.
const kiloFields = ['tier','cadence','status','cancelAtPeriodEnd','startedAt','nextBillingAt','refillAt','currentPeriodBaseCreditsUsd','currentPeriodUsageUsd','currentPeriodBonusCreditsUsd','isBonusUnlocked','nextBonusCreditsUsd','currentStreakMonths'];
async function kiloPass() {
  const {providers} = JSON.parse(await readFile(join(homedir(),'.config','magpie','providers.json'),'utf8'));
  const key = providers.find(provider => provider.id === 'kilo')?.key;
  if (!key) throw Object.assign(new Error('kilo provider is not configured'), {status:404});
  const headers = {Authorization:`Bearer ${key}`};
  const [state, balance] = await Promise.all([
    fetch('https://api.kilo.ai/api/trpc/kiloPass.getState', {headers}),
    fetch('https://api.kilo.ai/api/profile/balance', {headers}),
  ]);
  if (!state.ok || !balance.ok) throw Object.assign(new Error(`Kilo request failed (${state.status}, ${balance.status})`), {status:502});
  const subscription = (await state.json()).result.data.subscription ?? {};
  const body = {};
  for (const name of kiloFields) body[name] = subscription[name];
  body.balance = (await balance.json()).balance;
  return body;
}
export async function handle(store,req,res) {
  // Magpie frames use an opaque sandbox origin, including after navigation
  // to the local service. Fetch therefore needs an explicit CORS response.
  if (req.headers.origin === 'null') {
    res.setHeader('Access-Control-Allow-Origin', 'null');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  }
  try {
    const url = new URL(req.url,'http://localhost');
    if (!['GET','HEAD'].includes(req.method)) { res.setHeader('Allow','GET, HEAD'); return json(res,405,{error:'Read-only service'}); }
    if (url.pathname === '/health') return json(res,200,{name:'magpie-tt-media',version:'0.9.0',agents:['codex','claude','pi'],capabilities:['media','activity','transcript']});
    if (url.pathname === '/kilo') return json(res,200,await kiloPass());
    if (url.pathname === '/activity') {
      const result = await store.activity.snapshot(url.searchParams.get('id') ?? '', Number(url.searchParams.get('after') ?? 0), url.searchParams.get('epoch') ?? '', url.searchParams.get('agent') ?? 'codex');
      return json(res,200,result);
    }
    if (url.pathname === '/session') {
      const agent = url.searchParams.get('agent') ?? 'codex', id = url.searchParams.get('id') ?? '';
      if (agent === 'codex') return json(res,200,await store.session(id));
      if (['claude','claude-desktop'].includes(agent)) return json(res,200,await store.claudeSession(id));
      return json(res,400,{error:'This version supports Codex and Claude sessions'});
    }
    if (url.pathname === '/transcript') {
      const agent = url.searchParams.get('agent') ?? 'claude', id = url.searchParams.get('id') ?? '';
      if (agent === 'codex') return json(res,200,await store.codexTranscript(id));
      if (!['claude','claude-desktop'].includes(agent)) return json(res,400,{error:'This version reads Codex and Claude transcripts'});
      return json(res,200,await store.claudeTranscript(id));
    }
    if (url.pathname.startsWith('/media/')) {
      const entry = store.media.get(url.pathname.slice(7));
      if (!entry) return json(res,404,{error:'Load the session attachment list first'});
      const size = entry.data?.length ?? (await stat(entry.path)).size;
      let start = 0, end = size-1, status = 200;
      if (req.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!match || (!match[1] && !match[2])) { res.setHeader('Content-Range',`bytes */${size}`); return json(res,416,{error:'Invalid byte range'}); }
        start = match[1] ? Number(match[1]) : Math.max(0,size-Number(match[2]));
        end = match[1] && match[2] ? Math.min(size-1,Number(match[2])) : size-1;
        if (start > end || start >= size) { res.setHeader('Content-Range',`bytes */${size}`); return json(res,416,{error:'Range outside file'}); }
        status = 206;
      }
      const headers = {'Content-Type':entry.mime,'Content-Length':Math.max(0,end-start+1),'Accept-Ranges':'bytes','Cache-Control':'private, no-cache','X-Content-Type-Options':'nosniff'};
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      res.writeHead(status,headers);
      if (req.method === 'HEAD' || !size) return res.end();
      if (entry.data) return res.end(entry.data.subarray(start,end+1));
      const stream = createReadStream(entry.path,{start,end});
      stream.on('error',e=>res.destroy(e)); res.on('close',()=>stream.destroy()); stream.pipe(res); return;
    }
    if (url.pathname === '/') {
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      return res.end(await readFile(new URL('../page/service.html',import.meta.url)));
    }
    json(res,404,{error:'Not found'});
  } catch (e) {
    if (!res.headersSent) json(res,e.status ?? 500,{error:e.message}); else res.destroy(e);
  }
}
