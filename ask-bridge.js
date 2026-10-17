import { randomUUID } from "node:crypto";

/**
 * Re-registers the agent's `ask` tool so clarifying questions can be answered
 * from the toilet-pi browser UI as well as the local TUI.
 *
 * Interactive sessions show the native rich dialog AND publish the question to
 * the server; whichever side answers first wins and the other is dismissed.
 * Background (rpc) sessions have no UI, so the browser is the only answer path
 * (and without this override the builtin `ask` tool would not exist at all).
 *
 * Results are formatted exactly like the builtin tool so the model sees the
 * same text either way.
 */
export function createAskBridge({ emit, log, localDialog = true }) {
  /** @type {{ questionId: string, questions: any[], createdAt: number, resolve: (answers: any[]) => void } | null} */
  let pending = null;

  function pendingQuestion() {
    return pending ? { questionId: pending.questionId, questions: pending.questions, createdAt: pending.createdAt } : null;
  }

  function publish() {
    emit({ type: "question", question: pendingQuestion() });
  }

  function clear() {
    pending = null;
    publish();
  }

  /** Handles a browser answer; false when it targets a stale question. */
  function answer(message) {
    if (!pending || message.questionId !== pending.questionId) return false;
    const byId = new Map(message.answers.map((a) => [a.id, a]));
    const results = pending.questions.map((q) => {
      const a = byId.get(q.id);
      return {
        id: q.id,
        question: q.question,
        options: q.options.map((o) => o.label),
        multi: q.multi ?? false,
        selectedOptions: Array.isArray(a?.selectedOptions) ? a.selectedOptions : [],
        ...(typeof a?.customInput === "string" ? { customInput: a.customInput } : {}),
      };
    });
    const resolve = pending.resolve;
    pending = null;
    publish();
    resolve(results);
    return true;
  }

  function toDialogQuestions(questions) {
    return questions.map((q) => ({
      id: q.id,
      question: q.question,
      ...(q.header?.trim() ? { header: q.header } : {}),
      options: q.options.map((o) => ({
        label: o.label,
        ...(o.description?.trim() ? { description: o.description.trim() } : {}),
        ...(o.preview?.trim() ? { preview: o.preview } : {}),
      })),
      ...(q.multi !== undefined ? { multi: q.multi } : {}),
      ...(q.recommended !== undefined ? { recommended: q.recommended } : {}),
    }));
  }

  function toWireQuestions(questions) {
    return questions.map((q) => ({
      id: q.id,
      question: q.question,
      ...(q.header?.trim() ? { header: q.header } : {}),
      options: q.options.map((o) => ({ label: o.label, ...(o.description?.trim() ? { description: o.description.trim() } : {}) })),
      ...(q.multi !== undefined ? { multi: q.multi } : {}),
      ...(q.recommended !== undefined ? { recommended: q.recommended } : {}),
    }));
  }

  // Shows the native dialog when a UI exists. Resolves null when dismissed by
  // the user or cancelled because the browser answered first.
  async function showLocalDialog(ctx, questions, signal) {
    if (!ctx?.hasUI || !ctx.ui?.askDialog) return null;
    try {
      const result = await ctx.ui.askDialog(toDialogQuestions(questions), { signal });
      if (!result) return null;
      if (result.kind === "chat") return { chat: true };
      return { results: result.results };
    } catch (error) {
      if (signal.aborted) return null;
      log(`local ask dialog failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async function execute(params, signal, ctx) {
    if (pending) {
      return { content: [{ type: "text", text: "Error: another ask call is already waiting for the user" }], details: {} };
    }
    const questions = params.questions;
    if (signal?.aborted) throw new Error("Ask tool was cancelled");
    const localAbort = new AbortController();
    const questionId = randomUUID();

    const remote = new Promise((resolve) => {
      pending = { questionId, questions: toWireQuestions(questions), createdAt: Date.now(), resolve };
    }).then((results) => ({ source: "remote", results }));
    publish();

    // Turn abort (user pressed Esc in the TUI, or abort from the browser):
    // dismiss the local dialog, drop the pending question, fail the tool.
    let onTurnAbort = null;
    const turnAborted = new Promise((_, reject) => {
      onTurnAbort = () => reject(new Error("Ask tool was cancelled"));
      signal?.addEventListener("abort", onTurnAbort, { once: true });
    });
    turnAborted.catch(() => {});

    // Background rpc runners report a UI whose askDialog auto-resolves (the
    // recommended option came back within seconds in testing), so the local
    // branch is only used for interactive sessions; the browser is the only
    // answer path otherwise.
    const local = localDialog && ctx?.hasUI && ctx.ui?.askDialog
      ? showLocalDialog(ctx, questions, localAbort.signal).then((outcome) => ({ source: "local", outcome }))
      : new Promise(() => {});

    let winner;
    try {
      winner = await Promise.race([remote, local, turnAborted]);
      if (winner.source === "local" && winner.outcome === null) {
        // The native dialog was dismissed by the user (not by us): behave like
        // the builtin tool and abort the turn instead of silently waiting.
        ctx?.abort?.();
        throw new Error("Ask tool was cancelled by the user");
      }
    } finally {
      if (onTurnAbort) signal?.removeEventListener("abort", onTurnAbort);
      localAbort.abort();
      if (pending?.questionId === questionId) clear();
    }

    if (winner.source === "local" && winner.outcome?.chat) {
      return {
        content: [{ type: "text", text: `User chose to chat about this instead of answering.\n\nQuestions asked:\n${questions.map((q) => q.question).join("\n")}` }],
        details: { chatRedirect: true, questions: questions.map((q) => q.question) },
      };
    }
    const results = winner.source === "local" ? winner.outcome.results : winner.results;
    return formatResults(questions, results, ctx);
  }

  function formatResults(questions, results, ctx) {
    if (questions.length === 1) {
      const result = results[0];
      if (!result || (!result.timedOut && !result.multi && result.selectedOptions.length === 0 && result.customInput === undefined)) {
        ctx?.abort?.();
        throw new Error("Ask tool was cancelled by the user");
      }
      return {
        content: [{ type: "text", text: formatSingleQuestionResponse(result) }],
        details: {
          question: result.question, options: result.options, multi: result.multi,
          selectedOptions: result.selectedOptions, customInput: result.customInput, note: result.note, timedOut: result.timedOut,
        },
      };
    }
    return {
      content: [{ type: "text", text: `User answers:\n${results.map(formatQuestionResult).join("\n")}` }],
      details: { results },
    };
  }

  function register(pi) {
    // OMP injects a TypeBox builder; upstream pi (and test doubles) may not.
    // Without it the builtin `ask` stays in place and questions are TUI-only.
    const Type = pi.typebox?.Type;
    if (!Type) return false;
    const Option = Type.Object({
      label: Type.String({ description: "display label" }),
      description: Type.Optional(Type.String({ description: "optional explanatory text displayed below the label" })),
      preview: Type.Optional(Type.String({ description: "optional rich preview content for interactive ask dialogs" })),
    });
    const Question = Type.Object({
      id: Type.String({ description: "question id" }),
      question: Type.String({ description: "question text" }),
      header: Type.Optional(Type.String({ description: "optional short display chip for rich ask dialogs" })),
      options: Type.Array(Option, { description: "available options" }),
      multi: Type.Optional(Type.Boolean({ description: "allow multiple selections" })),
      recommended: Type.Optional(Type.Number({ description: "recommended option index" })),
    });
    pi.registerTool({
      name: "ask",
      label: "Ask",
      description: ASK_DESCRIPTION,
      parameters: Type.Object({ questions: Type.Array(Question, { description: "questions to ask", minItems: 1 }) }),
      approval: "read",
      loadMode: "essential",
      strict: true,
      execute: async (_toolCallId, params, signal, _onUpdate, ctx) => execute(params, signal, ctx),
    });
    return true;
  }

  return { register, answer, pendingQuestion, clear: () => { if (pending) clear(); } };
}

const ASK_DESCRIPTION = `Ask the user for clarification/input during task execution.

<conditions>
- Multiple approaches with significantly different tradeoffs user should weigh.
</conditions>

<instruction>
- \`recommended: <index>\` marks default (0-indexed); " (Recommended)" added automatically.
- Use \`questions\` for related questions, not one at a time.
- Set \`multi: true\` on a question to allow multiple selections.
- Short option labels; explanatory tradeoffs in \`description\`, not labels.
</instruction>

<caution>
- Provide 2-5 concise, distinct options.
</caution>

<critical>
- Default to action. Resolve ambiguity via repo conventions, existing patterns, reasonable defaults. Exhaust existing sources (code, configs, docs, history) before asking. Ask only when options have materially different tradeoffs the user must decide.
- If multiple choices acceptable: pick most conservative/standard option; proceed; state choice.
- Do NOT include "Other"; UI automatically adds "Other (type your own)" to every question.
</critical>`;

function formatQuestionResult(result) {
  const noteSuffix = result.note ? ` (note: ${result.note})` : "";
  if (result.customInput !== undefined) return `${result.id}: "${result.customInput}"${noteSuffix}`;
  if (result.selectedOptions.length > 0) {
    const suffix = `${result.timedOut ? " (auto-selected after timeout)" : ""}${noteSuffix}`;
    return result.multi
      ? `${result.id}: [${result.selectedOptions.join(", ")}]${suffix}`
      : `${result.id}: ${result.selectedOptions[0]}${suffix}`;
  }
  return result.multi ? `${result.id}: []${noteSuffix}` : `${result.id}: (cancelled)${noteSuffix}`;
}

function formatSingleQuestionResponse(result) {
  const parts = [];
  if (result.selectedOptions.length > 0) {
    const selected = result.multi ? `User selected: ${result.selectedOptions.join(", ")}` : `User selected: ${result.selectedOptions[0]}`;
    parts.push(result.timedOut ? `${selected} (auto-selected after timeout)` : selected);
  }
  if (result.customInput !== undefined) {
    parts.push(result.customInput.includes("\n")
      ? `User provided custom input:\n${result.customInput.split("\n").map((line) => `  ${line}`).join("\n")}`
      : `User provided custom input: ${result.customInput}`);
  }
  if (result.note) {
    parts.push(result.note.includes("\n")
      ? `User added note:\n${result.note.split("\n").map((line) => `  ${line}`).join("\n")}`
      : `User added note: ${result.note}`);
  }
  if (parts.length > 0) return parts.join("\n");
  return result.multi ? "User did not select any options" : "User cancelled the selection";
}
