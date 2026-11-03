// thub.reserve (design: artboard 3): step 1, the board (Idle now / Busy);
// step 2, for how long (30m, 2h, 4h, 8h, Custom…) and "Connect right away".

import * as vscode from 'vscode';
import type { SessionManager } from '../session/SessionManager';
import { resourceSlot, resourceToReplace } from '../session/resourceSlots';
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
  let board: Resource | undefined;
  if (preselected){
    const target = mgr.resources.find((r) => r.name === preselected);
    if (!target){
      throw new Error(`Board ${preselected} is no longer available`);
    }
    if (mgr.mines.some((r) => r.name === target.name)){
      board = await pickBoard(mgr);
      if (!board){
        return;
      }
    }
    else {
      board = target;
    }
  }
  else {
    board = await pickBoard(mgr);
    if (!board){
      return;
    }
  }

  const initialBoard = board;
  if (!initialBoard){
    return;
  }
  const sameType = resourceToReplace(mgr.mines, initialBoard);
  if (sameType){
    const kind = resourceSlot(initialBoard),
      action = `Switch ${kind} resource`,
      pick = await vscode.window.showWarningMessage(
        `You already hold ${sameType.name} (${kind}). Release it and reserve ${initialBoard.name}? Your ${initialBoard.type === 'hw' ? 'SIL' : 'HIL'} reservation will remain.`,
        { modal: true },
        action
      );
    if (pick !== action){
      return;
    }
  }
  const choice = await pickDuration(initialBoard);
  if (!choice){
    return;
  }
  await mgr.refresh();
  const refreshedBoard = mgr.resources.find((r) => r.name === initialBoard.name);
  if (!refreshedBoard || (!mgr.mines.some((r) => r.name === refreshedBoard.name) && !['idle', 'job'].includes(boardState(refreshedBoard)))){
    throw new Error(`Board ${initialBoard.name} is no longer available`);
  }
  let selectedBoard = refreshedBoard;
  if (sameType){
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `thub: releasing ${sameType.name}` },
      () => mgr.release(sameType.name)
    );
    await mgr.refresh();
    const refreshed = mgr.resources.find((r) => r.name === selectedBoard.name);
    if (!refreshed || (!mgr.mines.some((r) => r.name === refreshed.name) && !['idle', 'job'].includes(boardState(refreshed)))){
      throw new Error(`Board ${selectedBoard.name} is no longer available`);
    }
    selectedBoard = refreshed;
  }
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `thub: reserving ${selectedBoard.name}` },
    () => mgr.reserve(selectedBoard.name, choice.minutes, false));
  if (choice.connect){
    await mgr.connect(selectedBoard.name);
  }
}

function pickBoard(mgr: SessionManager): Promise<Resource | undefined> {
  const qp = vscode.window.createQuickPick<BoardPick>(),
    boards = mgr.resources.filter((r) => r.type === 'hw' || r.type === 'sw'),
    idle = boards.filter((r) => boardState(r) === 'idle'),
    busy = boards.filter((r) => ['job', 'reserved'].includes(boardState(r))),
    item = (r: Resource): BoardPick => {
      const state = boardState(r),
          model = labelsSummary(r),
          kind = r.type === 'hw' ? 'HIL' : 'SIL';
        return state === 'idle'
          ? { label: `$(circle-large-outline) ${r.name}`, description: `${kind}${model ? ` · ${model}` : ''}`, board: r }
          : state === 'job'
            ? { label: `$(circle-filled) ${r.name}`, description: `${kind}${model ? ` · ${model}` : ''}`, detail: 'Running a job · reserve to have it after that job', board: r }
            : { label: `$(lock) ${r.name}`, description: `${kind}${model ? ` · ${model}` : ''}`, detail: `Reserved by ${r.reservation?.by || 'someone'} · frees in ${formatLeft(msUntil(r.reservation?.until))}` };
    };
    qp.title = mgr.mines.length ? 'thub: Switch or add a resource lock' : 'thub: Reserve resource';
  qp.placeholder = 'Filter by name or board (e.g. f401)';
  qp.step = 1;
  qp.totalSteps = 2;
  qp.matchOnDescription = true;
  qp.items = [
    { label: 'HIL', kind: vscode.QuickPickItemKind.Separator },
    ...idle.filter((r) => r.type === 'hw').map(item),
    ...busy.filter((r) => r.type === 'hw').map(item),
    { label: 'SIL', kind: vscode.QuickPickItemKind.Separator },
    ...idle.filter((r) => r.type === 'sw').map(item),
    ...busy.filter((r) => r.type === 'sw').map(item)
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
