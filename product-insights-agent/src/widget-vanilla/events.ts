export type WidgetEventType =
  | "seed_questions_loaded"
  | "question_submitted"
  | "answer_started"
  | "answer_completed"
  | "answer_error"
  | "disclaimer_opened";

export interface WidgetEventBase {
  sessionId: string;
  clientId?: string;
  productId: string;
  type: WidgetEventType;
  ts: number;
}

export type WidgetEvent =
  | (WidgetEventBase & {
      type: "seed_questions_loaded";
      payload: {
        count: number;
        source: "cache" | "fallback" | "fresh" | "unknown";
      };
    })
  | (WidgetEventBase & {
      type: "question_submitted";
      payload: {
        source: "seed" | "followup" | "free_text";
        questionId?: string;
      };
    })
  | (WidgetEventBase & {
      type: "answer_started";
      payload: Record<string, never>;
    })
  | (WidgetEventBase & {
      type: "answer_completed";
      payload: { durationMs: number; escalation: boolean };
    })
  | (WidgetEventBase & {
      type: "answer_error";
      payload: { message: string };
    })
  | (WidgetEventBase & {
      type: "disclaimer_opened";
      payload: Record<string, never>;
    });
