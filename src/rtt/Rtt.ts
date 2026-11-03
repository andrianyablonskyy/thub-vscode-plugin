import * as vscode from 'vscode';
import type { RttConfig } from '../cli/types';
import type { SessionManager } from '../session/SessionManager';
import { RttTerminals } from './RttTerminal';

async function selectProbe(session: Awaited<ReturnType<SessionManager['ensureUp']>>, index?: number): Promise<number> {
  const probes = session.ready?.ports.filter((port) => port.kind === 'swd') || [];
  if (!probes.length){
    throw new Error(`${session.client} has no ST-Links`);
  }
  if (index !== undefined){
    if (!probes.some((probe) => probe.index === index)){
      throw new Error(`${session.client} has no ST-Link ${index}`);
    }
    return index;
  }
  if (probes.length === 1){
    return probes[0].index;
  }
  const pick = await vscode.window.showQuickPick(
    probes.map((probe) => ({ label: `ST-Link ${probe.index}`, description: `${probe.label} · ${probe.target || session.target || 'no OpenOCD target'}`, index: probe.index })),
    { title: `thub: ${session.client} — which ST-Link?` }
  );
  if (!pick){
    throw new Error('Canceled');
  }
  return pick.index;
}

async function promptConfig(index: number, existing?: RttConfig, defaultTarget?: string): Promise<RttConfig | undefined> {
  const address = await vscode.window.showInputBox({
    title: `RTT · ST-Link ${index} · control-block search range`,
    prompt: 'RAM start address to search for the SEGGER RTT control block (from the linker map)',
    value: existing?.address || '0x20000000',
    validateInput: (value) => /^(?:0[xX][0-9a-fA-F]{1,8}|[0-9]{1,10})$/.test(value.trim())
      ? undefined : 'Enter a 32-bit address in decimal or hexadecimal'
  });
  if (address === undefined){
    return undefined;
  }
  const size = await vscode.window.showInputBox({
    title: `RTT · ST-Link ${index} · control-block search range`,
    prompt: 'Number of bytes to search from the start address',
    value: existing?.size || '0x10000',
    validateInput: (value) => {
      const n = value.trim();
      return /^(?:0[xX][0-9a-fA-F]{1,8}|[0-9]{1,10})$/.test(n) && Number(n) > 0
        ? undefined : 'Enter a positive 32-bit size in decimal or hexadecimal';
    }
  });
  if (size === undefined){
    return undefined;
  }
  const target = await promptTarget(index, existing?.target || defaultTarget || '', !defaultTarget);
  if (target === undefined){
    return undefined;
  }
  const channel = await vscode.window.showInputBox({
    title: `RTT · ST-Link ${index} · up-channel`,
    prompt: 'RTT up-channel to read (0 is the usual log channel)',
    value: String(existing?.channel ?? 0),
    validateInput: (value) => /^\d+$/.test(value) && Number(value) <= 255
      ? undefined : 'Enter a channel between 0 and 255'
  });
  return channel === undefined ? undefined : {
    index, address: address.trim(), size: size.trim(), channel: Number(channel),
    ...(target ? { target } : {})
  };
}

async function promptTarget(index: number, value: string, required: boolean): Promise<string | undefined> {
  const target = await vscode.window.showInputBox({
    title: `RTT · ST-Link ${index} · OpenOCD target`,
    prompt: required
      ? 'Required: OpenOCD target script name, for example stm32g4x'
      : 'Target script name, for example stm32g4x; leave blank to use the Client configuration',
    value,
    placeHolder: 'stm32g4x',
    validateInput: (input) => {
      const trimmed = input.trim();
      if (required && !trimmed){
        return 'Enter the OpenOCD target script name';
      }
      return !trimmed || /^[A-Za-z0-9_.-]{1,64}$/.test(trimmed)
        ? undefined : 'Enter an OpenOCD target script name, for example stm32g4x';
    }
  });
  return target === undefined ? undefined : target.trim() || undefined;
}

async function waitForRestart(mgr: SessionManager, session: Awaited<ReturnType<SessionManager['ensureUp']>>): Promise<void> {
  if (mgr.getSession(session.client) === session && !session.isUp){
    await session.whenUp();
  }
}

export async function configureRtt(mgr: SessionManager, terminals: RttTerminals, requestedIndex?: number, client?: string): Promise<void> {
  const session = await mgr.ensureUp('RTT logs', undefined, client),
    index = await selectProbe(session, requestedIndex),
    existing = mgr.getRttConfigs(session.client).find((entry) => entry.index === index),
    config = await promptConfig(index, existing, session.ready?.ports.find((port) => port.kind === 'swd' && port.index === index)?.target || session.target);
  if (!config){
    return;
  }
  terminals.close(session, index);
  await mgr.setRttConfigs([...mgr.getRttConfigs(session.client).filter((entry) => entry.index !== index), config], session.client);
  await waitForRestart(mgr, session);
  terminals.show(session, index, config.channel);
}

export async function openRtt(mgr: SessionManager, terminals: RttTerminals, index: number, client?: string): Promise<void> {
  const session = await mgr.ensureUp('RTT logs', undefined, client),
    config = mgr.getRttConfigs(session.client).find((entry) => entry.index === index);
  if (!config){
    await configureRtt(mgr, terminals, index, session.client);
    return;
  }
  const portTarget = session.ready?.ports.find((port) => port.kind === 'swd' && port.index === index)?.target,
    target = config.target || portTarget || session.target;
  if (!target){
    const configuredTarget = await promptTarget(index, '', true);
    if (!configuredTarget){
      return;
    }
    const updated = { ...config, target: configuredTarget };
    await mgr.setRttConfigs([...mgr.getRttConfigs(session.client).filter((entry) => entry.index !== index), updated], session.client);
    await waitForRestart(mgr, session);
  }
  terminals.show(session, index, config.channel);
}

export async function removeRtt(mgr: SessionManager, terminals: RttTerminals, index: number, client?: string): Promise<void> {
  const config = mgr.getRttConfigs(client).find((entry) => entry.index === index);
  if (!config){
    throw new Error(`RTT configuration for ST-Link ${index} was not found`);
  }
  const answer = await vscode.window.showWarningMessage(
    `Remove the RTT log configuration for ST-Link ${index}?`,
    { modal: true },
    'Remove'
  );
  if (answer !== 'Remove'){
    return;
  }
  const session = client ? mgr.getSession(client) : mgr.session;
  await mgr.setRttConfigs(mgr.getRttConfigs(client).filter((entry) => entry.index !== index), client);
  if (session){
    terminals.close(session, index);
  }
}
