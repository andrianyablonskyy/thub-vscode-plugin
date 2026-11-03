import * as vscode from 'vscode';
import type { ForwardConfig } from '../cli/types';
import type { SessionManager } from '../session/SessionManager';
import { parseForwardInput } from './forwardInput';

async function promptForward(existing?: ForwardConfig): Promise<ForwardConfig | undefined> {
  const value = await vscode.window.showInputBox({
    title: existing ? `Update forwarded service · ${existing.name}` : 'Add forwarded service',
    prompt: 'Service name and port on the reserved Client host',
    placeHolder: 'Web UI:3000',
    value: existing ? `${existing.name}:${existing.clientPort}` : '',
    validateInput: (input) => {
      try {
        parseForwardInput(input);
        return undefined;
      }
      catch (err){
        return err instanceof Error ? err.message : String(err);
      }
    }
  });
  if (value === undefined){
    return undefined;
  }
  return parseForwardInput(value);
}

export async function addForward(mgr: SessionManager, client?: string): Promise<void> {
  const service = await promptForward();
  if (service){
    await mgr.setForwardServices([...mgr.getForwardServices(client), service], client);
  }
}

export async function editForward(mgr: SessionManager, name: string, client?: string): Promise<void> {
  const services = mgr.getForwardServices(client),
    current = services.find((service) => service.name === name);
  if (!current){
    throw new Error(`Forwarded service "${name}" was not found`);
  }
  const updated = await promptForward(current);
  if (updated){
    await mgr.setForwardServices(services.map((service) => service === current ? updated : service), client);
  }
}

export async function removeForward(mgr: SessionManager, name: string, client?: string): Promise<void> {
  const services = mgr.getForwardServices(client);
  if (!services.some((service) => service.name === name)){
    throw new Error(`Forwarded service "${name}" was not found`);
  }
  const answer = await vscode.window.showWarningMessage(
    `Remove the forwarded service "${name}"?`,
    { modal: true },
    'Remove'
  );
  if (answer === 'Remove'){
    await mgr.setForwardServices(services.filter((service) => service.name !== name), client);
  }
}
