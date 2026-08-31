import { describe, expect, it } from 'vitest';

import { parseAgentActivityFeed } from './agent-activity-feed.js';

describe('agent activity feed parser', () => {
  it('turns Codex JSONL into ordered agent messages and command rows', () => {
    const feed = parseAgentActivityFeed(`
{"type":"thread.started","thread_id":"thread-1"}
{"type":"item.completed","item":{"type":"agent_message","text":"Inspecting the repository."}}
{"type":"item.started","item":{"type":"command_execution","id":"cmd-1","command":"pnpm test","status":"in_progress"}}
{"type":"item.completed","item":{"type":"command_execution","id":"cmd-1","command":"pnpm test","aggregated_output":"All tests passed","status":"completed","exit_code":0}}
{"type":"item.completed","item":{"type":"agent_message","text":"The checks are green."}}
{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}
`);

    const events = feed.attempts[0]?.events ?? [];

    expect(events.map((event) => event.kind)).toEqual(['message', 'command', 'message']);
    expect(events[0]).toMatchObject({ detail: 'Inspecting the repository.' });
    expect(events[1]).toMatchObject({
      command: 'pnpm test',
      output: 'All tests passed',
      status: 'completed',
      exitCode: 0,
    });
    expect(feed.attempts[0]?.status).toBe('completed');
  });

  it('adapts Claude tool use and tool result events into one command row', () => {
    const feed = parseAgentActivityFeed(`
{"type":"assistant","message":{"content":[{"type":"text","text":"I will inspect the diff."},{"type":"tool_use","id":"tool-1","name":"Bash","input":{"command":"git diff --stat"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":"2 files changed"}]}}
{"type":"result","is_error":false}
`);

    const events = feed.attempts[0]?.events ?? [];

    expect(events.map((event) => event.kind)).toEqual(['message', 'command']);
    expect(events[1]).toMatchObject({
      command: 'git diff --stat',
      input: '{\n  "command": "git diff --stat"\n}',
      output: '2 files changed',
      status: 'completed',
      exitCode: 0,
    });
  });
});
