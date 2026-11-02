import { open, stat, readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Read display text only; never execute the recorded JavaScript wrapper.
function literalText(literal) {
  if (literal.startsWith('"')) return JSON.parse(literal);
  const text = literal.slice(1, -1);
  if (literal.startsWith('`') && text.includes('${')) return null;
  return text.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, escaped) => {
    if (escaped[0] === 'u' || escaped[0] === 'x') return String.fromCharCode(parseInt(escaped.slice(1), 16));
    return ({n:'\n', r:'\r', t:'\t', '\n':''})[escaped] ?? escaped;
  });
}
function actionDetail(payload, name, input) {
  let args = input;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { /* Custom tools carry raw text. */ }
  }
  if (name === 'exec' && typeof args === 'string') {
    const commands = [...args.matchAll(/tools\.exec_command\s*\(\s*\{\s*(?:"cmd"|'cmd'|cmd)\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g)]
      .map(match => literalText(match[1])).filter(text => text !== null);
    if (commands.length) return commands.map(commandSummary).join('\n');
  }
  if (args && typeof args === 'object') {
    const command = args.cmd ?? args.command ?? payload.action?.command;
    if (command) return commandSummary(Array.isArray(command) ? command.join(' ') : String(command));
    const queries = args.search_query ?? args.image_query;
    if (Array.isArray(queries)) return queries.map(query => query.q).filter(Boolean).join(' · ');
    if (args.query ?? args.q ?? args.path) return String(args.query ?? args.q ?? args.path);
  }
  if (payload.action?.command) return commandSummary([].concat(payload.action.command).join(' '));
  return null;
}


// A shell command reads best by what it actually runs: skip a leading `cd <dir> &&` / `pwd &&`
// style preamble, then keep the first real command with its subcommand.
const preamble = /^\s*(?:(?:cd|pushd)\s+(?:"[^"]*"|'[^']*'|\S+)|pwd|set\s+-\S+|export\s+\S+=\S*|source\s+\S+|true)\s*(?:&&|;|\|\||\n)\s*/;
export function commandSummary(command) {
  let text = String(command ?? '').trim();
  for (let i = 0; i < 6; i++) {
    const next = text.replace(preamble, '');
    if (next === text) break;
    text = next;
  }
  // First command only: stop at a separator that is not inside quotes or $( ).
  let quote = '', depth = 0, end = text.length;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === '\\' && quote === '"') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '$' && text[i + 1] === '(') { depth++; i++; continue; }
    if (ch === ')' && depth) { depth--; continue; }
    if (depth) continue;
    if (ch === '\n' || ch === ';' || (ch === '&' && text[i + 1] === '&') || (ch === '|' && text[i + 1] === '|')) { end = i; break; }
  }
  let first = text.slice(0, end).trim();
  const heredoc = first.indexOf('<<');
  if (heredoc > 0) first = first.slice(0, heredoc).trim();
  // A bare `VAR=$(...)` assignment: show the command inside it.
  const assigned = /^[A-Za-z_]\w*=\$\(([^|)]*)/.exec(first);
  if (assigned) first = commandSummary(assigned[1]);
  // An unterminated quote (a multi-line script argument) is cut at the opening quote.
  if (quote) first = first.slice(0, first.lastIndexOf(quote)).trim() + ' …';
  // A quoted multi-line script argument (`node -e "…"`): keep the command and its flag only.
  else if (first.includes('\n')) first = first.split('\n')[0].trim() + ' …';
  return first || String(command ?? '').trim();
}
const oneLine = value => String(value).replace(/\s+/g, ' ').trim();
const base = path => String(path).split('/').filter(Boolean).pop() ?? String(path);

function action(payload) {
  const name = payload.name ?? payload.type;
  const input = payload.arguments ?? payload.input ?? '';
  const categories=[];
  if (/^(web_search_call|web_search|web\.run)$/.test(name) || (name === 'exec' && /tools\.(?:web__run|mcp__codex_apps__search_service_web_run)\s*\(/.test(input))) categories.push('search');
  if (['exec_command','shell_command','shell','local_shell_call'].includes(name) || (name === 'exec' && /tools\.exec_command\s*\(/.test(input))) categories.push('command');
  if (['apply_patch','write_file','edit_file'].includes(name) || (name === 'exec' && /tools\.apply_patch\s*\(/.test(input))) categories.push('edit');
  if (['read_file','view_image'].includes(name)) categories.push('read');
  return {category:categories.length===1?categories[0]:'tool', name, detail:actionDetail(payload, name, input), described:false};
}

export class ActivityStore {
  constructor(media) { this.media = media; this.sessions = new Map(); }
  async snapshot(id, after = 0, epoch = '', agent = 'codex') {
    const family = agent === 'claude' || agent === 'claude-desktop' ? 'claude'
      : ['pi', 'pi-agent', 'pi-coding-agent', 'pi-cli'].includes(agent) ? 'pi' : 'codex';
    const key = `${family}:${id}`;
    const locate = () => family === 'claude' ? this.media.findClaude(id) : family === 'pi' ? this.media.findPi(id) : this.media.find(id);
    let file = this.sessions.get(key)?.file ?? await locate(), info;
    try { info = await stat(file); }
    catch (error) {
      if (error.code !== 'ENOENT' || file !== this.sessions.get(key)?.file) throw error;
      this.sessions.delete(key);
      file = await locate();
      info = await stat(file);
    }
    if (family === 'codex' && file.endsWith('.zst')) throw Object.assign(new Error('Live activity requires an uncompressed Codex rollout'), {status:422});
    let state = this.sessions.get(key);
    const cacheRoot = family === 'claude' ? this.media.claudeHome : family === 'pi' ? this.media.piHome : this.media.home;
    const cacheDirectory = join(cacheRoot, 'tt-activity');
    const cacheFile = join(cacheDirectory, `${id}.json`);
    if (!state) {
      try {
        const saved = JSON.parse(await readFile(cacheFile, 'utf8'));
        state = {...saved, epoch:randomUUID(), tail:Buffer.from(saved.tail, 'base64')};
        state.turns = saved.turns.map(turn => ({...turn, active:new Map(turn.active)}));
        state.current = state.turns.find(turn => turn.id === saved.currentID) ?? null;
        if (state.current?.status === 'running') state.current.timingIncomplete = true;
        this.sessions.set(key, state);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    let changed = false;
    let rebuilt = false;
    if (!state || state.file !== file || state.ino !== info.ino || info.size < state.offset) {
      state = {file, ino:info.ino, offset:0, tail:Buffer.alloc(0), epoch:randomUUID(), cursor:0, turns:[], events:[], current:null};
      this.sessions.set(key,state);
      changed = true;
      rebuilt = true;
    }
    if (info.size > state.offset) {
      changed = true;
      const handle = await open(file,'r');
      try {
        let position = state.offset;
        while (position < info.size) {
          const buffer = Buffer.alloc(Math.min(256*1024,info.size-position));
          const {bytesRead} = await handle.read(buffer,0,buffer.length,position);
          if (!bytesRead) break;
          position += bytesRead;
          const pending = Buffer.concat([state.tail,buffer.subarray(0,bytesRead)]);
          let begin = 0, end;
          while ((end=pending.indexOf(10,begin)) !== -1) {
            const line=pending.subarray(begin,end).toString('utf8');begin=end+1;
            if (!line.trim()) continue;
            let record;try {record=JSON.parse(line);}catch {continue;}
            if (family === 'claude') consumeClaude(this, state, record);
            else if (family === 'pi') consumePi(this, state, record);
            else this.consume(state, record);
          }
          state.tail = Buffer.from(pending.subarray(begin));
          state.offset = position;
        }
      } finally { await handle.close(); }
    }
    // A historical start alone cannot establish that a turn is still executing.
    if (rebuilt && state.current?.status === 'running') state.current.timingIncomplete = true;
    if (changed) {
      await mkdir(cacheDirectory, {recursive:true});
      const saved = {...state, tail:state.tail.toString('base64'), current:undefined,
        currentID:state.current?.id,
        turns:state.turns.map(turn => ({...turn, active:[...turn.active]}))};
      await writeFile(`${cacheFile}.tmp`, JSON.stringify(saved));
      await rename(`${cacheFile}.tmp`, cacheFile);
    }
    const completedSeconds = state.turns.reduce((sum, turn) =>
      sum + (turn.startedAt && turn.endedAt ? Math.max(0, (Date.parse(turn.endedAt)-Date.parse(turn.startedAt))/1000) : 0), 0);
    const incompleteTurns = state.turns.filter(turn => !turn.startedAt ||
      (!turn.endedAt && (turn.status !== 'running' || turn.timingIncomplete))).length;
    const reset = epoch !== state.epoch || after > state.cursor || (state.events.length && after < state.events[0].sequence-1);
    const current = state.current;
    const response = {agent:family, session:id, epoch:state.epoch, cursor:state.cursor, reset:Boolean(reset),
      completedSeconds, incompleteTurns,
      current:current ? this.publicTurn(current) : null,
      turns:state.turns.slice(-30).map(x=>this.publicTurn(x)),
      events:state.events.filter(x=>reset || x.sequence>after)};
    while (this.sessions.size>8) this.sessions.delete(this.sessions.keys().next().value);
    return response;
  }
  publicTurn(turn) {
    const {active,...result}=turn;
    return {...result, activeTools:[...active.values()]};
  }
  emit(state, turn, record, kind, details={}) {
    const event={sequence:++state.cursor,turnID:turn.id,time:record.timestamp,kind,...details};
    state.events.push(event);
    if (state.events.length>200) state.events.shift();
    turn.lastEvent=event;
  }
  consume(state,record) {
    const p=record.payload ?? {}, time=record.timestamp;
    if (record.type==='event_msg' && p.type==='task_started' && p.turn_id) {
      if (state.current?.status==='running' && state.current.id!==p.turn_id) {
        state.current.status='unknown';state.current.active.clear();
      }
      let turn=state.turns.find(x=>x.id===p.turn_id);
      if (!turn) {
        turn={id:p.turn_id,status:'running',startedAt:time,endedAt:null,active:new Map(),lastEvent:null};
        state.turns.push(turn);
      }
      turn.timingIncomplete=false;
      state.current=turn;this.emit(state,turn,record,'started');return;
    }
    if (record.type==='event_msg' && ['task_complete','turn_aborted','task_aborted'].includes(p.type)) {
      let turn=p.turn_id ? state.turns.find(x=>x.id===p.turn_id) : state.current;
      if (!turn && p.turn_id) {
        turn={id:p.turn_id,status:'unknown',startedAt:null,endedAt:null,active:new Map(),lastEvent:null};
        state.turns.push(turn);state.current=turn;
      }
      if (!turn) return;
      turn.status=p.type==='task_complete'?'completed':'cancelled';turn.endedAt=time;turn.timingIncomplete=false;turn.active.clear();
      this.emit(state,turn,record,turn.status);return;
    }
    const turn=state.current;
    if (!turn || turn.status!=='running' || record.type!=='response_item') return;
    if (['function_call','custom_tool_call','local_shell_call','web_search_call'].includes(p.type)) {
      const callID=p.call_id ?? p.id;
      if (!callID) return;
      const details={callID,...action(p)};
      this.emit(state,turn,record,'tool_started',details);
      // Some built-in calls are only written once, after they have finished.
      if (p.status==='completed' && ['web_search_call','local_shell_call'].includes(p.type)) {
        this.emit(state,turn,record,'tool_returned',details);
      } else turn.active.set(callID,{...details,startedAt:time});
    } else if (['function_call_output','custom_tool_call_output'].includes(p.type)) {
      const details=turn.active.get(p.call_id);
      turn.active.delete(p.call_id);
      this.emit(state,turn,record,'tool_returned',{callID:p.call_id,...details});
    } else if (p.type==='message' && p.role==='assistant') {
      this.emit(state,turn,record,'reply_recorded',{channel:p.channel ?? null});
    }
  }
}

// Claude Code (also Claude Desktop's Code tab) session files: a turn starts at a
// real user prompt and ends at an assistant message with stop_reason end_turn.
const claudeNames = {
  Bash:'command', PowerShell:'command', Read:'read', NotebookRead:'read',
  Edit:'edit', Write:'edit', MultiEdit:'edit', NotebookEdit:'edit',
  Grep:'search', Glob:'search', WebSearch:'search', WebFetch:'search'
};
function claudeAction(block) {
  const input = block.input ?? {};
  const category = claudeNames[block.name] ?? 'tool';
  const described = typeof input.description === 'string' && input.description.trim() ? oneLine(input.description) : null;
  let detail = null;
  let fromDescription = Boolean(described);
  if (category === 'command') {
    detail = input.command ? commandSummary(input.command) : described;
    fromDescription = !input.command && Boolean(described);
  } else if (category === 'read' || category === 'edit') detail = described ?? ((input.file_path ?? input.notebook_path) ? base(input.file_path ?? input.notebook_path) : null);
  else detail = described ?? input.pattern ?? input.query ?? input.url ?? input.path ?? null;
  return {category, name:block.name, detail:detail === null ? null : String(detail), described:fromDescription};
}
export function consumeClaude(store, state, record) {
  const time = record.timestamp, message = record.message;
  if (!time || !message || !['user','assistant'].includes(record.type) || record.isSidechain) return;
  const blocks = Array.isArray(message.content) ? message.content : [{type:'text', text:String(message.content ?? '')}];
  if (record.type === 'user') {
    const results = blocks.filter(b => b.type === 'tool_result');
    const turn = state.current;
    for (const result of results) {
      if (!turn || turn.status !== 'running') continue;
      const details = turn.active.get(result.tool_use_id);
      turn.active.delete(result.tool_use_id);
      store.emit(state, turn, record, 'tool_returned', {callID:result.tool_use_id, ...details});
    }
    if (results.length || record.isMeta || !blocks.some(b => b.type === 'text' || b.type === 'image')) return;
    // Only a real prompt opens a turn; a new one closes a turn that never ended.
    if (state.current?.status === 'running') {
      state.current.status = 'unknown'; state.current.active.clear();
    }
    const id = record.promptId ?? record.uuid;
    const next = {id, status:'running', startedAt:time, endedAt:null, active:new Map(), lastEvent:null, timingIncomplete:false};
    state.turns.push(next); state.current = next;
    store.emit(state, next, record, 'started');
    return;
  }
  const turn = state.current;
  if (!turn || turn.status !== 'running') return;
  for (const block of blocks) {
    if (block.type === 'tool_use' && block.id) {
      const details = {callID:block.id, ...claudeAction(block)};
      store.emit(state, turn, record, 'tool_started', details);
      turn.active.set(block.id, {...details, startedAt:time});
    } else if (block.type === 'text' && block.text?.trim()) {
      store.emit(state, turn, record, 'reply_recorded', {channel:null});
    }
  }
  if (message.stop_reason === 'end_turn') {
    turn.status = 'completed'; turn.endedAt = time; turn.timingIncomplete = false; turn.active.clear();
    store.emit(state, turn, record, 'completed');
  }
}

// Pi session files: a real user message opens a turn. toolCall / toolResult pair by id.
// stop ends the turn; error ends it as failed. A later assistant in the same turn is a retry
// and reopens that failed turn. A new user message marks a still-running turn unknown.
const piNames = {bash:'command', read:'read', edit:'edit', write:'edit'};
function piAction(call) {
  let args = call.arguments ?? {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
  const category = piNames[call.name] ?? 'tool';
  let detail = null;
  if (category === 'command') detail = args.command ? commandSummary(String(args.command)) : null;
  else if (category === 'read' || category === 'edit') detail = args.path ? base(String(args.path)) : null;
  else if (args.path ?? args.query ?? args.pattern) detail = String(args.path ?? args.query ?? args.pattern);
  return {category, name:call.name, detail, described:false};
}
export function consumePi(store, state, record) {
  if (record.type !== 'message') return;
  const time = record.timestamp, message = record.message;
  if (!time || !message) return;
  const blocks = Array.isArray(message.content) ? message.content : [];
  if (message.role === 'toolResult') {
    const turn = state.current;
    if (!turn || turn.status !== 'running') return;
    const callID = message.toolCallId;
    const details = callID ? turn.active.get(callID) : null;
    if (callID) turn.active.delete(callID);
    store.emit(state, turn, record, 'tool_returned', {callID, ...details});
    return;
  }
  if (message.role === 'user') {
    if (!blocks.some(block => block.type === 'text' && String(block.text ?? '').trim())) return;
    if (state.current?.status === 'running') {
      state.current.status = 'unknown'; state.current.active.clear();
    }
    const id = record.id;
    const next = {id, status:'running', startedAt:time, endedAt:null, active:new Map(), lastEvent:null, timingIncomplete:false};
    state.turns.push(next); state.current = next;
    store.emit(state, next, record, 'started');
    return;
  }
  if (message.role !== 'assistant') return;
  const turn = state.current;
  if (!turn) return;
  if (turn.status === 'failed') {
    turn.status = 'running'; turn.endedAt = null; turn.timingIncomplete = false;
  }
  if (turn.status !== 'running') return;
  for (const block of blocks) {
    if (block.type === 'toolCall' && block.id) {
      const details = {callID:block.id, ...piAction(block)};
      store.emit(state, turn, record, 'tool_started', details);
      turn.active.set(block.id, {...details, startedAt:time});
    } else if (block.type === 'text' && String(block.text ?? '').trim()) {
      store.emit(state, turn, record, 'reply_recorded', {channel:null});
    }
  }
  if (message.stopReason === 'stop') {
    turn.status = 'completed'; turn.endedAt = time; turn.timingIncomplete = false; turn.active.clear();
    store.emit(state, turn, record, 'completed');
  } else if (message.stopReason === 'error') {
    turn.status = 'failed'; turn.endedAt = time; turn.timingIncomplete = false; turn.active.clear();
    store.emit(state, turn, record, 'failed');
  }
}
