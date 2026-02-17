export type AllDayMode = "ignore" | "mirror";
export type OverlapPolicy = "skip" | "allow";

export type GogEventTime = {
  dateTime?: string;
  date?: string;
  timeZone?: string;
};

export type GogEvent = {
  id: string;
  etag?: string;
  updated?: string;
  summary?: string;
  description?: string;
  status?: string;
  visibility?: string;
  transparency?: string;
  start: GogEventTime;
  end: GogEventTime;
  reminders?: {
    useDefault?: boolean;
    overrides?: Array<{ method: string; minutes: number }>;
  };
};

export type SourceRef = {
  srcAccount: string;
  srcCalendar: string;
  eventId: string;
  start: string;
  end: string;
  title: string;
};

export type HoldDefaults = {
  summary: string;
  visibility: "private";
  transparency: "busy";
};

export type DesiredHold = {
  source: SourceRef;
  event: GogEvent;
};

export type ReconcileAction =
  | { type: "create"; desired: DesiredHold }
  | { type: "update"; existing: GogEvent; desired: DesiredHold }
  | { type: "delete"; existing: GogEvent }
  | { type: "skip_overlap"; desired: DesiredHold; blockingEventId: string };

export type ReconcilePlan = {
  actions: ReconcileAction[];
  desiredCount: number;
  existingManagedCount: number;
  capped: boolean;
};
