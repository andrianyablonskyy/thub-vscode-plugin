// thub.reserve (design: artboard 3): step 1, the board (Idle now / Busy);
// step 2, for how long (30m, 2h, 4h, 8h, Custom…) and "Connect right away".

import * as vscode from 'vscode';
import type { SessionManager } from '../session/SessionManager';
import { boardState, formatLeft, labelsSummary, msUntil, parseDurationMin } from '../cli/parse';
import type { Resource } from '../cli/types';
import { settings } from '../util/config';

interface BoardPick extends vscode.QuickPickItem {
  board?: Resource;
}

interface DurationPick extends vscode.QuickPickItem {
  minutes?: number;
  custom?: boolean;
}

export async function reserveFlow(mgr: SessionManager, preselected?: string): Promise<void> {
  await mgr.refresh();
  if (mgr.mine){
    const pick = await vscode.window.showInformationMessage(`You already hold ${mgr.mine.name}.`, 'Extend 1h', 'Release it');
    if (pick === 'Extend 1h'){
      await mgr.extend(60);
    }
    else if (pick === 'Release it'){
      await mgr.release();
    }
    return;
  }
  const board = preselected ? mgr.resources.find((r) => r.name === preselected) : await pickBoard(mgr);
  if (!board){
    return;
  }
  const choice = await pickDuration(board);
  if (!choice){
    return;
  }
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `thub: reserving ${board.name}` },
    () => mgr.reserve(board.name, choice.minutes, false));
  if (choice.connect){
    await mgr.connect();
  }
}

function pickBoard(mgr: SessionManager): Promise<Resource | undefined> {
  const qp = vscode.window.createQuickPick<BoardPick>(),
    boards = mgr.resources.filter((r) => r.type === 'hw'),
    idle = boards.filter((r) => boardState(r) === 'idle'),
    busy = boards.filter((r) => ['job', 'reserved'].includes(boardState(r))),
    item = (r: Resource): BoardPick => {
      const state = boardState(r),
        model = labelsSummary(r);
      return state === 'idle'
        ? { label: `$(circle-large-outline) ${r.name}`, description: model, board: r }
        : state === 'job'
          ? { label: `$(circle-filled) ${r.name}`, description: model, detail: 'Running a job · reserve to have it after that job', board: r }
          : { label: `$(lock) ${r.name}`, description: model, detail: `Reserved by ${r.reservation?.by || 'someone'} · frees in ${formatLeft(msUntil(r.reservation?.until))}` };
    };
  qp.title = 'thub: Reserve board';
  qp.placeholder = 'Filter by name or board (e.g. f401)';
  qp.step = 1;
  qp.totalSteps = 2;
  qp.matchOnDescription = true;
  qp.items = [
    { label: 'Idle now', kind: vscode.QuickPickItemKind.Separator },
    ...idle.map(item),
    ...(busy.length ? [{ label: 'Busy', kind: vscode.QuickPickItemKind.Separator }, ...busy.map(item)] : [])
  ];
  return new Promise((resolve) => {
    qp.onDidAccept(() => {
      const sel = qp.selectedItems[0];
      if (sel?.board){
        resolve(sel.board);
        qp.hide();
      }
      else if (sel){
        // Someone else's: not selectable.
        qp.title = `thub: Reserve board — ${sel.label.replace(/^\$\([^)]*\)\s*/, '')} is reserved by someone else`;
      }
    });
    qp.onDidHide(() => {
      resolve(undefined);
      qp.dispose();
    });
    qp.show();
  });
}

function pickDuration(board: Resource): Promise<{ minutes: number; connect: boolean } | undefined> {
  const qp = vscode.window.createQuickPick<DurationPick>(),
    preferred = parseDurationMin(settings.defaultDuration()) || 120;
  let connect = true;
  const toggle: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('pass-filled'), tooltip: 'Connect right away (UART, GDB, camera): on' },
    toggleOff: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('circle-large-outline'), tooltip: 'Connect right away (UART, GDB, camera): off' },
    title = () => `thub: Reserve board › ${board.name} › For how long?  ·  Connect right away: ${connect ? 'on' : 'off'}`;
  qp.title = title();
  qp.step = 2;
  qp.totalSteps = 2;
  qp.placeholder = 'Pick a duration, or type one (45m, 3h)';
  qp.buttons = [toggle];
  const presets: DurationPick[] = [30, 120, 240, 480].map((m) => ({ label: m < 60 ? `${m}m` : `${m / 60}h`, minutes: m }));
  qp.items = [...presets, { label: 'Custom…', custom: true, description: 'type it above: 45m, 3h, 90' }];
  qp.activeItems = [presets.find((p) => p.minutes === preferred) || presets[1]];
  return new Promise((resolve) => {
    qp.onDidTriggerButton(() => {
      connect = !connect;
      qp.buttons = [connect ? toggle : toggleOff];
      qp.title = title();
    });
    qp.onDidChangeValue((v) => {
      const min = parseDurationMin(v);
      qp.items = min
        ? [{ label: v.trim(), description: `${min} min`, minutes: min }, ...presets]
        : [...presets, { label: 'Custom…', custom: true, description: 'type it above: 45m, 3h, 90' }];
    });
    qp.onDidAccept(() => {
      const sel = qp.selectedItems[0] || qp.activeItems[0];
      if (sel?.minutes){
        resolve({ minutes: sel.minutes, connect });
        qp.hide();
      }
    });
    qp.onDidHide(() => {
      resolve(undefined);
      qp.dispose();
    });
    qp.show();
  });
}
