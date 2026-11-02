import * as vscode from 'vscode';
import type { ForwardConfig } from '../cli/types';
import type { SessionManager } from '../session/SessionManager';

const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

async function promptForward(existing?: ForwardConfig): Promise<ForwardConfig | undefined> {
  const name = await vscode.window.showInputBox({
    title: existing ? `Update forwarded service · ${existing.name}` : 'Add forwarded service',
    prompt: 'Service name (for example, Web UI)',
    value: existing?.name || '',
    validateInput: (value) => SERVICE_NAME.test(value.trim())
      ? undefined
      : 'Use 1–64 letters, numbers, spaces, dots, underscores or hyphens'
  });
  if (name === undefined){
    return undefined;
  }
  const port = await vscode.window.showInputBox({
    title: existing ? `Update forwarded service · ${name.trim()}` : `Add forwarded service · ${name.trim()}`,
    prompt: 'Port on the reserved Client host (localhost)',
    value: existing ? String(existing.clientPort) : '',
    validateInput: (value) => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535
      ? undefined : 'Enter a port between 1 and 65535'
  });
  if (port === undefined){
    return undefined;
  }
  return { name: name.trim(), clientPort: Number(port) };
}

export async function addForward(mgr: SessionManager): Promise<void> {
  const service = await promptForward();
  if (service){
    await mgr.setForwardServices([...mgr.forwardServices, service]);
  }
}

export async function editForward(mgr: SessionManager, name: string): Promise<void> {
  const services = mgr.forwardServices,
    current = services.find((service) => service.name === name);
  if (!current){
    throw new Error(`Forwarded service "${name}" was not found`);
  }
  const updated = await promptForward(current);
  if (updated){
    await mgr.setForwardServices(services.map((service) => service === current ? updated : service));
  }
}

export async function removeForward(mgr: SessionManager, name: string): Promise<void> {
  const services = mgr.forwardServices;
  if (!services.some((service) => service.name === name)){
    throw new Error(`Forwarded service "${name}" was not found`);
  }
  const answer = await vscode.window.showWarningMessage(
    `Remove the forwarded service "${name}"?`,
    { modal: true },
    'Remove'
  );
  if (answer === 'Remove'){
    await mgr.setForwardServices(services.filter((service) => service.name !== name));
  }
}
