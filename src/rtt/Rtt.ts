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

async function promptConfig(index: number, existing?: RttConfig): Promise<RttConfig | undefined> {
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
  const channel = await vscode.window.showInputBox({
    title: `RTT · ST-Link ${index} · up-channel`,
    prompt: 'RTT up-channel to read (0 is the usual log channel)',
    value: String(existing?.channel ?? 0),
    validateInput: (value) => /^\d+$/.test(value) && Number(value) <= 255
      ? undefined : 'Enter a channel between 0 and 255'
  });
  return channel === undefined ? undefined : { index, address: address.trim(), size: size.trim(), channel: Number(channel) };
}

async function waitForRestart(mgr: SessionManager, session: Awaited<ReturnType<SessionManager['ensureUp']>>): Promise<void> {
  if (mgr.session === session && !session.isUp){
    await session.whenUp();
  }
}

export async function configureRtt(mgr: SessionManager, terminals: RttTerminals, requestedIndex?: number): Promise<void> {
  const session = await mgr.ensureUp('RTT logs'),
    index = await selectProbe(session, requestedIndex),
    existing = mgr.rttConfigs.find((entry) => entry.index === index),
    config = await promptConfig(index, existing);
  if (!config){
    return;
  }
  terminals.close(session, index);
  await mgr.setRttConfigs([...mgr.rttConfigs.filter((entry) => entry.index !== index), config]);
  await waitForRestart(mgr, session);
  terminals.show(session, index, config.channel);
}

export async function openRtt(mgr: SessionManager, terminals: RttTerminals, index: number): Promise<void> {
  const session = await mgr.ensureUp('RTT logs'),
    config = mgr.rttConfigs.find((entry) => entry.index === index);
  if (!config){
    await configureRtt(mgr, terminals, index);
    return;
  }
  terminals.show(session, index, config.channel);
}

export async function removeRtt(mgr: SessionManager, terminals: RttTerminals, index: number): Promise<void> {
  const config = mgr.rttConfigs.find((entry) => entry.index === index);
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
  const session = mgr.session;
  await mgr.setRttConfigs(mgr.rttConfigs.filter((entry) => entry.index !== index));
  if (session){
    terminals.close(session, index);
  }
}
