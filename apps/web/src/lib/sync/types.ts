// The shapes the web app's sync uses between the page and the brain worker
// (see ../brain/sync-controller.ts). Plain, structured-clone-safe data.
//
// The access token never appears in any of these except as the argument of
// the calls that take one (`listBrains`, `plan`, `connect`, `setToken`); what
// comes back only ever carries `tokenHint`, its last four characters.

/** The small status the header shows. */
export type SyncIndicator =
  /** Not connected to a server: sync is simply off. */
  | 'off'
  | 'synced'
  | 'syncing'
  /** Notes or change records are waiting to be sent. */
  | 'waiting'
  | 'offline'
  /** Conflicts to resolve, or a problem automatic sync can't get past (the token). */
  | 'attention';

export type SyncProblemKind =
  /** The server refused the token. Automatic sync stops until it is fixed. */
  | 'auth'
  /** The device is offline, or the server can't be reached. */
  | 'offline'
  /** The server answered with an error; retried with backoff. */
  | 'server'
  /** The server has no sync right now (no database, misconfigured). Retried. */
  | 'unavailable'
  /** The brain is gone from the server. Automatic sync stops. */
  | 'gone'
  /** The server's copy is older than this device's (restored or recreated). Automatic sync stops. */
  | 'reset'
  | 'other';

export interface SyncProblem {
  readonly kind: SyncProblemKind;
  /** In plain language; never names the token. */
  readonly message: string;
  /** Unix seconds. */
  readonly at: number;
}

/** How far a running sync has got. */
export interface SyncProgress {
  /** Notes sent so far in this run, and how many were waiting when it started. */
  readonly sent: number;
  readonly toSend: number;
  /** Server changes received so far, and how many there are (null until known). */
  readonly received: number;
  readonly toReceive: number | null;
}

export interface SyncRunSummary {
  /** Unix seconds. */
  readonly at: number;
  readonly rounds: number;
  readonly received: { readonly notes: number; readonly events: number; readonly changes: number };
  readonly pushed: { readonly edits: number; readonly events: number; readonly changes: number };
  /** Edits the server refused this run (each kept as a conflict copy). */
  readonly conflicts: number;
}

/** Where this device stands with the server. */
export interface SyncView {
  readonly connected: boolean;
  readonly brainId: string | null;
  /** The token's last four characters, for a masked display. Null when not connected. */
  readonly tokenHint: string | null;
  /** The brain this device last synced with (kept after Disconnect), or null. */
  readonly previousBrainId: string | null;
  readonly indicator: SyncIndicator;
  readonly running: boolean;
  /** False while automatic sync is stopped (a token problem, a brain that is gone). */
  readonly autoSync: boolean;
  readonly offline: boolean;
  /** Failed attempts in a row. */
  readonly failures: number;
  /** Unix seconds; null if never. */
  readonly lastSyncAt: number | null;
  readonly lastAttemptAt: number | null;
  /** When the next automatic attempt is due, Unix milliseconds; null when none is planned. */
  readonly nextAttemptAt: number | null;
  readonly problem: SyncProblem | null;
  /** What the next sync would push (`Engine.syncStatus().pending`). */
  readonly pending: { readonly notes: number; readonly events: number; readonly changes: number };
  readonly progress: SyncProgress | null;
  /** Conflict copies (`*.conflict-<client>-<date>.md`) on this device. */
  readonly conflicts: number;
  readonly lastRun: SyncRunSummary | null;
}

/** Whether the origin the app came from offers sync (`GET /api/health`). */
export type ServerAvailability =
  | { readonly available: true; readonly version: string | null }
  | {
      readonly available: false;
      /** static: no server behind the app; no-database: the server has no API; unavailable: it is down or misconfigured; unreachable: no answer. */
      readonly reason: 'static' | 'no-database' | 'unavailable' | 'unreachable';
      readonly message: string;
    };

/** A brain on the server, as `GET /api/brains` lists it. */
export interface RemoteBrain {
  readonly id: string;
  /** Unix seconds. */
  readonly createdAt: number;
  /** The brain's mutation counter: 0 means it has nothing in it yet. */
  readonly mutation: number;
}

export interface ConnectRequest {
  readonly token: string;
  readonly brainId: string;
  /** Create the brain on the server (with this device's folder roles). */
  readonly create?: boolean;
}

export type ConnectKind =
  /** New brain on the server; this device's notes are uploaded. */
  | 'create-upload'
  /** New, empty brain; this device has no notes either. */
  | 'create-empty'
  /** The server's brain is empty; this device's notes are uploaded. */
  | 'upload'
  /** This device is empty; the server's notes are downloaded. */
  | 'download'
  /** Both have notes: they are combined. */
  | 'merge'
  /** Both are empty. */
  | 'empty'
  /** The brain this device already synced with: carry on where it left off. */
  | 'resume';

/** What connecting would do, worked out before anything changes. */
export interface ConnectPlan {
  readonly kind: ConnectKind;
  readonly brainId: string;
  readonly create: boolean;
  readonly localNotes: number;
  /** The server brain's mutation counter (0 for a new or empty one). */
  readonly serverMutation: number;
  /** The folder roles differ: the server's replace this device's (and the notes are re-indexed). */
  readonly rolesDiffer: boolean;
  /** Other settings (half-lives, weights, …) differ: the server's are taken too. */
  readonly settingsDiffer: boolean;
  /** This device synced with another brain before; its sync record is cleared first. */
  readonly differentBrain: boolean;
  readonly previousBrainId: string | null;
  /** The person must agree before `connect` goes ahead. */
  readonly needsConfirmation: boolean;
}

/** A conflict copy beside the note it conflicts with. */
export interface SyncConflictView {
  /** The conflict copy's path. */
  readonly path: string;
  /** The note it is a version of; the server's version is (or was) there. */
  readonly original: string;
  /** The client id in the name (the device that kept it), and the date. */
  readonly client: string;
  readonly date: string;
  /** This device's text (the conflict copy). */
  readonly mine: string;
  /** The server's text, now at `original`; null when the note is gone. */
  readonly theirs: string | null;
}

export type ConflictChoice = 'mine' | 'theirs' | 'both';

/** Whether a note's current version is on the server. */
export type NoteSyncState = 'off' | 'synced' | 'waiting';
