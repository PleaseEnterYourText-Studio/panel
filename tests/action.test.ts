import { describe, it, expect } from 'vitest';
import {
  ACTIONS,
  actionsFor,
  isEnabled,
  CommandNotAvailableError,
  UnavailableChannel,
  type CommandChannel,
  type AllowedVerb,
} from '../src/domain/action';

describe('actions', () => {
  it('only probe.run is enabled in P0', () => {
    const enabled = ACTIONS.filter(isEnabled);
    expect(enabled.map((a) => a.id)).toEqual(['probe.run']);
  });

  it('holds no action ids duplicated', () => {
    const ids = ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('owner sees phase 3 actions but they stay disabled', () => {
    const all = actionsFor('owner');
    const restart = all.find((a) => a.id === 'service.restart');
    expect(restart?.phase).toBe(3);
    expect(restart?.danger).toBe('confirm');
    expect(restart && isEnabled(restart)).toBe(false);
  });

  // 过滤职责是「谁能看到按钮」，禁用职责是 isEnabled(action)。
  // viewer 看不到 service.restart，但能看见 danger=none 的 service.logs——
  // 它是 phase 3，所以可见但禁用（UI 显示 P3 徽章）。
  it('viewer hides write actions but keeps danger-none phase 3 ones visible-disabled', () => {
    const visible = actionsFor('viewer');
    expect(visible.some((a) => a.id === 'service.restart')).toBe(false);

    const logs = visible.find((a) => a.id === 'service.logs');
    expect(logs).toBeDefined();
    expect(logs?.danger).toBe('none');
    expect(logs?.phase).toBe(3);
    expect(logs && isEnabled(logs)).toBe(false);
  });

  it('ops sees service.restart but it is disabled', () => {
    const restart = actionsFor('ops').find((a) => a.id === 'service.restart');
    expect(restart).toBeDefined();
    expect(restart && isEnabled(restart)).toBe(false);
  });

  it('marks agent.restart as typed, irreversible and owner-only', () => {
    const agent = ACTIONS.find((a) => a.id === 'agent.restart');
    expect(agent?.danger).toBe('typed');
    expect(agent?.reversible).toBe(false);
    expect(agent?.roles).toEqual(['owner']);
    expect(agent && isEnabled(agent)).toBe(false);
  });

  it('exposes a typed error for unavailable commands', () => {
    const err = new CommandNotAvailableError();
    expect(err.name).toBe('CommandNotAvailableError');
    expect(err.message).toContain('phase 3');
  });

  it('UnavailableChannel rejects dispatch with the typed error', async () => {
    // 按接口类型持有：UnavailableChannel.dispatch 自身不声明参数（实现可窄于契约），
    // 调用点走 CommandChannel 才能传 actor / server / verb / args。
    const channel: CommandChannel = new UnavailableChannel();
    const verb: AllowedVerb = 'check.health';
    const pending = channel.dispatch('actor@example.com', 'srv-1', verb, {});
    await expect(pending).rejects.toBeInstanceOf(CommandNotAvailableError);
    await expect(pending).rejects.toBeInstanceOf(Error);
  });
});
