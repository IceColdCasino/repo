import { Transaction } from '@solana/web3.js';

type Config = {
  admin: string;
  games: string[];
};

type FloatQuote = {
  lamports: number;
  callerInputs: number;
  computationSlots: number;
  error?: string;
};

type ListedSeat = {
  seat: number;
  player: string | null;
  house: boolean;
  floatLamports: number;
  heldLamports: number;
};

type ListedTable = {
  tableId: string;
  address: string;
  game: string;
  shoeDecks: number;
  variant: number;
  occupied: number;
  handInProgress: boolean;
  exists: boolean;
  floatLamports: number;
  seats: ListedSeat[];
};

type ListedRoom = {
  room: string;
  roomId: string;
  game: string;
  seed: string | null;
  label: string;
  tableCount: number;
  smallBlind: string;
  floatLamports: number;
  tables: ListedTable[];
};

type Step = {
  label: string;
  tx: string;
  blockhash: string;
  lastValidBlockHeight: number;
};

type Plan = {
  room: string;
  roomId: string;
  exists: boolean;
  mint: string | null;
  chipVault: string | null;
  tableCount: number | null;
  tables: { tableId: string; address: string; gameKind: number | null }[];
  players: {
    address: string;
    whitelisted: boolean;
    rentVault: string;
    rentVaultLamports: number;
  }[];
  steps?: Step[];
  notes?: string[];
  depositLamports?: number;
  error?: string;
};

type Phantom = {
  publicKey?: { toBase58(): string };
  connect(): Promise<{ publicKey: { toBase58(): string } }>;
  signTransaction(tx: Transaction): Promise<Transaction>;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const logEl = $('log');

let config: Config | null = null;
let walletKey = '';
let selectedRoomId = '';
let whitelistRequest = 0;

function sol(lamports: number): string {
  return (lamports / 1_000_000_000).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function log(text: string, bad = false): void {
  logEl.textContent = text;
  logEl.classList.toggle('bad', bad);
}

function signerMode(): 'local' | 'wallet' {
  const picked = document.querySelector<HTMLInputElement>('input[name="signer"]:checked');
  return picked?.value === 'wallet' ? 'wallet' : 'local';
}

function players(): string[] {
  return $('players').value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

function bodyFor(mode: 'create' | 'list' | 'all' | 'lookup' | 'open'): Record<string, unknown> {
  const game = $('game').value;
  return {
    cluster: $('cluster').value,
    game,
    seed: $('seed').value,
    smallBlind: Number($('blind').value),
    openTable: mode === 'open' || (mode !== 'lookup' && mode !== 'list' && $('open-table').checked),
    createRoom: mode === 'create' || mode === 'all',
    whitelist: mode === 'list' || mode === 'all',
    fund: mode === 'list' || mode === 'all',
    shoeDecks: Number($('shoe').value),
    rouletteVariant: Number($('variant').value),
    players: players(),
    roomId: $('room-id').value,
    floatLamports: $('float').dataset.lamports ? Number($('float').dataset.lamports) : undefined,
    floatSol: $('float').dataset.lamports ? undefined : $('float').value,
  };
}

function describe(view: Plan): string {
  const lines = [
    `Room ${view.room}`,
    `Room id ${view.roomId}`,
    view.exists
      ? `On chain. Tables: ${view.tableCount ?? 0}. Chip mint ${view.mint}. Chip vault ${view.chipVault}.`
      : 'Room account is not on this cluster yet.',
  ];
  for (const table of view.tables ?? []) {
    lines.push(`Table ${table.tableId} ${table.address}`);
  }
  for (const player of view.players ?? []) {
    const listed = player.whitelisted ? 'whitelisted' : 'not whitelisted';
    lines.push(`${player.address} ${listed}`);
  }
  for (const note of view.notes ?? []) lines.push(note);
  if (view.steps) {
    lines.push(`${view.steps.length} transaction${view.steps.length === 1 ? '' : 's'}.`);
    for (const step of view.steps) lines.push(`• ${step.label}`);
    if (view.depositLamports) lines.push(`Float deposits total ${sol(view.depositLamports)} SOL, plus account rent.`);
  }
  return lines.join('\n');
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : 'Request failed.');
  return payload;
}

function phantom(): Phantom | null {
  const scope = window as unknown as { phantom?: { solana?: Phantom }; solana?: Phantom };
  return scope.phantom?.solana ?? scope.solana ?? null;
}

function bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function b64(data: Uint8Array): string {
  let text = '';
  for (const byte of data) text += String.fromCharCode(byte);
  return btoa(text);
}

async function refreshStatus(): Promise<void> {
  const cluster = $('cluster').value;
  const status = $('status');
  try {
    const response = await fetch(`/api/status?cluster=${cluster}`);
    const payload = await response.json() as {
      ok?: boolean;
      balanceSol?: number;
      slot?: number;
      admin?: string;
      error?: string;
    };
    if (!response.ok || !payload.ok) throw new Error(payload.error ?? 'Cluster unreachable.');
    status.textContent = `${cluster} slot ${payload.slot}. Admin ${payload.admin} has ${payload.balanceSol?.toFixed(4)} SOL.`;
  } catch (err) {
    status.textContent = err instanceof Error ? err.message : String(err);
  }
}

function showVariant(): void {
  const game = $('game').value;
  const shoe = $('shoe-label');
  const variant = $('variant-label');
  const select = $('variant');
  shoe.hidden = !(game === 'baccarat' || game === 'blackjack' || game === 'war');
  const options: Record<string, [string, string][]> = {
    roulette: [['37', 'European 37'], ['38', 'American 38']],
    slots: [['3', '3 reels'], ['5', '5 reels']],
    bingo: [['75', '75 ball'], ['90', '90 ball']],
  };
  const rows = options[game];
  variant.hidden = !rows;
  if (!rows) return;
  select.replaceChildren(...rows.map(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }));
}

async function lookup(): Promise<void> {
  const body = bodyFor('lookup');
  const params = new URLSearchParams({
    cluster: String(body.cluster),
    game: String(body.game),
    seed: String(body.seed),
    players: players().join(','),
    roomId: $('room-id').value,
    shoe: $('shoe').value,
    variant: $('variant').value || '0',
  });
  const response = await fetch(`/api/room?${params}`);
  const payload = await response.json() as Plan;
  if (!response.ok) throw new Error(payload.error ?? 'Lookup failed.');
  log(describe(payload));
}

function requireWallet(): void {
  if (signerMode() !== 'wallet') return;
  const provider = phantom();
  if (!provider?.publicKey) throw new Error('Connect the admin wallet first.');
  if (config && provider.publicKey.toBase58() !== config.admin) {
    throw new Error(`Connect the admin key ${config.admin}.`);
  }
}

async function submit(planned: Plan, message: string): Promise<void> {
  const steps = planned.steps ?? [];
  log(describe(planned));
  if (steps.length === 0) return;
  if (!window.confirm(message)) {
    log(`${describe(planned)}\nWaiting for a signature.`);
    return;
  }
  if (signerMode() === 'local') {
    const sent = await post('/api/run', { cluster: $('cluster').value, steps });
    const signatures = sent.signatures as { label: string; signature: string }[];
    const lines = signatures.map((row) => `${row.label}\n${row.signature}`);
    log(`${lines.join('\n')}\n\nConfirming the room…`);
    await lookup();
    const confirmed = logEl.textContent ?? '';
    log(`${lines.join('\n')}\n\n${confirmed}`);
    await remember(planned);
    await refreshRooms();
    return;
  }
  const provider = phantom();
  if (!provider) throw new Error('Wallet not found.');
  const signatures: string[] = [];
  for (const step of steps) {
    const tx = Transaction.from(bytes(step.tx));
    const signed = await provider.signTransaction(tx);
    const payload = await post('/api/send', {
      cluster: $('cluster').value,
      tx: b64(signed.serialize()),
      blockhash: step.blockhash,
      lastValidBlockHeight: step.lastValidBlockHeight,
    });
    signatures.push(`${step.label}\n${String(payload.signature)}`);
    log(signatures.join('\n\n'));
  }
  await lookup();
  log(`${signatures.join('\n\n')}\n\n${logEl.textContent ?? ''}`);
  await remember(planned);
  await refreshRooms();
}

async function run(mode: 'create' | 'list' | 'all' | 'open'): Promise<void> {
  requireWallet();
  if (mode === 'open' && !$('room-id').value) {
    throw new Error('Pick a room, then open a table in it.');
  }
  const planned = await post('/api/plan', bodyFor(mode)) as unknown as Plan;
  const steps = planned.steps ?? [];
  const status = await fetch(`/api/status?cluster=${$('cluster').value}`);
  const balance = await status.json() as { balanceLamports?: number };
  const have = balance.balanceLamports ?? 0;
  const deposit = planned.depositLamports ?? 0;
  const left = have - deposit;
  const spend = deposit > 0 ? `${sol(deposit)} SOL of float` : 'account rent';
  const caution = left < 1_000_000_000 ? ' The admin key would be left under 1 SOL before rent.' : '';
  const verb = mode === 'open' ? `Open a ${$('game').value} table` : `Sign ${steps.length} transaction${steps.length === 1 ? '' : 's'}`;
  await submit(
    planned,
    `${verb} with the admin key? Balance is ${sol(have)} SOL. This spends ${spend}.${caution}`,
  );
}

async function closeTable(table: ListedTable): Promise<void> {
  requireWallet();
  if (!table.exists) return;
  if (table.handInProgress) throw new Error('This table has a hand in progress.');
  if (table.occupied > 0) throw new Error('Stand everyone up before closing this table.');
  const planned = await post('/api/plan', {
    ...bodyFor('open'),
    openTable: false,
    closeTableId: Number(table.tableId),
  }) as unknown as Plan;
  await submit(planned, `Close table ${table.tableId} and return its rent to the admin key?`);
}

function bind(): void {
  $('cluster').addEventListener('change', () => {
    $('room-id').value = '';
    selectedRoomId = '';
    showTables(null);
    void refreshStatus();
    void refreshRooms();
    void refreshFloat();
  });
  $('game').addEventListener('change', () => {
    showVariant();
    void refreshFloat();
  });
  $('shoe').addEventListener('change', () => { void refreshFloat(); });
  $('variant').addEventListener('change', () => { void refreshFloat(); });
  $('seed').addEventListener('input', () => {
    $('room-id').value = '';
    selectedRoomId = '';
    showTables(null);
    document.querySelectorAll('button.room').forEach((button) => button.classList.remove('selected'));
  });
  ($('float') as HTMLInputElement).addEventListener('input', () => {
    delete $('float').dataset.lamports;
  });
  $('new-seed').addEventListener('click', () => {
    const random = crypto.getRandomValues(new Uint8Array(4));
    $('seed').value = `room-${Array.from(random, (b) => b.toString(16).padStart(2, '0')).join('')}`;
    $('room-id').value = '';
    selectedRoomId = '';
    showTables(null);
    document.querySelectorAll('button.room').forEach((button) => button.classList.remove('selected'));
  });
  $('refresh-rooms').addEventListener('click', () => void act(refreshRooms));
  $('open-table-btn').addEventListener('click', () => void act(() => run('open')));
  document.querySelectorAll<HTMLInputElement>('input[name="signer"]').forEach((input) => {
    input.addEventListener('change', () => {
      $('connect').hidden = signerMode() !== 'wallet';
    });
  });
  $('connect').addEventListener('click', async () => {
    const provider = phantom();
    if (!provider) {
      log('No wallet found in this browser. Use the local admin key, or open the page in a browser with that wallet.', true);
      return;
    }
    const connected = await provider.connect();
    walletKey = connected.publicKey.toBase58();
    $('wallet').textContent = walletKey;
    if (config && walletKey !== config.admin) {
      log(`This wallet is ${walletKey}. Room setup signs with ${config.admin}.`, true);
    }
  });
  $('lookup').addEventListener('click', () => void act(lookup));
  for (const id of ['create', 'list', 'all'] as const) {
    $(id).addEventListener('click', () => {
      const mode = $(id).dataset.mode as 'create' | 'list' | 'all';
      void act(() => run(mode));
    });
  }
}

async function act(fn: () => Promise<void>): Promise<void> {
  const buttons = document.querySelectorAll('button');
  buttons.forEach((button) => { button.disabled = true; });
  try {
    await fn();
    await refreshStatus();
  } catch (err) {
    log(err instanceof Error ? err.message : String(err), true);
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

const response = await fetch('/api/config');
config = await response.json() as Config;
$('game').replaceChildren(...config.games.map((game) => {
  const option = document.createElement('option');
  option.value = game;
  option.textContent = game;
  return option;
}));
showVariant();
bind();
try {
  await refreshStatus();
  await refreshFloat();
  await refreshRooms();
} catch (err) {
  log(err instanceof Error ? err.message : String(err), true);
}

function knownGame(game: string): boolean {
  return config?.games.includes(game) ?? false;
}

async function refreshFloat(): Promise<void> {
  const params = new URLSearchParams({
    cluster: $('cluster').value,
    game: $('game').value,
    shoe: $('shoe').value,
    variant: $('variant').value || '0',
  });
  const response = await fetch(`/api/float?${params}`);
  const quote = await response.json() as FloatQuote;
  if (!response.ok) throw new Error(quote.error ?? 'Could not price this game.');
  const input = $('float') as HTMLInputElement;
  input.value = (quote.lamports / 1_000_000_000).toFixed(6);
  input.dataset.lamports = String(quote.lamports);
  $('float-hint').textContent = `${$('game').value} seat float is ${input.value} SOL: ${quote.callerInputs} shuffle inputs and ${quote.computationSlots} in-flight computations, plus that seat's accounts.`;
}

async function refreshRooms(): Promise<void> {
  const host = $('rooms');
  host.textContent = 'Loading rooms…';
  const response = await fetch(`/api/rooms?cluster=${$('cluster').value}`);
  const payload = await response.json() as { rooms?: ListedRoom[]; error?: string };
  if (!response.ok) throw new Error(payload.error ?? 'Could not list rooms.');
  const rooms = payload.rooms ?? [];
  host.replaceChildren();
  if (rooms.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'No room accounts on this cluster.';
    host.append(empty);
    showTables(null);
    return;
  }
  for (const room of rooms) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'room';
    button.dataset.roomId = room.roomId;
    if (room.roomId === selectedRoomId) button.classList.add('selected');
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = room.seed ? `${room.label} · ${room.seed}` : room.label;
    const meta = document.createElement('span');
    meta.className = 'meta';
    const tables = room.tables.length === 0
      ? 'No tables yet'
      : room.tables.map((table) => tableLine(table)).join(' · ');
    meta.textContent = `${room.room} · blind ${room.smallBlind} · seat float ${sol(room.floatLamports)} SOL · ${tables}`;
    button.append(title, meta);
    button.addEventListener('click', () => selectRoom(room));
    host.append(button);
  }
  const selected = rooms.find((room) => room.roomId === selectedRoomId);
  showTables(selected ?? null);
}

function showTables(room: ListedRoom | null): void {
  const panel = $('tables-panel');
  const host = $('tables');
  if (!room) {
    panel.hidden = true;
    host.replaceChildren();
    hideWhitelist();
    return;
  }
  void refreshWhitelist(room.roomId);
  panel.hidden = false;
  $('tables-hint').textContent = 'Open uses the game, shoe, and variant below. Close returns that table’s rent to the admin key. A table with players seated stays open.';
  host.replaceChildren();
  if (room.tables.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'This room has no tables yet.';
    host.append(empty);
    return;
  }
  for (const table of room.tables) {
    const block = document.createElement('div');
    block.className = 'table-block';
    const row = document.createElement('div');
    row.className = 'table-row';
    const label = document.createElement('span');
    const seated = table.occupied === 1 ? '1 seated' : `${table.occupied} seated`;
    label.textContent = table.exists
      ? `Table ${table.tableId} · ${tableKind(table)}, ${seated}`
      : `Table ${table.tableId} · closed`;
    row.append(label);
    if (table.exists) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Close';
      if (table.handInProgress) button.title = 'A hand is in progress.';
      if (table.occupied > 0) button.title = 'Players are still seated.';
      button.disabled = table.occupied > 0 || table.handInProgress;
      button.addEventListener('click', () => void act(() => closeTable(table)));
      row.append(button);
    }
    block.append(row);
    if (table.exists) {
      const seats = document.createElement('div');
      seats.className = 'seat-list';
      for (const seat of table.seats ?? []) {
        const line = document.createElement('p');
        line.className = 'seat-row';
        const who = seat.player ?? 'empty';
        const house = seat.house ? ' · house' : '';
        const holding = seat.player
          ? (seat.heldLamports > 0 ? ` · holding ${sol(seat.heldLamports)} SOL` : ' · unfunded')
          : '';
        line.textContent = `Seat ${seat.seat}${house} · ${who} · float ${sol(seat.floatLamports)} SOL${holding}`;
        seats.append(line);
      }
      block.append(seats);
    }
    host.append(block);
  }
}

type ListedPlayer = {
  address: string;
};

function hideWhitelist(): void {
  whitelistRequest += 1;
  $('whitelist-panel').hidden = true;
  $('whitelist').replaceChildren();
}

async function refreshWhitelist(roomId: string): Promise<void> {
  const request = ++whitelistRequest;
  const panel = $('whitelist-panel');
  const host = $('whitelist');
  panel.hidden = false;
  host.textContent = 'Loading whitelist…';
  let payload: { players?: ListedPlayer[]; error?: string };
  try {
    const response = await fetch(`/api/whitelist?cluster=${$('cluster').value}&roomId=${roomId}`);
    payload = await response.json() as { players?: ListedPlayer[]; error?: string };
    if (request !== whitelistRequest || selectedRoomId !== roomId) return;
    if (!response.ok) throw new Error(payload.error ?? 'Could not list the whitelist.');
  } catch (err) {
    if (request !== whitelistRequest || selectedRoomId !== roomId) return;
    host.textContent = err instanceof Error ? err.message : 'Could not list the whitelist.';
    return;
  }
  const players = payload.players ?? [];
  $('whitelist-hint').textContent = players.length === 1
    ? '1 address can sit. Float stays on the seat.'
    : `${players.length} addresses can sit. Float stays on the seat.`;
  host.replaceChildren();
  if (players.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'No players are whitelisted in this room.';
    host.append(empty);
    return;
  }
  for (const player of players) {
    const row = document.createElement('div');
    row.className = 'table-row';
    const label = document.createElement('span');
    label.textContent = player.address;
    row.append(label);
    host.append(row);
  }
}

function tableKind(table: ListedTable): string {
  const shoe = table.shoeDecks > 0 ? `${table.shoeDecks} deck` : '';
  const variant = table.variant > 0 ? String(table.variant) : '';
  return [table.game, shoe, variant].filter(Boolean).join(' ');
}

function tableLine(table: ListedTable): string {
  const seated = table.occupied === 1 ? '1 seated' : `${table.occupied} seated`;
  return `table ${table.tableId} ${tableKind(table)}, ${seated}, seat float ${sol(table.floatLamports)} SOL`;
}

function selectRoom(room: ListedRoom): void {
  const table = room.tables.reduce<ListedTable | undefined>((best, row) => {
    if (!best || row.floatLamports > best.floatLamports) return row;
    return best;
  }, undefined);
  const game = table && knownGame(table.game) ? table.game : (knownGame(room.game) ? room.game : $('game').value);
  $('game').value = game;
  showVariant();
  if (table && (game === 'baccarat' || game === 'blackjack' || game === 'war') && [1, 6, 8].includes(table.shoeDecks)) {
    $('shoe').value = String(table.shoeDecks);
  }
  if (table) {
    const value = String(table.variant);
    if ([...$('variant').options].some((option) => option.value === value)) $('variant').value = value;
  }
  $('blind').value = room.smallBlind;
  $('room-id').value = room.roomId;
  selectedRoomId = room.roomId;
  showTables(room);
  $('seed').value = room.seed ?? '';
  document.querySelectorAll('button.room').forEach((button) => {
    button.classList.toggle('selected', button.dataset.roomId === room.roomId);
  });
  log([room.label, room.room, ...room.tables.map(tableLine)].join('\n'));
  void refreshFloat();
}

async function remember(planned: Plan): Promise<void> {
  const seed = $('seed').value.trim();
  if (!seed || !planned.roomId) return;
  await post('/api/rooms/remember', { game: $('game').value, seed, roomId: planned.roomId });
}
