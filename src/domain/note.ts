export const NOTE_TYPES = ["decision", "bugfix", "discovery", "convention", "config", "other", "session"] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

/** A project note kept for later agent sessions. */
export interface Note {
  id: number;
  project: string;
  type: NoteType;
  title: string;
  content: string;
  topic?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewNote {
  project: string;
  type: NoteType;
  title: string;
  content: string;
  topic?: string;
}
